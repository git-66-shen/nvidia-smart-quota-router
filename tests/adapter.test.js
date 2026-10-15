/**
 * Adapter integration tests against a controllable mock NVIDIA endpoint:
 * sticky usage, streaming, tool calls and follow-up requests, 429 cooldown
 * and failover, shared rate limiting, the HTTP error matrix, timeout
 * accounting, cancellation, and shared scheduler coverage for concurrent
 * callers (main agent + in-process subagent simulation).
 * @module nvidia-smart-quota-router/tests/adapter.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError, BlockAssembler } from '@deepseek-ai/dsh-llm'
import { QuotaScheduler } from '../bundle/scheduler.js'
import { NvidiaRouterAdapter } from '../bundle/adapter.js'
import { resolveAdapterOptions } from '../bundle/config.js'
import { startMockNvidia, greetingStream, toolCallStream, sseEvent, SSE_DONE } from './mock-nvidia-server.js'

const KEYS = [
  { env: 'NVIDIA_API_KEY_1', label: 'Key-1' },
  { env: 'NVIDIA_API_KEY_2', label: 'Key-2' },
  { env: 'NVIDIA_API_KEY_3', label: 'Key-3' },
  { env: 'NVIDIA_API_KEY_4', label: 'Key-4' },
]

/** Fake credential values; the security suite proves they never leak. */
const KEY_VALUES = {
  NVIDIA_API_KEY_1: 'nvapi-TEST-1111111111111111',
  NVIDIA_API_KEY_2: 'nvapi-TEST-2222222222222222',
  NVIDIA_API_KEY_3: 'nvapi-TEST-3333333333333333',
  NVIDIA_API_KEY_4: 'nvapi-TEST-4444444444444444',
}

/**
 * Build one adapter wired to a real scheduler and the mock endpoint.
 * @param {object} mock - running mock server.
 * @param {object} [overrides] - resolved-option overrides.
 */
function buildAdapter(mock, overrides = {}) {
  const options = () => ({
    provider: 'nvidia',
    providerName: 'NVIDIA',
    baseURL: mock.baseURL,
    apiKeys: KEYS,
    models: [{ id: 'mock/model-a', name: 'Model A', contextWindow: 131072, maxTokens: 8192 }],
    windowMs: 60_000,
    safeThreshold: 38,
    rateLimitCooldownMs: 5_000,
    rateLimitCooldownMaxMs: 300_000,
    authErrorCooldownMs: 900_000,
    quotaCooldownMs: 1_800_000,
    maxFailoverAttempts: 2,
    allUnavailableWaitMs: 50,
    streamIdleTimeoutMs: 300_000,
    requestTimeoutMs: 120_000,
    streamUsage: true,
    ...overrides,
  })
  const scheduler = new QuotaScheduler({ options })
  const resolveKey = async envRef => {
    const value = KEY_VALUES[envRef]
    if (value === undefined) throw new LlmError(`no key for ${envRef}`, 'MISSING_CREDENTIAL')
    return value
  }
  const adapter = new NvidiaRouterAdapter({ options, scheduler, resolveKey })
  return { adapter, scheduler, options }
}

/**
 * Consume one stream to completion through the real BlockAssembler.
 * @param {object} adapter
 * @param {object} requestOptions
 * @param {{ onChunk?: (type: string) => void }} [hooks]
 * @returns {Promise<{ error?: Error, chunks: object[], blocks: object[], usage: object | undefined, finish: object | undefined, arrivalTimes: number[] }>}
 */
async function collect(adapter, requestOptions, hooks = {}) {
  const chunks = []
  const arrivalTimes = []
  const assembler = new BlockAssembler()
  let finish
  try {
    for await (const chunk of adapter.stream(requestOptions)) {
      arrivalTimes.push(Date.now())
      hooks.onChunk?.(chunk.type)
      if (chunk.type === 'finish') {
        finish = chunk
        break
      }
      chunks.push(chunk)
      assembler.push(chunk)
    }
  } catch (error) {
    return { error, chunks, arrivalTimes, blocks: assembler.blocks(), usage: assembler.usage, finish }
  }
  return { chunks, blocks: assembler.blocks(), usage: assembler.usage, finish, arrivalTimes }
}

function chatRequest(messages, extra = {}) {
  return {
    provider: 'nvidia',
    model: 'mock/model-a',
    messages: messages.map(text => ({ role: 'user', content: [{ type: 'text', text }], id: `m-${text.length}`, source: { kind: 'user' } })),
    ...extra,
  }
}

test('adapter: requests stay sticky on one key while it is available', async () => {
  const mock = await startMockNvidia()
  try {
    const { adapter, scheduler } = buildAdapter(mock)
    for (let i = 0; i < 5; i++) {
      const result = await collect(adapter, chatRequest([`hello ${i}`]))
      assert.equal(result.finish.reason.kind, 'stop')
    }
    assert.equal(scheduler.snapshot().keys[0].stats.ok, 5)
    assert.equal(scheduler.snapshot().keys[1].stats.sent, 0)
    assert.equal(mock.requests.filter(r => r.key === KEY_VALUES.NVIDIA_API_KEY_1).length, 5)
  } finally {
    await mock.close()
  }
})

test('adapter: threshold switch routes new requests to the next key', async () => {
  const mock = await startMockNvidia()
  try {
    const { adapter, scheduler } = buildAdapter(mock, { safeThreshold: 2 })
    for (let i = 0; i < 4; i++) await collect(adapter, chatRequest([`hello ${i}`]))
    const snap = scheduler.snapshot()
    assert.equal(snap.keys[0].stats.ok, 2)
    assert.equal(snap.keys[1].stats.ok, 2)
    assert.equal(snap.activeKey, 'Key-2')
    assert.equal(snap.scheduler.stickySwitches, 1)
  } finally {
    await mock.close()
  }
})

test('adapter: streaming passes chunks through promptly without duplication', async () => {
  const mock = await startMockNvidia({
    behaviors: {
      [KEY_VALUES.NVIDIA_API_KEY_1]: { behavior: 'ok', script: greetingStream({ prefix: 'Hello,' }), delayMs: 40 },
    },
  })
  try {
    const { adapter } = buildAdapter(mock)
    const startedAt = Date.now()
    const result = await collect(adapter, chatRequest(['stream test']))
    const text = result.blocks.filter(block => block.type === 'text').map(block => block.text).join('')
    assert.equal(text, 'Hello,world')
    assert.equal(result.blocks.length, 1, 'exactly one text block, no duplication')
    assert.equal(result.finish.reason.kind, 'stop')
    assert.ok(result.usage !== undefined && result.usage.totalTokens === 12, 'usage carried before finish')
    // 4 events at 40ms spacing: the first chunk must arrive well before the end.
    assert.ok(result.arrivalTimes[0] - startedAt < 120, 'first chunk arrives before the stream completes')
    assert.ok(result.arrivalTimes.length >= 4, 'every SSE event arrived as its own chunk')
    const usageIndex = result.chunks.findIndex(chunk => chunk.type === 'usage')
    assert.ok(usageIndex === result.chunks.length - 1, 'usage is the last chunk before the terminal finish')
    assert.ok(result.chunks.filter(chunk => chunk.type === 'finish').length === 0, 'finish is yielded exactly once (the loop breaks on it)')
  } finally {
    await mock.close()
  }
})

test('adapter: tool calls stream with raw JSON arguments and support the follow-up request', async () => {
  const mock = await startMockNvidia({
    behaviors: {
      [KEY_VALUES.NVIDIA_API_KEY_1]: { behavior: 'ok', script: toolCallStream() },
    },
  })
  try {
    const { adapter, scheduler } = buildAdapter(mock)
    const result = await collect(adapter, chatRequest(['weather in Tokyo?'], {
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
    }))
    const call = result.blocks.find(block => block.type === 'tool-call')
    assert.ok(call, 'a tool-call block assembled')
    assert.equal(call.id, 'call_1')
    assert.equal(call.name, 'get_weather')
    assert.equal(call.arguments, '{"city": "Tokyo"}', 'raw JSON string end-to-end, not re-parsed')
    assert.equal(result.finish.reason.kind, 'tool-calls')
    assert.equal(mock.requests[0].body.tools[0].function.name, 'get_weather', 'tools serialized to the wire')
    assert.equal(mock.requests[0].body.tool_choice, 'auto')

    // Follow-up: the tool result travels back as the tool role with tool_call_id.
    await collect(adapter, {
      provider: 'nvidia',
      model: 'mock/model-a',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'weather?' }], id: 'm-9', source: { kind: 'user' } },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city": "Tokyo"}' }],
          id: 'm-10',
          source: { kind: 'model', provider: 'nvidia', model: 'mock/model-a' },
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: 'sunny, 22C' }],
          id: 'm-11',
          source: { kind: 'tool', callId: 'call_1' },
          toolCallId: 'call_1',
          isError: false,
        },
      ],
    })
    const followUp = mock.requests[1].body
    const assistant = followUp.messages.find(message => message.role === 'assistant')
    assert.equal(assistant.tool_calls[0].id, 'call_1')
    assert.equal(assistant.tool_calls[0].function.arguments, '{"city": "Tokyo"}')
    const toolMessage = followUp.messages.find(message => message.role === 'tool')
    assert.equal(toolMessage.tool_call_id, 'call_1')
    assert.equal(toolMessage.content, 'sunny, 22C')
    assert.equal(scheduler.snapshot().keys[0].stats.sent, 2, 'every model call counted, including the follow-up')
  } finally {
    await mock.close()
  }
})

test('adapter: a 429 cools the key and fails over to the next key within the same request', async () => {
  const mock = await startMockNvidia({
    behaviors: {
      [KEY_VALUES.NVIDIA_API_KEY_1]: { behavior: 'rate-limit', retryAfterMs: 3_000 },
      [KEY_VALUES.NVIDIA_API_KEY_2]: { behavior: 'ok', script: greetingStream() },
    },
  })
  try {
    const { adapter, scheduler } = buildAdapter(mock)
    const result = await collect(adapter, chatRequest(['failover please']))
    assert.equal(result.finish.reason.kind, 'stop', 'the request completed on the second key')
    assert.equal(mock.requests.length, 2, 'exactly one failed attempt plus one failover attempt')
    assert.equal(mock.requests[0].key, KEY_VALUES.NVIDIA_API_KEY_1)
    assert.equal(mock.requests[1].key, KEY_VALUES.NVIDIA_API_KEY_2)
    const snap = scheduler.snapshot()
    assert.equal(snap.keys[0].stats.rateLimited, 1)
    assert.equal(snap.keys[0].cooling, true, 'Key-1 cools per the server Retry-After')
    assert.equal(Math.round(snap.keys[0].cooldownRemainingMs / 1000), 3)
    assert.equal(snap.keys[1].stats.ok, 1)
    assert.ok(snap.scheduler.stickySwitches >= 1)
  } finally {
    await mock.close()
  }
})

test('adapter: shared rate limiting never rotates blindly — attempts stay bounded and report the server hint', async () => {
  const mock = await startMockNvidia({
    behaviors: Object.fromEntries(Object.values(KEY_VALUES).map(key => [
      key,
      { behavior: 'rate-limit', retryAfterMs: 3_000 },
    ])),
  })
  try {
    const { adapter, scheduler } = buildAdapter(mock)
    const outcome = await collect(adapter, chatRequest(['will fail']))
    assert.ok(outcome.error instanceof LlmError, 'surface failure instead of endless rotation')
    assert.equal(outcome.error.code, 'RATE_LIMIT')
    assert.equal(outcome.error.failure.providerRetryAfterMs, 3_000, 'Retry-After propagates to step-level retry')
    assert.equal(mock.requests.length, 3, '1 + maxFailoverAttempts(2) total HTTP attempts, never more')
    const snap = scheduler.snapshot()
    for (const [index, key] of snap.keys.entries()) {
      if (index < 3) {
        assert.equal(key.stats.rateLimited, 1, `attempt keys 1-3 each received one rejected request (${key.label})`)
        assert.equal(key.cooling, true)
      } else {
        assert.equal(key.stats.rateLimited, 0, 'unused keys stay untouched once attempts are exhausted')
      }
    }
    assert.equal(snap.scheduler.allUnavailableEvents, 0, 'the adapter surfaces instead of waiting through every cooldown')
  } finally {
    await mock.close()
  }
})

test('adapter: error matrix maps every HTTP status to the harness taxonomy', async () => {
  const cases = [
    ['bad-request', 400, 'INVALID_REQUEST'],
    ['auth-error', 401, 'AUTH'],
    ['forbidden', 403, 'AUTH'],
    ['not-found', 404, 'HTTP_404'],
    ['quota', 402, 'QUOTA'],
    ['server-error', 500, 'SERVER'],
    ['server-error', 502, 'SERVER'],
    ['server-error', 503, 'SERVER'],
    ['server-error', 504, 'SERVER'],
  ]
  for (const [behavior, status, code] of cases) {
    const mock = await startMockNvidia({
      behaviors: { [KEY_VALUES.NVIDIA_API_KEY_1]: { behavior, status } },
    })
    try {
      const { adapter, scheduler } = buildAdapter(mock, { maxFailoverAttempts: 0 })
      const outcome = await collect(adapter, chatRequest(['probe']))
      assert.ok(outcome.error instanceof LlmError, `${behavior} surfaces as LlmError`)
      assert.equal(outcome.error.code, code, `${behavior} (HTTP ${status}) maps to ${code}`)
      assert.equal(outcome.error.failure.status, status)
      assert.equal(mock.requests.length, 1, 'deterministic failures never fail over')
      const key = scheduler.snapshot().keys[0]
      if (code === 'AUTH') assert.equal(key.credentialError, true, 'auth failures mark the key config-error')
      if (code === 'QUOTA') assert.equal(key.stats.quotaErrors, 1, 'quota failures cool the key at account level')
    } finally {
      await mock.close()
    }
  }
})

test('adapter: a stalled stream times out, keeps its count, and retries stay bounded', async () => {
  const mock = await startMockNvidia({
    behaviors: Object.fromEntries(Object.values(KEY_VALUES).map(key => [key, { behavior: 'stall' }])),
  })
  try {
    const { adapter, scheduler } = buildAdapter(mock, { streamIdleTimeoutMs: 150, requestTimeoutMs: 150, maxFailoverAttempts: 1 })
    const outcome = await collect(adapter, chatRequest(['stall probe']))
    assert.ok(outcome.error instanceof LlmError)
    assert.equal(outcome.error.code, 'TIMEOUT')
    assert.equal(mock.requests.length, 2, 'one attempt plus one bounded failover attempt')
    const snap = scheduler.snapshot()
    assert.equal(snap.keys[0].windowCount, 1, 'the possibly-consumed request keeps its reservation')
    assert.equal(snap.keys[1].windowCount, 1, 'the failover attempt keeps its reservation too')
    assert.equal(snap.keys[0].stats.timeouts, 1)
    assert.equal(snap.keys[0].stats.sent, 1)
    assert.equal(snap.keys[1].stats.timeouts, 1)
  } finally {
    await mock.close()
  }
})

test('adapter: a connection reset after visible content never resends on another key', async () => {
  const mock = await startMockNvidia({
    behaviors: {
      [KEY_VALUES.NVIDIA_API_KEY_1]: { behavior: 'drop' },
      [KEY_VALUES.NVIDIA_API_KEY_2]: { behavior: 'ok', script: greetingStream() },
    },
  })
  try {
    const { adapter, scheduler } = buildAdapter(mock)
    const seen = []
    let error
    try {
      for await (const chunk of adapter.stream(chatRequest(['drop test']))) {
        seen.push(chunk.type)
      }
    } catch (caught) {
      error = caught
    }
    assert.ok(error instanceof LlmError, 'mid-stream transport loss surfaces as a failure')
    assert.equal(error.code, 'TRANSPORT')
    assert.equal(mock.requests.length, 1, 'no second key attempt after content was already delivered')
    assert.equal(scheduler.snapshot().keys[1].stats.sent, 0)
  } finally {
    await mock.close()
  }
})

test('adapter: an empty completion is classified EMPTY_RESPONSE, not a silent empty turn', async () => {
  const mock = await startMockNvidia({
    behaviors: { [KEY_VALUES.NVIDIA_API_KEY_1]: { behavior: 'empty' } },
  })
  try {
    const { adapter, scheduler } = buildAdapter(mock)
    const result = await collect(adapter, chatRequest(['empty please']))
    assert.equal(result.finish.reason.kind, 'error')
    assert.equal(result.finish.reason.failure.code, 'EMPTY_RESPONSE')
    assert.equal(scheduler.snapshot().keys[0].stats.emptyResponses, 1)
  } finally {
    await mock.close()
  }
})

test('adapter: in-band provider errors end the stream with an error finish', async () => {
  const mock = await startMockNvidia({
    behaviors: { [KEY_VALUES.NVIDIA_API_KEY_1]: { behavior: 'in-band-error' } },
  })
  try {
    const { adapter } = buildAdapter(mock, { maxFailoverAttempts: 0 })
    const result = await collect(adapter, chatRequest(['in-band probe']))
    assert.equal(result.finish.reason.kind, 'error')
    assert.equal(result.finish.reason.failure.message, 'upstream overloaded')
  } finally {
    await mock.close()
  }
})

test('adapter: content_filter surfaces as a distinct non-retryable failure', async () => {
  const mock = await startMockNvidia({
    behaviors: { [KEY_VALUES.NVIDIA_API_KEY_1]: { behavior: 'content-filter' } },
  })
  try {
    const { adapter } = buildAdapter(mock, { maxFailoverAttempts: 0 })
    const result = await collect(adapter, chatRequest(['filter probe']))
    assert.equal(result.finish.reason.kind, 'error')
    assert.equal(result.finish.reason.failure.code, 'CONTENT_FILTERED')
    assert.equal(mock.requests.length, 1, 'a provider refusal never fails over')
  } finally {
    await mock.close()
  }
})

test('adapter: cancelling before dispatch releases the reservation; cancelling after chunks keeps it', async () => {
  const mock = await startMockNvidia({
    behaviors: { [KEY_VALUES.NVIDIA_API_KEY_1]: { behavior: 'ok', script: greetingStream(), delayMs: 30 } },
  })
  try {
    const { adapter, scheduler } = buildAdapter(mock)

    // Pre-dispatch cancel: signal already aborted when the stream starts.
    const pre = await collect(adapter, { ...chatRequest(['abort me']), signal: AbortSignal.abort() })
    assert.ok(pre.error instanceof LlmError && pre.error.code === 'ABORTED', 'pre-dispatch cancel surfaces ABORTED')
    assert.equal(scheduler.snapshot().keys[0].windowCount, 0, 'a request that never left the client releases its slot')
    assert.equal(scheduler.snapshot().keys[0].stats.sent, 0)

    // Mid-stream cancel: one chunk delivered, then cancellation.
    const controller = new AbortController()
    const seen = []
    const outcome = await collect(adapter, { ...chatRequest(['abort mid-stream']), signal: controller.signal }, {
      onChunk: type => {
        seen.push(type)
        if (seen.length === 2) controller.abort()
      },
    })
    assert.ok(outcome.error instanceof LlmError && outcome.error.code === 'ABORTED', 'mid-stream cancel ends with ABORTED')
    assert.ok(seen.includes('block-start') || seen.includes('text-delta'), 'content was visible before the cancel')
    assert.equal(scheduler.snapshot().keys[0].windowCount, 1, 'a request that reached the server keeps its slot')
    assert.equal(scheduler.snapshot().keys[0].stats.sent, 1)
  } finally {
    await mock.close()
  }
})

test('adapter: concurrent callers (main agent and subagent simulation) share one scheduler and one count', async () => {
  const mock = await startMockNvidia({
    behaviors: {
      [KEY_VALUES.NVIDIA_API_KEY_1]: { behavior: 'ok', script: greetingStream(), delayMs: 10 },
      [KEY_VALUES.NVIDIA_API_KEY_2]: { behavior: 'ok', script: greetingStream(), delayMs: 10 },
    },
  })
  try {
    const { adapter, scheduler } = buildAdapter(mock, { safeThreshold: 2 })
    const runs = await Promise.all([
      collect(adapter, chatRequest(['main agent request'])),
      collect(adapter, chatRequest(['subagent request'])),
      collect(adapter, chatRequest(['another subagent request'])),
      collect(adapter, chatRequest(['a fourth request'])),
    ])
    for (const run of runs) assert.equal(run.finish.reason.kind, 'stop')
    const snap = scheduler.snapshot()
    assert.equal(snap.scheduler.totalRequestsReserved, 4, 'every concurrent caller reserved through the same scheduler')
    assert.equal(snap.keys[0].windowCount + snap.keys[1].windowCount, 4)
    assert.ok(snap.keys[0].windowCount <= 2 && snap.keys[1].windowCount <= 2, 'no key exceeded its threshold under concurrency')
  } finally {
    await mock.close()
  }
})

test('adapter: the request carries attribution headers and only supported fields', async () => {
  const mock = await startMockNvidia()
  try {
    const { adapter } = buildAdapter(mock)
    await collect(adapter, chatRequest(['headers probe'], { temperature: 0.7, maxTokens: 512, stop: ['END'] }))
    const body = mock.requests[0].body
    assert.equal(body.model, 'mock/model-a')
    assert.equal(body.stream, true)
    assert.equal(body.stream_options.include_usage, true)
    assert.equal(body.temperature, 0.7)
    assert.equal(body.max_tokens, 512)
    assert.deepEqual(body.stop, ['END'])
    assert.equal(body.tool_choice, undefined, 'no tool_choice without tools')
    assert.equal(body.messages.length, 1, 'one-shot requests send exactly their messages')
  } finally {
    await mock.close()
  }
})

test('adapter: reasoning_content deltas assemble into a reasoning block', async () => {
  const script = [
    sseEvent({ id: '1', choices: [{ delta: { reasoning_content: 'thinking hard' } }] }),
    sseEvent({ id: '1', choices: [{ delta: { content: 'answer' } }] }),
    sseEvent({ id: '1', choices: [{ delta: {}, finish_reason: 'stop' }] }),
    sseEvent({ id: '1', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }),
    SSE_DONE,
  ]
  const mock = await startMockNvidia({
    behaviors: { [KEY_VALUES.NVIDIA_API_KEY_1]: { behavior: 'ok', script } },
  })
  try {
    const { adapter } = buildAdapter(mock)
    const result = await collect(adapter, chatRequest(['reason please']))
    const reasoning = result.blocks.find(block => block.type === 'reasoning')
    assert.ok(reasoning, 'reasoning assembled as its own block')
    assert.equal(reasoning.text, 'thinking hard')
    assert.equal(result.blocks.find(block => block.type === 'text').text, 'answer')
    assert.equal(result.blocks[0].type, 'reasoning', 'reasoning precedes text in first-seen order')
  } finally {
    await mock.close()
  }
})

test('adapter: a runtime-validated reasoningEffort rides the request per reasoningEffortParam', async () => {
  const mock = await startMockNvidia({
    behaviors: { [KEY_VALUES.NVIDIA_API_KEY_1]: { behavior: 'ok', script: greetingStream() } },
  })
  try {
    // Default 'none': the effort stays session-side metadata, exactly the
    // bytes pi-ai sends for this endpoint (its catalog marks the NVIDIA
    // route as ignoring effort parameters), and the request succeeds.
    const quiet = buildAdapter(mock)
    const quietOutcome = await collect(quiet.adapter, chatRequest(['effort probe'], { reasoningEffort: 'high' }))
    assert.equal(quietOutcome.error, undefined)
    assert.equal(quietOutcome.finish.reason.kind, 'stop')
    assert.equal(mock.requests[0].body.reasoning_effort, undefined,
      'the default param mode never writes reasoning_effort')

    // 'reasoning_effort': the OpenAI-style field rides the body verbatim.
    const forwarding = buildAdapter(mock, { reasoningEffortParam: 'reasoning_effort' })
    const forwardOutcome = await collect(forwarding.adapter, chatRequest(['effort probe'], { reasoningEffort: 'medium' }))
    assert.equal(forwardOutcome.error, undefined)
    assert.equal(mock.requests[1].body.reasoning_effort, 'medium')

    // An absent effort sends nothing in either mode.
    const absent = await collect(buildAdapter(mock, { reasoningEffortParam: 'reasoning_effort' }).adapter, chatRequest(['plain']))
    assert.equal(absent.error, undefined)
    assert.equal(mock.requests[2].body.reasoning_effort, undefined)
  } finally {
    await mock.close()
  }
})

test('adapter: missing credentials mark the key and fail over to a configured key', async () => {
  const mock = await startMockNvidia({
    behaviors: { [KEY_VALUES.NVIDIA_API_KEY_2]: { behavior: 'ok', script: greetingStream() } },
  })
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
      maxFailoverAttempts: 2,
      allUnavailableWaitMs: 50,
      streamIdleTimeoutMs: 300_000,
    requestTimeoutMs: 120_000,
      streamUsage: true,
    })
    const scheduler = new QuotaScheduler({ options })
    const resolveKey = async envRef => {
      if (envRef === 'NVIDIA_API_KEY_1') throw new LlmError('no key stored for NVIDIA_API_KEY_1', 'MISSING_CREDENTIAL')
      return KEY_VALUES[envRef]
    }
    const adapter = new NvidiaRouterAdapter({ options, scheduler, resolveKey })
    const result = await collect(adapter, chatRequest(['cred failover']))
    assert.equal(result.finish.reason.kind, 'stop')
    const snap = scheduler.snapshot()
    assert.equal(snap.keys[0].credentialError, true, 'the unconfigured key is marked, not silently skipped')
    assert.equal(snap.keys[0].windowCount, 0, 'a request that never left the client keeps no count')
    assert.equal(snap.keys[1].stats.ok, 1)
  } finally {
    await mock.close()
  }
})
