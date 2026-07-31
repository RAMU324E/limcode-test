# 性能、容量与安装门槛

## 1. 原则

这些门槛只防止已知问题复发，不建设通用压测、配额或 gate 数据库。真实 baseline、fixture、fault injection 与 benchmark 放在本机 ignored `/tests/`，不进入 Git/VSIX。

机器数值的唯一权威：

- Context/stream：`contracts/context.json#performance`；
- snapshot/changes/queue/page/detail：`contracts/client-feed.json`；
- process output/spool：`contracts/tool.json#processOutput`；
- package/provenance/smoke：`contracts/targets.json` 与 gate-registry.json。

本附录不复制可变数值。

## 2. candidate 性能与容量

### Context

| 项目 | 硬判定 |
|---|---|
| ordinary transaction scaling | 数据规模 2x 时耗时增长 ≤2.5x |
| per-turn storage growth | ≤1.5×本轮新增内容字节 + 128KB |
| thousand-node materialization | <50ms |
| ModelStreamCheckpoint rows | ≤ active request×64 + terminal request×33 |
| compression sequence nodes | 单次 ≤4，O(1) |

普通 transaction 不得 hash/rewrite/deep-clone full history。Context root/node 首发保留到 dataset reset；这不允许每轮复制历史。

### Client feed

必须分别证明：

- bounded snapshot：message window、active records/type、max bytes；
- bounded change batch：max records、max bytes；
- bounded host queue：max batches、max bytes；
- one commit one atomic batch；
- single commit/queue overflow → coalesced snapshot-required；
- snapshotCommitSeq/commitSeq atomic barrier 无 gap；
- keyset page rows/bytes 与 detail response/chunk 上限；
- Webview large list 同时挂载组件数量满足 client-feed rendering acceptance。

`maxInflightDataMessages=1` 不能代替 batch/queue limits。

### Process output

每个 Process 独立受以下边界约束：

- max chunk bytes；
- max retained bytes；
- max retained chunk count；
- max terminal tail bytes/stream；
- max flush delay；
- droppedBytes/truncated counters。

达到上限后 wrapper 继续 drain pipe，不能阻塞 child，也不能继续无限写 CAS/SQLite metadata。CAS content addressing 不等于 quota。

## 3. 必须覆盖的 fault scenarios

### Foundation

- SQLite transaction commit 前 host exit；
- CAS published 但 SQLite 尚未 reference；
- stale RootBinding generation；
- pending/epoch incomplete 时 fail closed；
- empty root current schema create。

### D recovery

- `recovery.effect-intent-hanging`：file digest、wrapper evidence、MCP unknown outcome；
- `recovery.file-change-unresolved`：expired decision + cancelled outcome + unique model result；
- wrapper still running across Extension Host restart；
- valid atomic exit receipt 与真实 exit code；
- wrapper absent/no receipt → outcome_unknown；
- PID reuse/fingerprint mismatch 时 stop 拒绝；
- sustained output 超限仍 drain 且 storage 收敛；
- MCP dispatched 后无法查询时不 auto-retry。

### F recovery/client

- `recovery.answer-inbox-invariant`；
- `recovery.delivery-pending`；
- `recovery.foreground-answer-wait-expired`；
- `recovery.cancelled-subtree-incomplete`；
- snapshot read/feed registration 中间并发 commit；
- single oversized commit；
- slow ACK 造成 host queue overflow；
- hostBootId change、commitSeq gap、unknown change type、atomic apply failure。

### Context/Subagent

- same content/different source segment identity；
- retry/edit/fork branch from same parent；
- historical replay after Message soft delete；
- compression tail stop；
- immutable compression replacement；
- cancel_subtree after child continuation and pending intent；
- late answer/stream/receipt 不重新打开 terminal Turn。

只验证状态真实和结果可继续处理，不要求所有 external effects exactly-once。

## 4. installed package 门槛

- gate 运行时 worktree clean，validator tracked；
- VSIX provenance 记录构建时 `worktreeClean=true`，commit 等于 current commit；
- 以 VSIX 内 package manifest 为权威，重算其 main entry SHA-256 与 provenance 匹配；
- 重算 installed loaded entry digest 与同一 VSIX 匹配；
- package surface 不含 tests/fixtures/benchmarks/scripts/internal architecture/source/database/log/secret/nested VSIX；
- physical migration manifest archive/filter/untouched assertions 通过；
- source grep、dist import graph、VSIX listing 三面 old entry checks 分开通过；
- targets.json 的 9 个 smoke 全部通过，包括真实 file mutation 与普通 Turn interrupt；
- restart recovery 不读取或写回 legacy Runtime。

未实现 handler 必须 PENDING；不能因为当前 package validator 只实现部分 checks 就宣布 installed 通过。
