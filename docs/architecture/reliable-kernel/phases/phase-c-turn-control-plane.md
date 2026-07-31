# 阶段 C：Turn 控制面

## 目标

让 Turn 成为唯一执行身份，收回散落在 ECS、Message 和旧 Run/AgentRun 中的生命周期 authority。

## 主要工作

- 将 Conversation、Turn、TurnIntent、PendingTurnInput、ExecutionLease、AuthoritySnapshot 与 TurnTermination 接到 SQLite；
- 用 `TurnExecutorLink` 保存历史 Agent executor；AgentConversationLink 只表达当前默认关系；
- 使用 `CommandReceipt(source_kind, source_key)` 统一 command/callback/internal/recovery dedupe；
- 将 Message、MessageRevision、current revision link、Conversation membership 与 Turn link 独立建模；
- 将 edit/delete/retry/interrupt/continuation 统一为 Turn command；
- 一个 Conversation 最多一个有效 ExecutionLease；
- ECS 只接收 committed projection，不直接写 execution terminal state；
- backend 新路径不再使用 RunId/AgentRun 作为 authority；协议与 ClientState 的旧 Run 移除归 F，物理删除归 G；
- 为 Conversation fork 提供以 source Turn/MessageRevision/root 为来源的事务接口，不保留 sourceRun authority。

## 关键规则

- Conversation 是对话容器，Turn 是 execution identity；
- Message 属于 Conversation，并通过独立 Link 关联 Turn；
- retry/fork 创建明确新 intent/root/Turn，不复活旧执行；
- interrupt request 与真实 terminal fact 分离；
- terminal 后 late callback 只收口原来源；
- sequence 使用 SQLite INTEGER，wire 使用 decimal integer string，JavaScript 不用 number 承载大序号。

## 完成标准

- input、interrupt、retry、edit、delete 走同一 command receipt/transaction boundary；
- recovery 按 identity.json 的 Turn matrix 判定 resume/finalize/needs_human；
- `CommandReceipt.commandId`、RunId lifecycle 与 ECS writer authority 从 candidate path 消失；
- fork source 使用 Turn/MessageRevision/Context root；
- concurrent command 与 terminal fault tests 在本机 ignored `/tests/` 通过；
- candidate 对应 stable check ID 有真实证据。
