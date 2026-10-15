/**
 * Plugin configuration schema and complete request-local resolution for the
 * NVIDIA router adapter. Every deployment-varying choice is a validated,
 * cordis.yml-editable field; nothing tunable is hardcoded.
 * @module @local/dsh-llm-nvidia-router/config
 */

import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'

/** Public NVIDIA OpenAI-compatible inference endpoint. */
export const PUBLIC_BASE_URL = 'https://integrate.api.nvidia.com/v1'

/** Environment variable naming this provider's endpoint, honored only from trusted layers. */
export const BASE_URL_ENV = 'NVIDIA_BASE_URL'

/** Default key table: four credential references, named exactly like the keys they name. */
export const DEFAULT_API_KEYS = [
  { env: 'NVIDIA_API_KEY_1', label: 'Key-1' },
  { env: 'NVIDIA_API_KEY_2', label: 'Key-2' },
  { env: 'NVIDIA_API_KEY_3', label: 'Key-3' },
  { env: 'NVIDIA_API_KEY_4', label: 'Key-4' },
]

/**
 * Advisory model catalog defaults. Ids must match NVIDIA's hosted model
 * listing (build.nvidia.com); they are configuration metadata, not remote
 * validation, and every entry is editable or replaceable from cordis.yml.
 */
export const DEFAULT_MODELS = [
  {
    id: 'deepseek-ai/deepseek-v3.1',
    name: 'DeepSeek V3.1 (NVIDIA)',
    description: 'DeepSeek V3.1 served through the NVIDIA API catalog.',
    contextWindow: 131072,
    maxTokens: 8192,
  },
  {
    id: 'meta/llama-3.3-70b-instruct',
    name: 'Llama 3.3 70B Instruct (NVIDIA)',
    description: 'Meta Llama 3.3 70B served through the NVIDIA API catalog.',
    contextWindow: 131072,
    maxTokens: 8192,
  },
]

/**
 * Read the current value behind every volatile reference of a parsed Config.
 * @param {Record<string, unknown>} config - parsed plugin Config.
 * @returns {Record<string, unknown>} plain options for the resolver.
 */
export function plainOptions(config) {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, isVolatile(value) ? value.get() : value]))
}

/**
 * Schemastery configuration for the router plugin row; volatile fields stay
 * editable from the settings surface without a reload.
 */
export const Config = z.object({
  // Route id defaults to nvidia-router: the base profile's pi-ai adapter
  // already declares "nvidia" in the configurable-provider directory, and a
  // colliding route id would fail activation (DUPLICATE_DIRECTORY).
  provider: z.string().default('nvidia-router').volatile(),
  providerName: z.string().default('NVIDIA (Quota Router)').volatile(),
  baseURL: z.string().volatile(),
  apiKeys: z.array(z.object({
    env: z.string().required(),
    label: z.string(),
  })).default(DEFAULT_API_KEYS).volatile(),
  models: z.array(z.object({
    id: z.string().required(),
    name: z.string(),
    description: z.string(),
    contextWindow: z.number().step(1).min(1),
    maxTokens: z.number().step(1).min(1),
  })).default(DEFAULT_MODELS).volatile(),
  windowMs: z.number().step(1).min(1).default(60_000).volatile(),
  safeThreshold: z.number().step(1).min(1).default(38).volatile(),
  rateLimitCooldownMs: z.number().step(1).min(1).default(5_000).volatile(),
  rateLimitCooldownMaxMs: z.number().step(1).min(1).default(300_000).volatile(),
  authErrorCooldownMs: z.number().step(1).min(1).default(900_000).volatile(),
  quotaCooldownMs: z.number().step(1).min(1).default(1_800_000).volatile(),
  maxFailoverAttempts: z.number().step(1).min(0).max(20).default(2).volatile(),
  allUnavailableWaitMs: z.number().step(1).min(0).max(3_600_000).default(15_000).volatile(),
  streamIdleTimeoutMs: z.number().min(1).default(300_000).volatile(),
  requestTimeoutMs: z.number().step(1).min(0).max(2_147_483_000).default(120_000).volatile(),
  streamUsage: z.boolean().default(true).volatile(),
  enableStatusTool: z.boolean().default(true).volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
})

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function positiveInt(value, field, min, max) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`llm-nvidia-router: ${field} must be an integer from ${min} through ${max}`)
  }
  return value
}

/**
 * @param {unknown} value - configured baseURL, if any.
 * @param {(ref: string) => { value: string } | undefined} [environmentGet]
 * @returns {string} validated endpoint root.
 */
function resolveBaseURL(value, environmentGet) {
  const configured = typeof value === 'string' && value.length > 0
    ? value
    : environmentGet?.(BASE_URL_ENV)?.value
  const baseURL = configured !== undefined && configured.length > 0 ? configured : PUBLIC_BASE_URL
  const parsed = new URL(baseURL)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('llm-nvidia-router: baseURL must be an HTTP(S) root without credentials, query, or fragment')
  }
  return baseURL
}

/**
 * @param {unknown} value
 * @returns {{ env: string, label: string }[]} validated key table.
 */
function resolveKeys(value) {
  const raw = Array.isArray(value) ? value : []
  if (raw.length === 0) throw new Error('llm-nvidia-router: apiKeys must list at least one credential reference')
  const seen = new Set()
  return raw.map((entry, index) => {
    const spec = typeof entry === 'object' && entry !== null ? entry : {}
    const env = typeof spec.env === 'string' ? spec.env.trim() : ''
    if (env.length === 0) {
      throw new Error(`llm-nvidia-router: apiKeys[${index}].env must be a non-empty credential reference`)
    }
    if (seen.has(env)) throw new Error(`llm-nvidia-router: duplicate apiKeys entry "${env}"`)
    seen.add(env)
    const label = typeof spec.label === 'string' && spec.label.trim().length > 0
      ? spec.label.trim()
      : `Key-${index + 1}`
    return { env, label }
  })
}

/**
 * @param {unknown} value
 * @returns {object[]} validated catalog.
 */
function resolveModels(value) {
  const raw = Array.isArray(value) ? value : []
  const seen = new Set()
  return raw.map((entry) => {
    const spec = typeof entry === 'object' && entry !== null ? entry : {}
    const id = typeof spec.id === 'string' ? spec.id.trim() : ''
    if (id.length === 0) throw new Error('llm-nvidia-router: catalog model ids must be non-empty')
    if (seen.has(id)) throw new Error(`llm-nvidia-router: duplicate catalog model "${id}"`)
    seen.add(id)
    const contextWindow = spec.contextWindow === undefined
      ? undefined
      : positiveInt(spec.contextWindow, `catalog model "${id}" contextWindow`, 1, Number.MAX_SAFE_INTEGER)
    const maxTokens = spec.maxTokens === undefined
      ? undefined
      : positiveInt(spec.maxTokens, `catalog model "${id}" maxTokens`, 1, Number.MAX_SAFE_INTEGER)
    return {
      id,
      name: typeof spec.name === 'string' && spec.name.length > 0 ? spec.name : id,
      ...typeof spec.description === 'string' && spec.description.length > 0 ? { description: spec.description } : {},
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    }
  })
}

/**
 * The one explicit resolve step from raw config to validated settings. Every
 * default and bound is re-judged here — at activation (fail loud) and again
 * whenever volatile settings are re-read — because dynamic updates can reach
 * this resolver without schema validation.
 * @param {Record<string, unknown>} config - plain options from the plugin row.
 * @param {{ get: (ref: string) => { value: string } | undefined }} [environment]
 *   this run's trusted environment layers, when available.
 * @returns {object} validated, detached settings snapshot.
 */
export function resolveAdapterOptions(config, environment) {
  const provider = typeof config.provider === 'string' && config.provider.trim().length > 0
    ? config.provider.trim()
    : 'nvidia-router'
  const providerName = typeof config.providerName === 'string' && config.providerName.length > 0
    ? config.providerName
    : 'NVIDIA (Quota Router)'
  const windowMs = positiveInt(config.windowMs ?? 60_000, 'windowMs', 1, 3_600_000_000)
  const safeThreshold = positiveInt(config.safeThreshold ?? 38, 'safeThreshold', 1, 1_000_000)
  const rateLimitCooldownMs = positiveInt(config.rateLimitCooldownMs ?? 5_000, 'rateLimitCooldownMs', 1, 3_600_000)
  const rateLimitCooldownMaxMs = positiveInt(config.rateLimitCooldownMaxMs ?? 300_000, 'rateLimitCooldownMaxMs', 1, 3_600_000)
  if (rateLimitCooldownMs > rateLimitCooldownMaxMs) {
    throw new Error('llm-nvidia-router: rateLimitCooldownMs must not exceed rateLimitCooldownMaxMs')
  }
  const authErrorCooldownMs = positiveInt(config.authErrorCooldownMs ?? 900_000, 'authErrorCooldownMs', 1, 86_400_000)
  const quotaCooldownMs = positiveInt(config.quotaCooldownMs ?? 1_800_000, 'quotaCooldownMs', 1, 86_400_000)
  const maxFailoverAttempts = positiveInt(config.maxFailoverAttempts ?? 2, 'maxFailoverAttempts', 0, 20)
  const allUnavailableWaitMs = positiveInt(config.allUnavailableWaitMs ?? 15_000, 'allUnavailableWaitMs', 0, 3_600_000)
  const streamIdleTimeoutMs = positiveInt(config.streamIdleTimeoutMs ?? 300_000, 'streamIdleTimeoutMs', 1, 2_147_483_000)
  const requestTimeoutMs = positiveInt(config.requestTimeoutMs ?? 120_000, 'requestTimeoutMs', 0, 2_147_483_000)
  return {
    provider,
    providerName,
    baseURL: resolveBaseURL(config.baseURL, environment?.get?.bind(environment)),
    apiKeys: resolveKeys(config.apiKeys),
    models: resolveModels(config.models),
    windowMs,
    safeThreshold,
    rateLimitCooldownMs,
    rateLimitCooldownMaxMs,
    authErrorCooldownMs,
    quotaCooldownMs,
    maxFailoverAttempts,
    allUnavailableWaitMs,
    streamIdleTimeoutMs,
    requestTimeoutMs,
    streamUsage: config.streamUsage !== false,
    enableStatusTool: config.enableStatusTool !== false,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-nvidia-router: retryPolicy'),
  }
}
