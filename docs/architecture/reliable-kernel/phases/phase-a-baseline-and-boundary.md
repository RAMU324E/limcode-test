# 阶段 A：合同、基线与边界

## 目标

先冻结首发产品决定、Runtime/configuration exact set、physical migration manifest 与 gate protocol，再开始 SQLite 实现。

## 主要工作

- 固定 Turn、Tool、Context、ChildExecution、Process、MCP 与 Client feed 的行为边界；
- 保留 r3 已闭合的 Context DAG、RuntimeDelivery partial unique/InputLink 与 ChildExecution lineage；
- 冻结 `cancel_subtree=required-first-release`；
- 冻结 `ProviderContinuation=disabled-full-request`，首发不建表、不发送 suffix；
- 冻结 detached wrapper、bounded spool、atomic exit receipt 与 per-process output limits；
- 冻结 fork/MCP/Compression/Attachment/AskUser/TaskList/skills/rules/checkpoint disposition；
- 将 D/F recovery 拆成六个稳定 ID 和唯一 owner；
- 将 71 个 registered roots、registered files、9 个 global settings sections、conversation settings、scope links、skills/rules、Workspace 与 unknown files 纳入 physical manifest；
- 将 transition ledger 分成 replacementStage 与 deleteStage；
- 将 gate/target smoke 改为 stable atomic IDs；
- 记录真实 performance baseline；本地 fixture、fault injection 与 benchmark 只放 Git ignored `/tests/`。

## 必须保留的能力

- 多轮 Conversation、streaming reply、普通 Turn interrupt 与有限 Provider retry；
- file proposal/approval/actual mutation；
- foreground/background command、output/read/wait/stop 与跨宿主准确恢复；
- independent Tool parallelism；
- child spawn/send/wait/list/cancel/cancel_subtree 与 answer delivery；
- Context compression、dry-run、historical replay 与 fork；
- MCP settings/dynamic Tool；
- bounded snapshot/changes/pagination；
- Extension Host restart 后真实 recovery 结论。

ProviderContinuation transport optimization 首发禁用不等于删除 reconnect correctness；正确性由完整 frozen request 实现。

## 完成标准

- 11 份合同统一为 `2026-07-31-r4`；
- `npm run check:contracts:plan` 退出 0；
- authority/configuration/migration/recovery/gate/smoke 均 exact-set；
- plan/gate validator 使用稳定 ID，不再匹配 description；
- 未实现 foundation/candidate/package checks 仍诚实 PENDING；
- 未开始 Phase B schema/Repository 实现；
- 没有 legacy Runtime import、dual write、fallback、compatibility adapter 或运行时 schema negotiation。
