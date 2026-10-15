/**
 * Scheduler unit tests: sticky selection, rolling-window thresholds, atomic
 * reservation under concurrency, cooldown and recovery, bounded all-keys
 * wait, release semantics, restart, and key-table reconfiguration.
 * @module nvidia-smart-quota-router/tests/scheduler.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QuotaScheduler } from '../bundle/scheduler.js'
import { LlmError } from '@deepseek-ai/dsh-llm'

const KEYS = [
  { env: 'NVIDIA_API_KEY_1', label: 'Key-1' },
  { env: 'NVIDIA_API_KEY_2', label: 'Key-2' },
  { env: 'NVIDIA_API_KEY_3', label: 'Key-3' },
  { env: 'NVIDIA_API_KEY_4', label: 'Key-4' },
]

/**
 * Test harness: controllable clock, and a sleeper the test chooses.
 * `sleepMode` is 'advance' (sleep advances the fake clock instantly) or
 * 'record' (sleep records the requested delay and never resolves).
 */
function harness(overrides = {}) {
  let now = 1_000_000
  const sleeps = []
  const options = () => ({
    apiKeys: KEYS,
    windowMs: 60_000,
    safeThreshold: 38,
    rateLimitCooldownMs: 5_000,
    rateLimitCooldownMaxMs: 300_000,
    authErrorCooldownMs: 900_000,
    quotaCooldownMs: 1_800_000,
    allUnavailableWaitMs: 15_000,
    ...overrides,
  })
  const sleep = async (ms, signal) => {
    sleeps.push(ms)
    if (harness.mode === 'advance') {
      now += ms
      return
    }
    return new Promise((resolve, reject) => {
      if (signal !== undefined) {
        if (signal.aborted) return reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }
      // 'record' mode: never resolve; the test only observes the wait.
    })
  }
  const scheduler = new QuotaScheduler({ options, clock: () => now, sleep })
  return {
    scheduler,
    sleeps,
    options,
    advance: ms => { now += ms },
    now: () => now,
  }
}
harness.mode = 'advance'

test('sticky: below threshold the same key keeps serving every request', async () => {
  const h = harness()
  const labels = []
  for (let i = 0; i < 37; i++) {
    const lease = await h.scheduler.acquire('m', undefined)
    labels.push(lease.label)
    lease.reportSuccess()
  }
  assert.ok(labels.every(label => label === 'Key-1'), 'all 37 stay on Key-1')
  assert.equal(h.scheduler.stats.switches, 0)
})

test('threshold: at the safe threshold the next request switches to the next key', async () => {
  const h = harness()
  const labels = []
  for (let i = 0; i < 40; i++) {
    const lease = await h.scheduler.acquire('m', undefined)
    labels.push(lease.label)
    lease.reportSuccess()
  }
  assert.equal(labels.filter(label => label === 'Key-1').length, 38)
  assert.equal(labels.filter(label => label === 'Key-2').length, 2)
  assert.equal(h.scheduler.stats.switches, 1)
  assert.equal(h.scheduler.snapshot().activeKey, 'Key-2')
})

test('rolling window: entries that leave the window free their quota', async () => {
  const h = harness({ safeThreshold: 3 })
  for (let i = 0; i < 3; i++) (await h.scheduler.acquire('m', undefined)).reportSuccess()
  assert.equal(h.scheduler.snapshot().keys[0].windowCount, 3)
  h.advance(60_001)
  const lease = await h.scheduler.acquire('m', undefined)
  assert.equal(lease.label, 'Key-1', 'sticky anchor unchanged; the drained key serves again')
  assert.equal(h.scheduler.snapshot().keys[0].windowCount, 1)
  lease.reportSuccess()
})

test('rolling window: sticky stays on the later key until it fills, then advances', async () => {
  const h = harness({ safeThreshold: 2, windowMs: 60_000 })
  const seen = []
  for (let i = 0; i < 6; i++) {
    const lease = await h.scheduler.acquire('m', undefined)
    seen.push(lease.label)
    lease.reportSuccess()
  }
  assert.deepEqual(seen, ['Key-1', 'Key-1', 'Key-2', 'Key-2', 'Key-3', 'Key-3'])
  assert.equal(h.scheduler.snapshot().activeKey, 'Key-3')
})

test('concurrency: 50 simultaneous acquires never exceed the per-key threshold', async () => {
  harness.mode = 'record'
  const h = harness({ apiKeys: [KEYS[0]], safeThreshold: 10, windowMs: 60_000, allUnavailableWaitMs: 120_000 })
  // Every acquire() body runs its synchronous check-and-reserve section before
  // its first await, so the burst is fully sequenced on one thread.
  const acquires = Array.from({ length: 50 }, () => h.scheduler.acquire('m', undefined))
  const snapshot = h.scheduler.snapshot()
  assert.equal(snapshot.keys[0].windowCount, 10, 'exactly threshold reservations pass the sync section')
  assert.equal(snapshot.keys[0].stats.sent, 10)
  assert.equal(h.sleeps.length, 40, 'the remaining callers queue behind a bounded wait')
  assert.equal(h.scheduler.stats.allUnavailableEvents, 0)
  void acquires
  harness.mode = 'advance'
})

test('all unavailable: bounded wait, then a diagnosable RATE_LIMIT with recovery hint', async () => {
  const h = harness({ apiKeys: [KEYS[0]], safeThreshold: 1, allUnavailableWaitMs: 15_000 })
  const lease = await h.scheduler.acquire('m', undefined)
  lease.reportSuccess()
  await assert.rejects(
    () => h.scheduler.acquire('m', undefined),
    error => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'RATE_LIMIT')
      assert.equal(error.failure.providerRetryAfterMs, 60_000, 'hint is the full window slide of the fresh entry')
      assert.match(error.message, /Key-1: 1 in window/)
      assert.match(error.message, /local estimate, not a server-supplied quota/)
      return true
    },
  )
  assert.equal(h.scheduler.stats.allUnavailableEvents, 1)
})

test('all unavailable: the bounded wait recovers through cooldown and window expiry', async () => {
  const h = harness({ apiKeys: [KEYS[0], KEYS[1]], safeThreshold: 1, allUnavailableWaitMs: 60_000 })
  const a = await h.scheduler.acquire('m', undefined)
  a.reportRateLimit(5_000)
  const b = await h.scheduler.acquire('m', undefined)
  assert.equal(b.label, 'Key-2')
  b.reportRateLimit(20_000)
  // Both keys are now cooling; recovery walks 5s (Key-1 cooldown), 15s (Key-2
  // cooldown), then 40s (both window entries sliding out), and the sticky
  // anchor (Key-2) serves again once its own window is free.
  const c = await h.scheduler.acquire('m', undefined)
  assert.equal(c.label, 'Key-2')
  assert.deepEqual(h.sleeps, [5_000, 15_000, 40_000])
  assert.equal(h.scheduler.stats.allUnavailableEvents, 0)
  c.reportSuccess()
})

test('429 cooldown: server Retry-After wins over local backoff', async () => {
  const h = harness()
  const lease = await h.scheduler.acquire('m', undefined)
  lease.reportRateLimit(30_000)
  const snap = h.scheduler.snapshot()
  assert.equal(snap.keys[0].cooldownRemainingMs, 30_000)
  assert.equal(snap.keys[0].cooldownReason, 'rate-limit (server 429)')
})

test('429 cooldown: consecutive 429s without a hint apply capped exponential backoff', async () => {
  const h = harness({ rateLimitCooldownMs: 1_000, rateLimitCooldownMaxMs: 3_000 })
  const first = await h.scheduler.acquire('m', undefined)
  first.reportRateLimit(undefined)
  assert.equal(h.scheduler.snapshot().keys[0].cooldownRemainingMs, 1_000)
  h.advance(1_000)
  const second = await h.scheduler.acquire('m', undefined)
  assert.equal(second.label, 'Key-1', 'cooldown expired and the sticky key is re-evaluated')
  second.reportRateLimit(undefined)
  assert.equal(h.scheduler.snapshot().keys[0].cooldownRemainingMs, 2_000)
  h.advance(2_000)
  const third = await h.scheduler.acquire('m', undefined)
  third.reportRateLimit(undefined)
  assert.equal(h.scheduler.snapshot().keys[0].cooldownRemainingMs, 3_000, 'backoff is capped at the configured max')
})

test('no flap: a recovered key does not steal the sticky anchor back', async () => {
  const h = harness({ safeThreshold: 2 })
  const a = await h.scheduler.acquire('m', undefined)
  a.reportRateLimit(1_000)
  const b = await h.scheduler.acquire('m', undefined)
  assert.equal(b.label, 'Key-2')
  b.reportSuccess()
  h.advance(1_500)
  const c = await h.scheduler.acquire('m', undefined)
  assert.equal(c.label, 'Key-2', 'sticky stays on the serving key even after Key-1 recovers')
  c.reportSuccess()
})

test('auth error: key is marked config-error with a long cooldown, and a success clears the mark', async () => {
  const h = harness({ authErrorCooldownMs: 900_000 })
  const lease = await h.scheduler.acquire('m', undefined)
  lease.reportAuthError()
  const snap = h.scheduler.snapshot()
  assert.equal(snap.keys[0].credentialError, true)
  assert.equal(snap.keys[0].cooldownRemainingMs, 900_000)
  h.advance(900_000)
  const retry = await h.scheduler.acquire('m', undefined)
  assert.equal(retry.label, 'Key-1')
  retry.reportSuccess()
  assert.equal(h.scheduler.snapshot().keys[0].credentialError, false)
})

test('quota error: long cooldown, recorded as account-level', async () => {
  const h = harness()
  const lease = await h.scheduler.acquire('m', undefined)
  lease.reportQuotaError()
  const snap = h.scheduler.snapshot()
  assert.equal(snap.keys[0].cooldownRemainingMs, 1_800_000)
  assert.match(snap.keys[0].cooldownReason, /account-level/)
})

test('release: a pre-dispatch cancel frees the reservation; settlement locks it', async () => {
  const h = harness()
  const lease = await h.scheduler.acquire('m', undefined)
  assert.equal(h.scheduler.snapshot().keys[0].windowCount, 1)
  lease.release()
  assert.equal(h.scheduler.snapshot().keys[0].windowCount, 0)
  assert.equal(h.scheduler.snapshot().keys[0].stats.sent, 0)
  const second = await h.scheduler.acquire('m', undefined)
  second.reportSuccess()
  assert.equal(h.scheduler.snapshot().keys[0].windowCount, 1)
  second.release()
  assert.equal(h.scheduler.snapshot().keys[0].windowCount, 1, 'a settled lease never releases its count')
})

test('one lease reports exactly one outcome even if two layers classify it', async () => {
  const h = harness()
  const lease = await h.scheduler.acquire('m', undefined)
  lease.reportTimeout()
  lease.reportTimeout()
  lease.reportRateLimit(1_000)
  const key = h.scheduler.snapshot().keys[0]
  assert.equal(key.stats.timeouts, 1)
  assert.equal(key.stats.rateLimited, 0)
  assert.equal(key.lastFailure.code, 'TIMEOUT')
})

test('release: a clock that ticks between reservation and lease construction cannot leak the slot', async () => {
  // Regression for the intermittent adapter failures: the lease used to call
  // the clock again in its constructor, so a millisecond boundary between the
  // reservation and the lease left release() unable to find its own entry.
  let now = 1_000_000
  const scheduler = new QuotaScheduler({
    options: () => ({
      apiKeys: KEYS,
      windowMs: 60_000,
      safeThreshold: 38,
      rateLimitCooldownMs: 5_000,
      rateLimitCooldownMaxMs: 300_000,
      authErrorCooldownMs: 900_000,
      quotaCooldownMs: 1_800_000,
      allUnavailableWaitMs: 15_000,
    }),
    clock: () => (now += 1),
    sleep: async () => {},
  })
  const lease = await scheduler.acquire('m', undefined)
  assert.equal(scheduler.snapshot().keys[0].windowCount, 1)
  lease.release()
  assert.equal(scheduler.snapshot().keys[0].windowCount, 0, 'the slot is gone even though the clock advanced')
  assert.equal(scheduler.snapshot().keys[0].stats.sent, 0)
})

test('restart: a fresh scheduler starts with clean in-memory state and the same config', async () => {
  const h = harness()
  const lease = await h.scheduler.acquire('m', undefined)
  lease.reportRateLimit(60_000)
  const reborn = new QuotaScheduler({ options: h.options, clock: () => h.now() })
  const snap = reborn.snapshot()
  assert.equal(snap.keys[0].windowCount, 0)
  assert.equal(snap.keys[0].cooling, false)
  const fresh = await reborn.acquire('m', undefined)
  assert.equal(fresh.label, 'Key-1')
  fresh.reportSuccess()
})

test('key table: configuration edits add, remove, and relabel keys', async () => {
  const apiKeys = [KEYS[0], KEYS[1], KEYS[2]]
  const h = harness({ apiKeys, safeThreshold: 1 })
  const a = await h.scheduler.acquire('m', undefined)
  a.reportSuccess()
  const b = await h.scheduler.acquire('m', undefined)
  b.reportSuccess()
  const c = await h.scheduler.acquire('m', undefined)
  assert.equal(c.label, 'Key-3')
  c.reportSuccess()
  // Mutate the same array the options closure reads.
  apiKeys.length = 0
  apiKeys.push({ env: 'NVIDIA_API_KEY_9', label: 'Key-9' })
  const lease = await h.scheduler.acquire('m', undefined)
  assert.equal(lease.label, 'Key-9')
  assert.equal(h.scheduler.snapshot().keys.length, 1)
})

test('window entries record the model for future per-model accounting', async () => {
  const h = harness()
  const lease = await h.scheduler.acquire('deepseek-ai/deepseek-v3.1', undefined)
  assert.equal(lease.key.windowModels[0], 'deepseek-ai/deepseek-v3.1')
  lease.reportSuccess()
})

test('missing key table fails loud instead of guessing', async () => {
  const h = harness({ apiKeys: [] })
  await assert.rejects(
    () => h.scheduler.acquire('m', undefined),
    error => error instanceof LlmError && error.code === 'MISSING_CREDENTIAL',
  )
})
