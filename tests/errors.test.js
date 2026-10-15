/**
 * Error-classification unit tests: the HTTP status matrix, Retry-After
 * parsing, in-band errors, transport classification, and the failover
 * eligibility set.
 * @module nvidia-smart-quota-router/tests/errors.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  FAILOVER_ELIGIBLE,
  classifyHttpError,
  classifyInBandError,
  classifyTransportError,
  parseRetryAfterMs,
} from '../bundle/errors.js'

function headers(of = {}) {
  return new Headers(of)
}

test('classifyHttpError: the full status matrix maps to the harness taxonomy', () => {
  const cases = [
    [400, 'INVALID_REQUEST'],
    [401, 'AUTH'],
    [403, 'AUTH'],
    [404, 'HTTP_404'],
    [409, 'HTTP_409'],
    [413, 'INVALID_REQUEST'],
    [429, 'RATE_LIMIT'],
    [500, 'SERVER'],
    [502, 'SERVER'],
    [503, 'SERVER'],
    [504, 'SERVER'],
  ]
  for (const [status, code] of cases) {
    const failure = classifyHttpError(status, JSON.stringify({ error: { message: `boom ${status}` } }), undefined)
    assert.equal(failure.code, code, `HTTP ${status} maps to ${code}`)
    assert.equal(failure.failure.status, status)
  }
})

test('classifyHttpError: quota wording wins over the raw status', () => {
  const failure = classifyHttpError(400, JSON.stringify({ error: { message: 'Your usage limit reached for this account' } }), undefined)
  assert.equal(failure.code, 'QUOTA')
})

test('classifyHttpError: HTTP 402 is quota exhaustion', () => {
  const failure = classifyHttpError(402, JSON.stringify({ error: { message: 'payment required' } }), undefined)
  assert.equal(failure.code, 'QUOTA')
})

test('classifyHttpError: context-window wording maps to CONTEXT_WINDOW_EXCEEDED', () => {
  const failure = classifyHttpError(
    400,
    JSON.stringify({ error: { message: 'This model supports a maximum context window of 131072 tokens' } }),
    undefined,
  )
  assert.equal(failure.code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('classifyHttpError: OpenAI-style error types classify without a status', () => {
  const rate = classifyHttpError(undefined, JSON.stringify({ error: { type: 'rate_limit_error' } }), undefined)
  assert.equal(rate.code, 'RATE_LIMIT')
  const auth = classifyHttpError(undefined, JSON.stringify({ error: { type: 'authentication_error' } }), undefined)
  assert.equal(auth.code, 'AUTH')
  const overloaded = classifyHttpError(undefined, JSON.stringify({ error: { type: 'overloaded_error' } }), undefined)
  assert.equal(overloaded.code, 'SERVER')
})

test('classifyHttpError: a gateway without JSON still reports status and a message', () => {
  const failure = classifyHttpError(502, '<html>bad gateway</html>', undefined)
  assert.equal(failure.code, 'SERVER')
  assert.match(failure.message, /NVIDIA chat\/completions request failed \(HTTP 502\)/)
})

test('classifyHttpError: retry-after seconds and request id attach to the failure', () => {
  const failure = classifyHttpError(
    429,
    JSON.stringify({ error: { message: 'slow down', type: 'rate_limit_error' } }),
    headers({ 'retry-after': '7', 'x-request-id': 'req-abc' }),
  )
  assert.equal(failure.failure.providerRetryAfterMs, 7_000)
  assert.equal(failure.failure.requestId, 'req-abc')
})

test('parseRetryAfterMs: seconds, HTTP-date, and invalid values', () => {
  assert.equal(parseRetryAfterMs(headers({ 'retry-after': '2.5' })), 2_500)
  const date = new Date(Date.now() + 60_000).toUTCString()
  const parsed = parseRetryAfterMs(headers({ 'retry-after': date }))
  assert.ok(parsed > 59_000 && parsed <= 60_000, `HTTP-date parsed near 60s (got ${parsed})`)
  assert.equal(parseRetryAfterMs(headers({ 'retry-after': 'soon' })), undefined)
  assert.equal(parseRetryAfterMs(headers({ 'retry-after': '-3' })), undefined)
  assert.equal(parseRetryAfterMs(headers({})), undefined)
  assert.equal(parseRetryAfterMs(undefined), undefined)
})

test('classifyInBandError: a stream error event classifies like an HTTP error', () => {
  const failure = classifyInBandError({ error: { type: 'rate_limit_error', message: 'in stream' } })
  assert.equal(failure.code, 'RATE_LIMIT')
  assert.equal(failure.failure.status, undefined)
})

test('classifyTransportError: undici fetch failures are TRANSPORT; deadlines are TIMEOUT', () => {
  const transport = classifyTransportError(new TypeError('fetch failed'), 'pkg')
  assert.equal(transport.code, 'TRANSPORT')
  const timeout = classifyTransportError(Object.assign(new Error('headers timeout'), { name: 'TimeoutError' }), 'pkg')
  assert.equal(timeout.code, 'TIMEOUT')
  const passthrough = classifyTransportError(new LlmError('already classified', 'AUTH'), 'pkg')
  assert.equal(passthrough.code, 'AUTH')
})

test('FAILOVER_ELIGIBLE: key-scoped and transient classes only', () => {
  for (const code of ['RATE_LIMIT', 'AUTH', 'MISSING_CREDENTIAL', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']) {
    assert.ok(FAILOVER_ELIGIBLE.has(code), `${code} may fail over`)
  }
  for (const code of ['INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'QUOTA', 'HTTP_404', 'UNSUPPORTED_OPTION', 'CONTENT_FILTERED']) {
    assert.ok(!FAILOVER_ELIGIBLE.has(code), `${code} never fails over`)
  }
})
