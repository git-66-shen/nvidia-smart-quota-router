# PROJECT_STATUS — NVIDIA Smart Quota Router

上次更新：2026-10-15 09:4x (Asia/Shanghai)

## 项目目标与当前阶段

为 DSH 开发 NVIDIA API 智能调度插件（sticky_quota 多 Key 粘性配额路由），
主/子智能体请求统一计数、有限故障转移、密钥零泄漏，并以持久化文件跨对话推进。

**当前阶段：真机全链路已通且用户 GUI 在用**（health green，Key-1 sent 2/ok 2）；
两个活缺陷已修复并经 headless e2e + 用户 GUI 双重实证；**Host 半改动已免重启**
（profile patch `hmr` 行开启模块根 watch，原地重写即热生效）。剩余仅可选决策：
是否把 `agent-default-model` 默认也切到本路由（用户已可按会话随时选用插件模型）。

## 已完成的功能（全部有验证证据）

1. 架构检查（阶段 0）：运行方式、模型调用唯一入口 `ctx.llm`、进程内子智能体共享同进程、
   重试边界、bundle 分发/导入解析、GUI 接入、密钥读取规范——结论与出处见 TECHNICAL_DESIGN.md §1。
2. 调度核心（阶段 1）：粘性选择、60s 滚动窗口、38/窗口本地安全阈值、同步原子预留、
   429/认证/配额冷却、全不可用有界等待、幂等 Lease 上报、超时后粘性锚点前移。
3. 适配器（阶段 1）：OpenAI 兼容序列化与 SSE 翻译、流式+工具调用全协议义务、
   首块前有限故障转移（默认 2 次）、两级超时、取消语义（发送前释放/已发送保留）。
4. 接线（阶段 1）：provider 路由 + Models 页可配置目录 + 端点模型发现 + 脱敏状态工具。
5. 自动化测试（阶段 2）：**69 项，全部通过**（`pass 69 / fail 0`，模拟端点，零真实 API 消耗），
   命令 `sh tests/run.sh`，结果详见 TEST_REPORT.md。
   （曾有一个 `windowCount 1 !== 0` 的间歇性失败，2026-10-14 深夜**已定位并修复**——实为
   `QuotaLease` 重复读时钟导致的**预留泄漏**真实缺陷，见下第 10 项。）
6. 安装接入（阶段 3）：bundle 已链接进 `web` profile 并**激活成功**（路由 id `nvidia-router`）。
   实测发现并修复了与 pi-ai 的 `nvidia` 目录冲突；profile patch 追加行已备份；
   验证证据：`nvidia_quota_status` 工具已注册进运行中 Host 工具目录 + 插件行 schema 可查
   （TECHNICAL_DESIGN.md §8 实录）。用户现有 pi-ai/deepseek 配置零改动。
7. 客户端配置界面（2026-10-14，两轮）：第一轮 `plugins.row.config` 行按钮在用户浏览器未出现
   （Host 侧已排除，见 TEST_REPORT）；第二轮按用户决定改为**设置里的独立配置页**
   （`settings.section`，与 通用/模型/插件 并列），并保留行按钮为备用入口；
   Key 表无行数上限且文案明示。改版经 boot graph/bundle/热加载三重活体验证。
8. 动态模型目录 + 模型探测 + 健康徽标（2026-10-14 第三轮，按用户新需求）：
   - **模型目录动态化**：端点目录经 `ctx.remote.llm.discoverModels` 拉取，只读展示、
     存 Key 后自动刷新；客户端移除“手动添加模型”入口；`config.js` 放开空目录校验。
   - **配置页「测试所有模型」按钮**：Host 新增精确 fetch 路由 `POST /api/nvidia-router.probe`
     逐模型最小 completion 探测（并发 3、20s 超时），返回 id/成败/状态码/延迟，不含密钥；
     配置页逐行显示绿/红圆点 + 延迟与「可用 N/M」。
   - **对话头部健康徽标**：Host 新增 `GET /api/nvidia-router.status`（脱敏快照 + `computeHealth` 判定），
     客户端注册 `conversation.session.header.utilities`（id `nvidia-router-health`, order 30），
     显示已配置 Key 数与红/黄/绿圆点，15s 轮询。
   - 验证：`node --check` 全通过；**68 项回归**（wiring 由 9 → 15 项，覆盖两路由、判定纯函数与 429 上抛）；
     槽位契约对照 DSH 源码核对（list/scope/session，选项形状与既有插件一致）。浏览器内呈现待用户确认。
9. 动态目录「只保留免费可用」+ 发现失败修复（2026-10-14 深夜，按用户实测反馈）：
   - **修 `needs a provider route or a baseURL`**：根因是 `LlmRuntime.discoverModels`
     在派发给插件回调**之前**就要求 `provider`/`baseURL` 至少一个非空，而 Config 的 `baseURL`
     无默认值（刻意，保住 `NVIDIA_BASE_URL` 回退）→ 客户端 `discover()` 改为**三级兜底**
     （draft → 已保存 → 官方默认），请求体永远带非空 baseURL。
   - **回答“为什么是 80 个”**：匿名 curl 实测 `GET /v1/models` 返回 **200 / 恰好 80 条**，
     字段仅 `id/object/created/owned_by`，**无免费标记**，且混入 embed/rerank/安全/视觉/解析等
     非对话模型 → **“当前免费可用”只能实测**。
   - **实现**：`discover()` = 拉全量 → 自动实测 → 按裁决裁剪；裁剪只移除
     `400/401/402/403/404`，**429 与 5xx/超时保留为“未确定”**；新增「恢复全部模型」/「仅保留可用」；
     `routes.js` 并发 3 → 6；新增 wiring 测试（429 上抛）。
10. 配额预留泄漏修复（2026-10-14 深夜，测试中发现并确证，**真实缺陷**）：
   - **症状**：偶发 `windowCount 1 !== 0`（`adapter.test.js:406` / `:540`），约每 2–3 次全量运行 1 次。
   - **根因**：`QuotaLease` 构造时**再次调用 `clock()`** 作为 `reservedAt`，而非
     `#tryAcquire` 实际压入窗口的 `now`。真实 `Date.now()` 可能在这两步之间跨 1ms →
     `release()` 的 `window.lastIndexOf(this.reservedAt)` 落空 → **静默跳过 splice，预留永久泄漏**。
   - **影响**：线上窗口计数只增不减 → 误判 Key“已达安全阈值/冷却中” → 提前抛 `RATE_LIMIT`
     （“所有 Key 不可用”），与多 Key 可靠路由的核心目标冲突。
   - **修复**：`bundle/scheduler.js` — `reservedAt: now` 由 `#tryAcquire` 直接传入，构造器不再读时钟。
   - **回归**：`tests/scheduler.test.js` 新增确定性用例（注入每次 +1 的时钟）；测试 67 → **68**。
   - **验证**：修复后连续 5 次全量运行 `pass 68 / fail 0 / rc=0`（现已随 wiring 16 增至 **69**）。
11. 真机「测试未能执行 (HTTP 404)」修复（2026-10-14 23:46，**三重根因**）：
   - **主因：两条 fetch 路由从未注册**。模块级 `export const inject = ['llm']` **不含 `connection`**，
     而 `registerConnectionRoutes` 在 `apply()` 里**急切**读 `ctx.get('connection')`；浏览器连接通道是
     **独立 boot 行**，那一刻尚未 ACTIVE → 读到 `undefined` → 两条 `ctx.connection.fetch.register`
     **一条都没执行**。未注册的 `/api/*` 精确路由在**认证通过后**返回 **404**（未认证才是 401）→
     客户端红字「测试未能执行 (HTTP 404)」，且 80 个模型**一个都没被判定**（`可用 0/80 · 已移除 0 ·
     保留 80 (未确定 80)`——全按“未确定”保留本身是裁剪规则的正确行为）。
     修复：`ctx.inject(['connection'], (connectionCtx) => { … })` **作用域等待**（DSH 官方惯用法，
     见 `packages/bundle/web-app/src/index.ts:268`、`file-upload`、`session-log-export`）；
     **不**把 `connection` 加进模块级 `inject`（那会连 provider 一起挂到浏览器通道上）。
   - **`UNUSABLE_STATUSES` 补 `410`**：NVIDIA 对已下线(retired)模型返回 410 Gone，旧表只到 404。
   - **探测超时改「逐模型独立」**：原整批共享 `AbortSignal.timeout(20s)`，慢模型吃满预算后
     后面的全被截断误判 TIMEOUT（一轮 80 个里误杀 **44 个**）；现每模型 10s、并发 6，
     超时仍记「未确定」。
   - 测试：`fakeContext` 补 `inject(names, callback)` 语义（与真实 Cordis 同构，否则旧的急切读法会掩盖此缺陷）；
     `sh tests/run.sh` → **69 项全通过**（wiring 16）。
   - 实证（非推测）：pid 1681424（23:46:51 启动，晚于 `routes.js` mtime 23:46:40）下，认证同源
     `GET /api/nvidia-router.status` → **200** `{"keyCount":4,"totalKeys":4,"health":"yellow",…}`；
     `POST /api/nvidia-router.probe`（`{"models":["definitely/not-a-model"]}`）→ **200**
     `{"ok":false,"status":404,"error":"HTTP_404","latencyMs":527}`。
   - 全量 80 模型一轮端到端实测：≈**182s**；`ok=10 / 404=55 / TIMEOUT=10 / 500=2 / 503=2 / 400=1`
     → **可用 10 / 已移除 56 / 保留 24（未确定 14）**。

12. **真机首验 5/5 + 两个活缺陷修复（2026-10-15 凌晨，本轮）**：
    - 用户已配置 4 Key（设置页保存链路实证可用：`/api/nvidia-router.status` →
      `keyCount 4 / configured 4 / health yellow`）。
    - **缺陷一**：适配器未继承 `LlmAdapter` 基类 → 请求准备期 `prepareCall is not a function`
      （web Host 从未有路由器流量，路径从未执行——首验第一跑即抓到）。修复：
      `extends LlmAdapter` + `super()`，继承默认 `prepareCall`/`imageRequestPricing`。
    - **缺陷二**：`nvidia_quota_status` 一调即报 `value is not lossless JSON`——`snapshot()`
      对从未失败的 Key 输出 `lastFailure: undefined`（工具管线判 `undefined` 非无损）。
      修复：缺席字段省略属性 + `isJsonValue` 三态回归。
    - **headless e2e 方法**（可复用）：`dsh --profile headless --patch tests/e2e/*.yml "<task>"`，
      凭据读全局 `~/.dsh/.credentials.yaml`；headless profile 已加本包 bundle 行与 node_modules 链接。
    - **README 首验清单 5/5**：流式对话、工具调用+后续计数、子智能体统一计数（Key-1 窗口 5）、
      阈值 2 粘性切换（switches 2、分布 2/2/1/0=reserved 5、Key-1/2/3 真实服务）、stream_options 无 400。
    - 目录 24 模型复测：可用 12（`z-ai/glm-5.3-flash` 398ms）；`z-ai/glm-5.3` 探测超时（保留未确定）。
    - 回归：`sh tests/run.sh` → **70/70**。

## 正在处理的任务

- 无进行中任务。GUI 已可用插件模型正常对话（health green）；健康徽标应显示 4+绿点（用户顺带确认即可）。

## 未完成任务和阻塞原因

- **可选决策（用户）**：是否把 `agent-default-model` 默认也切到 `nvidia-router`
  （README「迁移到本路由」；必须删除 `reasoningEffort: high`；建议模型 `z-ai/glm-5.3-flash`）。
  现状：按会话在模型列表里选用插件模型已实测可用，迁移只影响「新会话默认」。
- 插件页行按钮（备用入口）：主入口（设置页）已证实可用，仅在有浏览器报错证据时再查。
- Git：**独立仓库已建立**（2026-10-15）——`git init`（master）、首次提交 `5a800c0`（33 文件）、
  附注标签 `v0.1.0`；泄密终检通过。后续改动按常规提交即可。

## 已知缺陷

- 无已知实现缺陷；已知边界（非缺陷）见 TECHNICAL_DESIGN.md §7 与 README「约束与边界」。

## 最近一次实际测试结果

- 2026-10-15 08:5x：`sh tests/run.sh` → **tests 70 · pass 70 · fail 0**（≈2.6s）。
- 2026-10-15 09:1x–09:3x：**真机首验 5/5**（headless e2e，4 Key，真实端点，
  低频短任务——实录见 TEST_REPORT.md「真机首验」）。
- 2026-10-15 11:41：**用户 GUI 实证**——切插件模型发消息成功；`/api/nvidia-router.status`
  → **health green / Key-1 sent 2 / ok 2**（免重启修复实录见 TEST_REPORT.md 对应小节）。

## 最近一次成功运行的验证命令

```sh
sh tests/run.sh
# node --import tsx/esm --test "项目/nvidia-smart-quota-router/tests/"
# Node v26.10.0, cwd=/vol2/1000/deepseek harness
```

## 最近修改的文件

- 实现：`bundle/{index,config,scheduler,errors,wire,adapter,status}.js`、
  **`bundle/routes.js`（模型探测 + 健康状态两条客户端 fetch 路由；2026-10-14 23:46 改为
  `ctx.inject(['connection'], …)` 作用域等待注册 + 逐模型 10s 独立超时）**、
  **`bundle/client.js`（设置独立页 `settings.section` + 保留插件页行按钮；动态模型目录 +
  「测试所有模型」按钮 + 对话头部健康徽标；2026-10-14 23:41 裁剪表补 `410`）**、
  `bundle/config.js`（放开空目录校验）、
  `bundle/{package.json(+dsh.client),cordis.patch.yml,locale/*.json,icon.svg}`
- 测试：`tests/{run.sh,mock-nvidia-server.js,scheduler.test.js,adapter.test.js,errors.test.js,security.test.js,wiring.test.js}`（wiring 16 项；security 6 项含**快照无损三态回归**）、
  **`tests/e2e/{route-default,sticky-threshold}.yml`（headless e2e overlay 固件，无密钥）**、
  `tests/scan-repro.mjs`（Host 侧扫描复现脚本，诊断用）
- 文档：全部 8 个（README/TECHNICAL_DESIGN/TASK_CHECKLIST/PROJECT_STATUS/TEST_REPORT/CHANGELOG/HANDOFF/CONFIG.example.yaml）
- 外部：`~/.dsh/profiles/web/cordis.patch.yml`（用户层，本轮零改动）；
  **`~/.dsh/profiles/headless/`（e2e 用：模板初始化 + 本包 bundle 行与 node_modules/@local 链接）**

## 下一步最应该执行的一个具体任务

**重启 web 进程**（HANDOFF.md 有确切命令与核对步骤）加载两个 Host 半修复，然后：
用户决定是否迁移 `agent-default-model → nvidia-router / z-ai/glm-5.3-flash`
（README「迁移到本路由」三步，删 `reasoningEffort`）；迁移后本会话流量即全部经调度器，
`nvidia_quota_status` 与右上角健康徽标应转绿。

## 恢复开发时必须注意的事项

1. Node 不在 PATH：用 `/vol1/@appdata/trim.hermes/旧hermes配置文件/node/bin/node`（v26.10.0）；
   测试一律从检出根跑（`sh tests/run.sh`）。
2. bundle 是纯 JS（无构建步骤）；**改 `bundle/client.js` 不需要重启 DSH**——
   `dsh-client-hmr` 每 500ms 轮询 bundle 文件并经 SSE 推送新代；**改 Host 半
   （index/config/scheduler/adapter/errors/wire/status/routes）必须重启 web 进程**。
3. `plugin_manager` 的安装结果以 `application` 字段为准，不看日志推断。
4. 不要在真实 NVIDIA 端点上做高频限额探测；真机验证按 README 清单低频执行。
5. 密钥只能经 credentials 服务或启动环境提供，绝不写入配置文件/源码/Git。
6. 诊断捷径：`curl -sN http://<host>:<port>/plugins/events` 的 SSE 首帧就是完整 boot graph
   （无需认证）；bundle 按 `rev`（文件 mtime/ctime/size 的 sha1 前 12 位）可直接 GET 验证。
7. **headless e2e 是真机验证的既定方法**：`dsh --profile headless --patch tests/e2e/*.yml "<task>"`；
   headless profile（~/.dsh/profiles/headless）已接好本包（bundle 行 + node_modules 链接）；
   凭据读全局 `~/.dsh/.credentials.yaml`；`DSH_PERMISSION_MODE=danger-full-access` 避免审批挂起。
