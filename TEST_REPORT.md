# TEST_REPORT — NVIDIA Smart Quota Router

本报告只记录**实际执行**的测试。通过/失败/未测试严格区分；未运行的一律标注。

## 运行环境（最近一次完整执行）

- 日期：2026-10-15 08:5x (Asia/Shanghai)
- 主机：DSH Web GUI 所在主机（源码检出 `/vol2/1000/deepseek harness/`，profile `web`）
- Node：v26.10.0（`/vol1/@appdata/trim.hermes/旧hermes配置文件/node/bin/node`；PATH 中无 `node`）
- 测试加载方式：`node --import tsx/esm --test`，从检出根运行；测试文件经祖先链解析真实 `@deepseek-ai/*` 工作区包（dsh-llm、dsh-tools、dsh-timeout、dsh-launch-environment、schemastery、cordis），因此被测对象是**真实 harness API**，不是桩
- 测试对象：`bundle/` 下的插件实现（纯 ESM JS，与安装进 profile 的文件一致）
- 端点：`tests/mock-nvidia-server.js` 本地可控 mock（OpenAI 兼容 SSE/429/401/超时/挂起）；自动化测试**不接触真实 API**；真机请求见「真机首验」小节（低频短任务与 max_tokens:1 探测）

## 命令与结果

```sh
sh tests/run.sh
# 等价于：node --import tsx/esm --test "项目/nvidia-smart-quota-router/tests/"
```

**最近一次结果：tests 70 · pass 70 · fail 0**（2026-10-15，含快照无损回归；单次耗时 ≈ 2.6s）

套件构成：

| 文件 | 数量 | 覆盖（对应规则文件第九节测试项） |
|---|---|---|
| scheduler.test.js | 19 | 1 单 Key 粘性；2 阈值切换；3 滚动窗口释放；4 并发不突破阈值（50 并发仅 10 个越过同步段）；7 全部不可用有界等待与清晰错误；冷却恢复/不抖动/重启语义/Key 表增删；**释放：时钟跨毫秒也不泄漏预留（回归）** |
| adapter.test.js | 18 | 1 粘性；2 阈值；5 429 冷却+换 Key；6 共享限流不盲目轮换（3 次封顶+服务端提示透传）；8 工具调用与后续请求；9 流式及时透传不重复；10 超时有限重试且计数保留；13 错误分类矩阵（400/401/403/404/402/429/500/502/503/504）；14 并发“主+子智能体”共享同一调度器计数；取消（发送前释放/已发送保留）；连接中断不重发已可见内容 |
| errors.test.js | 11 | 13 错误分类矩阵单元级；Retry-After 秒/HTTP 日期/非法；故障转移资格集合 |
| security.test.js | 6 | 12 密钥安全：日志/错误/快照/请求体/源码零泄漏；**快照在全新表/失败后/空表三种状态均为无损 JSON（工具管线规则回归）** |
| wiring.test.js | 16 | 插件接线：apply() 注册路由+目录+发现+状态工具+**两条连接 fetch 路由**；Config 真实 schema 校验与默认值；模型元数据；零 Key fail-loud；**健康判定纯函数（红/黄/绿）**；**探测路由逐模型计延迟且不泄露密钥**；**探测失败可见（404 保留）**；**无凭证时干净拒绝（MISSING_CREDENTIAL）**；**健康路由只计已存储 Key 并给出判定**；**429 以 status 原样上抛（供 GUI 判定“未确定”而非不可用）**；**空目录仍能激活并发现（不自锁）**；**fakeContext 以 `inject(names, cb)` 复刻 Cordis 作用域语义（服务缺失则回调不执行）** |

关键断言摘录（全部通过）：

- 粘性：38 次阈值下 37 连发全在 Key-1，switches=0；第 39 次切 Key-2（scheduler 测试 + 76 连发分布 {"Key-1":38,"Key-2":38} 冒烟）
- 并发原子性：50 个并发 acquire（阈值 10）只有 10 个完成预留，其余进入有界等待
- 429：Retry-After 3000ms 被采用为冷却与 `providerRetryAfterMs`；无提示时按 1s→2s→3s 封顶指数退避
- 共享限流：全部 Key 429 时恰好 1+maxFailoverAttempts 次尝试后以 RATE_LIMIT 抛出，各 Key 至多被拒 1 次
- 超时：150ms 停滞 → TIMEOUT；预留计数保留；粘性锚点前移后重试落在另一 Key
- 工具调用：arguments 以原始 JSON 字符串端到端（`{"city": "Tokyo"}`），后续请求 tool_call_id/role 正确映射
- 流式：40ms 间隔事件逐块及时到达；无重复；usage 在 finish 前最后输出；恰好一个 finish
- 真实 harness 组装器：适配器输出经真实 `BlockAssembler` 组装为内容块（非自制桩）
- 密钥安全：含 `nvapi-SECRET-*` 假密钥的完整 429/401/成功流程后，日志、错误文本、快照 JSON、请求体均无密钥值；源码与 CONFIG.example.yaml 无密钥字面量

## 客户端配置页改版实测（2026-10-14 17:00–17:35，非模拟）

设置页改版（`bundle/client.js`：新增 `settings.section` 注册，保留 `plugins.row.config`）
后的实测，全部对运行中的 Host（PID 1471436）执行：

- `node --check bundle/client.js`：语法通过。
- **boot graph 活体确认**（不经浏览器，直接消费 Host 的 `/plugins/events` SSE 首帧）：
  graph rev `6f7c423b1f52`，71 个条目中含 `@local/dsh-llm-nvidia-router`
  （application 批次，rev `0e23e295059c`，inject 边 `dsh-client-locale`/`dsh-api-remotes`）——
  **客户端条目确实在图里**，插件页行按钮缺失与 boot graph 无关。
- **bundle 内容活体确认**：按文件系统基线（mtime/ctime/size）计算 rev 并请求
  `/plugins/??@local/dsh-llm-nvidia-router/client.js&rev=0e23e295059c` → 200，返回字节与
  本地文件一致（仅追加 sourceMappingURL 尾注）。
- **改版热加载确认（无需重启）**：保存新 client.js 后，`dsh-client-hmr` 的 500ms 轮询
  自动发布——SSE 首帧 graph rev 变为 `6a3239cf693a`，本包行 rev 变为 `f7d32cc5809e`，
  新 bundle URL 返回 200 且包含新代码（8 处 SettingsSection/settings.section/whileServed 符号）。
- Host 侧扫描复现（`tests/scan-repro.mjs`，用 Host 相同的解析分支：裸包名解析 + 就近
  package.json + dsh.client 校验 + exports["./client"] + bundle 读取）：全部通过；
  注意 `createRequire(pkg/package.json)` 分支会因 exports 未声明 `./package.json` 而失败
  ——Host 实际不走该分支（`loader.internal` 存在，解析裸包名）。
- 61/61 回归通过（见上）。

## 动态模型目录 / 模型探测 / 健康徽标（2026-10-14 22:00，非模拟）

本轮按用户三项新需求实现：端点模型目录改为**动态获取**、配置页新增**「测试所有模型 + 延迟」**按钮、
对话头部新增**已配置 Key 数 + 红黄绿**徽标。实现与实测：

- **Host 半（`bundle/routes.js`，新建）**：经 `ctx.connection.fetch.register` 挂两条精确 fetch 路由
  （`POST /api/nvidia-router.probe`、`GET /api/nvidia-router.status`），注册包在 `ctx.effect` 内；
  - 探测：逐模型 `POST {baseURL}/chat/completions`（`max_tokens:1`，并发限 3，单次 20s 超时），
    以 `performance.now()` 计时；结果只含 `{id, ok, status?, error?, latencyMs}`，**不含任何密钥值**；
  - 健康：先 `scheduler.syncKeys?.()` 再取快照，输出 `{keyCount, totalKeys, health, keys[]}`，
    `keys[]` 只有 `label/credentialRef/configured/cooling/credentialError`；
  - `computeHealth` 为导出纯函数：未配置→red；全部不可用→red；部分不可用或从未成功→yellow；全部可用且有成功→green。
- **Host 半（`bundle/index.js`）**：新增 `resolveAnyKey()`（遍历 Key 表取第一个可解析者）与
  `keyConfigured()`（credentials.describe 优先、environment.get 兜底）；模型发现改用 `resolveAnyKey`；
  末尾注册两条连接路由。
- **`bundle/config.js`**：移除 `resolveModels` 的空目录抛错——动态目录允许「删空后再保存」。
- **Client 半（`bundle/client.js`）**：模型目录只读展示（移除“手动添加模型”入口，仅保留“移除”+“获取模型列表”）；
  存 Key 成功后自动 `discoverModels`；新增「测试所有模型」按钮渲染绿/红圆点与延迟；
  新增 `ApiHealthBadge` 注册进 `conversation.session.header.utilities`（`id: nvidia-router-health`, order 30），
  每 15s 轮询状态路由。旧的手动添加相关字典键（modelId/modelName/modelContext/modelMaxTokens/addModel）已删除。

实测（全部通过）：

- `node --check`：`bundle/{routes,index,client,config}.js` 与 `tests/wiring.test.js` 全部通过。
- **66/66 自动化测试通过**（新增 wiring 5 项，见上表）：探测路由逐模型计延迟且不泄露密钥、
  失败模型可见（not-found→404 保留）、无凭证干净拒绝（`MISSING_CREDENTIAL`）、
  健康路由只计已存储 Key（cold: keyCount 0 / totalKeys 4 / red；warm: keyCount 1 / yellow）、
  健康判定纯函数四态。均在可控 mock 端点上执行，**未接触真实 NVIDIA API**。
- 槽位契约对照源码核对：`conversation.session.header.utilities` 为 `{kind:'list', scope:'session'}`，
  注册选项 `{name,id,order,label,locale}` 与 `ui-open-in-app`/`ui-schedule` 的真实用法一致
  （`ui-slots` 的 list 选项类型含 `id/order/label`）——注册形态正确。
- **活体可达性抽查（受限结论）**：对运行中的 DSH（`192.168.25.199:3080`，进程
  `apps/cli/src/bin.ts web --host 192.168.25.199 --port 3080`）用 `curl` 请求两条新路由
  与一个**不存在**的 `/api/*` 路径，**全部返回 `401 Unauthorized`**（而 `/plugins/events` 为 `200`）。
  说明 `/api/*` 统一架在**鉴权门之后**，未认证请求无法区分「已注册 / 未注册」——**此抽查不作为
  路由可达的证据**。浏览器内由同源会话 cookie 通过该门，故页面内可达；两条路由的处理逻辑
  已由上述 5 项自动化测试覆盖。
  > **后续更正（2026-10-14 23:46）**：这个“受限结论”掩盖了真问题——**认证之后是可以区分的**
  > （已注册 200 / 未注册 404）。补做认证同源抽查后发现当时两条路由**根本没注册**
  > （根因：连接通道未注入），真机表现为红字「测试未能执行 (HTTP 404)」。详见下方同名小节。
- **浏览器内渲染待用户确认**：本对话期间无已连接浏览器页面，探测按钮/徽标的实际呈现
  仍标为「未测试」（见下）。client 代码改动经 `dsh-client-hmr` 约半秒生效，无需重启。

## 动态目录「只保留免费可用」+ 发现失败根因（2026-10-14 23:30，非模拟）

用户实测反馈两件事：① 点「获取模型列表」报 `model discovery needs a provider route or a baseURL`；
② 填了 `https://integrate.api.nvidia.com/v1` 后**出来了 80 个模型**，而用户只要“当前免费可用的”，
不是全部 80 个。

### 根因一：`needs a provider route or a baseURL`（已修复）

读 DSH 源码定位：报错出自 `packages/llm/llm/src/index.ts:601` 的 `LlmRuntime.discoverModels`，
**在把请求派发给插件注册的回调之前**就校验 `request.provider` / `request.baseURL` **至少一个非空**；
插件 Host 回调里再怎么兜底都来不及。而本插件 Config 的 `baseURL: z.string().volatile()`
**没有默认值**（这是刻意的——有默认值会让 `NVIDIA_BASE_URL` 环境变量回退失效），
所以客户端 draft 的 `baseURL` 在用户没填时是空串，旧代码只发 `{ baseURL: "" }`（等价于没发）。
→ 修法：客户端 `discover()` 改为**三级兜底**取生效 baseURL：**表单 draft → 已保存配置 → 官方默认
`https://integrate.api.nvidia.com/v1`**，请求体**永远携带非空 baseURL**。
（`storeKey` 成功后的自动 discover 走同一函数，一并修好。）

### 根因二：为什么是 80 个（实测确证，无静态免费标记）

在服务器上**匿名** `curl https://integrate.api.nvidia.com/v1/models` → **HTTP 200，恰好 80 条**，
每条字段**只有** `{id, object, created, owned_by}`——**没有任何免费/付费/可用性/模态元数据**；
且其中混有 embedding / rerank / 内容安全 / 视觉检测 / 文档解析等**根本不能对话**的模型
（如 `nvidia/embed-qa-4`、`nvidia/nvclip`、`nvidia/nemotron-parse`、`meta/llama-guard-4-12b`、
`nvidia/nemotron-4-340b-reward`）。结论：**“当前免费可用”没有字段可查，只能实测**——
免费档的实质就是“你这把 Key 能不能调通”。故不采用任何硬编码“免费模型清单”（必然过时）。

### 实现

- **客户端（`bundle/client.js`）**：
  - `discover()`：拉全量 → **自动**调用实测 → 按裁决**裁剪** → 面板显示
    `可用 N/M · 已移除 D · 保留 K (未确定 U)`；新增 **「恢复全部模型」**（还原原始目录）
    与 **「仅保留可用」**（按最近实测重剪）。「测试所有模型」保留为“只测不裁”。
  - 裁剪规则（防误杀，`UNUSABLE_STATUSES = [400,401,402,403,404]`）：**只有**这五种状态判定不可用并移除；
    **429 与 5xx/超时视为“未确定”并保留**（429 说明模型存在且免费档可用，只是被限流；80 连发本身就可能触发）。
  - 新增字典键：`probeHint / usableOf / removedOf / keptOf / uncertainOf / onlyUsable / restoreAll / prunedNote`。
- **Host（`bundle/routes.js`）**：探测量增大，`PROBE_CONCURRENCY` 由 3 提到 **6**（超时仍 20s/模型）。
- **测试**：`tests/wiring.test.js` 新增 1 项（共 **15**）：**429 以 `status` 原样上抛**，
  证明裁剪所需信息对 GUI 可见（且响应仍不含密钥）。

### 实测

- `node --check`（routes/client/scheduler）通过；`sh tests/run.sh` → **68 项**。
- 修复后**连续 5 次全量运行**均为 `pass 68 / fail 0 / rc=0`，见下节。

## 真机「测试未能执行 (HTTP 404)」（2026-10-14 23:46，非模拟；三重根因）

用户反馈：点「获取模型列表」→ 目录**又出现 80 个**，汇总 `可用 0/80 · 已移除 0 · 保留 80 (未确定 80)`，
列表下方红字 **`测试未能执行 (HTTP 404)`**。逐条定位如下，全部有证据。

### 根因一（主因）：两条 fetch 路由从未注册

- `bundle/index.js` 模块级声明 `export const inject = ['llm']`，**不含 `connection`**；而
  `registerConnectionRoutes` 在 `apply()` 里**急切**执行 `ctx.get('connection')`。
  **浏览器的连接通道是独立 boot 行**，`apply()` 运行时它**还没 ACTIVE** → `ctx.get('connection')`
  返回 `undefined` → 两条 `ctx.connection.fetch.register` **一条都没执行**，路由从未存在。
- `/api/*` 的匹配发生在**鉴权之后**且是**精确 pathname 匹配**（`rpc-host.ts` 的
  `createSharedFetchHandler`）：**未认证 → 401；已认证但未注册 → 404 `not found`**。
  所以认证后的 `404` 就是「路由不存在」的确定证据（与上一节“受限结论”相印证）。
- 客户端因此拿到 `{error:'HTTP 404'}` → 红字「测试未能执行 (HTTP 404)」；**没有任何模型被判定**，
  于是 80 个全按“未确定”保留（`0 可用 / 0 移除 / 80 保留`）——**“未确定全保留”本身是裁剪规则的正确行为**，
  错的是探针根本没跑。
- **修复（DSH 官方惯用法）**：
  ```js
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.connection.fetch.register({ … }), 'label')
    …
  })
  ```
  回调只在 `connection` 服务解析完成后执行（出处：`packages/bundle/web-app/src/index.ts:268`、
  `file-upload`、`session-log-export`）。作用域外的部署（无浏览器通道）**永不进入**，provider 本体照常挂载。
  **不能**把 `connection` 加进模块级 `inject`。

### 根因二：`UNUSABLE_STATUSES` 缺 `410`

NVIDIA 对**已下线(retired)**模型返回 **410 Gone**；旧表 `[400,401,402,403,404]` 会把它当“未确定”保留 →
目录残留永远调不通的模型。修复：客户端 `UNUSABLE_STATUSES = [400,401,402,403,404,410]`。

### 根因三：整批共享一个超时

原 `handleProbe` 用**整批共享**的 `AbortSignal.timeout(20s)`：前几个慢模型吃满预算后，
**排在后面的全部被整批截断**并误判为 `TIMEOUT`（一轮 80 个里**44 个**这样被误杀）。
修复：**每个模型各自一份预算**——`AbortSignal.any([request.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)])`
移入**单模型调用**内部（`PROBE_TIMEOUT_MS = 10_000`，并发仍 6）；调用方取消依旧对每个探针生效；
超时仍记「未确定」，**永不当作不可用**。

### 测试侧同步

`tests/wiring.test.js` 的 `fakeContext` 补上 `inject: (names, callback)` 的 Cordis 语义：
**服务缺失则不执行回调**；存在则以 `Object.assign(Object.create(ctx), scope)` 造作用域。
这很关键——**旧的“急切 `ctx.get()`”写法在测试里永远“成功”**，正好会掩盖本次真机缺陷。
用例数不变（wiring **16**），`sh tests/run.sh` → **69 项 / pass 69 / fail 0 / rc=0**。

### 实证（认证同源请求，非推测）

进程 **pid 1681424**（启动 **2026-10-14 23:46:51**，晚于 `bundle/routes.js` mtime **23:46:40**）；
`curl -c jar -L <loginURL>` 取得会话 cookie 后：

```
GET  /api/nvidia-router.status -> 200
     {"keyCount":4,"totalKeys":4,"activeKey":"Key-1","health":"yellow",…}
POST /api/nvidia-router.probe  -> 200
     {"models":["definitely/not-a-model"]}
     {"results":[{"id":"definitely/not-a-model","ok":false,"latencyMs":527,"status":404,"error":"HTTP_404"}]}
```

→ **404 红字消失，探针确实在跑**；响应中**不含任何密钥值**（仅 id/成败/状态码/延迟）。
对照：**未认证**请求两条路由均为 `401`（与不存在的 `/api/*` 同码）——**只有认证后才能区分 200 / 404**。

### 全量 80 模型一轮端到端实测（真实 NVIDIA 端点，仅此一轮，非高频）

命令本体是设置页同一个探针路由（`POST /api/nvidia-router.probe`，未传 models → 用当前目录全量 80 个）。
耗时 ≈ **182s**；逐模型裁决分布：

| 结果 | 数量 | 归类 |
|---|---|---|
| ok（2xx） | 10 | **可用**（保留） |
| 404 not found / 410 gone 类 | 55 | **不可用**（移除） |
| 400 | 1 | **不可用**（移除） |
| TIMEOUT | 10 | 未确定（保留） |
| 500 | 2 | 未确定（保留） |
| 503 | 2 | 未确定（保留） |

→ 裁剪后 **可用 10 / 已移除 56 / 保留 24（未确定 14）**。可用的 10 个含
`meta/llama-3.2-11b-vision-instruct`、`openai/gpt-oss-20b`、`nvidia/nemotron-3-super-120b-a12b` 等。
**“未确定”是刻意保留**（限流/超时/5xx 不是“不可用”的证明），可随时重测。

## 间歇性失败：定位与修复（2026-10-14 深夜，本轮发现并修复）

- **症状**：`windowCount` 偶发为 `1` 而期望 `0`（`1 !== 0`）。首现于
  `adapter.test.js:406`（发送前取消应释放预留），本轮另一次全量运行出现于
  `adapter.test.js:540`（缺凭据换 Key 的请求不留计数）。两者共同点：
  **都断言“未离开客户端的请求不留预留”**。
- **频率**：约每 2–3 次全量运行失败 1 次（真实 `Date.now` 时钟下才复现）。
- **根因（确证，非推测）**：`QuotaLease` 构造时**再次调用 `clock()`** 作为 `reservedAt`，
  而该值应该是 `QuotaScheduler.#tryAcquire` **实际压入窗口的那个时间戳**（`now`）。
  两者在同一个同步段内取值，但真实 `Date.now()` 可能在两步之间跨过 1ms 边界 →
  `reservedAt` 比窗口条目大 1 → `release()` 的 `window.lastIndexOf(this.reservedAt)`
  返回 `-1` → **静默跳过 splice，预留永久泄漏**（计数不减、`totalSent` 不减）。
  同步段极短 ⇒ 命中概率低 ⇒ 表现为“间歇”。
- **影响**：不只是测试抖动——**线上会造成预留泄漏**：窗口计数只增不减，
  最终把 Key 误判为“已达本地安全阈值/冷却中”，提前抛 `RATE_LIMIT`（“所有 Key 不可用”）。
  属真实缺陷，与本插件“多 Key 可靠路由”的核心目标直接冲突。
- **修复**：`bundle/scheduler.js` — 把 `reservedAt` 作为构造入参由 `#tryAcquire` 直接传入
  （`reservedAt: now`），构造器不再自行读时钟。语义零变化，仅消除时间戳错配。
- **回归测试**：`tests/scheduler.test.js` 新增确定性用例
  `release: a clock that ticks between reservation and lease construction cannot leak the slot`
  （注入每次调用 +1 的时钟，强制跨毫秒；修复前必失败、修复后通过）。
- **验证**：修复后连续 5 次全量运行 `pass 68 / fail 0 / rc=0`（此前约 1/3 概率 `fail 1`）。

## 真机首验（2026-10-15 凌晨，4 Key × headless 全栈 e2e——全部通过）

用户经设置页保存 4 个真实 Key（`NVIDIA_API_KEY_1..4`）。验证方法：**headless 单任务进程**
（`dsh --profile headless --patch <overlay> "<task>"`）——新进程从磁盘加载 bundle（含本轮修复）、
凭据经全局 `~/.dsh/.credentials.yaml` 解析（4 Key 全部可解析）、任务经完整 agent loop
（标题生成 + 工具调用 + 子智能体）打到真实端点。**全部请求都经过 sticky_quota 调度器**，
状态由任务内实时调用的 `nvidia_quota_status` 回读。overlay 固件见 `tests/e2e/`（无密钥）。

**前置证据（零 API 消耗）**：

- `/api/nvidia-router.status`（认证同源）：`keyCount 4 / totalKeys 4 / configured 4 /
  health yellow / 各 Key sent 0`——设置页保存链路端到端可用，路由器尚无流量。
- 目录 24 模型复测一轮（probe，≈22s，max_tokens:1，并发 6）：**可用 12**
  （`z-ai/glm-5.3-flash` 398ms）、TIMEOUT 9（含 `z-ai/glm-5.3`、`moonshotai/kimi-k3`、
  `deepseek-ai/deepseek-v4.1-flash`——按防误杀规则保留「未确定」）、SERVER 3（500/503，保留）。

**首验清单逐项（README 五项全过）**：

| # | 项 | 任务 | 实测证据 |
|---|---|---|---|
| 1 | 流式对话 + 状态 ok+1 | "只回复两个字：成功" | stdout `成功`、exit 0——完整链路（调度预留→适配器→真实端点 SSE→流回）真机可用 |
| 2 | 工具调用 + 后续请求计数 | bash echo + 状态工具 | `ROUTER_E2O_OK` 往返正常；快照 `reserved 2 / Key-1 窗口 2 / ok 1`（标题已结算、规划步在途），后续请求完成 |
| 3 | 子智能体统一计数 | subagent 委派 + 状态 | 子智能体原话「子任务完成」；**Key-1 窗口 5** = 主智能体与子智能体请求合计（同一 ctx.llm 同一调度器） |
| 4 | 阈值 2 粘性切换（低频） | 三次 echo + 状态（safeThreshold:2 overlay） | **sticky switches 2**；窗口分布 2/2/1/0 精确等于 reserved 5；**Key-1/2/3 都真实服务成功**（ok 2/2/1）；零 all-unavailable 事件 |
| 5 | stream_options.include_usage | 隐含于 1–4 | 全部流式请求无 400（若端点拒绝会 fail-loud） |

- 会话标题 LLM 请求同样计入调度器（任务 2 的 `ok 1` 先于 agent 步骤——标题请求先结算），
  印证「标题/压缩等辅助请求统一入口」。
- 修复后状态工具在真实智能体内正常工作（渲染文本块，无无损 JSON 报错）。

**本轮暴露并修复的缺陷（首验第一跑即抓到，用户 GUI 首次走路由器前被拦下）**：

1. `prepareCall is not a function`：适配器未继承 `LlmAdapter` 基类，请求准备期方法缺失
   （web Host 从未有路由器流量，路径从未执行）。修复：`extends LlmAdapter` + `super()`。
2. `nvidia_quota_status` 一调即 `value is not lossless JSON`：`snapshot()` 输出
   `lastFailure: undefined`/`activeKey: undefined`。修复：缺席字段省略属性；
   回归用 harness 真实 `isJsonValue` 断言三种状态（旧测试 `JSON.stringify` 测不出此类违规）。

**迁移决策的实证输入**：`z-ai/glm-5.3`（当前 pi-ai 默认模型）在 10s 探测预算下 TIMEOUT
（保留未确定；适配器真实流式预算 `requestTimeoutMs=120s`，仍可能可用但慢）；
`z-ai/glm-5.3-flash` 已验证可用且 398ms——迁移目标建议优先 flash 档。

## 用户 GUI 实证 + 免重启修复（2026-10-15 10:03–11:41，非模拟）

- **10:03 用户实测撞上缺陷一**：模型列表切到插件模型发消息 →
  `本轮运行失败 registration.adapter.prepareCall is not a function`——与 headless 首验
  第一跑的发现一致（运行中进程持修复前模块代）。
- **11:0x 启用模块根 HMR**（免重启修复的根基）：profile patch 追加 `hmr` 行
  （`root: [bundle 目录]`，备份 `.bak-hmr-root-20261015`）→ config-HMR 即时生效。
  **实证**：Host 进程 inotify watch 表（`/proc/<pid>/fdinfo/<fd>`）中出现 bundle 目录
  与 adapter.js 的 inode（十进制→十六进制换算后匹配）。
- **11:32 原地重写 adapter.js**（内容不变，`cp` 两跳触发 IN_MODIFY；纯 `touch` 不触发
  chokidar change）→ dsh-hmr `partialReload()` 以修复后模块重建插件 fiber
  （管线逐环核验：loadCache realpath 两侧一致、`EntryNamespaces.resolve` 用 loadCache URL
  而非重解析——符号链接不构成障碍）。
- **11:41 用户重试成功**（对话模型 `nvidia-router / z-ai/glm-5.3-flash` 正常回复）；
  随后 `/api/nvidia-router.status` → **health green，Key-1 sent 2 / ok 2，4 Key 全部可用**。
- 结论：**真机全链路（GUI 会话 → 调度器 → 适配器 → 真实端点）已通且在用**；
  Host 半改动从「必须重启」升级为「原地重写即热生效」。

## 未测试 / 待真机验证（如实记录）

1. **真实 NVIDIA API 的少数细节**：SSE 字段/流式协议、`stream_options.include_usage` 接受度、
   模型目录与发现已由 2026-10-15 真机首验覆盖（见上节）；**尚未观察到**：真实 429 的
   `Retry-After` 头格式（本轮零 429）、`x-request-id` 头、`z-ai/glm-5.3` 在 120s 流式预算下
   的真实可用性（探针 10s 预算下超时，保留「未确定」）。下次真实 429 出现时顺带核对即可。
2. **Web GUI 渲染的剩余项**：设置页已由用户实际使用证实（存 4 Key、目录裁剪均经它完成）；
   尚待用户顺带确认的只有**对话页右上角健康徽标**（数量 + 红黄绿，15s 轮询）的呈现——
   其数据源 `/api/nvidia-router.status` 已实测 200 且判定逻辑有 wiring 自动化覆盖。
3. **插件页行“配置”按钮**：备用入口，Host 侧链路核验无缺陷（见 2026-10-14 小节）；
   主入口（设置页）已证实可用，此按钮仅在有浏览器报错证据时再查。
4. **多进程子智能体**（ACP/Codex/dsh-sdk child）明确不在覆盖范围（设计边界，见 TECHNICAL_DESIGN.md §7）。

## 实机安装验证（2026-10-14 04:22–04:45，非模拟）

在运行中的 web profile 上实际执行并观察：

- `plugin_manager install_bundle`（target=bundle 绝对路径）：pnpm v12.11.2 链接成功
  （`+ @local/dsh-llm-nvidia-router <- ../../../../../vol2/1000/deepseek harness/项目/nvidia-smart-quota-router/bundle`）；
  首次激活 `application: failed`，错误 `configurable provider "nvidia" is already declared`
  （pi-ai 占用 `nvidia` 目录）——失败被插件 fiber 隔离，未影响宿主与其他 provider。
- 修复（默认路由 id → `nvidia-router`：bundle 代码 + profile 行覆盖；patch 先备份）后，
  config-only HMR 自动重组：**激活成功**。证据：
  - `cordis_inspect_query Tool.listTools`：`nvidia_quota_status` 工具出现在运行中 Host 工具目录
    （apply() 按目录→发现→adapter→工具顺序注册，工具在末位）；
  - `cordis_inspect_query Config.listConfigs`（name=@local/dsh-llm-nvidia-router）：
    返回 `include:llm-nvidia-router`，status=schema，17 个配置字段全部可查。
- 该验证证明的是**插件加载与注册链路**；provider 的请求路径（stream/调度）仍以 mock 测试为准，
  真机请求待 Key。

## 失败记录与修复历史（保留审计）

- 2026-10-13 首轮 adapter 测试 8 项失败，根因：`contentText` 未跳过 assistant 历史中的 tool-call/reasoning 块（代码缺陷，已修）；mock `drop` 立即销毁 socket 导致已写数据未送达（fixture 缺陷，已修）；若干断言与粘性/恢复语义不符（测试缺陷，已修）。
- 停滞超时最初仅覆盖流读取，不覆盖 fetch 阶段（代码缺陷）→ 新增 `requestTimeoutMs` 配置与 fetch 截止（dsh-timeout `deadline`）。
- 超时/传输错误后粘性锚点不前移，导致重试落回同一 Key（设计缺陷）→ 新增 `advanceStickyPast`。
