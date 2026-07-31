# 实施阶段索引

| 阶段 | 解决什么 | 主要产物 | 对应出口 |
|---|---|---|---|
| A 合同与边界 | 冻结 release decision、exact set、physical manifest、stable IDs | r4 contracts、plan validator、baseline | 无 |
| B SQLite/CAS foundation | 建立单 DB、CAS、RootBinding 与 commit result | schema、Repository、CAS、barrier | foundation |
| C Turn control plane | 统一 execution identity 与 command lifecycle | Turn、MessageRevision、Lease、CommandReceipt | candidate 前置 |
| D Effect/Tool/File/Process/MCP | 分开 intent/receipt/outcome，建立 wrapper 与 D recovery | EffectReceipt、FileChangeSet、Process wrapper、mcp_tool_call | candidate 前置 |
| E Context/Provider | 消除历史复制，保留 fork/replay/compression | Context DAG、HeadLink、immutable replacement、full request | candidate 前置 |
| F ChildExecution/Client | 可靠 answer/delivery 与 bounded feed | ChildExecution Links、DeliveryInputLink、snapshot/changes | candidate |
| G hard cut/install | journaled archive、old source delete、真实 VSIX | physical migration、provenance、9 smoke | installed |

## 跨阶段接口冻结

| 契约 | Schema/接口冻结 | 行为 owner | 合同 |
|---|---|---|---|
| RootBinding / SQLite / CAS | B | B | authority.json + migration.json |
| commit result / snapshot barrier | B | F 消费 | client-feed.json |
| Turn / CommandReceipt / Lease | C | C | identity.json + authority.json |
| Tool/Effect/File/Attachment | B schema，D API | D | tool.json + file.json |
| Process / OutputChunk | B schema，D wrapper/API | D | tool.json + authority.json |
| Context DAG / HeadLink | B schema，E materializer | E | context.json + authority.json |
| fork Reuse/Branch/Origin Links | B schema，E root/F client | E/F | context.json + authority.json |
| ChildExecution Link group | B schema，F state machine | F | subagent.json + authority.json |
| Inbox/Delivery/InputLink | B schema，D producer/F consumer | D/F | tool.json + subagent.json |
| MCP Effect | D | D | tool.json |
| bounded Client feed | B barrier，F transport/UI | F | client-feed.json |
| physical migration/cutover | B Root API，G actor | G | migration.json |

下游发现 frozen interface 不足时，必须回到其 owner contract 修改并重新运行 plan/gate；不得在下游增加隐藏兼容字段。

## Recovery owner

| Stable ID | Owner | 说明 |
|---|---|---|
| `recovery.effect-intent-hanging` | D | 通用 external Effect 核验 |
| `recovery.file-change-unresolved` | D | File proposal 收口 |
| `recovery.answer-inbox-invariant` | F | Answer/Inbox 原子不变量 |
| `recovery.delivery-pending` | F | Delivery state machine |
| `recovery.foreground-answer-wait-expired` | F | wait deadline 收口 |
| `recovery.cancelled-subtree-incomplete` | F | lineage 终止续扫 |

D 只建立 scanner framework；不得因此声称拥有 F 的四项规则。

## transition 删除时点

- replacementStage A～F：新能力完成；
- candidate：old writer route/import graph unreachable；
- deleteStage G：old source 物理删除；
- deletedAtCommit：真实删除后才登记。

## 使用方式

- 阶段按依赖推进，不再拆成额外版本协议；
- 同一 table/state chain 只有一个 schema/behavior owner；
- 正式出口只有 foundation/candidate/installed；
- 本机测试、fixture、fault injection、benchmark 只放 ignored `/tests/`；
- Git 只跟踪合同、实现、validator 与必要说明；
- 未实现 gate check 保持 PENDING。
