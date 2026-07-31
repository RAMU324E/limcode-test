# 阶段 G：hard cut、源码删除与本机安装

## 目标

在 candidate 已通过后物理删除旧入口，由最终 VSIX 的 cutover-only coordinator 完成一次可恢复 hard cut，并用真实安装包证明新内核可用。

## 切换前收口

- foundation/candidate 全部 stable check ID 已有真实 handler 与 evidence；
- candidate import graph/route 不可达 old writer；
- transition ledger 的 replacementStage 全部完成，但尚未把“不可达”冒充“已删除”；
- 按 `deleteStage=G` 删除 old writer、旧 protocol/ECS/client fields 与兼容修补；
- 删除后逐条写 transition ledger `deletedAtCommit`；
- clean commit 上构建同一个最终 VSIX，写 build provenance；
- 当前旧宿主仍只负责关闭 admission、drain、持久化 cutover request，然后退出。

## cutover actor 与顺序

唯一权威是 `contracts/migration.json#cutoverSequence`：

1. 旧宿主关闭 command admission；
2. drain active Turn、background wrapper process、pending Provider stream 与 persistence；
3. 持久化 fenced cutover request；
4. 退出 VS Code，旧 Extension Host 不再存在；
5. 用本机 CLI 安装同一个最终 VSIX；
6. 重启 Extension Host，但 final VSIX 先只进入 `cutover-only coordinator`；
7. coordinator 按 physical manifest 执行 journaled Runtime archive；
8. filter/verify configuration roots、settings sections 与 scope links；
9. 创建 RootBinding pending、limcode.sqlite 与 CAS；
10. 写 current runtimeKernelEpoch；
11. 原子激活 RootBinding；
12. 只打开新 Runtime；
13. 运行 installed gate。

退出后的 archive actor 是 final VSIX coordinator，不是假设已退出的旧宿主。archive/filter/verify 完成前禁止打开 SQLite 或启动 Runtime。

## archive failure 语义

- same filesystem 优先 journaled rename；
- cross-filesystem 使用 copy + tree digest verify，全部验证后才删除 source；
- 每一步写 pending journal；
- RootBinding activation 前失败时 active pointer 不变，并按 journal 逆序恢复；
- activation 后失败只修复新内核，不自动 fallback old writer。

## physical manifest 验收

- 71 个 registered root 与 registered files 全部有 disposition；
- global settings 9 sections/records 保留；
- conversation settings 与 transaction locks 归档删除；
- global/agent/workflow scope links 保留；conversation/run/agentSystem links 删除；
- rewritten index 与 records 双向一致；
- skills、AGENTS.md、CLAUDE.md 原地保留并重扫；
- Workspace 不移动、不修改；
- unknown data-root user files path/digest set 不变；
- old Runtime 不导入、不双写、不 fallback。

## old entry 三面删除

三项使用独立 package check：

- source selector/symbol grep=0；
- dist import graph unreachable；
- VSIX file listing 不含 old entry。

candidate 只证明 route unreachable；G 才证明 source absent。

## provenance

Package validator 必须：

1. 从 VSIX 读取 `dist/build-provenance.json`；
2. 要求其中 `worktreeClean=true`，并将 `commitSha` 与 current clean commit 比较；
3. 以 VSIX 内 `package.json` 为权威读取真实 main entry；
4. 从 VSIX 解压并重算该 entry SHA-256；
5. 与 `mainEntrySha256` 比较；
6. 安装后重算实际加载 entry digest，再与同一 VSIX 比较。

仅检查 provenance JSON 有字段不算通过。

## installed smoke

完整 ID/steps/assertions 只在 targets.json 定义。必须逐项运行 9 个 smoke，尤其：

- `smoke.file-proposal-approve-apply`：临时文件 → FileChangeSet → approval → actual write → target digest → FileMutationReceipt succeeded → one ToolModelResult；
- `smoke.turn-interrupt`：普通 streaming Turn → interrupt → true terminal → lease released → late stream 不重开；
- `smoke.command-run-and-wait`：wrapper output/exit receipt/exit code；
- `smoke.subagent-start-and-cancel`：ChildExecution cancel 不误伤其他树；
- `smoke.extension-host-restart`：hostBootId 变化、client snapshot reset；
- `smoke.recovery-verification`：六个 recovery ID 各有真实结论。

## 完成标准

- production 只有一个 SQLite Runtime writer authority；
- physical migration/archive/filter verification 完成；
- old writer 在 source/dist/VSIX 三面消失；
- provenance 构建时 worktree clean、current commit、VSIX main digest、installed entry digest 全匹配；
- package surface 不含测试、fixture、benchmark、source、database、secret；
- 9 个 smoke 全部通过；
- 未使用 dual write、legacy import、compatibility adapter 或 fallback；
- installed gate 全部 stable ID 通过后，才允许作为日常插件。
