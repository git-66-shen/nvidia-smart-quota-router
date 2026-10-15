/**
 * OpenAI-compatible wire layer for the NVIDIA chat/completions endpoint:
 * request serialization from the harness message vocabulary and SSE stream
 * translation into the raw StreamChunk protocol (block indexes in first-seen
 * order, raw JSON tool arguments, usage before finish, nothing after finish).
 * @module @local/dsh-llm-nvidia-router/wire
 */

import { attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import { classifyInBandError } from './errors.js'

const PKG = 'llm-nvidia-router'

/**
 * Flatten one message's content blocks into the plain text this text-only
 * route sends. Assistant tool-call blocks serialize separately in the
 * assistant branch; reasoning blocks are provider thinking and are not
 * replayed on any later request. File and image references never reach an
 * adapter (request assembly projects them to deterministic handle text); an
 * unknown block kind without text fails loud rather than silently dropping
 * model-visible content.
 * @param {readonly object[]} content
 * @param {string} role - message role for diagnostics.
 * @returns {string}
 */
function contentText(content, role) {
  const parts = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    if (block.type === 'tool-call') continue
    if (block.type === 'reasoning') continue
    if (typeof block.text === 'string') {
      if (block.text.length > 0) parts.push(block.text)
      continue
    }
    throw new LlmError(
      `${PKG}: message role "${role}" carries an unsupported content block type`
      + ` ${JSON.stringify(block.type)}; this route sends text only`,
      'INVALID_REQUEST',
    )
  }
  return parts.join('\n')
}

/**
 * Serialize the harness request into an OpenAI-compatible chat/completions
 * body. Assistant reasoning blocks are not replayed (providers do not accept
 * them back); tool results map to the `tool` role with `tool_call_id`.
 * @param {object} options - GenerateOptions.
 * @param {object} connection - resolved settings snapshot.
 * @param {string} apiKey - resolved credential for this request.
 * @returns {{ url: string, headers: Record<string, string>, body: string }}
 */
export function serializeRequest(options, connection, apiKey) {
  const messages = []
  if (typeof options.system === 'string' && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages) {
    switch (message.role) {
      case 'system':
      case 'developer':
        messages.push({ role: 'system', content: contentText(message.content, message.role) })
        break
      case 'user':
        messages.push({ role: 'user', content: contentText(message.content, message.role) })
        break
      case 'assistant': {
        const text = contentText(message.content, message.role)
        const toolCalls = message.content.filter(block => block.type === 'tool-call')
        const wire = { role: 'assistant', content: text.length > 0 ? text : null }
        if (toolCalls.length > 0) {
          wire.tool_calls = toolCalls.map(block => ({
            type: 'function',
            id: block.id,
            function: { name: block.name, arguments: block.arguments },
          }))
        }
        messages.push(wire)
        break
      }
      case 'tool':
        messages.push({
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: contentText(message.content, message.role),
        })
        break
      default:
        throw new LlmError(`${PKG}: unsupported message role ${JSON.stringify(message.role)}`, 'INVALID_REQUEST')
    }
  }
  const body = {
    model: options.model,
    messages,
    stream: true,
  }
  if (connection.streamUsage) body.stream_options = { include_usage: true }
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map(tool => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
    body.tool_choice = 'auto'
  }
  if (typeof options.temperature === 'number') body.temperature = options.temperature
  if (typeof options.maxTokens === 'number') body.max_tokens = options.maxTokens
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop
  // The runtime validated the effort against the model's declared levels before
  // dispatch. Whether the wire carries it at all is a deployment fact: 'none'
  // matches the pi-ai catalog's verdict that this endpoint ignores effort
  // parameters; 'reasoning_effort' forwards the OpenAI-style field.
  if (connection.reasoningEffortParam === 'reasoning_effort'
    && typeof options.reasoningEffort === 'string' && options.reasoningEffort.length > 0) {
    body.reasoning_effort = options.reasoningEffort
  }
  return {
    url: `${connection.baseURL.replace(/\/+$/u, '')}/chat/completions`,
    headers: {
      ...attributionHeaders(),
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  }
}

/**
 * Streaming bookkeeping for one response: block indexes in first-seen order,
 * raw JSON tool arguments accumulated per provider index.
 */
class StreamState {
  constructor() {
    this.nextIndex = 0
    /** @type {{ index: number, parts: string[] } | undefined} */
    this.text = undefined
    /** @type {{ index: number, parts: string[] } | undefined} */
    this.reasoning = undefined
    /** @type {Map<number, { index: number, id: string, name: string, argParts: string[] }>} keyed by provider tool index. */
    this.toolCalls = new Map()
    this.usage = undefined
    this.finishReason = undefined
    this.blocks = 0
  }

  /** @param {string} text @returns {object} the text-delta chunk */
  openText(text) {
    if (this.text === undefined) {
      this.text = { index: this.nextIndex++, parts: [] }
      this.blocks++
    }
    this.text.parts.push(text)
    return { type: 'text-delta', index: this.text.index, text }
  }

  /** @param {string} text @returns {object} the reasoning-delta chunk */
  openReasoning(text) {
    if (this.reasoning === undefined) {
      this.reasoning = { index: this.nextIndex++, parts: [] }
      this.blocks++
    }
    this.reasoning.parts.push(text)
    return { type: 'reasoning-delta', index: this.reasoning.index, text }
  }

  /**
   * Feed one provider tool-call fragment.
   * @param {number} providerIndex - fragment index from the wire.
   * @param {string | undefined} id - provider call id, present on the first fragment.
   * @param {string | undefined} name - tool name, present on the first fragment.
   * @param {string | undefined} argumentsDelta - raw JSON argument fragment.
   * @returns {object[]} chunks to emit for this fragment.
   */
  feedToolCall(providerIndex, id, name, argumentsDelta) {
    const chunks = []
    let call = this.toolCalls.get(providerIndex)
    if (call === undefined) {
      call = { index: this.nextIndex++, id: id ?? '', name: name ?? '', argParts: [] }
      this.toolCalls.set(providerIndex, call)
      this.blocks++
      chunks.push({ type: 'block-start', index: call.index, blockType: 'tool-call' })
    }
    if (id !== undefined && id.length > 0) call.id = id
    if (name !== undefined && name.length > 0) call.name = name
    chunks.push({
      type: 'tool-call-delta',
      index: call.index,
      id: call.id,
      ...name !== undefined && name.length > 0 ? { name } : {},
      argumentsDelta: argumentsDelta ?? '',
    })
    if (argumentsDelta !== undefined) call.argParts.push(argumentsDelta)
    return chunks
  }

  /** Close every open block in first-seen index order. @returns {object[]} */
  closeBlocks() {
    const open = []
    if (this.text !== undefined) open.push(this.text)
    if (this.reasoning !== undefined) open.push(this.reasoning)
    for (const call of this.toolCalls.values()) open.push(call)
    open.sort((a, b) => a.index - b.index)
    const chunks = []
    for (const block of open) {
      if (block === this.text) {
        chunks.push({ type: 'block-end', index: block.index, block: { type: 'text', text: block.parts.join('') } })
      } else if (block === this.reasoning) {
        chunks.push({ type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.parts.join('') } })
      } else {
        chunks.push({
          type: 'block-end',
          index: block.index,
          block: {
            type: 'tool-call',
            id: block.id,
            name: block.name,
            arguments: block.argParts.join(''),
          },
        })
      }
    }
    return chunks
  }
}

/** Map a provider finish reason to the harness vocabulary. */
function finishKind(reason) {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    default:
      return { kind: 'stop' }
  }
}

/**
 * Translate one decoded SSE data payload into stream chunks.
 * @param {StreamState} state
 * @param {unknown} payload - decoded JSON event.
 * @returns {object[]} chunks to emit for this event.
 */
function feedEvent(state, payload) {
  if (typeof payload !== 'object' || payload === null) return []
  if ('error' in payload && payload.error !== undefined) {
    throw classifyInBandError(payload)
  }
  const chunks = []
  if ('usage' in payload && typeof payload.usage === 'object' && payload.usage !== null) {
    const usage = payload.usage
    const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined
    const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined
    const cached = typeof usage.prompt_tokens_details?.cached_tokens === 'number'
      ? usage.prompt_tokens_details.cached_tokens
      : 0
    if (promptTokens !== undefined || completionTokens !== undefined) {
      state.usage = {
        inputTokens: Math.max(0, (promptTokens ?? 0) - cached),
        outputTokens: completionTokens ?? 0,
        ...cached > 0 ? { cacheReadTokens: cached } : {},
        ...typeof usage.total_tokens === 'number' ? { totalTokens: usage.total_tokens } : {},
        ...typeof usage.completion_tokens_details?.reasoning_tokens === 'number'
          && usage.completion_tokens_details.reasoning_tokens > 0
          ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }
          : {},
      }
    }
  }
  const choice = Array.isArray(payload.choices) && payload.choices.length > 0 ? payload.choices[0] : undefined
  if (typeof choice === 'object' && choice !== null) {
    const delta = typeof choice.delta === 'object' && choice.delta !== null ? choice.delta : {}
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      const first = state.text === undefined
      chunks.push(...(first ? [{ type: 'block-start', index: state.nextIndex, blockType: 'text' }] : []))
      chunks.push(state.openText(delta.content))
    }
    const reasoningText = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
      : typeof delta.reasoning === 'string' ? delta.reasoning
        : undefined
    if (reasoningText !== undefined && reasoningText.length > 0) {
      const first = state.reasoning === undefined
      chunks.push(...(first ? [{ type: 'block-start', index: state.nextIndex, blockType: 'reasoning' }] : []))
      chunks.push(state.openReasoning(reasoningText))
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const fragment of delta.tool_calls) {
        if (typeof fragment !== 'object' || fragment === null) continue
        const fn = typeof fragment.function === 'object' && fragment.function !== null ? fragment.function : {}
        chunks.push(...state.feedToolCall(
          typeof fragment.index === 'number' ? fragment.index : 0,
          typeof fragment.id === 'string' ? fragment.id : undefined,
          typeof fn.name === 'string' ? fn.name : undefined,
          typeof fn.arguments === 'string' ? fn.arguments : undefined,
        ))
      }
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
      state.finishReason = choice.finish_reason
    }
  }
  return chunks
}

/**
 * Translate an OpenAI-compatible SSE body into raw stream chunks. Yields
 * block chunks as they arrive; closes blocks, emits usage, then exactly one
 * terminal finish chunk at the `[DONE]` marker or clean stream end. A
 * provider in-band error ends the stream with an error finish; a completion
 * with zero content blocks is classified EMPTY_RESPONSE.
 * @param {ReadableStream<Uint8Array>} body - decoded response body stream.
 * @returns {AsyncGenerator<object>} raw StreamChunk values.
 */
export async function* translateSse(body) {
  const state = new StreamState()
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/u, '')
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (line.length === 0 || line.startsWith(':')) continue
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') {
        return yield* flush(state)
      }
      let decoded
      try {
        decoded = JSON.parse(payload)
      } catch {
        // Ignore unparseable keepalive noise; a malformed data frame is not a
        // provider failure and the stream continues.
        continue
      }
      yield* feedDecoded(state, decoded)
    }
  }
  buffer += decoder.decode()
  if (buffer.trim().startsWith('data:')) {
    const payload = buffer.trim().slice(5).trim()
    if (payload === '[DONE]') return yield* flush(state)
    try {
      return yield* feedDecoded(state, JSON.parse(payload))
    } catch {
      // A trailing partial frame cannot change the settled outcome.
    }
  }
  return yield* flush(state)
}

/**
 * Feed one decoded event, converting a provider in-band error into the
 * terminal error finish the protocol sanctions for in-band failures.
 * @param {StreamState} state
 * @param {unknown} decoded
 * @returns {AsyncGenerator<object>}
 */
async function* feedDecoded(state, decoded) {
  try {
    yield* chunksOf(feedEvent(state, decoded))
  } catch (error) {
    if (error instanceof LlmError) {
      yield { type: 'finish', reason: { kind: 'error', failure: error.failure } }
      return
    }
    throw error
  }
}

/**
 * Emit closing chunks: block-ends in order, usage when present, then the
 * single terminal finish.
 * @param {StreamState} state
 * @returns {AsyncGenerator<object>}
 */
async function* flush(state) {
  if (state.finishReason === 'content_filter') {
    yield* chunksOf(state.closeBlocks())
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'NVIDIA provider stopped generation with content_filter',
          code: 'CONTENT_FILTERED',
        },
      },
    }
    return
  }
  if (state.blocks === 0) {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: `NVIDIA completion finished with reason ${JSON.stringify(state.finishReason ?? 'stop')} but no content blocks`,
          code: 'EMPTY_RESPONSE',
        },
      },
    }
    return
  }
  yield* chunksOf(state.closeBlocks())
  if (state.usage !== undefined) yield { type: 'usage', usage: state.usage }
  yield { type: 'finish', reason: finishKind(state.finishReason) }
}

/** @param {object[]} chunks */
async function* chunksOf(chunks) {
  for (const chunk of chunks) yield chunk
}
