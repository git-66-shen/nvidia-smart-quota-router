/**
 * Connection routes for llm-nvidia-router's browser surfaces: the model-probe
 * endpoint the settings page calls to latency-test its catalog, and the health
 * endpoint the conversation-header badge polls for its red/yellow/green
 * verdict. Both ride the authenticated shared API channel as exact Fetch
 * routes rather than an RPC interceptor — the API Gateway already owns the one
 * `/api` interceptor, so a feature registers exact paths beside it. Responses
 * carry ids, latencies, and redacted labels only; a credential value never
 * rides out, and no request is sent unless a user asked for the probe.
 * @module @local/dsh-llm-nvidia-router/routes
 */

import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { classifyHttpError } from './errors.js'

/** Exact route the settings page posts a catalog to for a latency test. */
export const PROBE_PATH = '/api/nvidia-router.probe'

/** Exact route the header badge polls for the configured-key count and verdict. */
export const STATUS_PATH = '/api/nvidia-router.status'

// A model that answers at all answers well inside the configured probe budget;
// the budget is deployment-tunable (`probeTimeoutMs`) because a congested
// endpoint's time-to-first-response can legitimately exceed a small fixed
// value — what a timeout leaves is "undetermined", never "unusable".
const PROBE_CONCURRENCY = 6

/**
 * @param {unknown} body - decoded request body.
 * @returns {string[]} validated model ids, de-duplicated in first-seen order.
 */
function requestedModels(body) {
  if (typeof body !== 'object' || body === null || !Array.isArray(body.models)) return []
  const seen = new Set()
  for (const id of body.models) {
    if (typeof id === 'string' && id.length > 0) seen.add(id)
  }
  return [...seen]
}

/**
 * @param {object} value - JSON-safe payload.
 * @param {number} [status] - HTTP status.
 * @returns {Response} a no-store JSON response.
 */
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

/**
 * Classify one non-2xx probe answer into the code a caller records.
 * @param {Response} response - the failed answer.
 * @returns {Promise<string>} the router's own error code.
 */
async function errorCodeOf(response) {
  const text = await response.text().catch(() => '')
  try {
    return classifyHttpError(response.status, text, response.headers).code
  } catch {
    return `HTTP_${response.status}`
  }
}

/**
 * Probe one model with a minimal completion: a 2xx proves the route serves the
 * model, and the round-trip time is the latency a user sees. Only the verdict
 * and the measured duration leave this function.
 * @param {object} init
 * @param {string} init.model - model id to probe.
 * @param {string} init.baseURL - endpoint root, already trimmed.
 * @param {string} init.key - resolved credential value (never returned).
 * @param {string} [init.reasoningEffort] - optional OpenAI-style effort id to
 * include as `reasoning_effort`, testing whether the model accepts it.
 * @param {AbortSignal} init.signal - caller cancellation bound to the deadline.
 * @returns {Promise<object>} one probe result.
 */
async function probeModel({ model, baseURL, key, reasoningEffort, signal }) {
  const started = performance.now()
  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...attributionHeaders(), authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
        ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
      }),
      signal,
    })
    const latencyMs = Math.round(performance.now() - started)
    if (!response.ok) return { id: model, ok: false, latencyMs, status: response.status, error: await errorCodeOf(response) }
    // A valid answer is the whole signal; the tiny body is discarded unread.
    if (response.body !== null) await response.body.cancel().catch(() => {})
    return { id: model, ok: true, latencyMs }
  } catch (error) {
    const latencyMs = Math.round(performance.now() - started)
    const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError'
    return { id: model, ok: false, latencyMs, error: aborted ? 'TIMEOUT' : 'TRANSPORT' }
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving order.
 * @param {readonly unknown[]} items - work items.
 * @param {number} limit - maximum concurrency.
 * @param {(item: unknown) => Promise<unknown>} worker - per-item task.
 * @returns {Promise<unknown[]>} results in item order.
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

/**
 * An optional probe-request extension: one reasoning effort id forwarded to the
 * endpoint's OpenAI-style `reasoning_effort` field, so a probe can answer
 * whether the served model accepts the parameter at all.
 * @param {unknown} body - decoded request body.
 * @returns {string | undefined} a validated effort id, or undefined.
 */
function requestedReasoningEffort(body) {
  if (typeof body !== 'object' || body === null) return undefined
  const effort = body.reasoningEffort
  return typeof effort === 'string' && effort.length > 0 ? effort : undefined
}

/**
 * POST /api/nvidia-router.probe: latency-test each requested model (default:
 * the whole catalog) against the configured endpoint through the first key
 * that currently resolves. An optional `reasoningEffort` body field forwards
 * one OpenAI-style effort so a probe can test whether the model accepts it.
 * @param {object} init
 * @param {Request} init.request - the inbound request.
 * @param {() => object} init.options - live resolved settings.
 * @param {() => Promise<string>} init.resolveAnyKey - resolves the first live key.
 * @returns {Promise<Response>} per-model verdicts, or a top-level refusal.
 */
export async function handleProbe({ request, options, resolveAnyKey }) {
  const snapshot = options()
  const body = await request.json().catch(() => null)
  const requested = requestedModels(body)
  const reasoningEffort = requestedReasoningEffort(body)
  const models = requested.length > 0 ? requested : snapshot.models.map((entry) => entry.id)
  if (models.length === 0) {
    return jsonResponse({
      testedAt: Date.now(), results: [], error: 'EMPTY_CATALOG', message: 'the catalog lists no models to test',
    })
  }
  let key
  try {
    key = await resolveAnyKey()
  } catch (error) {
    return jsonResponse({
      testedAt: Date.now(), results: [], error: error?.code ?? 'MISSING_CREDENTIAL', message: String(error?.message ?? error),
    })
  }
  const baseURL = snapshot.baseURL.replace(/\/+$/u, '')
  const probeTimeoutMs = snapshot.probeTimeoutMs
  // One budget per model, not one shared by the whole pass: a batch-wide
  // deadline cuts off whatever is still queued once the first slow model burns
  // it, which would report a large catalog as mostly "undetermined". Caller
  // cancellation still applies to every probe.
  const results = await mapWithConcurrency(models, PROBE_CONCURRENCY, (model) => probeModel({
    model, baseURL, key, reasoningEffort,
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(probeTimeoutMs)]),
  }))
  return jsonResponse({ testedAt: Date.now(), baseURL, ...(reasoningEffort === undefined ? {} : { reasoningEffort }), results })
}

/**
 * Reduce one key's redacted facts to a single verdict. Red = nothing can serve
 * a request now (no stored key, or every stored key cooling/errored); green =
 * every stored key is usable and at least one has already served a request;
 * yellow = unknown (stored but never exercised) or partial (some unusable).
 * @param {readonly object[]} keys - per-key redacted records.
 * @returns {'red' | 'yellow' | 'green'} the badge verdict.
 */
export function computeHealth(keys) {
  const configured = keys.filter((key) => key.configured)
  if (configured.length === 0) return 'red'
  const usable = configured.filter((key) => !key.cooling && !key.credentialError)
  if (usable.length === 0) return 'red'
  if (usable.length < configured.length) return 'yellow'
  if (!configured.some((key) => key.sent > 0)) return 'yellow'
  return 'green'
}

/**
 * GET /api/nvidia-router.status: the stored-key count plus the verdict the
 * header badge renders, from the scheduler's local estimate and credential
 * presence. Keys are named by label and reference only; values never ride out.
 * @param {object} init
 * @param {object} init.scheduler - the shared quota scheduler.
 * @param {(ref: string) => Promise<boolean>} init.keyConfigured - presence probe.
 * @returns {Promise<Response>} the redacted health view.
 */
export async function handleStatus({ scheduler, keyConfigured }) {
  scheduler.syncKeys()
  const snapshot = scheduler.snapshot()
  const keys = await Promise.all(snapshot.keys.map(async (key) => ({
    label: key.label,
    credentialRef: key.credentialRef,
    configured: await keyConfigured(key.credentialRef),
    cooling: key.cooling,
    credentialError: key.credentialError,
    cooldownRemainingMs: key.cooldownRemainingMs,
    sent: key.stats.sent,
    ok: key.stats.ok,
    rateLimited: key.stats.rateLimited,
    authErrors: key.stats.authErrors,
    timeouts: key.stats.timeouts,
  })))
  return jsonResponse({
    keyCount: keys.filter((key) => key.configured).length,
    totalKeys: keys.length,
    activeKey: snapshot.activeKey,
    health: computeHealth(keys),
    keys,
  })
}

/**
 * Register both exact Fetch routes on the shared API channel. The browser
 * channel mounts as its own boot row, so it can still be activating while this
 * provider's apply runs; a scoped fiber waits for it instead of reading a
 * service that is not active yet (reading it eagerly yields `undefined` and the
 * routes would silently never exist). A deployment with no browser channel
 * never enters this scope, and the provider itself stays mounted either way.
 * @param {object} init
 * @param {object} init.ctx - registrant context.
 * @param {object} init.scheduler - the shared quota scheduler.
 * @param {() => object} init.options - live resolved settings.
 * @param {() => Promise<string>} init.resolveAnyKey - resolves the first live key.
 * @param {(ref: string) => Promise<boolean>} init.keyConfigured - presence probe.
 */
export function registerConnectionRoutes({ ctx, scheduler, options, resolveAnyKey, keyConfigured }) {
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.connection.fetch.register({
      path: PROBE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleProbe({ request, options, resolveAnyKey }),
    }), 'llm-nvidia-router: model probe route')
    connectionCtx.effect(() => connectionCtx.connection.fetch.register({
      path: STATUS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => handleStatus({ scheduler, keyConfigured }),
    }), 'llm-nvidia-router: header health route')
  })
}
