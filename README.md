# NVIDIA Smart Quota Router

为 DeepSeek Harness（DSH）提供 NVIDIA API 模型接入与**多 API Key 粘性配额调度**：
主智能体与进程内子智能体的每一次模型请求都先经同一个调度器原子预留额度，
当前 Key 在本地安全阈值内持续使用，接近阈值才切换下一个 Key；429 按服务端提示冷却；
全部 Key 不可用时退避并给出可诊断错误——而不是逐请求轮询或无限重试。

## 特性

- **粘性多 Key 调度**：滚动窗口计数 + 原子预留，单线程下并发调用者不会重复占用同一额度；
  接近阈值自动切换下一个 Key，切换行为有统计。
- **429 正确处理**：优先遵循服务端 `Retry-After`，否则指数退避（可配上限）；
  账户级配额（402）与凭据错误（401/403）分别冷却，绝不盲目轮询。
- **有界故障转移**：429/5xx/凭据类失败在首块输出前换 Key 重试（次数可配）；
  超时类不转移——慢端点换 Key 只会放大挂起。
- **完整流式支持**：SSE 流翻译、工具调用、推理内容、usage 统计；
  空响应、内容过滤、带内错误都有明确分类。
- **图形化配置页**：DSH 设置里的独立页面——API Key 表（密钥直存凭据服务，绝不落盘）、
  动态模型目录（拉取 + 逐个实测，防误杀裁剪）、全部调度参数可在线调整、保存即生效。
- **推理等级**：模型条目可声明可选档位（如 off/low/medium/high），对话页模型选择器
  出现推理等级选择；档位校验与默认值由 DSH 运行时统一处理，是否真正下发到端点可配置。
- **可观测**：会话头部红/黄/绿健康徽标（15 秒轮询）；
  `nvidia_quota_status` 只读诊断工具输出各 Key 窗口计数、冷却状态与失败统计（全程脱敏）。
- **零依赖 bundle**：纯 ESM JavaScript，无 npm 依赖；支持 DSH 热更新，改代码免重启。

## 快速开始

### 前置

- 一台运行 DeepSeek Harness 的机器（`dsh` CLI 可用）；
- 至少一把 NVIDIA API Key（[build.nvidia.com](https://build.nvidia.com) 免费申请，数量不限）。

### 安装

1. 把 `bundle/` 链接（或复制）进你的 profile：

   ```bash
   mkdir -p ~/.dsh/profiles/<profile>/node_modules/@local
   ln -s "/path/to/nvidia-smart-quota-router/bundle" \
     ~/.dsh/profiles/<profile>/node_modules/@local/dsh-llm-nvidia-router
   ```

2. 在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加插件行：

   ```yaml
   - id: llm-nvidia-router
     name: '@local/dsh-llm-nvidia-router'
     config:
       baseURL: https://integrate.api.nvidia.com/v1
   ```

3. 重启 DSH。设置 → 「NVIDIA 配额路由」出现独立配置页即安装成功。

### 配置 API Key（推荐走设置页）

1. 设置 → 「NVIDIA 配额路由」→ 在 Key 表中填入凭据引用名（如 `NVIDIA_API_KEY_1`）
   与密钥值——密钥经凭据服务存储，**绝不写入配置文件或 Git**；
2. 点「获取模型列表」自动拉取 NVIDIA 目录并逐个实测，**只保留你这把 Key 真能调通的模型**
   （超时/限流判「未确定」保留，仅 400/401/402/403/404 判不可用移除，支持一键还原）；
3. 把默认模型切到本路由：`cordis.patch.yml` 的 `agent-default-model` 行改为
   `provider: nvidia-router`、`model: <你选定的模型>`。完成——正常对话即生效。

### 关键配置（均可在设置页在线调整）

| 参数 | 默认 | 说明 |
|---|---|---|
| `windowMs` / `safeThreshold` | 60s / 38 | 滚动窗口与每 Key 本地预算（预算 ≠ 服务端配额镜像） |
| `requestTimeoutMs` | 120000 | 等待响应头+错误体的截止，头部到达即撤除；**慢端点建议调大**（如 300000） |
| `streamIdleTimeoutMs` | 300000 | 流式两个数据块之间的最大空闲 |
| `maxFailoverAttempts` | 2 | 首块输出前换 Key 重试次数上限 |
| `retryPolicy.maxRetries` | 5 | 失败后的步级重试次数 |
| `probeTimeoutMs` | 30000 | 「测试所有模型」的单模型探测预算，慢端点调大（如 120000） |

完整字段与注释见 [CONFIG.example.yaml](CONFIG.example.yaml)。

## 使用与诊断

- 正常对话即生效：主/子智能体、会话标题、压缩摘要的请求统一经过调度器。
- 会话中让智能体调用 `nvidia_quota_status`：各 Key 窗口计数、剩余额度、
  冷却状态与恢复时间、429/超时/切换/全不可用统计（输出全部脱敏，Key-1…Key-N）。
- 对话页右上角健康徽标：红 = 无可用 Key；黄 = 部分 Key 异常或未验证；绿 = 全部可用且已有成功请求。
- Key 切换/冷却记 info 日志，错误记 warn；任何输出不含密钥值。

## 测试

```bash
sh tests/run.sh
```

75 项自动化测试，全部走本地 mock 端点——不接触真实 API、不消耗配额。

## 已知限制（如实）

- 本地阈值是**预算**，不是 NVIDIA 服务端配额的镜像；本插件的目标是避开可预估的限额、
  正确处理 429，而非突破服务端限制。同一账号族的多个 Key 可能共享限流。
- 进程外子智能体（ACP/Codex/Claude Code/dsh-sdk）不经本调度器。
- 纯文本模态（图像由 DSH 运行时投影为占位文本）；采样参数仅透传
  temperature/max_tokens/stop。
- NVIDIA 免费档端点在高峰期可能响应极慢（实测首字节延迟可达 2 分钟+）——
  把 `requestTimeoutMs` 调大可容忍慢端点，但吞吐本身取决于服务端。

## 开发文档

| 文档 | 内容 |
|---|---|
| [TECHNICAL_DESIGN.md](TECHNICAL_DESIGN.md) | 架构检查结论、调度流程、技术决策 |
| [TEST_REPORT.md](TEST_REPORT.md) | 真机首验与测试实录（命令与结果） |
| [CHANGELOG.md](CHANGELOG.md) | 变更记录（每条含原因与证据） |
| [PROJECT_STATUS.md](PROJECT_STATUS.md) | 项目阶段与任务状态 |
| [HANDOFF.md](HANDOFF.md) | 交接说明与运维约束 |
| [CODE_REVIEW_20261017.md](CODE_REVIEW_20261017.md) | 全量代码审查记录 |
| [CONFIG.example.yaml](CONFIG.example.yaml) | 完整配置样例（无任何真实 Key） |

## License

未附带开源许可证（默认保留所有权利）。如需以 MIT/Apache-2.0 等方式复用，请开 issue 联系作者。
