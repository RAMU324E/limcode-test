# 长会话与多 Agent 数据链性能优化实施报告

日期：2026-10-17。源码基线：`v0.0.42`、`cbd46a9876233713b16b15ab2bc827fb4935ca9f`、Runtime epoch 6。本轮实现统一进入 epoch 7。

本轮已把当前请求、当前子任务和停止候选的读取收敛到实际需要的事实；前端按受影响对象更新，并释放离开阅读窗口的事实与正文；冻结目录由活跃请求持有；原生输出逐项保存正文和有限尾块。原有 SQLite/CAS、领域归属、工具准入、RootBinding 和提交事务继续承担持久化职责。

同一台 Mac 的真实 Worker 复测中，18,000 Turn 子任务的当前快照从 **1,618.409958 ms 降至 2.147875 ms**，保留初始任务、旧待处理答复、实际续跑来源和当前答复；16 个不同 Agent 的共享 Worker 混合读写从 **74.676042 ms 降至 1.778500 ms**。原生输出从 100 项增加到 200 项时，全部新增 CAS 载荷从 **1,125,995 B 增到 2,253,945 B，约 2.002 倍**；基线相应为 3.903 倍。原始结果见 [Worker 基线](../../../tests/reliable-kernel/evidence/long-conversation-implementation/worker-rpc-baseline-mac.json)、[Worker 当前实现](../../../tests/reliable-kernel/evidence/long-conversation-implementation/worker-rpc-current-mac.json)、[原生写入基线](../../../tests/reliable-kernel/evidence/long-conversation-implementation/native-growth-baseline-mac.json)和[原生写入当前实现](../../../tests/reliable-kernel/evidence/long-conversation-implementation/native-growth-current-mac.json)。

目录采用 32 操作块后，18,000 项目录的首次冻结准备增加 **63.476374 ms**；同一冻结请求随后四次解析从 **94.341083 ms 降至 0.008208 ms**，20 次热解析新增 CAS 读取为零。保留有限尾块和活跃 holder，接受这次冷重建代价。真实 native pending 查询仍为 **46.486709 ms**，是本轮保留的主要当前工作查询热点。冷读、热读和剩余成本分别列于后文。

## 1. 实施矩阵

| 工作包 | 已落地的共同入口与行为 | 保留的语义与边界 |
| --- | --- | --- |
| A1 当前工作读取 | [modelRequestWorkSnapshot](../../../backend/reliableKernel/modelRequestWorkSnapshot.ts) 提供确切 Turn 的 `activeModelRequests`；[conversationCurrentWorkSnapshot](../../../backend/reliableKernel/conversationCurrentWorkSnapshot.ts) 提供当前 Turn 与范围转向回执。压缩、取消、交还、协作发送和路由使用这些入口。完整 ModelRequest 历史按 `request_seq,id` keyset 读取。 | 三个活跃状态 `prepared/streaming/retrying` 完整返回；超过 1,000 条继续分页。当前 Turn 读取至多两条活跃记录，保留唯一性判定；空闲锚点按既有索引取最新 Turn。 |
| A2 展示关联索引 | [reliablePresentationIndex](../../../webview/src/domain/reliablePresentationIndex.ts) 与[共同投影](../../../webview/src/domain/reliableConversationProjection.ts) 建立消息、Turn、请求、工具来源、provider call/ordinal、转向和压缩位置索引。列表、工具卡、重试和回执展示共用选择器。 | `ToolCallSourceLink` 决定工具归属；多消息、多工具聚合和转向拆分沿同一规则关联。native 分页窗口只使用已取得的精确 item 身份。 |
| A3 刷新与重复处理 | [clientFeed](../../../backend/reliableKernel/clientFeed.ts)、[externalClientCommits](../../../backend/reliableKernel/externalClientCommits.ts) 使用 writer 在删除前取得的 owner/Link 作用域；历史页最大候选只物化一次，预算缩减复用事实；[clientWireData](../../../backend/reliableKernel/clientWireData.ts) 复用最终 plain-data 和字节计数。普通事务只验证实际触及的 ModelRequest/Operation/Attempt 聚合。 | 窗口外相关删除仍更新数量、楼层和状态；未登记提交及通知缺口沿现有快照路径处理。Turn 结束、导入、删除和历史修复保留各自聚合职责；本事务聚合错误仍回滚。 |
| A4 冻结目录一次准备 | [modelHandleCatalog](../../../backend/reliableKernel/modelHandleCatalog.ts)、[frozenModelHandleCatalog](../../../backend/reliableKernel/frozenModelHandleCatalog.ts) 生成不可变准备对象；[modelProviderControlPlane](../../../backend/reliableKernel/modelProviderControlPlane.ts) 的活跃请求 holder 供 preview、压缩、创建、dispatch、工具参数和 native 初始目录复用。 | 使用既有对象身份和 recipe CAS ID；换根或作用域变化重新准备。活跃请求强持有，结束或交还释放；闲置缓存限制为 8 项、8 MiB，按已有长度计费。 |
| B1 子任务当前状态 | [childTaskFactsSnapshot](../../../backend/reliableKernel/childTaskFactsSnapshot.ts) 按权威状态选择最多 32 个任务卡；[childExecutionFactsSnapshot](../../../backend/reliableKernel/childExecutionFactsSnapshot.ts) 的固定选择器覆盖执行、调度、恢复、子树和续跑等待。 | 每个入选任务保留 first/latest、当前答复、旧待处理答复、实际 continuation 来源和队列。`childHandleTargets` 与后代身份完整；总数和 `turn_seq` 来自原关系及聚合查询。完整历史走独立入口。 |
| B2 稳定投影与有界驻留 | [Feed store](../../../webview/src/stores/useReliableKernelClientFeedStore.ts)、[reliableHistoryResidency](../../../webview/src/domain/reliableHistoryResidency.ts) 持有一份 canonical 已提交事实；共同 projector 只重投影变更 Turn/group。主会话与协作专属历史分别驻留当前页及前后各一页，保留独立 live 尾部；[原生 item 窗口](../../../webview/src/domain/reliableMessageContentWindow.ts) 每页 32 项；[内容块窗口](../../../webview/src/composables/useContentBlockWindow.ts) 最多挂载 32 块。 | 纯正文 delta 复用历史 Message、工具数组和结构索引。主会话及协作专属三来源使用真实 before/after 游标，消息楼层取同快照 `display_seq`；释放、重读和前插以 row key 与像素偏移保持锚点。展开详情和完整复制由实际 owner 持有并释放，混排消息与协作请求完成后共同恢复阅读锚点。 |
| B3 停止必要输出 | [modelRequestWorkSnapshot](../../../backend/reliableKernel/modelRequestWorkSnapshot.ts) 的 `modelRequestStopCandidates` 在同一快照取得 partial 与 tool-output 候选；`agentLoop` 取消活跃请求后共用一次候选快照，再进入既有物化与 Context 收尾。 | 已物化 partial 和完整历史成功输出退出扫描。未闭合工具、终态工具缺失 Context，以及输出已提交但 `ToolCallSourceLink` 尚未建立的崩溃窗口仍进入候选，保持供应商顺序和原终态事务。 |
| C1 epoch 7 准入 | [publishedEpoch6](../../../backend/reliableKernel/schema/publishedEpoch6.ts) 固定实际已发布描述；[runtimeEpochMigration](../../../backend/reliableKernel/runtimeEpochMigration.ts) 支持精确 6→7 及已发布 3/4/5 路径。所有新系统 CAS 类型由 `content_type` 和领域 kind 分派。 | 保留原 Host 离线检查、SQLite Backup API、durable journal、单事务和 RootBinding。旧升级 journal 先收敛到原目标；旧行、配方和 CAS 字节保留，已发布格式继续按原定义读取。 |
| C2 目录根与有限尾块 | [contextHandleCatalogStorage](../../../backend/reliableKernel/contextHandleCatalogStorage.ts) 使用固定大小根和最多 32 条 `bind/extend-metadata/retire` 操作的尾块；原 Context transition 登记 CAS、根快照和当前 head。 | 仅实际 admission 发布 binding，未使用的私有分配保留 high-water。旧根按同一 Conversation、Context root 和 provenance 精确激活；fork 创建目标作用域根，共享不可变块。 |
| C3 native 冻结目录引用 | [nativeToolFacts](../../../backend/reliableKernel/nativeToolFacts.ts)、[conversationChildHandles](../../../backend/reliableKernel/conversationChildHandles.ts) 和[nativeRequestSession](../../../backend/reliableKernel/nativeRequestSession.ts) 让 proof/result projection 引用产生时的不可变私有目录视图，准备对象和稀疏增量直接复用。 | proof 保留原始参数、冻结 `resolvedArguments/error` 和调用身份；projection 保留冻结 output。目录登记与 checkpoint/结果沿原事务提交，恢复使用当时冻结含义。 |
| C4 原生 item 组合 | [turnOutput](../../../backend/reliableKernel/turnOutput.ts) 每项保存独立正文、小组合根及最多 32 项尾块，正常结束生成一次普通 aggregate；[LogicalMessageContentReader](../../../backend/reliableKernel/logicalMessageContent.ts) 统一全文、范围和 item 读取。Feed、Context、恢复、只读历史、回答、协作、预览和复制均接入。 | 原 item/revision 身份与 Context 提交事务保持。item 正文通过 CAS ID 读取，不再读取 producer revision 行。`ContentObject.byte_length` 计物理载荷，组合逻辑长度供详情范围读取；已发布非规范前缀保留原字节。 |
| C5 CAS 引用与合库 | [runtimeMergeConversationOwnership](../../../backend/reliableKernel/runtimeMergeConversationOwnership.ts) 解释目录、私有视图、proof、projection 和消息组合的明确引用边；[runtimeMergeConversationExclusions](../../../backend/reliableKernel/runtimeMergeConversationExclusions.ts) 接入既有归属和依赖闭包，复制、fork、合库及[容量分类](../../../backend/reliableKernel/runtimeContentUsage.ts) 共用新类型。 | packed/loose 与原对象登记流程保持。缺共享块沿既有 Conversation 依赖闭包形成 partial；普通用户和工具 JSON 保留其正文含义。item `revisionId` 用于稳定展示身份，正文依赖指向 CAS。 |

## 2. 同机复测方法

### 2.1 环境与样本

两版均在 Apple M5、macOS `darwin/arm64`、Node `v24.15.0` 上运行，Worker 使用 SQLite `3.53.4`。基线加载已保留的 epoch 6 compiled 目录，当前版加载同一仓库的 epoch 7 编译产物。Worker、原生写入、目录冷/热读取分别使用同一份脚本与相同参数运行两版；脚本及逐次原始数据保存在[实施复测目录](../../../tests/reliable-kernel/evidence/long-conversation-implementation/)。

Worker 样本使用真实 `RuntimeDatabase` Worker、RootBinding 和既有 timing sink。夹具按生产 DDL 构造完整 Request/Operation/Attempt 关系，需要正文的结构读者通过实际 CAS 登记内容。两版数据库均有 18,019 个 Turn、54,054 个 ModelRequest、36,003 个 ToolCall，SQLite 文件为 158,593,024 B。样本同时包括：

- 18,000 个短 Turn，其中一个仍活跃。
- 同一 Turn 的 18,000 个终态请求，以及分别处于三个活跃状态的 3 个请求。
- 一个经历 18,000 Turn 的子任务，包含较早的待处理答复、实际续跑来源、当前答复及排队 Intent。
- 18,000 个已闭合普通工具加一个未闭合普通工具。
- 18,000 个具有完整 admission/result/Context/delivery 关系的已闭合 native 工具，加一个真实 pending native 工具。
- 16 个不同 Agent/Conversation/Turn 共用一个 Worker，各有 1,125 个历史请求和 3 个活跃请求；每轮 32 次读取与 4 次 Turn 元数据写入。

Worker 查询先预热一次，再记录 5 次；混合读写先预热一轮，再记录 5 轮。API 时间包含调用到响应的完整等待，Worker 排队、执行和往返使用既有指标。返回 JSON 字节在计时后按 UTF-8 统计，BigInt 转成十进制字符串，用于对比实际返回数据的体积；该数值表达 JSON 载荷大小。完整采样方法见[Worker 脚本](../../../tests/reliable-kernel/evidence/long-conversation-implementation/worker-rpc-retest.cjs)。

### 2.2 当前工作与完整历史

下表时间为 5 次采样的中位数。返回行数汇总响应中的领域事实行。

| 读取路径 | 基线 API ms | 当前 API ms | 返回事实行：基线 → 当前 | 返回 JSON B：基线 → 当前 |
| --- | ---: | ---: | ---: | ---: |
| 18,000 短 Turn：当前工作观察 | 26.419167 | 0.088125 | 18,000 → 1 | 3,672,012 → 250 |
| 同 Turn 18,000 终态 + 3 活跃：活跃请求 | 61.927875 | 0.106625 | 18,003 → 3 | 12,140,997 → 2,103 |
| 同一 Turn：完整请求历史 | 59.849250 | 46.094250 | 18,003 → 18,003 | 12,140,997 → 12,140,997 |
| 18,000 Turn 子任务：语义完整的当前快照 | 1,618.409958 | 2.147875 | 162,024 → 64 | 28,352,484 → 13,580 |
| 普通工具样本：native pending 探测 | 3.102083 | 3.061333 | 0 → 0 | 39 → 39 |
| native 工具样本：native pending | 46.200584 | 46.486709 | 1 → 1 | 300 → 300 |

数据：[基线](../../../tests/reliable-kernel/evidence/long-conversation-implementation/worker-rpc-baseline-mac.json)、[当前](../../../tests/reliable-kernel/evidence/long-conversation-implementation/worker-rpc-current-mac.json)。

当前子任务快照选择 Turn 1 的初始任务、Turn 3 的旧待处理答复、Turn 5 的实际续跑来源、Turn 8 的当前答复和 Turn 18,000 的当前执行，保留两份答复与一个排队 Intent。32 的产品限制用于选择任务卡；该样本通过实际关系选中 5 个 Turn。对应 API 采样范围为基线 **1,597.287125–1,720.333125 ms**、当前 **2.089125–2.422333 ms**，Worker 执行中位数为 **1,557.701208→2.076583 ms**。

完整历史仍返回全部 18,003 个请求。当前工作路径消除了终态历史的解码和跨 Worker 传输；明确请求完整历史时，成本仍随返回数据量增长。这两条入口在基准和实现中分别保留。

### 2.3 16 个不同 Agent 的共享 Worker 混合读写

各 Agent 在同一轮中执行两次读取，每轮其中 4 个 Agent 同时提交 Turn 元数据变更。每轮共 36 次 RPC，5 轮共 180 次；写入 Agent 随轮次轮换。

| 指标 | 基线 | 当前 |
| --- | ---: | ---: |
| 每轮 wall 中位数 | 74.676042 ms | 1.778500 ms |
| 每轮 wall 范围 | 73.628792–76.689459 ms | 1.762958–1.845084 ms |
| 每 Agent 完成延迟，脚本 median | 57.270417 ms | 1.303375 ms |
| 每 Agent 完成延迟，p95 | 73.702583 ms | 1.722834 ms |
| 单 RPC 排队时间中位数 | 26.220021 ms | 0.497583 ms |
| 单 RPC Worker 执行时间中位数 | 1.6775415 ms | 0.0269380 ms |
| 单 RPC Worker 往返时间中位数 | 28.7650000 ms | 0.5506665 ms |
| 每轮返回事实行 | 36,096 | 96 |
| 每轮返回 JSON 字节中位数 | 24,720,759 B | 69,183 B |

单 RPC 中位数由 5 轮共 180 个原始样本合并后计算，偶数样本取中间两项的均值；wall 和每 Agent 指标采用报告中的采样汇总。返回 JSON 的五轮范围分别为 24,720,723–24,720,762 B 和 69,147–69,186 B。数据与各轮队列记录见[基线](../../../tests/reliable-kernel/evidence/long-conversation-implementation/worker-rpc-baseline-mac.json)和[当前](../../../tests/reliable-kernel/evidence/long-conversation-implementation/worker-rpc-current-mac.json)的 `distinctAgentReadWrite`。

### 2.4 保留的 native pending 成本

有 18,000 组完整闭合 native 事实和一项 pending 时，当前 API 中位数为 **46.486709 ms**，范围 **46.150750–46.839916 ms**；其中 Worker 执行中位数 **46.188333 ms**，返回一行、300 B。查询仍需发现历史 admission，并判断 result、Context 和 delivery 是否闭合。普通工具样本对应 3.061333 ms，两个样本分别计量。

本轮沿原方案保留这条完整未闭合工作查询，暂缓持久 `NativePending` 关系和新的状态 writer。后续若继续处理这个热点，应由 native 准入、结果、Context 与投递的共同 writer 表达工作关系，完整保留旧未闭合工具。当前 46.49 ms 的成本计入交付结果。

## 3. C2/A4：目录冷重建与活跃请求复用

### 3.1 相同 18,000 项目录的实测

[目录脚本](../../../tests/reliable-kernel/evidence/long-conversation-implementation/catalog-root-retest.cjs) 一次构造 18,000 个实际目录项，通过生产 helper 保存并通过真实 Worker 登记。当前格式得到 563 个至多 32 操作的块与一个 252 B 根。每次采样重新打开 RuntimeDatabase，创建新的 ContentAddressedStore 和 provider，再准备同一个已登记 recipe；随后在同一活跃 holder 内解析四次。共 5 次采样，文件系统缓存保持操作系统正常状态。`RuntimeDatabase.open` 单独计时，未并入首次冻结准备。

| 指标 | 已发布 inline 目录 | 当前根/块与活跃 holder |
| --- | ---: | ---: |
| 目录项数 | 18,000 | 18,000 |
| 所选目录对象数 | 1 | 1 根 + 563 块 |
| 根对象字节 | 1,591,096 B | 252 B |
| 所选根及块物理载荷 | 1,591,096 B | 2,113,156 B |
| 最大目录块 | — | 3,776 B |
| recipe 载荷 | 363 B | 363 B |
| 首次冻结准备中位数 | 23.500417 ms | 86.976791 ms |
| 首次冻结准备范围 | 23.198500–32.442167 ms | 83.617750–94.541416 ms |
| 首次准备 CAS 读取次数，含 recipe | 2 | 565 |
| 首次准备读取字节，含 recipe | 1,591,459 B | 2,113,519 B |
| 同一冻结 recipe 四次解析中位数 | 94.341083 ms | 0.008208 ms |
| 四次解析额外 CAS 读取 | 4 次 / 6,364,384 B | 0 次 / 0 B |
| 全部 20 次热解析额外 CAS 读取 | 20 次 | 0 次 |
| 当前活跃 holder 释放后再次读取中位数 | — | 78.954000 ms |

数据：[目录基线](../../../tests/reliable-kernel/evidence/long-conversation-implementation/catalog-root-baseline-mac.json)、[目录当前实现](../../../tests/reliable-kernel/evidence/long-conversation-implementation/catalog-root-current-mac.json)。当前 20 次热解析还保持同一准备对象的身份，metadata 查询同样没有增加。

### 3.2 代价与决定

**保留 32 操作块和活跃 holder。** 该样本的首次冻结准备从 23.500417 ms 增至 86.976791 ms，增加 **63.476374 ms**；所选目录载荷增加 **522,060 B**。冷读需要沿 563 个块恢复目录索引，这部分成本仍随目录规模增长。活跃请求随后直接复用已准备的目录，preview、压缩判断、创建、dispatch、工具和 native 入口不再反复读取和规范化整个目录。

将每次冷准备与随后四次解析相加后，五组总耗时的中位数为 **117.539583→86.989875 ms**，下降约 **26%**；该合计直接来自上述[基线](../../../tests/reliable-kernel/evidence/long-conversation-implementation/catalog-root-baseline-mac.json)和[当前](../../../tests/reliable-kernel/evidence/long-conversation-implementation/catalog-root-current-mac.json)的对应 trial。

活跃 holder 的生命周期与请求一致，结束和交还释放。闲置缓存限 8 项、8 MiB，并按已有存储长度及既定内存估算计费；本次大目录超过闲置容量，因此释放后再次打开实际重建，测得 78.954000 ms。活跃 holder 保证 16 个并行 Agent 的正在使用目录不因闲置 LRU 轮转而反复加载。

写入增长由已有[目录定向测试](../../../tests/reliable-kernel/ci-context-handles.test.mjs)覆盖：65 次真实 admission 每次仅生成根和有限尾块两个对象，最后所选链为三个块；fork 只新增目标作用域根并共享块。旧快照、metadata 扩充、退役和未采用分配的 high-water 按实际场景断言。目录复测只统计一次真实目录构造与冷/热读取，admission 的写入范围使用这组既有测试结果。

## 4. C3/C4：冻结引用与原生输出写入增长

### 4.1 native proof/result 的冻结含义

native proof 和结果 projection 保存产生时的不可变私有目录 CAS 引用。proof 保留原始参数、冻结的解析结果或错误、response/call/ordinal/async 身份；结果 projection 保留发送前冻结的 output。私有视图引用确切的持久目录基底和本次新增操作，之后的分配、退役或压缩不改变旧调用含义。

目录从 1 项扩到 18,000 项时，固定输入的 proof 为 **405→407 B**、projection 为 **289→291 B**；连同私有视图的结果发布为 **700→710 B**。已经持有准备目录时，首次 proof 没有额外读取基底 CAS。相关[Context/native 定向测试](../../../tests/reliable-kernel/ci-context-handles.test.mjs)和[恢复用例](../../../tests/reliable-kernel/ci-native-lifecycle.test.mjs)同时覆盖参数冻结、旧错误重放和随后目录变化。

### 4.2 原生链实测方法与总量

[原生写入脚本](../../../tests/reliable-kernel/evidence/long-conversation-implementation/native-growth-bench.mjs) 打开真实 `ReliableKernelApplication`、SQLite 和 CAS，由脚本 provider 在一个逻辑请求中产生 20、50、100、200 个完成文本 item，每项 2,048 B，并正常生成终态 aggregate。每个规模的 `driveMs` 是一次完整 drive 实测。两版的 item revision 数均为 N，展示 revision 数均为 N，最终 aggregate 均为 1。

下表“消息新增载荷”包含所有新增 item 正文、最终 aggregate、每个展示根及**全部尾块版本**。“全部新增 CAS 载荷”再计入 checkpoint、目录、recipe 和工具定义。统计对新增 `ContentObject.byte_length` 求和，覆盖写入既有 packed 容器的新对象；同一 CAS ID 只计一次。

| 完成 item 数 | 基线 drive ms | 当前 drive ms | 基线消息新增 B | 当前消息新增 B | 基线全部新增 CAS B | 当前全部新增 CAS B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 20 | 263.581 | 148.909 | 488,227 | 149,439 | 538,015 | 199,206 |
| 50 | 724.753 | 214.298 | 2,820,442 | 422,903 | 2,936,134 | 538,553 |
| 100 | 1,505.844 | 432.368 | 10,965,467 | 902,620 | 11,188,989 | 1,125,995 |
| 200 | 3,112.889 | 777.777 | 43,233,317 | 1,816,328 | 43,671,165 | 2,253,945 |

数据：[基线逐项分类](../../../tests/reliable-kernel/evidence/long-conversation-implementation/native-growth-baseline-mac.json)、[当前逐项分类](../../../tests/reliable-kernel/evidence/long-conversation-implementation/native-growth-current-mac.json)。

### 4.3 100/200 项全计费明细

| 新增内容类别 | 基线 100 项 B | 当前 100 项 B | 基线 200 项 B | 当前 200 项 B |
| --- | ---: | ---: | ---: | ---: |
| 单项 item 正文 | 215,480 | 215,480 | 431,180 | 431,180 |
| 一次最终 aggregate | 212,906 | 212,906 | 426,006 | 426,006 |
| 旧累计展示正文独占部分 | 10,537,081 | 0 | 42,376,131 | 0 |
| 全部新组合根 | 0 | 20,492 | 0 | 41,192 |
| 全部新组合尾块版本 | 0 | 453,742 | 0 | 917,950 |
| **消息载荷合计** | **10,965,467** | **902,620** | **43,233,317** | **1,816,328** |
| stream checkpoint | 220,412 | 220,412 | 433,512 | 433,512 |
| 目录载荷 | 1,800 | 1,653 | 3,026 | 2,795 |
| recipe 与工具定义 | 1,310 | 1,310 | 1,310 | 1,310 |
| **全部新增 CAS 载荷** | **11,188,989** | **1,125,995** | **43,671,165** | **2,253,945** |
| 新增 ContentObject 数量 | 244 | 346 | 448 | 650 |

100→200 项时，当前消息载荷增长 **2.012284 倍**，全部新增 CAS 载荷增长 **2.001736 倍**；基线相应为 **3.942679 倍**、**3.903048 倍**。新组合保存了更多小对象：200 项时新增 ContentObject 从 448 个变为 650 个；每个完成 item 的写入范围由单项正文、固定根和有限尾块组成，完整聚合在正常结束时生成一次。表内已经计入每个尾块中重复保存的至多 32 项引用。

## 5. 界面投影、正文驻留与预览

### 5.1 对象与读取职责

Feed store 按原子 changes 批次更新 canonical 事实，projector 按 Turn/group 更新受影响的展示对象。纯正文更新复用结构 assembly、索引和工具数组，仅替换 active Message 的既有位置；公共 messages 数组仍浅复制。历史正文、工具对象和已完成内容块保持引用，Message 索引用原 Map 加当前小范围 override。

主会话历史驻留当前阅读页及相邻两页，加独立 live 尾部。页面离开时释放其成员持有的事实、投影与正文；展开详情仍由详情 owner 持有。主会话双向历史使用自然顺序的 before/after keyset，楼层使用服务端同快照的 `display_seq`。真实消息行与单消息内容块都用既有 row key 和像素偏移保持前插及释放后的阅读位置。相关实现见[驻留管理](../../../webview/src/domain/reliableHistoryResidency.ts)和[共同投影](../../../webview/src/domain/reliableConversationProjection.ts)。

native 消息使用 32 项 metadata 页、当前页及相邻页，正文通过 `message-content-item` CAS 详情共用缓存。流中 done 到已提交 item 的交接复用同一 parsed part，最新 32 个 sealed item 在索引接管后释放交接持有者；恢复允许只有小型 done 标记，终态通过 `native_completed` 小事件进入展示。完整复制由独立 owner 按当前 revision 显式读取完整逻辑正文，结束后释放。[内容窗口](../../../webview/src/domain/reliableMessageContentWindow.ts)与[Rich 内容块窗口](../../../webview/src/composables/useContentBlockWindow.ts)覆盖消息内部的长内容。

侧栏预览共用逻辑 reader，并在 [conversationHistoryProjection](../../../backend/application/reliableKernel/conversationHistoryProjection.ts) 中按 block CAS 复用前缀摘要、按 item CAS 复用小摘要。两类 LRU 各限 256 项，每项至多 4,096 字符，随 facade 释放。逐项思考或工具输出只读取新增 item 正文；可见摘要超过 180 字符后继续追加也无需读取新正文。原正文→工具→结果→思考优先级、空白折叠和 177 字符加省略号的展示规则保持。

### 5.2 前端同机数字

[UI 脚本](../../../tests/reliable-kernel/evidence/long-conversation-implementation/ui-projection-bench.cjs) 在同机 Node/Vue 响应式运行时加载基线 HEAD 与当前工作树的真实生产 projector。两种规模为 200/18,000 条消息，每个 Turn 一条 user、一条 model 消息，每条 model 消息关联一个工具，29 条历史正文已就绪。初次投影各计一次；随后替换同一在飞 item 三次，尾部时间取三次中位数。全部原始计数见 [UI 同机结果](../../../tests/reliable-kernel/evidence/long-conversation-implementation/ui-projector-results.json)。

| 样本 | 基线初次投影 ms | 当前初次投影 ms | 基线尾部 delta 中位数 ms | 当前尾部 delta 中位数 ms |
| --- | ---: | ---: | ---: | ---: |
| 200 消息 / 100 工具 | 5.388 | 6.823 | 2.507 | 0.107 |
| 18,000 消息 / 9,000 工具 | 775.007 | 212.429 | 481.520 | 0.143 |

18,000 消息的三次尾部样本为基线 **688.869 / 481.520 / 457.980 ms**、当前 **0.143 / 0.145 / 0.130 ms**。当前每次更新的历史 Message 投影次数、历史正文读取次数和结构 assembly 次数均为 **0**；17,999 个历史 Message、9,000 个 Tool 对象及整个工具数组均保持原引用。初次结构 assembly 为 23.603 ms，包含在 212.429 ms 内。

| 18,000 消息尾部更新的工作范围 | 基线 | 当前 |
| --- | ---: | ---: |
| 每次历史 Message 投影 | 17,999 | 0 |
| 每次已就绪历史正文读取 | 29 | 0 |
| 保持引用的历史 Message | 0 / 17,999 | 17,999 / 17,999 |
| 保持引用的 Tool 对象 | 0 / 9,000 | 9,000 / 9,000 |
| 工具数组保持引用 | 否 | 是 |

堆数据使用 `heapUsed`：初次与每次尾部采样前执行 GC，记录该次计算期间的增量；尾部列出三次中的最大值。

| 样本与时段 | 基线堆增量 MiB | 当前堆增量 MiB |
| --- | ---: | ---: |
| 200 消息：初次投影 | 4.174 | 6.389 |
| 200 消息：尾部更新最大值 | 2.116 | 0.070 |
| 18,000 消息：初次投影 | 209.856 | 154.166 |
| 18,000 消息：尾部更新最大值 | 51.804 | 0.200 |

小样本初次投影增加 **1.435 ms**，初次堆增量增加 **2.215 MiB**；准备稳定桶和共同索引有这项开销。重复尾部更新随后复用这些结构，200 消息下由 2.507 ms 降至 0.107 ms。大样本初次投影和重复更新均下降，公共 messages 数组仍保留一次浅复制。

同一脚本通过真实 Feed store 工作流连续翻阅 **80 页、1,600 条消息**。最大及最终驻留均为 **60 条 Message、40 条正文**，其中 20 条 Message 属于 live，40 条属于两页已访问历史；最多同时驻留两页历史。该样本在向前翻阅时按页面 owner 释放旧事实与正文。主会话往返重读、展开详情 owner 和真实 DOM 锚点由第 7 节的定向测试覆盖。

协作专属历史已补齐三来源双向分页：[cursor 协议](../../../backend/reliableKernel/collaborationHistoryCursor.ts) 明确 `before/after` 方向，响应同时给出两侧坐标与 `hasMore`。[clientProjection](../../../backend/reliableKernel/clientProjection.ts) 沿既有 exchange 序号、全局有界 message 序号加 source/target 关系、作用域 delivery 的 `(created_at,id)` 查询。更早方向（`before`）依次遍历 exchange→message→answer，较新方向（`after`）按反序经过原来源；只有外部对话记录的空扫描页也保留真实已检查边界。

Feed 的协作页保存成员和两侧坐标，按可见卡的 `messageId/acceptedAnswerId` 选择当前页，保留当前页及相邻页；释放 accepted-answer 正文与 peer generation 元数据，展开详情 owner 持有到关闭。列表的“更早/较新内容”可以同时请求消息与协作页，两者完成后共同恢复同一阅读锚点。实际 Feed/MessageList 用例覆盖四页后退、三次 after 重读，普通消息卡与 accepted answer 回到精确边界，展开正文释放后能重新读取；混排浏览器用例让消息先到、协作后到，并包含 173 px 协作卡，阅读像素锚点保持。

## 6. epoch 7 与已发布用户数据

本轮目录根/块、native 工具 proof/projection 和原生消息组合共用一次 epoch 7 准入。已发布 epoch 6 的 113 个领域描述固定在 [publishedEpoch6](../../../backend/reliableKernel/schema/publishedEpoch6.ts)，6→7 保留原领域 DDL 和数据行；升级继续通过既有元数据、manifest 与 RootBinding 流程完成。已发布 3/4/5 的迁移路径继续支持。

中断升级记录按其记录的原目标恢复。尤其现有 `epoch-to-6` journal 先收敛到 epoch 6，再启动 6→7；持久 journal 的原目标保持。离线 Host 检查、SQLite Backup API、单事务提交、备份清理和 RootBinding 重绑定沿既有实现执行。升级不要求批量读取或改写历史正文，旧 recipe、MessageContent、inline catalog、旧 proof/projection 与 loose CAS 的字节保持。

新系统描述通过明确 `ContentObject.content_type` 与领域 kind 选择解码器，新格式维护一套 epoch 7 定义。已发布内容保留其原有版本字段和 reader；普通 JSON 的内容含义不参与新系统描述分派。逻辑 MessageContent reader 在同一入口处理旧普通正文与新组合描述，并分别使用物理载荷长度和逻辑正文长度。

CAS 引用依赖接入原复制与合库流程：目录根到尾块、私有视图到基底和增量、proof/projection 到私有视图、消息组合根到块、块到前序块与 item CAS。实际正文依赖由 `contentObjectId` 表达。fork 会沿原 revision 复制规则携带该消息最新的小型 composition 展示 revision，保留源 `revision_seq` 和原 CAS 字节，因此最终 current revision 已是普通 aggregate 时，目标 Feed 仍能用稳定 item 索引读取。实现入口见[复制 Context](../../../backend/reliableKernel/conversationForkContext.ts)、[fork snapshot](../../../backend/reliableKernel/conversationForkSnapshot.ts)及[CAS 引用解释](../../../backend/reliableKernel/runtimeMergeConversationOwnership.ts)。

## 7. 定向测试覆盖的语义

本节记录围绕实际变化补齐的覆盖范围。完整构建与集成检查状态统一填在下一节。

| 领域 | 已覆盖的具体行为 | 既有测试入口 |
| --- | --- | --- |
| A1 活跃与历史请求 | 精确 Turn、三个活跃状态、超过 1,000 条仍完整、未知 Turn 空集合；同序号以 ID 跨页，完整 1,012 条历史保持 `request_seq` 顺序。 | [ci-model-observation](../../../tests/reliable-kernel/ci-model-observation.test.mjs) |
| A3 事务验证 | 终态 Turn 元数据更新不重审全部旧请求；同一事务触及错误 request 或 operation 聚合时，聚合变化与 Turn 元数据一起回滚。 | [ci-model-observation](../../../tests/reliable-kernel/ci-model-observation.test.mjs) |
| A1/A3 Feed 与范围读取 | 当前 Turn/回执按范围读取；本地与跨 Host 作用域刷新，无关删除保持订阅，相关窗口外删除更新实际数量、楼层与状态。 | [client-feed-external-refresh](../../../tests/reliable-kernel/client-feed-external-refresh.test.mjs) |
| A2 工具与转向关联 | 多工具聚合、provider call 与 response/output item、连续转向、失败/取消、压缩位置；使用共同索引完成对应展示。 | [ui-workflows](../../../tests/reliable-kernel/ui-workflows.test.mjs)、[collaboration-ui-view](../../../tests/reliable-kernel/collaboration-ui-view.test.mjs) |
| B2 稳定事实与驻留 | 尾部 delta 的历史读取为零，历史对象和工具数组保持引用；连续双向翻页释放再读无漏重，楼层稳定，展开详情 owner 保留；96 项 native 分页加在飞第 97 项、完整复制与回尾部。 | [ui-workflows](../../../tests/reliable-kernel/ui-workflows.test.mjs) |
| B2 实际 DOM | 原消息列表不等高前插保持像素锚点；原 MessageItem/Rich 组件最多挂载 32 块，尾部更新保持旧 DOM 身份，前插块保持锚点，完整复制含未挂载的第 160 块。 | [webview-session-thinking.browser](../../../tests/webview-session-thinking.browser.mjs) |
| B2 协作三来源往返 | 真实 SQLite 的 4,096 条 foreign-only 扫描页前后推进，完整 envelope 和最新 retry 重新出现；6 条 message、5 条 accepted answer、11 条 timeline 的双向遍历逐来源返回相同 records 闭包，并逐份读取接受答复正文。实际 Feed/MessageList 四页后退、三次 after 重读、详情 owner 释放与混排共同锚点。 | [collaboration-ui-view](../../../tests/reliable-kernel/collaboration-ui-view.test.mjs)、[webview-session-thinking.browser](../../../tests/webview-session-thinking.browser.mjs) |
| B1 当前任务与执行事实 | 超过 32 Turn 仍保留真实来源和旧答复；42 Turn 的来源场景、35 个直接任务和一个后代的卡片选择；完整后代身份、排队、实际计数及 `turn_seq`。 | [child-execution](../../../tests/reliable-kernel/child-execution.test.mjs)、[collaboration-ui-view](../../../tests/reliable-kernel/collaboration-ui-view.test.mjs) |
| B3 停止窗口 | 大量完整输出旁的必要候选；终态工具缺 Context；输出已提交而 ToolCall/source 尚未形成的窗口；停止与删除沿原队列、终态和跨 Host 行为收尾。 | [conversation-stop-delete](../../../tests/reliable-kernel/conversation-stop-delete.test.mjs)、[native lifecycle](../../../tests/reliable-kernel/ci-native-lifecycle.test.mjs) |
| A4/C2/C3 目录与冻结 | 16 个活跃 holder 轮转不增加基底读取，释放后重建；65 次 admission 的根/尾块范围；旧根、fork、metadata、retire/high-water；18,000 项 proof/projection 不嵌入全目录；恢复重放冻结参数和错误。 | [ci-context-handles](../../../tests/reliable-kernel/ci-context-handles.test.mjs)、[ci-native-lifecycle](../../../tests/reliable-kernel/ci-native-lifecycle.test.mjs)、[runtime-recovery-approval](../../../tests/reliable-kernel/runtime-recovery-approval.test.mjs) |
| C1 已发布升级 | 精确 6→7；已发布旧 epoch 及旧 to-6 journal 的四个持久窗口恢复；旧行与 CAS 读取。 | [storage-root-upgrade](../../../tests/reliable-kernel/storage-root-upgrade.test.mjs) |
| C4 真正文与恢复 | 70 项 Unicode 的实际 HTTP 范围和稳定分页、跨块边界、正常结束一次 aggregate；fork 后删除源 Conversation 并重开，目标 Feed 保留自身 item index；仅允许查询 ContentObject 的 reader 验证 item 正文读取已消除 producer revision 依赖；35 项已发布非规范前缀恢复只读取新增项。 | [native-http-context-completeness](../../../tests/reliable-kernel/ci-parts/native-http-context-completeness.mjs)、[ci-native-lifecycle](../../../tests/reliable-kernel/ci-native-lifecycle.test.mjs) |
| C4 离线读取 | 33 项两块组合的历史正文与 Unicode 范围；原生产者根删除后，离线快照和已有 CAS adapter 仍读取冻结数据，来源文件保持。 | [storage-foreign-history](../../../tests/reliable-kernel/storage-foreign-history.test.mjs) |
| C4 侧栏预览 | 200 次真实 Runtime/CAS/facade 刷新，旧 item 正文零重读；正文接管思考摘要、Unicode 和 180 字符阈值；继续追加 40 项不再读取正文。 | [sidebar-message-count-reuse](../../../tests/reliable-kernel/sidebar-message-count-reuse.test.mjs) |
| C5 引用闭包 | 新类型复制及 streamed merge；共享块缺 body/metadata 时两条实际依赖对话成为 partial，独立对话保留；65 项目录、三个块在复制后删除源 Conversation 仍可读；普通 JSON 保持原解释。 | [runtime-history-merge-core](../../../tests/reliable-kernel/runtime-history-merge-core.test.mjs)、[runtime-history-merge-streamed](../../../tests/reliable-kernel/runtime-history-merge-streamed.test.mjs) |

A2/B2 收口后的 `ui-workflows` 与 `collaboration-ui-view` 合跑为 **55 项通过、0 项跳过、0 项失败**；本轮真实浏览器的混排历史锚点和 Rich 内容窗口两项分别通过。协作专属历史的后端三来源、前端有界驻留及释放后前向回读已纳入这次定向结果。

原机完整检查还定位了一项既有夹具问题：公共临时 `file-mutations` 锁目录存在空 owner 记录，TE10 文件编辑恢复在原版编译产物中同样复现失败。[TE10 用例](../../../tests/reliable-kernel/ci-tool-effects.test.mjs) 已把真实文件变更 registry 放入自身临时目录，继续执行真实 claim、dispatcher、回执缺口恢复及冻结结果重放。原机重跑整份 `ci-tool-effects.test.mjs` 为 **12 项通过、1 项 Linux 专用用例按平台跳过、0 项失败**。

完整浏览器检查中的旧夹具也已迁移：[协作查找](../../../tests/webview-composer-menus.browser.mjs) 使用双向游标和真实 Feed snapshot 初始化已展示卡片；[文件预览](../../../tests/webview-file-change-preview.browser.mjs) 用 snapshot/changes 发布工具与后到成员。长内容窗口加载与应用相同的 theme 样式，并按真实交互悬停消息头、显示操作按钮后正常点击复制。连续搜索、停止、错误后继续、旧卡去重、展开/折叠、32 块上限、锚点和完整复制的原断言全部通过。

## 8. 最终集成检查与交付状态

验证使用 `/Users/lurenxing/GitHub/limcode-test` 的实际工作树。核心、界面行为与同机性能采样分别保留其实际结果。

| 项目 | 最终结果 |
| --- | --- |
| 原机生产编译、类型检查与前端构建 | `npm run check:plan` 通过，包含 extension 编译、Vite 构建、webview 类型检查及 11 份合同检查。 |
| 原机完整核心套件 | 本次重新执行 `npm run test:ci`，核心范围共 542 项：541 项通过、0 项失败，1 项 Linux 专用用例按平台跳过；核心耗时 45.36 秒。 |
| 原机完整浏览器范围 | 本次 `npm run test:ci` 重新执行五份浏览器测试文件，共 13 项全部通过，0 项失败、0 项跳过。 |
| 受最终修改影响的定向复跑 | 先前 UI 工作流与协作视图合计 55/55；旧卡搜索、长内容复制等按具体原因修复后定向复跑通过。本次再次完整执行核心与浏览器套件，全部通过。 |
| 协作专属历史三来源双向回读及驻留 | 三来源真实 SQL 往返、当前页及相邻页驻留、释放后回读、混排卡片位置和分批响应的像素锚点全部通过，已纳入核心及浏览器范围。 |
| 同机 UI 投影与驻留结果 | 第 5 节为原机实际结果。其后变更补齐协作分页、失败提示索引及浏览器夹具，性能样本所测的消息投影和驻留路径保持。 |
| 交付工作树和同步状态 | A1–A4、B1–B3、C1–C5 的源码、调用者迁移、合同、定向测试、报告与同机原始数据已同步到 `/Users/lurenxing/GitHub/limcode-test`。改动保留在工作树；打包、发布和安装继续按后续任务执行。 |

### 本次接续验证（2026-10-17）

在同一 Mac 工作树重新执行完整验证：`npm run check:plan` 退出码为 0，extension 编译、Vite 构建、webview 类型检查和 11 份合同检查通过；`npm run test:ci` 退出码为 0，核心共 542 项，其中 541 项通过、1 项 Linux 专用测试按平台跳过，浏览器 13 项全部通过，失败数为 0，整体耗时 45.4 秒。`git diff --check` 通过。

接续核对使用本报告已保存的原始 Worker、目录、原生输出与 UI 数据。新增代码没有引入哈希计算或额外验证账本；新 CAS 引用继续使用现有 ContentObject 元数据、对象身份与原事务。

## 9. 复现入口

Worker、目录与原生写入三个脚本加载指定 compiled 树，使用临时 Runtime 数据集。以仓库根为当前目录，当前版参数如下；结果输出到临时文件。

```sh
node tests/reliable-kernel/evidence/long-conversation-implementation/worker-rpc-retest.cjs \
  --source-root . --compiled dist/extension --mode current \
  --size 18000 --agents 16 --mixed-history 1125 --repeats 5 \
  --output /tmp/worker-rpc-current.json

node tests/reliable-kernel/evidence/long-conversation-implementation/catalog-root-retest.cjs \
  --source-root . --compiled dist/extension --mode current \
  --size 18000 --repeats 5 --hot 4 \
  --output /tmp/catalog-root-current.json

node tests/reliable-kernel/evidence/long-conversation-implementation/native-growth-bench.mjs \
  --compiled-root=dist/extension --items=20,50,100,200 --item-bytes=2048 \
  --output=/tmp/native-growth-current.json
```

复测基线时，Worker 和目录脚本改为 `--mode baseline` 并指向已发布 epoch 6 compiled 树；原生脚本直接将 `--compiled-root` 指向同一基线。目录基线分支调用已发布 inline reader，当前分支调用实际根/块 reader 和请求 holder。计时样本、返回 JSON 字节、各类 CAS 载荷及冷/热读取次数均保留在本报告链接的原始 JSON 中。

UI 脚本在基线 HEAD 保持为本报告记录的提交时运行 `node --expose-gc tests/reliable-kernel/evidence/long-conversation-implementation/ui-projection-bench.cjs`，分别加载该 HEAD 和当前工作树源码，并将结果写到脚本旁的 `ui-projector-results.json`。

## 10. 首轮 11 项 Review 修复记录

本节记录首轮 11 项问题的修改与当时验证。随后无上下文复审确认其中仍有 9 项同根因遗漏，继续修复的共同入口见下一节。首轮修改包括：无新消息的重试与续跑共用稳定顺序锚点；未准入的子任务续聊在取消、超时与恢复时沿确切 Intent 收尾；native 私有目录和 Context 基底共用原有容量边界内的缓存与活跃持有关系。最终 item 索引复用 aggregate 的实际顺序和已有 item CAS，正常顺序不额外写索引；逻辑正文缓存恢复原 CAS 的 root 与文件生命周期检查。

前端统一解析转向拆分消息的来源，完整复制读取来源正文；展示交接等待当前索引与正文就绪，读取错误可见并复用原重试入口。索引切换释放旧 metadata 请求与 owner，迟到响应不恢复旧详情；整页前插先按内容 key 平移窗口，再恢复像素位置。合库在完整引用图上沿已有删除闭包跳过无需导入的坏依赖，继续处理健康增量。

验证结果：`npm run check:plan` 通过，包含生产构建、webview 类型检查与 11 份合同检查。完整核心运行共 554 项；新增子任务夹具补齐前置 spawn 回执后，相关文件 18 项复跑全部通过，最终合计 553 项通过、1 项 Linux 专用用例按平台跳过。浏览器 13 项全部通过，内容窗口用例已改为整页前插 32 块。已通过且相关输入未变的结果直接复用；本轮未新增哈希、内容指纹或重复校验层。

## 11. 第二轮 9 项遗漏的共同入口修复

| 共同职责 | 修改与实际覆盖 |
| --- | --- |
| 活跃目录的依赖寿命 | `StoredHandleCatalog` 保留确切 `persistentBase` 关系，冻结请求和 native 私有目录共用 holder；Occurrence 只在实际操作期间持有基底，AgentLoop 持有当前轮实际消费的冻结基底，各结束入口统一释放。私有根在同一不可变 overlay lookup 上重放 bind、metadata 与 retire 增量，完整 entries 按实际全量消费者需要懒物化并共享原 entry；读取旧 proof 复用基底索引。18,000 项基底复现中，连续 occurrence 和完整 append 每次只读一次 recipe；结果推进后重读先前 proof，只读取它自己的私有根和增量块，基底零重读，结束后大基底退出活跃缓存。 |
| 正文读取状态与接管 | 移除内容窗口重复的 `pendingKey/error`，由原详情缓存统一派生 metadata、body、loading、error 和可重试状态；projection 与 transient lifecycle 使用同一 readiness。首次终态先于窗口建立时保留可见输出，预取耗尽后的选页保留错误和明确重试，自动重试成功后自然清除旧错误。 |
| 转向分段与完整复制 | native response.created 在已接受转向的后继上确定 `outputItem.steeringSuccessorResponseId`，同一逻辑请求内的多跳普通工具续流继承同一标量；所有输出、恢复、索引与 Feed 解析保留它。完整投影与截窗首段共用该身份和回执证明分类，未证明的前缀只影响所属段，后续已证明边界继续分段；部分驻留时展示与全量复制属于同一段，不读取窗外历史正文。 |
| 阅读位置与思考组件身份 | 列表用一个根 ResizeObserver 延续同一阅读锚点，覆盖 metadata 前插、正文迟到和后续布局变化；原 bottom-sticky composable 统一发布滚动意图，加载期间的新滚动更新当前读点，回到底部清除旧定位，迟到历史页正常驻留。思考组按驻留 item 身份沿用已有 key，整页前插 32 块、释放前缀后保持展开状态，关联随驻留范围释放。 |
| 子任务等待的真实归属 | 新等待的 `Operation.owner_kind` 为 `child_intent_answer_wait`，`owner_id` 直接指向已存在的 `TurnIntent.id`；前台超时、取消、恢复、任务投影和删除使用同一归属。Conversation 最终 writer 在同一删除入口核对未收尾的 Intent 等待，id 与唯一键删除共用；终态 Operation 的父工具结果仍由原 Phase D 按顺序物化。已准入回答核对实际 Turn 代际；已发布 Turn/bridge owner 只保留确切读取和恢复。普通查询从未结算或未物化的工具工作选取候选，已完成取消历史不驱动逐条查询。113 个领域、DDL 与已发布定义保持，工具、子任务、权威合同和现有 Phase F gate 同步。 |
| 逻辑正文的物理读取 | 根和块解析缓存命中、未命中及旧非 canonical item 解码，共用原 CAS 范围读取。65 根造成解析缓存逐出、底层仍有整文件缓存时，以及实际读取旧 item 片段时，均保留既有文件身份检查；不新增哈希、验证账本或重复探针。 |

新增回归放在原有测试文件中，覆盖上述实际失败路径。历史前插测试使用真实 MessageItem/RichContent 和迟到正文，思考组测试覆盖前插与释放前缀；子任务覆盖新 owner 与两种已发布 owner 的超时、取消及结算提交后结果未物化的恢复。

### 本轮最终验证与独立复审（2026-10-17）

最终生产源码统一完成 extension 编译、Vite 构建和 webview 类型检查。Client Feed 新合同的日期修订同步到原校验器和合同 README 后，原精确合同检查通过：11 份合同、7 阶段、3 出口、4 校验器；生产构建结果继续复用。

完整 `npm run test:ci` 执行核心 571 项，浏览器 13 项全部通过。随后按真实有序结果和 complete-batch checkpoint 规则修正新增 WebSocket 夹具：三工具交接未完成的异步尾项，严格验证同一请求内的多跳前驱、聚合正文及生产 Feed 索引与详情中的段身份；共享夹具等待 drive 和诊断回调退出后再重置。生产源码保持该次统一编译结果，整份 `ci-native-lifecycle.test.mjs` 定向复跑 **27/27 通过、0 失败、0 跳过**，其余核心范围沿用同轮完整运行的通过结果。最终合计 **核心 570 项通过、1 项 Linux 专用测试按平台跳过，浏览器 13 项通过**。

六名全新、无上下文的只读 subAgent 分别复审目录、正文状态、转向、阅读锚点、子任务与逻辑正文读取，并独立复现实际调用链。复审发现的旧 proof 目录复制、多跳段归属、加载期间新导航和最终删除竞态均在共同入口修正后回验；最终各组已确认问题全部闭合。目录实测保留基底对象并消除重复全目录 map，滚动后迟到正文的读点偏差为 0.21875px；已取消但等待未收尾时删除整笔回滚，终态结果仍由原 Phase D 按顺序物化。

最终 `git diff --check` 通过。改动保留在当前工作树，沿用原 CAS 身份、引用计数和事务规则；本轮未新增哈希算法、内容指纹或校验账本。

## 12. v0.0.44：修复已发布 epoch 6 的 Packed CAS 升级

v0.0.43 安装后的 SSH 现场出现 `Packed CAS identity does not match the authoritative RootBinding.`：Runtime 已完成 6→7，根代次由 2 推进到 3，Packed CAS 的 `cas_metadata.root_generation` 仍为 2。两边的数据集和根身份相同，原升级的完成 journal、completion 和备份完整；Packed CAS 含 43,330 条正文。原升级夹具全部使用 loose CAS，漏掉了 epoch 6 已发布的 packed-only 正文。

修复在原离线升级内统一推进两份身份：先核验旧 packed schema 和身份，在 Runtime 事务持久化之后，由原 packed worker 单事务更新 metadata 代次，checkpoint、关闭并持久同步后再发布根指针。正文行与 loose 文件保持原字节，普通 reader 继续严格校验完整身份。已完成升级但遗漏 packed 步骤的旧现场，只以确切匹配的原完成 journal、completion、旧绑定、manifest 和备份结构补齐；完成事实写回原记录，后续旧身份倒退明确拒绝。补齐中断后的重入复用同一身份核验，不重新扫描或计算整份备份摘要。已发布 epoch 6 的外来历史通过 recorded 身份只读打开私有副本，来源不原地升级。

新增回归复现原 `packed-cas-corrupt`，并覆盖 packed-only 正文、混合 loose 消息和附件、数据库／packed／指针提交边界中断、旧 completed 补齐及再次中断、未知身份、已完成后倒退和完成凭据冲突。每项直接比较相关行及正文原字节，沿用现有 CAS 与事务合同。

最终 extension 编译及 11 份合同检查通过。升级整文件 **22/22 通过**；CAS、外来历史和目录迁移三份相关测试 **38/38 通过**，共 60 项。独立只读复审确认正常升级、恢复和未知身份拒绝边界闭合；另经真实 epoch 6 外来只读查看读回 packed-only 消息、loose 消息与附件，来源的 epoch、代次和正文保持。未重跑未受影响的完整 UI／核心套件，沿用上一节结果；本次按故障影响范围验证。
