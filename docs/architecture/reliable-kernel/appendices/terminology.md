# 术语说明

| 名称 | 解释 |
|---|---|
| Conversation | 对话容器，本身不是一次执行 |
| Turn | 处理一次输入的一次执行，是唯一 execution identity |
| TurnIntent | 尚未 admit 的未来工作意图 |
| PendingTurnInput | 已存在 Turn 等待吸收的补充输入 |
| ExecutionLease | Conversation 当前 execution ownership 凭证 |
| CommandReceipt | 以 `(source_kind, source_key)` 去重 command/callback/internal/recovery |
| Operation | 一项业务操作 |
| Attempt | Operation 的一次明确尝试 |
| EffectIntent | commit 前登记“准备对外做什么” |
| EffectReceipt | 外部世界目前能够证明的结果 |
| outcome_unknown | 外部作用可能发生，但无法安全证明 success/failure |
| ToolCall | 模型提出的一次工具调用 |
| ToolExecution | 系统对 ToolCall 的执行过程 |
| ToolOutcome | ToolCall 的唯一业务终态结论 |
| ToolModelResult | terminal 后送回模型的唯一工具结果 |
| FileChangeSet | 等待 approval/apply 的文件 mutation proposal |
| FileChangeDecision | approved/rejected/expired 决定 |
| OutcomePause | Operation 等待外部回答而暂停的事实 |
| OperationResolution | OutcomePause 如何恢复或收口 |
| Attachment / AttachmentLink | CAS 附件对象及其到 MessageRevision 的独立关系 |
| CAS | 按内容摘要保存 immutable 大正文的目录 |
| ContentObject | CAS 对象的 content type/digest/length metadata |
| ContextSegment | 一次稳定 source occurrence；正文相同不表示来源相同 |
| ContextSegmentSource | source tuple 到 segment 的唯一归属关系 |
| ContextSequenceNode | 可分支 persistent parent DAG 节点 |
| ContextSequenceRoot | 某次可物化 Context 的 root，可共享 DAG prefix |
| ConversationContextHeadLink | Conversation 当前选择哪个 ContextSequenceRoot |
| tail_node_id / tail_segment_count | compression summary 后允许回溯的 finite tail 起点与长度 |
| ModelContextProjection | owner/request 对某个 frozen root 的引用，不复制 full prompt |
| ConversationReuseLink | stable reuse key 到 Conversation/Agent 的关系 |
| ConversationBranchLink | source Conversation/MessageRevision 到 target fork 的 branch 边 |
| ConversationOriginLink | Conversation 创建来源关系，历史执行来源使用 Turn 而非 Run |
| ChildExecution | 稳定 child lineage，可包含多个首次/续接 Turn 与 pending Intent |
| ChildExecutionParentLink | lineage 间稳定 parent tree edge |
| ChildExecutionTurnLink | Turn membership，不随 active pointer 改写 |
| ChildExecutionIntentLink | 尚未 admit 的 continuation TurnIntent membership |
| ChildExecutionActiveTurnLink | 当前 active Turn 指针，不用于推导 lineage |
| AnswerBridge | 归属 ChildExecution 的答案桥 |
| AnswerSubmission | child 正式提交的一份答案事实 |
| RuntimeInboxItem | 只保存异步来源事实，不保存 destination |
| RuntimeDelivery | Inbox item 的 destination/phase/attempt/state |
| RuntimeDeliveryInputLink | Delivery 注入了哪个 PendingTurnInput，以及何时 handled |
| parent_handling_state | 由对应 DeliveryInputLink.handled_at 推导的父执行器处理状态 |
| detached wrapper | 独立观察真实命令、drain spool、原子写 exit receipt 的小型 packaged helper |
| process start fingerprint | 与 nonce/process group 一起防止 PID reuse 误判的启动证据 |
| ProcessOutputChunk | 有界 process output metadata，正文进入 CAS |
| mcp_tool_call | MCP 外部调用的 Effect kind；connection rebuild 不是 call recovery |
| hostBootId | 一次 Extension Host boot 的标识 |
| commitSeq | 同一 hostBootId 内单调的 commit 水位，wire 为 decimal integer string |
| snapshotCommitSeq | bounded snapshot 已包含到哪个 commitSeq |
| snapshot-required | changes 不可安全继续时合并的一位控制状态，不形成队列 |
| physical migration manifest | 当前注册 root/file/settings/external input 的可执行 preserve/archive/filter/untouched 清单 |
| RootBinding | paths/dataSet/root generation/pointer revision/runtime epoch 的 fenced binding |
| runtimeKernelEpoch | Runtime schema epoch；bump 等于 archive/reset，不用于版本协商 |
| replacementStage | transition ledger 中新替代能力完成的阶段 |
| deleteStage | old source 物理删除阶段，Runtime 入口统一为 G |
| gate check ID | validator handler 的稳定机器身份；description 不是身份 |
| PENDING | gate check 尚未实现，必须使 formal gate 失败 |
