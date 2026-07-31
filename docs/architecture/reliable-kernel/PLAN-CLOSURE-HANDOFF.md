# 可靠运行内核计划收口——下一 Agent 完整交接

> **状态（2026-07-31-r4）：已执行前的历史核验记录。** 本文记录的是 r4 收口开始前的工作树与缺口，用于审计“为什么修改”；当前机器权威以 `contracts/*.json` 的 `2026-07-31-r4` 和 `scripts/reliable-kernel/` validator 为准。本文后续出现的“当前失败”“仍需解决”不得再被解释为 r4 完成后的实时状态。


> 仓库：`/home/claude/limcode2`
> 审查方式：只读核验，未修改任何文件。
> 目标：先收口可靠运行内核计划、机器合同和校验器，**不要直接开始 Phase B SQLite 实现**。
> 重要：当前工作树包含大量未提交、未跟踪内容，不要执行 `git reset`、`git checkout .`、清理未跟踪文件等操作。

---

## 一、当前工作区状态

### 1. 评审文件

恢复的评审文件：

```text
/home/claude/limcode2/可靠运行内核计划独立架构评审.md
```

信息：

```text
483 行
19,371 字符
SHA-256:
90bb953883590b9355b97f19bd711013a8728f0c7725ab414462206e1b89f3c1
Git 未跟踪
```

这份评审反映的是较早合同状态。当前工作树已经把其中一部分建议应用到 `r3` 合同，因此：

- 可以把它当作“问题发现记录”；
- **不能把其中九项全部当作当前仍未解决的问题；**
- 不应按旧评审重复修改已经闭合的 Context、RuntimeDelivery 和 ChildExecution 核心模型。

### 2. 计划目录和脚本仍未跟踪

当前至少包括：

```text
?? docs/architecture/
?? scripts/
?? 可靠运行内核计划独立架构评审.md
```

另有多个已跟踪文件被修改，例如：

```text
M .gitignore
M .vscodeignore
M AGENTS.md
M README.md
M docs/background-process-reliability.md
M docs/conversation-storage-authority.md
M docs/global-settings-data-integration.md
M docs/model-context-projection.md
M package.json
```

因此：

- 工作树内容才是当前审查对象，不要只看 `HEAD`；
- `npm run check:plan:tracked` 目前必然会因为计划和脚本未跟踪而失败；
- 现阶段应先以 `npm run check:contracts:plan` 为工作区计划自洽检查；
- 正式 gate 要等计划和脚本提交、工作区干净后才能运行；
- 如果后续提交，commit 信息按项目规则使用中文。

### 3. 合同修订目前是 r2/r3 混合状态

| 合同 | 当前修订 |
|---|---|
| `authority.json` | `2026-07-30-r3` |
| `context.json` | `2026-07-30-r3` |
| `identity.json` | `2026-07-30-r3` |
| `subagent.json` | `2026-07-30-r3` |
| `client-feed.json` | `2026-07-28-r2` |
| `file.json` | `2026-07-28-r2` |
| `gate-registry.json` | `2026-07-28-r2` |
| `migration.json` | `2026-07-28-r2` |
| `targets.json` | `2026-07-28-r2` |
| `tool.json` | `2026-07-28-r2` |
| `transition-ledger.json` | `2026-07-28-r2` |

这正是当前主要问题来源：**r3 已更新部分核心领域合同，但其余机器合同、人读阶段文档和校验脚本没有完成同批同步。**

---

# 二、总判断

当前计划的核心方向正确：

```text
单 SQLite 热控制面
+ CAS 大内容
+ Turn 唯一执行身份
+ EffectIntent / EffectReceipt
+ RuntimeInbox / RuntimeDelivery
+ Persistent ContextSequence
+ 稳定 ChildExecution lineage
+ 有界 ClientState
+ 无旧 Runtime 数据导入、双写或 fallback
```

经过三路独立核验，最终结论是：

## 已经闭合，不应重新设计

1. ContextSegment 来源身份；
2. Context parent DAG 分支；
3. Context current head；
4. Context root/node retention；
5. 压缩 tail 截断；
6. 消息软删后的历史精确重放；
7. RuntimeDelivery 的 SQLite NULL 唯一性；
8. RuntimeDeliveryInputLink 和父处理状态；
9. failed Delivery 人工重投；
10. Inbox/Delivery 边界；
11. ChildExecution 稳定 lineage；
12. CommandReceipt 的 source tuple 身份；
13. CompressionBlock 的 regenerate、enable/disable、soft delete 基础语义。

## 仍需收口的实质问题

1. r3 合同与旧 plan validator 不一致；
2. D/F recovery owner、扫描数量和门禁冲突；
3. cancel_subtree / ProviderContinuation 降级规则未贯通；
4. transition ledger 替换阶段与物理删除阶段冲突；
5. migration 只有逻辑配置域，没有可执行的物理 root manifest；
6. Client changes、宿主队列和 snapshot→changes 交接仍无界或未定义；
7. 后台进程跨 Extension Host 重启的 PID/pipe/exit 语义不成立；
8. ProcessOutputChunk 没有每进程存储上限和 CAS/截断边界；
9. 部分现有能力没有明确 keep/rebuild/delete 去向；
10. `CompressionUpdate` 与摘要不可变合同冲突；
11. MCP 只处理了设置/重连，没有处理工具调用的 Effect 语义；
12. installed smoke 缺文件真实修改和普通 Turn interrupt；
13. cutover “先退出、再由旧宿主归档”顺序不可执行；
14. gate 仍用可变 prose 做 handler 身份，并存在复合检查；
15. package provenance handler 没有重算入口文件摘要。

因此：

> Context、Delivery、ChildExecution 本身已经可以作为 DDL 基础，但**整个 Phase B schema/Repository/changes 接口还不能冻结**，因为 migration、Client feed、ProcessOutput、fork/MCP 等决定仍可能改变字段、领域表、Effect kind 或冻结接口。

---

# 三、已经修复的内容：下一 Agent 不要重复整改

## 1. Context 来源身份已经修复

当前依据：

```text
docs/architecture/reliable-kernel/contracts/context.json:30-61
docs/architecture/reliable-kernel/contracts/authority.json:854-888
```

当前语义：

- `ContentObject` 只按摘要去重正文；
- `ContextSegment` 表示稳定来源/语义出现；
- 相同正文、不同来源可以共享 `ContentObject`，但不能因此共享 segment 身份；
- `ContextSegment` 的 `(content_object_id, segment_kind)` 只是普通索引，不再是 UNIQUE；
- `ContextSegmentSource` 使用：

```text
(source_kind, source_id, source_revision) UNIQUE
```

- tool pair 使用两条来源行：
  - `tool_call`
  - `tool_model_result`

不要把唯一键改回正文身份，也不要把 `segment_id` 塞回来源唯一键导致同一来源可重复归属多个 segment。

## 2. Context 分支已经修复

当前依据：

```text
context.json:63-87
authority.json:891-926
phase-e-context-provider.md:9-15
```

当前语义：

```text
firstReleaseShape = persistent-parent-dag
```

索引：

```text
parent_node_id
(parent_node_id, segment_id) UNIQUE
```

`parent_node_id` 本身不再 UNIQUE，允许 retry/edit/fork 从同一历史节点产生不同后继。

`ContextSequenceRoot.root_node_id` 也只是普通索引，不再 UNIQUE，允许不同 Conversation/fork root 共享不可变历史节点。

不要让 stale validator 把它改回 `append-only-parent-chain`。

## 3. current head 已经修复

当前依据：

```text
context.json:83
authority.json:929-947
```

当前使用：

```text
ConversationContextHeadLink
  conversation_id UNIQUE
  root_id
```

创建新 current root 时，在同一事务更新该 Link。

`ContextSequenceRoot` 另有：

```text
(conversation_id, root_seq) UNIQUE
```

不再从 `created_at` 推导当前分支。

## 4. Context retention 已经修复

当前依据：

```text
context.json:82
authority.json:891-925
phase-b-sqlite-cas-foundation.md:20-27
```

当前规则：

- Context root/node 首版保留到 runtime dataset reset；
- 不实现“最近 32 root”的在线物理删除；
- 不做首版在线 Context/CAS GC；
- 客户端查询窗口可以有界，但不删除共享历史结构。

不要为此加入引用计数、在线 GC 或复杂回收器。

## 5. 压缩 tail 边界已经修复

当前依据：

```text
context.json:71-79,128-141
authority.json:910-926
phase-e-context-provider.md:15
```

当前 root 字段包括：

```text
tailNodeId?
tailSegmentCount
```

压缩物化规则：

```text
summary segment
+ 从 tailNodeId 开始精确回溯 tailSegmentCount 个节点
```

不得继续沿 tail 读出已经被 summary 替代的原文。

## 6. 软删和历史重放已经修复

当前依据：

```text
context.json:47,144-152
authority.json:330-346
phase-e-context-provider.md:35
```

当前语义：

- edit/delete 创建新的 current root；
- 旧 root 和旧 ModelContextProjection 的解释永远不变；
- 历史 replay 不读取 Message 当前 soft-delete 状态；
- MessageRevision 保留；
- 旧 projection 按原 root 和原 AuthoritySnapshot 重放。

不要恢复“物化时读取 Message 当前删除状态”的动态解释。

## 7. RuntimeDelivery 的 NULL 唯一性已经修复

当前依据：

```text
identity.json:27-35
authority.json:1253-1272
subagent.json:128-132
```

当前使用两组 SQLite 部分唯一索引：

```text
(inbox_item_id, target_conversation_id, phase, attempt_seq)
UNIQUE WHERE target_turn_id IS NULL
```

```text
(inbox_item_id, target_conversation_id, target_turn_id, phase, attempt_seq)
UNIQUE WHERE target_turn_id IS NOT NULL
```

不要退回普通 nullable UNIQUE。

## 8. Delivery 与具体输入关联已经修复

当前依据：

```text
authority.json:1275-1293
subagent.json:173-231
```

已有独立：

```text
RuntimeDeliveryInputLink
  delivery_id UNIQUE
  pending_turn_input_id UNIQUE
  handled_at
```

当前语义：

- `RuntimeDelivery.state=consumed`：输入已可靠注入；
- `handled_at`：父执行器实际吸收了该输入；
- `parent_handling_state` 只看对应 InputLink；
- 不检查目标 Turn 下任意无关 `PendingTurnInput`。

## 9. failed Delivery 重投已经修复

当前依据：

```text
identity.json:30-35
subagent.json:128-132,170-171,230
authority.json:1264-1271
```

当前规则：

- 旧 failed 行不复活；
- 用户明确 redeliver 创建 `attempt_seq + 1`；
- 新行写 `retry_of_delivery_id`；
- 旧 attempt 只允许：

```text
pending → consumed
pending → failed
```

后续只需给 validator 增加静态检查，不要再重做状态机。

## 10. Inbox/Delivery 边界已经修复

当前依据：

```text
authority.json:1232-1271
subagent.json:109-132
```

当前边界：

```text
RuntimeInboxItem:
  只保存来源事实和来源引用

RuntimeDelivery:
  targetConversation
  targetTurn
  phase
  attempt
  消费状态
```

不要把目标 Conversation/Turn 塞回 Inbox。

## 11. ChildExecution lineage 已经修复

当前依据：

```text
subagent.json:15-26
authority.json:1077-1176
```

当前独立领域：

```text
ChildExecution
ChildExecutionParentLink
ChildExecutionTurnLink
ChildExecutionIntentLink
ChildExecutionActiveTurnLink
```

语义：

- `ChildExecution` 是稳定 lineage；
- ParentLink 是稳定树边；
- TurnLink 保存首次和续接 Turn membership；
- IntentLink 保存尚未 admit 的续接意图；
- ActiveTurnLink 只表达当前活动 Turn；
- cancel_subtree 沿 ParentLink 递归，不沿 ActiveTurnLink 推导树；
- AnswerBridge 归属 ChildExecution。

不要重新引入单一 `ChildTurnLink` 或让 active pointer 兼任 lineage。

## 12. CommandReceipt 合同已经修复

当前依据：

```text
identity.json:6-11
authority.json:311-327
```

当前身份：

```text
CommandReceipt(source_kind, source_key)
```

索引：

```text
(source_kind, source_key) UNIQUE
```

其中：

```text
source_kind ∈ command | callback | internal | recovery
```

不要改回单一 `commandId`。

## 13. CompressionBlock 基础管理语义已经修复

当前依据：

```text
context.json:128-142
authority.json:989-1006
```

当前规则：

- regenerate 创建新 `CompressionBlock`；
- enable/disable/delete 只更新 status；
- delete 是 `soft_deleted`；
- 正文、来源、摘要不可变；
- 不物理删除历史 projection。

但仍有一个未解决入口：`CompressionUpdate`，见后文。

---

# 四、当前计划校验器实际失败

执行：

```bash
npm run check:contracts:plan
```

当前退出码为 1，失败 5 项：

```text
运行时领域缺少ChildTurnLink
命令去重必须由CommandReceipt负责
上下文领域出现未登记值ConversationContextHeadLink
第一版上下文序列应使用简单追加父链
子Agent前端事实缺少childTurnExecutionState
```

这些不是 r3 架构回退，而是：

```text
scripts/reliable-kernel/lib/contract-model.mjs
```

仍按旧模型校验。

## 1. `REQUIRED_RUNTIME_DOMAINS` 已过时

当前脚本仍要求：

```text
ChildTurnLink
```

但 r3 已替换为：

```text
ChildExecution
ChildExecutionParentLink
ChildExecutionTurnLink
ChildExecutionIntentLink
ChildExecutionActiveTurnLink
```

当前脚本还没有完整登记 authority 中的多个领域。至少需要重新核对以下新增或遗漏项：

```text
TurnIntentRevision
TurnExecutionPresetRevision
TurnExecutorLink
Attachment
AttachmentLink
ToolCallEvent
OutcomePause
OperationResolution
ToolResultArtifact
FileMutationReceiptMember
ConversationContextHeadLink
CompressionBlockSource
ChildExecution
ChildExecutionParentLink
ChildExecutionTurnLink
ChildExecutionIntentLink
ChildExecutionActiveTurnLink
AnswerPayload
RuntimeDeliveryInputLink
```

并删除目标领域中的旧：

```text
ChildTurnLink
```

注意：`transition-ledger.json` 可以继续引用旧源码符号 `ChildTurnLinkRecord`，因为它在描述待替换旧入口；不能因为目标模型删除了 ChildTurnLink 就把过渡清单里的旧 selector 一并误删。

### 当前额外问题

`validateAuthority` 只检查“必须项是否存在”，却允许未登记额外领域；但 `authority.json` 的 notes 声称 runtimeDomains 与领域合同是精确集合。

最小修法：

- 更新目标领域全集；
- 使用 exact-set 校验，而不是只检查 missing；
- 如果能力 disposition 最终新增 fork/MCP 领域，先完成决定再冻结全集；
- 不要为了让检查绿灯简单删除检查。

## 2. Context validator 已过时

当前：

```text
contract-model.mjs:358-398
```

仍然：

- 漏掉 `ConversationContextHeadLink`；
- 强制 `append-only-parent-chain`。

应改为校验：

```text
persistent-parent-dag
ConversationContextHeadLink
source-occurrence identity
source tuple UNIQUE
(parent_node_id, segment_id) UNIQUE
root_node_id 非 UNIQUE
tail_segment_count
dataset-reset-only retention
历史 replay 不读当前 Conversation
```

## 3. Identity validator 已过时

当前：

```text
contract-model.mjs:272-281
```

仍精确比较：

```text
CommandReceipt.commandId
```

应改成：

```text
CommandReceipt(source_kind,source_key)
```

同时补充目前完全缺少的 Delivery 静态检查：

- NULL/非 NULL 两组部分唯一索引；
- `attempt_seq`；
- `retry_of_delivery_id`；
- `RuntimeDeliveryInputLink`；
- `handled_at`；
- Inbox 不包含目标；
- redeliver 不复活旧行。

## 4. Subagent validator 已过时

当前：

```text
contract-model.mjs:400-422
```

仍要求 UI fact：

```text
childTurnExecutionState
```

当前 r3 UI facts 是：

```text
childExecutionState
activeChildTurnState
answerSubmissionState
runtimeDeliveryState
parentHandlingState
terminationState
```

还应静态检查：

- 树遍历依据 ParentLink；
- ActiveTurnLink 不得作为 lineage；
- AnswerBridge owner 是 ChildExecution；
- continuation Turn 复用同一 ChildExecution；
- pending Intent 属于 IntentLink；
- cancel_subtree 同时覆盖 active Turn 与 pending Intent。

## 5. 计划检查完成标准

完成相关修订后：

```bash
npm run check:contracts:plan
```

必须退出 0。

但不要伪造 foundation/candidate 已实现：

- `validators/foundation.mjs` 当前 `implemented=[]`；
- `validators/candidate.mjs` 当前 `implemented=[]`；
- 计划期显示 PENDING 本身不是 bug；
- 不能为了通过 gate 把未实现项目直接标 completed。

---

# 五、仍需解决的问题

---

## 问题 1：D/F recovery owner 冲突

### 当前证据

合理冻结边界：

```text
appendices/implementation-stage-index.md:19-23
```

当前意图是：

```text
B：建表
D：写入接口和通用 Effect/Process producer
F：子代理 Delivery 消费和状态机
```

但：

```text
phase-d-effects-tools-files-processes.md:15-16,31
```

要求阶段 D 扫描：

```text
AnswerSubmission 存在但 RuntimeInboxItem 缺失
```

而：

```text
phase-f-subagent-client.md:32-41
```

明确说：

```text
AnswerSubmission invariant
pending RuntimeDelivery
expired foreground wait
incomplete cancelled subtree
```

归阶段 F，并明确“阶段 D 不拥有这些子代理恢复规则”。

### 为什么是实质问题

这会导致：

- D 阶段依赖尚未由 F 实现的 AnswerBridge/AnswerSubmission；
- 阶段完成标准无法判断由谁负责；
- candidate validator 无法分配 handler；
- 实现者可能重复实现同一个 scanner，或者两边都以为对方负责。

### 建议的最小口径

全局 recovery 项至少拆成稳定、原子的检查：

```text
recovery.effect-intent-hanging       ownerStage=D
recovery.file-change-unresolved      ownerStage=D
recovery.answer-inbox-invariant      ownerStage=F
recovery.delivery-pending            ownerStage=F
```

另有两个子代理专用 sweep：

```text
recovery.foreground-answer-wait-expired   ownerStage=F
recovery.cancelled-subtree-incomplete     ownerStage=F
```

建议：

- D 建通用 scanner 框架；
- D 实现前两类；
- F 注册并实现后四类；
- `tool.json` 或统一 recovery 合同可保留最终全集，但每项加 `ownerStage`；
- Phase D 完成标准只验 D 所有项；
- Phase F 完成标准验 F 所有项；
- candidate 最终验证全集。

不要把“全局四类扫描”和“F 内部另外两类 sweep”混成“三类”。

---

## 问题 2：recoveryScan 四类与 gate 三类冲突

### 当前证据

四类权威定义：

```text
identity.json:117-145
tool.json:93-113
```

包括：

1. 悬挂 Effect/Attempt；
2. 未决 FileChangeSet；
3. AnswerSubmission 无 Inbox；
4. pending RuntimeDelivery。

但：

```text
02-workflow-and-gates.md:81-83
gate-registry.json:70-75
```

仍写“三类”，漏掉 pending RuntimeDelivery。

### 最小修法

- candidate gate 改为四个独立 ID；
- 不要继续写一段组合 prose；
- 对 subagent 的 expired wait 和 incomplete subtree 再各设独立检查；
- plan validator exact-set 对比 recovery IDs；
- 不允许 tool/identity/gate 再次漂移。

---

## 问题 3：cancel_subtree 降级规则冲突

### 当前证据

章程：

```text
00-program-charter.md:105-112
```

允许降级：

```text
cancel_subtree
ProviderContinuation
```

但 cancel_subtree 同时被以下位置强制要求：

```text
subagent.json:7-14
phase-f-subagent-client.md:15,56
gate-registry.json:73
contract-model.mjs:401
README.md 能力底线
```

### 需要明确决策

只有两个合法方案。

#### 方案 A：首发必须支持 cancel_subtree

这是当前 r3 模型最接近的方案，因为稳定 lineage 已经完整设计。

需要：

- 从“可降级项”删除 cancel_subtree；
- 保留 candidate 必选检查；
- README、章程、subagent、Phase F、gate 保持一致。

#### 方案 B：允许首发降级

需要：

- 增加明确 release decision；
- disabled 时从实际 operation、Phase F 完成标准和 gate 必选项中条件化移除；
- 只保留逐个 cancel；
- UI/协议不得继续宣称支持 cancel_subtree；
- 不能一边允许降级，一边 exact-set 强制操作存在。

不要新增阶段，只需冻结一个决定。

---

## 问题 4：ProviderContinuation 降级条件没有贯通

### 当前状态

这项比 cancel_subtree 冲突轻一些。

`context.json:154-171` 已经定义：

```text
releaseMode = optional-transport-optimization
disabledBehavior = always-send-full-request
```

因此 candidate 中“continuation 不跨连接”在 disabled 模式下可以通过“不发送 suffix”满足。

但以下位置没有统一读取明确 release decision：

```text
README 能力底线
Phase E 目标和完成标准
gate-registry
validator
```

### 最小修法

加入明确决策，例如：

```text
providerContinuationReleaseDecision:
  enabled | disabled-full-request
```

若 enabled，gate 验证：

- 同一物理连接；
- strict prefix；
- Completed 才推进；
- socketGeneration 隔离；
- 压缩失效后完整请求。

若 disabled，gate 验证：

- 永远发送完整请求；
- 不产生 suffix；
- 不读取旧 continuation；
- 功能正确性不受影响。

不要建立运行时协议协商或 v1/v2 fallback。

---

## 问题 5：transition ledger 的替换阶段与删除阶段冲突

### 当前证据

计划规定：

```text
02-workflow-and-gates.md:29-43
phase-g-hard-cut-release.md:7-12
00-program-charter.md:69-83
```

candidate 通过前，旧文件 Runtime 继续服务日常插件；源码旧写入器在 G 阶段统一删除。

但：

```text
transition-ledger.json
```

大量条目在 B/D 使用：

```text
ownerStage: B | D
disposition: replace-and-delete
```

末尾规则又说条目“在对应阶段删除后”标记 `deleted-at-commit`。

### 为什么是实质冲突

`ownerStage` 同时承担：

1. 新替代能力何时完成；
2. 旧源码何时物理删除。

而计划的 candidate 口径只是：

```text
候选路径不调用旧 writer
```

并不等于：

```text
源码已经删除
```

### 最小修法

给 ledger 分开字段，例如：

```json
{
  "replacementStage": "B",
  "deleteStage": "G"
}
```

或保留 `ownerStage` 表示 replacement owner，再增加：

```json
"deleteStage": "G"
```

规则：

- B～F：完成 replacement；
- candidate：证明候选导入图/路由不可达旧 writer；
- G：源码 grep=0、dist 不可达、VSIX 不含；
- 物理删除后才写 `deletedAtCommit`。

更新 validator：

- 校验 replacementStage/deleteStage；
- 对旧运行时入口，deleteStage 不得早于 G；
- 不要把 candidate 的“不参与”偷换成“源码不存在”。

---

# 六、migration：必须从逻辑标签变成可执行物理清单

## 1. 当前真正的问题

`migration.json:16-20` 的 preserve 只有：

```text
settings
agents
work-environments
workspace-files
```

但同一合同的：

```text
preserveAndVerify.configurationDomains
```

已经表达了七个逻辑域：

```text
Agent
Workflow
Policy
ModelProfile
Settings
WorkEnvironment
RuntimeContext
```

所以不能说计划完全忘了 Workflow/Policy 等。

准确问题是：

> 已经有逻辑保留意图，但没有将其映射到当前真实 physical roots、record/index、scope link 和外部配置文件，无法执行硬切。

## 2. 当前真实物理配置面

主要来源：

```text
backend/capabilities/vscodeStorage/constants.ts:19-60
backend/capabilities/vscodeStorage/paths.ts
shared/protocol.ts:47-50,896-898
```

至少包含：

```text
agents
workflows

plan-review-policies
plan-review-policy-scope-links

tool-policies
tool-policy-scope-links

skill-policies
skill-policy-scope-links

system-prompts
system-prompt-scope-links

model-profiles
model-profile-scope-links

runtime-contexts
runtime-context-scope-links

work-environments
work-environment-policies
work-environment-policy-scope-links

checkpoint-policies
checkpoint-policy-scope-links

settings
```

Settings 内至少有九个全局 section：

```text
common
llm
llmProviderConfigs
llmCompression
llmCompressionConfigs
checkpointMaintenance
appearance
attachments
mcpServers
```

此外还有：

```text
conversation-... settings files
```

这些引用即将重置的 Conversation，不能把整个 settings root 无条件保留。

## 3. mixed scope link 必须过滤

当前 scope 包括：

```text
global
conversation
agent
workflow
run
```

部分类型另有：

```text
agentSystem
```

现有：

```text
ClientStatePersistence.ts:215-242,247-248
```

只过滤 `run`，仍会持久化 `conversation` scope。

硬切后 Conversation/Run 重置，因此：

- global：通常保留；
- agent：通常保留；
- workflow：通常保留；
- conversation：必须删除；
- run：必须删除；
- agentSystem：当前只是预留普通 id，没有 AgentSystem 权威，必须明确决定保留稳定 key 还是删除，不能自动假设保留。

过滤后必须重写 index/records，不能只删除 record 留悬空 index。

## 4. 还有 StoragePaths 之外的真实输入

独立核验发现：

```text
backend/capabilities/skillCatalog.ts
```

会读取：

```text
<dataRoot>/skills
```

而：

```text
backend/capabilities/rulesCatalog.ts
```

会读取：

```text
<dataRoot>/AGENTS.md
<dataRoot>/CLAUDE.md
```

它们不在当前 `REGISTERED_STORAGE_ROOT_DIRS/FILES` 中。

因此物理 manifest 还需要表达：

```text
preserve-in-place
external-untouched
```

不能只支持目录的 preserve/reset/filter。

同时：

- Workspace 文件不属于 data root；
- `workspace-files` 应表达“不移动、不修改”，而不是虚构一个 data-root 目录；
- 自定义 data root 内未知用户文件默认不得触碰；
- `constants.ts:92-95` 已明确只能操作注册目录。

## 5. authority 配置 crosswalk 也不完整

当前：

```text
authority.configurationDomains
```

用一个抽象 `Policy` 聚合多类独立 Policy，并漏掉：

```text
SystemPrompt
各类 ScopeLink
```

这与项目“独立对象、独立 Link 独立建模”的规则不完全一致。

最小方案：

- authority 配置域引用新的 physical migration manifest；
- 或直接扩展 configuration crosswalk；
- 每个配置对象/Link 至少明确 repository/codec/physical root/disposition；
- 不把配置放进 Runtime SQLite。

## 6. 建议的 manifest 字段

每项至少包含：

```text
id
logicalDomain
physicalKind:
  registered-root
  settings-section
  external-data-root-input
  workspace-external

pathSource:
  StoragePaths property
  constants root name
  explicit external relative path

repository
codec

disposition:
  preserve-whole
  archive-reset-whole
  filter-by-scope
  preserve-in-place
  external-untouched

preservedScopeKinds?
resetScopeKinds?

indexPolicy
recordsPolicy
verification
unknownFilePolicy
```

对 scope link：

```text
preservedScopeKinds = global, agent, workflow
resetScopeKinds = conversation, run
```

`agentSystem` 单独冻结决定。

## 7. 最小验收

- manifest 与 `constants.ts`/`paths.ts` machine crosswalk；
- 每个配置 root 有明确去向；
- Settings 中 global records 保留；
- Conversation settings 删除；
- Conversation/Run scope links 删除；
- Agent/Workflow/global scope links按决定保留；
- 所有 index 与 records 一致；
- skills/rules 原地保留；
- Workspace 不触碰；
- 未知用户文件不触碰；
- 不导入旧 Runtime 数据；
- 不双写、不 fallback。

---

# 七、Client feed：snapshot 有界，但 changes 和交接仍未闭合

## 1. 当前缺口

`client-feed.json` 当前只有：

```text
messageWindowLimit
activeRecordLimitPerType
snapshot.maxBytes
maxInflightDataMessages = 1
```

但没有：

```text
maxChangeBatchRecords
maxChangeBatchBytes
maxQueuedBatches
maxQueuedBytes
commitSeq
snapshot/feed barrier
snapshot-required 状态机
```

直接矛盾：

```text
phase-f-subagent-client.md:18,30,58
```

已经声称存在：

```text
snapshot-required
commitSeq barrier
changes/queue 硬上限
```

机器合同却没有。

## 2. 为什么一个在途包不够

`maxInflightDataMessages=1` 只能限制发送并发，不能限制：

1. 一个数据库事务产生的单批大小；
2. Webview ACK 很慢时宿主排队多少批；
3. 排队总字节；
4. 持续 stream/tool change 的积压；
5. snapshot 查询与订阅注册之间的提交丢失。

## 3. snapshot→changes 缺口

如果执行顺序是：

```text
读取 snapshot
→ 注册 changes listener
```

中间发生的 commit 会丢失。

如果先订阅再读 snapshot，又需要知道哪些 queued change 已包含在 snapshot 里。

因此必须有水位或等价原子机制。

## 4. 建议的最小合同

增加：

```text
hostBootId
commitSeq
snapshotCommitSeq

maxChangeBatchRecords
maxChangeBatchBytes
maxQueuedBatches
maxQueuedBytes
```

语义：

- `commitSeq` 在同一 Extension Host boot 内单调；
- host 重启后 `hostBootId` 改变；
- 不要求 commitSeq 跨宿主持久化；
- snapshot 与 feed 注册必须形成原子交接；
- writer barrier 是一种实现方案，但合同不必把具体锁实现写死；
- changes 携带 commitSeq；
- 客户端检测 gap 后整份重取 snapshot；
- 不建设持久 ClientChangeLog。

## 5. 超限行为

单个 commit 超限或排队超限时：

```text
不拆分一个 commit 形成半可见状态
不无限排队
不持久化 change log
```

而应：

```text
丢弃尚未发送的普通 patch
合并成一个 snapshot-required 控制状态
等待当前 inflight 包 ACK/结束
重新读取有界 snapshot
```

`snapshot-required` 应合并为单一标记，不能自己形成无界队列。

## 6. validator 必须补充

当前 `validateClient` 只检查 snapshot 和 commit source。

应增加：

- 四个上限为正整数；
- snapshot/changes 都有 hostBootId；
- commitSeq 交接字段存在；
- one commit one atomic batch；
- 超限退回 snapshot；
- 不允许 ClientChangeLog；
- Phase F 和 candidate gate 引用同一机器字段。

---

# 八、后台进程：PID 无法恢复 pipe、exit code 和后续输出

## 1. 技术事实

当前命令通过：

```text
backend/capabilities/commandRunner.ts:166-171
```

调用 Node `spawn`，并在：

```text
commandRunner.ts:256-280
```

监听：

```text
child.stdout data
child.stderr data
child close
```

这些 pipe FD 和 child 事件属于创建它的 Extension Host。

Extension Host 重启后，新宿主即使持有 PID，也不能：

- 重新取得旧 stdout/stderr pipe；
- 对非自己 child 的进程调用 waitpid；
- 得到真实 exit code；
- 重新订阅 Node `close`；
- 读取旧宿主死亡后尚未持久化的输出。

裸 PID 还有复用问题。

## 2. 当前实现并不“诚实”

恢复评审中“现实现比较诚实”的评价不准确。

当前：

```text
backgroundProcessManager.ts:597-624
```

在 owner 丢失、无 receipt 时会直接写：

```text
status = abnormal
exitCode = 1
exitedAt = now
```

即使 OS 进程可能仍活着，随后还会生成 terminal facts。

这把：

```text
观察丢失
```

冒充成：

```text
进程已异常退出且 exitCode=1
```

违反目标合同“不可证明则 outcome_unknown”。

## 3. 必须二选一

### 方案 A：保留准确跨重启能力

如果能力底线仍要求重启后：

- 继续读取新增 stdout/stderr；
- 准确 wait；
- 获取真实 exit code；
- 安全 stop；

则必须使用一个小型 detached wrapper：

```text
wrapper 启动真实命令
stdout/stderr 重定向到有界 spool
wrapper 原子写 exit receipt
持久化 stable nonce / process group / start fingerprint
新宿主读取 spool 和 receipt
```

不需要常驻 daemon 或通用进程 broker。

### 方案 B：诚实降级

如果不希望 wrapper：

```text
宿主重启后保留最后一次已落盘输出
PID 尚存 → running-unobserved
PID 消失但无 exit receipt → outcome_unknown
不承诺后续 stdout/stderr
不承诺真实 exit code
```

未经 start fingerprint 核验，不允许对裸 PID 执行 stop，避免 PID 复用误杀。

## 4. 必须同步的合同

至少：

```text
00-program-charter.md
README.md
01-invariants-and-authority.md
tool.json
identity.json
authority.json
phase-d-effects-tools-files-processes.md
targets/gate checks
```

不能只在实现代码里决定。

---

# 九、ProcessOutputChunk 必须按每进程有界

## 1. 当前缺口

当前：

```text
authority.json:821-833
```

只定义：

```text
ProcessOutputChunk
insert-only
(process_id, chunk_seq) UNIQUE
```

没有：

```text
正文存 SQLite 还是 CAS
每个 chunk 最大字节
每个进程最大 retained bytes
每个进程最大 chunk count
截断策略
dropped bytes
flush 上限
```

`client-feed` 的按需读取上限只限制单次响应，不限制存储增长。

## 2. 当前代码的 200,000 不是总上限

当前：

```text
commandRunner.ts:17-24,157-158
```

给 stdout 和 stderr 各一个：

```text
AppendBuffer(200_000 chars)
```

所以最大大约是：

```text
stdout 200,000 UTF-16 chars
+ stderr 200,000 UTF-16 chars
```

不是整个进程总共 200,000。

## 3. 最小目标合同

建议 SQLite 只保存 chunk metadata，正文进入 CAS 或有界 spool：

```text
process_id
chunk_seq
stream_kind
content_object_id
byte_length
created_at
```

并明确：

```text
maxChunkBytes
maxRetainedBytesPerProcess
maxRetainedChunksPerProcess
droppedBytes
truncated
```

持续高输出时：

- 仍要 drain child pipe，避免阻塞 child；
- 超过 retained 上限后丢弃正文；
- 累加 dropped bytes；
- 不继续无限写 CAS 或 SQLite metadata。

单用户首发不需要：

- 企业级全局 quota；
- 按租户配额；
- 通用 backpressure 平台；
- 阻塞式 pipe backpressure。

但**每进程上限必须存在**；CAS 不能替代容量上限。

---

# 十、能力 disposition：需要简短但完整的 keep/rebuild/delete 表

不要为每项建立专用状态机，但当前现有能力必须有明确去向。

## 1. Conversation fork

当前 Context 已要求：

```text
retry/edit/fork 可从旧 parent 分支
```

但目标 authority 没有当前：

```text
ConversationBranchLink
ConversationOriginLink
ConversationReuseLink
```

决策二选一：

### 保留现有关系语义

增加独立 Link 域、表、Repository、Codec、Client mapping、delete policy。

### 只保留复制/fork 行为，不保留关系展示

明确删除：

- 对应 Bridge；
- UI；
- ClientState 关系；
- tests；
- transition ledger 中旧入口。

不能一边说 fork 是完成标准，一边不说明现有 branch/origin/reuse 关系的去向。

## 2. MCP

MCP 需要拆成两个问题。

### 设置与连接

可以：

```text
settings/mcp-servers 保留
Extension Host 重启后重建连接
不进入 Runtime SQLite
```

### MCP 工具调用

当前 MCP 工具可能是：

```text
read
write
command
```

但 `tool.json.effectKinds` 当前没有 MCP 调用。

如果保留 MCP，必须定义：

```text
Operation owner
EffectIntent effectKind，例如 mcp_tool_call
EffectReceipt
风险等级与审批
崩溃后不自动重试
无法核验 → outcome_unknown
唯一 ToolModelResult
```

连接重建不能代替调用恢复语义。

如果不保留，则必须明确删除：

- MCP settings UI；
- runtime manager；
- 动态工具注入；
- Bridge；
- 相关测试。

## 3. Attachments

目标 authority 已有：

```text
Attachment
AttachmentLink
```

transition ledger 也有 attachment cohort，所以并非完全遗漏。

仍应补简短验收：

- ingest；
- 大小限制；
- CAS 内容；
- MessageRevision 绑定；
- on-demand read；
- hard cut 后旧 Runtime attachment 不导入；
- settings 中附件配置保留。

不需要再建新的 Attachment 专用状态机。

## 4. ask_user

应明确映射为：

```text
ToolCall
ToolExecution
InteractionRequest
InteractionOwnerLink
InteractionResponse
OutcomePause
OperationResolution
ToolOutcome
ToolModelResult
```

不建 `AskUser` 专表。

## 5. task list

建议继续：

```text
update_task_list ToolCall/ToolOutcome
→ 客户端派生投影
```

不建 TaskList 权威表。

但需要 disposition 明确：

- 是否保留当前 UI；
- 从哪些 Tool facts 派生；
- 重载后如何重建；
- 不把 UI 临时列表反写成第二套权威。

## 6. 压缩管理

r3 已闭合：

```text
regenerate
enable
disable
soft delete
```

但当前仍有 Bridge：

```text
CompressionUpdate
```

可修改：

```text
title
summary
```

这与：

```text
正文、来源和摘要不可变
```

冲突。

必须二选一：

- 删除 CompressionUpdate；
- 或把它定义为创建 replacement/new CompressionBlock，而不是原地改摘要。

## 7. skills 和 rules

当前真实输入：

```text
<dataRoot>/skills
<dataRoot>/AGENTS.md
<dataRoot>/CLAUDE.md
```

应明确：

- 配置保留；
- 不进入 Runtime SQLite；
- hard cut 原地不动；
- tools/catalog 重启后重新扫描；
- migration manifest 覆盖；
- 不需要专表。

## 8. checkpoint

`authority.json.disabledCapabilities` 已明确 workspace checkpoint 首发禁用。

保持：

- 不建 Runtime 表；
- 不导入旧 checkpoint Runtime 数据；
- 相关配置是否保留单独决定；
- 不要与 `ModelStreamCheckpoint` 混淆。

---

# 十一、installed smoke 与 Phase G 不一致

## 1. 当前目标 smoke

`targets.json:40-49` 只有：

```text
open-extension
send-message
run-read-only-tool
run-command-and-wait
start-and-cancel-subagent
restart-extension-host
verify-recovery
```

## 2. Phase G 另有承诺

`phase-g-hard-cut-release.md:44-51` 要求：

```text
对话
文件
命令
子 Agent
中断
重启恢复
```

当前 smoke 没有：

1. 文件提案→批准→真实写入；
2. 普通 Turn interrupt。

## 3. 当前并不会错误绿灯

当前：

```text
validators/package.mjs
```

只有少量 handler，其他检查会 PENDING，因此 installed 目前不会通过。

准确风险是：

> 如果未来只按现有 targets smoke 实现 handler，可能在文件 Effect handler 漏打包或 Turn interrupt 坏掉时仍通过。

## 4. 建议增加的原子 smoke ID

至少：

```text
smoke.open-extension
smoke.send-message
smoke.read-only-tool
smoke.file-proposal-approve-apply
smoke.command-run-and-wait
smoke.subagent-start-and-cancel
smoke.turn-interrupt
smoke.extension-host-restart
smoke.recovery-verification
```

每个 ID 需要最短步骤与明确断言。

例如文件 smoke：

```text
创建临时文件目标
→ 工具生成 FileChangeSet
→ 用户批准
→ Workspace 真实写入
→ actual digest = target digest
→ FileMutationReceipt succeeded
→ 只生成一个 ToolModelResult
```

普通 Turn interrupt：

```text
启动流式 Turn
→ 发出普通 TurnTermination/interrupt
→ 不仅仅是 cancel subagent
→ Turn 进入真实终态
→ 迟到 stream 不重新打开 Turn
```

---

# 十二、cutover 归档顺序和执行主体

## 1. 当前计划顺序

`migration.json` 当前是：

```text
drain-checks
quit-vscode-window
archive-and-verify
install-final-vsix
...
```

问题：

- 退出 VS Code 后旧 Extension Host 已不存在；
- 旧宿主无法继续执行 archive；
- 当前没有正式外部 archive runner。

## 2. 不是完全没有可复用实现

当前源码已有开发期 reset/archive 入口：

```text
BackendApplication.ts
vscode/commands/registerCommands.ts
dataEpoch.ts
```

但不能直接当目标 cutover：

- 它会处理全部 registered entries；
- 备份位置在 data root 内；
- 会立即写旧 data epoch；
- 不能按新 migration manifest 只归档 Runtime；
- 多项 rename 中途失败时可能已经移动一部分；
- 不满足 target migration “失败时旧数据保持原样”的承诺。

## 3. 单用户最小建议

优先使用旧宿主执行：

```text
关闭新命令 admission
→ 等待持久化/dispatcher idle
→ 按 physical manifest 选择性归档 Runtime
→ 校验配置保留和 archive 完整性
→ 写可恢复完成标记
→ 退出 VS Code
→ 安装新 VSIX
→ 新宿主创建 RootBinding/SQLite/CAS
```

无需 daemon。

如果坚持“先退出再归档”，则必须提供一个明确的手工本地脚本及命令，不可只写自然语言。

## 4. 失败语义必须可实现

当前 migration 承诺：

```text
激活前失败，旧数据保持原样
```

因此不能使用无法恢复的逐项 rename 而没有任何恢复记录。

最小可以是：

- copy + verify 后再切指针；
- 或 rename 配合简单 pending journal/rollback；
- 或整个旧 root 原子归档，再把保留配置复制到新 root。

不需要通用迁移平台，但文档承诺必须和执行方式一致。

---

# 十三、gate 不能继续用 prose 作为机器身份

## 1. 当前问题

`gate-registry.json` 的 checks 是描述字符串。

`validators/package.mjs:133-143` 使用正则匹配描述字符串到 handler。

风险：

- 改文案导致 handler 不匹配；
- 两个描述偶然匹配同一正则；
- 一项复合检查只证明其中一部分；
- recovery 已从三类变四类，但 gate prose 没同步。

candidate 最后一项同时包含：

```text
旧 writer
recoveryScan
parentHandling
```

即使给整句加一个 ID，仍然不原子。

## 2. 最小目标形状

例如：

```json
{
  "id": "candidate.recovery.pending-delivery",
  "description": "Extension Host 重启后重新评估 pending RuntimeDelivery",
  "ownerStage": "F"
}
```

validator 使用：

```text
Map<checkId, handler>
```

而不是正则匹配 description。

## 3. 必须拆成原子 ID

至少：

```text
candidate.old-writer-not-routed
candidate.recovery.effect-intent-hanging
candidate.recovery.file-change-unresolved
candidate.recovery.answer-inbox-invariant
candidate.recovery.pending-delivery
candidate.recovery.foreground-wait-expired
candidate.recovery.cancelled-subtree-incomplete
candidate.parent-handling-matrix
```

每个 handler 单独返回断言结果。

不需要建设 gate 数据库。

## 4. provenance handler 也不完整

当前 package handler 只检查：

- build provenance JSON 有字段；
- commitSha 匹配。

但没有重算 VSIX 内实际入口文件并与：

```text
mainEntrySha256
```

比较。

`targets.json` 已明确要求入口摘要核对。

installed 前必须：

1. 从 VSIX 读取 `dist/build-provenance.json`；
2. 找到包内真实 main entry；
3. 重算 SHA-256；
4. 与 provenance 比较；
5. 再与安装后实际加载入口比较。

---

# 十四、旧恢复评审中需要纠正的表述

下一 Agent 不要按以下旧说法直接执行：

| 旧评审说法 | 当前准确状态 |
|---|---|
| 九项全部必须修 | 错。Context、Delivery、lineage 已大体修入 r3 |
| ContextSegment 仍按正文 UNIQUE | 已过时 |
| parent/root 仍禁止分支 | 已过时 |
| 仍有最近 32 roots 物理 retention | 已过时 |
| current head 仍从 created_at 推导 | 已过时 |
| 压缩没有 tail stop | 已过时 |
| 软删会改变旧 replay | 已过时 |
| RuntimeDelivery 仍用 nullable 普通 UNIQUE | 已过时 |
| parentHandling 仍看任意 PendingTurnInput | 已过时 |
| failed Delivery 无法 redeliver | 已过时 |
| Inbox 仍保存目标 Conversation | 已过时 |
| active child pointer 仍充当 lineage | 已过时 |
| identity 仍写 CommandReceipt.commandId | 合同已修，只有 validator 仍旧 |
| CompressionBlock 只有 insert、不能管理 | 已过时；r3 已支持 status update/regenerate |
| ProviderContinuation 被 candidate 完全硬强制 | 只部分成立；context 已定义 disabled full-request |
| 当前后台进程实现比较诚实 | 错；当前会伪造 abnormal/exitCode=1 |
| 当前实现有 200,000 字符总进程上限 | 不准确；stdout/stderr 各 200,000 chars |
| 完全没有 archive 主体 | 过度；有旧实现入口，但顺序和语义不适用 |
| installed 当前可能漏测后直接通过 | 当前会 PENDING；风险发生在未来 handler 只按旧 smoke 实现时 |
| 必须保留 agentSystem scope link | 尚不能断言；没有 AgentSystem 权威，必须先决定 |
| 完全忘记七个配置域 | 不准确；有逻辑保留意图，缺的是物理可执行映射 |

---

# 十五、建议下一 Agent 的处理顺序

## 第 0 步：先冻结四个产品决定

在编辑合同前明确：

1. `cancel_subtree` 首发必需还是允许降级；
2. `ProviderContinuation` enabled 还是 disabled-full-request；
3. 后台进程使用 wrapper 还是诚实降级；
4. fork/MCP/CompressionUpdate 的 keep/rebuild/delete 选择。

这些决定会影响：

- runtime domain 全集；
- Effect kinds；
- authority DDL；
- gate checks；
- Phase E/F 完成标准。

## 第 1 步：先改机器合同

建议优先级：

1. `migration.json`
2. `client-feed.json`
3. `tool.json`
4. `authority.json`
5. `subagent.json`
6. `gate-registry.json`
7. `targets.json`
8. `transition-ledger.json`
9. 必要时同步 `identity.json/context.json`

如果统一提升 `contractRevision`，使用日期化 revision，例如：

```text
2026-07-31-r4
```

该 revision 只表示当前机器合同定义，不得引入 Runtime 版本协商、旧格式 fallback 或迁移链。

## 第 2 步：同步人读文档

至少：

```text
README.md
00-program-charter.md
01-invariants-and-authority.md
02-workflow-and-gates.md
phase-b-sqlite-cas-foundation.md
phase-d-effects-tools-files-processes.md
phase-e-context-provider.md
phase-f-subagent-client.md
phase-g-hard-cut-release.md
appendices/implementation-stage-index.md
appendices/performance-and-packaging-gates.md
appendices/terminology.md
```

确保人读文档不再另立第二套权威。

## 第 3 步：更新 plan validator

重点：

```text
scripts/reliable-kernel/lib/contract-model.mjs
```

必须：

- 更新 runtime domain exact set；
- 删除目标 `ChildTurnLink`；
- 登记 ChildExecution Link 组；
- 更新 Context DAG；
- 更新 CommandReceipt tuple；
- 更新 UI facts；
- 验证 Delivery 部分索引/InputLink/redelivery；
- 验证 recovery IDs exact set；
- 验证 migration physical manifest；
- 验证 Client feed 上限/barrier；
- 验证 transition replacement/delete stage；
- 验证 gate check 使用原子 ID；
- 验证 targets smoke exact set。

不要通过放宽检查来消除错误。

## 第 4 步：同步 gate validator 协议

涉及：

```text
validators/foundation.mjs
validators/candidate.mjs
validators/package.mjs
check-stage-gate.mjs
```

把：

```text
prose regex matcher
```

改成：

```text
stable check ID matcher
```

但未实现项目仍应诚实 PENDING，不得虚假通过。

## 第 5 步：运行只读/计划检查

先运行：

```bash
npm run check:contracts:plan
```

目标：退出 0。

可辅助运行：

```bash
node -e "..."   # JSON parse/crosswalk
rg ...
```

计划和脚本仍未提交时，不要把：

```bash
npm run check:plan:tracked
npm run check:gate
```

失败误判为架构问题。

## 第 6 步：再进行一次独立交叉核验

重点验证：

- authority runtimeDomains 与各领域合同 exact set；
- migration manifest 与 constants/paths 对齐；
- Phase D/F owner 无重复；
- recovery IDs 完整；
- gate 与 targets/phase 文档一致；
- Context r3 不被 stale validator 回退；
- 不新增兼容代码、旧 Runtime 导入、双写或 fallback。

---

# 十六、明确不要做的过度设计

本次收口不需要：

```text
在线 Context root/node GC
CAS 引用计数
永久 ClientChangeLog
跨 Extension Host 持久 change feed
通用死信系统
企业级进程 daemon/broker
多租户/权限系统
全局进程输出配额平台
为 ask_user 建专表
为 task list 建权威表
为每个 UI 工具建专用状态机
closure table
图数据库
gate 结果数据库
运行时 v1/v2 协商
旧文件 Runtime 数据导入
新旧存储双写
旧 Runtime fallback
长期 migration chain
```

需要的是：

```text
可执行的物理 migration manifest
有界 Client feed
诚实的进程恢复语义
每进程输出上限
独立关系 Link
原子 gate IDs
真实 installed smoke
```

---

# 十七、计划收口完成标准

只有以下条件同时成立，才适合冻结 Phase B：

1. `npm run check:contracts:plan` 退出 0；
2. validator 不再要求：
   - `ChildTurnLink`
   - `CommandReceipt.commandId`
   - `append-only-parent-chain`
   - `childTurnExecutionState`
3. authority runtime domain 集合与合同 exact-set 一致；
4. Context r3 语义保持不变；
5. Delivery 部分唯一索引和 InputLink 进入静态检查；
6. recovery owner 和检查 IDs 明确；
7. 四类全局 recovery + 两类 F sweep 有明确 owner；
8. cancel_subtree/ProviderContinuation release decision 已冻结；
9. transition ledger 分离 replacement/delete stage；
10. migration physical manifest 覆盖：
    - 配置 roots；
    - settings records；
    - mixed scope links；
    - skills/rules；
    - Workspace untouched；
    - unknown files untouched；
11. Client feed 有：
    - batch 上限；
    - queue 上限；
    - commitSeq；
    - snapshot/feed 无缝交接；
    - snapshot-required；
12. Process recovery 选择 wrapper 或诚实降级；
13. ProcessOutputChunk 有每进程容量和截断规则；
14. fork/MCP/CompressionUpdate 等能力去向明确；
15. installed smoke 包含 file mutation 和普通 Turn interrupt；
16. gate 使用稳定、原子的 ID；
17. cutover 归档顺序有真实执行主体；
18. 所有未实现 gate 仍诚实 PENDING；
19. 没有引入任何旧 Runtime 兼容、导入、双写或 fallback。

---

## 给下一 Agent 的一句话任务

> 只收口 `docs/architecture/reliable-kernel/` 与 `scripts/reliable-kernel/` 的机器合同、阶段文档和计划校验器；保留已经闭合的 r3 Context/RuntimeDelivery/ChildExecution 模型，重点解决 physical migration、bounded client feed、process recovery/output、capability disposition、D/F recovery owner、degradation、transition delete stage、atomic gate IDs 和 installed smoke；在 `npm run check:contracts:plan` 通过前不要开始 Phase B SQLite 实现，也不要添加旧格式兼容、双写或 fallback。
