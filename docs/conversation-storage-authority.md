# Conversation 可靠存储权威模型（Epoch 6）

## 1. 目标

Conversation 可靠存储采用**单写者、显式文件归属、mutation 驱动编译、HEAD 提交点**。任何权威文件都必须由唯一 Storage HEAD 持有；任何读取权威文件的路径都必须先取得对应 HEAD 的稳定租约。

本设计不支持旧 schema 导入、双写、ownership handoff、目录 diff 编译、缺字段默认值、静默修复或旧格式迁移。开发期数据格式变化通过 `DATA_FORMAT_EPOCH = 6` 做单向切换；旧 epoch 必须显式重置，不能被当前代码读取。

## 2. 原始故障根因

旧的 Conversation 快照写入会在未发生领域 mutation 时创建多个空 compression index，例如：

```text
compression-block-llm-invocation-links/conversations/<shard>/index.json
```

随后可靠事务建立 Storage HEAD 时，只登记本次 transition 真正处理到的文件。于是磁盘上出现“位于可靠 namespace 内、但不属于任何 HEAD”的文件，下一次压缩事务在 prepare 或启动校验阶段失败：

```text
Unowned file appeared beneath an established Storage HEAD
```

这不是单个 index 的问题，而是以下架构冲突的结果：

1. 多个 writer 可以直接发布同一领域文件；
2. 一个 Conversation HEAD 同时承担控制版本和多个物理领域；
3. compile-tree diff 根据目录现状推断 mutation；
4. 派生索引、缓存和权威数据没有明确 durability class；
5. 启动校验只做 HEAD → 文件，没有完整执行文件 → HEAD 反向校验。

## 3. Durability class 与唯一 writer

`StoragePathAuthorityRegistry` 是可靠 Conversation 文件 namespace 的唯一注册表。

| Durability class | 含义 | 唯一 writer |
| --- | --- | --- |
| `authoritative-mutable` | 可变、必须被 HEAD 持有的领域或资源记录 | `conversation-transaction-backend` |
| `derived-projection` | 可从 committed facts 重建的读模型 | `derived-projection-writer` |
| `immutable-content` | 内容寻址或 write-once 数据 | `immutable-content-writer` |
| `transaction-control` | WAL、claim、receipt、HEAD、owner lease | `transaction-control-writer` |

可靠事务只能发布 `authoritative-mutable` 文件。直接 writer 必须先通过 `assertLiveWriteAllowed` 校验对应 durability class。注册表没有“单 Conversation 猜测”、路径包含 shard 推断或未知 scope fallback。

## 4. HEAD 拆分

每个 Conversation 使用八个相互独立的 HEAD：

```text
conversation:<id>:control
conversation:<id>:runtime
conversation:<id>:timeline
conversation:<id>:compression
conversation:<id>:tool_calls
conversation:<id>:tool_events
conversation:<id>:tool_results
conversation:<id>:interactions
```

其中：

- `control` 只保存 `controlVersion`、patch sequence 和 transition 顺序，不持有业务文件；
- `runtime` 只持有 `runtime-authority.json`；
- `timeline` 持有 Message chunk 以及 revision、project、checkpoint 等 sidecar，不持有 ToolCall / ToolCallEvent；
- `compression` 持有四类 canonical compression record store；
- `tool_calls` 持有 ToolCall record store；
- `tool_events` 持有只追加的 ToolCallEvent record store；
- `tool_results` 持有 ToolResultArtifact 与 ToolCallResultLink record store；
- `interactions` 持有 InteractionRequest record store。

共享资源使用独立 resource HEAD：

```text
resource:conversation-attachments
resource:answer-bridge-links
```

Conversation、Attachment、AnswerBridge 互不嵌套；事务可以临时租用多个 HEAD，但关系和资源所有权仍是独立数据。

## 5. 确定性 mutation 编译

`RuntimeAuthorityAdapter.compile` 先将 `recordMutations` 应用为完整 post-state，再调用确定性编译器：

```text
compileTimelinePostimages
compileCompressionPostimages
compileToolCallPostimages
compileToolCallEventPostimages
compileToolResultPostimages
compileInteractionPostimages
compileAttachmentRecordPostimages
compileAnswerBridgePostimages
```

编译规则：

1. 只处理 mutation 明确触及的 canonical family；
2. 不因 sibling family 变化创建空 index；
3. 已存在记录复用 index 中的稳定文件名；
4. 新文件名由 transition 时间、可读 slug 和 ID hash 确定；
5. 删除由 current/post-state 直接计算为 delete postimage；
6. 相同输入、相同 `now` 必须生成相同 postimages；
7. 同一个 target 不能由两个编译器生成；
8. 不扫描临时 compile tree，也不通过目录 diff 推断 mutation。

Timeline 中每个 record ID 只允许出现一次。跨 chunk 共享的 ProjectContext、ShadowRepository、repository link 与 Checkpoint 被确定性分配给首次引用它们的 chunk；读取时遇到重复 ID 直接失败。

## 6. 单写者与创建生命周期

Conversation 从创建起就进入可靠事务：

```text
Create / Fork / Rename / Delete
  -> FileConversationTransactionBackend
  -> prepared WAL
  -> business postimages
  -> domain/resource HEADs
  -> control HEAD
  -> storage_committed
  -> ECS committed projection
```

不存在以下路径：

- 先由 `StorageCapability` 写快照，再把 ownership 转交给可靠后端；
- 空 Conversation store bootstrap；
- System 创建 placeholder/skeleton Conversation；
- 直接递归删除 Conversation 目录；
- Conversation runtime 的 legacy drain 或双 writer。

`AgentSpawnSystem` 只能链接已存在的 Conversation；Agent、Conversation 与 Link 始终独立建模。

## 7. Canonical、derived 与 immutable 数据

### 7.1 Canonical

- runtime authority；
- timeline Message chunks 与非工具领域 sidecars；
- 四类 compression records；
- ToolCall records；
- ToolCallEvent records；
- ToolResultArtifact 与 ToolCallResultLink records；
- InteractionRequest records；
- attachment records；
- AnswerBridge records。

Canonical reader 必须校验 schema、ID、排序、时间戳、hash、count、文件集合以及跨记录引用。它们不会过滤坏记录、补 index、跳过未知文件或改写磁盘。

### 7.2 Derived

- Run History：从 committed facts 按请求纯投影；
- conversation history：可重建 sidebar 读模型；
- attachment opened files：仅供 VS Code 打开附件；
- UI 查询状态与内存 lookup。

Derived 数据不拥有 resource HEAD，不能进入 authoritative transaction postimages。

### 7.3 Immutable

Attachment blob 与大型 ToolResult blob 先以内容寻址方式写入各自 immutable namespace，然后对应 canonical record 在事务中发布。崩溃只可能留下没有 canonical record 的 blob-first staging。GC 的 mark 集合只来自已提交的 canonical records；canonical record 指向缺失 blob 时必须失败，GC 只删除未被 canonical record 标记的中断 staging。

## 8. 读取屏障

- Conversation facts：`readCommittedView` / gateway committed read；
- Attachment 与 AnswerBridge 共享资源：`readStorageResource`；
- Timeline page 与 Run History：先读取 committed facts，再执行纯投影。

Router、LLM provider 和 UI reload 不能直接读取 canonical record store。托管附件解析由 `BackendApplication` 取得 attachment resource HEAD 租约后调用 strict canonical reader；本地路径附件不属于该资源。

## 9. 启动时双向校验

启动顺序为：

1. 获取 data-root 单写者 lease；
2. recovery 所有 prepared WAL；
3. 读取并校验全部 HEAD；
4. 校验 domain HEAD 必须有对应 control HEAD；
5. 校验 HEAD 中每个 target 都属于注册表声明的 owner，且 hash 一致；
6. 按注册表的 authoritative inspection entries 枚举物理文件；
7. 校验每个物理 authoritative 文件都被唯一 HEAD 持有；
8. 发现缺失、未登记、重复归属、未知 namespace 或 hash drift 时关闭 mutation admission。

不能在启动校验失败后继续运行，也不能创建空 index、重建 canonical 数据或静默忽略额外文件。

## 10. Epoch 规则

Epoch 6 是单向格式边界：

- runtime schema 固定为当前 schema；
- WAL `operation` 必填，不默认成 `write`；
- ToolCall、ToolCallEvent、ToolResult 与 InteractionRequest 使用独立领域 HEAD，不再作为 timeline sidecar 或工具依赖 projection 持久化；
- ToolCall 的 `schedulingOrdinal` 与 `schedulingMode` 必填；
- Message internal/visible 只由显式 `presentation` 决定；
- pending command session 使用当前 epoch 专用 key，不迁移旧 session schema；
- 不读取 Epoch 5 timeline、旧 compression projection、attachment references cache、disk Run History 或旧 Conversation snapshot。

发现旧 epoch 或未标记的受管数据时，返回显式 `migration_required`/reset 提示；这里的“migration”仅表示用户需要切换或重置整个 data root，不存在业务记录格式迁移器。

## 11. 变更检查清单

新增可靠存储文件或目录前必须回答：

1. 它属于哪一种 durability class？
2. authoritative 文件的唯一 HEAD owner 是谁？
3. 唯一 live writer 是谁？
4. 是否由明确 record mutation 编译，而不是目录现状推断？
5. 是否在注册表中同时声明 namespace 与启动 inspection entry？
6. canonical reader 是否执行 index ↔ physical files 双向校验？
7. 读取是否持有对应 committed HEAD/resource HEAD 屏障？
8. 派生数据是否被错误加入 transaction 或 HEAD？
9. 是否引入旧 schema、默认缺字段、静默 repair、catch-and-continue 或双轨写入？
10. 是否覆盖 crash point、roll-forward、重启、越权文件、多 chunk shrink、附件与压缩集成测试？
