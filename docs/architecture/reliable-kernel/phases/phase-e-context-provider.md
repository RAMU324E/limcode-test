# 阶段 E：Context DAG、压缩与 Provider 完整请求

## 目标

消除长对话上下文平方增长，保留精确 replay、compression、fork、stream fence 与有限 Provider retry；首发不实现 ProviderContinuation suffix 优化。

## 主要工作

- ContentObject 只去重正文，ContextSegment 表达 source occurrence；相同正文不同来源不得合并；
- ContextSegmentSource 使用 `(source_kind, source_id, source_revision) UNIQUE`；
- ContextSequenceNode 使用可分支 persistent parent DAG，retry/edit/fork 共享 immutable prefix；
- 非 NULL parent 使用 `(parent_node_id, segment_id) UNIQUE` 保证 append idempotency；NULL parent 使用 `segment_id UNIQUE WHERE parent_node_id IS NULL` 补齐 SQLite NULL 语义，parent 本身不 UNIQUE；
- ContextSequenceRoot 使用 `(conversation_id, root_seq) UNIQUE`，root_node_id 不 UNIQUE；
- ConversationContextHeadLink 在创建 current root 的同一事务更新；
- root/node 与 historical projection 首发保留到 Runtime dataset reset，不做 online GC；
- projection 只保存 root/owner/recipe，不复制完整 history/source links；
- tool call + model result 作为不可拆 tool_pair segment；
- compression source range 登记在 CompressionBlockSource；
- compression root 用 `tail_node_id + tail_segment_count` 精确限定 summary 后的 finite tail；
- compression threshold/estimator 来自 frozen AuthoritySnapshot/ModelProfile；
- Message edit/delete 创建新 current root，historical replay 不读取当前 soft-delete；
- Conversation fork 创建目标 root/head，并写独立 Reuse/Branch/Origin Links；
- ModelStreamCheckpoint/ModelStreamFence 保存 stream identity 与 terminal fence；同一 stream identity 只有 kind 与 canonical content 都一致才可幂等重放；
- Provider transient retry 仍最多两次、以已提交 ModelRequest/Attempt 事实可见，并通过 request-level writer cancel-current 命中当时最新 attempt/socket；
- adapter resolve/reject、Completed 与 cancel 的返回分类以 durable first-wins 事实为准，旧 socket 正常返回也标记 superseded；
- Message context role 从 frozen source 指向的 immutable MessageRevision 读取；非精确 UTF-8 模型正文在外调前失败。

## Provider release decision

首发为 `disabled-full-request`：

- authority/runtime domains 不包含 ProviderContinuation；
- 每个 ModelRequest 从 frozen root + immutable recipe 构造完整 request；
- 不读取 continuation，不产生或发送 suffix；
- reconnect、compression invalidation 与 new attempt 都发送完整 request；
- candidate check 以独立 oracle 逐字段证明“始终完整请求”，不能运行 enabled-mode 检查后假装首发支持 continuation；
- future enabled mode 必须先修改机器合同，不得运行时协商或 fallback。

Phase E 的 stable ID 验证可靠内核 control plane 本身；旧应用 LLM/compression 路由的物理不可达与最终 Extension Host 装配由后续 candidate/cutover gate 负责。在该路由完成前，Phase E evidence 不得被表述为生产入口已经切换，也不得用手工 `evaluate/create` 结果冒充 append 后端到端自动压缩。

## Compression management

- summary/body/source immutable；
- enable/disable/soft delete 只更新 status；
- regenerate 创建新 CompressionBlock/segment/root；
- 用户修改 title/summary 也创建 immutable replacement，并明确处理旧块 status；`previousStatus` disposition 属于持久幂等命令身份；
- 删除旧 `CompressionUpdate` 原地 mutation；
- historical ModelContextProjection 永不被 replacement 重解释。

## 简化边界

- 不做 balanced tree、closure table 或 graph database；
- 不做 root/node online retention/GC；
- 不复制完整 prefix/source links；
- 不把 Provider retry 扩展为通用 external auto-retry；
- 不建 ProviderContinuation table；
- 不让 UI current Message 状态改变 historical replay。

## 完成标准

- 每轮新增存储与 compression node count 满足量化 gate；
- source occurrence identity、branching DAG、current head 与 tail stop 的 schema/index tests 通过；
- retry/edit/fork 可从旧 parent 合法分支；
- historical projection 在后续 edit/delete 后精确 replay；
- compression 不同时物化 summary 与被替换原文；
- immutable replacement 不修改旧 summary/projection；
- ModelStreamCheckpoint 在 terminal 后按受控 retention 收敛，容量/Completed fence/prune 全部由固定 writer operation 在一个事务中决定；
- Provider reconnect/retry 始终使用完整 frozen request，late socket generation 不重复输出；请求级取消即使 adapter 永不 settle 也可持久收口；
- candidate stable IDs `candidate.context-storage-growth`、`candidate.context-compression-node-bound`、`candidate.provider-continuation-disabled-full-request`、`candidate.conversation-fork-links`、`candidate.compression-immutable-replacement` 有真实证据。
