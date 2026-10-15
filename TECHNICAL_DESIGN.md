# TECHNICAL_DESIGN — NVIDIA Smart Quota Router

DSH（DeepSeek Harness）的 NVIDIA API 智能调度插件。本文记录真实架构、调度流程、状态管理与技术决策。
创建：2026-10-13。以本文件 + 源代码 + 可复现测试为准；与代码不一致时以代码和测试为准并修正本文。

## 1. 真实架构检查结论（全部已对源码验证）

| 事实 | 证据 |
|---|---|
| DSH 是全插件 Cordis harness，从源码检出运行 | 进程 `node --import tsx/esm apps/cli/src/bin.ts web --host 192.168.25.199 --port 3080`，profile `web` 位于 `/home/liang/.dsh/profiles/web` |
| 所有模型请求统一走 `ctx.llm` | `docs/architecture.md`「Add a model provider → register its adapter on ctx.llm」；`packages/llm/llm/README.md`："an agent loop, a session-title generator, a compaction summarizer — streams its requests through this service" |
| 主/子智能体同进程共享 `ctx.llm` | 默认子智能体为 in-process 实现（`packages/subagent/subagent-spawn-in-process`、`fork-in-process`；Agent Teams 队友同理），同一 Host 进程内所有 Cordis fiber 共享同一服务实例 |
| 一次 `stream()` = 一次 provider 尝试 | `dsh-llm` README："This service never re-runs a request: retrying is the job of dsh-llm-retry at the agent's failed-step extension point" |
| 步级重试由 provider 自有 retryPolicy 驱动 | `packages/llm/llm/src/retry-policy.ts`；默认 normal 模式 5 次，可重试码 EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT；`providerRetryAfterMs` 有效时取代本地退避 |
| 流协议义务 | `StreamChunk`：block-start/text-delta/reasoning-delta/tool-call-delta/block-end/usage/finish；usage 必须先于 finish，finish 后不再发块；tool 参数端到端保持原始 JSON 字符串；块 index 按首次出现顺序分配 |
| 错误两条正道 | 从 `stream()` 抛 `LlmError`（传输/协议错误），或以 `finish {kind:'error'|'aborted'}` 结束流（provider 带内失败）；跨包错误经 `normalizeLlmFailure` 信任自持 `code`+`failure` 数据属性的快照 |
| 插件安装机制 | 工作区 bundle 包（`package.json` 声明 `dsh.bundle` + `cordis.patch.yml`）→ `plugin_manager install_bundle`（绝对路径目标）→ pnpm 装入 profile `node_modules` |
| 插件 import 解析 | app-boot `profile-resolution/resolver.ts` 的运行时拦截层把裸 `@deepseek-ai/*` 请求映射到运行中安装作用域；`collectInstallationScopePackages` BFS 显式含 peers（"out-of-tree plugins import them directly"） |
| GUI 模型选择 | `registerConfigurableProviders()`（settingsNs=条目 id）+ `listModels()` 目录成员资格 + `registerModelDiscovery()` 端点发现 |
| 密钥读取 | `ctx.get('credentials')?.resolve(envRef)`（优先）或 `launchEnvironmentOf(ctx).get(envRef)`；`assertUsableApiKey` 校验；凭据值不落配置文件 |
| 兼容性检查 | `plugin-compatibility.ts` 只检查 `@deepseek-ai/dsh*` 的 peerDependencies；本插件零依赖、零 dsh peer 声明 → 无版本冲突面 |

## 2. 接入方案与理由（最小改动）

**方案：独立 LLM provider 适配器插件（bundle），实现 sticky_quota 调度器内嵌于 adapter。**

- 新 provider 路由 id `nvidia-router`（可配置），通过 `ctx.llm.registerAdapter(['nvidia-router'], adapter)` 注册。
  **为什么不是 `nvidia`（2026-10-14 安装时实测）**：基础 profile 的 `llm-pi-ai` 把 pi-ai 内置目录
  （含 `nvidia`）全量声明为可配置 provider 目录，且该部署当前正在用 pi-ai 的 `nvidia`
  profile（单 Key + `z-ai/glm-5.3`）。默认 `nvidia` 触发 `DUPLICATE_DIRECTORY` 激活失败；
  改用 `nvidia-router` 后激活成功。若未来移除 pi-ai 的 nvidia profile，`provider` 字段可改回。
- 主智能体、进程内子智能体、会话标题、压缩摘要的每一次模型调用都到达这一个 adapter 实例 →
  调度器（同一实例内）天然看到并计数全部请求，满足「主/子智能体共用调度器」。
- 不改动 DSH 源码、不代理转发、不接管现有 deepseek 路由；用户在 GUI/配置中自行选择是否把会话模型切到 `nvidia`。现有模型配置零破坏。
- Key 故障转移（换 Key 重试）发生在 adapter 内部、且仅在**首个流块输出之前**；流开始后只终止并上报，
  由 `dsh-llm-retry` 在步边界按 retryPolicy 决定是否重跑整个步骤（步级重跑会安全丢弃失败的部分输出，不会拼接重复文本）。

为什么不用其他方案：
- 本地 OpenAI 兼容代理（HTTP server）：引入常驻端口、认证与转发开销，且 DSH 的 `ctx.llm` adapter seam 已是一等扩展点，代理是不必要的第二跳。
- 改 dsh-llm/agent-loop 源码：违反「Plugins, not loop changes」且升级面大。
- pi-ai 库多 provider 路由：llm-pi-ai 虽有 nvidia 目录，但无法实现本项目的粘性配额调度与原子预留需求。

## 3. 调度核心（sticky_quota）

### 3.1 状态（全部进程内存；见 §3.6 重启语义）

每个 Key（以 envRef 为稳定标识）：

```
window: number[]        // 滚动窗口内已发送(含已预留)请求的时间戳，升序
cooldownUntil: number   // 冷却截止（0=可用）；来源：429/5xx退避/认证异常/配额
cooldownReason: string
credentialError: boolean// 401/403/缺凭据：该 Key 配置异常，冷却更长
consecutiveRateLimits: number // 连续 429 计数，驱动指数退避
lastFailure: {code, at} // 最近错误类型（诊断用）
stats: { sent, ok, rateLimited, authErrors, quotaErrors, serverErrors, timeouts, transportErrors, emptyResponses }
```

调度器全局：`activeKeyIndex`（粘性锚点）、`switches`、`allUnavailableEvents`、`totalSent` 等。

### 3.2 预留流程（原子性）

```
acquire(model, signal):
  loop:
    lease = tryAcquire(model)          # 同步段：整段无 await → 单线程下原子
    if lease: return lease
    wait = earliestRecoveryMs()        # 所有 Key 中最早「冷却到期 或 窗口最旧记录滑出」的时刻
    if wait > allUnavailableWaitMs: throw RATE_LIMIT(providerRetryAfterMs=min(wait,上限), 诊断信息)
    await sleep(min(wait, 剩余预算), signal)   # 有界等待，可被取消
```

`tryAcquire(model)` 同步段：
1. 按当前时间修剪各 Key 窗口中已滑出 `windowMs` 的记录。
2. 候选 = 当前粘性 Key（若可用：无冷却、无凭据异常、`window.length < safeThreshold`）；
   否则从粘性锚点之后按配置顺序找第一个可用 Key；切换时 `switches++` 并 info 日志（脱敏标签）。
3. 可用 → 立即 `window.push(now)` 完成预留（预留即计数：发送前的取消才可释放）。
4. 无可用 Key → 返回 null（进入有界等待）。

并发安全：JS 单线程 + 同步段无 await → 多个并发请求（主/子智能体同时申请）串行进入同步段，不可能同时「看到剩余额度」而超发。测试以并发 acquire 验证。

### 3.3 计数语义（对齐规则文件第三节）

- 每一个真实发往 NVIDIA 的 HTTP 请求都计数：主/子智能体请求、工具调用后的后续请求、失败重试、故障转移尝试。
- 预留发生在 fetch 之前；**请求一旦发起，计数不因失败/超时而释放**（可能已被服务端处理）。
- 唯一释放路径：fetch 尚未执行时请求即被取消（signal 已中止）→ 释放该预留。
- 窗口条目附带 `model` 字段（为将来按模型维度统计预留扩展点；当前按 Key 合并计数）。

### 3.4 冷却与恢复

| 信号 | 动作 |
|---|---|
| 429 | 优先采用有效 `Retry-After`；缺失时 `rateLimitCooldownMs * 2^(consecutiveRateLimits-1)`，封顶 `rateLimitCooldownMaxMs`；`consecutiveRateLimits++` |
| 401/403 | Key 标记 `credentialError`，冷却 `authErrorCooldownMs`（默认 15 分钟）；允许有限换 Key（错误是 Key 级的），但总尝试受 `maxFailoverAttempts` 限制 |
| 402 / 配额文案 | `QUOTA`（账户级余额/配额，可能是共享额度）：冷却 `quotaCooldownMs`（默认 30 分钟），不参与故障转移码集合 |
| 5xx / 超时 / 传输 | 计数保留；SERVER/TIMEOUT 可参与故障转移；TIMEOUT 传输层不额外冷却 Key（窗口计数已限制） |
| 成功 | `consecutiveRateLimits` 清零；statistically `ok++` |

恢复：冷却到期由 `tryAcquire` 逐步重新评估（不盲目立即恢复：窗口内历史仍在计数；连续 429 的指数退避防止抖动）。粘性锚点不因原 Key 恢复而自动回切，避免来回抖动；仅当现粘性 Key 不可用时才前进。

### 3.5 故障转移（单次 stream() 内）

- 仅在**尚未产出任何流块**时允许换 Key（此时无部分输出，重复发送无拼接风险）。
- 参与码：RATE_LIMIT、AUTH、SERVER、TIMEOUT、TRANSPORT、EMPTY_RESPONSE。不参与：INVALID_REQUEST、CONTEXT_WINDOW_EXCEEDED、QUOTA、HTTP_404 等（换 Key 也必然同样失败，或属共享配额）。
- 每请求最多 `maxFailoverAttempts`（默认 2）次换 Key；总 HTTP 尝试 ≤ 1+maxFailoverAttempts。
- 超出后抛出 LlmError（真实码 + status + providerRetryAfterMs），由 dsh-llm-retry 按策略在步边界重试（外层有限保险）。
- 流已开始后的一切失败：以 `finish {kind:'error'|'aborted'}` 终止，不做 adapter 内重发。

### 3.6 重启语义（设计决策）

窗口/冷却状态为进程内存态，重启即清零。理由：
- 窗口仅 60 秒，持久化收益低而复杂度高（需落盘 + 时钟对齐 + 崩溃一致性）。
- 重启后首分钟本地计数偏小 → 本地提前切换保护变弱，但服务端 429 反馈仍在：首次 429 即重新冷却，自愈（代价至多一次被拒请求）。
- 配置（阈值、窗口、Key 表）持久于 cordis.yml/credentials，重启后原样生效。

## 4. 线协议（OpenAI 兼容，NVIDIA integrate API）

- 端点：`{baseURL}/chat/completions`（默认 `https://integrate.api.nvidia.com/v1`，`NVIDIA_BASE_URL` 环境变量次之）；模型发现 `GET {baseURL}/models`。**配置页「测试所有模型」探测**复用同一 `chat/completions`（`max_tokens:1`，由 Host `bundle/routes.js` 逐模型发起，见 §9）。
- 请求头：`authorization: Bearer <key>`、`content-type/accept`、`user-agent`（`attributionHeaders()`，契约必带）。Key 永不出现在日志/状态/错误文本。
- 请求体：`model`、`messages`、`stream:true`、`stream_options:{include_usage:true}`（可关）、`tools`/`tool_choice:'auto'`（有 tools 时）、`temperature`、`max_tokens`、`stop`。
- 消息映射：system/developer→`system`；user→`user`（文本块连接）；assistant→`assistant`（tool-call 块→`tool_calls`，reasoning 块不回传，符合 provider 惯例）；tool 结果→`tool`（`tool_call_id`）。文件/图像由运行时在送达前投影为占位文本（v1 声明纯文本模态）。
- 流翻译：`data: {...}` 行 → delta.content（text-delta）/ delta.reasoning_content|reasoning（reasoning-delta）/ delta.tool_calls[i]（首见序分配块 index，id/name/arguments 增量，arguments 保持原始 JSON 字符串拼接）；`data: [DONE]` 或流结束 → 缓冲式冲刷 usage（最终块携带时）→ finish；finish_reason 映射 stop/tool_calls/length→stop/tool-calls/max-tokens，content_filter→`finish{error, CONTENT_FILTERED}`；零内容块完成 → `EMPTY_RESPONSE`；带内 `{error:...}` → `finish{error}`。
- 超时：流空闲 `streamIdleTimeoutMs`（idleWatchdog）→ TIMEOUT（计数保留，按可能已消耗处理）。

## 5. 配置（全部 cordis.yml 可调，无硬编码调参）

见 CONFIG.example.yaml。要点：`apiKeys[]`（env 引用+标签，数量任意，默认 4）、`models[]`
（**可为空数组**：目录由客户端从端点动态获取，`DEFAULT_MODELS` 仅作开箱种子）、`windowMs=60000`、
`safeThreshold=38`（本地预算，非服务端镜像）、冷却各值、`maxFailoverAttempts=2`、
`allUnavailableWaitMs=15000`、`retryPolicy`（复用 dsh-llm 的 `RetryPolicySchema`）、`enableStatusTool`。
参数在每次请求时经 `resolveAdapterOptions` 显式解析校验（加载期 fail loud，运行期动态配置同样走校验）。

「参考 RPM 40」不是配置字段：它是用户对阈值的推导参考（38 ≈ 40×95%），写入文档注释而非行为参数，避免无作用字段。

## 6. 诊断与状态

- `nvidia_quota_status` 只读工具（model-facing，默认启用可关）：输出脱敏状态（Key 标签、env 引用名、窗口计数、剩余估算、冷却及恢复时间、成功/429/超时/切换/全不可用计数），全部标注「本地估算」。
- 日志：Key 切换/冷却/恢复 info；错误 warn；无 Key 值输出。
- 统计口径在输出中显式区分「本地估算」与「服务端返回」（Retry-After 等）。

## 7. 已知边界（如实记录）

1. 进程外子智能体（ACP/Codex/Claude Code/dsh-sdk child）不经本调度器（独立产品进程，自带模型配置）。
2. v1 声明纯文本输入模态；图像由运行时投影为占位文本（NVIDIA VLM 支持留待后续）。
3. NVIDIA 端点细节（Retry-After 格式、stream_options、模型 id）按 OpenAI 兼容规范实现，真机首验前标记未测试。
4. `temperature`/`max_tokens`/`stop` 之外的采样参数（top_p、response_format 等）不在 DSH 请求词汇表中，不做透传也不伪造。
5. 多 choice 响应只取 `choices[0]`（DSH 请求不使用 n>1）。
6. 推理档位（2026-10-15 起，替代原「不支持 reasoning effort」边界）：模型是否支持推理、
   支持哪些档位是**部署知识**，由目录条目的 `efforts`（从低到高）与 `defaultEffort` 声明
   （端点 /models 列表不含该元数据；glm-5.3 / glm-5.3-flash 已在用户目录预配）。
   `resolveModel` 把声明投影为 `LlmResolvedModelInfo.reasoning`，选择器因此出现推理等级；
   档位的校验与缺省物化由运行时统一负责（`resolveCallWithInfo`：越界档位与未声明模型的
   显式档位都以 `UNSUPPORTED_REASONING_EFFORT` 拒绝）。线协议是否携带档位由
   `reasoningEffortParam` 决定：默认 `none`——与 pi-ai 目录对该端点的策展一致
   （NVIDIA 条目 `supportsReasoningEffort: false`，pi-ai 对 NVIDIA 实际不发任何 effort
   参数，档位只是会话侧元数据，glm 在该端点上默认自行思考）；`reasoning_effort` 则把
   OpenAI 风格字段写进请求体（端点若拒绝会显式 400，可随时改回）。

## 8. 安装与激活实录（2026-10-14，阶段 3 实测）

1. `plugin_manager install_bundle`（target=bundle 绝对路径）：pnpm 成功链接
   `@local/dsh-llm-nvidia-router@0.1.0`（`+` 依赖，pnpm v12.11.2），首启 `application: failed`——
   默认路由 id `nvidia` 与 pi-ai 目录冲突（`DUPLICATE_DIRECTORY`，见 §2）。
2. 修复：bundle 默认改为 `nvidia-router` + 在 profile `cordis.patch.yml` 追加 `llm-nvidia-router`
   行覆盖（改前备份 `cordis.patch.yml.bak-nvidia-router-20261014`）；config-only HMR 重组后激活成功。
   运行中进程持有首次失败时缓存的旧模块代（其 provider 默认仍为 nvidia），行覆盖使 apply()
   以 `provider: nvidia-router` 重跑；下一次 DSH 重启将直接加载修复后的新默认值。
3. 验证：Host 工具目录出现 `nvidia_quota_status`（apply() 末位注册，证明
   registerConfigurableProviders/registerModelDiscovery/registerAdapter 全部成功）；
   `Config.listConfigs` 返回 `include:llm-nvidia-router`（status=schema，全部 17 字段可见）。
4. 影响面：用户的 pi-ai `nvidia` 路由与其 `agent-default-model` 配置**零改动**；两路由并存。

## 9. 客户端表面与连接路由（2026-10-14 第三轮）

用户三项新需求（动态模型目录 / 配置页「测试所有模型 + 延迟」/ 对话头部健康徽标）的实现与接线。

### 9.1 客户端 ⇄ Host 通信（为什么不用 `/api` RPC）

`/api` 通道的 RPC interceptor 只允许**一个所有者**，在 web 组合里已被 API Gateway 占用，
插件无法再注册。因此本插件改用 **精确 Fetch 路由**（DSH 文档化的 `connection.fetch` 机制）：

- **Host**（`bundle/routes.js`）：注册必须发生在**作用域等待**里——
  `ctx.inject(['connection'], (connectionCtx) => { connectionCtx.effect(() =>
  connectionCtx.connection.fetch.register({ path, methods, requestBody:'buffered',
  fetch: (req) => Promise<Response> }), 'label') })` → 返回 disposer。
  **为什么必须等待**：浏览器的连接通道是**独立 boot 行**，`apply()` 执行时它通常**还没 ACTIVE**；
  在 `apply()` 里**急切** `ctx.get('connection')` 会得到 `undefined`，两条路由**静默不存在**
  （真机表现：认证后打到未注册的 `/api/*` 精确路径 → **404** → 客户端红字「测试未能执行 (HTTP 404)」）。
  `ctx.inject(names, cb)` 是 DSH 官方惯用法（出处 `packages/bundle/web-app/src/index.ts:268`、
  `file-upload`、`session-log-export`）；无浏览器通道的部署**永不进入该作用域**，provider 本体照常挂载。
  **不要**把 `connection` 加进模块级 `inject`（那会把整个 provider 挂靠在浏览器通道上）。
  （`fakeContext` 里 `connection`、`effect`、`inject` 都是本插件为测试新增的依赖面。）
  - `POST /api/nvidia-router.probe`：请求体 `{ models?: string[] }`（缺省用当前目录）；
    逐模型 `POST {baseURL}/chat/completions`（`max_tokens:1`、`messages:[{role:'user',content:'ping'}]`），
    并发限 **6**、**每模型独立 10s 预算**
    （`AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])`，在**单模型调用**内部构造）；
    返回 `{ results: [{id, ok, status?, error?, latencyMs}] }`。
    **超时必须逐模型计算**：整批共享一个 deadline 时，慢模型一旦吃满预算，排在后面的会被整批截断
    并被误判 `TIMEOUT`（实测一轮 80 个里误杀 **44 个**）。
    **响应永不包含密钥值**（只有 id/成败/状态码/延迟）；不在响应时泄漏 `authorization`。
  - `GET /api/nvidia-router.status`：先 `scheduler.syncKeys?.()`（补齐新增 Key）再取快照；
    返回 `{ keyCount, totalKeys, health, keys:[{label, credentialRef, configured, cooling, credentialError}] }`。
- **Client**（`bundle/client.js`）：用**文档相对路径** `fetch('api/nvidia-router.probe' | 'api/nvidia-router.status',
  { credentials:'same-origin' })`。

### 9.2 动态模型目录（需求 1）

模型目录不再手填：客户端经 `ctx.remote.llm.discoverModels('llm-nvidia-router', { baseURL })`
（DSH 已发布的 Models 页发现 Remote，Host 侧由 `ctx.llm.registerModelDiscovery` 提供实现）
从端点拉取列表 → 只读展示（**保留“移除”、去掉“手动添加”**），存 Key 成功后自动刷新。
`bundle/config.js` 随之放开 `resolveModels` 的空目录校验（否则「删空后保存」会被拒）。

**请求契约（实测得出，务必遵守）**：`LlmRuntime.discoverModels` 在把请求交给插件回调**之前**
就校验 `request.provider` 或 `request.baseURL` **至少一个非空**，否则抛
`LlmError('model discovery needs a provider route or a baseURL', 'INVALID_DISCOVERY')`
（源码 `packages/llm/llm/src/index.ts:601`）——**插件 Host 回调内的兜底来不及生效**。
故客户端必须**永远携带非空 baseURL**，取三级兜底：
**表单 draft → 已保存配置 → `DEFAULT_BASE_URL = https://integrate.api.nvidia.com/v1`**。
（刻意**不给 Config 的 `baseURL` 设 schema 默认值**：设了会让 `NVIDIA_BASE_URL` 环境变量回退失效。）

### 9.3 「只保留免费可用」的实测裁剪（需求 1 的补充）

**NVIDIA 的 `GET /v1/models` 给不出“免费可用”**：匿名实测（2026-10-14）返回 **200、恰好 80 条**，
每条只有 `{id, object, created, owned_by}`——**无免费/计费/可用性/模态字段**，且混有
embedding/rerank/内容安全/视觉检测/文档解析等**不能对话**的模型。免费档的实质是
**“这把 Key 能不能调通”**，所以：

- `discover()` = **拉全量 → 自动逐个实测（复用 probe 路由）→ 按裁决裁剪**；不引入任何硬编码清单。
- **裁剪规则（防误杀）**：`UNUSABLE_STATUSES = [400,401,402,403,404,410]` 才判定不可用并移除
  （**410 Gone = NVIDIA 已下线(retired) 的模型**，必须算不可用，否则目录残留永远调不通的条目）；
  **429 与 5xx/超时判为“未确定”并保留**（429 恰证明模型存在且免费档可用，只是被限流；
  80 连发本身就可能触发）。UI 明确标注“可用 = 你的 Key 当前能调通”。
- 面板显示 `可用 N/M · 已移除 D · 保留 K (未确定 U)`，并给 **「恢复全部模型」**（还原原始目录）
  与 **「仅保留可用」**（按最近实测重剪）。实测只走 Host 路由，**响应不含密钥**。
- 探测量随目录放大：`PROBE_CONCURRENCY` 由 3 提到 **6**，单模型预算改为**独立 10s**
  （原整批共享 20s 会把排在后面的模型整批截断，实测一轮 80 个里误杀 44 个为 TIMEOUT）。

### 9.4 健康判定（需求 3）

`computeHealth(keys)` 为导出**纯函数**（便于测试）：

- 未配置任何 Key，或已配置者**全部**不可用（`cooling || credentialError`）→ **red**；
- 部分不可用，或已配置但**从未产生成功请求**（`sent === 0`，未验证）→ **yellow**；
- 已配置者全部可用**且**至少有过成功请求 → **green**。

客户端 `ApiHealthBadge` 注册进 `conversation.session.header.utilities`
（槽位契约 `{ kind:'list', scope:'session' }`；注册选项 `{name, id:'nvidia-router-health',
order:30, label, locale}`，与 `ui-open-in-app`/`ui-schedule` 的真实用法同形），
15s 轮询状态路由，显示 `keyCount` + 红/黄/绿圆点，悬停展示每 Key 标签/引用名与状态。

### 9.5 验证

`node --check` 全通过；`tests/wiring.test.js` 由 9 → **16** 项（新增：健康判定纯函数四态、
探测逐模型计延迟且不泄密钥、失败模型保留 404、无凭证干净拒绝 `MISSING_CREDENTIAL`、
健康路由只计已存储 Key：cold `keyCount 0 / totalKeys 4 / red`、warm `keyCount 1 / yellow`、
429 以 status 原样上抛、**空目录仍能激活并发现（不自锁）**；`fakeContext` 已按真实 Cordis
补 `inject(names, cb)` 作用域语义——服务缺失则回调不执行）；
`sh tests/run.sh` → **69 项 / 全部通过**（2026-10-14 23:52 复核 `pass 69 / fail 0 / rc=0`；此前偶发的
`windowCount 1 !== 0` 已定位为 `QuotaLease` 预留泄漏并修复，见 TEST_REPORT.md
「间歇性失败：定位与修复」）。

**运行中进程的活体验证（2026-10-14 23:46 起）**：`/api/*` 精确路由**认证后可区分**——
已注册 → **200**、未注册 → **404**（未认证一律 401）。带同源会话 cookie 实测：
`GET /api/nvidia-router.status` → 200；`POST /api/nvidia-router.probe` → 200
（`definitely/not-a-model` → `HTTP_404`，527ms）。**全量 80 模型一轮** ≈182s →
`ok=10 / 404=55 / TIMEOUT=10 / 500=2 / 503=2 / 400=1` → **可用 10 / 已移除 56 / 保留 24（未确定 14）**。
浏览器内的实际呈现（按钮/徽标/裁剪效果）仍待用户确认。
