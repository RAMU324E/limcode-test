# 可靠运行内核总计划

> 合同修订：`2026-07-31-r4`
> 当前状态：计划已收口，尚未开始 Phase B SQLite 生产实现或切换
> 使用范围：作者本人、当前 Linux x64 电脑、本地 VS Code Extension Host、手工安装 VSIX
> 计划结构：一份背景、七个实施阶段、三个正式出口

## 1. 一句话目标

保留 LimCode2 已验证的 Agent 运行语义，用一个 SQLite 热控制面和一个 CAS 内容目录替换自制文件数据库，并集中解决：

1. 工具提案、外部执行与模型终态混在一起；
2. 长对话重复复制完整历史，导致近似 O(n²) 的存储、同步和深拷贝；
3. 子代理执行、答案提交、投递、父 Turn 处理与终止控制缺少同一组权威事实；
4. Client changes、后台进程观察和硬切归档没有可执行的容量与恢复边界。

完整来龙去脉见[项目背景](./BACKGROUND.md)。机器定义以 [`contracts/`](./contracts/README.md) 为唯一权威，人读文档只解释边界与实施顺序。

## 2. 最终结构

```text
一个 limcode.sqlite 热控制面
+ 一个 CAS 冷内容目录
+ Turn 唯一执行身份
+ Durable EffectIntent / EffectReceipt
+ RuntimeInboxItem / RuntimeDelivery / RuntimeDeliveryInputLink
+ Persistent ContextSequence DAG / ConversationContextHeadLink
+ ChildExecution + Parent/Turn/Intent/ActiveTurn Links
+ AnswerBridge / AnswerSubmission
+ bounded snapshot / changes ClientState
```

含义：

- SQLite 保存小而关键、需要事务约束的运行事实；
- CAS 保存工具原始结果、文件目标内容、上下文段、答案正文、进程输出 chunk 和回执详情；
- Agent、Conversation、Message、Turn、Tool、Process、Answer 与关系继续独立建模；
- ECS 只接收已提交事实形成只读投影，不再拥有运行生命周期；
- Webview 只接收有界快照和有界 changes，历史大内容按需读取；
- Agent、Workflow、Policy、Prompt、ModelProfile、WorkEnvironment、RuntimeContext 与 Settings 继续位于独立配置文件根，不进入 Runtime SQLite。

## 3. r4 已冻结的首发决定

### 3.1 子树终止

`cancel_subtree` 是首发必选能力，不再属于可降级项。树遍历只依据稳定 `ChildExecutionParentLink`；`ChildExecutionActiveTurnLink` 只是当前活动 Turn 指针。终止事务同时覆盖活动 Turn 与尚未 admit 的 `ChildExecutionIntentLink`。

### 3.2 ProviderContinuation

首发决定为 `disabled-full-request`：

- 每个 ModelRequest 都从冻结的 ContextSequenceRoot 与 immutable recipe 构造完整请求；
- 不建 `ProviderContinuation` Runtime 表；
- 不读取旧 continuation，不产生或发送 suffix；
- 连接重建、压缩和 Provider retry 的正确性不依赖 continuation；
- 将来启用必须修改机器合同，不能用运行时 v1/v2 协商或旧格式 fallback。

因此首发保留“断线后正确恢复”的功能语义，但通过完整请求实现，不承诺 WebSocket suffix 优化。

### 3.3 后台进程

后台进程采用小型 packaged `detached wrapper`，不是通用 daemon/broker：

- wrapper 持续 drain stdout/stderr 到有界 spool；
- stable nonce、process group 与 start fingerprint 防止 PID 复用误判；
- wrapper 原子写真实 exit receipt；
- Extension Host 重启后读取 spool/receipt 并核验结果；
- 无法证明时写 `outcome_unknown`，不得伪造 `abnormal` 或 `exitCode=1`；
- stop 必须核验 nonce/fingerprint/process group，禁止凭裸 PID 杀进程。

`ProcessOutputChunk` 正文进入 CAS，但每个进程仍受 bytes、chunk count 与 flush 上限约束。达到上限后继续 drain 外部 pipe，只累计 `droppedBytes/truncated`，不再无限写 CAS 或 SQLite metadata。

### 3.4 Conversation fork、MCP 与压缩管理

- Conversation fork 保留关系语义，目标 Runtime 使用独立 `ConversationReuseLink`、`ConversationBranchLink`、`ConversationOriginLink`；Context DAG 共享不可变历史前缀；
- MCP 设置保留在 `settings/mcp-servers`，连接在宿主重启后重建；MCP 工具调用进入 `mcp_tool_call` EffectIntent/EffectReceipt，不自动重试，不可核验时 `outcome_unknown`；
- 原地 `CompressionUpdate` 从目标协议删除；title/summary 修改创建新的 immutable CompressionBlock replacement，旧块只允许 status 更新；
- `ask_user` 复用通用 Tool/Interaction/Outcome 领域，不建专表；
- task list 是 `update_task_list` Tool facts 的客户端派生投影，不建第二套权威；
- skills、rules 原地保留并在重启后重扫；workspace checkpoint Runtime 首发禁用并重置，但 checkpoint 配置保留。

完整 keep/rebuild/delete 表在 [`authority.json#capabilityDispositions`](./contracts/authority.json)。

## 4. 四条核心链路

### 4.1 SQLite 与 CAS

```text
先按摘要发布不可变 CAS 内容
→ 核对内容存在
→ SQLite 事务写入独立领域事实和内容引用
→ 事务直接返回同一 commit 的 typed changes
```

CAS 发布后、SQLite 提交前崩溃，只会留下无人引用内容；首发不做引用计数或在线 GC。

### 4.2 外部作用

```text
领域操作
→ Operation / Attempt / EffectIntent
→ SQLite commit
→ capability dispatcher
→ EffectReceipt
→ reconcile
→ ToolOutcome / ProcessReceipt / RuntimeInboxItem
→ 唯一 ToolModelResult（若属于 ToolCall）
```

模型结果必须唯一；外部副作用不承诺绝对 exactly-once。能够核验就核验，不能确认时写 `outcome_unknown`，不得偷偷重做。

### 4.3 上下文

```text
MessageRevision / Tool exchange
→ source-occurrence ContextSegment
→ persistent parent DAG
→ ContextSequenceRoot
→ ConversationContextHeadLink（当前 root）
→ ModelContextProjection(rootId)
→ 完整 Provider 请求
```

`ContentObject` 只去重正文；相同正文的不同来源不能合并 segment。retry/edit/fork 可从旧 parent 分支。压缩 root 用 `tail_node_id + tail_segment_count` 精确限定未压缩尾部，不重新读入已被摘要替换的原文。

### 4.4 异步交付

```text
AnswerSubmission / ProcessReceipt / 外部完成事实
→ RuntimeInboxItem（只保存来源事实）
→ RuntimeDelivery（目标、phase、attempt、消费状态）
→ RuntimeDeliveryInputLink（具体输入与 handled_at）
```

`consumed` 只表示输入已可靠注入；`handled_at` 才表示父执行器已吸收对应输入。失败人工重投创建 `attempt_seq+1` 新行，旧 failed 行不复活。

## 5. 有界 Client feed

- `hostBootId` 标识一次 Extension Host 启动；
- `commitSeq` 只在同一 host boot 内单调，wire 使用十进制整数字符串；
- snapshot 带 `snapshotCommitSeq`，snapshot read 与 changes 注册通过 writer barrier 或等价原子机制交接；
- 一个数据库 commit 对应一个原子 changes batch，不拆分成半可见状态；
- snapshot、change batch、宿主待发送 batches/bytes 与 Webview 活动窗口都有硬上限；
- 单 commit 或队列超限时丢弃尚未发送的普通 changes，合并为一个 `snapshot-required` 控制状态；
- gap、未知类型、hostBootId 变化或应用失败时整份重取有界 snapshot；
- 首发不建设持久 `ClientChangeLog`。

数值与状态机只在 [`client-feed.json`](./contracts/client-feed.json) 定义。

## 6. Recovery owner

通用 scanner 框架由 D 建立，但扫描项使用稳定 ID 分配 owner：

- D：`recovery.effect-intent-hanging`、`recovery.file-change-unresolved`；
- F：`recovery.answer-inbox-invariant`、`recovery.delivery-pending`、`recovery.foreground-answer-wait-expired`、`recovery.cancelled-subtree-incomplete`。

`tool.json#recoveryScan` 是 target/action/owner 唯一权威；identity、阶段文档和 candidate checks 只引用这些 ID。

## 7. SQLite 硬切原则

- 不导入未发布的旧 Runtime 数据；
- 不双写文件数据库与 SQLite；
- SQLite candidate 始终使用隔离数据根；
- `migration.json#physicalManifest` 逐项覆盖全部注册 root/file、global settings sections、conversation settings、mixed-scope links、skills/rules、Workspace 与未知用户文件；
- global/agent/workflow scope links 保留，conversation/run/无 authority 的 agentSystem links 重置；
- 旧 Runtime 归档，配置按 manifest preserve/filter，Workspace 与未知用户文件不触碰；
- 激活后只修复新内核，不自动回退旧 writer。

真实 cutover actor 是最终 VSIX 的 `cutover-only coordinator`：旧宿主先关闭 admission、drain 并持久化 request，然后退出；最终 VSIX 安装并重启后先完成 journaled archive、配置过滤和校验，再创建 SQLite/CAS/epoch 并原子激活 RootBinding。归档失败时 active pointer 不变且可按 journal 恢复。

## 8. 七个阶段与三个出口

```text
A 合同、边界与物理清单
→ B SQLite/CAS/RootBinding foundation
→ C Turn 控制面
→ D Effect/Tool/File/Process/MCP
→ E Context/Compression/完整请求 Provider
→ F ChildExecution/Delivery/Client feed
→ G hard cut/源码删除/真实安装
```

- `foundation`：只证明 B 的 SQLite、CAS、RootBinding 与空根可用，不替换日常插件；
- `candidate`：在隔离根证明 C～F 能力与原子 recovery checks；旧源码可以仍存在，但候选导入图/路由不可达旧 writer；
- `installed`：G 物理删除旧入口、执行迁移、安装同一个当前 VSIX，并逐个运行 targets smoke。

Gate 的机器身份是稳定 `check.id`，handler 使用 `Map<checkId, handler>`，绝不正则匹配 description。未实现 handler 必须诚实输出 `PENDING`。

## 9. 明确不做

- 旧 Runtime 导入、双写、兼容 adapter、fallback 或长期 migration chain；
- 运行时 schema v1/v2 协商；
- 在线 Context root/node GC 或 CAS 引用计数；
- 持久 ClientChangeLog 或跨宿主持久 feed；
- 通用进程 daemon/broker、全局多租户进程配额平台；
- 通用死信系统、closure table、图数据库或 gate 结果数据库；
- AskUser/TaskList 专用权威表；
- 把配置 authority 迁入 Runtime SQLite；
- 把本地测试、fixture、benchmark、数据库或密钥打入 VSIX。

## 10. 计划收口完成与后续边界

本 r4 收口只证明合同与校验器结构可以自洽，不代表 foundation/candidate/installed 已实现。只有 `npm run check:contracts:plan` 退出 0 后，才允许冻结 Phase B schema/Repository 接口；本轮不开始 Phase B 实现。

后续最终完成仍要求：

1. Turn 是唯一执行身份；
2. 每个终态 ToolCall 只有一个 ToolModelResult；
3. Context DAG 不复制历史前缀；
4. detached wrapper 与每进程输出上限通过故障测试；
5. 六类 recovery scan 各有证据；
6. cancel_subtree、fork Links、MCP Effect 与 immutable compression replacement 通过 candidate；
7. snapshot/changes/queue/barrier 全部有界；
8. old writer 在 candidate 不可达，在 G 才物理删除；
9. physical migration manifest 与 cutover journal 真正执行；
10. targets 中 9 个 installed smoke（含真实文件 mutation 与普通 Turn interrupt）全部通过。

## 11. 常用检查

```text
npm run check:contracts:plan
npm run check:plan
npm run check:plan:tracked
npm run check:local
npm run check:gate -- --stage=foundation
npm run check:gate -- --stage=candidate
npm run check:gate -- --stage=installed --artifact=/本机路径/limcode.vsix
```

`check:contracts:plan` 只证明工作区计划结构自洽，不要求干净工作区。`check:plan:tracked` 和正式 gate 需要计划/脚本已被 Git 跟踪且工作区干净；foundation/candidate/package 中尚未实现的检查保持 `PENDING`，不得为了绿灯伪造完成。
