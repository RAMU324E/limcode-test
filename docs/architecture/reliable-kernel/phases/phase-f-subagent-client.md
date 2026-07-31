# 阶段 F：ChildExecution、RuntimeDelivery 与有界前端

## 目标

用稳定 ChildExecution lineage、权威 answer/delivery facts 控制子 Agent，并让 snapshot、changes、host queue 与 Webview 活动窗口在持续增量期间始终有界。

## 主要工作

- 建立 ChildExecution、ChildExecutionParentLink、ChildExecutionTurnLink、ChildExecutionIntentLink、ChildExecutionActiveTurnLink；
- AnswerBridge 归属 ChildExecution，首次/续接 Turn 复用同一 bridge；
- queue_next_turn 建 TurnIntent+IntentLink，interrupt_current_turn 先正常终止 active Turn 再建立 continuation Turn；
- wait/list 为短 SQLite snapshot read，不改变 Delivery；
- `cancel_subtree` 首发必选：沿 ParentLink 递归，同事务覆盖全部 ActiveTurnLink target 与 pending IntentLink；
- RuntimeInboxItem 只保存来源事实；RuntimeDelivery 保存 target/phase/attempt/state；
- target_turn_id NULL/非 NULL 使用两组 partial UNIQUE index；
- redeliver 创建 attempt_seq+1/retry_of_delivery_id 新行，旧 failed row 不复活；
- Delivery 注入时创建 RuntimeDeliveryInputLink，执行器吸收对应 input 时写 handled_at；
- UI 分别显示 childExecution、activeChildTurn、answerSubmission、runtimeDelivery、parentHandling、termination facts；
- Conversation fork 的 Reuse/Branch/Origin Links 与 task list 派生 projection 接入 bounded ClientState；
- snapshot 与 changes 都带 hostBootId；commitSeq 只在同一 host boot 内单调；
- snapshot 带 snapshotCommitSeq，snapshot read 与 feed registration 形成 atomic barrier；
- 一个 commit 一个 atomic changes batch；batch/queue 超限转单一 snapshot-required；
- history/detail 使用 keyset/chunked on-demand read；大列表 virtual/segmented 并复用 AdvancedScrollbar。

## 接口依赖

- C：TurnIntent、PendingTurnInput、ExecutionLease、Turn command/receipt；
- D：EffectIntent/Receipt、ToolOutcome/ToolModelResult、ToolExecution.wait_deadline_at；
- E：Context root/full request、fork root/head、compression replacement；
- B：transaction commit result、snapshot barrier、RootBinding fenced read；
- machine contracts：subagent.json、client-feed.json、authority.json。

## F recovery owner

本阶段只注册并实现：

- `recovery.answer-inbox-invariant`；
- `recovery.delivery-pending`；
- `recovery.foreground-answer-wait-expired`；
- `recovery.cancelled-subtree-incomplete`。

D 只提供 scanner framework，不拥有以上规则。F 不重复实现 D 的 hanging Effect/File closure handler。

## Client overflow 状态机

```text
normal changes queue
→ single commit 或 queued batches/bytes 超限
→ 丢弃尚未发送普通 changes
→ snapshotRequired=true（只合并一位，不排队）
→ 等当前 inflight ACK/结束
→ 读取新的 bounded snapshot + snapshotCommitSeq
→ atomic feed handoff
```

禁止拆分一个 commit 形成 half-visible state，禁止持久 ClientChangeLog，禁止 snapshot-required 自身形成队列。

## 简化边界

- 不建 dead-letter queue；
- 不复制 child Conversation 到 parent；
- 不在 ClientState 保存 full Context/tool/process/answer body；
- 不靠 activityStage、notificationRun、display text 或无关 PendingTurnInput 猜状态；
- 不建 closure table；树遍历使用 recursive CTE 或 application recursion over stable ParentLink；
- commitSeq 不跨 Extension Host 持久化；hostBootId 变化后重取 snapshot。

## 完成标准

- Delivery 两组 partial UNIQUE index、InputLink uniqueness、handled_at 与 redelivery state machine tests 通过；
- continuation 后 cancel_subtree 不漏旧 Turn 启动的 descendants，也取消 pending intents，且不误伤其他树；
- AnswerBridge owner、Intent membership 与 ActiveTurn separation 通过；
- 四个 F recovery ID 可跨 Extension Host restart 收口；
- snapshot/message/activity limits、change batch records/bytes、queued batches/bytes 全部满足 client-feed.json；
- snapshot→changes 不丢 commit，gap/unknown type/apply failure 转 snapshot-required；
- history older/newer keyset pagination 无重复漏项；
- candidate 对应 stable check ID 有真实 handler 与 evidence。
