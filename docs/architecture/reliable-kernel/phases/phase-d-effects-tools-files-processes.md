# 阶段 D：Effect、工具、文件、进程与 MCP

## 目标

把“准备做什么”和“外部世界实际发生了什么”分开保存，闭合唯一 ToolModelResult、真实文件回执、后台进程跨宿主观察与 MCP 外部调用。

## 主要工作

- 建立 Operation、Attempt、EffectIntent、EffectReceipt；
- 建立 ToolCall、ToolExecution、ToolOutcome 与唯一 ToolModelResult；
- File proposal 使用 FileChangeSet/Member，approval 与 actual mutation 分离；
- 文件执行使用 base/target/actual digest 核验，不自动 rollback/retry；
- Attachment 受设置大小限制 ingest 到 CAS，并由 AttachmentLink 关联 MessageRevision；
- ask_user 复用 Tool/Interaction/OutcomePause/OperationResolution，不建 AskUser table；
- task list 继续作为 update_task_list Tool facts，F 从事实派生 UI；
- 允许无冲突只读或 independent effect tools 并行；
- 建立 detached wrapper、bounded spool、stable nonce/process group/start fingerprint 与 atomic exit receipt；
- ProcessOutputChunk metadata 入 SQLite、正文入 CAS；reader按manifest稳定前缀合并CAS/spool并核对完整覆盖，terminal counters不得倒退；wrapper按250ms合并flush；
- MCP settings 继续位于 settings root，connection memory-only 重建；风险只取registry权威annotations，明确policy拒绝持久收口，每次获批调用创建 `mcp_tool_call` EffectIntent/Receipt；
- 建立通用 recovery scanner framework，但只注册 D owner 项。

## D recovery owner

本阶段只拥有：

- `recovery.effect-intent-hanging`：核验 dispatched 且无 receipt 的 EffectIntent；文件看 digest，进程看 wrapper evidence，MCP 等不可查询作用写 outcome_unknown；绝不自动重复 dispatch；
- `recovery.file-change-unresolved`：同事务写 expired FileChangeDecision、cancelled ToolOutcome 与唯一 ToolModelResult；一个Turn被call_seq阻塞不影响其他Turn；identity判为finalize且无Lease时只做终止收口。

`receipt_written → domain reconcile` 与已持久化 no-effect/response 的 ordered finalizer 是启动编排中的纯数据库 continuation：在两个稳定 ID 前后各执行一次，不注册第三个 recovery ID，也不计入上述 stable-ID 指标。

AnswerSubmission/Inbox、pending Delivery、foreground answer wait 与 cancelled subtree 全部属于 F；D 不得导入或重复实现它们的 handler。

## 后台进程恢复边界

- Extension Host 不把 Node child pipe 当跨重启 authority；
- wrapper 必须持续 drain；达到 retained limit 后丢弃后续正文但继续 drain；
- valid wrapper exit receipt 才能产生真实 exit code；
- wrapper 不可达且无 valid receipt → outcome_unknown；
- stop 只有 nonce/fingerprint/process group 全匹配时才允许；
- 禁止凭裸 PID stop，禁止把 owner loss 伪造成 abnormal/exitCode=1；
- 不建设 daemon/broker 或全局多租户 quota platform。

精确 limits 与 fields 只在 `contracts/tool.json#processOutput` 定义。

## MCP 边界

- Tool annotations 从 settings-backed memory registry 的已解析工具定义读取；readOnlyHint→read，destructiveHint→write，冲突 hints 在 Intent 前拒绝；
- approval 复用 ToolPolicy/PlanReviewPolicy；明确拒绝写 rejected Tool facts，不用裸异常留下 pending Tool；
- connection rebuild 不是 call recovery；
- dispatch 后无法查询同一 call 结果 → outcome_unknown；
- Extension Host restart 后不自动重试；
- terminal chain 始终为 EffectReceipt → ToolOutcome → one ToolModelResult。

## 完成标准

- 同一个 terminal ToolCall 只有一个 ToolModelResult；
- FileChangeSet 不作为最终模型结果；
- file applied 但 Conversation callback 失败时可凭 receipt reconcile；
- Attachment ingest/on-demand read/CAS link 通过；
- wrapper restart、真实 exit code、safe stop 与 output truncation fault tests 通过；
- MCP read/write/unknown outcome 与 no-auto-retry tests 通过；
- `recovery.effect-intent-hanging`、`recovery.file-change-unresolved` 各有独立 candidate handler；
- F 的四个 recovery ID 在本阶段没有 handler；
- 所有不可证明外部结果都为 outcome_unknown，不伪装失败或偷偷重做。
