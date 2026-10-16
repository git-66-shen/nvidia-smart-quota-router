/**
 * sticky_quota scheduler: one shared in-process reservation point for every
 * NVIDIA model request (main agent, in-process subagents, session titles,
 * compaction). Reservation is a synchronous section, so on the single
 * JavaScript thread concurrent callers can never observe the same remaining
 * budget twice.
 * @module @local/dsh-llm-nvidia-router/scheduler
 */

import { LlmError } from '@deepseek-ai/dsh-llm'

/** Upper bound on the retry hint reported to step-level retry when every key is unavailable. */
const MAX_REPORTED_RETRY_AFTER_MS = 60_000

/** Default sleeper: bounded, abort-aware delay. @param {number} ms @param {AbortSignal | undefined} signal */
async function defaultSleep(ms, signal) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    if (signal !== undefined) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * One atomic quota reservation for a single NVIDIA HTTP request. The
 * reservation is created inside a synchronous section of
 * {@link QuotaScheduler.acquire}; every attempt that reached `fetch` keeps
 * its count, and only a request cancelled before dispatch may release it.
 */
export class QuotaLease {
  /** @param {object} init */
  constructor({ key, index, model, reservedAt, schedulerStats, options, logger, clock }) {
    this.key = key
    this.index = index
    this.model = model
    /** Redacted display label; the credential value never travels on a lease. */
    this.label = key.label
    this.envRef = key.envRef
    /**
     * The exact timestamp {@link QuotaScheduler} pushed into the key's window.
     * It must be that value, never a fresh `clock()` reading: on a real
     * millisecond clock the constructor can land on the next millisecond, and
     * {@link release} would then fail to find its own entry and leak the slot.
     */
    this.reservedAt = reservedAt
    this.#schedulerStats = schedulerStats
    this.#options = options
    this.#logger = logger
    this.#clock = clock
  }

  #schedulerStats
  #options
  #logger
  #clock
  #released = false
  #settled = false

  /**
   * Release the reservation when the request provably never left the client
   * (cancelled before dispatch). Idempotent; forbidden after settlement.
   */
  release() {
    if (this.#settled || this.#released) return
    this.#released = true
    const window = this.key.window
    const at = window.lastIndexOf(this.reservedAt)
    if (at < 0) return
    window.splice(at, 1)
    this.key.windowModels.splice(at, 1)
    this.key.stats.sent--
    this.#schedulerStats.totalSent--
  }

  /** Record a successful request; clears the key's rate-limit streak and credential-error mark. */
  reportSuccess() {
    if (this.#beginReport()) return
    this.key.stats.ok++
    this.key.consecutiveRateLimits = 0
    this.key.credentialError = false
  }

  /**
   * Record an HTTP 429. Honors a valid server-provided retry delay; otherwise
   * applies exponential backoff over the configured base, capped.
   * @param {number | undefined} retryAfterMs - server-provided recovery delay in ms, when valid.
   */
  reportRateLimit(retryAfterMs) {
    if (this.#beginReport()) return
    this.key.stats.rateLimited++
    this.key.consecutiveRateLimits++
    const options = this.#options()
    const backoff = options.rateLimitCooldownMs * 2 ** (this.key.consecutiveRateLimits - 1)
    const cooldown = Math.min(backoff, options.rateLimitCooldownMaxMs)
    const delay = Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : cooldown
    this.key.cooldownUntil = this.#clock() + delay
    this.key.cooldownReason = 'rate-limit (server 429)'
    this.key.lastFailure = { code: 'RATE_LIMIT', at: this.#clock() }
    this.#logger?.info(
      `llm-nvidia-router: ${this.label} cooling ${delay}ms after 429`
      + ` (server hint: ${retryAfterMs ?? 'none'}; local estimate)`,
    )
  }

  /** Record a key-scoped authentication/permission failure (401/403, missing or malformed credential). */
  reportAuthError() {
    if (this.#beginReport()) return
    this.key.stats.authErrors++
    this.key.credentialError = true
    const options = this.#options()
    this.key.cooldownUntil = Math.max(this.key.cooldownUntil, this.#clock() + options.authErrorCooldownMs)
    this.key.cooldownReason = 'credential/config error (401/403 or missing credential)'
    this.key.lastFailure = { code: 'AUTH', at: this.#clock() }
    this.#logger?.warn(`llm-nvidia-router: ${this.label} marked as config-error; cooling ${options.authErrorCooldownMs}ms`)
  }

  /** Record provider-side quota exhaustion (HTTP 402 or quota wording; may be shared across keys). */
  reportQuotaError() {
    if (this.#beginReport()) return
    this.key.stats.quotaErrors++
    const options = this.#options()
    this.key.cooldownUntil = Math.max(this.key.cooldownUntil, this.#clock() + options.quotaCooldownMs)
    this.key.cooldownReason = 'quota exhausted (account-level; may be shared across keys)'
    this.key.lastFailure = { code: 'QUOTA', at: this.#clock() }
    this.#logger?.warn(`llm-nvidia-router: ${this.label} reported quota exhaustion; cooling ${options.quotaCooldownMs}ms`)
  }

  /** Record a 5xx server failure; the window count already throttles this key. @param {number} status */
  reportServerError(status) {
    if (this.#beginReport()) return
    this.key.stats.serverErrors++
    this.key.lastFailure = { code: 'SERVER', at: this.#clock() }
    this.#logger?.warn(`llm-nvidia-router: ${this.label} server error (HTTP ${status})`)
  }

  /** Record a network/protocol timeout; the request may have been consumed server-side, so the count stays. */
  reportTimeout() {
    if (this.#beginReport()) return
    this.key.stats.timeouts++
    this.key.lastFailure = { code: 'TIMEOUT', at: this.#clock() }
  }

  /** Record a transport-level failure (connection refused, TLS, reset); the count stays. */
  reportTransport() {
    if (this.#beginReport()) return
    this.key.stats.transportErrors++
    this.key.lastFailure = { code: 'TRANSPORT', at: this.#clock() }
  }

  /** Record a completed-but-empty response. */
  reportEmptyResponse() {
    if (this.#beginReport()) return
    this.key.stats.emptyResponses++
    this.key.lastFailure = { code: 'EMPTY_RESPONSE', at: this.#clock() }
  }

  /**
   * Record a provider in-band failure without a more specific class
   * (for example a content_filter stop); the count stays and no cooldown applies.
   * @param {string} code - provider-neutral failure code.
   */
  reportInBand(code) {
    if (this.#beginReport()) return
    this.key.lastFailure = { code, at: this.#clock() }
  }

  /**
   * Begin the one outcome report this lease accepts. Every report method is
   * idempotent, so a failure classified in two layers counts exactly once.
   * @returns {boolean} true when an outcome was already reported.
   */
  #beginReport() {
    if (this.#settled) return true
    this.#settled = true
    return false
  }
}

/**
 * Shared sticky_quota scheduler. All model requests route through
 * {@link acquire}; tunables are re-read from the resolved options on every
 * call so settings edits apply without a reload.
 */
export class QuotaScheduler {
  /** @param {object} init */
  constructor({ options, logger, clock = Date.now, sleep = defaultSleep }) {
    this.#options = options
    this.#logger = logger
    this.#clock = clock
    this.#sleep = sleep
    /** Runtime key states keyed by credential reference (stable across label edits). */
    this.#keys = new Map()
    this.#activeIndex = 0
    this.stats = { switches: 0, allUnavailableEvents: 0, totalSent: 0 }
    this.syncKeys()
  }

  #options
  #logger
  #clock
  #sleep
  #keys
  #activeIndex

  /** Runtime key table in configuration order. */
  #orderedKeys() {
    return this.#options().apiKeys.map(spec => this.#keys.get(spec.env)).filter(key => key !== undefined)
  }

  /** Reconcile the runtime key table with the current configuration (cheap; called per acquire). */
  syncKeys() {
    const { apiKeys } = this.#options()
    const wanted = new Set(apiKeys.map(spec => spec.env))
    for (const envRef of [...this.#keys.keys()]) {
      if (!wanted.has(envRef)) this.#keys.delete(envRef)
    }
    for (const spec of apiKeys) {
      const existing = this.#keys.get(spec.env)
      if (existing !== undefined) {
        existing.label = spec.label
        continue
      }
      this.#keys.set(spec.env, {
        envRef: spec.env,
        label: spec.label,
        window: [],
        windowModels: [],
        cooldownUntil: 0,
        cooldownReason: '',
        credentialError: false,
        consecutiveRateLimits: 0,
        lastFailure: undefined,
        stats: { sent: 0, ok: 0, rateLimited: 0, authErrors: 0, quotaErrors: 0, serverErrors: 0, timeouts: 0, transportErrors: 0, emptyResponses: 0 },
      })
    }
    if (this.#activeIndex >= apiKeys.length) this.#activeIndex = 0
  }

  /** Prune window entries that left the rolling window. @param {object} key @param {number} now @param {number} windowMs */
  #prune(key, now, windowMs) {
    let cut = 0
    while (cut < key.window.length && key.window[cut] <= now - windowMs) cut++
    if (cut > 0) {
      key.window.splice(0, cut)
      key.windowModels.splice(0, cut)
    }
  }

  /**
   * The synchronous check-and-reserve section. No `await` crosses this
   * method, which is what makes the reservation atomic on this thread.
   * @param {string} model
   * @returns {QuotaLease | undefined} a reservation, or undefined when no key is currently usable.
   */
  #tryAcquire(model) {
    const { safeThreshold, windowMs } = this.#options()
    const now = this.#clock()
    const keys = this.#orderedKeys()
    if (keys.length === 0) return undefined
    for (const key of keys) this.#prune(key, now, windowMs)
    const usable = key => key.cooldownUntil <= now && key.window.length < safeThreshold
    const order = []
    for (let step = 0; step < keys.length; step++) order.push(keys[(this.#activeIndex + step) % keys.length])
    const chosen = order.find(usable)
    if (chosen === undefined) return undefined
    if (chosen !== keys[this.#activeIndex]) {
      this.stats.switches++
      this.#activeIndex = keys.indexOf(chosen)
      this.#logger?.info(`llm-nvidia-router: sticky switch to ${chosen.label} (${chosen.envRef})`)
    }
    chosen.window.push(now)
    chosen.windowModels.push(model)
    chosen.stats.sent++
    this.stats.totalSent++
    const key = chosen
    const leaseIndex = keys.indexOf(chosen)
    return new QuotaLease({
      key,
      index: leaseIndex,
      model,
      reservedAt: now,
      schedulerStats: this.stats,
      options: this.#options,
      logger: this.#logger,
      clock: this.#clock,
    })
  }

  /**
   * Milliseconds until some key might become usable again (cooldown expiry or
   * the oldest window entry sliding out), from `now`.
   * @param {number} now
   * @returns {number} a positive delay, or Infinity with no keys configured.
   */
  #earliestRecovery(now) {
    const { windowMs } = this.#options()
    let earliest = Infinity
    for (const key of this.#keys.values()) {
      let candidate = Infinity
      if (key.cooldownUntil > now) candidate = Math.min(candidate, key.cooldownUntil - now)
      if (key.window.length > 0) candidate = Math.min(candidate, key.window[0] + windowMs - now)
      earliest = Math.min(earliest, candidate)
    }
    return earliest
  }

  /**
   * Reserve one request slot on the sticky key. When every key is momentarily
   * unavailable, waits a bounded, abortable interval for the earliest
   * recovery and retries; past the bound it fails with a diagnosable
   * RATE_LIMIT error whose retry hint names the earliest recovery.
   * @param {string} model - model id recorded on the window entry.
   * @param {AbortSignal | undefined} signal - caller cancellation.
   * @returns {Promise<QuotaLease>}
   */
  async acquire(model, signal) {
    this.syncKeys()
    if (this.#keys.size === 0) {
      throw new LlmError('llm-nvidia-router: no API keys are configured; set apiKeys in the plugin config', 'MISSING_CREDENTIAL')
    }
    const { allUnavailableWaitMs } = this.#options()
    const deadline = this.#clock() + allUnavailableWaitMs
    while (true) {
      const lease = this.#tryAcquire(model)
      if (lease !== undefined) return lease
      const now = this.#clock()
      const recovery = this.#earliestRecovery(now)
      const remaining = deadline - now
      if (remaining <= 0 || !Number.isFinite(recovery) || recovery > remaining) {
        this.stats.allUnavailableEvents++
        const hint = Number.isFinite(recovery)
          ? Math.min(Math.max(1, Math.ceil(recovery)), MAX_REPORTED_RETRY_AFTER_MS)
          : allUnavailableWaitMs
        const detail = [...this.#keys.values()]
          .map(key => `${key.label}: ${key.window.length} in window`
            + (key.cooldownUntil > now ? `, cooling ${Math.ceil((key.cooldownUntil - now) / 1000)}s (${key.cooldownReason})` : ''))
          .join('; ')
        throw new LlmError(
          `llm-nvidia-router: every key is at its local safe threshold or cooling; local estimate: ${detail};`
          + ` earliest recovery in ~${Math.round(hint / 1000)}s (local estimate, not a server-supplied quota)`,
          'RATE_LIMIT',
          { providerRetryAfterMs: hint },
        )
      }
      await this.#sleep(Math.max(1, recovery), signal)
    }
  }

  /**
   * Advance the sticky anchor past one key after a transient transport
   * failure (timeout, connection loss). The key stays fully eligible for
   * later requests — its quota is not the problem — but the immediate retry
   * prefers another key, matching "try another available key" for failures
   * whose handling on the same key is uncertain.
   * @param {object} key - the key runtime that just failed transiently.
   */
  advanceStickyPast(key) {
    const keys = this.#orderedKeys()
    const index = keys.indexOf(key)
    if (index === this.#activeIndex && keys.length > 0) {
      this.#activeIndex = (index + 1) % keys.length
    }
  }

  /**
   * Redacted, local-estimate snapshot for diagnostics: key labels, window
   * counts, cooldowns, per-key stats, and scheduler totals. Credential
   * values never appear. Absent facts are omitted, never `undefined`:
   * the tool pipeline rejects any value `JSON.stringify` would drop or
   * distort (undefined, Infinity, -0), and a key that has not failed yet
   * has no lastFailure to report.
   * @returns {object} plain lossless-JSON snapshot.
   */
  snapshot() {
    const { safeThreshold, windowMs } = this.#options()
    const now = this.#clock()
    const keys = this.#orderedKeys()
    const active = keys[this.#activeIndex]
    return {
      estimateBasis: 'local estimate (rolling window + cooldowns); NOT a server-side quota mirror',
      windowMs,
      safeThreshold,
      ...(active === undefined ? {} : { activeKey: active.label }),
      scheduler: {
        stickySwitches: this.stats.switches,
        allUnavailableEvents: this.stats.allUnavailableEvents,
        totalRequestsReserved: this.stats.totalSent,
      },
      keys: keys.map(key => ({
        label: key.label,
        credentialRef: key.envRef,
        windowCount: key.window.length,
        remainingEstimate: Math.max(0, safeThreshold - key.window.length),
        cooling: key.cooldownUntil > now,
        cooldownRemainingMs: key.cooldownUntil > now ? key.cooldownUntil - now : 0,
        cooldownReason: key.cooldownUntil > now ? key.cooldownReason : '',
        credentialError: key.credentialError,
        consecutiveRateLimits: key.consecutiveRateLimits,
        ...(key.lastFailure === undefined ? {} : { lastFailure: { ...key.lastFailure } }),
        stats: { ...key.stats },
      })),
    }
  }
}
