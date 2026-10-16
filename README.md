# NVIDIA Smart Quota Router（DSH NVIDIA API 智能调度插件）

为 DeepSeek Harness（DSH）提供 NVIDIA API 模型接入与多 API Key 粘性配额调度：
主智能体与进程内子智能体的每一次模型请求都先经同一个 sticky_quota 调度器原子预留额度，
当前 Key 在本地安全阈值内持续使用，接近阈值才切换下一个 Key；429 按服务端提示冷却；
全部 Key 不可用时退避并给出可诊断错误——而不是逐请求轮询或无限重试。

状态：**核心实现完成，75 项模拟测试全部通过；真机首验 5/5 通过（2026-10-15，4 Key headless e2e）；已安装进 web profile**。
当前真实进度见 PROJECT_STATUS.md；恢复开发先读 HANDOFF.md。

## 目录结构

```
nvidia-smart-quota-router/
├── bundle/                  # 可安装的 DSH bundle（纯 ESM JS，零依赖）
│   ├── index.js             # apply()：注册 provider/目录/模型发现/状态工具/连接路由
│   ├── config.js            # Config schema + 显式解析校验（全部参数可调；模型目录可为空）
│   ├── scheduler.js         # sticky_quota 调度器（滚动窗口/原子预留/冷却/统计）
│   ├── adapter.js           # LLM 适配器：流式/工具调用/有限故障转移
│   ├── wire.js              # OpenAI 兼容序列化 + SSE 流翻译
│   ├── errors.js            # HTTP/传输错误分类（对齐 dsh-llm 码表）
│   ├── status.js            # nvidia_quota_status 只读诊断工具
│   ├── routes.js            # 客户端 fetch 路由：模型探测 + 脱敏健康状态
│   ├── client.js            # 客户端半体：设置页/行按钮/模型探测/头部健康徽标
│   ├── cordis.patch.yml     # bundle 补丁（插入插件行）
│   └── locale/{en,zh}.json, icon.svg
├── tests/                   # 68 项自动化测试 + 可控 mock 端点
│   ├── run.sh               # 测试入口
│   └── *.test.js
├── CONFIG.example.yaml      # 完整配置样例（无任何真实 Key）
├── TECHNICAL_DESIGN.md      # 架构检查结论、调度流程、技术决策
├── TASK_CHECKLIST.md        # 任务分解与真实状态
├── PROJECT_STATUS.md        # 当前阶段/完成/阻塞/下一步
├── TEST_REPORT.md           # 实际执行的测试命令与结果
├── CHANGELOG.md             # 重要变更记录
└── HANDOFF.md               # 交接说明
```

## 安装（已完成 · 2026-10-14 实录）

本插件**已安装进运行中的 `web` profile 并已激活**（route id `nvidia-router`）：

- 包链接：`/home/liang/.dsh/profiles/web/node_modules/@local/dsh-llm-nvidia-router` → 指向本目录 `bundle/`；
- profile 覆盖：`~/.dsh/profiles/web/cordis.patch.yml` 末尾新增了 `llm-nvidia-router` 行
  （设置 `provider: nvidia-router`、`providerName: 'NVIDIA (Quota Router)'`）；
  **修改前备份**：`~/.dsh/profiles/web/cordis.patch.yml.bak-nvidia-router-20261014`；
- 为什么叫 `nvidia-router`：基础 profile 的 `llm-pi-ai` 插件把 pi-ai 内置目录（含 `nvidia`）
  全量声明为可配置 provider，且你当前正在用 pi-ai 的 `nvidia` 路由（单 Key + `z-ai/glm-5.3`），
  `nvidia` 这个路由 id 已被占用（DUPLICATE_DIRECTORY），故本插件默认取 `nvidia-router`
  （`provider` 字段可改；若将来移除 pi-ai 的 nvidia profile，可改回 `nvidia`）；
- 验证证据：`nvidia_quota_status` 工具已出现在运行中 Host 的工具目录
  （apply() 顺序注册 目录→发现→adapter→工具，工具在最后）；插件行 schema 经
  `cordis_inspect_query` 可查（`include:llm-nvidia-router`，status=schema）。

**当前状态：路由已注册但尚无流量**——你的会话仍走 pi-ai 的 `nvidia` 路由，
两者并存互不影响，直到你按下面「迁移到本路由（可选）」主动切换。

## 配置页面（设置 → 「NVIDIA 配额路由」独立页）

DSH 的设置界面由插件自己注册页面。本插件附带客户端配置界面
（`bundle/client.js`，双语），**主入口是左下角「设置」里的独立页面**（与 通用/模型/插件 并列）：

1. 点左下角 **设置**（齿轮）→ 导航里选 **NVIDIA Quota Router / NVIDIA 配额路由**；
2. 页面内可编辑：**API Key 表**（每行 = 凭据引用名 + 脱敏标签 + 密钥值存储——
   密钥值经 `remote.credentials.set` 直存 credentials 服务，绝不写入配置文件，并有
   已存储/未存储徽标）、Base URL、**模型目录**（动态获取，见下）、
   粘性调度阈值、冷却与超时、行为开关；保存为原子写（经 Host 全量校验 + HMR 即时生效）。
3. 备用入口：插件页 → 行 `llm-nvidia-router` 旁的 **配置**（Configure）按钮
   （`plugins.row.config` 槽位，与设置页共用同一表单）。

**模型目录是动态的（无需手填模型 id）**：

- 点 **「获取模型列表」** 会让 Host 经 `ctx.remote.llm.discoverModels` 从端点
  `GET {baseURL}/models` 拉取目录，**并紧接着自动逐个实测**，最后**只保留这把 Key 真能调通的模型**。
  拉取用的 baseURL 有三级兜底：表单里填的值 → 已保存的配置 → 官方默认
  `https://integrate.api.nvidia.com/v1`（所以**只填一个 Key 也能直接获取**，不必先填 URL）。
- 保存 Key 成功后也会**自动**触发同一条链路（拉取 + 实测 + 裁剪）。
- **为什么不能只靠端点返回“免费模型”**：NVIDIA 的 `GET /v1/models` 是 OpenAI 兼容的**全量目录**
  （实为 80 条），每条只有 `id / object / created / owned_by`，**没有任何免费/计费标记**，
  并且混着 embedding、rerank、内容安全等**根本不能对话**的模型。所以“当前免费可用”没有静态字段可查，
  唯一可靠的做法就是实测——这正是免费档的实质：**你这把 Key 能不能调通**。
- 裁剪规则（防误杀）：**只有**返回 `400/401/402/403/404` 才判定不可用并移除；
  **429（限流）与 5xx/超时视为“未确定”并保留**（限流恰恰说明模型存在且可用，只是暂时排队），
  供你稍后重测。完成后面板显示 `可用 N/M · 已移除 D · 保留 K (未确定 U)`，
  并给出 **「恢复全部模型」** 一键还原原始目录；也可用 **「仅保留可用」** 按最近一次实测结果重新裁剪。
- **「测试所有模型」按钮**：只做实测、不裁剪（逐行绿/红圆点 + 实测延迟 ms）。
  Host 侧并发限 6、单模型探测预算 `probeTimeoutMs`（默认 30s，慢端点可调大到 120000；
  2026-10-16 起可配置——此前固定 10s，在响应头延迟劣化的端点上会把健康模型误报为超时）。
  目录大时请耐心等数十秒（期间按钮显示“正在测试模型…”）。
  实测走 Host 的精确 fetch 路由 `/api/nvidia-router.probe`，**不消耗调度器配额、不回传任何密钥值**。

**对话页右上角健康徽标**：会话头部工具区（`conversation.session.header.utilities`）
显示一个 **已配置 API 数量** + **红/黄/绿圆点** 的小徽标，每 15 秒轮询 Host 的
`/api/nvidia-router.status` 脱敏路由。颜色判定：
**红** = 未配置任何 Key 或全部不可用；**黄** = 部分 Key 冷却/异常，或已存储但尚未产生成功请求（未验证）；
**绿** = 已配置的 Key 全部可用且已有成功请求。悬停可见每个 Key 的标签/引用名与状态。

**推理等级（2026-10-15 起）**：模型条目可声明 `efforts`（可选档位，从低到高）与
`defaultEffort`（未选择时的默认档）——声明后对话页右下角的模型选择器就会出现
**推理等级**选择（与 pi-ai 官方路由同款交互）。两个层面要分清：

- **会话层**：选择器选的档位由 DSH 运行时校验（必须在声明列表内）并物化进请求；
- **线协议层**：是否把档位发给端点是部署事实——`reasoningEffortParam` 默认 `none`
  （与 pi-ai 目录对该端点的策展结论一致：NVIDIA integrate API 忽略 effort 参数，
  选择只留在会话侧、不改变请求字节）；若你的端点接受 OpenAI 风格参数，把
  `reasoningEffortParam: reasoning_effort` 配上即可真实下发（端点若拒绝会显式报错，可随时改回）。
- glm-5.3 / glm-5.3-flash 两条目已预配 `efforts: [off, minimal, low, medium, high]`
  （glm-5.3 另配 `defaultEffort: high`）；「获取模型列表」重新发现时**保留**已声明的档位。
- 注意：模块热重载/重启都会清零调度器计数（与重启语义一致），健康徽标随之短暂回黄，
  下一次成功请求后转绿。

注意事项：

- 路由 id 在页面中只读显示（固定 `nvidia-router`，防误改造成冲突/失效）；
- **Key 数量不限**：Key 表没有行数上限，添加多少都行；调度器逐 Key 独立计数，
  默认样例里的 4 个只是示例（`apiKeys` 为任意长数组）；
- 页面跟随 Host 半体：若禁用了本插件的行，设置导航里的该页会自动消失；
- **改 `bundle/client.js` 不需要重启 DSH**：`dsh-client-hmr` 每 500ms 轮询客户端
  bundle 文件（含本项目链接包），改动后约半秒内新版本推送到已打开的页面；
- **改 Host 半文件（index/config/scheduler/adapter/errors/wire/status/routes）也不需要重启**
  （2026-10-15 起）：profile patch 的 `hmr` 行已开启**模块根 watch**（root=本 bundle 目录，
  备份 `.bak-hmr-root-20261015`）——改完**原地重写**一次
  （`cp a.js /tmp/x && cp /tmp/x a.js`，纯 `touch` 不可靠）即自动热重载插件 fiber。
  代价：调度器计数清零（与重启语义一致）。manifest/patch/组合级改动仍需重启 DSH。

## 配置密钥（使用本路由前必须）

真实 Key 永不写入源码/配置文件/Git。三种方式任选：

- **推荐：设置里的配置页面**（上一节）——每个 Key 行直接存储密钥值到 credentials 服务；
- Web 界面 Models 页 → NVIDIA (Quota Router)（注意：Models 页通用凭据流按“单 apiKeyEnv”
  约定设计，对本插件的多 Key 结构不适用，请以上一节的配置页面为准）；
- 或：启动环境中导出 `export NVIDIA_API_KEY_1=...`（引用名可在配置里改成任意名字/数量）。

调整其他参数：配置窗口（见上）或把 CONFIG.example.yaml 中 `config:` 的字段并入
`~/.dsh/profiles/web/cordis.patch.yml` 的 `llm-nvidia-router` 行（patch 语义=整行 config 替换）。

## 迁移到本路由（可选，需要你决定）

你当前的默认模型是 pi-ai `nvidia` 路由的 `z-ai/glm-5.3`（单 Key `NVIDIA_API_KEY`，`reasoningEffort: high`）。
要享受多 Key 粘性调度，需要把默认模型切到本路由。**这一步改动你的活跃会话行为，由你决定后执行**：

1. 先把 Key 配到本路由（上节，数量不限）；并把目标模型加入本插件 `models` 目录
   （已实测：`z-ai/glm-5.3-flash` 可用且 398ms；`z-ai/glm-5.3` 探测超时、保留「未确定」——
   若坚持用它，迁移后先发一两条短消息确认首块延迟；`requestTimeoutMs`（默认 120s）
   只守卫到响应头，之后由 `streamIdleTimeoutMs`（默认 300s）守卫流式节奏）。
   两个 glm 条目已预配推理档位（`efforts` + glm-5.3 的 `defaultEffort: high`）。
2. 把 `cordis.patch.yml` 里 `agent-default-model` 行改为
   `provider: nvidia-router`、`model: z-ai/glm-5.3-flash`（或你选定的模型）。
   **`reasoningEffort: high` 现在可以保留**——只要目标模型条目声明了包含 `high` 的
   `efforts`（glm 两条已配好），运行时会校验并物化；线协议是否下发由
   `reasoningEffortParam` 决定（默认不下发，见上节）。
3. 保留 `llm-pi-ai` 行不动（回滚时直接把 agent-default-model 改回 `provider: nvidia` 即可）。

注意：NVIDIA 对同一账号族的 Key 可能共享限流（合规声明见你提供的规则文件）；
多个 Key 不保证多份独立额度。本插件的定位是本地预算 + 正确处理 429，而非突破服务端限制。

## 运行与诊断

- 正常对话即生效：所有请求（主/子智能体、会话标题、压缩摘要）统一经过调度器。
- 会话中让智能体调用 **`nvidia_quota_status`** 工具查看：各 Key 滚动窗口计数（本地估算）、
  剩余额度、冷却状态与恢复时间、429/超时/切换/全不可用统计。输出全部为脱敏标签（Key-1…Key-4）。
- 日志（profile 日志）中 Key 切换/冷却为 info，错误为 warn；任何输出都不含密钥值。

## 回滚

1. 禁用（保留安装）：Plugins 页关闭该 bundle，或把 `cordis.patch.yml` 里 `llm-nvidia-router`
   行加 `disabled: true`。
2. 完全移除：Plugins 页 Remove（或 `plugin_manager remove_bundle`），并删除
   `cordis.patch.yml` 里的 `llm-nvidia-router` 覆盖段。
3. 误改了 patch 文件其他内容：用备份恢复
   `cp ~/.dsh/profiles/web/cordis.patch.yml.bak-nvidia-router-20261014 ~/.dsh/profiles/web/cordis.patch.yml`
   （备份仅含本次新增行之前的原文件内容）。
4. 本插件不修改 DSH 源码、不改你现有的 pi-ai/deepseek 配置；移除后其他 provider 不受影响。

## 真机首验清单（已执行 · 2026-10-15 全部通过，实录见 TEST_REPORT.md「真机首验」）

1. ✅ 普通对话流式输出正常、调度器计数正确（headless 全栈：stdout `成功`）。
2. ✅ 工具调用请求正常、后续请求计数 +1（bash 往返 + 后续请求）。
3. ✅ 子智能体统一计数（子智能体请求与主智能体合计在同一 Key 窗口内）。
4. ✅ `safeThreshold: 2` 粘性切换（sticky switches 2，窗口分布 2/2/1/0 = reserved 5；
   经临时 `--patch` overlay 完成，用户配置零改动，无需恢复 38）。
5. ✅ `stream_options.include_usage` 全程无 400（全部流式请求隐含验证）。

补充实测：目录 24 模型复测一轮——可用 12，`z-ai/glm-5.3-flash` 398ms 最快档已验证可用；
`z-ai/glm-5.3` 探测超时（保留「未确定」；`requestTimeoutMs` 默认 120s 只守卫到响应头，
流式由 `streamIdleTimeoutMs` 默认 300s 守卫，2026-10-16 起。此前 120s 会掐断整个长生成，
是当时超时风暴的成因之一，已修复）。

## 约束与边界（如实）

- 只管理已授权的 Key；本地阈值是**预算**，不是 NVIDIA 服务端配额的镜像；
  插件目标是主动避开可预估的限额、正确处理 429，而非突破服务端限制。
- 进程外子智能体（ACP/Codex/Claude Code/dsh-sdk）不经本调度器。
- v1 声明纯文本输入模态（图像由 DSH 运行时投影为占位文本）；采样参数仅透传
  temperature/max_tokens/stop（DSH 请求词汇表本身不含 top_p/response_format）。
- 未在本机真实 NVIDIA 端点验证前，相关行为以 TEST_REPORT.md「未测试」清单为准。
