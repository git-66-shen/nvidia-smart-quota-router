/**
 * Controllable OpenAI-compatible mock of the NVIDIA chat/completions
 * endpoint for adapter tests: per-key scripted behaviors, SSE streaming with
 * timing control, Retry-After headers, and request recording. No real API
 * is contacted and no rate limits are probed.
 * @module nvidia-smart-quota-router/tests/mock-nvidia-server
 */

import { createServer } from 'node:http'

/**
 * Build one SSE event chunk. OpenAI-compat frames are `data: <json>\n\n`.
 * @param {object} payload
 * @returns {string}
 */
export function sseEvent(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** @returns {string} the [DONE] terminator frame. */
export const SSE_DONE = 'data: [DONE]\n\n'

/**
 * Standard chat stream: greeting text, then usage, then [DONE].
 * @param {object} [options]
 * @returns {string[]}
 */
export function greetingStream(options = {}) {
  const events = []
  if (options.prefix !== undefined) events.push({ id: '1', choices: [{ delta: { role: 'assistant', content: options.prefix } }] })
  events.push({ id: '1', choices: [{ delta: { content: 'world' } }] })
  events.push({ id: '1', choices: [{ delta: {}, finish_reason: 'stop' }] })
  events.push({ id: '1', usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })
  return events.map(sseEvent)
}

/**
 * Tool-call stream: one function call split across argument fragments.
 * @param {string} [id]
 * @param {string} [name]
 * @param {string[]} [fragments]
 * @returns {string[]}
 */
export function toolCallStream(id = 'call_1', name = 'get_weather', fragments = ['{"city":', ' "Tokyo"}']) {
  const events = []
  events.push({ id: '1', choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: fragments[0] } }] } }] })
  for (const fragment of fragments.slice(1)) {
    events.push({ id: '1', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] } }] })
  }
  events.push({ id: '1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
  events.push({ id: '1', usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })
  return events.map(sseEvent)
}

/**
 * Start a mock NVIDIA endpoint.
 *
 * Key behavior is configured per authorization token:
 * `ok` (SSE events from `script`), `rate-limit`, `auth-error` (401),
 * `forbidden` (403), `not-found` (404), `bad-request` (400), `quota` (402),
 * `server-error` (500, or pass `{ status }` for other 5xx), `stall`
 * (never responds; drives idle timeout), `empty` (finish with no content),
 * `content-filter`, `in-band-error`, `drop` (closes the socket mid-stream).
 *
 * @param {object} [options]
 * @param {(auth: string | undefined, body: object) => string} [options.keyOf]
 *   maps an authorization header to a behavior key; default: strip `Bearer `.
 * @param {Record<string, { behavior: string, status?: number, retryAfterMs?: number, script?: string[], delayMs?: number }>} [options.behaviors]
 *   behavior script per key.
 * @param {object[]} [options.models] - `GET /models` response entries.
 * @returns {Promise<{ server: object, baseURL: string, requests: object[], close: () => Promise<void>, setBehavior: (key: string, spec: object) => void }>}
 */
export async function startMockNvidia(options = {}) {
  const requests = []
  const behaviors = { ...options.behaviors }
  const keyOf = options.keyOf ?? (auth => (auth ?? '').replace(/^Bearer /u, ''))
  const models = options.models ?? [{ id: 'mock/model-a', owned_by: 'mock' }, { id: 'mock/model-b' }]

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const auth = req.headers.authorization
      const key = keyOf(auth)
      let body = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = null
      }
      requests.push({ method: req.method, url: req.url, key, body, at: Date.now() })

      if (req.method === 'GET' && req.url === '/v1/models') {
        if (key === 'bad-key') {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'unauthorized', type: 'authentication_error' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: models }))
        return
      }

      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `unknown route ${req.url}` } }))
        return
      }

      const spec = behaviors[key] ?? { behavior: 'ok', script: greetingStream() }
      const headers = { 'content-type': 'text/event-stream', 'x-request-id': `req-${requests.length}` }
      switch (spec.behavior) {
        case 'ok': {
          const script = spec.script ?? greetingStream()
          const delayMs = spec.delayMs ?? 0
          res.writeHead(200, headers)
          let i = 0
          const send = () => {
            if (i >= script.length) {
              res.end(SSE_DONE)
              return
            }
            res.write(script[i++])
            if (delayMs > 0) setTimeout(send, delayMs)
            else send()
          }
          send()
          return
        }
        case 'rate-limit': {
          const retry = spec.retryAfterMs !== undefined ? { 'retry-after': String(Math.ceil(spec.retryAfterMs / 1000)) } : {}
          res.writeHead(429, { 'content-type': 'application/json', ...retry })
          res.end(JSON.stringify({ error: { message: 'rate limit exceeded', type: 'rate_limit_error' } }))
          return
        }
        case 'auth-error':
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'invalid api key', type: 'authentication_error' } }))
          return
        case 'forbidden':
          res.writeHead(403, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'forbidden', type: 'permission_error' } }))
          return
        case 'not-found':
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'model not found' } }))
          return
        case 'bad-request':
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'invalid request', type: 'invalid_request_error' } }))
          return
        case 'quota':
          res.writeHead(402, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'insufficient_quota: usage limit reached' } }))
          return
        case 'server-error':
          res.writeHead(spec.status ?? 500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'internal error', type: 'api_error' } }))
          return
        case 'stall':
          // Never respond; the client's idle watchdog must fire.
          return
        case 'headers-stall':
          // Respond with headers, then never write a body chunk: the request
          // deadline is withdrawn once headers arrive, so the client's idle
          // watchdog (not the request deadline) owns a silent stream.
          res.writeHead(200, headers)
          res.flushHeaders()
          return
        case 'empty': {
          res.writeHead(200, headers)
          res.write(sseEvent({ id: '1', choices: [{ delta: {}, finish_reason: 'stop' }] }))
          res.end(SSE_DONE)
          return
        }
        case 'content-filter': {
          res.writeHead(200, headers)
          res.write(sseEvent({ id: '1', choices: [{ delta: { content: 'unsafe' }, finish_reason: 'content_filter' }] }))
          res.end(SSE_DONE)
          return
        }
        case 'in-band-error': {
          res.writeHead(200, headers)
          res.write(sseEvent({ error: { message: 'upstream overloaded', type: 'overloaded_error' } }))
          res.end(SSE_DONE)
          return
        }
        case 'drop':
          // Deliver one visible event, then break the connection after the
          // client has pulled it, so the failure lands mid-stream.
          res.writeHead(200, headers)
          res.write(sseEvent({ id: '1', choices: [{ delta: { content: 'partial' } }] }))
          setTimeout(() => res.destroy(), 60)
          return
        default:
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `unknown mock behavior ${spec.behavior}` } }))
      }
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const baseURL = `http://127.0.0.1:${address.port}/v1`
  return {
    server,
    baseURL,
    requests,
    setBehavior: (key, spec) => { behaviors[key] = spec },
    close: () => new Promise(resolve => server.close(resolve)),
  }
}
