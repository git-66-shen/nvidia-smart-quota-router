/**
 * Plugin wiring tests: `apply()` registers the adapter route, the
 * configurable-provider directory entry, endpoint model discovery, and the
 * status tool and the browser probe/health routes; the resolved config flows from the real Config schema; and
 * the model metadata the GUI needs (context window, output cap, text-only
 * modality) resolves per catalog entry.
 * @module nvidia-smart-quota-router/tests/wiring.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { Config, plainOptions, resolveAdapterOptions } from '../bundle/config.js'
import { apply } from '../bundle/index.js'
import { computeHealth } from '../bundle/routes.js'
import { startMockNvidia } from './mock-nvidia-server.js'

/**
 * Build a recording context mimicking the surface apply() uses.
 * @param {object} [options]
 */
function fakeContext(options = {}) {
  const calls = { adapters: [], providers: [], discovery: [], tools: [], routes: [] }
  const lines = []
  const ctx = {
    fiber: { entry: { options: { id: options.entryId ?? 'llm-nvidia-router' } } },
    get: (name) => {
      if (name === 'tools') return { register: (tool) => { calls.tools.push(tool) } }
      if (name === 'connection') {
        return { fetch: { register: (route) => { calls.routes.push(route); return () => Promise.resolve() } } }
      }
      return undefined
    },
    // CORDIS `ctx.inject(names, callback)`: the callback runs only once every
    // named service resolves, so a scoped wait on a missing service stays
    // pending — exactly the behaviour that keeps the browser routes absent in a
    // deployment without a browser channel.
    inject: (names, callback) => {
      const scope = {}
      for (const name of names) {
        const value = ctx.get(name)
        if (value === undefined) return
        scope[name] = value
      }
      callback(Object.assign(Object.create(ctx), scope))
    },
    effect: (fn) => fn(),
    logger: {
      info: () => {}, warn: (...a) => { lines.push(a.map(String).join(' ')) },
      error: () => {}, debug: () => {},
    },
    llm: {
      registerAdapter: (providers, adapter) => {
        calls.adapters.push({ providers, adapter })
        return () => {}
      },
      registerConfigurableProviders: entries => { calls.providers.push(...entries) },
      registerModelDiscovery: (ns, discover) => { calls.discovery.push({ ns, discover }) },
    },
  }
  return { ctx, calls, lines }
}

/** Parse a config through the real schema, exactly as the loader does. */
function parsedConfig(raw) {
  const validation = Config['~standard'].validate(raw)
  if (validation.issues) throw new Error(JSON.stringify(validation.issues))
  return validation.value
}

test('wiring: the Config schema validates and defaults a minimal row', () => {
  const config = parsedConfig({})
  const resolved = resolveAdapterOptions(plainOptions(config), undefined)
  assert.equal(resolved.provider, 'nvidia-router')
  assert.equal(resolved.providerName, 'NVIDIA (Quota Router)')
  assert.equal(resolved.baseURL, 'https://integrate.api.nvidia.com/v1')
  assert.equal(resolved.apiKeys.length, 4)
  assert.equal(resolved.safeThreshold, 38)
  assert.equal(resolved.windowMs, 60_000)
  assert.equal(resolved.maxFailoverAttempts, 2)
  assert.equal(resolved.probeTimeoutMs, 30_000)
  assert.equal(resolved.retryPolicy.mode, 'normal')
  assert.equal(resolved.retryPolicy.maxRetries, 5)
  assert.deepEqual([...resolved.retryPolicy.retryableCodes], [
    'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT',
  ])
})

test('wiring: the resolver re-validates values that bypassed the schema', () => {
  const apiKeys = [{ env: 'NVIDIA_API_KEY_1' }]
  assert.throws(() => resolveAdapterOptions({ apiKeys, safeThreshold: 0 }, undefined), /safeThreshold/)
  assert.throws(() => resolveAdapterOptions({ apiKeys: [] }, undefined), /at least one credential/)
  assert.throws(() => resolveAdapterOptions({ apiKeys: [{ env: 'A' }, { env: 'A' }] }, undefined), /duplicate/)
  assert.throws(() => resolveAdapterOptions({ apiKeys, models: [{ id: '' }] }, undefined), /non-empty/)
  assert.throws(() => resolveAdapterOptions({ apiKeys, baseURL: 'ftp://x/y?z' }, undefined), /HTTP\(S\) root/)
  assert.throws(() => resolveAdapterOptions({ apiKeys, probeTimeoutMs: 0 }, undefined), /probeTimeoutMs/)
})

test('wiring: catalog reasoning levels validate and a default must name a declared level', () => {
  const apiKeys = [{ env: 'NVIDIA_API_KEY_1' }]
  const declared = resolveAdapterOptions({
    apiKeys,
    models: [{ id: 'glm', efforts: ['off', 'low', 'high'], defaultEffort: 'high' }],
  }, undefined)
  assert.deepEqual(declared.models[0].efforts, ['off', 'low', 'high'])
  assert.equal(declared.models[0].defaultEffort, 'high')

  const undeclared = resolveAdapterOptions({ apiKeys, models: [{ id: 'm' }] }, undefined)
  assert.equal(undeclared.models[0].efforts, undefined)
  assert.equal(undeclared.models[0].defaultEffort, undefined)

  assert.throws(() => resolveAdapterOptions({
    apiKeys, models: [{ id: 'glm', efforts: ['low', 'low'] }],
  }, undefined), /must not repeat a level/)
  assert.throws(() => resolveAdapterOptions({
    apiKeys, models: [{ id: 'glm', efforts: ['low'], defaultEffort: 'high' }],
  }, undefined), /defaultEffort must name one of the declared efforts/)
  assert.throws(() => resolveAdapterOptions({
    apiKeys, models: [{ id: 'glm', defaultEffort: 'high' }],
  }, undefined), /defaultEffort requires a non-empty efforts list/)
  assert.throws(() => resolveAdapterOptions({
    apiKeys, models: [{ id: 'glm', efforts: [''] }],
  }, undefined), /efforts must be non-empty strings/)
})

test('wiring: reasoningEffortParam accepts only none and reasoning_effort', () => {
  const apiKeys = [{ env: 'NVIDIA_API_KEY_1' }]
  const base = { apiKeys, models: [{ id: 'm' }] }
  assert.equal(resolveAdapterOptions(base, undefined).reasoningEffortParam, 'none')
  assert.equal(
    resolveAdapterOptions({ ...base, reasoningEffortParam: 'reasoning_effort' }, undefined).reasoningEffortParam,
    'reasoning_effort',
  )
  assert.throws(
    () => resolveAdapterOptions({ ...base, reasoningEffortParam: 'chat_template_kwargs' }, undefined),
    /reasoningEffortParam must be "none" or "reasoning_effort"/,
  )
})

test('wiring: resolveModel declares selectable reasoning levels for catalog entries that state them', async () => {
  const mock = await startMockNvidia()
  try {
    const { ctx, calls } = fakeContext()
    apply(ctx, parsedConfig({
      baseURL: mock.baseURL,
      models: [{ id: 'glm-5.3', name: 'GLM 5.3', efforts: ['off', 'low', 'medium', 'high'], defaultEffort: 'high' }],
    }))
    const adapter = calls.adapters[0].adapter

    const resolved = await adapter.resolveModel('nvidia-router', 'glm-5.3')
    assert.deepEqual(resolved.reasoning.efforts.map(effort => effort.id), ['off', 'low', 'medium', 'high'])
    assert.equal(resolved.reasoning.efforts[3].name, 'High')
    assert.equal(resolved.reasoning.defaultEffort, 'high')

    const undeclared = await adapter.resolveModel('nvidia-router', 'someone/new-model')
    assert.equal(undeclared.reasoning, undefined, 'unlisted models declare no reasoning levels')
  } finally {
    await mock.close()
  }
})

test('wiring: baseURL falls back to NVIDIA_BASE_URL from the launch environment', () => {
  const environment = { get: ref => (ref === 'NVIDIA_BASE_URL' ? { value: 'https://proxy.example.test/v1' } : undefined) }
  const resolved = resolveAdapterOptions({ apiKeys: [{ env: 'NVIDIA_API_KEY_1' }], models: [{ id: 'm' }] }, environment)
  assert.equal(resolved.baseURL, 'https://proxy.example.test/v1')
})

test('wiring: apply() registers the provider route, directory entry, discovery, and status tool', async () => {
  const mock = await startMockNvidia()
  process.env.NVIDIA_API_KEY_1 = 'nvapi-WIRING-KEY'
  try {
    const { ctx, calls } = fakeContext()
    const config = parsedConfig({ baseURL: mock.baseURL })
    apply(ctx, config)

    assert.equal(calls.adapters.length, 1)
    assert.deepEqual(calls.adapters[0].providers, ['nvidia-router'])
    const adapter = calls.adapters[0].adapter
    assert.equal(typeof adapter.stream, 'function')
    assert.equal(typeof adapter.listModels, 'function')
    assert.equal(typeof adapter.resolveModel, 'function')
    assert.equal(typeof adapter.providerInfo, 'function')
    assert.equal(typeof adapter.providerRetryPolicy, 'function')

    const info = adapter.providerInfo('nvidia-router')
    assert.deepEqual(info, { id: 'nvidia-router', name: 'NVIDIA (Quota Router)' })

    assert.equal(adapter.providerRetryPolicy('nvidia-router').mode, 'normal')

    assert.deepEqual(calls.providers, [{
      provider: 'nvidia-router',
      displayName: 'NVIDIA (Quota Router)',
      settingsNs: 'llm-nvidia-router',
      settingsPath: [],
    }])

    assert.equal(calls.discovery.length, 1)
    assert.equal(calls.discovery[0].ns, 'llm-nvidia-router')
    const discovered = await calls.discovery[0].discover({}, undefined)
    assert.deepEqual(discovered, [{ id: 'mock/model-a' }, { id: 'mock/model-b' }])

    assert.equal(calls.tools.length, 1)
    const tool = calls.tools[0]
    assert.equal(tool.name, 'nvidia_quota_status')
    assert.equal(typeof tool.execute, 'function')
  } finally {
    delete process.env.NVIDIA_API_KEY_1
    await mock.close()
  }
})

test('wiring: discovery propagates endpoint failures instead of hiding them', async () => {
  const mock = await startMockNvidia()
  try {
    const { ctx, calls } = fakeContext()
    apply(ctx, parsedConfig({ baseURL: mock.baseURL }))
    await assert.rejects(
      () => calls.discovery[0].discover({ apiKey: 'bad-key' }, undefined),
      error => error instanceof LlmError && error.code === 'AUTH',
    )
  } finally {
    await mock.close()
  }
})

test('wiring: without a tools service the provider still loads and warns', () => {
  const { ctx, calls, lines } = fakeContext()
  ctx.get = () => undefined
  apply(ctx, parsedConfig({}))
  assert.equal(calls.adapters.length, 1, 'the provider route registers regardless')
  assert.equal(calls.tools.length, 0)
  assert.ok(lines.some(line => line.includes('tools service')), 'the omission is logged, not silent')
})

test('wiring: enableStatusTool=false registers no tool', () => {
  const { ctx, calls } = fakeContext()
  apply(ctx, parsedConfig({ enableStatusTool: false }))
  assert.equal(calls.adapters.length, 1)
  assert.equal(calls.tools.length, 0)
})

test('wiring: model metadata carries GUI-relevant capabilities', async () => {
  const mock = await startMockNvidia()
  try {
    const { ctx, calls } = fakeContext()
    apply(ctx, parsedConfig({ baseURL: mock.baseURL }))
    const adapter = calls.adapters[0].adapter

    const listed = await adapter.listModels('nvidia-router')
    assert.ok(listed.length >= 2)
    assert.equal(listed[0].id, 'deepseek-ai/deepseek-v3.1')
    assert.deepEqual(listed[0].inputModalities, ['text'])

    const resolved = await adapter.resolveModel('nvidia-router', 'deepseek-ai/deepseek-v3.1')
    assert.equal(resolved.context.contextWindow, 131072)
    assert.equal(resolved.defaultMaxTokens, 8192)
    assert.deepEqual(resolved.inputModalities, ['text'])

    const unknown = await adapter.resolveModel('nvidia-router', 'someone/new-model')
    assert.equal(unknown.id, 'someone/new-model')
    assert.equal(unknown.context, undefined, 'unlisted models resolve without invented metadata')
  } finally {
    await mock.close()
  }
})

test('wiring: a zero-key configuration fails loud at activation', () => {
  const { ctx } = fakeContext()
  assert.throws(
    () => apply(ctx, parsedConfig({ apiKeys: [] })),
    /at least one credential reference/,
  )
})


test('wiring: the health verdict reduces key facts to red, yellow, or green', () => {
  const usable = (extra = {}) => ({ configured: true, cooling: false, credentialError: false, sent: 1, ...extra })
  assert.equal(computeHealth([]), 'red')
  assert.equal(computeHealth([{ configured: false, cooling: false, credentialError: false, sent: 0 }]), 'red')
  assert.equal(computeHealth([{ configured: true, cooling: false, credentialError: false, sent: 0 }]), 'yellow', 'stored but never exercised is unknown')
  assert.equal(computeHealth([usable()]), 'green')
  assert.equal(computeHealth([usable(), usable({ cooling: true })]), 'yellow', 'one cooling key is partial')
  assert.equal(computeHealth([usable(), usable({ credentialError: true })]), 'yellow')
  assert.equal(computeHealth([usable({ cooling: true }), usable({ credentialError: true })]), 'red', 'nothing usable is red')
})

test('wiring: the probe route latency-tests every model without leaking the key', async () => {
  const mock = await startMockNvidia()
  const refs = ['NVIDIA_API_KEY_1', 'NVIDIA_API_KEY_2', 'NVIDIA_API_KEY_3', 'NVIDIA_API_KEY_4']
  const saved = refs.map((ref) => process.env[ref])
  refs.forEach((ref) => { delete process.env[ref] })
  process.env.NVIDIA_API_KEY_1 = 'nvapi-PROBE-KEY'
  try {
    const { ctx, calls } = fakeContext()
    apply(ctx, parsedConfig({ baseURL: mock.baseURL, models: [{ id: 'mock/model-a' }, { id: 'mock/model-b' }] }))
    const route = calls.routes.find((entry) => entry.path === '/api/nvidia-router.probe')
    assert.ok(route, 'the probe route is registered')
    assert.deepEqual([...route.methods], ['POST'])
    const response = await route.fetch(new Request('http://host/api/nvidia-router.probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models: ['mock/model-a', 'mock/model-b'] }),
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.results.map((result) => result.id), ['mock/model-a', 'mock/model-b'])
    assert.deepEqual(body.results.map((result) => result.ok), [true, true])
    for (const result of body.results) assert.equal(typeof result.latencyMs, 'number')
    assert.ok(!JSON.stringify(body).includes('nvapi-PROBE-KEY'), 'the credential value never rides out')
    const probes = mock.requests.filter((entry) => entry.url === '/v1/chat/completions')
    assert.equal(probes.length, 2, 'one probe per model')
    assert.deepEqual(probes.map((entry) => entry.body.model), ['mock/model-a', 'mock/model-b'])
  } finally {
    refs.forEach((ref, at) => { if (saved[at] === undefined) delete process.env[ref]; else process.env[ref] = saved[at] })
    await mock.close()
  }
})

test('wiring: the probe route reports a failing model without hiding it', async () => {
  const mock = await startMockNvidia()
  const refs = ['NVIDIA_API_KEY_1', 'NVIDIA_API_KEY_2', 'NVIDIA_API_KEY_3', 'NVIDIA_API_KEY_4']
  const saved = refs.map((ref) => process.env[ref])
  refs.forEach((ref) => { delete process.env[ref] })
  process.env.NVIDIA_API_KEY_1 = 'nvapi-PROBE-KEY'
  mock.setBehavior('nvapi-PROBE-KEY', { behavior: 'not-found' })
  try {
    const { ctx, calls } = fakeContext()
    apply(ctx, parsedConfig({ baseURL: mock.baseURL, models: [{ id: 'mock/model-a' }] }))
    const route = calls.routes.find((entry) => entry.path === '/api/nvidia-router.probe')
    const response = await route.fetch(new Request('http://host/api/nvidia-router.probe', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }))
    const body = await response.json()
    assert.equal(body.results.length, 1, 'the catalog is tested when no list is posted')
    assert.equal(body.results[0].ok, false)
    assert.equal(body.results[0].status, 404)
    assert.equal(typeof body.results[0].error, 'string')
    assert.equal(typeof body.results[0].latencyMs, 'number')
  } finally {
    refs.forEach((ref, at) => { if (saved[at] === undefined) delete process.env[ref]; else process.env[ref] = saved[at] })
    await mock.close()
  }
})

test('wiring: the probe route refuses cleanly when no credential resolves', async () => {
  const refs = ['NVIDIA_API_KEY_1', 'NVIDIA_API_KEY_2', 'NVIDIA_API_KEY_3', 'NVIDIA_API_KEY_4']
  const saved = refs.map((ref) => process.env[ref])
  refs.forEach((ref) => { delete process.env[ref] })
  try {
    const { ctx, calls } = fakeContext()
    apply(ctx, parsedConfig({ models: [{ id: 'mock/model-a' }] }))
    const route = calls.routes.find((entry) => entry.path === '/api/nvidia-router.probe')
    const response = await route.fetch(new Request('http://host/api/nvidia-router.probe', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.error, 'MISSING_CREDENTIAL')
    assert.deepEqual(body.results, [])
  } finally {
    refs.forEach((ref, at) => { if (saved[at] === undefined) delete process.env[ref]; else process.env[ref] = saved[at] })
  }
})

test('wiring: the health route counts only stored keys and reports the verdict', async () => {
  const refs = ['NVIDIA_API_KEY_1', 'NVIDIA_API_KEY_2', 'NVIDIA_API_KEY_3', 'NVIDIA_API_KEY_4']
  const saved = refs.map((ref) => process.env[ref])
  refs.forEach((ref) => { delete process.env[ref] })
  try {
    const cold = fakeContext()
    apply(cold.ctx, parsedConfig({ models: [{ id: 'mock/model-a' }] }))
    const coldRoute = cold.calls.routes.find((entry) => entry.path === '/api/nvidia-router.status')
    assert.ok(coldRoute, 'the health route is registered')
    assert.deepEqual([...coldRoute.methods], ['GET'])
    const coldBody = await (await coldRoute.fetch(new Request('http://host/api/nvidia-router.status'))).json()
    assert.equal(coldBody.keyCount, 0, 'the four default rows count only once stored')
    assert.equal(coldBody.totalKeys, 4)
    assert.equal(coldBody.health, 'red')

    process.env.NVIDIA_API_KEY_1 = 'nvapi-HEALTH-KEY'
    const warm = fakeContext()
    apply(warm.ctx, parsedConfig({ models: [{ id: 'mock/model-a' }] }))
    const warmRoute = warm.calls.routes.find((entry) => entry.path === '/api/nvidia-router.status')
    const warmBody = await (await warmRoute.fetch(new Request('http://host/api/nvidia-router.status'))).json()
    assert.equal(warmBody.keyCount, 1)
    assert.equal(warmBody.health, 'yellow', 'stored but not yet exercised is unknown')
    assert.equal(warmBody.keys[0].label, 'Key-1')
    assert.ok(!JSON.stringify(warmBody).includes('nvapi-HEALTH-KEY'), 'the credential value never rides out')
  } finally {
    refs.forEach((ref, at) => { if (saved[at] === undefined) delete process.env[ref]; else process.env[ref] = saved[at] })
  }
})

test('wiring: the probe route reports throttling as a status so the GUI can keep the model', async () => {
  const mock = await startMockNvidia()
  const refs = ['NVIDIA_API_KEY_1', 'NVIDIA_API_KEY_2', 'NVIDIA_API_KEY_3', 'NVIDIA_API_KEY_4']
  const saved = refs.map((ref) => process.env[ref])
  refs.forEach((ref) => { delete process.env[ref] })
  process.env.NVIDIA_API_KEY_1 = 'nvapi-PROBE-KEY'
  mock.setBehavior('nvapi-PROBE-KEY', { behavior: 'rate-limit', retryAfterMs: 1_000 })
  try {
    const { ctx, calls } = fakeContext()
    apply(ctx, parsedConfig({ baseURL: mock.baseURL, models: [{ id: 'mock/model-a' }] }))
    const route = calls.routes.find((entry) => entry.path === '/api/nvidia-router.probe')
    const response = await route.fetch(new Request('http://host/api/nvidia-router.probe', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }))
    const body = await response.json()
    assert.equal(body.results[0].ok, false)
    assert.equal(body.results[0].status, 429, 'a 429 is a real answer, not proof the model is unusable')
    assert.equal(typeof body.results[0].latencyMs, 'number')
    assert.ok(!JSON.stringify(body).includes('nvapi-PROBE-KEY'), 'the credential value never rides out')
  } finally {
    refs.forEach((ref, at) => { if (saved[at] === undefined) delete process.env[ref]; else process.env[ref] = saved[at] })
    await mock.close()
  }
})

test('wiring: an empty catalog activates and discovers, rather than locking discovery out', async () => {
  // Discovery exists precisely to fill a catalog nobody typed, so an empty list
  // must be a legal starting point. A live profile with `models: []` once made
  // discovery answer `models must list at least one catalog entry`, which locked
  // the GUI out of the very action that would have populated it.
  const mock = await startMockNvidia()
  process.env.NVIDIA_API_KEY_1 = 'nvapi-EMPTY-CATALOG-KEY'
  try {
    const { ctx, calls } = fakeContext()
    apply(ctx, parsedConfig({ baseURL: mock.baseURL, models: [] }))

    assert.equal(calls.adapters.length, 1, 'the provider activates with no catalog entries')
    const discovered = await calls.discovery[0].discover({}, undefined)
    assert.deepEqual(discovered, [{ id: 'mock/model-a' }, { id: 'mock/model-b' }])
    const listed = await calls.adapters[0].adapter.listModels('nvidia-router')
    assert.deepEqual(listed, [], 'an empty configured catalog is the documented "built-in catalog" state')
  } finally {
    delete process.env.NVIDIA_API_KEY_1
    await mock.close()
  }
})
