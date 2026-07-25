# 模型上下文投影、中断与压缩一致性

本文描述 LimCode 中 `Message`、运行终止事实、模型上下文、工具交换和压缩之间的边界。新增或修改任何 LLM 请求、压缩、历史重放、dry-run、fork、retry 或消息编辑逻辑时，都必须遵守本文不变量。

## 1. 核心原则

页面历史、可靠运行事实和发送给模型的上下文不是同一个投影：

```text
durable facts
  ├─ UI projection：保留可审计记录
  ├─ ModelContextProjection：只输出本次模型可见语义
  └─ run/compression replay：读取当时冻结的不可变投影
```

因此：

- 停止后的 partial 输出可以保留在 durable Message 中；
- UI 默认折叠 partial，只显示终止占位，可显式展开审计；
- fresh 请求和压缩不能重新发送 raw partial；
- 同一 Run 的显式恢复可以使用受控的 resume 上下文；
- Provider 不能自行猜测某条 Message 是否有效。

## 2. 事实模型

### 2.1 Message 只表达物化状态

`Message.status` 只允许：

```text
streaming  正在物化
final      已完成物化
partial    保留了未完成的实际输出
```

它不再表达取消原因、Provider 错误类别或 Run 终态。

### 2.2 RunTermination 是独立事实

异常终止由独立记录表达：

```ts
RunTerminationRecord {
  id;
  runId;
  kind;
  actor;
  interruptedPhase;
  reasonCode;
  triggerRunId?;
  createdAt;
}
```

禁止重新添加：

- `Message.stopReason`；
- `Run.terminalReason`；
- 写入 `Message.content` 的 `[任务已暂停]`、`[任务已替换]` 等状态尾注。

正常完成的 Run 不应拥有 `RunTermination`。异常 terminal Run 必须且只能拥有一条 canonical termination fact。

### 2.3 关系保持独立

模型上下文快照和来源通过独立记录建模：

```text
ModelContextProjection
RequestModelContextProjectionLink
CompressionModelContextProjectionLink
ModelContextProjectionSourceLink
```

`ModelContextProjectionSourceLink` 同时记录：

- `conversationId`：关系和 projection 的存储 owner；
- `sourceConversationId`：被引用事实的领域 owner。

两者在 source-conversation 场景可以不同。不要把 source Message、Run、ToolCall 或 CompressionVariant 嵌入 projection 主体。

## 3. 唯一上下文入口

所有模型可见历史必须经由：

```ts
projectModelContext({ facts, purpose })
```

核心模块位于：

```text
backend/modelContext/
  modelContextProjector.ts
  toolTurnNormalizer.ts
  projectionRecords.ts
  projectionFingerprint.ts
  sourceFingerprint.ts
  compressionSourceGraph.ts
```

适配器只负责把事实转成 stable-ID view：

```text
World -> modelContextFactsFromWorld
DurableConversationFacts[] -> modelContextFactsFromDurable
```

适配器、Planner、Router 和 Provider 都不能再维护另一套消息筛选算法。

## 4. Purpose 语义

### 4.1 fresh

用于新的模型回合：

- 排除 streaming Message；
- partial model Message 不发送 raw text、thought、signature、provider context 或未提交 function call；
- 保留显式 `<turn_aborted>` 边界；
- 保留已完成的 durable ToolCall/Tool result；
- unresolved call 生成确定性的 interrupted output；
- 排除属于其他 queued/active Run 的输入；
- `historyMode` 只作用于非当前 Run-scoped 历史。

### 4.2 same_run_resume

只用于恢复同一个 Run：

- 可以读取该 Run 当前 streaming/partial body；
- 不得作为新 Run 或普通 fresh 请求的默认模式；
- 必须保留 exact Run、request、invocation、modelMessage 身份。

### 4.3 dry_run

历史 dry-run 读取已持久化的 exact projection：

- 不查找“最新 model Message”；
- 不从当前 Message.content 重算历史；
- Request 必须有唯一 `RequestModelContextProjectionLink`；
- compression 必须有唯一 `CompressionModelContextProjectionLink`；
- 缺少快照时 fail closed，不使用当前设置或当前内容猜测。

### 4.4 compression

自动、手动、分段和 task-list snapshot 共用 projector：

- stopped raw partial 不进入 summary source；
- 工具 call/result 必须以完整交换为选择单位；
- predecessor variant、segments、prior summary 和 result addenda 在规划时冻结；
- task-list addendum 从边界内 canonical ToolCall facts 生成；
- Provider 完成后只能附加冻结的 addendum，不能重新读取 live World。

## 5. Revision 与精确重放

模型内容来源是 `MessageRevision`，不是可变的 `Message.content`：

1. Run 冻结输入优先使用 `AgentRunInputRevision`；
2. 普通 live 历史使用唯一 current revision；
3. replay 使用 projection manifest 指定的 revision；
4. 缺少或歧义 revision 时产生 error diagnostic，并拒绝请求。

持久化 projection 至少包含：

- canonical contents；
- ordered source manifest；
- source fingerprints；
- projection fingerprint；
- token count；
- compression segments/prior summary/result addenda（如适用）。

## 6. 工具交换原子性

工具关联和修复只由 `toolTurnNormalizer` 定义。匹配优先级：

1. exact `functionCallId`；
2. 同一 model Message 内唯一的 name + canonical args；
3. call 与 response 都无 ID 时才允许 name FIFO；
4. 多候选产生 ambiguity diagnostic，不任意配对。

可靠路径中 `ToolCall.result` 保存原始工具输出。模型响应 envelope 只在物化 function response 时增加一次：

```ts
{ ok: true, output: rawToolResult }
```

禁止提前把 `{ ok, output }` 再写入 `ToolCall.result`，否则会产生双层 envelope。

Provider 边界只执行 canonical assertion。若仍存在 orphan response 或 unresolved call，应抛错，而不是静默改写最终请求。

## 7. 压缩来源图与完成 CAS

每个 compression projection source 都带 exact fingerprint。MessageRevision fingerprint 还包含：

- revision 内容；
- Message role/status/seq；
- Message 所属 Run IDs；
- 每个关联 Run 当前的 termination fact 或 null。

因此以下变化会使旧压缩来源失效：

- Message current revision 改变；
- Message 从 final 变为 partial；
- 新增、删除或改变 RunTermination；
- ToolCall 结果或状态改变；
- predecessor variant 改变；
- runtime snapshot 改变。

压缩完成回调必须再次验证整个递归 source graph。验证失败时：

```text
Operation/Attempt -> failed
CompressionBlock -> stale
CompressionContextVariant -> 不写入
```

编辑、删除、终止、重生成、禁用或修改 variant 时，需要沿 predecessor/source graph 级联失效或删除依赖块。

## 8. Generation fence 与晚到事件

停止事务必须原子完成：

- 保存最后 durable checkpoint；
- Message streaming -> partial；
- 写入 RunTermination；
- 终止 Request/Invocation/Operation/Attempt；
- 写 terminal stream fence；
- 清除 stream buffer；
- abort 外部 LLM/tool capability；
- 失效受影响的压缩来源。

晚到 delta、checkpoint、final callback 或 compact completion 必须通过 Attempt generation / stream fence / source-graph CAS 被拒绝，不能重新写回 UI、World 或 durable facts。

## 9. UI 行为

终止后的 partial Message：

- 默认显示紧凑终止占位；
- 明确提示“未计入模型上下文”；
- 可显式展开审计内容；
- 折叠时不允许误复制 raw partial；
- 不允许以 partial/streaming Message 作为 fork floor；
- retry 会删除旧审计 partial，并从冻结用户输入创建新 Run；
- compression 只使用中断边界和已完成工具事实。

持久化 Message 不因 UI 折叠而物理删除。

## 10. 修改检查清单

新增模型请求或历史功能前检查：

1. 是否直接从 `Message.content` 拼接 Provider contents？必须改为 projector。
2. 是否用“status 不是 streaming”作为资格判断？禁止。
3. 是否明确传入 exact Run/request/invocation/modelMessage？
4. 是否读取 exact MessageRevision？
5. 工具 call/result 是否经统一 normalizer？
6. token/hash/preflight 是否基于 canonicalized contents？
7. 压缩 addendum 是否在规划时冻结？
8. 完成回调是否验证 generation 和 source graph？
9. dry-run 是否读取持久化 projection 和执行配置快照？
10. source relation 是否记录独立的 sourceConversationId？
11. Provider 是否只做 assertion，而非业务修复？
12. UI 是否把 durable audit 与模型可见上下文分开？
