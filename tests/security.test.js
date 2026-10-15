/**
 * Key-security tests: credential values never appear in logs, status
 * snapshots, error messages, request bodies, or the plugin sources.
 * @module nvidia-smart-quota-router/tests/security.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import { QuotaScheduler } from '../bundle/scheduler.js'
import { NvidiaRouterAdapter } from '../bundle/adapter.js'
import { serializeRequest } from '../bundle/wire.js'
import { startMockNvidia, greetingStream } from './mock-nvidia-server.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = join(HERE, '..', 'bundle')

const SECRET_MARKER = 'nvapi-SECRET-'
const KEY_VALUES = {
  NVIDIA_API_KEY_1: `${SECRET_MARKER}1111111111111111`,
  NVIDIA_API_KEY_2: `${SECRET_MARKER}2222222222222222`,
  NVIDIA_API_KEY_3: `${SECRET_MARKER}3333333333333333`,
  NVIDIA_API_KEY_4: `${SECRET_MARKER}4444444444444444`,
}
const KEYS = Object.keys(KEY_VALUES).map((env, index) => ({ env, label: `Key-${index + 1}` }))

/** Collect every string a logger would emit. */
function capturingLogger() {
  const lines = []
  const make = level => (...args) => { lines.push(args.map(String).join(' ')) }
  return {
    lines,
    logger: { info: make('info'), warn: make('warn'), error: make('error'), debug: make('debug') },
  }
}

/** Assert no captured surface contains any secret value. */
function assertNoSecrets(surfaces, label) {
  for (const surface of surfaces) {
    for (const [env, value] of Object.entries(KEY_VALUES)) {
      assert.ok(!surface.includes(value), `${label} leaked the value of ${env}`)
    }
  }
}

test('security: a full 429/auth/success flow never logs a credential value', async () => {
  const mock = await startMockNvidia({
    behaviors: {
      [KEY_VALUES.NVIDIA_API_KEY_1]: { behavior: 'rate-limit', retryAfterMs: 2_000 },
      [KEY_VALUES.NVIDIA_API_KEY_2]: { behavior: 'auth-error' },
      [KEY_VALUES.NVIDIA_API_KEY_3]: { behavior: 'ok', script: greetingStream() },
    },
  })
  const { lines, logger } = capturingLogger()
  try {
    const options = () => ({
      provider: 'nvidia',
      providerName: 'NVIDIA',
      baseURL: mock.baseURL,
      apiKeys: KEYS,
      models: [{ id: 'mock/model-a', name: 'Model A' }],
      windowMs: 60_000,
      safeThreshold: 38,
      rateLimitCooldownMs: 5_000,
      rateLimitCooldownMaxMs: 300_000,
      authErrorCooldownMs: 900_000,
      quotaCooldownMs: 1_800_000,
      maxFailoverAttempts: 3,
      allUnavailableWaitMs: 50,
      streamIdleTimeoutMs: 300_000,
      requestTimeoutMs: 120_000,
      streamUsage: true,
    })
    const scheduler = new QuotaScheduler({ options, logger })
    const resolveKey = async envRef => KEY_VALUES[envRef]
    const adapter = new NvidiaRouterAdapter({ options, scheduler, resolveKey, logger })

    const errorMessages = []
    let chunks = []
    try {
      for await (const chunk of adapter.stream({
        provider: 'nvidia',
        model: 'mock/model-a',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'security probe' }], id: 'm-1', source: { kind: 'user' } }],
      })) {
        chunks.push(chunk)
      }
    } catch (error) {
      errorMessages.push(error instanceof Error ? error.message : String(error))
      errorMessages.push(error instanceof LlmError ? String(error.failure.message) : '')
      if (error.cause instanceof Error) errorMessages.push(error.cause.message)
    }
    // The flow must have exercised 429 + 401 logging before succeeding (or failing).
    assert.ok(lines.length > 0, 'the flow produced log output')
    assertNoSecrets(lines, 'log output')
    assertNoSecrets(errorMessages, 'error text')
    const snapshotText = JSON.stringify(scheduler.snapshot())
    assert.ok(!snapshotText.includes(SECRET_MARKER), 'the snapshot carries labels and refs only')
    // request bodies captured by the mock carry the key only in headers, never in the body
    for (const recorded of mock.requests) {
      assert.ok(!JSON.stringify(recorded.body).includes(SECRET_MARKER), 'request bodies never embed the credential')
    }
    assert.equal(mock.requests[0].key, KEY_VALUES.NVIDIA_API_KEY_1, 'the mock receives the key as a header value')
  } finally {
    await mock.close()
  }
})

test('security: serializeRequest places the credential only in the authorization header', () => {
  const { url, headers, body } = serializeRequest({
    provider: 'nvidia',
    model: 'mock/model-a',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], id: 'm', source: { kind: 'user' } }],
  }, {
    baseURL: 'https://example.invalid/v1',
    streamUsage: true,
  }, KEY_VALUES.NVIDIA_API_KEY_1)
  assert.equal(url, 'https://example.invalid/v1/chat/completions')
  assert.equal(headers.authorization, `Bearer ${KEY_VALUES.NVIDIA_API_KEY_1}`)
  assert.ok(!body.includes(SECRET_MARKER), 'the JSON body never embeds the credential')
})

test('security: the status snapshot names keys by label and credential reference only', () => {
  const options = () => ({
    apiKeys: KEYS,
    safeThreshold: 38,
    windowMs: 60_000,
    rateLimitCooldownMs: 5_000,
    rateLimitCooldownMaxMs: 300_000,
    authErrorCooldownMs: 900_000,
    quotaCooldownMs: 1_800_000,
  })
  const scheduler = new QuotaScheduler({ options })
  const snapshotText = JSON.stringify(scheduler.snapshot())
  assert.match(snapshotText, /Key-1/)
  assert.match(snapshotText, /NVIDIA_API_KEY_1/)
  assertNoSecrets([snapshotText], 'snapshot')
})

test('security: the status snapshot is lossless JSON in every state the tool can report', async () => {
  const options = apiKeys => () => ({
    apiKeys,
    safeThreshold: 2,
    windowMs: 60_000,
    rateLimitCooldownMs: 5_000,
    rateLimitCooldownMaxMs: 300_000,
    authErrorCooldownMs: 900_000,
    quotaCooldownMs: 1_800_000,
  })
  // Fresh key table, zero traffic: the exact live state that made the tool
  // fail with "value is not lossless JSON" (lastFailure was undefined).
  const fresh = new QuotaScheduler({ options: options(KEYS) })
  const freshSnapshot = fresh.snapshot()
  assert.equal(isJsonValue(freshSnapshot), true, 'a fresh key table snapshots losslessly')
  assert.ok(!('lastFailure' in freshSnapshot.keys[0]), 'a key that never failed omits lastFailure')
  assert.equal(freshSnapshot.activeKey, 'Key-1')
  // After a timeout: lastFailure present without cooldown.
  const lease = await fresh.acquire('mock/model-a')
  lease.reportTimeout()
  const failedSnapshot = fresh.snapshot()
  assert.equal(isJsonValue(failedSnapshot), true, 'a failed-key table snapshots losslessly')
  assert.equal(failedSnapshot.keys[0].lastFailure.code, 'TIMEOUT')
  // After a 429 on the same sticky key: lastFailure overwritten, cooldown finite.
  const limited = await fresh.acquire('mock/model-b')
  limited.reportRateLimit(2_000)
  const busySnapshot = fresh.snapshot()
  assert.equal(isJsonValue(busySnapshot), true, 'a partially cooled table snapshots losslessly')
  assert.equal(busySnapshot.keys[0].lastFailure.code, 'RATE_LIMIT')
  assert.equal(busySnapshot.keys[0].cooling, true)
  // Empty key table: activeKey omitted, not undefined.
  const empty = new QuotaScheduler({ options: options([]) })
  const emptySnapshot = empty.snapshot()
  assert.equal(isJsonValue(emptySnapshot), true, 'an empty key table snapshots losslessly')
  assert.ok(!('activeKey' in emptySnapshot), 'no sticky key omits activeKey')
  assert.deepEqual(emptySnapshot.keys, [])
})

test('security: a missing credential names the reference, never a value', async () => {
  const options = () => ({
    provider: 'nvidia',
    providerName: 'NVIDIA',
    baseURL: 'https://example.invalid/v1',
    apiKeys: KEYS,
    models: [{ id: 'mock/model-a', name: 'Model A' }],
    windowMs: 60_000,
    safeThreshold: 38,
    rateLimitCooldownMs: 5_000,
    rateLimitCooldownMaxMs: 300_000,
    authErrorCooldownMs: 900_000,
    quotaCooldownMs: 1_800_000,
    maxFailoverAttempts: 0,
    allUnavailableWaitMs: 50,
    streamIdleTimeoutMs: 300_000,
    requestTimeoutMs: 120_000,
    streamUsage: true,
  })
  const scheduler = new QuotaScheduler({ options })
  const resolveKey = async envRef => {
    throw new LlmError(
      `llm-nvidia-router: no API key resolved from ${envRef}; store it through the credentials service`,
      'MISSING_CREDENTIAL',
    )
  }
  const adapter = new NvidiaRouterAdapter({ options, scheduler, resolveKey })
  const outcome = await (async () => {
    try {
      for await (const chunk of adapter.stream({
        provider: 'nvidia',
        model: 'mock/model-a',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }], id: 'm', source: { kind: 'user' } }],
      })) void chunk
      return { error: undefined }
    } catch (error) {
      return { error }
    }
  })()
  assert.ok(outcome.error instanceof LlmError)
  assert.match(outcome.error.message, /NVIDIA_API_KEY_1/)
  assertNoSecrets([outcome.error.message], 'missing-credential diagnostic')
})

test('security: no credential literal exists anywhere in the plugin sources', () => {
  for (const file of ['index.js', 'config.js', 'scheduler.js', 'errors.js', 'wire.js', 'adapter.js', 'status.js']) {
    const source = readFileSync(join(BUNDLE, file), 'utf8')
    assert.ok(!source.includes('nvapi-'), `${file} embeds no key literal`)
  }
  const example = readFileSync(join(HERE, '..', 'CONFIG.example.yaml'), 'utf8')
  assert.ok(!example.includes('nvapi-'), 'CONFIG.example.yaml embeds no key literal')
})
