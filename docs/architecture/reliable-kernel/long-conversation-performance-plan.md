# 长会话与多 Agent 数据链性能优化方案

> 日期：2026-10-17。状态：已实施，构建、类型、核心与浏览器验证完成。
>
> 实施结果：[长会话与多 Agent 数据链性能优化实施报告](./long-conversation-performance-implementation.md)。下方保留审定方案与验收要求。
>
> 源码基线：`v0.0.42`，`cbd46a9876233713b16b15ab2bc827fb4935ca9f`，Runtime epoch 6。
>
> 本文件规定实施范围、结构、顺序和验收，沿用现有机器合同；不另建一套门禁或验证账本。

目标是让普通流式更新和当前工作读取退出完整历史，把反复复制累计正文改成保存新增事实。先完成现有格式内的查询、投影和对象复用，再统一实施新存储格式。历史准确性、工具归属、停止收尾和已发布用户数据继续由现有领域与事务承担。

## 执行约束

本方案的所有分析、实现、重构和审查必须读取并应用以下技能：

- `$认知一致性`：[技能正文](/Users/lurenxing/.codex/skills/认知一致性/SKILL.md)。
- `$stop-that-shit:stop-that-shit`：[技能正文](/Users/lurenxing/.codex/plugins/cache/stop-that-shit-local/stop-that-shit/0.2.7/skills/stop-that-shit/SKILL.md)。后续安装路径变化时按同名独立插件定位。

实施必须遵守下列具体要求：

1. **共同语义只有一个入口。** 同一种活跃请求、子任务状态、工具归属、冻结目录、消息正文读取各自有共同实现。迁移全部实际调用者，删除被替代的路径；不在旧链外包一层缓存继续保留重复职责。
2. **在源头减少工作量。** 通过条件查询、已有 ID 索引、稳定对象和新增事实写入解决问题。缓存是可丢弃的派生状态，SQLite、已提交 CAS 和现有关系仍是事实来源。
3. **禁止新增哈希及同用途替代机制。** 不增加 SHA256、MD5、CRC、xxHash、内容指纹、内容签名、验证戳、证明账本或哈希清单。禁止为了缓存命中、一致性或交付，改用反复读取正文、全量 JSON 序列化比较、全历史扫描来实现同一道校验；换名、换算法、换存储位置都不改变这一约束。
4. **保护只放在实际负责的边界。** 每项新增保护须说清真实失败方式、结果由谁使用、失败后采取什么动作。已有 CAS 寻址、事务原子性、归属/租约、RootBinding、已发布数据升级与工具准入合同继续承担原职责；不叠第二套验证、恢复或迁移框架。缓存直接使用既有 ID、revision、请求实例和提交事件。
5. **最小必要实现允许充分重构。** 以理解和维护成本判断结构，不按 diff 大小限制重构；不建设通用查询 DSL、状态注册平台、持久 Map 框架、通用日志框架或额外 writer。
6. **测试对应具体问题。** 优先复用已有夹具和测试，只补本方案列出的真实覆盖缺口。禁止覆盖率驱动的排列组合、重复基准、无用校验脚本和额外证明文件。相关输入未变时复用已通过结果，必要验证通过后交付。
7. **授权范围持续有效。** 本轮交付方案文档，产品代码未实施。后续取得实施授权后，连续完成对应工作包、调用者迁移、清理和必要验证；普通实现选择不重复请求确认。新增高风险操作或实质改变对外行为时再对齐。
8. **保持工作区边界。** 开始前查看 `git status --short`，保留他人的 staged、untracked 和并发修改，只处理本轮明确路径。说明分别列出已实施、定向验证、完整检查和交付状态。

## 独立复核后的决定

本方案采用三名未继承本聊天和上一轮结论的子 Agent 的独立复核结果。它们分别检查后台、前端和存储，只读取原始报告、原始实验与当前生产代码。

- 保留原报告的主线：当前工作专用读取、ID 索引、稳定历史投影、目录一次准备、增量持久化和原生片段追加。
- 重做子任务状态原型。产品的 32 是最多展示 32 个任务卡，原型截断的是每个任务的历史 Turn。初始任务、较早答复和续跑来源必须按实际引用读取。
- 活跃请求消费者共用按 Turn 限定的完整选择器；基准中的空活跃集合和同 Turn 的 16 次调用分开记录。
- 前端同时处理完整会话、单条原生消息内部、RichContent 与工具卡关联；30 行消息窗口之外仍需要内容块窗口。
- 把打开会话的逐 Turn 转向回执查询、协作消息路由全历史查询、停止收尾正文扫描纳入实施范围。
- 目录根、native 工具 proof、工具结果 projection 和原生消息组合统一纳入新存储准入。已发布旧格式按其原定义读取，新写入只用新格式。

## 基线与收益口径

原报告见[优化数据链性能](chatgpt-conversation://6ad3004b-ab9c-83ea-8119-057150b97bf7)。下表中的时间来自原始实验；百分比只用于对应的工作范围。

| 路径与样本 | 基线或原型 | 方案采用的收益定义 |
|---|---|---|
| 一个子任务有 18,000 个 Turn | Worker 快照 1,547.58 ms；截最近 32 Turn 为 4.20 ms | 完整初始任务、答复、续跑和投递语义下重新测量；减少进入状态卡的无关终态历史 |
| 一个 Turn 内 18,000 个已结束请求 | 全读 62.45 ms；全库空活跃集合 0.129 ms | 历史终态请求不再被解码、跨 Worker 搬运；按三个状态与确切 Turn 选择 |
| 同一个 Turn 的 16 次并发读取 | 737.63 ms 与 1.34 ms | 另测 16 个不同 Turn 的读写，记录共享 Worker 排队与执行成本 |
| 18,000 消息、9,000 Turn、9,000 工具、29 条正文就绪 | 投影 461.145 ms；单处 Map 261.404 ms | 该处 CPU 时间下降 43.3%；后续分别测 store、投影、timeline 和真实渲染 |
| 18,000 个目录引用 | 四次解析 84.40 ms；双遍规范化 13.44 ms，单遍 7.36 ms | 同一冻结请求只准备一次；重复规范化下降约 45%；准备次数减少与 CPU 时间分别报告 |
| 100 个 2 KiB 原生文本 item | 消息内容 10,965,467 B，其中累计中间版本独占 10,537,081 B | item 加最终聚合为 428,386 B；新块和描述的实际字节也计入新方案 |
| 18,000 Turn，零条转向回执 | 1 次全 Turn 查询与 18,000 次串行空查询 | 收敛到一次会话范围 Worker 读取；有回执时再按需批量读取正文 |

“目录累计 16.2 GB”是连续新增 18,000 次、每次约 100 B 且每次保存完整目录的条件计算。100 次工具调用、每次 proof 与结果各携带约 1.59 MB 目录时，目录重复约 318 MB，也是条件计算。两者用于定位写放大，新实现使用实际写入统计验收。

## 第一阶段 现有格式内减少重复工作

### A1 统一当前工作读取

**入口：**`agentLoop.ts`、`modelProviderControlPlane.ts`、`nativeSteering.ts`、`collaborationControlPlane.ts`、`automaticRuntimeDelivery.ts`、`runtimeDatabase.ts` 及固定 Worker 查询。

- 提供共同的 `activeModelRequests(turnId)` 语义，完整返回该 Turn 的 `prepared / streaming / retrying`。压缩取消、停止与交还消费者全部迁入。三个状态分别选择并复用现有状态索引，页数由实际结果决定，不使用固定 1,000 条截断。完整历史按 `request_seq` keyset 读取。
- 转向回执在同一 Worker 读事务中按 Conversation 关联 `Turn` 与 `PendingTurnInput`，保留既有 Turn 顺序及每 Turn 回执顺序；取消窗口线程逐 Turn 往返。正文按已有 metadata 批量读取能力处理。
- 协作发送与路由共用当前 Turn 事实读取：按 Conversation 与状态读取至多两条活跃 Turn 以保留唯一性判定；确需空闲锚点时按现有 `(conversation_id, created_at, id)` 索引取最新一条。发送和路由各自保留原有事务状态断言。
- 一次查看实际 SQL 查询计划，确认活跃状态查询没有继续按 owner 扫终态历史；不为查询计划另建检查框架。

**完成条件：**活跃请求不跨 Turn、不截断；零回执会话只有一次范围查询；一条协作消息不再将目标全部 Turn 传回窗口线程并排序。

### A2 统一展示关联索引

**入口：**`reliableConversationProjection.ts`、`ReliableMessageList.vue`、`RichContentView.vue`、`FunctionCallPartView.vue`、`reliableCompressionProjection.ts`。

- 在共同投影入口建立消息、Turn、请求、工具来源、provider call/ordinal、原聚合消息到转向拆分条目的索引。同一投影只建一次，组件复用同一套选择器。
- `ToolCallSourceLink` 继续决定工具归属，保留正文就绪后的关联规则和转向拆分语义。
- 消息楼层、删除数量、工具终态、失败/取消阶段推断、压缩卡位置使用已有索引，移除逐条全数组查找。
- 单个原生消息的工具关联也进入上述索引，避免多消息和单消息多工具两种平方增长。

**完成条件：**同一组输入的完整投影语义保持；工具/消息关联从逐工具全扫变为一次建表、按 ID 取值。Map 原型的内存结果单列：原样本的最大堆增量由 49.79 MiB 变成 54.802 MiB，内存收益由下一阶段的对象与驻留管理承担。

### A3 收窄刷新与重复处理

**入口：**`databaseWorker.ts`、`contracts.ts`、`externalClientCommits.ts`、`clientFeed.ts`、`clientProjection.ts`、`clientWireData.ts`、`conversationContextHandleState.ts`。

- 在现有 writer 删除路径利用删除前的 owner/Link 事实生成小的受影响 Conversation 与引用范围，随现有提交结果和跨 Host 通知传递。本地与外部 Feed 共用作用域解释；窗口外旧消息删除和父子关系删除仍更新实际受影响的数量、楼层与状态。
- 订阅按作用域、已物化记录和已有引用选择刷新范围。未登记提交、通知缺口和现有容量溢出继续走原快照路径，不新增通知账本。
- 历史页先物化最大候选页，能放入预算就返回，超出才缩减；同次缩减复用已取事实。前缀可见计数仍在同一快照内准确计算，不改用物理序号或客户端旧楼层。
- 生产者完成一次 plain-data 转换、裁剪和字节计数，后续层复用最终 wire 对象；保持结构化克隆要求与现有容量边界。
- `canonicalPlainJson()` 边界内只规范化一次，清理已确认的外层重复规范化。
- 普通在线事务按实际触及的 ModelRequest/Operation/Attempt 验证聚合，移除“触及终态 Turn 就遍历全部历史请求”的扩散。保留 Turn 结束的终态集合断言，以及导入、删除和历史修复各自的聚合职责；不新增“已验证”状态。

**完成条件：**无关订阅因结构删除而重快照为零；常规历史页只物化一次；结束长 Turn 时无关旧终态聚合逐条复查归零，本事务聚合错误仍回滚。

### A4 一次准备冻结目录

**入口：**`PreparedModelRequestRecipe`、请求准备 holder、`frozenModelHandleCatalog.ts`、`modelHandleCatalog.ts` 和实际工具/native 消费者。

- 复用现有私有准备对象与 WeakSet 机制，由请求 holder 持有冻结 recipe 和一个 `PreparedModelHandleCatalog`。提交前按生产者持有的不可变对象识别，提交后使用已有 `recipeObjectId`。
- preview、压缩判断、请求创建、dispatch、普通工具参数解析和 native 初始目录消费共用准备结果；清掉随后把准备对象重新 normalize 成普通数组的调用。
- 重新 freeze、压缩换根或 scope 改变就建立新 holder。native 后续分配属于其私有增量，保留产生时含义。
- 活跃请求强持有正在使用的目录，结束/交还时释放；空闲历史缓存继续有界。容量计费使用已存长度，不反复序列化目录或计算新身份。

**完成条件：**同一冻结请求只准备一次；16 个活跃 Agent 轮转不因空闲 LRU 上限反复读取各自正在使用的目录。冷读与跨请求线性建表单列统计。

## 第二阶段 当前状态和界面计算范围

### B1 子任务当前状态与历史详情分开读取

**入口：**`childTaskFactsSnapshot.ts`、`conversationChildTaskProjection.ts`、`childExecution.ts`、`childAgentCoordinator.ts` 及其实际调用者。

- 共用领域选择器和状态解释，分别提供当前状态与完整历史分页入口。状态卡先算全部直接任务的权威状态、队列和待处理投递，再按原有优先级选择最多 32 个卡片。
- 入选卡加载最初 Turn、active/latest Turn、当前答复 Turn、排队 Intent，以及 retry/runtime continuation 的实际来源关系。较早的未处理答复仍参与待处理计数。
- 完整后代身份集合 `childHandleTargets` 保留；成本随任务节点数和必要关系增长，不承诺整个状态操作只有 32 条成本。
- 同一读事务完成选择与关系读取。投影入口按 child/conversation/turn/message 分组索引，消除每输入重新过滤全部修订的平方项；只读取最终需要展示的预览正文。
- 迁移执行快照、调度、恢复和子树控制的实际消费者：当前工作只读取本主体/子树所需关系，需要历史的调用者改用分页或索引聚合。`turn_seq` 分配、总数和谱系判定使用原事实，不依赖截断数组长度。
- 根范围查询由现有 Conversation/Turn 关系驱动，处理根查询扫描全库父子关系的问题；不增加持久汇总表或第二个状态 writer。

**完成条件：**超过 32 Turn、含旧答复与跨窗口续跑来源的样本保持初始任务、当前输入、排序、计数和投递语义；无关终态历史不进入卡片投影。一个任务有很多 Turn 与很多子任务分别验收。

### B2 稳定事实投影和有界驻留

**入口：**Feed store、`useReliableConversation.ts`、transient 状态、混合 timeline、消息列表和内容块组件。

- Feed store 持有唯一的已提交事实。每个原子 changes 批次按 domain/id 更新索引和受影响展示对象；未变 Message、ToolCall、工具数组和已完成内容块保持引用。
- transient 按既有 request/attempt/socket/stream 身份定位当前 item，只更新对应正文。全局提交游标保留因果职责，不再使纯文本 delta 重建历史投影。
- timeline 顺序只随消息成员、转向/协作边界和压缩位置变化而更新；正文变化更新行内容，取消逐帧重建完整行 ID 字符串。
- 历史保存为有成员集合的页面，默认驻留当前阅读页及前后各一页、现有实时尾部。正在编辑、展开或等待交互的记录由其实际使用者持有；共享事实按现有 ID 共用一份。
- 释放页时同时释放投影、正文和详情引用。滚出 live 的记录只交给仍驻留且实际需要它的页面，不再无限并入历史大 bucket。
- 增加 before/after 双向 keyset，按 `(message_seq,id)` 选候选，两方向共用闭包物化。楼层继续使用数据库同快照的 `display_seq`；混合协作卡保留已有 predecessor/exchange 定位。
- 页面释放、重新加载和前插都使用既有 row key 与像素偏移保存阅读锚点。单条原生消息另设可视内容块及相邻预读块窗口，复用同一锚点原则；完整复制和导出按明确请求读取全部内容。
- 已完成 item 稳定保留，在飞 item 局部更新；组件通过共同工具索引取关联。第三阶段接入持久 item 后，展示仍使用这套对象与窗口职责。

**完成条件：**一次尾部 delta 的历史投影处理次数为零，未变对象引用保持；持续翻页后驻留事实和正文回落到约定范围；往返加载无漏项、重复或楼层漂移；消息行与单消息内容块挂载均有界。

### B3 停止收尾只还原必要输出

**入口：**`terminateIfRequested()`、`materializeFailedPartialOutput()`、`closeTerminalToolContext()`、工具结果与 Context 来源读取。

- 停止使用 A1 的共同活跃请求选择器；在 Worker 中挑选实际有待物化失败片段的请求，取消逐个读取所有成功历史请求。
- 根据未闭合工具、已提交输出的工具来源和缺失的 Context 关系定位需要还原的请求；完成工具的 Context 缺口仍处理。候选在同一读快照中取得，随后按供应商顺序收尾。
- 保留“输出已提交但 ToolCall 尚未建成”的崩溃窗口：当前或最新已提交输出及其来源仍作为候选，不只按现存 ToolCall.status 筛选。
- 继续走现有停止、等待收尾、终态事务和删除流程，不新造取消 writer，不重执行已完成效果。

**完成条件：**大量已完成历史旁只有一个未闭合工具时，仅读取相关输出；停止/删除现有队列、跨 Host、后台子任务和真实回执语义保持。

## 第三阶段 统一存储准入和增量正文

### C1 固定已发布边界

[`v0.0.42`](https://github.com/lurenxing628/limcode-test/releases/tag/v0.0.42) 已于北京时间 2026-10-17 13:10:16 正式发布，使用 epoch 6。`runtimeEpochMigration.ts` 的 `LATEST_PUBLISHED_RUNTIME_KERNEL_EPOCH=5` 已滞后；该常量当前未参与运行分支，存储改造不能据此把 epoch 6 当成未发布定义修改。

- 新目录、native proof/projection 与消息组合格式统一进入 **epoch 7**。即使不改变 DDL，旧 reader 无法读取的新 CAS 格式也使用该数据集准入边界。
- 固定实际已发布 epoch 6 的描述，精确支持 6→7，并保留真实已发布 3/4/5 的升级支持。现有 `epoch-to-6` 中断记录按原目标收敛后再进入新准入；不改旧 journal 的目标。
- 复用现有离线 Host 检查、SQLite Backup API、单事务、durable journal 和 RootBinding 流程。升级保留旧行、配方和 CAS 原字节，不在启动时扫描并改写历史正文。
- 已发布 inline 配方、工具定义、旧 native proof/projection、累计消息与 loose CAS 保留精确读取入口。未发布的新格式只维护一套定义，不增加运行时版本协商或字段缺失猜测。
- 新系统描述使用明确的 `ContentObject.content_type` 与领域 kind 进入对应解码器；不通过试读、缺字段或解码失败切换解释方式。
- 本阶段分工作包开发，在同一次 epoch 7 准入与发布中收敛，不为每个优化创建一个 epoch。

### C2 目录根与有限尾块

使用领域专用的不可变目录根和块，不建设通用持久集合框架：

```ts
CatalogRoot = {
  kind: 'context-handle-catalog',
  conversationId,
  identityContractRevision,
  tailBlockContentObjectId,
  allocationHighWater
}
CatalogBlock = {
  kind: 'context-handle-catalog-block',
  previousBlockContentObjectId,
  operations // 至多 32 条 bind / extend-metadata / retire
}
```

- 尾块未满只重写至多 32 条操作，满后封块并接新尾块；根保持固定大小，不保存增长中的块 ID 数组。
- 现有当前目录指针和 `ContextRootHandleCatalog` 指向根；写入口仍是现有 Context handle transition。CAS 先发布，对象登记、根快照和当前 head 在原事务内提交。
- 仅实际 Context admission 发布 binding；未采用的私有分配只保留 high-water。metadata 扩充和退役编号保持原身份规则。
- 旧根激活仍选择同一 `Conversation + Context root + provenance_revision` 的确切快照。fork 的目标根表达目标作用域，共享块只保存不可变事实。
- 冷读沿所选根遍历实际块、一次构建索引，复用现有有界异步读取和取消检查；热请求按 A4 复用准备结果。冷读仍与目录规模成正比，单列块读取次数、物理对象增长及首次打开成本。

### C3 native 工具冻结目录引用

- proof 保留原始参数、冻结 `resolvedArguments/error`、response/call/ordinal、async 和原有 item 身份，把完整目录改成当时**不可变私有目录视图**的 CAS 引用。私有视图可以引用 C2 基底并携带当时新增、附件和 metadata 部分；不引用可变当前指针。
- 目录对象登记与 checkpoint 使用原提交事务，之后再进入现有 admission。恢复直接使用冻结参数，不用当前 resolver 重新解释旧调用。
- 工具结果 projection 同样引用当时目录视图并保存冻结 output，继续在发送前提交；Context occurrence 来源解释、恢复、参数解析共同使用相同目录读取入口。
- 这两条路径都删除完整累计目录的嵌入写法，避免目录当前指针优化后仍按工具次数复制全目录。
- `buildCallProof()` 与 `freezeNativeChildToolProjection()` 直接使用准备视图及本次新增操作，取消逐工具调用的完整目录 normalize/clone；目录引用复用不再先构造一份完整副本。

**完成条件：**固定输入的 proof/projection 字节不再随累计目录项数线性增长；压缩、重试、分支和 producer 删除后，原调用仍使用原始冻结含义。

### C4 原生 item 组合与共同消息读取

- 保留已存在的确定性 item revision、单项 CAS 和逐项 Context 来源。工具 call 项仍由工具 pair 承担 Context occurrence。
- 累计展示 revision 改为小型组合描述，指向有限尾块；块按既有 item 顺序记录 revision 身份、CAS ID 和逻辑片段长度。正文引用以 CAS ID 为准，生产者行删除后仍可按冻结字节读取。采用至多 32 项尾块，不把全部历史 item ID 反复写进根。
- `nativeRequestSession` 停止逐项调用累计全文序列化；单项完成只准备该项和小型组合描述，完整聚合由请求结束或明确完整读取触发。
- `MessageCurrentRevisionLink` 继续指向完整已提交前缀的展示 revision。每项的 item、展示位置和 Context 变化仍按原事务提交。
- 建立一个共同的逻辑 MessageContent 读取入口，支持完整与范围读取。Feed、正文详情、只读历史、侧栏预览、回答/协作读取、失败部分输出、复制与导出统一接入；清理直接把物理 CAS 描述当 MessageContent 的路径。
- `ContentObject.byte_length` 继续表示物理 CAS 字节；组合描述中的逻辑长度用于详情的 totalBytes 与范围读取。长度从本次已生成字节累计，不重新扫描此前累计正文。导航不为取逻辑长度而扫描历史正文。
- Feed 暴露已提交 item 的稳定身份、顺序和 revision 引用；B2 按新增 item 取正文、复用完成块并更新在飞块，消除累计全文的反复传输和解析。
- 正常结束只生成一次普通 MessageContent aggregate；failed partial/rebase 的组合与普通聚合使用同一读取入口。恢复继续读取 item 事实，重复 done 不重复 item、Context 或工具执行。

**完成条件：**中途重开完整显示已提交前缀；文本、工具、思考签名与多 response 顺序保持；20/50/100 项加一个翻倍点的实际新增正文、描述与块字节接近线性增长。单项正文、最终聚合和新描述分别计数。

### C5 复制与合库同时接入引用边

目录根/块、私有目录视图、proof、结果 projection、消息组合根/块之间的引用接入现有 CAS 引用解释与合库依赖图。只解析明确的系统描述类型，不扫描任意用户或工具 JSON。

继续使用已有 CAS 传输、对象登记、packed/loose 读取和来源维护流程。复制、fork、合库后 producer 删除仍能读取共享前缀；缺块按现有对话归属与依赖闭包形成 partial，不另建正文扫描、证明账本或 GC。

## 依赖和并行安排

| 顺序 | 工作包 | 依赖与交付边界 |
|---|---|---|
| 第一批并行 | A1 当前工作读取；A2 展示索引；A3 刷新及去重；A4 目录准备 | 保持 epoch 6 与现有持久格式，按共同入口分别完成调用者迁移 |
| 第二批并行 | B1 子任务状态；B2 稳定投影与驻留；B3 停止收尾 | B1 复用范围查询；B2 依赖 A2/A3；B3 依赖 A1，保留崩溃窗口候选 |
| 第三批 | C1 epoch 7 准入，然后 C2/C3 与 C4 并行 | C3 依赖 C2；C4 与 B2 联调；C5 与所有新 CAS 表示同批完成 |

`databaseWorker.ts`、`runtimeDatabase.ts`、Feed store 等共同文件由同一工作包主实现者合入，其他并行任务提供明确接口需求；避免多个 Agent 同时改同一提交权威。

暂缓新增持久 `NativePending` 表或新的状态 writer。当前 native pending 查询仍会发现历史 admission，这个成本保留在真实 native 基准中单列；先完成上述秒级读取、平方投影和累计正文放大。后续若该查询成为主要剩余热点，再沿 native 准入、结果、Context 与投递的共同 writer 设计工作关系，不能仅按 `terminal`、最新 Turn 或最近 N 条排除未闭合工作。

## 必要验收

复用现有测试，按工作包补实际缺口；本轮方案阶段不运行产品构建和完整测试。

| 工作包 | 复用入口 | 需要补齐的具体行为 |
|---|---|---|
| A1、A3 | `client-feed-external-refresh.test.mjs`、`collaboration-message-delivery.test.mjs`、现有模型 provider 测试 | 两个 Turn 三种活跃状态及超过单页结果；零回执查询次数；无关删除零重快照、窗口外相关删除仍刷新 |
| A2、B2 | `ui-workflows.test.mjs`、`collaboration-ui-view.test.mjs`、`webview-session-thinking.browser.mjs` | 多工具聚合、连续转向、失败/取消；尾部 delta 对象复用；页释放再加载；混合卡位置与滚动锚点；单消息内容块窗口 |
| A4、C2、C3 | `ci-context-handles.test.mjs`、`ci-native-lifecycle.test.mjs` | 目录只准备一次、16 Agent 轮转、H1–H4 既有分支/退役/分配规则、冻结参数重放 |
| B1 | `child-execution.test.mjs`、`collaboration-ui-view.test.mjs` | 超过 32 Turn、较早答复、源 Turn 继承、队列未准入、状态排序及完整后代身份 |
| B3 | `conversation-stop-delete.test.mjs`、native context/recovery 既有用例 | 输出已提交而调用未建成、终态工具缺 Context、跨 Host 停止与删除收尾 |
| C1、C4、C5 | `storage-root-upgrade.test.mjs`、native lifecycle、fork 与历史合库测试 | 精确 6→7、中断日志恢复；流中重开、重复 done、partial/rebase、多 response；复制后 producer 删除与缺块 partial |

基准分别使用 18,000 个短 Turn、单 Turn 大量请求/工具、加载大量历史后的流式更新、16 个不同 Agent 混合读写。普通工具与完整 native admission/result/Context/delivery 分开造样本。

优先验收返回/解码范围、Worker 往返次数、准备/解析次数、未变对象复用、挂载节点、实际写入字节与停止/恢复进展。时间记录同机前后分布；原报告的 1 ms、10 ms、16 ms 不直接变成跨机器正确性门槛。采样安排只覆盖这些路径，不建立通用压测平台。

每个工作包完成定向验证；所有实现收敛后完成仓库要求的构建、类型检查和完整检查，已通过且输入未变的结果复用。新失败按对应原因修复、重跑受影响范围。文档、合同与实现同步更新，明确实际完成状态；打包、发布和安装按后续明确任务另行执行。
