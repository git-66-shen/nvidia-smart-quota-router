# nvidia-smart-quota-router 代码审查 · 2026-10-17

审查范围：`bundle/` 全部 9 个源文件逐行通读（index/config/scheduler/adapter/errors/wire/status/routes/client），
对照 DSH 检出（`packages/credentials`、`packages/client/ui-settings-models`）核对跨包调用约定，
并运行完整测试套件（`sh tests/run.sh`，Node v26.10.0）：**75/75 通过**。
审查中修复 2 处小问题（见下），修复后复跑 **75/75 通过（5.7s）**。

## 结论

无阻断性缺陷。调度原子性、failover 边界、密钥脱敏、SSE 协议翻译均正确。
以下按严重度记录发现（均为小问题，不影响当前已验证行为）。

## 已确认正确的设计（核对过源码与官方用法）

1. **`credentials.describe([refs])` 数组用法正确**（client.js:303）——DSH 客户端 Remote 的
   `describe` 接受数组并以 ref 为键返回映射；官方 `ui-settings-models/operations.ts` 同款用法
   （`ctx.remote.credentials.describe([ref])` → `response.value[ref]`）。
2. **调度原子性**：`#tryAcquire` 全同步段无 await，单线程下并发调用者不会重复观察到同一剩余额度
   （scheduler.test.js 的 50 并发测试覆盖）。
3. **`lease.reservedAt` 固定为预留时的时间戳**而非构造时重新取时钟——修复了 release 找不到自身
   条目导致槽位泄漏的问题，且有专门的回归测试（scheduler.test.js:250）。
4. **failover 边界严格**：仅在 `!flight.streamed`（无内容到达消费者）+ `attempts <= maxFailoverAttempts`
   + `FAILOVER_ELIGIBLE` + 未 abort 时继续；TIMEOUT 排除在 failover 外（串行等待只会放大挂钟时间）。
5. **release 语义保守正确**：只有 provably-never-dispatched（pre-dispatch abort、pre-dispatch 凭据失败）
   才释放额度；已到达 fetch 的请求计数保留（可能已被服务端消耗）。
6. **全 Key 不可用**：有界等待（`allUnavailableWaitMs`）→ 带最早恢复提示的 RATE_LIMIT 错误，
   上限 `MAX_REPORTED_RETRY_AFTER_MS = 60s`。
7. **SSE 协议**：in-band error → 终态 error finish；`content_filter` 特判；
   零内容块的完成判 `EMPTY_RESPONSE`；`[DONE]`/干净结尾/尾帧三种 flush 路径一致；
   block 索引按首见顺序，usage 在 finish 前。
8. **密钥安全**：lease 只携带 label/envRef；探测/状态路由只回 id/延迟/判定；
   `credentials.set` 直存 credentials 服务；`security.test.js` 还验证源码无密钥字面量。

## 小问题（按建议处理顺序）

### 1. `routes.js:211` 死防御 —— **已修复（2026-10-17）**

```js
scheduler.syncKeys?.()   // 修复前
scheduler.syncKeys()     // 修复后
```

`handleStatus` 唯一调用方 `registerConnectionRoutes` 传入的永远是真 `QuotaScheduler` 实例，
`syncKeys` 是公开方法恒存在，测试 mock 也没有省略它的。对静态保证的值做可选链是死防御。

### 2. `scheduler.js:104` 冗余条件 —— **已修复（2026-10-17）**

```js
const delay = Number.isFinite(retryAfterMs) && retryAfterMs !== undefined && retryAfterMs > 0   // 修复前
const delay = Number.isFinite(retryAfterMs) && retryAfterMs > 0                                // 修复后
```

`Number.isFinite(undefined)` 本身就是 `false`，中间的 `retryAfterMs !== undefined` 永不参与判定。

### 3. `adapter.js:130-133` attempts 计数语义模糊

```js
let attempts = 0
while (true) {
  attempts++
  const lease = await this.#scheduler.acquire(...)
```

`attempts++` 在 `acquire` 之前：若 acquire 抛 RATE_LIMIT（全 Key 不可用超时），计数已增加
但未用于任何判定。无害，但把 `attempts++` 移到 acquire 成功之后语义更准
（attempts = 实际发起的 HTTP 尝试数）。

### 4. `wire.js:256-261` usage 失真边界

```js
inputTokens: Math.max(0, (promptTokens ?? 0) - cached),
```

`prompt_tokens` 缺失（端点只回 `completion_tokens`）时 `inputTokens` 报 0 而非省略。
OpenAI 兼容端点实际总是提供 `prompt_tokens`，但字段可选性上写明
“promptTokens undefined → 报 0”更诚实。nit。

### 5. `wire.js:293` 无 index 工具片段合并

```js
typeof fragment.index === 'number' ? fragment.index : 0,
```

非数字 index 默认 0：同一流里多个省略 index 的工具片段会错误合并进一个 tool-call。
OpenAI 流式协议总是带 index，NVIDIA 端点实测通过；仅当未来遇到非标准端点才可能触发。
记录为已知边界即可，无需改动。

## 测试运行记录

```
$ cd /vol2/1000/deepseek harness && sh 项目/nvidia-smart-quota-router/tests/run.sh
ℹ tests 75  ℹ pass 75  ℹ fail 0  duration 5.4s
```

环境：Node v26.10.0（run.sh 探测路径），DSH 检出根 `/vol2/1000/deepseek harness`。
