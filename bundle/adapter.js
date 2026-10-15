/**
 * NVIDIA router adapter: one provider route over the OpenAI-compatible
 * chat/completions endpoint, with sticky multi-key quota scheduling, bounded
 * pre-stream key failover, and the full streaming/tool-call protocol.
 * Key failover happens only before the first stream chunk reaches the
 * consumer; after that, failures surface for step-level retry instead of
 * resending a partially delivered request.
 * @module @local/dsh-llm-nvidia-router/adapter
 */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { deadline, idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { FAILOVER_ELIGIBLE, classifyHttpError, classifyTransportError } from './errors.js'
import { serializeRequest, translateSse } from './wire.js'

const PKG = 'llm-nvidia-router'
const IDLE_CODE = 'NVIDIA_STREAM_IDLE'
const REQUEST_CODE = 'NVIDIA_REQUEST_TIMEOUT'

/**
 * @param {object} options - resolved settings snapshot.
 * @param {string} provider
 * @param {object} entry - one catalog model.
 * @returns {object} LlmModelInfo for the directory.
 */
function catalogModelInfo(options, provider, entry) {
  return {
    provider,
    id: entry.id,
    name: entry.name,
    ...entry.description !== undefined ? { description: entry.description } : {},
    inputModalities: ['text'],
  }
}

/**
 * One catalog entry's declared reasoning levels as the harness picker
 * consumes them: capitalized display names over the declared ids.
 * @param {object} entry - one catalog model with optional `efforts`.
 * @returns {object} the `reasoning` field, or an empty object when none are declared.
 */
function reasoningInfoOf(entry) {
  if (entry.efforts === undefined) return {}
  return {
    reasoning: {
      efforts: entry.efforts.map(level => ({
        id: level,
        name: level.charAt(0).toUpperCase() + level.slice(1),
      })),
      ...(entry.defaultEffort === undefined ? {} : { defaultEffort: entry.defaultEffort }),
    },
  }
}

/**
 * @param {object} options - resolved settings snapshot.
 * @param {string} provider
 * @param {string} model
 * @returns {object} LlmResolvedModelInfo.
 */
function resolveModelInfo(options, provider, model) {
  const entry = options.models.find(candidate => candidate.id === model)
  if (entry === undefined) {
    return { provider, id: model, name: model, inputModalities: ['text'] }
  }
  return {
    provider,
    id: entry.id,
    name: entry.name,
    ...entry.description !== undefined ? { description: entry.description } : {},
    inputModalities: ['text'],
    ...entry.contextWindow !== undefined ? { context: { contextWindow: entry.contextWindow } } : {},
    ...entry.maxTokens !== undefined ? { defaultMaxTokens: entry.maxTokens } : {},
    ...reasoningInfoOf(entry),
  }
}

/**
 * The NVIDIA provider adapter. `dependencies.options()` re-resolves the
 * volatile config per request; `dependencies.scheduler` is the single
 * in-process quota reservation point shared by every model call. Extends the
 * harness `LlmAdapter` base so request preparation rides the inherited
 * `prepareCall` generation binding (the runtime calls it before dispatching;
 * the base's `imageRequestPricing` default also applies).
 */
export class NvidiaRouterAdapter extends LlmAdapter {
  /** @param {object} dependencies */
  constructor({ options, scheduler, resolveKey, logger }) {
    super()
    this.#options = options
    this.#scheduler = scheduler
    this.#resolveKey = resolveKey
    this.#logger = logger
  }

  #options
  #scheduler
  #resolveKey
  #logger

  providerInfo(provider) {
    return { id: provider, name: this.#options().providerName }
  }

  providerRetryPolicy() {
    return this.#options().retryPolicy
  }

  async listModels(provider) {
    return this.#options().models.map(entry => catalogModelInfo(this.#options(), provider, entry))
  }

  async resolveModel(provider, model) {
    return resolveModelInfo(this.#options(), provider, model)
  }

  /**
   * Stream one model call with bounded key failover. Each HTTP attempt
   * reserves quota atomically through the shared scheduler; only failures
   * that arrive before any stream chunk has been delivered may try another
   * key, and only a bounded number of times. A reasoningEffort here was
   * already validated (and defaulted) by the runtime against the model's
   * declared levels; whether the wire carries it is the configured
   * `reasoningEffortParam` deployment fact.
   * @param {object} options - GenerateOptions.
   * @returns {AsyncGenerator<object>} raw StreamChunk values.
   */
  async *stream(options) {
    const connection = this.#options()
    let attempts = 0
    while (true) {
      attempts++
      const lease = await this.#scheduler.acquire(options.model, options.signal)
      const flight = { sent: false, streamed: false }
      try {
        yield* this.#attempt(lease, options, connection, flight)
        return
      } catch (error) {
        const failure = error instanceof LlmError ? error : classifyTransportError(error, PKG)
        if (failure.code === 'ABORTED') {
          // A request that never left the client releases its reservation;
          // one that reached fetch keeps it (possibly consumed server-side).
          if (!flight.sent) lease.release()
          throw failure
        }
        if (!flight.sent
          && (failure.code === 'MISSING_CREDENTIAL' || failure.code === 'INVALID_CREDENTIAL')) {
          // A credential failure happens before dispatch: the request provably
          // never reached the server, so its slot is safe to release.
          lease.release()
        }
        this.#report(lease, failure)
        if (failure.code === 'TIMEOUT' || failure.code === 'TRANSPORT') {
          // A transient transport failure says nothing about the key's quota;
          // cool nothing, but prefer another key for the immediate retry.
          this.#scheduler.advanceStickyPast(lease.key)
        }
        // Failover only before anything reached the consumer: resending a
        // partially delivered stream would duplicate visible content.
        if (!flight.streamed
          && attempts <= connection.maxFailoverAttempts
          && FAILOVER_ELIGIBLE.has(failure.code)
          && !options.signal?.aborted) {
          this.#logger?.info(
            `${PKG}: attempt ${attempts} failed on ${lease.label} (${failure.code}); trying another key`,
          )
          continue
        }
        throw failure
      }
    }
  }

  /**
   * Map a thrown pre-stream failure onto its lease.
   * @param {object} lease - the quota lease of the failed attempt.
   * @param {LlmError} failure - classified failure.
   */
  #report(lease, failure) {
    switch (failure.code) {
      case 'RATE_LIMIT':
        lease.reportRateLimit(failure.failure.providerRetryAfterMs)
        return
      case 'AUTH':
      case 'MISSING_CREDENTIAL':
      case 'INVALID_CREDENTIAL':
        lease.reportAuthError()
        return
      case 'QUOTA':
        lease.reportQuotaError()
        return
      case 'SERVER':
        lease.reportServerError(failure.failure.status)
        return
      case 'TIMEOUT':
        lease.reportTimeout()
        return
      case 'TRANSPORT':
        lease.reportTransport()
        return
      case 'EMPTY_RESPONSE':
        lease.reportEmptyResponse()
        return
      default:
        lease.reportInBand(failure.code)
    }
  }

  /**
   * One HTTP attempt under an idle watchdog. Throws pre-stream failures
   * (unreported; the caller reports and decides failover) and reports
   * post-stream outcomes itself, because the terminal finish chunk is the
   * last thing the consumer sees and no caller state can follow it.
   * @returns {AsyncGenerator<object>} raw StreamChunk values.
   */
  async *#attempt(lease, options, connection, flight) {
    const consumer = new AbortController()
    const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([consumer.signal, options.signal])
    using watchdog = idleWatchdog(signal, connection.streamIdleTimeoutMs, IDLE_CODE)
    try {
      yield* this.#dispatch(lease, options, connection, watchdog, flight)
    } catch (error) {
      if (timeoutOf(watchdog.signal, IDLE_CODE) !== undefined) {
        lease.reportTimeout()
        throw new LlmError(`${PKG}: NVIDIA stream idle timeout`, 'TIMEOUT', { cause: error })
      }
      if (timeoutOf(error, REQUEST_CODE) !== undefined) {
        lease.reportTimeout()
        throw new LlmError(`${PKG}: NVIDIA request exceeded its deadline`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError(`${PKG}: NVIDIA request aborted`, 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw classifyTransportError(error, PKG)
    } finally {
      // The abort owns socket teardown; a demand the watchdog abandoned can
      // stay pending forever, so the drain is detached exactly like the
      // dsh-llm-deepseek reference adapter.
      consumer.abort()
    }
  }

  /**
   * Resolve the key, send the request, and stream the translation. The
   * terminal finish chunk of a completed stream is reported here.
   * @returns {AsyncGenerator<object>} raw StreamChunk values.
   */
  async *#dispatch(lease, options, connection, watchdog, flight) {
    watchdog.signal.throwIfAborted()
    const apiKey = await this.#resolveKey(lease.envRef)
    const { url, headers, body } = serializeRequest(options, connection, apiKey)
    watchdog.signal.throwIfAborted()
    flight.sent = true
    // The idle watchdog only guards stream pulls; the fetch itself needs its
    // own deadline so a server that accepts but never responds cannot hang.
    using requestWatch = deadline(watchdog.signal, connection.requestTimeoutMs, REQUEST_CODE)
    const response = await fetch(url, { method: 'POST', headers, body, signal: requestWatch.signal, redirect: 'error' })
    if (!response.ok) {
      const text = await response.text()
      throw classifyHttpError(response.status, text, response.headers)
    }
    if (response.body === null) {
      throw new LlmError(`${PKG}: NVIDIA chat/completions returned no response body`, 'EMPTY_RESPONSE')
    }
    const iterator = translateSse(response.body)
    while (true) {
      const next = await watchdog.next(iterator)
      if (next.done) return
      const chunk = next.value
      if (chunk.type === 'finish') {
        this.#reportFinish(lease, chunk)
        yield chunk
        return
      }
      if (chunk.type !== 'usage') flight.streamed = true
      yield chunk
    }
  }

  /**
   * Report the terminal finish outcome of a completed stream on its lease.
   * @param {object} lease
   * @param {object} chunk - terminal finish chunk.
   */
  #reportFinish(lease, chunk) {
    const reason = chunk.reason
    switch (reason.kind) {
      case 'stop':
      case 'tool-calls':
      case 'max-tokens':
        lease.reportSuccess()
        return
      case 'aborted':
        return
      case 'error': {
        const failure = reason.failure
        if (failure.code === 'RATE_LIMIT') {
          lease.reportRateLimit(failure.providerRetryAfterMs)
          return
        }
        if (failure.code === 'EMPTY_RESPONSE') {
          lease.reportEmptyResponse()
          return
        }
        lease.reportInBand(failure.code)
        return
      }
      default:
        lease.reportInBand(String(reason.kind))
    }
  }
}
