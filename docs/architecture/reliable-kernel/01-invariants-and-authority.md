# 不变量与权威

[返回总计划](./README.md)

## 1. 权威分层

```text
配置权威：独立 configuration file roots
运行权威：limcode.sqlite
大内容权威：CAS
外部世界：Workspace / Provider / detached Process wrapper / MCP / Subagent runtime
ECS：已提交运行事实的只读投影
Webview：有界客户端读模型
```

任何层都不能冒充另一层：

- ECS 状态不能反向覆盖 SQLite；
- Webview 展示字段不能决定运行终态；
- CAS 内容不能暗中携带领域关系；
- Provider transport 优化不能成为模型上下文权威；
- Settings/Agent/Workflow/Policy 等配置不能迁入 Runtime SQLite；
- wrapper spool/exit receipt 是外部观察证据，必须经 EffectReceipt/reconcile 才成为领域结论。

## 2. 一个数据库文件，独立领域表

所有 Runtime 领域共用一个 `limcode.sqlite`，但共用事务介质不表示领域 ownership。每个对象与 Link 必须具有独立 table、Repository、Codec、mutation mapping、client mapping、index/FK 与 delete/reset policy。

禁止：

- generic family JSON table；
- 业务层 arbitrary SQL batch；
- 把 Tool、Message、Agent、Conversation、Process、Answer 或配置聚合进大记录；
- 用主体表可空字段代替独立 Link；
- 为 AskUser、TaskList 或 MCP 再建平行 authority；
- 在首发禁用状态下仍创建 ProviderContinuation 表。

Runtime domain exact set 只在 [`authority.json#runtimeDomains`](./contracts/authority.json) 定义，并由 plan validator 与 Context/Subagent/Fork 合同交叉核验。

## 3. 配置与 physical migration crosswalk

配置对象和 ScopeLink 分别建模，不再用一个抽象 `Policy` 聚合：

- Agent、Workflow；
- PlanReviewPolicy / ToolPolicy / SkillPolicy 及各自 ScopeLink；
- SystemPrompt 与 ScopeLink；
- ModelProfile 与 ScopeLink；
- WorkEnvironment / WorkEnvironmentPolicy / ScopeLink；
- RuntimeContext 与 ScopeLink；
- CheckpointPolicy 与 ScopeLink；
- GlobalSettings、LlmProviderConfig、LlmCompressionConfig、McpServerConfig。

每项在 `authority.json#configurationDomains` 中给出 Repository、Codec 和 `migrationEntryIds`；物理路径与 disposition 只在 `migration.json#physicalManifest` 定义。

Scope 过滤固定为：

```text
global / agent / workflow  → preserve
conversation / run         → archive-reset
agentSystem                → archive-reset（当前没有独立 AgentSystem authority）
```

过滤必须原子重写 index 与 records，删除悬空 index 和 orphan records。`common.proxy` 是业务设置，hard cut 时从 VS Code globalState 移入 settings root；globalState 只保留 root authority 与 cutover control metadata。

## 4. Turn 是唯一执行身份

- `TurnIntent` 表达未来工作；
- `PendingTurnInput` 表达当前 Turn 的补充；
- `Turn` 表达已经开始的一次执行生命周期；
- `ExecutionLease` 是 Conversation 当前执行 ownership；
- `AuthoritySnapshot` 冻结本 Turn 的模型身份、执行权限与基础配置；
- 新请求的压缩设置通过已有 `ModelRequest.settings_snapshot_object_id` 独立固定。保存配置不改写既有 Turn 或 ModelRequest；下一次尚未建立的请求读取对应模型的当前压缩配置，先行压缩与随后普通请求共用同一份设置；
- `TurnTermination` 只表达终止事实；
- `TurnExecutorLink` 保存历史 Agent executor 归属；
- `CommandReceipt(source_kind, source_key)` 对 command/callback/internal/recovery 去重。

一个 Conversation 最多一个 ExecutionLease。终止 Turn 时在同一事务释放 Lease。迟到 callback 只能收口原来源，不能重新打开 Turn 或创建未经意图的新执行。

Run/AgentRun 不再是 Runtime authority。Conversation origin/fork 若需要历史执行来源，使用 `source_turn_id`，不得保留 `source_run_id`。

Turn 重启判定矩阵只在 `identity.json#recoveryJudgment` 定义。

## 5. Message、Attachment 与 Conversation 关系

Message 只保存消息身份；正文与模型可见语义进入 immutable `MessageRevision`。

独立关系至少包括：

- Message 属于哪个 Conversation；
- Message 由哪个 Turn 产生；
- Message 当前 revision；
- MessageRevision 引用哪些 Attachment；
- Agent 与 Conversation 当前角色关系；
- Conversation fork/reuse/origin；
- ChildExecution 的父边、Turn/Intent membership 与 active Turn；
- Runtime item 到目标 Conversation/Turn 的 Delivery；
- Delivery 注入的具体 PendingTurnInput。

消息序号在 Conversation 内单调，含 soft-deleted 消息终身不复用。Attachment 正文进入 CAS，设置中的附件大小配置保留，旧 Runtime Attachment 不导入。

PlanProposal 由 `submit_plan` ToolCall/ToolOutcome 派生；TaskList 由 `update_task_list` Tool facts 派生，二者都不建专用 authority table。

## 6. Conversation fork

首发保留 fork 行为与关系展示：

- `ConversationReuseLink`：稳定 reuse key 到 Conversation/Agent；
- `ConversationBranchLink`：source Conversation/MessageRevision 到 target Conversation 的直接 branch 边；
- `ConversationOriginLink`：Conversation 创建来源，可软引用 Agent、Conversation、MessageRevision、ToolCall、Turn；
- `ConversationContextHeadLink`：目标 Conversation 当前选择的 ContextSequenceRoot。

fork 从选定历史 root/node 创建目标 root/head，允许共享 immutable DAG prefix。三个 Link 独立存储、独立 patch，不嵌入 Conversation。

## 7. CAS 发布

CAS identity 为：

```text
contentType + sha256 + byteLength
```

固定顺序：

1. 生成 canonical bytes；
2. 写 temporary content；
3. 核对 digest/length；
4. 原子 publish by digest；
5. SQLite transaction 写 ContentObject 与领域引用。

SQLite committed reference 不得指向缺失 CAS。无人引用内容首发允许保留到 Runtime dataset reset，不建设在线 refcount/GC。

## 8. EffectIntent、EffectReceipt 与唯一 Tool result

外部作用必须满足：

1. 来源 Operation/Attempt 与 EffectIntent 同事务建立；
2. commit 后才 dispatch；
3. EffectReceipt 独立于原 Turn 是否仍活动；
4. receipt 只陈述能证明的外部结果；
5. reconcile 再产生 FileMutationReceipt、ProcessReceipt、ToolOutcome、AnswerSubmission 或 RuntimeInboxItem；
6. 每个终态 ToolCall 只有一个 ToolModelResult。

拒绝或过期且尚未 dispatch 的审批可直接生成 ToolOutcome/ToolModelResult，不伪造 EffectIntent。文件、命令、MCP 和 subagent spawn 在 Extension Host 重启后不自动重复 dispatch。

Effect kind 首发包括 `mcp_tool_call`。MCP connection rebuild 不是 call recovery；无法查询同一 call 结果时写 `outcome_unknown`。

## 9. Recovery scans

六个 scan 的 target/action/owner 只在 `tool.json#recoveryScan` 定义：

| ID | Owner | 边界 |
|---|---|---|
| `recovery.effect-intent-hanging` | D | dispatched、无 receipt 的 EffectIntent |
| `recovery.file-change-unresolved` | D | 未决 FileChangeSet 收口 |
| `recovery.answer-inbox-invariant` | F | AnswerSubmission 已提交但缺 InboxItem |
| `recovery.delivery-pending` | F | pending RuntimeDelivery 重评估 |
| `recovery.foreground-answer-wait-expired` | F | 前台 answer wait 到期转后台 |
| `recovery.interrupted-subtree-incomplete` | F | interrupt_subtree 后仍有 active Turn/pending Intent |

D 建 scanner framework，但不得实现 F 的领域规则。candidate gate 为每个 ID 提供独立 check，不能再用“恢复三类”复合 prose。

## 10. 文件事实

- FileChangeSet 是 proposal，不是模型最终结果；
- 用户批准前不得修改 Workspace；
- apply 前重新核对路径、类型、base digest；
- actual digest 与 member outcome 逐项记录；
- partial execution 只记录真实完成项；
- 不自动 rollback 或 retry 外部文件变更；
- approval 使用 InteractionRequest/Response；
- terminal 后通过 ToolOutcome 生成唯一 ToolModelResult。

Installed smoke 必须包含 proposal → approve → actual Workspace mutation → digest/receipt 的完整链路。

## 11. Process authority 与输出上限

一次后台进程由 Process/ProcessOriginLink/ProcessOutputChunk/ProcessReceipt 独立表达。宿主通过 packaged detached wrapper 启动和观察真实命令：

```text
stable nonce
+ wrapper/child pid
+ process group
+ start fingerprint
+ command digest
+ durable append-only spool path
+ atomic exit receipt
```

Extension Host 不把 Node child pipe 或裸 PID 当作可跨重启 authority。重启后：

- wrapper/fingerprint 可证明存活 → running；
- valid exit receipt → 真实 exit code/signal；
- 无法证明 → `outcome_unknown`；
- stop 只有在 nonce/fingerprint/process group 全匹配后才能发送。

ProcessOutputChunk 只保存 metadata，正文进入 CAS。精确数值以 `tool.json#processOutput` 为准；达到 per-process retained bytes/chunks 任一上限后仍持续 drain，但不再写正文或 metadata，只更新 dropped/truncated counters。CAS 不替代 quota。

## 12. RuntimeInbox 与 RuntimeDelivery

RuntimeInboxItem 只保存来源事实和来源引用，不保存目标 Conversation/Turn。目标、phase、attempt 与消费状态都属于 RuntimeDelivery。

Delivery phases：

```text
current_turn
next_turn
notify_only
```

状态仅有 `pending/consumed/failed`，不建 dead-letter queue。`target_turn_id` 为 NULL 与非 NULL 时分别使用两组 SQLite partial UNIQUE index，避免 NULL 语义产生重复行。

人工 redeliver：

- 创建 `attempt_seq + 1` 新 RuntimeDelivery；
- 写 `retry_of_delivery_id`；
- 旧 failed row 不复活；
- 旧 attempt 只允许 pending→consumed 或 pending→failed。

注入时创建 `RuntimeDeliveryInputLink(delivery_id UNIQUE, pending_turn_input_id UNIQUE)`；执行器真正吸收对应 input 时写 `handled_at`。`parent_handling_state` 只由该 Link 推导，不读取目标 Turn 下任意无关 PendingTurnInput。

## 13. ContextSequence 与 compression

- ContentObject 只按摘要去重正文；ContextSegment 表达 source occurrence；
- ContextSegmentSource 使用 `(source_kind, source_id, source_revision) UNIQUE`；
- ContextSequenceNode 组成可分支 parent DAG，`(parent_node_id, segment_id) UNIQUE` 只做同一次 append 幂等；
- `parent_node_id` 本身不 UNIQUE；`root_node_id` 本身不 UNIQUE；
- ConversationContextHeadLink 显式选择 current root；
- root/node 首发保留到 dataset reset，不做在线 GC；
- historical replay 使用原 root、AuthoritySnapshot 与 immutable recipe，不读 Message 当前 soft-delete；
- compression root 用 `tail_node_id + tail_segment_count` 精确截断；
- ToolCall/ToolModelResult pair 不可拆开。

CompressionBlock 正文、来源和摘要 immutable。enable/disable/soft delete 只更新 status；regenerate 或用户修改 title/summary 都创建 new replacement block/root，禁止原地 CompressionUpdate。

## 14. Provider 首发模式

ProviderContinuation 首发为 `disabled-full-request`：

- Runtime domain exact set 中没有 ProviderContinuation；
- 每次请求都由 ContextSequenceRoot + frozen recipe 完整物化；Message role 来自 source 指向的 immutable MessageRevision，正文必须可精确解码为 UTF-8；
- 不读写 suffix；
- retry/compression/reconnect 均走完整请求；
- ModelStreamCheckpoint 与 ModelStreamFence 仍负责 stream identity、迟到隔离与 terminal fence；相同 stream identity 的 kind/content 不同必须冲突；
- request-level cancel-current 在 writer 中终止当时最新 attempt/socket；adapter 迟到结果按 durable first-wins 分类，不能覆盖 Completed 或新 generation。

未来 enabled contract 可规定同物理 connection、strict prefix、Completed fence 与 socketGeneration，但首发实现和 gate 不得假装已启用。

## 15. ChildExecution 与 interrupt_subtree

- ChildExecution 是稳定 lineage；
- ParentLink 是稳定树边；
- TurnLink 保存首次/续接 Turn membership；
- IntentLink 保存尚未 admit 的续接意图；
- ActiveTurnLink 只表达当前 active Turn；
- AnswerBridge 归属 ChildExecution，续接 Turn 复用同一 bridge；
- queue 与 interrupt 是不同输入语义；
- wait/list 为单次短 SQLite snapshot read，不改变 delivery；
- interrupt_subtree 首发必选，沿 ParentLink 递归，并在同一事务覆盖 active Turn 与 pending Intent；
- 显式 interrupt_subtree 的 partial interrupted answer 可保存但不得重开或自动续接父 Turn；非 cascade 父 Turn 中断后仍正常运行的 ChildExecution 提交答案时，可创建新的父侧 continuation Turn，但绝不复活旧 Turn。

UI 直接显示 childExecution、activeChildTurn、answerSubmission、runtimeDelivery、parentHandling 与 termination facts，不通过旧 activityStage、notificationRun 或 display text 猜测。

## 16. bounded Client feed

- snapshot 与 changes 都带 sessionId/hostBootId；
- commitSeq 在同一 host boot 内单调，宿主重启后不延续；
- snapshot 带 snapshotCommitSeq；snapshot read 与 listener registration 形成 atomic barrier；
- 一个 commit 对应一个 atomic batch；
- snapshot、batch、queue batches、queue bytes、page 与 detail response 各有 hard limit；
- 单 commit/queue 超限时丢弃未发送普通 changes，并合并为一个 snapshot-required；
- gap、hostBootId 变化、unknown type 或 apply failure 时整份重取 snapshot；
- 不持久化 ClientChangeLog；
- bridge payload 只允许 structured-clone plain data。

## 17. RootBinding 与 cutover

SQLite long-lived connection 只能缓存由 RootAuthority 建立的 immutable fenced RootBinding；每个 request/transaction 开始时重验 generation。root switch 只在 restart 后、数据库打开前完成。

最终 VSIX 的 cutover-only coordinator 是 archive actor。它按 physical manifest journaled archive Runtime、filter settings/scope links、验证配置与外部 untouched 项，再创建 SQLite/CAS/epoch 并原子切 pointer。激活前失败按 journal 恢复；激活后不自动回退旧 writer。

已落盘 SQLite epoch 3 到当前 epoch 4 只允许在 Extension Host 重启后的数据库打开前做一次精确、有界升级：只接受从 0.0.10–0.0.11 与 0.0.12–0.0.14 已发布 VSIX 提取出的两个完整 manifest 指纹；它们仅在 `ModelContextProjection` 的 `detail`/`summary` client mapping 与对应 digest 上不同，物理 DDL 和其余 86 个领域必须完全一致，不能泛化为任意同 epoch 漂移。升级先校验完整 table/index/trigger DDL、manifest 与 RootBinding predecessor 指纹并生成一致性备份，再写 pending writer fence，以单个 SQLite 事务新增包括 `RuntimeDeliveryIntentLink` 在内的四张关系表、刷新 schema manifest 与 RootBinding，并通过 durable journal 向前收敛。Windows 的持久化合同仍使用 canonical path，仅 SQLite 原生 I/O 使用 namespaced path，以保证深层备份路径可打开。既有对话、消息、附件和 CAS identity 全部保持不变；仅对稳定 id、CommandReceipt、RuntimeDelivery 与旧 CAS envelope 全部吻合的 Child Runtime continuation 发布当前 CAS，并重指向其 intent/preset revision、补独立 Link，不保留运行时 fallback。未知 schema、缺失备份或绑定冲突都 fail closed。

## 18. 失败原则

- SQLite 不可用：关闭 Runtime capability 并显示真实错误；
- CAS 缺失：报告 integrity error，不返回空正文；
- Effect 已 dispatch 但无法确认：`outcome_unknown`；
- wrapper 不可达且无 valid receipt：`outcome_unknown`；
- Provider 临时错误：仅按有限、可见、可取消策略 retry；
- Client patch 不适用：snapshot-required/重取 snapshot；
- Delivery target 已删除：InboxItem 保留，Delivery failed(reason=target-gone)；
- 不吞错、不伪造成功/失败、不改走旧文件 writer。
