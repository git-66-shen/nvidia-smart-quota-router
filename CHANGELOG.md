# CHANGELOG — NVIDIA Smart Quota Router

格式：日期 · 变更 · 原因。只记录有实际意义的阶段与决策。

## 2026-10-15 11:41 · 用户 GUI 报 `prepareCall is not a function` → 模块根 HMR 免重启修复

- **症状**：用户在模型列表切到插件模型发消息 → `本轮运行失败 registration.adapter.prepareCall
  is not a function`。与凌晨预测一致：运行中 web 进程（pid 1681424，10-14 23:46 启动）仍持
  修复前的旧适配器模块代——`prepareCall` 修复在磁盘上，但按旧规则「Host 半改动需重启」。
- **免重启修复（新机制，已实证）**：profile patch 追加 `hmr` 行覆盖
  （`root: ['<bundle 目录>']`，备份 `.bak-hmr-root-20261015`）——启用 dsh-hmr 的**模块根 watch**。
  配置经 config-HMR 即时生效（inotify watch 表实证含 bundle 目录与 adapter.js 的 inode）；
  随后**原地重写** adapter.js（内容不变、`cp` 两跳以真正触发 IN_MODIFY——纯 `touch` 不可靠）
  → `partialReload()` 以新模块代重建插件 fiber。10:03 报错 → 11:32 触发 → **11:41 用户重试成功**。
- **代价与边界**：模块热重载会重置插件调度器计数（与重启语义一致）；纯配置改动仍走 config-HMR；
  manifest（package.json）/patch/组合级改动仍需重启。
- **修复后活体状态**：`/api/nvidia-router.status` → **health green，Key-1 sent 2 / ok 2**，
  4 Key 全部可用——用户 GUI 流量真实经调度器成功往返。
- 由此，Host 半改动从「必须重启」变为「改完原地重写即热生效」——彻底消除本项目的重启之痛
  （初代 HANDOFF 预留的「module root watch opt-in 开关」路径，现已启用并实证）。

## 2026-10-15 · 真机首验全通过（4 Key × headless e2e）+ 两个活缺陷修复

- **用户已配置 4 个 Key**（设置页保存，`/api/nvidia-router.status` 实证
  `keyCount 4 / configured 4 / health yellow / 零流量`）——设置页保存链路端到端可用。
- **缺陷一（真机首验第一跑即暴露）：适配器缺 `prepareCall`**。`LlmRuntime` 请求准备期调用
  `registration.adapter.prepareCall(...)`（`packages/llm/llm/src/index.ts:941`），而
  `NvidiaRouterAdapter` 是未继承 `LlmAdapter` 基类的鸭子类型类——web Host 里插件行 active、
  但**从没有请求走过路由器**，此路径从未被执行。修复：`extends LlmAdapter`（生态既定模式：
  `DeepSeekAdapter`/`PiAiAdapter` 同）+ 构造器先 `super()`；继承默认
  `prepareCall`（同代绑定）与 `imageRequestPricing` 兜底，`resolveModel` 覆盖保留。
- **缺陷二：`nvidia_quota_status` 一调即报 `value is not lossless JSON`**。`snapshot()` 给
  从未失败的 Key 输出 `lastFailure: undefined`、零 Key 时输出 `activeKey: undefined`，而工具管线
  （`walkJsonValue`）把 `undefined` 值判为非无损（`JSON.stringify` 会静默丢弃，旧测试测不出）。
  修复：缺席字段**省略属性**而非输出 `undefined`；新增回归测试用 harness 真实
  `isJsonValue` 断言三种状态（全新表/失败后/空表）。web 进程中的旧代码在重启后随新模块代生效。
- **headless 全栈 e2e 方法**（新）：`dsh --profile headless --patch tests/e2e/*.yml "<task>"`，
  凭据读全局 `~/.dsh/.credentials.yaml`；headless profile 增加本包 bundle 行 + node_modules 链接
  （镜像 web profile 的接法）；overlay 临时覆盖 `agent-default-model → nvidia-router`，不触碰
  用户 profile。固件：`tests/e2e/route-default.yml`（glm-5.3-flash）、
  `tests/e2e/sticky-threshold.yml`（另加 `safeThreshold: 2`）。
- **README 真机首验清单 5/5 通过**（详见 TEST_REPORT.md「真机首验」）：
  ①流式对话（stdout `成功`，`stream_options.include_usage` 未被拒）；②bash 工具往返 + 后续请求
  计数；③子智能体统一计数（Key-1 窗口 5 = 主/子请求合计）；④阈值 2 粘性切换
  （sticky switches 2，窗口分布 2/2/1/0 精确等于 reserved 5，Key-1/2/3 真实服务）；
  ⑤流式 usage 无 400。
- **目录 24 模型复测一轮**（probe 路由，≈22s）：可用 12（`z-ai/glm-5.3-flash` 398ms 最快档）、
  TIMEOUT 9（含 `z-ai/glm-5.3` 与 kimi-k3——按规则保留「未确定」，真实流式预算 120s 仍可能可用）、
  SERVER 3（500/503，保留未确定）。迁移目标建议：`z-ai/glm-5.3-flash`（已验证可用且快）。
- 测试：`sh tests/run.sh` → **70/70**（69 + 快照无损回归）；文档同步。
- 待办：web 进程重启以加载两个 Host 半修复（重启会终止对话，交接见 HANDOFF.md）。

## 2026-10-14 23:46 · 真机报「测试未能执行 (HTTP 404)」：连接通道未注入 → 两条路由从未注册（三重根因）

- **症状**：用户点「获取模型列表」→ 目录**一下子出现 80 个**，汇总行
  `可用 0/80 · 已移除 0 · 保留 80 (未确定 80)`，列表下方红字 **`测试未能执行 (HTTP 404)`**。
- **根因一（主因）：这两条路由从未被注册。** `bundle/index.js` 的模块级 `export const inject = ['llm']`
  **不含 `connection`**，而 `registerConnectionRoutes` 是在 `apply()` 期间**急切读取** `ctx.get('connection')` 的
  —— 浏览器的**连接通道是独立 boot 行**，那一刻**尚未 ACTIVE**，读到 `undefined`，两条
  `ctx.connection.fetch.register` 于是**一条都没执行**。未注册的 `/api/*` 精确路由在**认证通过后**仍返回
  **404 "not found"**（`rpc-host.ts` 的 `createSharedFetchHandler` 按 pathname 精确匹配）→
  客户端拿到 `{error:'HTTP 404'}` → 红字「测试未能执行 (HTTP 404)」；**没有一个模型被判定**，
  于是 `0/80 可用、0 已移除、80 保留（未确定 80）`（80 个全按“未确定”保留**本身是裁剪规则的正确行为**，
  错的是探针根本没跑）。
- **修复一（正解 = DSH 官方惯用法）**：改为**作用域等待**
  `ctx.inject(['connection'], (connectionCtx) => { … })` —— 回调只在 `connection` 服务解析完成后执行
  （出处：`packages/bundle/web-app/src/index.ts:268`、`file-upload`、`session-log-export`）。
  **注意不是**把 `connection` 加进模块级 `inject`：那会把整个 provider 挂靠在浏览器通道上，
  无浏览器通道的部署会连 provider 一起不加载。现在无浏览器通道的部署**永不进入该作用域**
  （provider 本体照常挂载），注册仍包在 `connectionCtx.effect(…)` 内。
- **根因二：`UNUSABLE_STATUSES` 缺 `410`。** NVIDIA 对**已下线(retired)**模型返回 **410 Gone**；
  旧表只有 `[400,401,402,403,404]`，410 被当作“未确定”保留 → 目录里残留永远调不通的模型。
  修复：客户端 `UNUSABLE_STATUSES = [400,401,402,403,404,410]`。
- **根因三：整批共享一个超时。** `handleProbe` 原用**整批共享**的 `AbortSignal.timeout(20s)`：
  前几个慢模型一旦吃满预算，**排在后面的全部被整批截断**并误判为 `TIMEOUT`（实测一轮 80 个里
  **44 个**这样被误杀）。修复：**每个模型各自一份预算**——把
  `AbortSignal.any([request.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)])` 移进**单模型调用**内部
  （`PROBE_TIMEOUT_MS = 10_000`，并发仍为 6）；调用方取消依旧对每个探针生效。超时仍记「未确定」，
  **永不当作不可用**。
- **测试**：`tests/wiring.test.js` 的 `fakeContext` 补上 `inject: (names, callback)` 的 Cordis 语义
  （服务缺失则回调不执行；存在则以 `Object.assign(Object.create(ctx), scope)` 建作用域），与真实
  `ctx.inject` 同构——**否则测试里的旧「急切读取」写法正好会掩盖本缺陷**。用例数不变（wiring 16），
  `sh tests/run.sh` → **69 项 / pass 69 / fail 0 / rc=0**。
- **实证（重启后认证请求，非推测）**：进程 pid **1681424**（启动 **23:46:51**，晚于 `routes.js`
  mtime **23:46:40**）；带同源会话 cookie：
  `GET /api/nvidia-router.status` → **200** `{"keyCount":4,"totalKeys":4,"activeKey":"Key-1","health":"yellow",…}`；
  `POST /api/nvidia-router.probe`（body `{"models":["definitely/not-a-model"]}`）→ **200**
  `{"results":[{"id":"definitely/not-a-model","ok":false,"latencyMs":527,"status":404,"error":"HTTP_404"}]}`
  → **404 提示消失，探针确实在跑**。
- **全量 80 模型端到端实测（真实 NVIDIA 端点，跑一轮）**：耗时 ≈ **182s**；
  `ok=10 / 404=55 / TIMEOUT=10 / 500=2 / 503=2 / 400=1` → 裁剪后
  **可用 10 / 已移除 56 / 保留 24（未确定 14）**；可用的 10 个含
  `meta/llama-3.2-11b-vision-instruct`、`openai/gpt-oss-20b`、`nvidia/nemotron-3-super-120b-a12b` 等。
  **未确定 = 限流/超时/5xx，刻意保留**（可重测，不是“不可用”的证明）。
- **教训（已写入 HANDOFF 约束区）**：Host 半在 `apply()` 里需要另一个 boot 行的服务时，
  **必须 `ctx.inject(…, cb)` 作用域等待，不能急切 `ctx.get()`**；`/api/*` 未注册路由在**认证后返回 404**
  （未认证才是 401）——「HTTP 404」要这样读。

## 2026-10-14 23:10 · 真机报错 `models must list at least one catalog entry`：陈旧 Host 进程 + 空目录自锁

- **症状**：用户点「获取模型列表」→ `获取模型列表失败: llm-nvidia-router: models must list at least one catalog entry`。
- **根因（两条，均已实证）**：
  1. **运行中的 Host 跑的是旧代码**：`ps` 显示 web 进程启动于 `20:42`，而 `bundle/index.js`（21:53）、
     `bundle/config.js`（21:57）、`bundle/routes.js`（22:24）都在其后才被修改。**只有 `client.js`
     走 client-hmr（≈500ms 热更）；Host 半改动必须重启进程才生效**——这条以前只在文档里写过，
     这次真机结结实实撞到：旧 `config.js` 仍带「目录至少一个条目」的校验 → 抛错。
  2. **空目录自锁**：live profile `/home/liang/.dsh/profiles/web/cordis.patch.yml` 中 `models: []`
     （自动裁剪曾把所有模型删空并被保存）。于是「发现」被它本该修复的空目录挡住——
     **发现的意义就是从空目录起步填充，所以发现路径绝不能依赖已有目录**。
     全库 `grep` 确认该字符串**在磁盘上已不存在**（第 1 轮已移除），故只可能来自进程内旧模块。
- **修复**：
  - **重启 Host**，参数与原进程完全一致（`--host 192.168.25.199 --port 3080 --no-open
    --trusted-host 199dsh.smlkj.dynv6.net`）；新进程启动时间晚于全部 bundle mtime，确认加载新代码。
    重启后 `/plugins/events` → HTTP 200、30KB boot graph、无 error 字段、client rev `01c66e225e52`。
  - **客户端防自锁（`bundle/client.js`）**：裁剪结果为 0 时**不写回配置**——保留拉取到的完整目录，
    汇总行改用红字提示（新增双语键 `pruneAll`，指向 Key/额度问题而非目录问题）；
    `discover()` 端点为空时也不再清空现有列表；`keepOnlyUsable()` 同样拒绝把满目录换成空目录。
- **实证：DSH 明确支持空目录**（`packages/llm/llm/src/index.ts:242`、`types.ts:329`，以及
  `.agents/notes/archived/architecture/2026-08-04-declaring-a-provider-from-the-models-page.md`）：
  「空列表 = 由该路由提供内置目录」「目录成员资格是建议性的，不是请求校验」。
  所以 `models: []` 是合法起点，无需回填种子。
- **测试**：`tests/wiring.test.js` 15 → **16** 项，新增
  `wiring: an empty catalog activates and discovers, rather than locking discovery out`
  （`models: []` 仍能注册 provider、仍能发现端点目录、`listModels` 按文档返回空）；
  `sh tests/run.sh` → **69 项**，连续 3 次 `pass 69 / fail 0 / rc=0`。
- **教训（已写入 HANDOFF 约束区）**：改 Host 半文件后**必须重启**；「发现」永远不能依赖非空目录。

## 2026-10-14 · 需求 1 收敛为「只保留当前免费可用」：全量 80 条 → 实测裁剪（用户实测反馈）

- **问题**：用户填 `https://integrate.api.nvidia.com/v1` 后目录出现 **80 个模型**，
  而用户只要**英伟达当前免费可用**的模型，不是全部 80 条。
- **根因（匿名实测确证，非推测）**：`GET https://integrate.api.nvidia.com/v1/models` → HTTP 200，
  **恰好 80 条**，每条字段**仅** `{id, object, created, owned_by}`——端点**不提供任何
  免费/付费/可用性/模态标记**；且这 80 条里混有 embedding/rerank/内容安全/视觉检测/
  文档解析等**不能对话**的模型（`nvidia/embed-qa-4`、`nvidia/nvclip`、`nvidia/nemotron-parse`、
  `meta/llama-guard-4-12b`、`nvidia/nemotron-4-340b-reward`）。
  → **"当前免费可用"无法从列表元数据读出，只能实测**（不引入硬编码"免费清单"）。
- **实现（拉全量 → 自动实测 → 防误杀裁剪）**：
  - `bundle/client.js`：`discover()` 重写为 **拉全量 → `setFullCatalog` → 自动 `runProbe` →
    `pruneCatalog` → `setPruneSummary`**；新增常量 `DEFAULT_BASE_URL`、
    `UNUSABLE_STATUSES=[400,401,402,403,404]`；新增状态 `fullCatalog`/`pruneSummary`；
    新增 `toCatalog`/`runProbe`/`pruneCatalog`/`summarize`/`keepOnlyUsable`/`restoreAllModels`；
    `testModels()` 改为复用 `runProbe`。渲染新增「仅保留可用」按钮、探测提示、汇总行
    （`可用 N/M · 已移除 D · 保留 K (未确定 U)`）与「恢复全部模型」按钮；新增 9 个双语字典键。
  - **裁剪规则（防误杀）**：只移除 **400/401/402/403/404**（模型不存在 / 凭据错 / 额度耗尽 /
    请求非法）；**429 限流与 5xx/超时一律保留为"未确定"**——限流是真实应答，不是"不可用"的证明。
  - `bundle/routes.js`：探测并发 `PROBE_CONCURRENCY` 由 3 提高到 **6**（配合 80 模型批量实测）。
- **同一批修复（用户上一轮反馈）**：模型发现请求契约——`LlmRuntime.discoverModels` 在把请求
  派发给插件注册的回调**之前**，即校验 `request.provider` 或 `request.baseURL` 至少一个非空
  （`packages/llm/llm/src/index.ts:601`），Host 回调内兜底**来不及生效**；且本插件 Config 的
  `baseURL` **刻意无默认值**（有默认值会令 `NVIDIA_BASE_URL` 环境回退失效）→ 客户端改为
  **三级兜底**（draft → 已保存值 → `DEFAULT_BASE_URL`），请求体永远携带非空 baseURL。
- **测试**：`tests/wiring.test.js` 14 → **15** 项（新增：429 作为状态上报而非"不可用"证据，
  且响应不泄密钥）；`sh tests/run.sh` → **68 项**，连续 5 次全量运行 `pass 68 / fail 0 / rc=0`。
- **顺带修复一个真实缺陷：配额预留泄漏**。测试中偶发 `windowCount 1 !== 0`
  （`adapter.test.js:406` / `:540`）。根因：`QuotaLease` 构造时**再次调用 `clock()`** 作为
  `reservedAt`，与 `#tryAcquire` 实际压入窗口的 `now` 在真实 `Date.now()` 下可能相差 1ms →
  `release()` 的 `window.lastIndexOf` 落空 → **静默跳过 splice，预留永久泄漏**
  （窗口计数只增 → 线上会误判"所有 Key 不可用"并提前抛 `RATE_LIMIT`）。
  修复：`reservedAt: now` 由 `#tryAcquire` 直接传入，构造器不再读时钟（`bundle/scheduler.js`）；
  新增确定性回归测试（`tests/scheduler.test.js`，注入每次 +1 的时钟；修复前必失败）。
- 文档同步：README / TEST_REPORT / PROJECT_STATUS / TASK_CHECKLIST / TECHNICAL_DESIGN / HANDOFF 全量更新。

## 2026-10-14 · 动态模型目录 + 模型探测按钮 + 对话头部健康徽标（用户三项新需求）

- **需求**：① 端点与模型目录要**动态模型列表**——不用手填模型，免费能用的直接从端点进列表
  （对齐官方做法：只填 API，其它不用填）；② 配置页要一个**「测试所有模型 API 可用性并显示延迟」**按钮；
  ③ 对话主页右上角显示**当前配置了几个 API** 的数字，并用**红/黄/绿**表示是否正常。
- **通信机制（关键决策）**：`/api` 通道 RPC interceptor 只能有一个所有者（已被 API Gateway 占用），
  故改用 DSH 文档化的**精确 Fetch 路由** `ctx.connection.fetch.register`：Host 注册
  `POST /api/nvidia-router.probe` 与 `GET /api/nvidia-router.status`（包在 `ctx.effect` 内），
  Client 用文档相对路径 `fetch('api/...')`。
- **实现**：
  - 新建 `bundle/routes.js`：探测逐模型最小 completion（并发 3、20s 超时、`performance.now()` 计时，
    返回 id/成败/状态码/延迟，**不含密钥**）；健康路由先 `scheduler.syncKeys()` 再快照，
    输出 `{keyCount,totalKeys,health,keys[]}`，`computeHealth` 导出纯函数判红/黄/绿。
  - `bundle/index.js`：新增 `resolveAnyKey()`（取第一个可解析 Key，供模型发现用）与
    `keyConfigured()`（credentials.describe 优先、environment.get 兜底）；末尾注册两条连接路由。
  - `bundle/config.js`：移除 `resolveModels` 的空目录抛错（动态目录允许删空后保存）。
  - `bundle/client.js`：模型目录**只读**展示（移除“手动添加模型”入口，仅保留“移除”+“获取模型列表”），
    存 Key 成功后自动 `discoverModels`；新增「测试所有模型」按钮渲染绿/红圆点 + 延迟；
    新增 `ApiHealthBadge` 注册进 `conversation.session.header.utilities`
    （`id: nvidia-router-health`, order 30），显示 `keyCount` + 红/黄/绿圆点，15s 轮询。
    删除手动添加相关的孤儿字典键（modelId/modelName/modelContext/modelMaxTokens/addModel）。
- **测试**：`tests/wiring.test.js` 由 9 → 14 项（健康判定纯函数四态、探测逐模型计延迟不泄密钥、
  失败模型保留 404、无凭证干净拒绝 `MISSING_CREDENTIAL`、健康路由只计已存储 Key 并给出判定）；
  `sh tests/run.sh` → **66/66 通过**；`node --check` 全部通过。
- 浏览器内呈现（探测按钮/头部徽标）待用户刷新确认。

## 2026-10-14 · 配置界面改为设置独立页 + 行按钮问题 Host 侧排查（用户决定）

- **问题**：插件页行旁“配置”按钮在用户浏览器未出现（10:36 重启后仍缺），且用户决定
  配置界面改为左下「设置」里的独立页面，并明确要求 Key 数量不限。
- **方案**：`bundle/client.js` 增设 `settings.section` 注册（id `nvidia-router`、
  order 16 紧跟插件页、label 双语）。表单不再依赖插件页传 props：经
  `ctx.inject(['configForms'])` + `configForms.get('llm-nvidia-router')` 自建，
  `useSyncExternalStore` 订阅 `getSnapshot`，保存走 `mutate(ops, revision)` 原子写；
  注册经 `whileServed(['llm-nvidia-router'])` 跟随 Host 半体（行被禁用时设置页自动消失）。
  `plugins.row.config` 行按钮注册保留为备用入口，二者共用同一 ConfigCard。
  Key 表文案明示无行数上限（`apiKeys` 本就是任意长数组，默认 4 个仅是样例）。
- **行按钮排查结论（Host 侧无缺陷，证据三重）**：
  1. `/plugins/events` SSE 首帧（无需认证）显示 boot graph（71 条目）**包含**
     `@local/dsh-llm-nvidia-router`（application 批次）——“条目不在图里”被排除；
  2. 按文件基线算出的 rev 直接 GET bundle URL → 200 且字节与本地一致——“扫描失败/负缓存”
     被排除（`tests/scan-repro.mjs` 复现扫描逻辑全通过）；
  3. 注册 key、`rowConfigKey(pkg.name, row.rowId)`、factory require 的平台 seed 表、
     `slots.inject` 错误语义、激活审计（fiber 失败会令整页 boot 失败而 GUI 正常）——
     逐环核对一致。残余原因只能在浏览器运行时（控制台报错/页面未硬刷新），待用户验证。
- **重要机制发现（纠正前次交接的认知）**：`dsh-client-hmr` 每 500ms 轮询所有客户端
  bundle 文件（stat 对比）并经 `rebuilt()` → SSE 把新代推给已连接页面——
  **改 `bundle/client.js` 不需要重启 DSH**。“重启才生效”只适用于 client-modules 的
  包元数据负缓存（首次声明 `dsh.client` 之前启动的进程）。本次改版实测：保存后约半秒
  graph rev 即更新（`0e23e295059c` → `f7d32cc5809e`），新 bundle 直接可取。
- 验证：`node --check` 通过；61/61 回归通过；设置页浏览器内渲染待用户确认。

## 2026-10-14 · 新增插件页配置窗口（用户反馈：点开插件看不到配置）

- **问题**：DSH 插件页没有通用配置编辑器（配置 UI 由插件经 slot 自行注册）；Models 页的
  通用凭据流按单 `apiKeyEnv` 约定构建，不适配本插件的多 Key 结构。
- **方案**：按 DSH 文档化机制新增客户端半体 `bundle/client.js`（手写 lazy-CJS 工厂格式，
  零构建；`package.json` 增 `dsh.client: {platform: web}` 与 `./client` 导出）。
  注册 `plugins.row.config` 槽位（key = `包名#llm-nvidia-router`）→ 插件页该行自动出现
  “配置”按钮 → 配置窗口。
- **窗口能力**：API Key 表（引用名+标签编辑；密钥值经 `remote.credentials.set/unset/describe`
  直存/清除/显示已存储徽标——值只进 credentials 服务）、Base URL、模型目录（增删改）、
  粘性调度/冷却/超时数值（非法值标红并禁存）、行为开关；保存 = `form.mutate` 原子写
  （Host 全量校验 + volatile HMR 即时生效）；中英双语字典；只读态/不可用态处理。
- 验证：`node --check` 语法通过；Host 侧两次行禁用/启用（`application: applied`）后
  无扫描错误，61 项回归测试不变。**浏览器内渲染待用户确认**（无浏览器控制）；
  client-modules 的包元数据缓存重启才失效——若刷新后无“配置”按钮，重启 DSH 一次即出。
- 追加修正（对照 ui-settings-models/ui-settings-plugins 清单）：`dsh.client` 需声明
  `inject` 包依赖边（`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-api-remotes`，
  二者均为 web 组合内已有行）——否则客户端插件可能在 locale/remote 服务就绪前挂载而失败。
  另确认 `slots` 服务由 shell 基线提供，无需声明。

## 2026-10-14 · 安装进 web profile 并激活（阶段 3）

- `install_bundle` 成功链接 `@local/dsh-llm-nvidia-router@0.1.0` 到 profile node_modules（指向项目 bundle/ 目录）。
- **发现并修复路由冲突**：默认路由 id `nvidia` 与基础 profile 的 `llm-pi-ai` 可配置目录
  （pi-ai 内置目录含 nvidia）冲突，激活失败 `DUPLICATE_DIRECTORY`；该部署当前正使用
  pi-ai 的 nvidia 路由（`z-ai/glm-5.3` + 单 Key）。默认 id 改为 **`nvidia-router`**
  （schema 默认 + resolver 兜底 + profile 行覆盖三处一致），并在
  `~/.dsh/profiles/web/cordis.patch.yml` 追加行覆盖（备份 `.bak-nvidia-router-20261014`）。
- HMR 重组后激活成功；验证：`nvidia_quota_status` 工具出现在 Host 工具目录、
  `Config.listConfigs` 可查 `include:llm-nvidia-router` 全 schema。
- 用户现有配置（pi-ai nvidia profile、agent-default-model）**零改动**；迁移到本路由为用户决策，
  步骤见 README「迁移到本路由」。

## 2026-10-14 · 初始实现完成（v0.1.0）

**新增 bundle（纯 ESM JS，零运行时依赖）：**

- `config.js`：schemastery Config（17 个可调字段，含 retryPolicy 复用 dsh-llm 的 `RetryPolicySchema`）+ `resolveAdapterOptions` 显式重校验（加载 fail-loud、动态配置同校验）。
- `scheduler.js`：sticky_quota 调度器——粘性 Key 选择、60s 滚动窗口（默认 38/窗口本地阈值）、同步原子预留（单线程同步段无 await）、429 指数退避冷却（服务端 Retry-After 优先）、401/403 与缺凭据长冷却、402 账户级配额冷却、全不可用有界等待 + 可诊断 RATE_LIMIT（含最早恢复提示）、幂等 Lease 上报、`advanceStickyPast`（超时/传输错误后粘性锚点前移）。
- `errors.js`：HTTP/传输/带内错误分类，镜像 `dsh-llm-deepseek` transport 码表（INVALID_REQUEST/AUTH/QUOTA/RATE_LIMIT/CONTEXT_WINDOW_EXCEEDED/SERVER/HTTP_n/TRANSPORT/TIMEOUT），Retry-After 秒与 HTTP 日期解析。
- `wire.js`：OpenAI 兼容请求序列化（system/developer/user/assistant/tool 角色映射、tool_calls、max_tokens/temperature/stop、stream_options.include_usage）+ SSE 流翻译（首见序块 index、原始 JSON 工具参数、usage 先于 finish、[DONE] 缓冲冲刷、EMPTY_RESPONSE/CONTENT_FILTERED/带内错误终结）。
- `adapter.js`：provider 适配器——请求/流空闲两级超时（dsh-timeout `deadline`+`idleWatchdog`）、**首块输出前**有限 Key 故障转移（默认 2 次；RATE_LIMIT/AUTH/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE/凭据错参与；INVALID_REQUEST/CONTEXT/QUOTA/HTTP_4xx 不参与）、流开始后只终止不重发、发送前取消释放预留、已发送失败计数保留。
- `status.js` + `index.js`：`nvidia_quota_status` 只读诊断工具（严格 JSON schema 输出 + 脱敏渲染）、`registerConfigurableProviders`（Models 页可配置）、`registerModelDiscovery`（端点模型发现）、credentials 服务优先的密钥解析（与 `llm-deepseek-api-key` 同模式）。

**测试（tests/，61 项全部通过，详见 TEST_REPORT.md）：**

- 可控 OpenAI 兼容 mock 端点（SSE 时序、429+Retry-After、401/403/404/402/5xx、停滞、断连、空完成、content_filter、带内错误）。
- 5 个套件覆盖规则文件第九节 1–14 项中除“真实 API”外的全部可测项；适配器输出经真实 `BlockAssembler` 组装验证。

**文档：** README / TECHNICAL_DESIGN / TASK_CHECKLIST / PROJECT_STATUS / TEST_REPORT / HANDOFF / CONFIG.example.yaml 全量建立。

**关键决策（原因见 TECHNICAL_DESIGN.md）：**

1. 适配器插件方案而非本地代理/改 loop——`ctx.llm` adapter seam 是文档化的一等扩展点，零源码改动。
2. Key 故障转移限定在首个流块之前——流开始后重发会造成可见内容重复；步级重试交给 `dsh-llm-retry` 按策略执行。
3. 窗口/冷却为进程内存态——60s 窗口持久化收益低；重启后由服务端 429 反馈自愈（至多一次被拒请求的代价）。
4. “参考 RPM 40”记入文档而非配置字段——避免无行为作用的配置项；阈值默认 38 ≈ 40×95%。

## 开发过程中的修正（保留审计）

- `contentText` 未跳过 assistant 历史中的 tool-call/reasoning 块 → 后续请求序列化抛错（已修）。
- fetch 阶段不在 idle watchdog 覆盖内，停滞响应可无限挂起 → 新增 `requestTimeoutMs` 截止。
- 超时/传输错误后粘性锚点不前移，重试落回同一 Key → `advanceStickyPast`。
- Lease 结果上报引入幂等保护，双层分类只计一次。
