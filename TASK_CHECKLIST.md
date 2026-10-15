# TASK_CHECKLIST — NVIDIA Smart Quota Router

任务状态标记：`[ ]` 待办 · `[~]` 进行中 · `[x]` 已完成（附验证证据）· `[!]` 阻塞 · `[?]` 未测试/待验证

上次更新：2026-10-15 12:1x（真机全链路已通且 GUI 在用：health green；Host 半免重启已启用；仅剩可选迁移决策）

## 阶段 0：架构检查（已完成，全部有源码/运行时证据）

- [x] 检查 DSH 运行方式：源码检出 `/vol2/1000/deepseek harness/`，进程 `node --import tsx/esm apps/cli/src/bin.ts web --host 192.168.25.199 --port 3080`，profile `web`（`/home/liang/.dsh/profiles/web`），config-only HMR 默认开启
- [x] 确认模型调用统一入口：所有模型请求（主智能体、进程内子智能体、会话标题、压缩摘要）都经过 `ctx.llm.stream()`（`@deepseek-ai/dsh-llm`）；新增 provider = 在 `ctx.llm` 上注册 adapter（docs/architecture.md「Where new behavior goes」）
- [x] 确认子智能体模型路径：默认子智能体（subagent-spawn-in-process / fork-in-process、Agent Teams 队友）为进程内实现，与主智能体共享同一 `ctx.llm` 实例 → 同一 adapter 实例 → 同一调度器状态；ACP/Codex/Claude Code/dsh-sdk 等进程外子智能体是独立产品，自带模型配置，不在本调度器覆盖范围（已记录为设计边界）
- [x] 确认并发模型：单 Node 进程、单线程事件循环；同步「检查+预留」即原子，无需 Redis/SQLite 跨进程状态
- [x] 确认重试边界：`ctx.llm.stream()` 一次 = 一次 provider 尝试；`dsh-llm-retry` 在 agent 步边界按 provider 自有 `retryPolicy` 重跑；默认可重试码 EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT；`providerRetryAfterMs`（Retry-After）在策略上限内被 llm-retry 采纳
- [x] 确认插件分发机制：工作区 bundle（package.json `dsh.bundle` + `cordis.patch.yml`）经 `plugin_manager install_bundle` 安装进 profile；插件对 `@deepseek-ai/*` 的静态 import 由 profile 拦截层解析到运行中安装的作用域（app-boot `collectInstallationScopePackages` 的 BFS 显式包含 peers，注释原文 "out-of-tree plugins import them directly"）
- [x] 确认 GUI 接入：`ctx.llm.registerConfigurableProviders()`（Models 页可配置 provider）+ `listModels()` 目录（GUI 选模型要求目录成员）+ `registerModelDiscovery()`（端点模型发现）
- [x] 确认密钥读取规范：credentials 服务 `ctx.get('credentials')?.resolve(envRef)` → `{value}`，否则 `launchEnvironmentOf(ctx).get(envRef)`；`assertUsableApiKey` 校验（与 `llm-deepseek-api-key` 相同模式）
- [x] 验证测试可行性：Node 26.10.0（`/vol1/@appdata/trim.hermes/旧hermes配置文件/node/bin/node`）+ 检出根 `--import tsx/esm`，测试文件位于检出目录内可按祖先链解析真实 `@deepseek-ai/*` 工作区包（probe 测试已实际运行通过：dsh-llm/schemastery/dsh-tools/dsh-timeout/dsh-launch-environment 全部可导入）

## 阶段 1：调度核心与适配器实现（已完成）

- [x] TECHNICAL_DESIGN.md 记录真实架构、调度流程、状态管理、技术决策（§1 证据表 + §2-§7）
- [x] bundle/config.js：schemastery Config（17 个可调字段 + retryPolicy）+ `resolveAdapterOptions` 显式解析/校验（wiring 测试覆盖：schema 校验默认值、越界 fail-loud、NVIDIA_BASE_URL 回退；**动态目录下 `models` 允许为空数组**）
- [x] bundle/scheduler.js：sticky_quota 调度器（scheduler.test.js 18 项：粘性/阈值/滚动窗口/50 并发不突破/有界等待与恢复/冷却退避/不抖动/幂等上报/重启/Key 表增删）
- [x] bundle/errors.js：错误分类（errors.test.js 11 项：状态矩阵/配额与上下文文案/类型分类/网关非 JSON/Retry-After 三态/传输分类/故障转移资格）
- [x] bundle/wire.js：OpenAI 兼容序列化 + SSE 翻译（adapter.test.js：角色映射、工具参数原始 JSON、usage 先于 finish、reasoning_content、流式逐块到达）
- [x] bundle/adapter.js：流式/工具调用 + 首块前有限故障转移；流开始后不换 Key 重发（adapter.test.js：429 转移、共享限流 3 次封顶、断连不重发、超时保留计数+锚点前移、取消语义、UNSUPPORTED_OPTION fail-loud）
- [x] bundle/status.js：脱敏状态快照 + nvidia_quota_status 工具（security.test.js：快照仅含标签与引用名）
- [x] bundle/index.js：apply() 注册接线（wiring.test.js：路由/目录/发现/工具注册、无 tools 服务时降级告警、零 Key fail-loud）
- [x] bundle/package.json + cordis.patch.yml + locale/{en,zh}.json + icon.svg（manifest 对齐 host-plugin.md 规范）

## 阶段 2：自动化测试（已完成，69 项；全部通过 `pass 69 / fail 0`）

- [x] tests/mock-nvidia-server.js：可控 OpenAI 兼容 mock（SSE 时序、429+Retry-After、401/403/404/402/5xx、停滞、断连、空完成、content_filter、带内错误、/models）
- [x] scheduler.test.js：19/19（规则测试项 1、2、3、4、7 及冷却恢复、重启语义；**新增预留泄漏回归**）
- [x] adapter.test.js：18/18（规则测试项 1、2、5、6、8、9、10、13、14 的适配器层；含 BlockAssembler 真组装）
- [x] errors.test.js（11/11）+ security.test.js（5/5）+ wiring.test.js（16/16）：错误码表、密钥零泄漏（日志/错误/快照/请求体/源码/样例）、apply() 接线 + **探测/健康两条 fetch 路由、健康判定纯函数、429 状态上抛、空目录仍能发现**（`fakeContext` 已补 `inject(names, cb)` 的 Cordis 语义）
- [x] TEST_REPORT.md 记录实际命令与结果（2026-10-14 23:52：tests 69 · pass 69 · fail 0；失败修复史留痕）
- [x] **修 `windowCount 1 !== 0` 间歇性失败**（2026-10-14 深夜）：定位为 `QuotaLease` 构造时重复读时钟
      → `release()` 找不到自己压入的窗口条目 → **预留永久泄漏**（真实缺陷，线上会提前抛
      `RATE_LIMIT`）。修复：`reservedAt: now` 由 `#tryAcquire` 传入；新增确定性回归用例。见 TEST_REPORT.md。

## 阶段 3：安装接入与真机验证（安装/激活/客户端界面/动态目录+探测+健康徽标已完成；真机验证待用户 Key）

- [x] `plugin_manager install_bundle` 安装进 `web` profile：pnpm 链接成功
  （`@local/dsh-llm-nvidia-router@0.1.0` → 项目 bundle/）；首次激活因路由 id 冲突失败
  （`DUPLICATE_DIRECTORY`：pi-ai 已声明 `nvidia` 目录）→ 修复为 `nvidia-router`
  （bundle 默认 + schema 默认 + resolver 兜底三处）并在 profile patch 追加行覆盖（改前已备份）
- [x] `cordis_inspect_query` 验证激活：`nvidia_quota_status` 工具已出现在运行中 Host 工具目录
  （apply() 末位注册，证明目录/发现/adapter 均成功）；`Config.listConfigs` 返回
  `include:llm-nvidia-router`（status=schema，17 个字段全部可见）
- [x] 客户端配置界面（2026-10-14）：`bundle/client.js` 双入口——
  ① 设置独立页（`settings.section` 槽位，id `nvidia-router`、order 16（紧跟插件页），
  经 `ctx.inject(['configForms'])` + `whileServed(['llm-nvidia-router'])` 跟随 Host 半体，
  表单用 `useSyncExternalStore` 订阅 `ConfigForm.getSnapshot`，`mutate(ops, revision)` 原子写）；
  ② 插件页行“配置”按钮（`plugins.row.config`，保留）。Key 表无行数上限，界面文案明示。
  验证：`node --check` 通过；boot graph/bundle 内容/热加载三重活体证据（TEST_REPORT.md）；
  61/61 回归通过。浏览器内渲染待用户确认
- [x] 动态模型目录 + 模型探测 + 健康徽标（2026-10-14 第三轮，按用户新需求）：
  ① **动态目录**——`bundle/client.js` 模型列表只读展示（移除“手动添加模型”入口，仅保留“移除”
  与“获取模型列表”），存 Key 成功后自动调用 `ctx.remote.llm.discoverModels` 刷新；
  `bundle/config.js` 移除 `resolveModels` 空目录抛错，允许「删空后保存」；
  ② **「测试所有模型 + 延迟」按钮**——Host 新建 `bundle/routes.js`，经
  `ctx.connection.fetch.register` 挂 `POST /api/nvidia-router.probe`（逐模型最小 completion，
  并发 3、20s 超时，`performance.now()` 计时，返回 id/成败/状态码/延迟，**不含密钥**），
  客户端逐行显示绿/红圆点 + 延迟与「可用 N/M」；
  ③ **对话头部健康徽标**——Host 同文件挂 `GET /api/nvidia-router.status`（先 `syncKeys()` 再快照，
  输出 `{keyCount,totalKeys,health,keys[]}`，`computeHealth` 纯函数判红/黄/绿），
  客户端 `ApiHealthBadge` 注册进 `conversation.session.header.utilities`
  （id `nvidia-router-health`, order 30），显示已配置 Key 数 + 圆点，15s 轮询。
  `bundle/index.js` 增 `resolveAnyKey()`/`keyConfigured()`。验证：`node --check` 全通过；
  **68 项回归**（wiring 由 9 → 15 项，覆盖两路由、判定纯函数与 429 上抛）；槽位契约对照源码核对。
  浏览器内呈现待用户确认
- [x] 动态目录「只保留免费可用」+ 发现失败修复（2026-10-14 深夜，按用户实测反馈）：
  ① Client `discover()` 加 **baseURL 三级兜底**（draft → 已保存 → 官方默认），
  修掉 `model discovery needs a provider route or a baseURL`（根因：`LlmRuntime` 在派发给插件回调
  **之前**即校验 provider/baseURL 非空，Host 回调内兜底无效）；
  ② 匿名 curl 实测确证 `GET /v1/models` 返回 **200 / 恰好 80 条**、字段仅 `id/object/created/owned_by`、
  **无免费标记**且混入非对话模型，故「免费可用」只能实测；
  ③ `discover()` 改为 拉全量 → 自动实测 → 裁剪；只移除 `400/401/402/403/404`，
  **429 与 5xx/超时保留为“未确定”**；新增「恢复全部模型」/「仅保留可用」；`routes.js` 并发 3 → 6；
  新增 wiring 测试（429 上抛）。验证：`node --check` 通过；**68 项回归**
- [x] 配额预留泄漏修复（2026-10-14 深夜，测试中发现）：见阶段 2 末条；`bundle/scheduler.js`
  `reservedAt` 改为由 `#tryAcquire` 传入；`scheduler.test.js` 新增确定性回归用例；
  连续 5 次全量运行 `pass 68 / fail 0`（现为 **69**）
- [x] 真机「测试未能执行 (HTTP 404)」修复（2026-10-14 23:46，**三重根因**，均已实证）：
  ① **主因——两条 fetch 路由从未注册**：模块级 `inject = ['llm']` 不含 `connection`，而
  `registerConnectionRoutes` 在 `apply()` 里**急切**读 `ctx.get('connection')`；浏览器连接通道是
  **独立 boot 行**，那一刻未 ACTIVE → `undefined` → 两条 `connection.fetch.register` 都没执行。
  未注册的 `/api/*` 精确路由在**认证后**返回 **404**（未认证才是 401）→ 客户端红字
  「测试未能执行 (HTTP 404)」，80 个模型全按“未确定”保留（`可用 0/80 · 已移除 0 · 保留 80`）。
  **修复**：`ctx.inject(['connection'], (connectionCtx) => …)` **作用域等待**（DSH 官方惯用法，
  `packages/bundle/web-app/src/index.ts:268`、`file-upload`、`session-log-export`）；
  **不**把 `connection` 加进模块级 `inject`（那会连 provider 一起挂到浏览器通道上）；
  ② **`UNUSABLE_STATUSES` 补 `410`**（NVIDIA 对 retired 模型回 410 Gone）；
  ③ **探测超时改「逐模型独立 10s」**（原整批共享 20s → 一轮 80 个里误杀 **44 个**为 TIMEOUT）。
  测试：`fakeContext` 补 `inject(names, callback)` 语义（与真实 Cordis 同构）；
  `sh tests/run.sh` → **69 项全通过**（wiring 16）。
  **实证**：pid 1681424（23:46:51 启动）下认证同源 `GET /api/nvidia-router.status` → **200**、
  `POST /api/nvidia-router.probe` → **200**（`definitely/not-a-model` → `HTTP_404`，527ms）；
  全量 80 模型一轮 ≈182s → **可用 10 / 已移除 56 / 保留 24（未确定 14）**
- [x] 行按钮未出现问题的 Host 侧排查（2026-10-14）：boot graph 含本包条目（SSE 活体）、
  bundle 按当前 rev 可服务且字节一致、注册 key 与 `rowConfigKey(pkg.name, row.rowId)` 一致、
  factory 的 require 全部在平台 seed 表、`slots.inject` 错误语义与激活审计推不出静默失败——
  Host 侧无缺陷；残余原因在浏览器运行时（待用户控制台验证，步骤见 HANDOFF）
- [x] **真机首验 5/5（2026-10-15 凌晨，用户已配置 4 Key）**：headless 全栈 e2e
  （`dsh --profile headless --patch tests/e2e/*.yml`，凭据读全局 credentials 存储）——
  ①流式对话（stdout `成功`）②bash 工具往返+后续计数 ③子智能体统一计数（Key-1 窗口 5）
  ④阈值 2 粘性切换（switches 2、分布 2/2/1/0=reserved 5、Key-1/2/3 真实服务）
  ⑤stream_options 无 400。实录见 TEST_REPORT.md「真机首验」。
  首验**第一跑即抓到并修复两个活缺陷**：适配器缺 `prepareCall`（未继承 `LlmAdapter` 基类，
  web Host 从未有路由器流量故未暴露）→ `extends LlmAdapter` + `super()`；
  `nvidia_quota_status` 一调即报非无损 JSON（`snapshot()` 输出 `undefined` 值）→ 缺席字段
  省略属性 + `isJsonValue` 三态回归。**70/70 回归通过**。
  附：目录 24 模型复测（可用 12；`z-ai/glm-5.3-flash` 398ms 可用；`z-ai/glm-5.3` 探测超时保留未确定）
- [x] 设置页经用户实际使用证实（4 Key 经它保存、目录裁剪经它完成）
- [x] **用户 GUI 实证 + 免重启修复（2026-10-15 10:03–11:41）**：用户切插件模型发消息报
  `prepareCall is not a function`（旧进程持修复前模块代，与首验第一跑发现一致）→
  profile patch 追加 `hmr` 行开启**模块根 watch**（备份 `.bak-hmr-root-20261015`）→
  config-HMR 即时生效（inotify watch 表实证）→ 原地重写 adapter.js（内容不变）→
  `partialReload()` 热重建插件 fiber → **用户重试成功**；`/api/nvidia-router.status` →
  **health green / Key-1 sent 2 / ok 2**。Host 半改动从此免重启。
- [?] 对话页右上角健康徽标浏览器呈现（数据源 `/api/nvidia-router.status` 已实证
  health green，仅差用户顺带看一眼）
- [ ] 迁移决策（用户，可选）：是否把 `agent-default-model` 默认也切到 `nvidia-router`
  （README「迁移到本路由」；必须删除 `reasoningEffort: high`；建议模型 `z-ai/glm-5.3-flash`；
  按会话在模型列表选用插件模型已实测可用，迁移只影响新会话默认）

## 阶段 4：文档与交接（已完成并随实现同步）

- [x] README.md：安装、配置、运行、回滚 + 真机首验清单（已执行并勾选）
- [x] CONFIG.example.yaml：无真实 Key 的完整配置样例（含 patch 整行替换语义说明）
- [x] PROJECT_STATUS.md / HANDOFF.md / CHANGELOG.md 与代码一致（2026-10-15 更新）
- [x] `tests/e2e/{route-default,sticky-threshold}.yml`：headless e2e overlay 固件（无密钥）
- [ ] 评估为本项目目录建立独立 Git 版本管理并打标签（真机首验已通过，待用户点头）

## 阻塞与未测试事项

- [?] 真实 429 的 Retry-After 头格式与 `x-request-id` 头：本轮真机零 429，未观察到；
  下次真实 429 出现时顺带核对（其余真机行为已由首验覆盖）
