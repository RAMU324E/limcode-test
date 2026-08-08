# 模型、工具调度与工具执行性能画像

> 状态：2026-08-07 当前工作树与当前 runnable `dist` 的只读调查报告。
>
> 定位：本文件记录性能背景、生产历史统计、当前受控基准、硬盘 I/O 压力、观测限制和优化判断。它是**人读调查证据，不是机器合同**，也不替代 [工具调度器与执行器性能优化方案](./TOOL-SCHEDULER-EXECUTOR-OPTIMIZATION.md)。
>
> 项目边界：个人/小团队、本机 VS Code 扩展。目标是降低真实交互延迟，在保留必要崩溃恢复与外部副作用边界的前提下，避免多租户、分布式或企业级审计所需的过度防守。

## 0. 结论摘要

正常完整工具回合的真实生产时间加权占比为：

| 阶段 | p50 / p95 | 含模型占比 | 去模型后占比 |
|---|---:|---:|---:|
| 模型 Provider：dispatch → wire terminal | 9.044s / 25.261s | **89.16%** | — |
| wire terminal → 首个工具 batch submit | 207ms / 363ms | 1.72% | **15.87%** |
| 工具 batch envelope | 694ms / 2.915s | 8.52% | **78.61%** |
| dispatch complete → Context commit observation | 23ms / 241ms | 0.60% | **5.52%** |
| **完整回合** | **10.708s / 26.289s** | 100% | — |
| **去模型后的本地回合** | **961ms / 3.188s** | 10.84% | 100% |

核心判断：

1. **完整用户等待主要来自模型。**正常完整工具回合中，Provider 段约占 89%。
2. **模型已决定调用工具之后，本地等待主要来自工具 batch envelope。**但该 envelope 是 batch wall-clock，不是纯 capability 时间。
3. **真正的 read capability 几乎可以忽略。**当前受控 1KiB read 中，真实文件读取只占工具窗口约 0.6%；readonly durable settlement 与有序 Context 发布合计约 72%。
4. **短 process 也不是 OS spawn 慢。**生产普通 process 中，identity → exit/output drain 约占 24%，前后 queue/control/receipt/settlement envelope 约占 76%。
5. **当前 8/4/8 并发真实生效。**有界 scheduler helper 在确定性能力基准中的额外 wall time不足 1ms；下一阶段不应继续盲目提高 cap，而应减少每工具前后的 DB 状态转换和 convergence 竞争。
6. **当前硬盘不是带宽饱和，而是小文件 durability 与 WAL 写放大。**warm 工具回合的物理读取通常为 0；单个完整 1KiB read 仍写约 1.57MiB SQLite WAL，并为 14 个新 CAS 对象执行 126 次 sync。低至中风险组合预计可减少 70%～88% 显式 sync、15%～30% 实际块写和 35%～55% 日增长。
7. **优化本地工具路径会明显改善工具之间的响应感，但不会同比改写完整回合。**即使所有非模型阶段完全消失，正常完整回合的数学上限也只有 10.84%；更现实的本地减半约改善完整回合 5%，但可以回收每次工具数百毫秒。

## 1. 调查背景与问题定义

本次调查源于两个持续的用户感知问题：

- “模型已经给出工具调用，但工具迟迟不开始或不显示完成”；
- “多个可并行工具虽然声明 parallel，视觉上仍像串行”。

此前源码与基准已经确认：

- 并行 capability 核心存在，不是一个简单 `for/await` 把所有工具串行；
- 一个逻辑工具动作会经过 ModelRequest terminal、Assistant Message、ToolCall batch、dispatcher preflight、capability、artifact/Operation、ToolOutcome/ToolModelResult、Context 等多层 durable 状态；
- 所有 RuntimeDB 请求进入同一个同步 SQLite worker；
- 旧生命周期日志中的 `tool_dispatch_started/completed` 是 batch submission/return 边界，不是真实单工具 capability start/end；
- 首轮曾被 MCP discovery 硬门禁，当前已改为后台发现，不再阻塞 builtin readiness；
- ordinary/process-MCP/child durable admission 的并发上限当前为 8/4/8，并已拆 lane；
- 25ms RootBinding 成功验证复用已显著降低热突发中的重复 pointer/epoch 读取，但逻辑 DB 请求数仍高。

因此本报告不再用单一总 wall time判断“是模型慢还是工具慢”，而是同时使用三套分母：

1. **完整 Agent 回合**：首轮模型 dispatch 到工具执行、第二轮模型和 Turn terminal；
2. **工具本地窗口**：Provider output ready 到 ToolModelResult/Context commit；
3. **纯 capability**：真实文件、进程、MCP 或 child 外部工作本身。

人工审批、foreground wait、后台任务和异常长输出单独统计，不与普通工具 p50 混合。

## 2. 版本、数据与隐私边界

### 2.1 当前构建

- HEAD：`490765d9addc5f86a340955075449075b6c546d2`；
- 工作树明显 dirty，本报告以当前工作树而不是 clean HEAD 作为现状；
- runnable main：`dist/extension/vscode/extension.js`；
- provenance source closure：418 文件；当前工作树相对 runnable dist 有 2 个 SHA-256 mismatch，位于 `answerDelivery.ts` 与 `automaticRuntimeDelivery.ts`；
- 本节实际测量的 CAS、RuntimeDB、RootAuthority、process、dispatcher、EffectControlPlane 与 Context I/O 热路径全部与 provenance 匹配；
- provenance 明示 `worktreeClean=false`，因此这些数字对应当前 dirty 工作树附近的 runnable dist，不是 clean-commit 重现。

### 2.2 真实历史数据范围

为避免调查自身的工具/process telemetry 污染，真实统计使用调查开始前的硬 cutoff。cutoff 前历史约覆盖 2026-08-03 至 2026-08-07：

- ModelRequest：8,864；
- ToolCall/ToolExecution：11,232；
- Process：4,730；
- 普通首 attempt 模型 timing：7,872；
- 普通成功 read：4,105；
- 普通成功 process launch：4,269；
- 普通 MCP：7；
- 当前 journal 中可完整关联的正常工具回合：31。

SQLite 提供全历史 durable facts；diagnostics journal 受 4MiB rotation 约束，在最终快照中只覆盖最近约 41 分钟，因此完整回合样本显著少于 SQLite 行数。

### 2.3 受控基准

当前 runnable dist 上额外运行：

- 完整两轮 read AgentLoop：累计 110 样本；
- production convergence 开启的完整 read：30 样本；
- short process：`true`、`printf`、`rg` 各 15，共 45 样本；
- Provider stream：1/10/33/100 个 delta 各 15 样本；
- ordinary/process-MCP/mixed/child 并发：各 10 样本；
- 1000 segment Context warm materialization：40 个既有证据样本。

完整 read 使用真实 AgentLoop、当前 ReliableToolDispatcher、SQLite/CAS 和真实 1KiB `fs.readFile`；Provider 为零网络模拟器，所以它测量的是本地控制面下界，不代表真实模型速度。

### 2.4 隐私

统计只读取类型、状态、时间、大小、截断计数和 durable link；未读取或输出：

- prompt、system prompt、模型正文或 thought；
- 工具参数、命令正文、文件正文、路径内容；
- URL、Authorization header、API key 或其他凭据；
- process spool 的 stdout/stderr 正文。

## 3. 时间字段与观测语义

### 3.1 模型

- `ModelRequest.created_at` 是创建事务的逻辑时间，不是 provider send 时间；
- `providerStartedAt` 位于 runtime settings 解析之后、provider 实例和 payload 准备之前；
- `firstOutputAt` 是首个具有 stream timing 语义的 chunk，不等于首个 raw transport frame；
- `completedAt` 是 stream iterator 结束时间；
- `streamOutputDurationMs` 使用单调时钟，适合生成段统计；
- transport `request_sent`、`first_raw_event`、`first_semantic_event`、`terminal` 都是 Extension Host 的观察时刻；
- terminal checkpoint timestamp 在 terminal CAS prepare 后、SQLite commit 前采样；
- `provider_output_ready` 在 terminal checkpoint commit 后又从 SQLite/CAS 读回，因此真正 durable commit 位于 checkpoint timestamp 与 output-ready observation 之间。

### 3.2 工具

当前 11,232 条 ToolExecution 全部满足：

```text
ToolExecution.started_at == ToolCall.created_at
```

因此 `started_at` 只是 ToolCall batch 创建时间，**不是 capability start**。

所有 terminal 记录还满足：

```text
ToolExecution.completed_at
  == ToolOutcome.created_at
  == ToolModelResult.created_at
```

这些时间是在 terminal settlement 事务前采样的逻辑时间，不是事务完成时间。

`EffectIntent.updated_at` 会在 claim 和 receipt 等状态反复覆盖，最终行通常不能恢复真实 claim 时间。`EffectReceipt.received_at` 位于外部 capability 已返回、结果已规范化/CAS prepare 后、receipt commit 前。

### 3.3 lifecycle 不能误用

`agent.lifecycle.tool_dispatch_started/completed` 的生产语义是：

```text
为 group 内所有调用先记录 started
→ await dispatchBatch(group)
→ 整批返回后为成员记录 completed
```

所以它只提供 batch envelope：

- queued call 会提前获得 started；
- fast sibling 的真实 capability end 会被慢 sibling 抹平；
- completed 不能作为单工具执行结束。

生产 RuntimeDatabase 没有接入 optional `performanceMetrics` sink，`tool.lifecycle capability_start/end` 目前只是开发类型，不是生产事实。read/MCP/child 的真实 capability 只能给上界；process 可通过 spool identity/exit 获取更精确区间。

### 3.4 Webview 时钟

`webview.*.painted.observedAt` 来自 Webview 自己的双 `requestAnimationFrame` 后时钟。当前 38 个 first transient → paint 配对中有 36 个出现客户端时间早于 Extension Host，因此现有日志不能可信计算首事件 → 首画；不得把跨进程 wall clock直接相减。

## 4. 完整回合占比

完整序列要求同一 ModelRequest 同时存在 dispatch、wire terminal、首 batch submit、末 dispatch complete 和末 Context commit，且严格有序。近期共 34 个可关联回合；排除 approval 2 个和 child 1 个后，正常 n=31。

| 子集 | n | 含模型：model / control / tool-wait / settlement | 去模型：control / tool-wait / settlement |
|---|---:|---:|---:|
| 正常全部 | 31 | **89.16 / 1.72 / 8.52 / 0.60%** | **15.87 / 78.61 / 5.52%** |
| 纯 read 回合 | 12 | 90.15 / 2.00 / 7.45 / 0.40% | 20.30 / 75.63 / 4.07% |
| 含 process launch | 16 | 88.15 / 1.40 / 9.82 / 0.63% | 11.79 / 82.87 / 5.34% |

占比是各阶段总时长/总 wall-clock 的时间加权值，不是“每回合百分比的平均”。

`tool-wait` 是 batch envelope，包含：

- scheduler queue/preflight；
- 真实 capability 或 foreground wait；
- dispatcher 内部 durable result settlement；
- 同批慢 sibling 的 barrier/HOL。

它不能直接解释为“工具代码执行了 694ms”。

## 5. 模型行为

### 5.1 SQLite 全历史 timing

筛选 terminal completed、存在 assistant link、attemptSeq=1、四个时间齐全且有序，n=7,872：

| 阶段 | p50 | p95 | 结论 |
|---|---:|---:|---|
| ModelRequest timestamp → providerStartedAt | 56ms | 217ms | 本地 dispatch envelope，不是纯 Context |
| providerStartedAt → firstOutputAt | **5.207s** | **25.757s** | setup、网络、排队、模型首输出 |
| firstOutputAt → completedAt | **1.765s** | **28.420s** | 流式生成段 |
| providerStartedAt → completedAt | **8.369s** | **45.235s** | Provider 总段 |
| completedAt → terminal checkpoint timestamp | 17ms | 150ms | durable commit 前处理下界 |

按 Provider 总时间加权：

- 首输出前约 54%；
- 首输出后约 46%。

因此模型长尾既包含 TTFT，也包含长输出/长推理，不能只优化 transport 首包。

### 5.2 近期 transport 细分

| 阶段 | p50 | p95 | n |
|---|---:|---:|---:|
| dispatch → lock_wait | 58ms | 201ms | 39 |
| dispatch → request_sent | 109ms | 393ms | 39 |
| request_sent → first raw frame | 748ms | 1.293s | 39 |
| first raw → first semantic | **4.241s** | **9.706s** | 38 |
| dispatch → first semantic | 5.128s | 10.930s | 38 |
| first semantic → wire terminal | 4.235s | 45.636s | 38 |
| wire terminal → checkpoint timestamp | 21ms | 119ms | 39 |
| checkpoint timestamp → provider_output_ready | 14ms | 48ms | 39 |
| wire terminal → provider_output_ready | 38ms | 169ms | 39 |
| Assistant durable commit bracket | 32ms | 97ms | 39 |

首 raw frame 后到首 semantic 仍有 p50 4.241s，说明当前 TTFT 主体不在本地 Context 或 DNS/TLS，而在 Provider/server/model 侧。

### 5.3 本地模型控制面下界

零网络模拟 Provider 下，完整 `dispatch()` 对 1/10/33/100 个 delta 的 p50 均约 25～31ms、p95 约 38～54ms，并固定为：

- 17 个 RuntimeDB request；
- 2 个 durable stream transaction；
- 仅首个普通 delta 与 terminal summary 持久化。

因此 delta 数不再线性放大 durable 成本。普通短 Context 的 request build约 5～6ms；1000 segment warm materialization 为 p50 13.39ms、p95 22.09ms。现有证据不支持把模型 5～25s TTFT 归因于本地 Context materialization。

## 6. read：真实执行与控制面

### 6.1 生产历史

普通成功 read，n=4,105：

| 阶段 | p50 | p95 | 语义 |
|---|---:|---:|---|
| ToolCall created → terminal | **1.247s** | **5.510s** | ToolCall 总 envelope |
| created → no-effect Operation timestamp | 942ms | 3.792s | capability 上界，包含 queue/control |
| Operation timestamp → Tool terminal | 146ms | 2.010s | settlement/finalization timestamp interval |
| terminal timestamp → Context timestamp | 203ms | 1.889s | Context transaction 前处理下界 |
| Context timestamp →下一 ModelRequest timestamp | 256ms | 960ms | 下一轮构造上界余量 |

生产没有 read capability start/end，因此不能从这组数据精确还原文件 I/O。

### 6.2 当前受控完整 read

production convergence 开启，真实 AgentLoop/Dispatcher/SQLite/CAS、真实 1KiB `fs.readFile`，Provider 网络为 0，n=30：

| 指标 | p50 | p95 |
|---|---:|---:|
| 完整两轮本地回合 | **209.8ms** | **448.5ms** |
| Provider ready →工具 Context commit | **88.8ms** | **229.3ms** |
| Assistant Message commit | 7.9ms | 35.0ms |
| Assistant → ToolCall batch | 7.0ms | 24.2ms |
| scheduler preflight → capability | 4.1ms | 12.6ms |
| 真实 `fs.readFile(1KiB)` | **0.189ms** | **2.136ms** |
| capability end → dispatcher return | **43.0ms** | **97.2ms** |
| ToolModelResult → Context pair | **17.6ms** | **46.3ms** |
| Context pair →下一 Provider dispatch | 15.6ms | 51.1ms |

工具窗口按全部样本累计时间加权：

| 阶段 | 占比 |
|---|---:|
| Assistant 输出持久化 | 12.68% |
| ToolCall 创建、策略冻结、scheduler/preflight | 14.40% |
| **真实 read capability** | **0.62%** |
| **readonly durable settlement** | **50.43%** |
| **ToolModelResult 有序发布与 Context** | **21.86%** |

结论：

```text
文件读取本身 < 1%
调度与 ToolCall 准备约 14%
结果 settlement + Context 约 72%
```

继续优化 `fs.readFile` 或继续提高 ordinary cap，不会解决单 read 延迟。readonly result settlement 与 Context 是首要本地热点。

### 6.3 capability 后分解

在 convergence 关闭的稳定诊断样本中：

| 阶段 | p50 | p95 |
|---|---:|---:|
| capability end → ToolResultArtifact durable | 10.2ms | 15.1ms |
| ToolResultArtifact → ToolOutcome | 12.6ms | 25.1ms |
| ToolOutcome → dispatcher return | 1.1ms | 4.8ms |
| ToolModelResult → Context pair | 9.8ms | 19.2ms |

这些阶段适合做 readonly compound snapshot/transaction；没有必要删除 ToolCall identity、Lease fence或 Provider result 顺序。

## 7. DB 请求与 convergence

### 7.1 完整零网络 read 的请求分布

production convergence 开启：

| DB 窗口 | p50 requests | p95 |
|---|---:|---:|
| Turn admission → 首轮 Provider dispatch | 36 | 42 |
| 首轮 Provider dispatch → output ready | 20 | 26 |
| Provider ready → capability start | **31** | 37 |
| capability start → Context commit | **33** | 42 |
| Context → 下一 Provider dispatch | 22 | 28 |
| 第二轮 Provider → Turn terminal | 53 | 59 |
| **完整回合** | **207** | **216** |

完整回合累计 DB 工作：

- worker execute：p50 88.3ms、p95 129.7ms；
- worker queue：p50 34.9ms、p95 102.2ms。

累计 worker 时间在并发时可能重叠，不能与 wall time直接相加。

### 7.2 先前“33 requests”的准确边界

单 1KiB read 的 33 requests 指 Provider terminal → capability 入口窗口，而不是完整工具生命周期。标准构成为：

- 29 `snapshot`；
- 1 `snapshotAll`；
- 2 `transaction`；
- 1 `modelStreamEvent`。

主要用于：

1. terminal checkpoint；
2. Assistant Message + Context；
3. ToolCall batch；
4. termination/replay 检查。

实际 read、结果 artifact、ToolOutcome、Context tool pair 和下一轮 Provider都不在这 33 次内。RootBinding 25ms 热验证复用降低了每次 request 的物理 pointer/epoch 成本，但逻辑 request 数仍在。

### 7.3 convergence 敏感性

fresh Runtime 独立运行的同类 read 基准：

| 指标 | convergence 关闭 | 开启 |
|---|---:|---:|
| 完整本地回合 p50 | 150.4ms | 209.8ms |
| 工具窗口 p50 | 66.4ms | 88.8ms |
| capability → dispatcher p50 | 33.0ms | 43.0ms |
| ToolModelResult → Context p50 | 10.9ms | 17.6ms |
| DB requests p50 | 195 | 207 |

两组是独立运行，系统负载和 cache 会引入误差，不能把全部差值严格归因给 convergence；但新增请求、DB queue 和多个前台阶段同步变慢，足以说明全局 convergence 是明确的 p95 放大器。长期方向应是按 commit 涉及的 effect/turn 定向推进，保留 startup full scan 兜底，而不是每次全扫 active Turn。

## 8. process

### 8.1 生产普通前台 process

排除审批、后台返回、非成功、长输出/截断，n=4,269：

| 阶段 | p50 | p95 |
|---|---:|---:|
| ToolCall created → identity.startedAt | **367ms** | **3.089s** |
| identity.startedAt → exit.exitedAt | **42ms** | **1.008s** |
| exitedAt → Tool terminal timestamp | **455ms** | **1.767s** |
| Tool terminal → Context timestamp | **239ms** | **1.100s** |
| ToolCall created → terminal | **1.131s** | **6.185s** |

按总时间加权：

- identity → exit + output drain：约 24%；
- identity 之外的 queue/control/receipt/settlement envelope：约 76%。

全 process n=4,730：

| 分段 | p50 | p95 |
|---|---:|---:|
| `launch.json.createdAt` → `identity.startedAt` | 68ms | 175ms |
| `exit.exitedAt` → `ProcessReceipt.received_at` | 118ms | 395ms |

### 8.2 当前短命令受控基准

`true`、`printf`、`rg` 各 15 个临时 Runtime 样本，共 n=45：

- direct process control-plane total：p50 202ms、p95 318ms；
- prepare：p50 12ms；
- spawn：p50约 3～4ms；
- identity：约 45～65ms；
- command + receipt observation：约 52～57ms；
- 其余 DB/receipt/finalization：约 68～75ms。

45 个样本累计时间占比：

| 阶段 | 占比 |
|---|---:|
| prepare | 6.73% |
| OS spawn | **1.83%** |
| identity ready | 28.88% |
| command + terminal receipt observation | 19.88% |
| output import | 5.10% |
| 其余可靠控制面 | **37.58%** |

数据不支持优先建设 persistent shell。应优先压缩 process prepare 重读、exit receipt/import、terminalization 与 convergence。

### 8.3 后台与异常样本

- 后台返回 ToolCall：n=284，ToolCall created → background return 为 p50 2.132s、p95 18.508s；
- 普通输出后台 process：n=274，identity → exit 为 p50 13.707s、p95 105.554s；
- 长输出/截断：n=51，identity → exit 为 p50 216ms、p95 4.606s；
- manual stop 10、timeout 2。

这些样本没有混入普通 process p50。

## 9. MCP、child 与交互等待

### 9.1 MCP

普通成功样本仅 n=7，低样本：

| 阶段 | p50 | p95 |
|---|---:|---:|
| ToolCall created → terminal | 1.944s | 7.014s |
| EffectIntent created → receipt（capability 上界） | 1.358s | 3.178s |
| receipt → Tool terminal | 159ms | 1.823s |
| terminal → Context | 163ms | 1.377s |

`Intent created → receipt` 包含 queue、claim、网络和 server 执行，不是真实 MCP capability。生产缺 per-server capability start/end，当前不能进一步可信归因。

### 9.2 child

只有 durable spawn link 的 n=42：

| 模式 | n | p50 / p95 |
|---|---:|---:|
| spawn EffectIntent created → receipt | 42 | 71ms / 464ms |
| background：ChildExecution created →父 Tool terminal | 21 | 302ms / 1.096s |
| foreground answered：created → AnswerSubmission | 11 | 47.952s / 3,917.854s |
| foreground timeout：created →父 Tool terminal | 10 | 120.090s / 8,954.164s |

foreground child 时间包含 child 自己的模型、工具和回答过程，不能归为父 scheduler 开销。background/foreground/timeout 必须分开统计。

### 9.3 人工与交互

| interaction 类型 | n | request → response p50 / p95 |
|---|---:|---:|
| exec approval | 6 | 8.925s / 63.38min |
| plan review | 70 | 50.374s / 37.78min |
| ask_user | 6 | 18.051s / 3.73min |
| file-change approval | 647 | 45ms / 182ms |

file-change 样本大量来自快速/自动政策路径，不能解释为人工反应。以上交互均未混入普通工具分位数。

## 10. 并发与 mixed HOL

当前 cap：

- ordinary：8；
- process/MCP：4；
- child durable-intent admission：8。

10 个受控样本：

| 场景 | 理论能力时间 | 实测 p50 | maxActive |
|---|---:|---:|---:|
| 8 ordinary × 50ms | 50ms | **50.43ms** | 8 |
| 4 process/MCP × 80ms | 80ms | **80.32ms** | 4 |

因此 bounded scheduler helper 的附加 wall time不足 1ms，slot-refill 与并发度真实生效。

慢 child 250ms + 快 read 20ms 的 mixed 场景：

| 事件 | p50 |
|---|---:|
| read capability 完成 | 23.8ms |
| read result durable | 36.9ms |
| capability → durable | 13.3ms |
| 整批返回 | 260.2ms |

这说明当前 lane 拆分与 early readonly settlement 已消除“快 read 等慢 child 才 durable”的主要 HOL；整批返回仍按 batch/foreground 合同等待 child，Provider-visible结果仍遵守 prefix/order。

8 个 child durable admission：

- wall p50 250.3ms；
- DB request 通常 338；
- worker execute 累计 p50 137.6ms；
- worker queue 累计 p50 898ms。

child admission 仍是 DB 请求非常密集的路径；累计 queue 是并发工作总量，不可直接当 wall time。

## 11. 硬盘 I/O 压力与存储增长

### 11.1 调查方法与解释边界

本节同时使用三类证据：

1. 当前 active Runtime 的文件数、表观大小、实际分配块和 SQLite page 统计；
2. 完整活跃日 2026-08-07 的 CAS、process spool 和 durable fact 增量；
3. 临时 Runtime 上的 `/proc/self/io`、`strace -f` 和分阶段 CAS/WAL 计数。

受控基准使用与 runnable dist provenance 匹配的 I/O 热路径模块；当前两处 provenance mismatch 位于 answer delivery 文件，不在本节测量的 CAS、RuntimeDB、process、dispatcher 或 Context 路径中。`strace` 会放大 wall time，因此 syscall 数和字节用于归因，wall time 使用无 `strace` 样本。

必须区分：

- **逻辑读取/写入**：进程经 `read/write/pread/pwrite` 处理的字节，可由 page cache 吸收；
- **物理块读取/写入**：`/proc/self/io` 的 `read_bytes/write_bytes`；
- **显式 sync**：`fsync/fdatasync` 等 durability barrier，正文很小也可能阻塞调用；
- **表观大小与实际分配**：小于 4KiB 的文件通常仍至少占一个 4KiB block，并消耗 inode 和目录项。

当前没有通过 drop-cache、重启或独占机器构造严格 cold-disk 样本，因此 warm `read_bytes=0` 不能外推为冷启动没有物理读取。

### 11.2 文件系统与设备状态

当前 Runtime、项目和 `/tmp` 均位于同一 `/dev/sda1` ext4：

- 非旋转设备，write-back cache；
- 4KiB block；
- `relatime,discard,commit=30`；
- 调度器为 `mq-deadline`；
- 机器约 7.8GiB RAM，调查时约 5.1GiB available、1.9GiB page cache，无 swap。

SQLite 当前使用：

- `journal_mode=WAL`；
- `synchronous=NORMAL`；
- `wal_autocheckpoint=1000`；
- `page_size=4096`；
- `cache_size=-16000`；
- `temp_store=0`；
- `mmap_size=0`；
- 写事务为 `BEGIN IMMEDIATE`。

空闲窗口 `iostat -dx 1` 样本中，设备利用率约 0.3%～2.4%，写吞吐约 156～656KiB/s，write await约 0.25～0.88ms。当前没有证据表明设备带宽或队列已持续饱和；用户可感知成本主要来自热路径主动等待大量小 sync、SQLite WAL 页写和单 worker 排队。

### 11.3 当前 active Runtime 存量

调查时 active Runtime 近似存量：

| 子系统 | 表观大小 | 实际分配 | 文件数 |
|---|---:|---:|---:|
| SQLite 主库、WAL、SHM | 约 470MB | 约 470MB | 少量 |
| CAS | 约 560MB | **约 1.23GB** | 约 19.8 万 |
| process spool | 约 72MB | **约 198MB** | 约 2.64 万 |
| diagnostics | 约 3～4MB | 约 3～4MB | 4 |
| **总计** | **约 1.11GB** | **约 1.90GB** | **约 22.4 万** |

文件尺寸分布：

| 尺寸 | 文件数 |
|---|---:|
| `<4KiB` | 约 19.1 万 |
| `4～16KiB` | 约 2.4 万 |
| `16～64KiB` | 约 7,500 |
| `>=64KiB` | 约 850 |

约 85% 文件小于 4KiB。表观约 1.11GB、实际分配约 1.90GB，差额约 790MB；其中 CAS 小文件块/metadata 放大约 666MB，spool约 126MB。inode总容量暂未接近耗尽，但 Limcode Runtime 已持有大量系统已用 inode，长期无回收会放大目录、备份、冷 cache 和维护成本。

### 11.4 完整活跃日增长

使用完整的 2026-08-07 样本，不用调查当日的部分日数据外推：

| 子系统 | 新文件 | 表观增量 | 实际分配增量 |
|---|---:|---:|---:|
| CAS | 32,407 | 152.7MB | **243.1MB** |
| process spool | 8,453 | 24.0MB | **50.4MB** |
| **CAS + spool** | **40,860** | **176.7MB** | **293.6MB** |

再加 SQLite 主库增长，当前高强度开发日的总分配增长约为 0.3～0.35GB/活跃日。若使用强度长期不变且没有 retention/GC，月增长可能达到约 9～10GB；这不是自然日承诺值，只是当前活跃日基线的线性外推。

当天 ContentObject 类型归因：

| 类别 | 对象数 | 逻辑字节 | 当天占比 |
|---|---:|---:|---:|
| Context tool pair + ToolModelResult + ToolResultArtifact | 9,592 | 83.7MB | 对象 27.0%，字节 46.8% |
| Model stream checkpoints | 11,250 | 21.3MB | 对象 31.7%，字节 11.9% |
| Model request recipe | 711 | 25.9MB | 对象 2.0%，字节 14.5% |
| process protocol CAS objects | 5,209 | 6.1MB | 对象 14.7% |

三类工具结果事实不必然对应三份物理文件：相同正文会按 digest去重。当天 9,592 个结果 ContentObject 行对应约 6,518 个物理文件、57.5MB表观和72.6MB实际分配。后续收益估算按物理文件而不是简单按三倍计算。

### 11.5 CAS durability 写放大

每个新 CAS 对象当前执行：

```text
ensure tmp child + parent                 2 directory sync
ensure sha256 child + parent              2 directory sync
ensure digest prefix child + parent       2 directory sync
write temporary object                    1 file sync
link final object + sync digest prefix    1 directory sync
delete temporary + sync tmp               1 directory sync
                                           ----------------
                                           9 sync / object
```

即使目录已经存在，`EEXIST` 路径仍同步 child和parent。生产 CAS 已具有全部 digest prefix，因此多数 publish并没有新建目录。完整活跃日 32,407 个新 CAS 文件约对应：

```text
32,407 × 9 ≈ 291,663 次 CAS sync / 活跃日
```

这些 sync 平均值不高，但会在 Provider terminal、ToolResult settlement 和 Context commit 阶段集中爆发。一次 cold 14对象完整 read 的采样中，14次文件 sync累计约12.5ms，112次目录 sync累计约49.7ms；后续同 Application 的常见3对象回合，文件 sync约2.3～4.5ms、目录 sync约6～13ms。设备利用率低并不意味着顺序等待这些 barrier没有延迟。

### 11.6 SQLite WAL 与 TEMP

WAL + `synchronous=NORMAL` 下，普通 commit主要追加 WAL，硬件同步更多发生在 checkpoint/restart边界，不等于每个 transaction都把主库同步一遍。但高层状态颗粒度会触碰大量4KiB表页和索引页，形成明显 WAL写放大。

完整单 read 回合约 1.57MiB WAL的阶段分布：

| 阶段 | WAL写 |
|---|---:|
| Turn admission →首轮 Provider dispatch | 约 394KiB |
| 首轮 Provider build + terminal | 约 109KiB |
| 第一轮 Assistant commit | 约 177KiB |
| Assistant → ToolCall batch | 约 105KiB |
| capability end → ToolResultArtifact | 约 76KiB |
| artifact → ToolOutcome | 约 153KiB |
| ToolModelResult → Context pair | 约 81KiB |
| Context →下一 Provider dispatch | 约 81KiB |
| 第二轮 Provider | 约 97KiB |
| 第二轮 Assistant | 约 189KiB |
| Turn terminal | 约 60KiB |

直接与工具结果 artifact/outcome/Context相关的 WAL约 310KiB，占完整回合约20%。因此 compound snapshot主要减少读请求、IPC和queue；要显著降低写字节，必须减少实际写入的状态/索引页、事务边界或重复payload，而不是只把相同查询换一个API名称。

Runtime worker的 TEMP change-capture会在完整 read中产生约220KiB临时 `pwrite`。对应 `/proc/self/io.cancelled_write_bytes` 约230KiB，通常在落盘前删除，所以 `temp_store=MEMORY` 可以减少逻辑临时I/O，但对当前物理块写收益有限，不是第一优先级。

### 11.7 受控场景 I/O

#### 完整单 1KiB read

真实 AgentLoop、Dispatcher、SQLite/CAS和文件读取，零网络两轮 Provider：

| 指标 | 当前结果 |
|---|---:|
| RuntimeDB requests | 约 205 |
| 普通 transaction | 13 |
| model stream transaction | 4 |
| SQLite WAL写 | **约 1.57MiB** |
| SQLite TEMP写 | 约 220KiB |
| CAS新对象 | **14** |
| CAS sync | **126** |
| CAS正文 | 约 2.7KiB |
| 逻辑读取 p50 | 约 1.89MiB |
| 物理块读取 p50 | **0** |
| 物理块写入 p50 | **约 1.77MiB** |

目标文件正文只有1KiB；硬盘压力几乎全部来自状态持久化而不是 `fs.readFile`。

#### 同批 8 个 read

| 指标 | 单 read | 8-read batch |
|---|---:|---:|
| SQLite WAL写 | 1.57MiB | 1.62MiB |
| SQLite TEMP写 | 220KiB | 220KiB |
| CAS新对象 | 14 | 35 |
| CAS sync | 126 | 315 |
| 物理块写 p50 | 1.77MiB | 2.49MiB |
| 物理块读 p50 | 0 | 0 |

batch使 WAL只增加约3%，每工具分摊块写约从1.77MiB降到311KiB，说明 ToolCall/terminal/Context批处理已经有效。剩余线性增长主要是每个额外readonly结果约增加3个CAS对象，即约27次sync。

#### Provider 100 delta

当前策略只持久化首个普通delta和terminal summary：

| 指标 | 当前结果 |
|---|---:|
| 输入 delta | 100 |
| durable CAS对象 | 2 |
| CAS sync | 18 |
| WAL写 | 约 111KiB |
| 物理块写 | 约 123KiB |
| 物理块读 | 0 |

这条路径相对逐delta持久化已削减约90%以上 durable transaction和约94% CAS sync，不是当前首要热点。

#### 空命令 `true` process control-plane

| 指标 | 当前结果 |
|---|---:|
| CAS对象 / sync | 5 / 45 |
| process spool文件 / sync | 5 / 10 |
| 总显式 sync | **55** |
| SQLite WAL写 | 约 486KiB |
| spool正文 | 约 3.1KiB |
| 父Runtime物理块写 p50 | 约 512KiB |
| 物理块读 p50 | 0 |

最小 spool协议包含 `launch.json`、identity、running/exited manifest和exit receipt，每份都是文件sync+目录sync。CAS仍占空命令显式sync的主要部分。wrapper是独立进程，父Runtime的 `/proc/self/io` 不包含全部spool计数，因此这里用 `strace -f` 补齐。

### 11.8 压力排序

当前硬盘相关热点按优先级为：

```text
1. CAS 每对象 9 次显式 sync 和目录 metadata
2. SQLite WAL 页写、索引写与后续 checkpoint
3. 大量小文件的 4KiB block、inode和目录放大
4. process spool 的固定 durable 文件与无 retention 累积
5. 冷 cache 下的 SQLite/CAS物理读取
6. diagnostics append
```

warm读路径的物理读取通常为0，因此 RootBinding cache和compound snapshot主要改善 syscall、JSON parse、worker queue和CPU，不应被描述为按同比例降低硬盘读字节。diagnostics使用异步批量append且不主动fsync，当前也不是主要durability来源。

### 11.9 分档优化收益

#### A. DB compound snapshot、同 lease复用、定向 convergence

候选：

- 将相邻dependent snapshot合并；
- 同一drive复用刚读取的 Turn、Lease、ModelRequest和frozen authority；
- convergence只推进commit涉及的effect/turn，startup保留full scan。

预计：

| 指标 | 改善区间 |
|---|---:|
| DB requests | **35%～55%** |
| 逻辑读取/syscall | **25%～45%** |
| SQLite worker queue | **20%～40%** |
| 物理读取 | warm基线已接近0，绝对收益有限 |
| WAL写 | **0%～10%** |
| CAS sync / 文件增长 | 基本不变 |
| 实际块写 | **0%～8%** |

关闭 convergence 的单个受控 `strace` 样本中，CAS对象、sync和WAL写与开启时相同，只减少读取/请求；因此这档首先是延迟、CPU和p95优化，不是主要写压力优化。

#### B. CAS已存在目录不重复sync

若启动时durable建立固定 `tmp/sha256/256 prefixes`，后续对象只保留文件sync、final digest prefix sync和tmp目录sync，每对象可从9次降至3次：

| 场景 | 当前 sync | 目标 sync | 降幅 |
|---|---:|---:|---:|
| 完整单 read | 126 | 42 | **66.7%** |
| 8-read batch | 315 | 105 | **66.7%** |
| Provider delta+terminal | 18 | 6 | **66.7%** |
| process CAS部分 | 45 | 15 | **66.7%** |
| process总显式sync | 55 | 25 | **54.5%** |

它主要降低flush barrier和metadata等待，正文块写字节几乎不变。常见3对象热回合预计回收约5～15ms；cold/大batch可回收数十毫秒。风险低到中，必须用crash-point验证新目录首次创建和root切换。

#### C. CAS阶段级group directory sync

N个对象先各自写临时文件并file sync，最后统一sync涉及的digest目录和tmp目录。14个对象分布在不同digest prefix时，预计从126次降到约28～30次，即减少约76%～78%；Provider 2对象可从18次降到约4～5次。只有多个对象命中同一digest prefix时才能进一步合并该目录sync。

保护条件：CAS目录项全部durable之后，SQLite事务才能提交对这些storage key的引用；失败后重试必须按已存在digest幂等。该方案不需要建设新存储格式，是当前最高I/O性价比候选。

#### D. readonly canonical result payload

repeatable readonly工具可保留独立ToolResultArtifact、ToolModelResult和Context事实身份，但共享一份canonical payload/storage key。按当前物理去重后的生产数据估计：

| 指标 | 改善区间 |
|---|---:|
| 每额外read CAS对象 | 约 3 → 1 |
| 每工具增量CAS sync | **约 66.7%** |
| 8-read batch总CAS sync | 315 →约171，**约46%** |
| 完整单read总CAS sync | 126 →约108，**约14%** |
| capability→Context WAL | **20%～35%** |
| 完整回合WAL | **8%～18%** |
| CAS物理增长 | **15%～30%** |

不能删除 ToolCall identity、Lease generation、Provider result顺序或durable terminal；优化的是payload表示和dependent transaction，不是把结果只留在内存。

#### E. terminal checkpoint retention 与 spool GC

全历史checkpoint约：

- 12.5万个物理CAS文件；
- 127.9MB表观；
- 572.3MB实际分配。

其中非终态 output delta/item约11.36万个文件、约505MB实际分配。terminal commit后若按明确保留期prune非终态checkpoint，并用reachability GC删除CAS对象，当前回收上限约为：

```text
约 505MB CAS
+ 约 70～80MB SQLite checkpoint表/索引可回收页
```

普通DELETE只形成freelist，主库文件缩小需要离线rebuild/VACUUM。完整活跃日未来可少累计约8,900个checkpoint文件和40.7MB分配空间，但terminal后prune不减少首次写入时的热路径I/O。

process spool当前约198MB，完整活跃日新增约50MB。输出已完整导入CAS、Process terminal且超过保留期后删除，可把无界增长改为固定时间窗口；同样主要改善空间/inode，而不减少新process的10次最小spool sync。

#### F. 小对象 pack或SQLite BLOB

约85%文件小于4KiB。若把小CAS对象写入append-only pack或专用BLOB存储，多对象共享文件和sync，预计：

| 指标 | 改善区间 |
|---|---:|
| CAS文件创建 | **80%～95%** |
| CAS显式sync | **90%～97%** |
| CAS实际分配增长 | **40%～65%** |
| 总实际块写 | **25%～45%** |
| 长期active Runtime空间 | **35%～60%** |

这是高收益高风险项，需要pack索引、原子尾部、crash recovery、GC/compaction和迁移；不应早于目录sync、canonical payload和retention。

### 11.10 推荐组合

#### 低风险组合

```text
compound snapshot
+ 同lease事实复用
+ 定向convergence
+ 已存在CAS目录不重复sync
```

预计：

- 逻辑读取/syscall降低25%～45%；
- CAS显式sync降低约65%；
- 实际块写降低5%～12%；
- 新文件数量基本不变；
- read本地窗口改善约15%～30%；
- process本地窗口改善约8%～20%。

#### 推荐的中等组合

再加入：

```text
CAS group directory sync
+ readonly canonical payload
+ terminal checkpoint retention
+ process spool retention
```

预计：

- 显式sync降低70%～88%；
- SQLite WAL写降低10%～25%；
- 实际块写降低15%～30%；
- CAS新文件降低30%～50%；
- 日分配增长从约0.3～0.35GB降至约0.15～0.22GB；
- 当前存量可回收约0.6～0.8GB；
- read本地窗口改善约25%～45%；
- process本地窗口改善约15%～30%。

#### 激进存储重构

在中等组合上增加small-object pack/BLOB和完整reachability GC，预计CAS显式sync降低90%～97%、文件创建降低80%～95%、实际块写降低35%～55%、日分配增长降低60%～80%。风险明显更高，不应与调度和settlement大改同批合入。

### 11.11 实施顺序

1. 去掉固定已存在CAS目录的重复sync，并补crash-point测试；
2. 增加阶段级CAS publish/group directory sync；
3. readonly canonical payload与compound settlement；
4. terminal checkpoint retention、process spool retention和dry-run GC；
5. 只有空间/文件数仍成为实际瓶颈时，再建设small-object pack。

不建议为了I/O数字优先把 SQLite `synchronous` 改为 `OFF`、单纯调大checkpoint、建立多writer或取消必要CAS durability。当前主要冗余来自sync粒度、重复payload和无retention，而不是必要的单writer本身。

## 12. 理论收益上限

### 12.1 完整回合

正常完整回合：

```text
模型约 89.16%
全部非模型约 10.84%
```

数学上：

- 删除全部非模型阶段，完整回合最多改善 10.84%；
- 本地非模型减半，完整回合大约改善 5%；
- 但 p50 工具间等待可减少约数百毫秒，交互响应会明显改善。

模型侧若把真实 Provider 段降低 20%，完整回合理论上可改善约 18%，显著大于继续压缩单个本地 snapshot 的收益。

### 12.2 read

read 受控工具窗口中 capability <1%，所以：

- 只优化文件 I/O的理论上限不足 1%；
- 只优化 scheduler/preflight 的上限约 14%；
- settlement + ordered Context 的主要可优化 envelope 约 72%，但其中必要持久化和 Provider 顺序不能全删。

较现实目标：

- readonly 本地窗口改善 30%～45%；
- 生产 read p50 回收约 300～500ms；
- 并发 read 的 DB queue/p95 收益大于单工具 p50。

### 12.3 process

普通 process 中 identity → exit/output drain 约占 24%，其余前后 envelope约 76%。该 76% 是理论控制面上界，不代表都可删除；claim-before-side-effect、stable identity、atomic receipt 和后台恢复仍需保留。

## 13. 优化优先级

### P0：readonly result settlement 与 Context compound path

目标合并：

```text
capability result
→ ToolResultArtifact / Operation
→ ToolOutcome / ToolModelResult
→ Context tool pair
```

建议：

- 同一 lease 内复用刚读取的 Turn、Lease、ModelRequest 和 frozen policy；
- 将多次 dependent snapshot 合为 compound snapshot；
- transaction 直接返回已知的新 Context head，删除立即回读；
- repeatable readonly capability 使用专用 compound settlement；
- clean path transaction-first，UNIQUE/assertion 冲突后才进入 replay 慢路径。

保留 ToolCall identity、Lease generation、Provider result 顺序和单一 durable terminal。

### P0：convergence 按 commit 涉及 ID 定向推进

- effect/turn commit只入队涉及的 ID；
- 不在每次 commit后全扫所有 active Turn；
- startup/recovery full scan继续作为丢失 wake 的 level-trigger兜底。

这项主要改善生产状态规模下的 p95 和 SQLite worker竞争。

### P1：压缩 Provider terminal → ToolCall submit

当前真实 p50 207ms。候选：

- terminal event直接返回 terminal metadata，避免立即重读；
- Assistant transaction返回 Context head；
- ToolCall create合并 replay/Turn/Lease/Message/link snapshot；
- 同一 drive复用 immutable ModelRequest recipe和 authority。

目标先降到约 100～140ms，不通过删除 Lease或 Provider fence伪造收益。

### P1：process exit settlement

优先压缩：

- receipt observation；
- output import；
- process terminalization；
- ToolModelResult/Context publish；
- convergence竞争。

不优先做 persistent shell、多 worker或仅删除双 shell；spawn只占约 2%。

### P2：模型侧

如果目标是降低完整用户等待，应优先评估：

- provider/endpoint/model选择；
- TTFT和首 semantic延迟；
- 推理与输出长度；
- system/context体积；
- endpoint负载、retry和连接复用。

模型占完整回合约 89%，其绝对收益上限远高于继续压缩几十毫秒本地调度。

## 14. 风险边界：可以积极，但不破坏必要不变量

个人/小团队项目可以比企业平台更积极地合并请求、减少预检查和使用 readonly fast path；但以下边界仍有直接 correctness价值：

- Turn ExecutionLease generation fence；
- Provider tool call/result顺序和连续 Context prefix；
- process/MCP/外部副作用的 claim-before-effect、stable identity与 receipt；
- ambiguous外部 effect不自动重发；
- SQLite单 writer和Context head CAS；
- parent abort停止新 admission并传播到 active capability。

本轮不建议为最后 10%～15%收益而：

- 删除 ToolCall/Execution/Lease/Receipt durable facts；
- 让 process/MCP套用 readonly direct lane；
- 取消 Provider result顺序；
- 仅把结果保存在内存；
- 建设通用 DAG、persistent shell池或多 SQLite writer。

## 15. 当前观测缺口

要让后续优化能够精确归因，仍需生产级、低开销的真实边界：

```text
scheduler_enqueued
scheduler_admitted
approval_wait_begin/end
capability_start/end
result_artifact_committed
tool_outcome_committed
context_tool_pair_committed
next_provider_dispatch
```

要求：

- 使用统一 trace/span父子关系或至少稳定 ToolCall/ModelRequest关联；
- scheduler queue和SQLite worker queue分开；
- 高频 DB默认聚合，慢请求/错误再保留明细；
- I/O指标至少区分CAS hit/miss、对象/正文字节、file/directory sync次数与耗时、WAL/checkpoint字节、process spool文件与块分配；
- 基准产物同时保存逻辑I/O、`read_bytes/write_bytes`、`cancelled_write_bytes`和文件/分配块增量；
- 热路径异步导出，不同步 JSON/console/file write；
- Webview跨时钟需校准，不能继续直接相减；
- `tool_dispatch_started/completed`应明确命名为 batch submit/return，避免再次误解为 capability。

在这些埋点进入生产前，read/MCP/child 的 capability只能报告上界，不能把 ToolExecution时间或 batch lifecycle伪装成真实执行时间。

## 16. 最终判定

```text
完整回合慢：主要是模型。
模型已经输出 ToolCall 后慢：主要是 durable settlement、Context与DB竞争。
真正的 read/process capability：通常不是主瓶颈。
并发执行器：当前 8/4/8 已真实生效，helper开销很小。
```

下一阶段应优先减少每个工具前后的 DB状态转换和 convergence争用，而不是继续单纯提高并发度。对完整等待的绝对优化，则应同步处理模型 TTFT、首 semantic和长生成。
