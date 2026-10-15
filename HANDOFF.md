# HANDOFF — NVIDIA Smart Quota Router（给下一个 DSH 对话窗口）

上次更新：2026-10-15 22:0x (Asia/Shanghai)。恢复步骤：先读 PROJECT_STATUS.md →
TASK_CHECKLIST.md → TECHNICAL_DESIGN.md → TEST_REPORT.md，再从下面「下一步」继续。

## 当前项目阶段

**真机全链路已通且用户 GUI 在用**：用户把会话模型切到 `nvidia-router / z-ai/glm-5.3-flash`
发消息正常回复；`/api/nvidia-router.status` 显示 **health green、Key-1 sent 2/ok 2**、
4 Key 全部可用。两个活缺陷（适配器缺 `prepareCall`、快照非无损 JSON）已修复并经
headless e2e + 用户 GUI 双重实证；自动化 70/70。

**重要机制变更（2026-10-15，免重启修复的根基）**：profile patch 新增 `hmr` 行覆盖
（`root: ['/vol2/1000/deepseek harness/项目/nvidia-smart-quota-router/bundle']`，
备份 `cordis.patch.yml.bak-hmr-root-20261015`）——dsh-hmr 的**模块根 watch** 现已启用。
**Host 半改动（index/config/scheduler/adapter/errors/wire/status/routes）从此免重启**：
watcher 触发 → loadCache 命中（realpath 两侧一致）→ `partialReload()` → 插件 fiber
以新模块代重建。实证链：配置热应用（inotify watch 表里有 bundle 目录与 adapter.js 的
inode）→ 原地重写 adapter.js（内容不变，`cp` 两次经过以真正触发 IN_MODIFY——纯 `touch`
不可靠）→ 用户重试即成功（10:03 报错 → 11:32 触发 → 11:41 用户确认成功）。
**代价**：fiber 刷新会重置调度器计数（与重启语义一致，TECHNICAL_DESIGN §3.6 已记录）。

## 上一轮实际完成了什么（2026-10-15 凌晨–上午）

1. **状态核对（零消耗）**：`/api/nvidia-router.status`（认证 curl，token 在 `/home/liang/dsh-web.log`
   最后一行）→ `keyCount 4 / configured 4 / health yellow / 零流量`——用户 4 Key 经设置页保存成功。
2. **缺陷一（真机首验第一跑即暴露）**：headless 首个任务报
   `registration.adapter.prepareCall is not a function`——`LlmRuntime` 请求准备期调用
   `prepareCall`（`packages/llm/llm/src/index.ts:941/1053`），而 `NvidiaRouterAdapter`
   是未继承 `LlmAdapter` 基类的鸭子类型类。web Host 从未有路由器流量，此路径从未执行——
   **用户 GUI 首次切到插件模型就会撞上**（10:03 用户实测撞上，与本预测一致）。
   修复：`bundle/adapter.js` `extends LlmAdapter` + 构造器 `super()`
   （生态既定模式：DeepSeek/PiAi 同）。
3. **缺陷二**：`nvidia_quota_status` 工具一调即报 `value is not lossless JSON`——
   `bundle/scheduler.js` 的 `snapshot()` 给从未失败的 Key 输出 `lastFailure: undefined`、
   零 Key 时输出 `activeKey: undefined`；工具管线的 `walkJsonValue` 把 `undefined` 值判为
   非无损（`null` 合法、`undefined` 不行；`JSON.stringify` 静默丢弃所以旧测试测不出）。
   修复：**缺席字段省略属性**（条件展开）；新增回归用 harness 真实 `isJsonValue` 断言三态
   （全新表/失败后/空表）。测试 69 → **70**。
4. **headless 全栈 e2e（真机首验方法，可复用）**：
   `cd "/vol2/1000/deepseek harness" && DSH_PERMISSION_MODE=danger-full-access \
    /home/liang/.local/bin/node --import tsx/esm apps/cli/src/bin.ts \
    --profile headless --patch "项目/nvidia-smart-quota-router/tests/e2e/route-default.yml" "<task>"`
   - headless profile（`~/.dsh/profiles/headless`，模板初始化）已接本包：
     `package.json` 的 `dsh.profile.bundles` 与 `dependencies` 各加一行 +
     `node_modules/@local/dsh-llm-nvidia-router` 符号链接（镜像 web profile 接法）。
   - 凭据读**全局** `~/.dsh/.credentials.yaml`（4 Key 全部可解析）。
   - overlay 临时覆盖 `agent-default-model → nvidia-router / z-ai/glm-5.3-flash`
     （整行替换语义，天然无 `reasoningEffort`），**不触碰用户 profile**。
   - 固件：`tests/e2e/route-default.yml`、`tests/e2e/sticky-threshold.yml`（另设 safeThreshold:2）。
5. **README 首验清单 5/5 通过**（实录见 TEST_REPORT.md「真机首验」）：
   ①流式对话 stdout `成功`；②bash 工具往返 + 后续请求计数（快照 `reserved 2 / ok 1`，
   标题请求先结算——辅助请求统一入口实证）；③子智能体统一计数（Key-1 窗口 5）；
   ④阈值 2 粘性切换（switches 2、分布 2/2/1/0 = reserved 5、Key-1/2/3 真实服务成功）；
   ⑤stream_options.include_usage 全程无 400。
6. **目录 24 模型复测一轮**（probe 路由，≈22s）：**可用 12**（`z-ai/glm-5.3-flash` 398ms 最快档）、
   TIMEOUT 9（含 **`z-ai/glm-5.3`**（用户原默认模型）与 kimi-k3、deepseek-v4.1-flash——
   按防误杀规则保留「未确定」；适配器真实流式预算 `requestTimeoutMs=120s`，仍可能可用但慢）、
   SERVER 3（500/503，保留）。**迁移建议模型：`z-ai/glm-5.3-flash`**。
7. **用户 GUI 实证（10:03–11:41）**：切模型发消息报 `prepareCall` 错（旧进程持修复前模块代）→
   启用 hmr 模块根（见上）→ 原地重写 adapter.js → 用户重试**成功**；
   `/api/nvidia-router.status` → **health green / Key-1 sent 2 ok 2**。
   回归：`sh tests/run.sh` → **70/70**（≈2.6s）。

## 下一步（按序）

1. **无阻塞待办**。可选决策：是否把 `agent-default-model` 也切到
   `nvidia-router / z-ai/glm-5.3-flash`（README「迁移到本路由」；**必须删除 `reasoningEffort: high``**）。
   现状：用户可随时在模型列表里按会话选择插件模型（已实测可用），迁移只是改「新会话默认」。
2. 用户顺带看一眼对话页右上角健康徽标：现在应显示 **4 + 绿点**（15s 轮询）。
3. ~~评估为本项目目录 `git init` + 打 v0.1.0 标签~~ **已完成（2026-10-15）**：独立仓库
   已建立（master 分支，首次提交 `5a800c0`，附注标签 `v0.1.0`，仓库本地身份
   `liang <liang@localhost>`）。后续改动照常 `git add/commit` 即可；
   改动 Host 半文件后记得原地重写触发模块热重载（见约束区）。

## 真实端点未核对项（很小，顺带即可）

- 真实 429 的 `Retry-After` 头格式与 `x-request-id` 头：本轮真机零 429，未观察到；
  下次真实 429 出现时从日志核对即可。
- `z-ai/glm-5.3` 在 120s 流式预算下的真实可用性（探针 10s 超时、保留未确定）。

## 不应该重复做的工作 / 不可破坏的约束

- **不要重写调度/适配器**（70 项测试通过 + 真机 e2e + GUI 实证）；改动后 `sh tests/run.sh` 全量回归。
- **适配器必须继承 `LlmAdapter`**（`@deepseek-ai/dsh-llm`）：请求准备期走基类 `prepareCall`
  的同代绑定；构造器必须先 `super()`。不要改回鸭子类型裸类。
- **推理档位（2026-10-15 起）**：目录条目 `efforts`/`defaultEffort` 是部署知识（端点列表
  不含该元数据）；档位校验与缺省物化由运行时 `resolveCallWithInfo` 统一负责，适配器
  **不要**再加自己的 effort 守卫；线协议由 `reasoningEffortParam` 决定（默认 none =
  pi-ai 对该端点的已验证行为；`reasoning_effort` 供确实接受的端点）。客户端目录重建
  必须保留已保存条目的档位（发现/裁剪不得覆盖）。
- **`snapshot()` 永远不输出 `undefined` 值**（缺席字段省略属性）：工具管线判非无损
  （`undefined`/`Infinity`/`-0` 都不行）；回归测试用 `isJsonValue`，别用 `JSON.stringify` 断言。
- **预留时间戳不可重复读取**：`QuotaLease.reservedAt` 必须用 `#tryAcquire` 传入的 `now`
  （构造器再读时钟会跨毫秒 → `release()` 落空 → 预留永久泄漏；已有确定性回归用例）。
- **discoverModels 契约**：`LlmRuntime` 在派发回调**之前**即要求 provider/baseURL 非空；
  客户端 `discover()` 必须永远带非空 baseURL（三级兜底，`DEFAULT_BASE_URL` 不可删）。
- **client→host 只走 `bundle/routes.js` 的精确 Fetch 路由**；注册必须用
  `ctx.inject(['connection'], …)` 作用域等待（急切读会拿到 undefined → 路由静默不存在）；
  **不要**把 `connection` 加进模块级 `inject`。
- **模型目录动态只读**；裁剪只移除 `400/401/402/403/404/410`，429/5xx/超时一律保留「未确定」；
  空裁剪结果不写回配置（自锁）；保留「恢复全部模型」；不引入硬编码免费清单。
- **热更规则（2026-10-15 起，含本次新机制）**：`bundle/client.js` 走 client-hmr 500ms 轮询；
  **Host 半改动走 dsh-hmr 模块根 watch（profile patch `hmr` 行，root=bundle 目录）**——
  改完文件**原地重写**（`cp a.js /tmp/x && cp /tmp/x a.js`；纯 `touch` 不可靠）即自动热重载，
  无需重启；代价是插件 fiber 重建、调度器计数清零（与重启语义一致）。
  免重启失效的场景（回到重启）：改动 `package.json`（manifest 级）、`cordis.patch.yml`、
  profile 组合/依赖结构。
- 不要动用户 profile patch 里的既有行（ui-settings-general / llm-pi-ai / agent-default-model）；
  本项目追加过两行：`llm-nvidia-router`（备份 `.bak-nvidia-router-20261014`）与
  `hmr`（备份 `.bak-hmr-root-20261015`）。
- 不要把真实 Key 写入任何文件/日志/Git/对话；密钥只经 credentials 服务或启动环境
  （全局存储 `~/.dsh/.credentials.yaml`，不要打印其内容）。
- 不要对真实 NVIDIA 端点做高频限额测试；尊重 Retry-After 与服务端限流。
- Node 不在 PATH：用 `/vol1/@appdata/trim.hermes/旧hermes配置文件/node/bin/node`
  （或已修复的 `/home/liang/.local/bin/node`）；测试以检出根为 cwd。
- bundle 行 id 固定 `llm-nvidia-router`、路由 id `nvidia-router`；设置页 section id
  `nvidia-router`、order 16；头部徽标 id `nvidia-router-health`、order 30。
- 状态输出/日志只允许脱敏标签（Key-1…/env 引用名）；security.test.js 回归。
- 诊断捷径：`/plugins/events` SSE 首帧 = boot graph（免认证）；bundle 按 rev 直接 GET；
  `/api/nvidia-router.*` 两路由在鉴权门后（未认证 401，认证后已注册 200/未注册 404），
  认证用日志最后一行的带 token URL + cookie jar。
