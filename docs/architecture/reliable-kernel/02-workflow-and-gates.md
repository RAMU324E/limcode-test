# 工作流与三个出口

[返回总计划](./README.md)

## 1. 七阶段顺序

```text
A 合同、边界、physical manifest 与 baseline
→ B SQLite / CAS / RootBinding foundation
→ C Turn control plane
→ D Effect / Tool / File / Process wrapper / MCP
→ E Context DAG / Compression / full-request Provider
→ F ChildExecution / RuntimeDelivery / bounded Client feed
→ G hard cut / old source deletion / installed VSIX
```

D/E 可在 C 稳定后并行；F 同时依赖 C、D、E；G 是唯一日常插件切换点。

## 2. 开发方式

- A～F 只在 isolated candidate root 和 Git ignored `/tests/` 验证；
- 旧文件 Runtime 在 candidate 通过前继续服务日常插件，但不得向 SQLite candidate dual-write；
- candidate 必须只走新 Repository/Effect/Context/Projection 路由；
- 旧源码可在 A～F 继续存在，candidate 要证明导入图和路由不可达；
- G 才按 transition ledger 的 `deleteStage=G` 物理删除旧入口；
- 不为中间阶段增加 compatibility adapter、legacy import 或 fallback。

## 3. transition ledger 语义

`contracts/transition-ledger.json` 为每个旧入口分别记录：

- `replacementStage`：新能力在哪一阶段完成；
- `deleteStage`：旧源码何时物理删除，旧 Runtime 入口统一为 G；
- `disposition/replacement/selector/cohort`；
- `deletedAtCommit`：只有真实删除后才写。

`replacementStage` 不等于 `deleteStage`。candidate 的“旧 writer 不参与路由”不能冒充“源码已经不存在”；installed 才运行 source grep、dist import graph 与 VSIX listing 三面删除检查。

## 4. gate 的机器身份

正式出口只有 `foundation`、`candidate`、`installed`；直接 validator 只有 `plan`、`foundation`、`candidate`、`package`。

Gate checks 的唯一权威是 `contracts/gate-registry.json`：

```json
{
  "id": "candidate.recovery.pending-delivery",
  "description": "...",
  "ownerStage": "F",
  "contractRef": "recovery.delivery-pending"
}
```

规则：

- handler 只通过 `Map<checkId, handler>` 匹配；
- description 可改文案，不能作为身份或正则匹配输入；
- 一个 ID 只证明一个原子断言；
- compound prose 必须拆开；
- 未实现 ID 输出 `PENDING` 并使 gate 失败；
- 不建设 gate 结果数据库。

人读文档不复制完整 check 清单，只解释出口边界。

## 5. foundation 出口

覆盖 A、B，只证明：

- SQLite native driver 在真实 Extension Host 加载；
- 一个 dedicated database worker 持有连接；
- current schema、FK/index 与独立 Repository 可建立；
- CAS publish 先于 SQLite reference commit；
- RootBinding 按 request/transaction fenced validation；
- SQLite/CAS 故障不会转旧 writer；
- empty root 可直接创建 current Runtime epoch；
- performance/package baseline 字段非 placeholder。

不得传入 VSIX，不得替换日常插件。宣布通过前按出口要求提交 adversarial review；未实现检查继续 PENDING。

## 6. candidate 出口

覆盖 C～F，并累计 foundation。关键证明分为独立 check：

- Turn sole execution identity；
- ToolModelResult exactly once；
- FileChangeSet 与 actual mutation 分离；
- EffectReceipt 可独立 reconcile；
- Context DAG 存储增长与 compression node 上限；
- `disabled-full-request` 模式确实不读写 ProviderContinuation suffix；
- Conversation fork 三 Link、immutable compression replacement、Attachment/CAS；
- `mcp_tool_call` Effect crash 语义；
- detached wrapper recovery 与 per-process output bounds；
- ChildExecution answer delivery 与 required interrupt_subtree；
- snapshot、change batch、host queue、snapshot/feed barrier 分别有界；
- candidate 路由不可达 old writer；
- parentHandling matrix 只读取对应 InputLink.handled_at。

Recovery 不能再合并成“三类”一句话，六个稳定 ID 各自有 check：

```text
D:
  recovery.effect-intent-hanging
  recovery.file-change-unresolved

F:
  recovery.answer-inbox-invariant
  recovery.delivery-pending
  recovery.foreground-answer-wait-expired
  recovery.interrupted-subtree-incomplete
```

candidate 仍不得替换日常插件。

## 7. installed 出口

覆盖 G，并累计前两个出口。必须使用当前 clean commit 生成的同一个 VSIX。

### 7.1 provenance

- VSIX 内 `dist/build-provenance.json.worktreeClean` 必须证明构建时工作区干净，`commitSha` 等于当前 commit；
- 以 VSIX 内 `package.json` 为权威读取 main entry，重算 SHA-256，与 `mainEntrySha256` 比较；
- 安装后再对实际加载 entry 重算摘要并与同一 VSIX 比较；
- 不能只检查 provenance JSON “有字段”。

### 7.2 migration 与删除

- final VSIX 的 cutover-only coordinator 按 physical manifest 执行 journaled archive/filter/verify；
- global/agent/workflow 配置与 links 保留，conversation/run/agentSystem links 重置；
- settings records、skills、rules 保留；Workspace 与 unknown user files 不触碰；
- source grep=0、dist import graph unreachable、VSIX listing absent 三面检查分别有 ID；
- empty root、RootBinding/epoch/open order 各有独立断言。

### 7.3 installed smoke

`contracts/targets.json#validation.smoke` 是 ID、步骤与断言唯一权威。9 个 smoke 各自映射 package check，特别包括：

- `smoke.file-proposal-approve-apply`：proposal → approval → actual Workspace write → digest/receipt → one ToolModelResult；
- `smoke.turn-interrupt`：普通 streaming Turn interrupt → terminal → late stream 不重开；
- Extension Host restart 与六类 recovery verification。

只有 installed 全部通过后，才允许作为日常插件。

## 8. 干净证明与自举

正式 gate 要求：

- 当前 worktree clean；
- 合同与 validator 已被 Git 跟踪且是普通文件；
- installed 提供本机普通 VSIX path；
- package provenance 与当前 commit/entry digest 匹配；
- SQLite native module 可由当前 VS Code Extension Host 加载。

计划和脚本第一次入库前，`npm run check:contracts:plan` 只检查工作区内容；`check:plan:tracked` 因未跟踪文件失败是预期，不能误判为架构失败，也不能假装 formal gate 已通过。

## 9. 命令

```text
npm run check:contracts:plan
npm run check:plan:tracked
npm run check:local
npm run check:gate -- --stage=foundation
npm run check:gate -- --stage=candidate
npm run check:gate -- --stage=installed --artifact=/本机路径/limcode.vsix
```

`check:contracts:plan` 只证明合同和计划结构自洽；它不证明 SQLite、故障恢复或安装已经实现。
