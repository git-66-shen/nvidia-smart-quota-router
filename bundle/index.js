/**
 * llm-nvidia-router: NVIDIA API provider route for DeepSeek Harness with
 * sticky multi-key quota scheduling. Every model call in this process — the
 * main agent, in-process subagents, session titles, compaction — reserves
 * quota atomically through one shared scheduler before its HTTP request.
 * @module @local/dsh-llm-nvidia-router
 */

import { assertUsableApiKey, attributionHeaders, LlmError } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { Config, plainOptions, resolveAdapterOptions } from './config.js'
import { QuotaScheduler } from './scheduler.js'
import { NvidiaRouterAdapter } from './adapter.js'
import { classifyHttpError } from './errors.js'
import { registerStatusTool } from './status.js'
import { registerConnectionRoutes } from './routes.js'

export const name = 'llm-nvidia-router'
export const inject = ['llm']
export { Config }

const PKG = 'llm-nvidia-router'

/**
 * Register the NVIDIA provider route, its configurable-provider directory
 * entry, endpoint model discovery, the redacted status tool, and the browser
 * routes (model probe + header health) the settings page and header badge use.
 * @param {object} ctx - registrant context.
 * @param {object} config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const environment = launchEnvironmentOf(ctx)
  const options = () => resolveAdapterOptions(plainOptions(config), environment)
  const resolved = options()
  const settingsNs = ctx.fiber.entry?.options.id ?? name

  /**
   * Resolve one credential reference through the credentials service when
   * present (its precedence applies), otherwise through the launch
   * environment. The resolved value never enters logs or status output.
   * @param {string} envRef - credential reference name.
   * @returns {Promise<string>} validated API key.
   */
  const resolveKey = async (envRef) => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(envRef)
      if (hit !== undefined) return assertUsableApiKey(hit.value, PKG, envRef)
    } else {
      const ambient = environment.get(envRef)
      if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, PKG, envRef)
    }
    throw new LlmError(
      `${PKG}: no API key resolved from ${envRef}; store ${envRef} through the credentials service`
      + ' (the web Models page writes it) or export it in the launching environment',
      'MISSING_CREDENTIAL',
    )
  }

  /**
   * Resolve the first configured key that currently resolves, so discovery and
   * the probe follow whichever credential the user actually stored — not a row
   * that happens to be first. Throws the last failure when none resolve.
   * @returns {Promise<string>} validated API key.
   */
  const resolveAnyKey = async () => {
    let lastError
    for (const spec of options().apiKeys) {
      try {
        return await resolveKey(spec.env)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new LlmError(`${PKG}: no configured key could be resolved`, 'MISSING_CREDENTIAL')
  }

  /**
   * Report whether one reference currently resolves to a value, through the
   * credentials service or the launch environment — the fact the header badge
   * counts as "an API configured". The value itself is never read out.
   * @param {string} envRef - credential reference name.
   * @returns {Promise<boolean>} whether the reference is currently supplied.
   */
  const keyConfigured = async (envRef) => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        return (await credentials.describe(envRef))?.configured === true
      } catch {
        return false
      }
    }
    return environment.get(envRef) !== undefined
  }

  const scheduler = new QuotaScheduler({ options, logger: ctx.logger })
  const adapter = new NvidiaRouterAdapter({ options, scheduler, resolveKey, logger: ctx.logger })

  ctx.llm.registerConfigurableProviders([
    { provider: resolved.provider, displayName: resolved.providerName, settingsNs, settingsPath: [] },
  ])

  ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
    const snapshot = options()
    const baseURL = typeof request.baseURL === 'string' && request.baseURL.length > 0
      ? request.baseURL.replace(/\/+$/u, '')
      : snapshot.baseURL.replace(/\/+$/u, '')
    const key = typeof request.apiKey === 'string' && request.apiKey.length > 0
      ? request.apiKey
      : await resolveAnyKey()
    const response = await fetch(`${baseURL}/models`, {
      headers: { ...attributionHeaders(), authorization: `Bearer ${key}` },
      signal,
    })
    if (!response.ok) {
      throw classifyHttpError(response.status, await response.text(), response.headers)
    }
    const payload = await response.json().catch(() => null)
    const data = typeof payload === 'object' && payload !== null && Array.isArray(payload.data) ? payload.data : []
    return data
      .filter(model => typeof model === 'object' && model !== null && typeof model.id === 'string' && model.id.length > 0)
      .map(model => ({ id: model.id }))
  })

  ctx.llm.registerAdapter([resolved.provider], adapter)

  if (resolved.enableStatusTool) {
    registerStatusTool({ ctx, scheduler })
  }

  registerConnectionRoutes({ ctx, scheduler, options, resolveAnyKey, keyConfigured })
}
