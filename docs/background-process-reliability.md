# 后台进程退出的可靠投递语义

> 状态：历史文档，描述已退役的后台进程文件实现和迁移来源。当前生产由可靠内核 Process/Effect/RuntimeDelivery 与 detached wrapper 处理退出观察和投递；入口见[可靠运行内核架构](./architecture/reliable-kernel/README.md)，定义以其 [`contracts/`](./architecture/reliable-kernel/contracts/README.md) 为准。下文旧记录和 outbox 不是当前写入入口。

## 1. 领域边界

后台化的 shell/bash 进程与启动它的 Tool Attempt 是独立对象。Tool 在进程已持久化后即可返回 `status=running`，后续退出不能依赖原 Attempt、原 Tool controller 或 Extension Host 进程继续存活。

进程 capability 只维护进程事实与退出投递 outbox：

```text
BackgroundProcessRecord
BackgroundProcessOriginLinkRecord
BackgroundProcessOutputRecord
BackgroundProcessExitReceiptRecord
BackgroundProcessNotificationDeliveryRecord
```

Conversation 控制面只接收通用异步输入：

```text
RuntimeInboxItemRecord       # 不可变事件主体
RuntimeDeliveryLinkRecord    # 事件到目标 Conversation / owner Turn 的关系与消费状态
```

禁止把进程、Conversation、Turn、Message 或 ToolCall 重新嵌入一个大对象。正文日志继续由进程存储拥有；进入 Inbox 的 completion 只是有界、可结构化克隆的纯数据快照。

## 2. 稳定身份

一次进程退出由以下事实唯一标识：

```text
processId + terminalRevision
```

进程 outbox 的 source key 为：

```text
event:background-process-exit:{processId}:{terminalRevision}
```

Conversation 侧使用：

```text
dedupeKey = terminal:{processId}:{terminalRevision}
RuntimeInboxItem.id = hash(destinationConversationId, kind, dedupeKey)
RuntimeDeliveryLink.id = hash(itemId, destinationConversationId, ownerTurnId)
```

同一目标的重复 callback 必须得到完全相同的 Item 与 Delivery；若同一稳定身份对应不同 payload 或关系，系统 fail closed。

`RuntimeInboxItemRecord` 保存：

```text
kind = background_process_exited
sourceKind = background_process
sourceId = processId
dedupeKey
payload + payloadHash
occurredAt + createdAt
```

`RuntimeDeliveryLinkRecord` 独立保存：

```text
destinationConversationId
ownerTurnId
targetTurnId?
policy
state + rowVersion
```

## 3. 退出生命周期

```text
Command Tool
  -> CommandRunner 启动进程
  -> foregroundWaitMs 到期
  -> BackgroundProcessManager 持久化 Process + OriginLink
  -> Tool 返回 status=running/processId
  -> 原 Tool Attempt 正常结束

进程稍后退出
  -> 持久化 terminal Process 与有界 Output
  -> 写不可变 ExitReceipt
  -> 写 pending NotificationDelivery outbox
  -> delivery dispatcher 获取 terminal-revision claim
  -> BackgroundProcessExitNotificationHandler 在 conversation transaction 中原子写：
       RuntimeDeliveryLink + RuntimeInboxItem
  -> 事务提交后 outbox 标记 delivered
```

`BackgroundProcessExitNotificationHandler` 只记录异步事实。它不得直接：

```text
创建 Message
创建 Turn 或 TurnIntent
取得或替换 ExecutionLease
打断当前 Turn
创建模型 Request
```

因此 callback 到达不会提前进入 transcript，也不会插进 function call / function response 配对中间。

## 4. Payload 边界

`normalizeBackgroundProcessCompletionPayload` 在写 Inbox 前执行统一归一化：

- payload 序列化后硬上限为 12,000 字符；
- stdout/stderr 只保留有界尾部；
- command/cwd 使用有界 head/tail；
- 被裁剪长度累加到 `droppedChars`；
- payload 必须是纯 Object/Array/string/number/boolean/null；
- payload hash 在事务内校验，读取时再次验证。

完整日志仍通过 BackgroundProcess output capability 查询，Inbox payload 不承担日志归档职责。

## 5. Delivery 调度

后台进程退出使用：

```text
policy = inject_current_or_continue
state = pending
ownerTurnId = 启动该进程的 Turn
```

Reconciler 是 level-triggered：只要 committed facts 中仍存在 pending Delivery，就会继续尝试；不依赖一次性内存 callback。

### 5.1 Conversation 有活动 Turn

若存在有效 `ExecutionLease`，Delivery 保持 pending。只有正常模型/工具 continuation 已形成的安全边界，`appendPendingRuntimeDeliveriesAndNextInvocation` 才能原子执行：

```text
校验 Lease 仍属于当前 Turn
按 occurredAt / createdAt / itemId / deliveryId 稳定排序
生成 presentation=internal 的 User Message
创建 MessageRevision
创建 MessageTurnLink(role=notification)
把 Delivery 标记 consumed 并写 targetTurnId
创建下一组 Invocation / Request / Operation / Attempt / EffectIntent
```

安全边界前不创建 Message；人工 Interaction、未完成 Tool 批次、流式请求中间状态均不会被异步输入穿透。

### 5.2 Conversation 空闲

若没有有效 Lease，Reconciler 从每条 Delivery 的 `ownerTurnId` 找到唯一 owner Turn、executor target 与唯一 `AuthoritySnapshot`，并原子启动 continuation：

```text
新 Turn + ExecutionLease
internal User Message + MessageRevision + MessageTurnLink
从 owner AuthoritySnapshot 等价派生的新 AuthoritySnapshot
AuthorityDerivationLink(relation=equal)
初始模型工作
Delivery -> consumed(targetTurnId = 新 Turn)
```

新 Turn 的稳定 ID 来自目标 Conversation、owner Turn 与 canonical delivery batch digest。重放不能创建第二个 continuation。

若 owner Turn、target 或 AuthoritySnapshot 缺失/歧义，Delivery 转为 `dead_letter`，不会回退到实时 scope 配置，也不会注入无关 Turn。

### 5.3 其他 policy

通用 RuntimeInbox 同时支持：

```text
resume_owner                 # 精确恢复 foreground child 所属 Tool
inject_current_or_continue   # 活动 Turn 安全边界注入，否则空闲 continuation
start_continuation_when_idle # 只在空闲时启动 continuation
defer_until_next_user_turn   # 等待后续显式用户 Turn
notify_only                  # 只消费通知，不启动模型工作
```

后台进程退出固定使用 `inject_current_or_continue`，不得在 callback 中根据当前 UI/ECS 状态临时改写语义。

## 6. Exactly-once 与重启恢复

系统使用三层持久证据：

1. Process 层：`(processId, terminalRevision)` 对应一个不可变 ExitReceipt 与一个投递 outbox；
2. 事务层：同一 source key 的重复请求只能提交一次 Item/Delivery transition；
3. Conversation 层：稳定 Item/Delivery/Message/Turn/Operation 身份与 `rowVersion` CAS 防止重复消费。

恢复规则：

- pending process outbox 在重启后继续投递；
- pending RuntimeDelivery 由 level-triggered Reconciler 继续处理；
- consumed Delivery 永不再次 materialize；
- dead_letter Delivery保留错误证据，不静默丢弃；
- 已创建的 Operation/Attempt 按通用可靠 effect 恢复矩阵处理；
- `Scheduler.waitForIdle` 只有在取消/退出事实完成 durable commit 后才能返回。

outbox `delivered` 仅表示异步输入已进入 Conversation authority，不等于 Delivery 已被模型消费。

## 7. mode=output 与自动投递

模型主动 `mode=output` 与自动退出投递竞争同一 terminal-revision claim：

```text
claimOwner = model_poll | auto_delivery
```

- `model_poll` 先取得 claim：终态由该次 ToolResult 返回，自动 outbox 不再重复注入；
- `auto_delivery` 先取得 claim：终态进入 RuntimeInbox，后续模型 poll 只报告已被自动投递接管；
- Webview 被动查看日志不 claim；
- `consume=true` 只控制日志清理，不代表 RuntimeDelivery consumed。

这保证一个退出终态不会同时作为 Tool FunctionResponse 和异步 internal Message 重复进入模型上下文。

## 8. Model Context 与 UI

异步输入 materialize 后必须满足：

```text
Message.role = user
Message.presentation = internal
MessageTurnLink.role = notification
```

Model Context projector fail closed：

- notification 只有明确链接到目标 Turn 时才能进入该 Turn；
- terminal/历史 Turn 的 internal Message 不进入无关新 Turn；
- compression 不包含 internal Message；
- 每个 ToolCall 仍只有一个 canonical FunctionResponse。

用户侧：

- 普通 timeline 隐藏 internal Message；
- pending RuntimeDelivery 不伪装成 TurnIntent 或排队 Message；
- QueuePanel 只显示用户的 TurnIntent；
- Reliability Inspector 可查看 Item/Delivery 状态，但不暴露 payload 正文。

## 9. 存储布局

所有路径都通过当前 storage capability 的 `getPaths()` 获取：

```text
<dataRoot>/
  background-processes/
  background-process-origin-links/
  background-process-exit-receipts/
  background-process-notification-deliveries/

  runtime-inbox-items/conversations/{conversation}/...
  runtime-delivery-links/conversations/{conversation}/...
```

Item 与 Delivery 是独立 canonical record family，并拥有独立 Storage HEAD。Delivery 先于 Item 编译/写入，用关系证明 Item 的 canonical destination ownership；不得写回 conversation runtime blob 或进程目录。

## 10. 必须保持的不变量

1. Tool 只有在 Process + OriginLink 持久化后才能返回 `status=running`。
2. 退出投递不依赖原 Tool Attempt、controller 或 Extension Host 继续存活。
3. callback 只写 RuntimeInboxItem + RuntimeDeliveryLink，不创建 Message、Turn 或 Request。
4. Item 不嵌入目标 Conversation/Turn；目标与消费语义只存在于 DeliveryLink。
5. 同一 destination + kind + dedupeKey 只允许一个 payload hash。
6. active Turn 只在 Lease 匹配的安全边界消费 Delivery。
7. idle continuation 必须从 owner AuthoritySnapshot 等价派生，禁止重新解析实时默认权限。
8. terminal revision 只能由 model_poll 或 auto_delivery 一方 claim。
9. consumed/dead_letter 是持久终态；pending 不得被 GC 隐式删除。
10. internal Message 不可见于普通 timeline，也不得制造第二个 FunctionResponse。
11. payload、批次和输出正文均有独立硬上限。
12. 所有写入必须走可靠事务、Storage HEAD、WAL 与 projection barrier。
