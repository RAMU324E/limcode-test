# Task 连续性与上下文压缩机制研究

> 状态：研究报告与长期设计备选，不是 Reliable Kernel 机器合同；Capsule、Reducer、Manifest 与 Finalization Decision 均为延期项。个人 / 小团队第一版的实施取舍以实用版方案为准。
>
> 面向个人 / 小团队的精简实施版本见：[Task 连续性与上下文压缩：实用版落地方案](./TASK_AND_CONTEXT_COMPACTION_PRACTICAL_PLAN.md)。
>
> 研究快照：LimCode `9138ed39b80f706bcd595d143b085fceb2cf0959`；Claude Code 2.1.88 sourcemap `a8a678cb6244e6770e1e421767ff0987a1d95549`；Codex `2b5bdcf67547860f2e5c5a605009a70026796b2b`；OpenCode official `dev` `38e10eb1408feb700021b8e8766fb0ab41bf84e2`。
>
> 修订日期：2026-08-09。
>
> 研究目的：解释“Task 列表仍有未完成任务，但 Agent 已整体结束，且压缩后更明显”的机制原因，并提出可实施的改进方案。
>
> 证据边界：本文确认了能导致该现象的结构性缺口，但尚未用同一生产会话完成“压缩开启/关闭”的对照复现。因此“压缩放大提前结束”属于高可信机制推导，不应表述为已经完成因果归因。
>
> 实施后说明：本文第 1 节及后文出现的“当前实现”均指上述研究快照的实施前基线。任务操作严格校验、typed Runtime Delivery、replacement summary、完整请求预算等缺口已由实用版修复；保留这些段落是为了说明改动原因，不代表 2026-08-09 落地后的现状。

## 1. 执行摘要（实施前基线与当时结论）

本次排查得到的核心结论如下。

1. LimCode 当前的 Task List 是从 `update_task_list` / `submit_plan` Tool facts 派生的**语义投影**，不是任务调度器，也不是 Turn 终止权威。模型无 ToolCall 输出 final 时，当前正常路径不会读取 Task Snapshot 来阻止结束。
2. 当前 Task 投影本身还不能直接升级为终止门禁：可靠 dispatcher 没有完整校验 `mode`，投影没有 Task generation/current intent 作用域，retry/edit/delete 后的旧事实和 `change_requested` Plan 也需要先定义可达性与激活规则。
3. Reliable Kernel 压缩默认保留最近 **8 个 `message` 边界**，不是最近 12 条工具消息，也不是最近 8 次工具执行。如果配置改成 12，其语义仍然是 12 个 message 边界。
4. `tool_pair` 和 `runtime_context` 不参与保留数量计算，却会跟随位置进入摘要前缀或原样尾部。尾部没有 Token 硬上限；`runtime_context` 还会在 Provider 适配器中退化为 `user` 消息并影响分段摘要边界。
5. 当前 Task、Process、Child、Approval 等状态没有形成一个从各自权威事实派生、随 ModelRequest 冻结、可精确重放的模型投影。不能把 UI 投影或一个新的 Capsule 当成第二套权威。
6. 重复执行 `segmented_summary` 时，首个旧 Compression 会**确定性地**同时进入 `priorSummaryContents` 和待总结 `segments`。即使去掉双重输入，当前“旧摘要逐字 + 新增摘要”的拼接方式仍没有最终 Summary 硬上限。
7. 压缩前后的 Token 统计可能不是同一口径：压缩前可能是包含 System/Tool Schema 的 Provider observed prompt，压缩后却只计算 Summary + Context tail。当前“压缩成功”只保证估算结果比原来小，不保证落到压缩阈值或安全请求窗口内。
8. Claude Code、Codex 与 OpenCode 没有统一的“摘要 + 原文尾部 + 当前状态”默认算法。可稳定借鉴的是：每个预算必须声明作用域，旧活动历史由有界替代内容接管，仍然有效的当前上下文按具体路径重新投影。Claude 的 40k、Codex Remote v2 的 64k、OpenCode V1/V2 的 8k recent budget 都不能解释为完整 Provider 请求的绝对硬上限，也不能拿来直接取平均值。
9. 长期完整设计可将模型输入规划为（不是当前第一版实施范围）：
   - 从既有权威事实派生并随请求冻结的 `Canonical Projection Capsule`；
   - 有最终输出上限的 `Semantic Summary`；
   - 连续、结构原子且受剩余请求预算约束的 `Verbatim Tail`；
   - 以 immutable reduction artifact 表达的 `Tool / Runtime Evidence`。
10. Task 连续性应先通过 Snapshot 回注、投影修复和 telemetry 解决。只有在 Task generation、异步 handoff、用户暂停和结构化 final disposition 均闭合后，才能增加“一次软提醒 + 有界收尾”的 Finalization Decision；不能简单规定“有 pending 就禁止当前 Turn 结束”。
11. OpenAI standalone Compact 应接收完整模型可见历史并原样接管返回的 canonical window，不采用“native 旧前缀 + LimCode 本地旧 tail”的混合；已交付的 Process / Child 结果进入历史，活动状态在 output 后重新投影，内部控制记录排除。
12. 面向当前个人 / 小团队项目，已选择更小的第一版边界：48k 动态文字对话主体、8k replacement summary、2k 当前 Turn 提醒卡、4k/16k 工具结果预览、完整请求 preflight；不实施 Capsule/Manifest、新表、跨 Turn Task 或 final hard gate。

---

## 2. 背景与问题定义

### 2.1 观察到的现象

用户观察到：

- Task 列表中仍有多个未完成任务；
- Agent 却已经输出最终回答并结束整个 Turn；
- 长任务、工具调用多的任务更容易出现；
- 上下文压缩之后问题似乎更明显。

相关疑问包括：

- 是否保留所有用户消息；
- 是否原样保留最近 12 条工具执行消息；
- 后台任务和 Sub Agent 注入是否被排除；
- 工具执行消息是否值得按固定数量原样保留。

### 2.2 必须区分的三类状态

```text
Authoritative Sources
  ├─ Runtime SQLite facts / CAS / external receipts
  ├─ Frozen configuration AuthoritySnapshot
  ├─ UI Projection：给用户看的历史和 Task List
  ├─ Model Request Projection：下一次模型请求真正看到的内容
  └─ Execution Control Decision：决定 Turn 能否继续、等待或终止
```

Task Tool facts 可以持久存在并被 UI 投影，但这不代表：

- 模型在压缩后仍能看到它；
- Turn 终止逻辑会读取它；
- `pending` 会自动调度下一项工作；
- `in_progress` 会阻止模型 final。

### 2.3 结论标记

本文区分四类表述：

- **代码事实**：可由当前源码直接确认；
- **复现证据**：有冻结输入、输出和控制流的端到端样本；
- **风险推导**：由代码事实可构造出的失败场景，不代表已有完整生产复现日志；
- **设计建议**：建议的新语义，不代表当前实现。

本文目前主要包含代码事实与风险推导。要把“压缩后更容易提前结束”升级为生产根因结论，还需要保存同一任务在压缩开启/关闭时的 pre-final ModelRequest、Context root、Task projection revision、Summary 内容和最终 Provider 输出。

---

## 3. LimCode 当前 Task 机制

### 3.1 Task List 的职责与派生来源

**代码事实：** 工具定义明确说明：

> This tool only records structured task list operations; it does not modify workspace files.

相关代码：

- `backend/world/modules/tools/definitions/taskList/index.ts:69-107`
- `backend/reliableKernel/toolDispatcher.ts:872-876`
- `backend/reliableKernel/toolInteractions.ts:728-740`

调用链大致为：

```text
Model calls update_task_list
  ↓
ToolCall / ToolOutcome 持久化
  ↓
根据 rewrite / update 操作推导当前 Task Snapshot
  ↓
ClientFeed 投影到前端
```

当前快照投影主要位于：

- `backend/reliableKernel/databaseWorker.ts:2571-2682`
- `backend/reliableKernel/databaseWorker.ts:2785-2860`
- `backend/reliableKernel/clientFeed.ts:2372-2374`

因此 Task List 当前首先是一个**被动状态投影**。

还需注意两个当前实现细节。

第一，`projectCurrentTaskList()` 同时接受成功或 partial 的 `update_task_list` 与带 `taskList` 的 `submit_plan`：

- `backend/reliableKernel/databaseWorker.ts:2785-2860`

这意味着 Plan proposal 内的 Task 也可能参与当前投影。是否应激活它，必须结合 Plan 的 `approved / change_requested / rejected` 结论，而不能只看 ToolOutcome 为 `succeeded`。

第二，Reliable dispatcher 的 `update_task_list` 特殊路径只提取 `items` 交给 settlement，没有在该边界持久化完整规范化的 `{ mode, items }`：

- `backend/reliableKernel/toolDispatcher.ts:872-880`
- `backend/reliableKernel/toolInteractions.ts:728-740`

因此“ToolCall 成功结算”和“投影能解析并应用完整 operation”目前不是同一个不变量。把 Task 用于任何控制决策前，必须先在唯一写入边界完成 schema 校验和 canonical operation 持久化。

### 3.2 Task List 不是调度器

Task 状态允许：

```text
pending
in_progress
completed
blocked
cancelled
```

但这些值当前主要用于校验和展示。没有发现以下通用调度语义：

```ts
if (task.status === 'pending') {
  automaticallySchedule(task)
}
```

所以：

- `pending` 表示记录中的待办，不代表已经进入执行队列；
- `in_progress` 表示模型曾写入此状态，不代表系统拥有对应执行 Lease；
- Task List 不会替代 Agent 自身继续调用模型和工具。

### 3.3 Task List 不是正常 final 的终止门禁

**代码事实：** 对当前 Reliable Kernel 的 Agent Loop、Turn Output、Turn Control 和工具结算路径进行检查，没有发现正常模型 final 之前读取 `currentTaskList` 并拒绝结束的逻辑。

当前 terminal transaction 主要直接保护：

- 未结算 ToolCall；
- terminal-blocking PendingTurnInput；
- 未终态 ModelRequest；
- 未收口的文件变更等可靠执行事实。

Interaction、Runtime Delivery、ChildExecution、Process 是否阻止当前 Turn 结束，取决于它们是否仍映射成上述 blocking fact。后台 Child 或 detached Process 本身不天然阻止父 Turn final；例如 `run_agent` 明确允许 Child 继续后台运行，同时父 Turn 结束并等待之后的 Delivery。

这些保护不等于 Task 完成检查，因此可以出现：

```text
Task A: completed
Task B: in_progress
Task C: pending

Model emits final answer
  ↓
没有 Task-aware finalization decision
  ↓
Turn terminal
```

这是当前语义允许的结果，不只是前端显示错误。

### 3.4 压缩为何可能放大问题

**风险推导：** 以下链路与当前实现一致，但仍需端到端样本确认它在具体生产会话中的发生频率。

压缩前，模型可能通过原始 Tool Exchange 看到：

```text
update_task_list(...)
task_list.result(...)
```

压缩后，这些内容可能：

- 被摘要模型完整保留；
- 被概括成“更新了任务列表”；
- 被遗漏；
- 留在原样尾部；
- 在重复摘要中发生状态漂移。

与此同时，前端 `currentTaskList` 会从 Conversation 范围的持久化 ToolCall 历史独立重建，于是可能出现：

```text
UI：Task B 仍然 in_progress
Model Context：没有可靠的 Task B 状态
```

模型输出 final 后，执行控制又不检查 Task Snapshot，最终表现为“Task 没完成，但整体结束”。

但 UI 投影也不能未经校验就被假定为绝对正确。当前查询需要补充以下语义：

- retry/edit/delete 后，旧 ToolCall 是否仍从当前 Context lineage 可达；
- 新用户任务是否开始新的 Task generation；
- `submit_plan` 只有 approved 后才激活，还是 proposal 阶段也展示；
- fork 后继承的是历史展示、活动 Task，还是二者的显式 Link；
- ToolPolicy 禁用 Task 工具时，如何结束或修正已有 Task。

### 3.5 历史实现曾附加 Task Snapshot

旧 `ModelContextProjector` 中存在：

- `compressionTaskListSnapshot()`；
- `buildTaskListTimeline()`；
- `formatTaskListSnapshotForContext()`。

位置：

- `backend/modelContext/modelContextProjector.ts:912-947`

它会在压缩时重建 Task Snapshot 并作为 Addendum 提供给压缩上下文。但该投影路径已被标记为迁移来源和历史记录：

- `docs/model-context-projection.md:1-5`

当前 Reliable Kernel ContextSequence 路径中没有发现等价的 Task Snapshot 规范回注。这可能是切换运行时后 Task 连续性退化的来源之一。

### 3.6 在 Task 进入控制面前必须闭合的语义

Task List 已由 Tool facts 派生，不应再建立一张平行 Task authority 表。需要新增的是**派生投影的作用域与使用合同**：

```text
Task operation facts
  + current Context lineage
  + Plan decision
  + Task generation / current intent
  + projection revision
  → Canonical Task Projection
```

至少应满足：

1. 每次 operation 在 settlement 前完成完整 schema 校验；
2. retry/edit/delete 后，被当前 Context 排除的 Task operation 不得继续控制新 Turn；
3. 新任务可显式开始新 generation，旧 pending 不得约束无关请求；
4. `change_requested/rejected` Plan 不激活执行 Task；
5. `blocked` 表示工作未完成，不等于当前 Turn 必须继续；是否允许结束由独立 Finalization Disposition 决定；
6. Snapshot 带来源 revision，可与 final fence 在同一 writer 决策中校验，避免 TOCTOU。

---

## 4. LimCode 当前压缩机制

### 4.1 默认配置

相关定义：

- `shared/protocol.ts:518-550`
- `shared/protocol.ts:614-632`

当前默认值包括：

```text
contextWindowTokens            = 200,000
compressionTriggerPercent      = 90%
reserveLatestUserMessageTokens = 20,000
preserveLatestMessages         = 8
compressionKind                = segmented_summary
```

这些是协议与新建默认配置的基线；某个 Turn 的实际窗口、阈值、Provider 和压缩策略以该 Turn 的 frozen AuthoritySnapshot 为准。

需要注意：

- 活动选择器实际消费的是 `preserveLatestMessages`；
- `reserveLatestUserMessageTokens` 被协议、存储和 UI 推荐阈值使用；
- 没有发现它进入 Reliable Kernel 的压缩边界选择或形成后端硬保证。

相关路径：

- `backend/reliableKernel/vscodeConfigurationAuthority.ts:802-848`
- `backend/reliableKernel/frozenAuthority.ts:30-42`
- `backend/reliableKernel/frozenAuthority.ts:139-179`
- `webview/src/components/settings/global/LlmCompressionSettingsEditor.vue:86-107`

因此 `reserveLatestUserMessageTokens` 容易让人误解为“后端保证给最新用户消息保留 20k Token”，但当前更接近 UI 的推荐触发储备值。

### 4.2 ContextSequence 结构

当前 Context Segment 种类为：

```ts
type ContextSegmentKind =
  | 'system'
  | 'message'
  | 'tool_pair'
  | 'compression'
  | 'runtime_context'
```

位置：

- `backend/reliableKernel/contextSequence.ts:18-25`

主要语义：

- `message`：用户或模型消息；
- `tool_pair`：一组 ToolCall / ToolResult 事实；
- `compression`：已经生成的结构化摘要；
- `runtime_context`：后台任务、Child Answer、Process Completion 等运行时注入；
- `system`：系统上下文。

每个并行工具结果通常形成独立 `tool_pair` Segment：

- `backend/reliableKernel/contextSequence.ts:270-339`
- `backend/reliableKernel/contextSequence.ts:347+`
- `backend/reliableKernel/agentLoop.ts:800-852`

### 4.3 自动压缩选择算法

核心位置：

- `backend/reliableKernel/contextCompressionCoordinator.ts:99-116`
- `backend/reliableKernel/contextCompressionCoordinator.ts:241-260`

算法可简化为：

```ts
function selectCompressionPrefix(records, preserveLatestMessages) {
  const messageIndexes = indexesOf(records, segmentKind === 'message')
  const retainedMessages = Math.max(1, preserveLatestMessages)

  if (messageIndexes.length === 0) {
    return records.length > 1 ? records.length - 1 : 0
  }

  if (messageIndexes.length <= retainedMessages) {
    return 0
  }

  return messageIndexes[messageIndexes.length - retainedMessages]
}
```

然后闭合工具边界：

```ts
while (cut > 0 && records[cut]?.segmentKind === 'tool_pair') {
  cut -= 1
}
```

最终：

```text
summary source = records[0 .. cut)
verbatim tail  = records[cut .. end)
```

默认 `preserveLatestMessages = 8` 的准确含义是：

> 保留最近 8 个 `message` Segment，并原样保留这些 message 之间和之后的所有 `tool_pair`、`runtime_context` 等 Segment。

它不是：

- 最近 8 个用户回合；
- 最近 8 次工具执行；
- 最近 12 条 Tool Result；
- 所有用户消息原样保留。

本次搜索当前仓库和相关 Git 历史，没有找到“正式实现固定保留最近 12 条工具消息”的代码。如果本地持久化配置将值改成 12，其语义仍然是 12 个 message 边界。

### 4.4 工具边界保护的能力和局限

`closeToolExchangeBoundary()` 会在切点落到模型 ToolCall 与后续 `tool_pair` 之间时，将对应模型消息一起移入原样尾部。

它能够：

- 避免直接制造孤儿 Tool Result；
- 多个连续 `tool_pair` 时退回到前面的模型消息。

在正常 Agent Loop 写入路径中，Thought、Text 和同一次响应的 ToolCall 位于同一个 Assistant `message`，Tool Pair 随后按 Provider ordinal 连续附加；Runtime Delivery 也显式避免插入 Assistant Message 与 Tool Result 之间。因此正常路径已经具备较强的 API-round 原子性，不能笼统表述为“完全不保证同一 API Response”。

当前真正的局限是：

- 尾部 Token 有界；
- 只保留语义重要的工具结果；
- 大结果被归约或替换为内容句柄。
- 通过 `ModelRequest / ToolCallSourceLink / provider ordinal` 身份验证 group 归属，而不只依赖相邻 `segment_kind`；
- 非规范 append、人工 prefix 或损坏序列仍满足同样的机器不变量。

### 4.5 压缩结果如何替换上下文

压缩 Provider 只看到选择出的前缀：

- `backend/reliableKernel/modelProviderControlPlane.ts:477-501`
- `backend/reliableKernel/llmCapabilityProviderAdapter.ts:484-536`

Provider 返回的 `MessageContent[]` 被写入 Compression Segment，新上下文由以下两部分组成：

```text
Compression Segment
+
原样 Tail
```

相关代码：

- `backend/reliableKernel/contextCompressionCoordinator.ts:153-189`
- `backend/reliableKernel/contextCompression.ts:143-278`

下一次普通模型请求会展开 Compression Segment 和原样 Tail：

- `backend/reliableKernel/modelProviderControlPlane.ts:418-502`
- `backend/reliableKernel/llmCapabilityProviderAdapter.ts:359-386`

### 4.6 `finite_tail` 和 `non_reducing`

当没有可压缩前缀时返回：

```text
reason: finite_tail
```

典型情况是 message 数不超过保留数，即使其中存在很大的工具结果。

当前协调器近似比较：

```text
summaryTokens + tailTokens >= originalTokens
```

协调器返回：

```text
reason: non_reducing
```

位置：

- `backend/reliableKernel/contextCompressionCoordinator.ts:157-169`

这能避免同一冻结 Head 上无限重复调用压缩 Provider，但需要注意两个边界。

第一，`originalTokens` 可能来自 Provider observed prompt，包含 System Prompt 和 Tool Schema；`summaryTokens + tailTokens` 当前却只包含 ContextSequence 内容。两边不一定是同一统计口径，不能把上式解释成完整请求严格缩小。

第二，幂等键包含 `headRootId`。只要随后追加一个 Message 或 Runtime Segment，即使可压缩前缀和巨大尾部几乎没变，也可能对新 Head 再次付费并得到 `non_reducing`。失败诊断应按 `(sourceHash, frozen policy, provider binding, reducer revision)` 缓存，直到 eligible prefix 实质变化。

### 4.7 “压缩成功”不等于请求已安全

当前协调器只要求：

```text
projectedEstimatedTokens < originalEstimatedTokens
```

它没有要求压缩后一定满足：

```text
completeRequestTokens <= contextWindowTokens - outputReserve - safetyMargin
```

也没有要求 `projectedEstimatedTokens < compressionThresholdTokens`。Agent Loop 对 `finite_tail`、`non_reducing` 等 skipped 结果没有 Reducer/fallback，随后仍会创建普通 ModelRequest。

因此当前可能出现：

- 压缩提交成功，但下一次完整请求仍超出安全窗口；
- 压缩被跳过，随后原样发送已经过大的上下文；
- 压缩 Provider 的输入自身过长而失败。

设计目标必须从“摘要比原来小”提升为“完整序列化 Provider 请求满足冻结预算，或给出明确、可恢复的不可行结论”。

---

## 5. 主要失败模式

### 5.1 固定 message 数不是 Token 预算

#### 场景 A：一次响应并行调用大量工具

```text
User Message
Assistant Message: tool call × 100
Tool Pair × 100
Assistant Message
```

message 边界很少，但工具结果可能达到数十万 Token。只要 Assistant Message 落入最近保留区间，相关 Tool Pair 就可能全部留在原样尾部。

#### 场景 B：单个超大结果

```text
User Message
Assistant Tool Call
Bash/Read Result: 100k tokens
Assistant Message
```

固定 message 数无法限制这一条结果。

#### 场景 C：message 很少但工具很多

如果总 message 数为 1～8，选择器返回 0：

```text
large context + no eligible prefix = finite_tail
```

单个人类请求内部运行很久、工具很多的 Agentic Workload，反而可能最难压缩。零 `message` 是一个例外：当记录数大于 1 时，选择器会保留最后一个 Segment 并尝试压缩前缀。

### 5.2 不同工具的语义价值不同

| 类型 | 示例 | 合理处理 |
|---|---|---|
| 可重新读取的大文本 | `read`、`grep`、`web_fetch` | 摘要、Head/Tail、可解析的 ContentObject 句柄 |
| 大量过程日志 | `bash`、测试日志 | 命令、退出状态、关键错误、输出尾部、可解析的完整输出句柄 |
| 修改证据 | `edit`、`write`、Patch | 文件、Receipt、Hash、结果状态，必要时保留小型 Diff |
| 控制状态 | Task、Approval、Plan | 规范状态回注，不依赖原始 Tool Result |
| 后台标识 | `processId`、`answerBridgeId` | 结构化保留直到消费或终止 |
| 重复通知 | Completion Envelope、Heartbeat | 消费后排除 |

当前按位置切割无法表达这些差异。

### 5.3 摘要 Prompt 不能替代 Canonical Task Projection

当前通用 Summary Prompt 要求保留状态和下一步，分段 Prompt 还要求保留：

- 用户意图；
- 工具调用及主要结果；
- 结论和决定；
- 回合结束状态、遗留任务和下一步。

位置：

- `shared/protocol.ts:530-550`

这些 Prompt 有价值，但不能形成强保证：

- Summary 是概率输出；
- Task 状态可能被概括或遗漏；
- 多次摘要后状态可能漂移；
- Summary 不能替代从当前 Context lineage、Plan decision 和 Tool facts 确定性派生的 Task Snapshot。

### 5.4 重复 `segmented_summary` 的确定性双重输入与无界拼接

**代码事实：** 当前适配器解析 Compression Segment 时，会把解码内容同时加入普通 `contents`、分段 `segments` 的累积内容和 `priorSummaryContents`：

- `backend/reliableKernel/llmCapabilityProviderAdapter.ts:484-536`

随后分段摘要：

- 使用 `priorSummaryContents` 作为第一段“前情”；
- 使用 `segments` 作为“本回合记录”；
- 最后把旧摘要逐字拼到新摘要开头。

位置：

- `backend/capabilities/llmProvider.ts:1636-1665`
- `backend/capabilities/llmProvider.ts:1815-1848`

因此重复压缩时，旧摘要会同时出现在：

```text
【前情】旧摘要
【本回合记录】旧摘要 + 新记录
```

然后输出：

```text
早前对话摘要：旧摘要
回合 1：再次总结过的旧摘要
```

直接后果：

- 重复摘要；
- 压缩结果逐轮增长；
- Task 状态和用户约束逐轮改写；
- 更容易触发 `non_reducing`；
- 分段摘要 Token 预算被旧内容重复占用。

现有检查验证了 `contents` 和 `priorSummaryContents` 都存在，但没有覆盖“旧摘要不得再次进入 source segment”的不变量，应补独立回归测试。

修复双重输入后仍有第二个独立问题：当前最终结果机械拼接为：

```text
previous summary 原文
+
本轮各 segment 摘要
```

`targetTokens` 只用于分配本轮 segment call，不限制逐字加入的 previous summary，也不限制最终 joined 输出。因此必须分别建立：

1. previous summary 不进入 source segment；
2. `previous summary + delta summary` 的最终产物有绝对最大预算；
3. 超预算时进行整体重新归并或确定性降级，而不是继续逐字累加。

### 5.5 完整请求预算缺失

Tail、Summary 或 retained message 的局部预算不能替代完整请求预算。至少需要统一计算：

```text
system / developer instructions
+ tool schemas and provider framing
+ canonical projection capsule
+ semantic summary
+ verbatim tail
+ current user/runtime input and media
+ output reserve
+ estimator safety margin
```

还要覆盖超大 Assistant text、Thinking、ToolCall arguments、图片/文档和 Provider-specific signature；不能只归约 Tool Result。任何 mandatory item 超限时都必须有明确策略：内容对象化、可验证截断、请求用户缩短或 fail closed，不能静默改写精确用户约束。

---

## 6. 后台任务和 Sub Agent 注入

### 6.1 Runtime Delivery 阶段

```ts
type RuntimeDeliveryPhase =
  | 'current_turn'
  | 'next_turn'
  | 'notify_only'
```

位置：

- `backend/reliableKernel/answerDelivery.ts:34`

概括：

- `current_turn`：当前 Turn 在安全边界吸收并继续模型循环；
- `next_turn`：附加到下一次普通 Turn；
- `notify_only`：只形成通知，不做模型输入注入。

### 6.2 注入后的存储形态

`current_turn` / `next_turn` 的 PendingTurnInput 被 Agent Loop 吸收后写为：

```text
segmentKind: runtime_context
```

位置：

- `backend/reliableKernel/agentLoop.ts:1099-1142`

所以它们没有被压缩机制统一排除。`selectCompressionPrefix()` 只统计 `message`，不统计 `runtime_context`，导致 Runtime Context：

- 在切点之前时进入压缩 Provider 输入；
- 在切点之后时原样保留；
- 不独立消耗 `preserveLatestMessages` 数量。

这是一种位置偶然性，而不是语义策略。

还有一个容易被忽略的角色问题。普通请求和压缩请求在展开未知/运行时 Segment 时，会根据 `messageRole` 回退；`runtime_context` 的 role 为 null，最终被物化为 `user` 内容：

- `backend/reliableKernel/llmCapabilityProviderAdapter.ts:359-386`
- `backend/reliableKernel/llmCapabilityProviderAdapter.ts:509-536`

因此 Runtime Context 不只会按位置被保留或摘要，还可能：

- 被模型误解为普通用户消息；
- 命中 `hasOrdinaryUserPart()` 并切开 segmented summary；
- 改变 segment call 数量与 prior context 选择。

Agent Loop 会在新 ModelRequest 边界先吸收 Runtime Delivery，再执行压缩，因此一次新 Delivery 首次进入时通常位于最新尾部；只有后续压缩才可能把它纳入 source。设计时应为 Runtime Projection 使用明确 typed envelope/trust label，而不是依赖 user-role 文本。

### 6.3 Process Completion 的大小控制

Process Completion 有独立限制：

```text
PROCESS_COMPLETION_MAX_PAYLOAD_BYTES = 12,000
PROCESS_COMPLETION_MAX_OUTPUT_BYTES  = 8,000
```

位置：

- `backend/reliableKernel/processCompletionDelivery.ts:17-19`

它能控制单条进程完成通知的大小，但不能解决多个通知累积、已消费通知留存、Child Agent Answer 大小和活动状态回注问题。本次搜索没有发现 Child Agent Answer 对应的同类独立硬预算；若存在其他上层限制，实施时还需继续确认。

“未读取 Child Answer”不是当前可直接查询的可靠状态。`read_agent_answer` 的 `readCurrent()` 明确为 read-only，不消费 RuntimeInbox，也不改变 Delivery。当前能精确表达的是 AnswerSubmission、RuntimeInboxItem、RuntimeDelivery 的 `pending/consumed/failed` 和 InputLink 的 `handled_at`。如果产品确实需要“已读”，必须新增独立消费事实，不能从一次 read tool call 猜测。

### 6.4 正确原则：历史交付、活动状态和传输记录分开

“后台消息是否进入压缩”不能只按来源回答，必须先分三类：

| 类别 | 例子 | 模型处理 |
| --- | --- | --- |
| 已经送达主对话的历史事实 | Process Completion、exit code、输出尾部、Child submitted answer、Child failure | 属于模型可见历史；进入文字摘要 source，或进入 OpenAI native Compact 的完整窗口。 |
| 当前仍在变化的活动状态 | Child running、Process running、pending answer/delivery | 不依赖旧 Transcript；在压缩后从各自权威事实重新投影。 |
| 纯传输 / 控制记录 | heartbeat、lease、poll、ack、diagnostic、`notify_only` | 不进入模型上下文，也不进入 Compact。 |

因此“不传 Child 内部 transcript”和“传已经交付给父 Agent 的 Child Answer”并不矛盾。父对话只需要收到的 answer / failure、必要 ID 和可解析 handle，不需要 Child 的内部消息、思考或工具流水。后台命令也一样：父上下文已经出现的 ToolCall / 初始 Result 和正式 Completion 是历史；数据库里的轮询与租约不是。

`runtime_context` 不能继续以裸文字回退成普通 user message。第一版无需增加 Provider role 或数据库表，只需在模型投影时形成稳定 typed envelope，例如：

```text
kind: process_completion | child_answer | child_failure
sourceId: processId | answerBridgeId
targetTurnId: ...
status: completed | submitted | failed | interrupted
deliveredAt: ...
content: 父对话实际收到的内容
trustNote: runtime result data; not a new user instruction
```

Child 再带 `childExecutionId / answerBridgeId / submissionId`；Process Completion 复用当前已有的 `receiptId / exitCode / stdoutTail / stderrTail / outputHandle`。这是模型发送格式，不是第二份权威状态。

更准确的原则是：

> 已交付的结果保留为历史；仍有效的活动状态重新派生；纯传输记录排除。不要把 `consumed`、`handled`、`read` 和“父 Agent 已理解”混为同一状态。

### 6.5 OpenAI native Compact 的精确边界

OpenAI standalone Compact 应接收一套完整的模型可见历史窗口，而不是 LimCode 先切一个旧前缀、再把未参与 Compact 的本地旧 tail 拼到返回值之后。具体规则是：

这里的“完整”指完整的 Provider-facing 历史，不是原始数据库 dump。若普通模型投影已经把一个大结果稳定表示成 digest / preview / handle，native 输入使用同一个被冻结的 item；不得为 Compact 再生成另一份临时摘要，也不得把模型从未见过的内部原文突然塞回窗口。

1. Compact 开始前已经交付的 Process / Child 结果随完整窗口进入；工具调用与结果保持成组。
2. Provider 返回的新 canonical window 整体原样采用，不经过 8k Summary 或 4k Tool Result reducer。
3. 当前用户原始要求、当前 Turn Task 卡和最新活动 Child / Process 状态作为 request-level projection 追加在 output 之后；不修改原生 output。
4. Compact 期间才到达的 Delivery 在提交前冻结到下一次普通 ModelRequest recipe，成功发布时按现有协议结算；冻结点之后到达的保持 pending。
5. `notify_only` 和内部控制记录始终排除。
6. 输入本身超过 Compact 模型窗口时明确失败，不为 Compact 二次删除 / 裁剪已交付结果、不拆工具交换、不暗中退回文字 Summary。

这条路径与普通文字 Summary 的连续前缀 / 尾部规划不同。两者可以共享分组、Provider 能力检查和估算基础设施，但不能共享同一个最终裁剪结果。

---

## 7. Claude Code 2.1.88 研究结果

Claude Code 有多条压缩路径，部分路径和工具微压缩受 Feature Gate 或环境变量控制，不能简单概括为一个固定算法。

### 7.1 标准全量摘要

标准 `compactConversation()` 将待压缩消息交给模型生成结构化 Summary：

- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/compact.ts:383-491`

压缩 Prompt 明确要求包含：

- 所有非 Tool Result 用户消息；
- Pending Tasks；
- Current Work；
- Optional Next Step；
- 文件、代码、错误和用户反馈。

位置：

- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/prompt.ts:61-77`

标准完整路径返回：

```text
boundary marker
summary message
post-compact attachments
hook results
```

位置：

- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/compact.ts:596-624`
- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/compact.ts:738-748`

标准 full compact 路径本身不返回 `messagesToKeep`；近期原文保留由 Partial、Reactive 或 Session Memory 等其他路径负责。

当压缩请求本身 Prompt Too Long 时，Claude 按 API-round 分组从头截断并重试：

- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/compact.ts:462-490`

### 7.2 实验性 Session Memory 尾部

默认配置：

```text
minTokens            = 10,000
minTextBlockMessages = 5
maxTokens            = 40,000
```

位置：

- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/sessionMemoryCompact.ts:44-66`

近期尾部选择：

- 从最新内容向前扩展；
- 至少满足最小 Token；
- 至少保留一定数量含文本消息；
- 达到 `maxTokens` 时停止继续主动回扩；
- 不切开 Tool Use / Tool Result；
- 不切开共享同一 Assistant message ID 的 Thinking / Tool Chunks。

位置：

- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/sessionMemoryCompact.ts:188-396`

该功能由两个默认值为 `false` 的 Gate 控制：

- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/sessionMemoryCompact.ts:399-431`

所以它是重要参考方向，但不是所有 Claude Code 用户的固定默认行为。

这里的 `maxTokens = 40,000` 不是严格硬上限：

- 未摘要尾部本身已经超过 40k 时仍会整体保留；
- 一整条 Message 加入后可能越过 40k；
- Tool Use/Result 与同 Assistant ID 修复会继续向前移动起点。

因此只能把它称为“回扩停止阈值”，不能用来证明最终尾部严格小于 40k。

### 7.3 Prompt Too Long 重试的 API-round 分组

Claude 按 Assistant API Response ID 分组，而不是只按人类用户回合分组：

- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/compact.ts:230-290`
- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/grouping.ts:3-63`

这样可以在传统压缩请求自身 Prompt Too Long 时，按比人类用户回合更细的边界从头删除并重试，避免单个人类回合无法切割。当前恢复源码中该 helper 的直接调用属于 PTL retry；Session Memory 使用的是另一套 Tool Pair / Assistant ID 起点修复，不能把 API-round helper 描述成所有 Claude 压缩路径的统一算法。

### 7.4 工具微压缩

Claude 对旧工具结果有独立 Microcompact 层。

时间型 Microcompact 在长时间空闲、Prompt Cache 已失效后清理旧结果：

- 默认 `keepRecent = 5`；
- 默认 `enabled = false`。

位置：

- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/timeBasedMCConfig.ts`
- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/microCompact.ts:401-529`

API Native Context Management 可以生成按 Token 阈值触发的 Provider 策略：

```text
trigger ≈ 180,000 tokens
target  ≈ 40,000 tokens
```

当前源码可直接确认：

- 只有 `USER_TYPE=ant` 才进入工具清理分支；
- `USE_API_CLEAR_TOOL_RESULTS` 生成 `clear_tool_inputs=[Shell, Glob, Grep, Read, Web...]`；
- `USE_API_CLEAR_TOOL_USES` 生成另一策略，并设置 `exclude_tools=[Edit, Write, NotebookEdit]`；
- 默认 `trigger=180k`，`clear_at_least=140k`，均可被环境变量覆盖。

位置：

- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/apiMicrocompact.ts:14-32`
- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/apiMicrocompact.ts:63-152`

这些字段最终由服务端如何执行不能仅靠客户端源码反推，但它们仍体现了关键原则：工具证据应按工具语义处理，而不是统一按位置保留。

### 7.5 传统 Full/Partial 路径的压缩后状态回注

传统 Full/Partial 路径会确定性恢复：

- 最近读取文件，带文件数和 Token 预算；
- Plan 文件；
- Plan Mode；
- 已调用 Skills；
- Deferred Tool 状态；
- 异步 Agent 状态。

文件恢复限制示例：

```text
最多 5 个文件
单文件最多 5,000 tokens
总预算最多 50,000 tokens
```

位置：

- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/compact.ts:122-130`
- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/compact.ts:531-585`
- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/compact.ts:925-975`
- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/compact.ts:1415-1463`

异步 Agent 的实际过滤条件是排除 `retrieved`、排除 `pending`、排除当前 Agent 自身；其他状态会保留，因此除 running/completed 外还可能包括 failed/killed：

- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/compact.ts:1562-1599`

因此传统路径的思想不是简单排除 Sub Agent 注入，而是删除陈旧 Transcript 噪声，再重新注入仍然有效的异步任务状态。

Session Memory 路径不能套用上述完整列表。当前路径主要构造 Session Memory summary、`messagesToKeep`、Plan 文件和 SessionStart hook results，没有等价恢复最近文件、Plan Mode、Skills、Deferred Tools 与异步 Agent 的全部附件：

- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/sessionMemoryCompact.ts:476-502`

### 7.6 媒体负载处理

传统压缩的 regular streaming fallback 会把图片和文档替换为标记，避免媒体让压缩请求本身超长：

- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/compact.ts:133-199`
- `/home/claude/claude-code-sourcemap/restored-src/src/services/compact/compact.ts:1151-1301`

默认 cache-sharing fork 路径当前没有执行相同剥离，因此媒体替换不是所有 Claude 压缩请求的不变量。

---

## 8. Codex 研究结果

Codex 当前源码包含 Local、Legacy Remote 和 Remote v2 Compaction。Remote 只用于支持的 OpenAI/Azure Responses Provider；Remote v2 当前为 stable 默认路径，关闭时回到 legacy Remote，不支持 Remote 的 Provider 使用 Local。另有 under-development、默认关闭的 token-budget 路径，会开启新 context window 而不是运行 Local/Remote summary。

还要把“Codex 源码行为”和“公开 Responses Compact 合同”分开。当前 [OpenAI Compaction 官方文档](https://developers.openai.com/api/docs/guides/compaction) 明确说明：

- server-side compaction 按渲染后的 Token 数跨过用户 `compact_threshold` 时触发；
- standalone `/responses/compact` 接收消息、工具和其他 items 组成的完整窗口；
- 返回值是一套新的 canonical compacted window，通常不只含一个 compaction item；
- compaction item 是不透明状态，不面向人类阅读；
- standalone 输出应原样传给下一次 Responses 请求，不能再次自行 prune；
- 送入 compact endpoint 的窗口本身仍必须能放进模型窗口。

这份公开合同不能证明 Codex Local/Remote v2 的 20k/64k 私有预算，但能确认 LimCode 的 `openai_responses_compact` 必须与普通 8k Markdown Summary 分支隔离：原生输出、保留项、opaque 内容和 Provider 绑定都不能再被通用文本 reducer 改写。

它还会改变 LimCode 的本地组合方式：文字 Summary 可以只总结连续旧前缀并保留本地 tail；standalone native Compact 则应提交完整模型可见历史，让 Provider 自己返回新的 canonical window。把一个本地未提交 tail 接到原生 output 后面虽然直觉上可行，但公开合同没有承诺这种混合输入可保持原生状态关系，因此第一版不采用。已经送达父对话的 Process Completion 和 Child Answer 属于该完整窗口；仅表示“现在仍在运行”的状态以及当前 Task / 用户原文在 Compact 后重新投影。

相关路径：

- `/home/claude/codex/codex-rs/core/src/tasks/compact.rs:40-76`
- `/home/claude/codex/codex-rs/features/src/lib.rs:1337-1341`
- `/home/claude/codex/codex-rs/features/src/lib.rs:1450-1455`

这些路径都不依赖固定数量的 Tool Result 原样尾部，但保留对象、预算口径和 Initial Context 注入时机并不相同。

### 8.1 Local Compaction

Local Compaction 让模型基于当前历史生成 Handoff Summary：

- `/home/claude/codex/codex-rs/core/src/compact.rs:241-347`

压缩后历史主要由以下内容组成：

```text
从真实 UserMessage 提取并重建的文本投影
+
Handoff Summary
```

位置：

- `/home/claude/codex/codex-rs/core/src/compact.rs:348-383`

用户文本投影选择规则：

- 只处理可解析为真实 `UserMessage` 的消息，并提取其文本；
- 排除先前 Summary 和内部包装；
- 总预算最多 20,000 Token；
- 最新优先；
- 边界消息必要时截断。

位置：

- `/home/claude/codex/codex-rs/core/src/compact.rs:57`
- `/home/claude/codex/codex-rs/core/src/compact.rs:526-549`
- `/home/claude/codex/codex-rs/core/src/compact.rs:622-695`

图片、音频和原 ResponseItem 结构不会由这条文本投影原样保留。所以这里是“最多约 20k 的用户文本重建”，不是无限原样保留所有用户消息。

Codex Handoff Prompt 要求：

- 当前进度和关键决定；
- 约束与用户偏好；
- 剩余工作；
- 继续工作所需的关键数据和引用。

位置：

- `/home/claude/codex/codex-rs/prompts/templates/compact/prompt.md`

### 8.2 Remote Compaction 过滤

Remote Compaction 输出会过滤：

- FunctionCall；
- FunctionCallOutput；
- ToolSearch Call/Output；
- Reasoning；
- LocalShellCall；
- AdditionalTools；
- 其他内部项。

位置：

- `/home/claude/codex/codex-rs/core/src/compact_remote.rs:320-362`

随后按 compaction 时机处理当前 Initial Context / WorldState：

- `/home/claude/codex/codex-rs/core/src/compact_remote.rs:302-317`
- `/home/claude/codex/codex-rs/core/src/compact.rs:555-619`

Mid-turn compaction 会立即把当前 Initial Context 插入最后一个真实用户/Agent message 之前；manual/pre-turn 使用 `DoNotInject`，先安装不含 Initial Context 的 replacement history，再由下一次普通 Turn 完整重注。这样可以避免压缩模型返回的旧 Developer/System 包装与当前环境重复或冲突。

### 8.3 Remote v2 Token 预算

```text
RETAINED_MESSAGE_TOKEN_BUDGET      = 64,000
MAX_RETAINED_AGENT_MESSAGE_TOKENS  = 10,000
```

位置：

- `/home/claude/codex/codex-rs/core/src/compact_remote_v2.rs:56-62`

eligible retained items 按最新优先和文本预算截断：

- `/home/claude/codex/codex-rs/core/src/compact_remote_v2.rs:442-515`

Function Call 和 Function Output 不在 retained 集合中。

64k 只约束 retained subset 的文本：普通 Message 的图片/音频在该计算中为 0，compaction output 在预算之后追加，Initial Context 也不属于这 64k。AgentMessage 先受单条 10k 上限，再参与共享预算。因此它不是完整 Provider 请求的硬上限。

### 8.4 Delegated Task 专项处理

Codex 有一项直接针对该问题的提交：

```text
4f6d06d485 Preserve delegated tasks across remote compaction (#36128)
```

提交说明包括：

- 有界保留非完成型 Agent Message；
- 使 delegated task 在后续 Turn 中仍可用；
- 计算加密 Agent Message 的 Token；
- 排除 Child Completion Message；
- Fork Child 时去掉继承的 Parent Agent Message。

当前消息格式包括：

```text
Message Type: MESSAGE
Message Type: NEW_TASK
Message Type: FINAL_ANSWER
```

位置：

- `/home/claude/codex/codex-rs/core/src/context/inter_agent_message.rs`
- `/home/claude/codex/codex-rs/core/src/context/inter_agent_completion_message.rs`

Remote v2 保留非 `FINAL_ANSWER` Agent Message；单条 AgentMessage 受 10k 限制，随后与其他 eligible retained text 共同受 64k 文本预算约束：

- `/home/claude/codex/codex-rs/core/src/compact_remote_v2.rs:462-478`

这体现的是：Delegated Task 协调状态需要跨压缩保留；`NEW_TASK` / `MESSAGE` 只在预算内保留，`FINAL_ANSWER` 不进入 retained 集合。

### 8.5 Durable Goal 是另一类控制状态

当前 Codex 还存在默认启用的 durable Thread Goal。Goal 存在独立 state DB，控制循环在空闲继续时重新读取并注入 typed steering item。它不等于普通 turn task，也不是 compaction transcript 的一部分，但直接说明了：真正决定持续执行的控制状态应有独立持久语义和重新注入路径，不能只依赖自由摘要或历史消息。

产品层面的 [OpenAI Developers](https://developers.openai.com/) 页面也把 Follow a goal 描述为给 Codex 一个可长期运行的 durable objective；本文关于具体持久化与 steering 路径的结论仍以固定 commit 的本地源码为准。

相关路径：

- `/home/claude/codex/codex-rs/features/src/lib.rs:1331-1335`
- `/home/claude/codex/codex-rs/ext/goal/src/runtime.rs:359-405`
- `/home/claude/codex/codex-rs/ext/goal/src/steering.rs:45-53`

### 8.6 触发口径与完整窗口分离

Codex 还区分 auto-compaction 的计数作用域：`total` 统计完整活动上下文，`body_after_prefix` 只统计当前 compaction window 的 carried prefix 之后新增的 Token。但模型完整 context window 始终作为独立硬上限参与判断：

- `/home/claude/codex/codex-rs/core/src/session/context_window.rs:23-89`

这说明“何时触发压缩”和“完整 Provider 请求能否进入模型”可以使用不同口径，但两者必须同时记录、不能拿 body budget 冒充 full-window safety。

---

## 9. 对比总结

### 9.1 OpenCode 当前 V1 与 V2 补充

本机没有单独的 OpenCode 源码 checkout。本节使用官方仓库固定提交 `38e10eb1408feb700021b8e8766fb0ab41bf84e2`，并严格区分当前 V1 运行路径、V2 已有核心代码和仍在演进的 V2 规范。

**当前 V1 代码事实：**

- 默认最多考虑最近 2 个用户回合。
- 近期预算默认取可用窗口约 25%，再被夹在 2k–8k；若显式设置 `preserve_recent_tokens`，该显式值不受默认 8k 上限约束。
- 送入摘要模型前，每个工具输出最多序列化 2,000 字符，附件只保留文字标记。
- 已完成的旧 compaction user/assistant 消息从新一轮 source 中排除，只把最后一个摘要作为 `previousSummary` 更新，避免把旧摘要再次当普通历史总结。
- `tail_start_id` 让模型看到“压缩标记 + 新摘要 + 被保留的近期消息 + 后续消息”；完整历史仍在 Session 存储中。
- 另有可选且默认关闭的旧工具输出 prune：保护最近约 40k 工具输出，只有可清理量超过 20k 才批量标记 compacted；`skill` 默认受保护。它不能描述成 V1 每次请求的必经路径。

稳定源码：

- [OpenCode V1 compaction.ts](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/session/compaction.ts)
- [OpenCode V1 message-v2.ts](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/session/message-v2.ts)
- [OpenCode V1 config schema](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/v1/config/config.ts)

**V2 已实现核心代码与仍未完成的产品化：**

- 默认近期序列化内容 8k、摘要输出最多 4,096 tokens、完整请求预留 20k。
- 请求前估算 `system + messages + tools` 的完整模型输入，而不是只看 Transcript。
- 压缩结果保存为一个隐藏检查点，内容是结构化滚动摘要和 Token 有界的近期序列化原文；完整 Transcript 继续持久保存。
- 摘要固定覆盖目标、重要细节、已完成/正在做/受阻、下一步和相关文件，并要求保留准确路径、符号、命令、错误、URL 和 ID。
- 重复压缩使用旧结构化摘要加新历史进行更新，而不是机械追加无界旧摘要。
- `Compaction.Ended` 后才安装 durable checkpoint；Provider 尚未产生 durable assistant/tool side effect 时发生 overflow，最多额外压缩并重试一次，不能无限循环。

稳定源码与规范：

- [OpenCode V2 compaction core](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/session/compaction.ts)
- [OpenCode V2 LLM runner](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/session/runner/llm.ts)
- [OpenCode V2 Session spec](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/specs/v2/session.md)
- [OpenCode 当前 V1 HTTP Session handler](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts)

自动压缩本身已经在 native V2 core 中实现，不能把它全部降格成规划；尚未完成的是 V1 runtime parity 和产品主路径替换。手动压缩、确定性旧 Tool Result prune、完整 instructions / agent policy、steering、plan/final reminder、plugin transforms、完整 media/MCP/agent materialization、崩溃后续跑和 metrics 等仍在规范缺口中。当前 `packages/opencode` HTTP Session handler 仍使用 V1 `SessionPrompt` / `SessionCompaction`。现有 V2 core `select()` 还会在预算边界按序列化字符串切分一条内容，这不适合直接复制到 LimCode，因为它可能破坏 Assistant / Tool Result 的结构边界。

对 LimCode 最有价值的借鉴是：

1. 用固定字段写成真正的“继续工作交接单”，而不是自由散文摘要。
2. 旧摘要作为待更新的锚点，不再次混入普通待总结历史。
3. 摘要输入中的工具结果先做确定性缩短。
4. 完整历史继续保存，压缩只替换模型的活动视图。
5. 请求前计算 System、Messages 和 Tools 的完整大小。
6. 压缩失败或仍未缩小时有界退出，不能烧钱循环。

### 9.2 Claude Code、Codex、OpenCode 与 LimCode 对比

| 维度 | LimCode 当前 | Claude Code 2.1.88 | Codex 当前源码 | OpenCode 固定快照 |
|---|---|---|---|---|
| 默认/主要路径 | segmented summary + 最近 8 个 message 边界 | 标准 full summary；Partial/Session Memory 等另有路径 | 支持的 Responses Provider 默认 Remote v2；其他走 Local | 当前产品 handler 走 V1；V2 native core 已实现自动压缩但尚未完成产品替换 |
| retained 预算 | 原样尾部无 Token hard cap | Session Memory 40k 是回扩停止阈值，非严格 hard cap | Local 用户文本约 20k；Remote v2 eligible retained text 64k，均非完整请求 hard cap | V1 默认 2k–8k recent；V2 默认约 8k 近期序列化内容，均非完整请求 hard cap |
| 工具结果 | 按位置进入摘要或原样尾部 | gated Microcompact / API Context Management | Remote 输出过滤 FunctionCall/Output；Local 依赖 Summary | V1/V2 摘要输入单结果约 2,000 字符；V1 另有默认关闭的旧结果 prune |
| 原子边界 | 正常路径为 Assistant message + 连续 tool_pair；缺少 owner identity group 合同 | PTL retry 按 Assistant API round；Session Memory 用 Tool/Assistant ID 修复 | Local PTL 逐 item 删除；Remote 过滤后重建 replacement history | V1 以消息/part 处理；V2 recent `select()` 仍可在序列化字符串中间切开 |
| Task/控制状态 | Task 为派生 UI 投影，未规范回注，也无 final decision | Summary 要求 Pending Tasks；传统路径另有 Plan/Agent 附件 | Local 依赖 Handoff Summary；Remote v2 有界保留 delegated AgentMessage；durable Goal 独立重注 | V2 Summary 固定 Active/Blocked/Next Move；完整 plan/final reminder 仍是 parity 缺口 |
| 后台 Agent | runtime_context 按位置处理，并退化为 user role | 传统路径回注未 retrieved、非 pending 的异步 Agent | delegated 保留只属于 Remote v2；`FINAL_ANSWER` 被过滤 | V1 有 agent 消息；V2 完整 agent reference materialization 尚未闭合 |
| 用户内容 | 旧消息依赖 Summary，近期 message 原样 | full Summary 要求列出全部；实验尾部保留近期 | Local 重建约 20k 用户文本；Remote v2 使用共享 retained text budget | V1 按近期回合与 token budget；V2 保存有界序列化 recent，不等于规范原始消息 |
| 重复压缩 | 旧摘要确定性同时进入 prior/source，最终拼接无硬上限 | 各路径有不同 summary/保留/附件边界，不能统一概括 | 过滤旧包装；Initial Context 按 mid-turn/pre-turn 时机重注 | previous summary 作为锚点更新；完成事件后才安装 checkpoint |

共同经验不是某个固定数字，而是：

```text
Token budget
+ semantic classification
+ structural atomicity
+ canonical projection reinjection
+ explicit path and accounting scope
```

任何借鉴都必须先回答“预算覆盖什么”和“该行为属于哪条启用路径”。局部 retained 数字不能直接转化成 LimCode 完整请求的 hard cap。

---

## 10. 设计判断

### 10.1 不应无限原样保留所有用户消息

建议分层：

1. 最新真实用户请求在通过输入 admission 后默认原样保留；
2. 用户明确纠正、偏好、不可违反约束进入有来源 revision 的 `User Intent / Constraints Projection`；
3. 较旧用户消息进入语义摘要；
4. 只有精确措辞具有合同意义时才放入有预算 Quote Ledger。

这比“所有用户消息永远原样保留”和“所有旧用户消息都只依赖自由摘要”更稳健。若最新输入本身超过完整请求可用预算，系统必须内容对象化、要求用户缩短或明确 fail closed，不能为了满足 hard cap 而静默摘要用户原文。

### 10.2 不应固定保留 N 条工具消息

工具消息数量与 Token 大小、重要性没有稳定关系：

```text
1 条 Read 结果可能有 100k tokens
100 条 Edit Receipt 可能只有几千 tokens
```

工具策略必须考虑：

- 工具类别；
- 是否已消费；
- 是否仍是下一步依赖；
- 是否可重新读取；
- 是否是 mutation、approval、idempotency 证据；
- ToolCall arguments、媒体和 provider signature 是否同样过大或不可改写；
- Token/字节大小；
- 完整内容是否已存在 ContentObject/CAS。

仅保留 ContentObject ID 还不够：模型必须拥有受策略约束、可审计的 rehydrate/read 能力，否则 handle 对模型不可解析。

### 10.3 后台和 Sub Agent 应区分已交付历史与当前状态

应排除：

- Heartbeat；
- 重复 Completion Notification；
- 已完成其传输职责的 Delivery Envelope；
- 已被规范状态表示的 Transport Metadata。

应作为历史保留或进入摘要 / native Compact：

- 父 Agent 已经收到的 Process Completion、exit code 与有界输出；
- 父 Agent 已经收到的 Child Answer、failure / interruption；
- 与上述结果相连的必要 ToolCall / Result 和稳定身份。

应在压缩后从当前权威事实回注：

- 活动 Child Task；
- Child ID / Answer Bridge ID；
- 已提交但仍有 pending Delivery 或未 handled Input 的 Answer；
- 活动后台 Process；
- Process Receipt / Output Handle；
- 失败且仍需主 Agent 处理的状态。

历史交付使用 typed runtime envelope，明确标记为结果数据而非新用户指令；Child 内部 transcript、思考和工具流水不随父对话压缩。

### 10.4 Task 语义投影与 Turn 终止决策必须分离

Task List 可以从 Tool facts 确定性投影，因此应作为 canonical **projection** 回注；压缩模型只能解释其背景，不能成为 Task 状态权威。

但 `pending/in_progress/blocked` 只描述用户工作分解，不直接等价于“当前 Turn 必须继续”。真正控制 final 的应是独立、结构化并随 Turn 冻结的 `TurnFinalizationDisposition`，例如：

```text
continue_local_work
waiting_external
needs_user
handoff_registered
completed
explicit_override
```

这样后台 Child、detached Process、Approval wait 和用户要求暂停可以合法结束当前 Turn，而不会被一个陈旧 pending Task 强制空转。

---

## 11. 建议的分层上下文架构

建议将模型输入构造成：

```text
Stable System / Developer Instructions
Frozen Tool Schemas and Authority-derived Context
Semantic Summary
Contiguous Verbatim Tail + Reduced Evidence
Canonical Projection Capsule
Current User Input / Typed Runtime Input
```

把经常变化的 Capsule 放在稳定前缀之后，可以减少对 Prompt Cache 的破坏。它必须使用结构化、转义后的 typed content，并标明来源与 trust class，不能让 Task title、网页正文或 Child output 通过伪造标题覆盖 System/Developer 指令。

完整请求预算先于各层局部预算：

```text
fixedPrefixTokens
+ summaryTokens
+ reducedTailTokens
+ capsuleTokens
+ currentInputTokens
+ providerFramingTokens
+ outputReserveTokens
+ estimatorSafetyMarginTokens
<= contextWindowTokens
```

Tail 只能使用扣除固定前缀、当前输入、输出储备和安全余量后的剩余预算。所有计数必须带 `accountingScope` 与 estimator identity；在无法使用 Provider 精确 tokenizer 时，应称为估算硬门槛，并保留 byte limit 与安全余量。

以上分层是普通请求和文字 Summary 路径的逻辑结构。OpenAI native Compact 是明确例外：它用完整模型可见历史生成并整体替换 canonical window，不在本地做 `Semantic Summary + Contiguous Tail` 拼接。替换完成后仍可追加本次请求级的 Current User、Task 卡、typed Runtime Delivery 和最新活动状态，但不能追加一段未交给 Compact 的旧历史。

### 11.1 Canonical Projection Capsule

Capsule 不是新权威，而是一次 ModelRequest 对多个既有权威的冻结投影。字段 crosswalk 至少包括：

| 投影字段 | 权威来源 |
|---|---|
| Current Task / Plan | 当前 Context lineage 可达的 canonical Tool operation + Plan decision |
| Approval / User Decision | InteractionRequest / Response / OwnerLink |
| Changed Files | EffectReceipt / FileMutationReceipt / ChangeSet，不猜测 live Workspace |
| Background Process | Process / ProcessReceipt / output ContentObject |
| Child / Answer | ChildExecution / AnswerSubmission / RuntimeDelivery / InputLink |
| WorkEnvironment / Provider / ToolPolicy | 当前 Turn 的 frozen AuthoritySnapshot，不读取 live settings |
| User Intent / Constraints | 带来源 MessageRevision 的派生 projection |

首次创建 ModelRequest 时必须冻结：

```text
contextRootId
authoritySnapshotId
root/head generation
SQLite snapshotCommitSeq
capsule ContentObject identity
ordered source fact IDs and revisions
capsule schema / renderer revision
```

同一 ModelRequest 的 retry、reconnect、dry-run 和 replay 必须复用该 Capsule，不能重新读取“当前状态”。Capsule 示例使用 canonical JSON 而非可被未转义内容破坏的手写 YAML：

```json
{
  "schema": "canonical-projection-capsule",
  "projectionRevision": "42:7:3",
  "taskGeneration": "task_generation_xxx",
  "tasks": [
    { "title": "还原压缩算法", "status": "completed" },
    { "title": "修复 Task 连续性", "status": "in_progress" }
  ],
  "childExecutions": [
    {
      "answerBridgeId": "answer_bridge_xxx",
      "status": "running",
      "deliveryState": "not_created"
    }
  ]
}
```

Capsule 有 aggregate budget 和每类/per-item budget，并定义固定优先级：控制决策与活动身份优先，长文本使用可解析 handle。超预算必须记录 completeness/truncation 标记；不能静默丢弃 pending approval、活动 processId 或 Task generation。

Capsule 应作为 request-level immutable projection 或明确 superseding 的 Context artifact，不能每轮简单 append 到 Transcript，否则旧 Capsule 会累积并再次进入摘要。

### 11.2 Semantic Summary

历史摘要负责表达：

- 用户目标和意图变化；
- 已确认事实；
- 关键决定及原因；
- 已修改文件和重要标识符；
- 错误、修复和验证结果；
- 当前工作上下文；
- 尚未完成事项；
- 下一步。

摘要不应重复注入已经由 Canonical Projection Capsule 表达的运行时状态全文，只需记录其语义背景。

摘要还必须满足：

1. previous summary 只作为只读输入，不进入本轮 source transcript；
2. summary source 在进入 Provider 前也应用证据归约和独立输入上限；
3. `previous summary + delta` 经过整体预算化归并；
4. 最终 Summary 有 absolute max，不只设置 target；
5. Provider 过长、空输出或非法结构时有 deterministic fallback；
6. Capsule 与 Summary 冲突时，以带 revision 的 Capsule/权威事实为准。

### 11.3 Token-bounded Verbatim Tail

选择单位应是由 durable identity 构造的 `ContextGroup`，而不是仅靠 Segment 数量或 transport chunks。Group identity 至少使用：

```text
ModelRequest
+ ModelRequestMessageLink 对应的最终 MessageRevision
+ ToolCallSourceLink / provider ordinal
+ 对应终态 ToolModelResult
+ 该请求前新增的 user/runtime input segments
```

Thinking/Text 只使用最终持久化 MessageRevision 中可重放的内容，不依赖未持久化的流式 delta。

选择规则：

1. 从最新 Group 向旧遍历；
2. 对 ToolCall arguments、Tool Result、媒体和可清理 Provider content 应用 immutable reduction plan；
3. 使用冻结 estimator 计算统一口径的估算 Token；
4. 达到目标预算后停止扩展；
5. 不得突破硬预算；
6. 不拆 Call/Result 或同一 Assistant Response；
7. Tail 必须是连续后缀，不能为了保留旧 mandatory group 在历史中打洞；
8. Task、Process、Child、Approval 等跨位置 mandatory state 进入 Capsule；
9. 当前输入过大时执行 admission/fail-closed 策略，不能静默摘要精确指令。

Claude 的 `10k min / 40k max` 只能作为实验起点，且 40k 在 Claude 实现中并非严格 hard cap。LimCode 的最终值必须由完整请求预算反推，而不是照抄固定数字。

### 11.4 Tool Evidence Reducer

建议每种工具声明策略：

```ts
type ToolContextRetentionPolicy =
  | 'verbatim'
  | 'structured_digest'
  | 'head_tail'
  | 'handle_only'
  | 'drop_after_handled'
```

Reducer 不能原地修改 ToolModelResult 或 ContextSegment。每次归约应生成新的 immutable artifact：

```ts
interface EvidenceReductionArtifact {
  sourceSegmentId: string;
  sourceContentObjectId: string;
  sourceSha256: string;
  policyRevision: string;
  disposition: ToolContextRetentionPolicy;
  reducedContentObjectId: string;
  estimatedTokens: number;
}
```

该 artifact 属于冻结的 ModelContextProjection/Compression recipe，并可回链原始 CAS。相同 key 不同内容必须冲突；retry/replay 复用 artifact，不能重新调用 LLM reducer。

Reduction artifact 可以是 Manifest 引用的有界 CAS 列表，但不能为了每个旧 Tool Pair 重写原 Context DAG 或创建 O(k) 新 Context nodes；compression replacement 仍需满足现有常数级 node-growth gate。

#### Read / Search / Web

保留：

```text
path / query / URL
line range
result count
关键片段
content hash
ContentObject ID
```

大型正文使用 Head/Tail 或结构摘要，完整内容继续保留在 CAS。

URL 内容可能随时间变化，handle 应指向冻结 ContentObject，而不是承诺未来重新抓取仍得到相同正文。

#### Bash / Shell

保留：

```text
command
cwd
exitCode
terminationReason
processId
stdout head/tail
stderr head/tail
outputHandle / ContentObject ID
```

Handle 必须有受 ToolPolicy 约束的读取能力；若模型无法解析，至少保留足以继续工作的错误尾部和关键输出。

#### Edit / Write / Patch

保留：

```text
目标文件
操作类型
Receipt / ChangeSet ID
before/after hash
是否已提交
关键 Diff 摘要
```

大 Write/Patch 的 ToolCall arguments 也需要归约，但 mutation receipt、目标 hash、provider-required call identity 和签名必须保留。

#### Task / Plan / Approval

不依赖 Tool Result 原文，直接从 Canonical Projection Capsule 重建；proposal、approved plan 与 active task generation 必须分开。

#### Child Agent / Process Delivery

父对话已经收到的 Completion / Answer 用 typed envelope 作为历史证据；活动 ID、精确 Delivery/Input handling 状态和可解析结果句柄从当前权威事实投影。传输 Envelope 完成职责后可从模型输入排除，由 Capsule / 实用版状态卡表达当前状态、Summary 或 native canonical window 承接历史语义。Child 内部 transcript 不进入父上下文；`consumed`、`handled`、`read` 不能互换。

---

## 12. Task-aware Finalization Decision

只回注 Task Snapshot 仍不足以发现模型提前收尾，但 Task status 也不能直接成为 Turn terminal authority。正确目标是：在 final-output fence 之前，用一次冻结、可重放的决策同时解释 Task semantic state、可靠执行事实和用户意图。

### 12.1 启用前置条件

硬门禁启用前必须先满足：

1. Task operation 已完整校验并持久化；
2. Snapshot 绑定当前 Context lineage、approved Plan 和 Task generation；
3. ToolPolicy 禁用 Task 工具时仍有结构化收尾路径；
4. 用户暂停/阶段汇报绑定具体 immutable MessageRevision，不靠自由文本猜测；
5. Child、Process、Approval、Runtime Delivery 有明确的 foreground/background/handoff 矩阵；
6. 决策与 `TurnFinalOutputFence` 位于同一 writer authority 下。

在这些条件完成前，只记录 `open_task_final_candidate` telemetry，不阻止 terminal。

### 12.2 建议决策矩阵

```text
没有当前 generation 的 open task：
  disposition = completed；允许 final。

存在当前 Turn 可本地继续、无人接管且 policy=blocking 的 task：
  第一次 final candidate → continue_once，注入确定性提醒。

Task 已由后台 Child / detached Process / Approval / 用户输入接管：
  disposition = waiting_external / handoff_registered / needs_user；允许当前 Turn 结束。

Task 为 advisory、来自旧 generation 或不再从当前 Context 可达：
  不阻止 final，记录诊断或修正 projection。

用户明确要求暂停、阶段汇报或结束：
  disposition = explicit_override，记录来源 MessageRevision 与 reason code。
```

`blocked` 仍表示工作未完成；只有存在结构化 blocker、owner 和 resume condition 时，才可映射为 `waiting_external` 或 `needs_user`。不能要求模型把所有未完成项伪装成 cancelled 来逃离门禁。

### 12.3 有界、持久的两阶段流程

第一次发现无合法 disposition 的 final candidate：

1. 在提交可见 Assistant Message 和 final-output fence **之前**读取 Task projection revision 与可靠执行快照；
2. 写入稳定身份的 `TurnFinalizationAttempt(modelRequestId, taskRevision)`；
3. 将 Provider 的 candidate output 保存在既有 ModelRequest terminal/CAS 审计中，但不发布成用户可见 final；
4. 追加 typed reminder projection，创建且只创建一次后续 ModelRequest。

流式 delta 可能在决策前已被 UI 短暂观察。UI 必须把它标为未提交 candidate、在决策后折叠/替换，或者延迟 final promotion；不能先把文本展示成已完成最终回答，再悄悄继续同一 Turn。

提醒示例：

```text
当前 Task generation 仍有可在本 Turn 继续的本地工作。
这是本 Turn 唯一一次自动继续机会。
请继续执行；如需要外部等待、用户决定或显式暂停，请形成结构化 finalization disposition。
```

第二次仍输出 final 时不得无限循环。控制面必须在以下结果中结束：

- `completed`；
- `waiting_external / handoff_registered`；
- `needs_user`；
- 绑定用户指令的 `explicit_override`；
- 无合法 disposition 时以 `needs_user` + typed diagnostic 安全终止，而不是再次 nudge。

Attempt、Decision、reminder identity 和 candidate visibility 必须可在 Extension Host 重启后精确恢复。

### 12.4 Task 与可靠执行事实的边界

Task List 不替代可靠执行事实：

- ToolCall 是否 terminal 由 Tool/Effect 判断；
- Child 是否运行由 ChildExecution 判断；
- Process 是否运行由 Process/Receipt 判断；
- Delivery 是否注入/handled 由 RuntimeDelivery/InputLink 判断；
- Task 只表达用户工作分解和完成语义；
- TurnFinalizationDecision 解释“为什么当前 Turn 继续或结束”。

后台 Child/Process 的存在不天然阻止 final，前台 wait 也不能只靠 Task title 推断。所有判断都必须使用 frozen policy 和 writer-side CAS，避免在 read 与 final fence 之间发生 TOCTOU。

---

## 13. 建议的压缩计划算法

下面的大段算法描述的是普通文字 Summary / 长期 Capsule 路径。OpenAI standalone native Compact 必须在入口先分支，不能走其中的 local Summary / Tail 分配：

```ts
if (policy.method === 'openai_responses_compact') {
  const nativeInput = projectCompleteProviderVisibleHistory(materialized.context)
  assertWithinCompactProviderWindow(nativeInput, frozen.compactProvider)

  const canonicalOutput = await compactAsFrozenProvider(nativeInput)
  const requestFacts = freezeCurrentRequestFacts({
    currentUserRevision: frozen.currentUserRevision,
    taskCard: projectCurrentTurnTaskCard(),
    runtimeDeliveriesArrivedDuringCompact: pendingModelDeliveries(),
    activeRuntimeState: projectActiveChildAndProcessState()
  })
  const nextRequest = serializeProviderRequest({ canonicalOutput, requestFacts })
  assertWithinCompleteRequestBudget(nextRequest, policy)
  return publishWithHeadCasAndSettleDeliveries(canonicalOutput, requestFacts)
}
```

这里的 `canonicalOutput` 不经过 reducer，`runtimeDeliveriesArrivedDuringCompact` 只在成功发布时按现有协议结算，未被本次冻结的 Delivery 保持 pending。

```ts
function buildCompressionPlan(frozen, materialized, policy) {
  assertSameRootAndAuthority(frozen, materialized)

  const capsule = projectCanonicalCapsule({
    snapshotCommitSeq: frozen.snapshotCommitSeq,
    authoritySnapshot: frozen.authoritySnapshot,
    runtimeFacts: frozen.runtimeFacts,
    taskLineage: frozen.taskLineage
  })

  const groups = groupByDurableRequestOwnership(materialized.context)
  const reductionArtifacts = planImmutableReductions(groups, {
    policyRevision: policy.reducerRevision,
    contentStore: frozen.contentStore
  })
  const reducedGroups = applyReductionArtifacts(groups, reductionArtifacts)

  const reservedTokens = estimateReservedRequestTokens({
    authority: frozen.authoritySnapshot,
    tools: frozen.toolSchemas,
    capsule,
    currentInput: frozen.currentInput,
    providerFraming: frozen.providerFraming,
    outputReserve: policy.outputReserveTokens,
    safetyMargin: policy.estimatorSafetyMarginTokens
  })
  const variableBudget = policy.contextWindowTokens - reservedTokens
  if (variableBudget <= 0) return infeasible('reserved_request_layers_exceed_window')

  // Summary 与 Tail 联合分配；不能先把全部 variableBudget 分给 Tail，
  // 也不能让 Summary 挤掉合同要求的最小近期 Group。
  const allocation = allocateSummaryAndTailBudgets({
    totalTokens: variableBudget,
    summaryTargetTokens: policy.summaryTargetTokens,
    summaryMaxTokens: policy.summaryMaxTokens,
    tailTargetTokens: policy.verbatimTailTargetTokens,
    tailMaxTokens: policy.verbatimTailMaxTokens,
    minRecentApiRounds: policy.minRecentApiRounds,
    groups: reducedGroups
  })
  if (!allocation.feasible) return infeasible(allocation.reason)
  const { summaryBudget, tailBudget } = allocation

  // Tail 必须是连续后缀；跨位置活动状态已经进入 Capsule。
  const tail = selectNewestContiguousGroupsWithinBudget({
    groups: reducedGroups,
    targetTokens: Math.min(policy.verbatimTailTargetTokens, tailBudget),
    maxTokens: Math.min(policy.verbatimTailMaxTokens, tailBudget),
    minRecentApiRounds: policy.minRecentApiRounds
  })

  // Summary Provider 也只能看到归约后的 source，并受独立输入上限约束。
  const summarySource = reducedGroupsBefore(tail)
  const summaryInput = boundSummaryInput(summarySource, {
    maxTokens: policy.summaryInputMaxTokens,
    fallback: 'hierarchical_or_deterministic'
  })
  const summary = mergeSummaryWithinBudget({
    previousSummary: previousSummaryAsReadOnlyContext(materialized),
    deltaSource: summaryInput,
    targetTokens: policy.summaryTargetTokens,
    maxTokens: summaryBudget
  })

  const manifest = buildCompressionManifest({
    frozen,
    policy,
    capsule,
    groups,
    reductionArtifacts,
    summarySource,
    summary,
    tail
  })
  const request = serializeProviderRequest({ frozen, capsule, summary, tail })
  assertWithinCompleteRequestBudget(request, policy)
  return { status: 'planned', capsule, summary, tail, reductionArtifacts, manifest }
}
```

关键不变量：

```text
previous summary 不得再次进入待总结 source
previous summary + delta 的最终产物有 absolute max
summary source 在进入 Provider 前已经归约且有输入上限
call/result 不得拆分
tail 是连续后缀且受完整请求剩余预算约束
Task/Process/Child/Approval 等活动状态不通过历史打洞保留
Capsule 不成为第二 authority，且不依赖 summary 正确性
Reducer 输出 immutable、可回链原始 CAS，并随 recipe 冻结
同一 ModelRequest retry/replay 不读取 live Capsule 或重新调用 Provider
压缩失败不改变旧 head；新 head 发布必须 CAS
最终序列化请求满足统一 accounting scope
```

---

## 14. 配置 hard-cut 建议

当前字段：

```text
preserveLatestMessages
reserveLatestUserMessageTokens
```

建议迁移为：

```text
requestAccountingScope
outputReserveTokens
estimatorSafetyMarginTokens
verbatimTailTargetTokens
verbatimTailMaxTokens
minRecentApiRounds
canonicalProjectionMaxTokens
canonicalProjectionPerKindMaxTokens
toolEvidenceMaxTokens
toolEvidencePerItemMaxTokens
userIntentLedgerMaxTokens
summaryInputMaxTokens
summaryTargetTokens
summaryMaxTokens
```

本项目仍处开发期，项目准则明确不保留旧格式 fallback 或运行时兼容链。因此不建议让新旧字段长期共存，也不建议把 `preserveLatestMessages` 解释成兼容下限。

正确做法是一次性 hard cut：

1. 同步修改 config codec、UI、AuthoritySnapshot 冻结结构、physical manifest verification 和测试；
2. 对需要保留的 configuration root 做一次原子重写，运行时只解释新 schema；
3. 无法等价转换的 `preserveLatestMessages` 使用新默认值，不伪造 message→Token 换算；
4. 不兼容的 Runtime compression recipe/manifest 通过当前 Runtime epoch reset/archive 处理；
5. UI 只展示完整请求预算、Token 和 durable API-round/group 语义。

`reserveLatestUserMessageTokens` 应二选一：

1. 真正参与完整请求预算并形成可验证保证，例如拆成 `currentInputAdmissionTokens` 与 `outputReserveTokens`；
2. 若只影响 UI 推荐值，则改名为 `recommendedTriggerReserveTokens`，且不进入 frozen runtime policy。

---

## 15. 遥测与可解释性

建议每次压缩记录：

```text
accountingScope
estimatorKind / estimatorRevision / estimateSource
contextWindowTokens
outputReserveTokens
estimatorSafetyMarginTokens
completeRequestTokensBefore
completeRequestTokensAfter
fixedPrefixTokens
summarySourceTokens
summaryInputTokens
summaryOutputTokens
summaryHardLimit
canonicalProjectionTokens
verbatimTailTokens
verbatimTailHardLimit
tailTokensBySegmentKind
tailTokensByToolName
runtimeContextTokens
toolCallArgumentTokens
mediaItemCount
rawToolResultCount
reducedToolResultCount
droppedToolResultCount
activeTaskCount
activeProcessCount
activeChildCount
compressionSkipReason
largestRetainedItem
budgetFeasibility
headCasOutcome
```

Telemetry 不记录正文、命令输出或用户内容，只记录稳定 ID、分类和大小。还应同时保存 Provider 实际 usage 与估算差值，用于按模型校准 safety margin。

建议把可审计 `CompressionManifest` 作为内容寻址的 immutable artifact，并让 ModelRequest recipe / CompressionBlock 引用它。只有计数的 Manifest 不足以精确重放；至少需要：

```yaml
source:
  rootId: context_root_xxx
  authoritySnapshotId: authority_snapshot_xxx
  headGeneration: "18"
  snapshotCommitSeq: "4201"
  orderedSegmentIdsObjectId: content_ordered_segment_ids_xxx
  segments: 120
  tokens: 145000
  sourceHash: sha256:...
accounting:
  scope: complete_provider_request
  estimator: tokenx@revision
  contextWindow: 200000
  outputReserve: 12000
  safetyMargin: 8000
summary:
  modelRequestId: model_request_xxx
  inputObjectId: content_summary_input_xxx
  outputObjectId: content_summary_output_xxx
  tokens: 9000
  hardLimit: 10000
tail:
  startGroupId: group_xxx
  groups: 6
  tokens: 23000
  hardLimit: 40000
canonicalProjection:
  contentObjectId: content_capsule_xxx
  sourceRevision: "42:7:3"
  tokens: 1800
reductions:
  policyRevision: reducer-2026-08-09
  artifacts:
    - sourceSegmentId: segment_tool_xxx
      sourceObjectId: content_raw_xxx
      reducedObjectId: content_reduced_xxx
      disposition: head_tail
```

这能回答：

- 为什么压缩没有发生；
- 哪个工具结果最大；
- Task 是否被回注；
- Child/Process 状态是否仍然活跃；
- 重复压缩是否逐轮变大；
- before/after 是否使用同一 Token scope；
- retry/replay 是否复用了原 Capsule、Reducer artifact 和 Summary；
- 哪个 head/config/reducer revision 产生了本计划。

相同 idempotency key 如果解析出不同 Manifest digest 必须冲突；exact replay 的验收条件包括 Provider 调用次数为 0，而不是重新生成“等价”摘要。

---

## 16. 实施优先级

### P0：证据、合同与已确认缺陷

1. 保存同一任务压缩开启/关闭的 pre-final ModelRequest、Context root、Task revision、Summary 和 Provider 输出，确认生产因果与频率；
2. 修复 `update_task_list` settlement 的完整 operation 校验与 canonical 持久化；
3. 修正 Task projection 的 current Context lineage、Task generation、retry/edit/delete/fork 与 Plan approval 语义；
4. 修复 prior summary 确定性双重输入，并给最终 `previous + delta` Summary 增加 absolute max；
5. 统一压缩前后为 complete-request Token accounting scope；压缩后必须满足安全窗口，否则进入明确 reducer/fallback/infeasible 路径；
6. 对 `finite_tail/non_reducing` 增加最大项、scope 和跨 Head 重复成本诊断；
7. 先更新 context/authority/tool/migration/gate-registry 机器合同，未实现 gate 标记 PENDING；
8. Task final 仅增加 telemetry，不启用硬门禁。

### P1：冻结 Canonical Projection Capsule

1. 为 Task、Plan、Approval、Process、Child、Delivery、User Constraints 建立权威 crosswalk；
2. 首次 ModelRequest 创建时冻结 Capsule ContentObject、source revisions 与 snapshotCommitSeq；
3. retry/reconnect/replay 复用 Capsule，不读取 live settings/state；
4. 普通请求和压缩后确定性回注 Capsule，但不把每轮旧 Capsule 累积进 Transcript；
5. `runtime_context` 改为 typed projection，不再隐式伪装成普通 user message；
6. 验证 Prompt Cache 受 Capsule 放置和变化频率的影响。

### P1：完整请求预算与 immutable Reducer

1. 引入由 durable owner links 构造的 ContextGroup；
2. 引入 output reserve、safety margin、summary input/max、tail target/max 和 Capsule per-kind budget；
3. Tail 只选择连续后缀，所有跨位置活动状态进入 Capsule；
4. Summary source 与 Tail 都使用 immutable reduction artifact；
5. 优先处理 `bash/shell`、Read/Search/Web、Child Answer、超大 Write/Patch arguments 和媒体；
6. Handle 必须可解析、受 ToolPolicy 控制并可校验原始 CAS；
7. Mandatory current input 不可容纳时执行 admission/fail-closed，不静默摘要；
8. 压缩失败保持旧 head，新 head 发布使用 CAS。
9. 修正现有 `openai_responses_compact`：完整模型可见窗口输入、canonical output 原样替换、无本地旧 tail 拼接，并闭合 Compact 前后 Runtime Delivery 的一次性交付。

### P2：有界 Finalization Decision

1. 定义 Task generation、blocking/advisory policy 与 `TurnFinalizationDisposition`；
2. 建立 Child/Process/Approval 的 foreground/background/handoff 矩阵；
3. final candidate 检查发生在可见 Assistant Message 与 final-output fence 之前；
4. durable Attempt 最多触发一次自动 nudge；第二次必须结构化终止，禁止无界循环；
5. 用户暂停 override 绑定 MessageRevision 与 reason code；
6. Finalization Decision 与 Task revision、PendingTurnInput、Lease generation 和 final fence 做 writer-side CAS。

### P2：Provider Native 能力

1. 在修好已有 standalone Compact 之后，再评估 server-side automatic compaction 和 Context Editing；
2. 区分原生 compact 产物与当前明确禁用的 continuation/suffix/cache-edit authority；
3. 本地 ContextSequence、Manifest 与 Provider edit 保持可审计一致；
4. 增加多次压缩漂移、估算误差与 cache break 监控。

---

## 17. 回归测试矩阵

### 17.1 Task 连续性

1. 缺失/非法 `mode`、非法 status、空 title 在唯一 settlement 边界失败，不产生“成功但不可投影”的 operation；
2. 多次 `update/rewrite` 后只回注当前 generation 的最新投影；
3. retry/edit/delete 后，当前 Context 不可达的旧 Task 不再生效；
4. 新用户任务开始新 generation，旧 pending 不约束新请求；
5. `change_requested/rejected` Plan 不激活 Task，approved Plan 才按合同激活；
6. fork 明确验证展示历史与 active Task 的继承规则；
7. Task Tool Result 被压缩后仍由 Tool facts 重建，不依赖 Summary；
8. Summary 故意遗漏或写错 Task 时 Capsule 仍准确并带 revision；
9. Task 工具被 ToolPolicy 禁用时，Finalization Decision 仍可结构化收尾；
10. 后台 Child/Process 接管 Task 时允许父 Turn 以 `handoff_registered/waiting_external` 结束；
11. 第一次无合法 disposition 的 final 只 nudge 一次，第二次不会无限循环；
12. 用户暂停 override 绑定正确 MessageRevision；
13. final decision 与新 PendingTurnInput、Task revision、Lease generation、final fence 的竞态由 writer CAS 解决；
14. 第一次 nudge 后 Extension Host 重启可精确恢复 candidate、attempt 和下一步；
15. 被拒 final 的 transient stream 不会在 UI 中永久冒充已提交最终回答。

### 17.2 工具尾部

1. 一个 Assistant Response 并行调用 100 个工具；
2. 少于 8 个 message，但有一个 100k Token Tool Result；
3. 一个用户消息内发生 50 个连续 Tool Round；
4. 切点位于 Assistant ToolCall 与多个 ToolResult 之间；
5. 同一 Assistant message ID 的 Thinking、Text、ToolCall 不得拆分；
6. Mutation Receipt 与大 Read Result 混合时，Receipt 保留、Read 归约；
7. 100k Write/Patch arguments、超大 Assistant text/Thinking、图片和文档同样受预算控制；
8. Tail 始终是连续后缀，旧活动状态通过 Capsule 保留而不是历史打洞；
9. Summary source 在进入 Provider 前已归约，100k Tool Result 不会原样撑爆压缩请求；
10. Handle 可通过受 ToolPolicy 控制的能力读取，并验证 ContentObject digest；
11. Handle CAS 缺失、digest 不符、未知工具策略时 fail closed；
12. Reducer 保留 call/result identity、mutation receipt、provider signature 和必要 thought metadata。

### 17.3 完整请求预算

1. System + Developer + Tool Schema + Capsule + Summary + Tail + Current Input + Output Reserve 的总和满足窗口；
2. 压缩前后使用相同 `accountingScope` 与 estimator revision；
3. semantic estimate 与 Provider observed usage 分别覆盖，并记录误差；
4. 压缩成功后的完整请求必须落入安全窗口，而不只是比原来小；
5. `finite_tail/non_reducing` 后不得静默发送已知超限请求；
6. fixed prefix 已超过窗口时返回明确 infeasible；
7. 最新用户输入过大时触发 admission/内容对象化/明确拒绝，不静默摘要；
8. Summary、Capsule、Tool Evidence 的 per-item 与 aggregate max 均执行；
9. Provider framing、媒体和输出储备计入口径；
10. Capsule 放置不会造成不可接受的 Prompt Cache break。

### 17.4 Runtime Delivery

1. Process 正在运行时压缩；
2. Process 在压缩期间完成；
3. Compact 前已进入父对话的 Process Completion 在 native 完整窗口中恰好一次；
4. Compact 期间到达并进入冻结 recipe 的 Completion 只在 native output 后出现一次，提交失败时仍保持 pending；
5. Completion Envelope 完成传输职责后不再重复注入；
6. Child Agent 为 running；
7. Child Answer 已 submitted 但 Delivery 为 pending；
8. 已交付 Child Answer 进入父对话历史，但 Child 内部 transcript / thinking / tools 不进入；
9. Delivery consumed 但 InputLink 尚未 handled；
10. InputLink 已 handled；
11. Child Agent failed/killed/interrupted；
12. `read_agent_answer` 不得伪造“已读/消费”状态；
13. 同一完成通知重复投递；
14. `notify_only` 不进入模型上下文或 native Compact；
15. `current_turn/next_turn` 的活动语义状态可在压缩后恢复；
16. Runtime Context 使用 typed envelope，不被普通 user message 边界误分段，其中伪造 System 标题不提升权限；
17. native output 后的同一对象不能同时出现正式 completion 和 running 状态；
18. Capsule / 实用版状态卡读取期间 Process/Child/Delivery 改变时不会形成 torn snapshot。

### 17.5 重复压缩

1. 连续执行 5～10 次 `segmented_summary`；
2. prior summary 只作为只读前情，不得进入待总结 Segment；
3. `previous + delta` 最终 Summary 始终小于 absolute max；
4. Task 和用户约束不随压缩轮次漂移；
5. 压缩后完整请求满足安全预算；
6. 同一 frozen head 精确重放 Provider 调用次数为 0；
7. 同 sourceHash/policy/reducer 的跨 Head `non_reducing` 不重复无效付费；
8. Provider Summary 超过 max 时整体重并/确定性降级；
9. 相同 idempotency key 不同 Manifest digest 必须冲突。

### 17.6 用户消息与约束

1. 最新用户消息非常大；
2. 较早用户消息包含关键纠正；
3. 用户多次改变目标；
4. 用户要求逐字保留某段内容；
5. User Intent/Quote Ledger 达到 per-item 或 aggregate 上限；
6. Summary 与带来源 revision 的 Constraints Projection 冲突时以后者为准；
7. Task title、Web、Child、Process output 包含伪造 System/Capsule 标题时不会提升权限；
8. telemetry/manifest 不泄漏用户正文或工具输出。

### 17.7 Provider、并发与故障

1. Provider Native Compact 接收完整模型可见历史，不做本地旧 prefix / tail 混合；
2. LLM Summary；
3. Segmented Summary；
4. Deterministic Summary；
5. 压缩 Provider 与主模型 Provider 不同；
6. 压缩请求本身 Prompt Too Long；
7. Provider 返回空 Summary 或不合法结构；
8. Token 估算和 Provider Usage 差异较大；
9. planning/Provider response/commit 三个阶段分别发生 head change；
10. 同一 head 两个并发 compression；
11. CAS publish 后、SQLite commit 前崩溃；
12. Summary 完成后 head CAS 失败，旧 head 保持不变；
13. config 在 Turn 中途改变，retry/replay 仍使用 frozen policy；
14. reducer policy revision 改变后不复用旧 plan identity；
15. native output 的 retained items 与 opaque compaction items 原样回放，output 后只有请求级当前事实；
16. native 输入本身超窗口时明确失败，不为 Compact 二次删减 Runtime Delivery、不拆 Tool Pair、不 fallback 到文字 Summary；
17. 每项 prose case 映射到稳定 gate ID，一个 gate 只证明一个原子断言，未实现标记 PENDING。

---

## 18. 验收不变量

```text
1. 不产生孤儿 ToolCall / ToolResult。
2. Canonical Projection Capsule 永不成为第二 authority，所有字段可回链来源事实与 revision。
3. 同一 ModelRequest 的 retry/reconnect/replay 不重建 live Capsule，不继承中途变化的 settings。
4. 完整序列化 Provider 请求受统一预算约束；Tail hard cap 由剩余预算导出。
5. 单个巨大 Tool Result、ToolCall arguments、Assistant text 或媒体不能永久阻止压缩或静默绕过预算。
6. 超大当前用户输入不能被静默摘要；必须 admission、内容对象化或明确 fail closed。
7. Previous Summary 不得同时作为 prior context 和 source transcript；最终 previous + delta Summary 有 absolute max。
8. Task Snapshot 绑定当前 Context lineage、Plan decision 和 Task generation，不依赖摘要模型正确性。
9. Task status 不直接成为 Turn authority；Finalization Decision 与 final-output fence 原子，自动 nudge 最多一次。
10. 后台 Child/Process 的合法 handoff 允许父 Turn 结束，活动身份和 Delivery/Input handling 跨压缩不丢失。
11. Runtime Delivery 的 pending、consumed、handled、read 语义不混用；已交付结果作为 typed 历史保留，已完成传输职责的 Envelope 不重复污染上下文。
12. 所有 Reducer 输出 immutable、可回链原始 CAS、冻结 policy revision，且 handle 可受控解析。
13. Summary/Reducer/压缩失败不改变旧 head；新 head 更新必须 CAS。
14. Manifest 内容寻址；相同 key 异内容冲突；exact replay 的 Provider 调用次数为 0。
15. 多次压缩后完整请求与 Summary 大小保持有界，Task/约束不随轮次漂移。
16. 新配置 hard cut 后运行时只解释当前 schema，不建立旧字段 fallback 或双 writer。
17. OpenAI native Compact 接收完整模型可见历史并原样接管 canonical output；不拼未参与 Compact 的旧 tail，活动状态只在 output 后重新投影。
```

---

## 19. 最终结论

当前问题不是把保留数量从 8 改成 12 就能解决，也不是单纯加强 Summary Prompt 就能解决。

已确认的结构性问题是多类内容目前共享同一个按位置切割的 Transcript，但生命周期不同：

```text
对话历史
工具证据
Task/Plan 语义投影
后台/Child 执行状态
当前用户/Runtime 输入
```

它们有完全不同的生命周期和保留要求。

当前 Task List 是 Tool facts 的派生 UI 投影，没有：

- 压缩后的规范模型回注；
- current Context lineage 与 Task generation 合同；
- 独立、结构化的 TurnFinalizationDisposition；
- 自动调度语义。

因此“Task 未完成但 Agent 整体结束”是当前语义允许的结果；压缩丢失 Task 交换、runtime_context 角色退化和重复摘要漂移都可能放大它。要证明具体生产事件的因果链，仍需保存压缩开关 A/B 与 pre-final 冻结请求证据。

长期完整方向不是继续增加 `preserveLatestMessages`，而是：

```text
Complete-request Budget Planner
+ Canonical Projection Capsule
+ Semantic Summary
+ Contiguous Token-bounded Tail
+ Immutable Tool / Runtime Evidence Reduction
+ Bounded TurnFinalizationDecision
```

但当前个人 / 小团队项目不直接实施这套完整形态。已经采用的第一版落点是：

1. 以用户阈值触发、动态最多 48k 的对话主体作为压缩目标；
2. 修复 prior summary 双重输入，并把 previous + delta 更新成一个最多 8k 的 replacement summary；
3. 用普通 / 文本摘要 / native 三种明确投影和同源估算阻止已知超限请求；native 使用完整模型可见窗口和原样 canonical output，不拼本地旧 tail；
4. 文字摘要路径用连续 atomic tail、4k/16k 工具结果预览和当前用户 revision 回注取代固定 message 数；
5. 已交付的 Process / Child 结果以 typed runtime 历史保留，活动状态在压缩后重新投影，`notify_only` 和内部控制记录排除；
6. 只冻结当前 Turn 的 2k 提醒卡，并记录 open-task final telemetry；
7. 删除 final 后自动压缩，不实现 nudge、hard gate、跨 Turn Task 或新数据库领域。

Capsule、Manifest、通用 Reducer、Task generation 和 Finalization Decision 继续保留为长期备选。只有第一版 telemetry 和真实失败样本证明简化方案不够时才启用它们。即便未来扩展，目标也不是把 Task、Process、Child、Approval 聚合成一个新的超级权威，而是保留各自领域 ownership，为每次 ModelRequest 冻结一个可追溯的投影。

---

## 附录 A：LimCode 关键源码索引

```text
shared/protocol.ts
shared/taskListProjection.ts
backend/reliableKernel/contextSequence.ts
backend/reliableKernel/contextCompressionCoordinator.ts
backend/reliableKernel/contextCompression.ts
backend/reliableKernel/contextTokenEstimator.ts
backend/reliableKernel/modelProviderControlPlane.ts
backend/reliableKernel/llmCapabilityProviderAdapter.ts
backend/reliableKernel/agentLoop.ts
backend/reliableKernel/turnControlPlane.ts
backend/reliableKernel/answerDelivery.ts
backend/reliableKernel/automaticRuntimeDelivery.ts
backend/reliableKernel/processCompletionDelivery.ts
backend/reliableKernel/databaseWorker.ts
backend/reliableKernel/clientFeed.ts
backend/reliableKernel/toolDispatcher.ts
backend/reliableKernel/toolInteractions.ts
backend/world/modules/tools/definitions/taskList/index.ts
backend/world/modules/tools/definitions/runAgent/index.ts
backend/capabilities/llmProvider.ts
backend/modelContext/modelContextProjector.ts
webview/src/components/settings/global/LlmCompressionSettingsEditor.vue
webview/src/stores/useGlobalSettingsStore.ts
docs/architecture/reliable-kernel/01-invariants-and-authority.md
docs/architecture/reliable-kernel/contracts/context.json
docs/architecture/reliable-kernel/contracts/authority.json
AGENTS.md
```

## 附录 B：Claude Code 2.1.88 关键源码索引

```text
/home/claude/claude-code-sourcemap/restored-src/src/services/compact/compact.ts
/home/claude/claude-code-sourcemap/restored-src/src/services/compact/prompt.ts
/home/claude/claude-code-sourcemap/restored-src/src/services/compact/sessionMemoryCompact.ts
/home/claude/claude-code-sourcemap/restored-src/src/services/compact/grouping.ts
/home/claude/claude-code-sourcemap/restored-src/src/services/compact/microCompact.ts
/home/claude/claude-code-sourcemap/restored-src/src/services/compact/timeBasedMCConfig.ts
/home/claude/claude-code-sourcemap/restored-src/src/services/compact/apiMicrocompact.ts
```

## 附录 C：Codex 关键源码索引

公开 Provider 合同：

- [OpenAI Compaction 官方文档](https://developers.openai.com/api/docs/guides/compaction)

```text
/home/claude/codex/codex-rs/core/src/compact.rs
/home/claude/codex/codex-rs/core/src/compact_remote.rs
/home/claude/codex/codex-rs/core/src/compact_remote_v2.rs
/home/claude/codex/codex-rs/core/src/tasks/compact.rs
/home/claude/codex/codex-rs/core/src/session/context_window.rs
/home/claude/codex/codex-rs/features/src/lib.rs
/home/claude/codex/codex-rs/core/src/context/inter_agent_message.rs
/home/claude/codex/codex-rs/core/src/context/inter_agent_completion_message.rs
/home/claude/codex/codex-rs/ext/goal/src/runtime.rs
/home/claude/codex/codex-rs/ext/goal/src/steering.rs
/home/claude/codex/codex-rs/prompts/templates/compact/prompt.md
```

## 附录 D：OpenCode 固定源码索引

本机未发现独立 OpenCode checkout；以下链接均固定到官方提交 `38e10eb1408feb700021b8e8766fb0ab41bf84e2`：

- [V1 compaction](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/session/compaction.ts)
- [V1 message projection](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/session/message-v2.ts)
- [V1 compaction config](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/v1/config/config.ts)
- [V2 compaction core](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/session/compaction.ts)
- [V2 LLM runner](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/core/src/session/runner/llm.ts)
- [V2 Session specification](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/specs/v2/session.md)
- [Current V1 HTTP Session handler](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts)
