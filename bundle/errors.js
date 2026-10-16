/**
 * Normalize HTTP, in-band, and transport failures into provider-neutral
 * LlmError codes, mirroring the dsh-llm-deepseek classification so retry
 * policy and diagnostics route on the same taxonomy.
 * @module @local/dsh-llm-nvidia-router/errors
 */

import { isContextWindowExceededError, isQuotaExceededError, LlmError } from '@deepseek-ai/dsh-llm'

/**
 * Failure codes that justify trying a different key within the same request:
 * key-scoped or transient classes only. Deterministic request-level failures
 * (bad arguments, unknown model, context overflow) and account-level quota
 * exhaustion never fail over, because another key reproduces the same
 * outcome or burns a shared balance. TIMEOUT is excluded even though it is
 * transient: the endpoint and its models are shared by every key, so a
 * serial retry only multiplies the wall-clock hang (each attempt waits out
 * the full request deadline) and burns extra reservations without changing
 * the outcome. The next request still starts on another key via
 * advanceStickyPast, and step-level retry owns any later reattempt.
 */
export const FAILOVER_ELIGIBLE = new Set([
  'RATE_LIMIT',
  'AUTH',
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'SERVER',
  'TRANSPORT',
  'EMPTY_RESPONSE',
])

/**
 * Read the provider's error fields without trusting arbitrary response data.
 * @param {unknown} raw - decoded JSON error response body.
 * @returns {string} code, type, and message text joined for classification.
 */
export function providerErrorDetail(raw) {
  const error = typeof raw === 'object' && raw !== null && 'error' in raw ? raw.error : undefined
  if (typeof error !== 'object' || error === null) return ''
  const fields = error
  return [fields.code, fields.type, fields.message].filter(value => typeof value === 'string').join(' ')
}

/**
 * Parse a Retry-After header into a positive millisecond delay.
 * Accepts seconds or an HTTP-date; invalid values report undefined.
 * @param {Headers | undefined} headers
 * @returns {number | undefined}
 */
export function parseRetryAfterMs(headers) {
  const retry = headers?.get('retry-after')
  if (retry == null) return undefined
  const seconds = /^\d+(?:\.\d+)?$/u.test(retry) ? Number(retry) * 1000 : Number.NaN
  const delay = Number.isFinite(seconds) ? seconds : Date.parse(retry) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? Math.ceil(delay) : undefined
}

/**
 * Classify an HTTP error response without trusting arbitrary response fields.
 * @param {number | undefined} status - HTTP status of the failed response, when it had one.
 * @param {string} bodyText - raw response body text for classification and cause.
 * @param {Headers | undefined} headers - response headers for retry delay and request identity.
 * @returns {LlmError} a stable failure consumed by LlmRuntime and llm-retry.
 */
export function classifyHttpError(status, bodyText, headers) {
  let raw
  try {
    raw = JSON.parse(bodyText)
  } catch {
    // HTTP status is authoritative when a gateway does not return JSON.
  }
  const envelope = typeof raw === 'object' && raw !== null ? raw : {}
  const error = typeof envelope.error === 'object' && envelope.error !== null ? envelope.error : {}
  const message = typeof error.message === 'string' && error.message.length > 0
    ? error.message
    : `NVIDIA chat/completions request failed (${status === undefined ? 'stream error' : `HTTP ${status}`})`
  const type = typeof error.type === 'string' ? error.type : ''
  const detail = `${type} ${typeof error.code === 'string' ? error.code : ''} ${message}`
  let code
  if (status === 401 || status === 403 || ['authentication_error', 'permission_error'].includes(type)) code = 'AUTH'
  else if (isQuotaExceededError(detail) || status === 402) code = 'QUOTA'
  else if (status === 429 || type === 'rate_limit_error') code = 'RATE_LIMIT'
  else if (isContextWindowExceededError(detail)) code = 'CONTEXT_WINDOW_EXCEEDED'
  else if (status === 400 || status === 413 || type === 'invalid_request_error') code = 'INVALID_REQUEST'
  else if ((status !== undefined && status >= 500) || ['api_error', 'overloaded_error'].includes(type)) code = 'SERVER'
  else code = status === undefined ? 'SERVER' : `HTTP_${status}`
  const id = headers?.get('x-request-id') ?? headers?.get('request-id')
  const retryAfterMs = parseRetryAfterMs(headers)
  return new LlmError(message, code, {
    ...status === undefined ? {} : { status },
    ...id !== null && id !== undefined ? { requestId: id } : {},
    ...retryAfterMs !== undefined ? { providerRetryAfterMs: retryAfterMs } : {},
    cause: new Error(bodyText.slice(0, 2000)),
  })
}

/**
 * Classify an in-band error event delivered inside the SSE stream. The
 * payload carries provider type/code/message fields; no HTTP status exists.
 * @param {unknown} event - decoded in-band error payload.
 * @returns {LlmError}
 */
export function classifyInBandError(event) {
  return classifyHttpError(undefined, JSON.stringify(event), undefined)
}

/**
 * Classify a thrown transport-level value from the request boundary.
 * @param {unknown} error - thrown value.
 * @param {string} pkg - diagnostic prefix.
 * @returns {LlmError} TIMEOUT for deadline aborts, TRANSPORT otherwise.
 */
export function classifyTransportError(error, pkg) {
  if (error instanceof LlmError) return error
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error && error.message.length > 0 ? error.message : String(error)
  if (name === 'TimeoutError' || name === 'AbortError' || /timeout/iu.test(message)) {
    return new LlmError(`${pkg}: request timed out`, 'TIMEOUT', { cause: error })
  }
  return new LlmError(`${pkg}: transport failed: ${message}`, 'TRANSPORT', { cause: error })
}

/**
 * Render a thrown value briefly for logs without leaking response bodies.
 * @param {unknown} error
 * @returns {string}
 */
export function shortError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
