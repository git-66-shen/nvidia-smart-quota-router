/**
 * Redacted read-only status surface: the `nvidia_quota_status` tool reports
 * the scheduler's local estimates. Credential values never appear; keys are
 * identified by label and credential reference name only.
 * @module @local/dsh-llm-nvidia-router/status
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

const TOOL_NAME = 'nvidia_quota_status'

/** JSON schema of the snapshot this tool returns. */
const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    estimateBasis: { type: 'string', required: true },
    windowMs: { type: 'integer', required: true },
    safeThreshold: { type: 'integer', required: true },
    activeKey: { type: 'string' },
    scheduler: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        stickySwitches: { type: 'integer', required: true },
        allUnavailableEvents: { type: 'integer', required: true },
        totalRequestsReserved: { type: 'integer', required: true },
      },
    },
    keys: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string', required: true },
          credentialRef: { type: 'string', required: true },
          windowCount: { type: 'integer', required: true },
          remainingEstimate: { type: 'integer', required: true },
          cooling: { type: 'boolean', required: true },
          cooldownRemainingMs: { type: 'integer', required: true },
          cooldownReason: { type: 'string', required: true },
          credentialError: { type: 'boolean', required: true },
          consecutiveRateLimits: { type: 'integer', required: true },
          lastFailure: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string', required: true },
              at: { type: 'integer', required: true },
            },
          },
          stats: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              sent: { type: 'integer', required: true },
              ok: { type: 'integer', required: true },
              rateLimited: { type: 'integer', required: true },
              authErrors: { type: 'integer', required: true },
              quotaErrors: { type: 'integer', required: true },
              serverErrors: { type: 'integer', required: true },
              timeouts: { type: 'integer', required: true },
              transportErrors: { type: 'integer', required: true },
              emptyResponses: { type: 'integer', required: true },
            },
          },
        },
      },
    },
  },
}

/**
 * Render the snapshot as one compact text block for the transcript.
 * @param {object} value - scheduler snapshot.
 * @returns {string}
 */
function renderStatus(value) {
  const lines = [
    `NVIDIA Smart Quota Router — ${value.estimateBasis}`,
    `Active key: ${value.activeKey ?? '(none)'} · window ${Math.round(value.windowMs / 1000)}s · local safe threshold ${value.safeThreshold}`,
  ]
  for (const key of value.keys) {
    const cooling = key.cooling ? `, cooling ${Math.ceil(key.cooldownRemainingMs / 1000)}s (${key.cooldownReason})` : ''
    const last = key.lastFailure === undefined ? '' : `, last ${key.lastFailure.code}`
    lines.push(
      `${key.label} (${key.credentialRef}): ${key.windowCount} in window, ~${key.remainingEstimate} left`
      + ` — ok ${key.stats.ok}, 429 ${key.stats.rateLimited}, timeouts ${key.stats.timeouts}, auth ${key.stats.authErrors}`
      + `${cooling}${last}`,
    )
  }
  lines.push(
    `Sticky switches ${value.scheduler.stickySwitches} · all-keys-unavailable events ${value.scheduler.allUnavailableEvents}`
    + ` · reserved requests ${value.scheduler.totalRequestsReserved}`,
  )
  return lines.join('\n')
}

/**
 * Register the read-only status tool on the tools registry when it is
 * available; a composition without the tools service skips the tool with a
 * warning instead of failing the provider route.
 * @param {object} init
 * @param {object} init.ctx - registrant context.
 * @param {object} init.scheduler - the shared quota scheduler.
 */
export function registerStatusTool({ ctx, scheduler }) {
  const tools = ctx.get('tools')
  if (tools === undefined) {
    ctx.logger.warn(`${TOOL_NAME}: the tools service is unavailable; the quota status tool was not registered`)
    return
  }
  tools.register(defineTool({
    name: TOOL_NAME,
    description:
      'Read the NVIDIA Smart Quota Router status: per-key rolling-window request counts (local estimate,'
      + ' redacted key labels), cooldown states with recovery estimates, error counters (429/timeout/auth),'
      + ' sticky-switch and all-keys-unavailable totals. Read-only diagnostics; no request is sent.',
    parameters: {},
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    execute: () => Promise.resolve(scheduler.snapshot()),
  }))
}
