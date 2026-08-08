# 工具调度器与执行器性能优化方案

> 状态：2026-08-07 已完成独立核对、Phase 0/1、数据支持的 Phase 2 小项，以及第二轮模型无关残余热点审计/实施；未完成项和取消项见第 0 节。
>
> 研究对象：当前 `/home/claude/limcode2` 工作树、Claude Code 2.1.88 sourcemap 还原源码、OpenAI Codex 当前本机源码、Pi Agent Harness 当前本机源码。
>
> 项目边界：个人/小团队、本机 VS Code 扩展。目标是低延迟、高吞吐和足够的崩溃恢复；不建设多租户、分布式一致性、通用任务编排平台或企业级审计系统。

## 0. 2026-08-06～07 独立核对与实施记录

本节是当前工作树的实施证据；后续章节保留研究背景和原始建议。修改前代码来自任务开始时冻结的完整工作树，不以 `HEAD` 冒充用户现状。可重复证据为：

- `scripts/reliable-kernel/tool-scheduler-phase0-before.json`：冻结前，5 次；
- `scripts/reliable-kernel/tool-scheduler-phase1-after.json`：Phase 1 第一轮后，5 次；
- `scripts/reliable-kernel/tool-scheduler-phase2-after.json`：最终实现，5 次；
- `scripts/reliable-kernel/tool-scheduler-model-independent-after.json`：第二轮模型无关减法后，5 次；
- `scripts/reliable-kernel/model-independent-hotpaths-after.json`：re-drive R=1/10/100/500 与 1000 文件 transfer；
- `scripts/reliable-kernel/benchmark-tool-scheduler.mjs`；
- `scripts/reliable-kernel/benchmark-phase0-milestones.mjs`；
- `scripts/reliable-kernel/benchmark-model-independent-hotpaths.mjs`。

`read` 基准的 capability boundary 是 injected dispatcher 进入点后、真实读取 1KiB 文件之前；“有 Webview”使用真实 Client Feed subscription，但不渲染浏览器。它不会覆盖 `VscodeReliableToolHost` 的全部成本。wall time 在不同时段运行，受 OS cache、并行测试和系统负载影响；请求、事务、fsync 等原始计数是主要比较依据。

### 0.1 十四项源码核对

| # | 冻结前工作树事实 | 2026-08-06 结果 |
|---:|---|---|
| 1 | `RuntimeDatabase.request()` 每次请求前仍执行 `RootAuthority.validate(binding)` | 请求边界保留；成功验证现在跨 25ms 热突发复用，过期后重新读取 pointer/epoch |
| 2 | 正常 validate 为 1 次 pending `access`、2 次文件 read、2 次 JSON parse | 成立；即 3 次 host 文件操作、2 次 parse/实际执行 |
| 3 | `requireToolFacts()` 是 5 个顺序 worker 请求 | 成立；改为 1 个 `toolFactsSnapshot`，逐项校验数量、关系和 same-Turn generation |
| 4 | `prepare()/prepareBatch()` 先 durable publish 后查 SQLite | 成立；改为 identity → 一次批量 lookup → 仅 publish unique miss |
| 5 | duplicate CAS hit 仍创建 temp 并执行 file/directory fsync | 成立；现在全部为 0 |
| 6 | caller preflight 后 `commitSource()` 再查一次 CommandReceipt | 成立；传递内部 checked token，UNIQUE race 回读仍保留 |
| 7 | 每组从 `calls[0]` 重扫且结尾再扫，最坏 O(K²) | 成立；drive-local cursor 后为 O(K) |
| 8 | tool pair 逐个查 source、逐个更新 Context head | 成立；连续 prefix 改为 batch，new/mixed 为固定 6 snapshot + 1 transaction |
| 9 | 普通 Provider event await preflight/CAS/SQLite；前 33 个 durable，之后仍逐 event preflight | 成立；短 burst 已降为 transient fanout + 首 delta marker，`output_item_done`/terminal 同步 durable；总非终态上限为 `1 delta + 32 item_done`，semantic overflow 明确失败 |
| 10 | “同一 model request 多次完整 materialize” | 原结论过窄；Provider build 单 attempt 为 1 次，但普通 create+首发为 2 次、自动压缩未触发为 3 次、一次 retry 为 3 次、真实 compression coordinate+commit 为 7 content+2 structure；本轮只记录，不增加全局 projection cache |
| 11 | “re-drive 完全没有 frontier” | 需修正；已有 `request_seq` 物理 frontier，但原实现仍以 `2R+1` DB 请求读历史 recipe；现保留全历史校验并合批为固定 2 请求，没有新增 schema/latest-row 捷径 |
| 12 | command 的 `readonly/parallel/wait=false` 可由模型放宽审批或并发 | 成立；现由一个可信 classifier 同时冻结 permission/scheduling，模型只能用 `serial/wait=true` 收紧 |
| 13 | parallel group 使用无上限 `Promise.all` | 成立；现为三路 non-fail-fast slot-refill：ordinary cap 8、process/MCP cap 4、child durable-intent admission cap 8 |
| 14 | Client Feed listener 位于 transaction response 邻近同步路径 | 成立；实测 trivial commit 仅 0.0558～0.3546ms，因此本轮不改异步队列 |

外部项目只抽查了与本轮直接相关的机制，版本事实严格分开：Claude 还原源码是 2.1.88（安装二进制 2.1.220 不据此推断），Codex 是 `main@2b5bdcf...`（本机二进制 0.146.0 不等同当前 main），Pi 是 `main@4c01c709...`/0.83.0。确认的源码事实分别是 Claude 输入级并发分类与 cap=10 slot-refill、Codex 当前 main 的 `RwLock`/`FuturesOrdered`、Pi 的输入序 `Promise.all` 结果与同步 JSONL；没有混写成其他版本的确定事实。

### 0.2 修改前、Phase 1 与最终基准

单 1KiB `read` 到 capability start，表内为 `worker requests / Root validate / wall p50`：

| 场景 | 冻结前 | Phase 1 第一轮 | 08-06 Phase 2 | 08-07 模型无关减法后 |
|---|---:|---:|---:|---:|
| 无 Feed，cold CAS | 46 / 51 / 80.670ms | 44 / 44 / 76.074ms | 38 / 38 / 80.802ms | 33 / 33 / 63.622ms |
| 无 Feed，warm CAS | 47 / 52 / 82.444ms | 44 / 44 / 40.149ms | 38 / 38 / 55.333ms | 33 / 33 / 36.238ms |
| 有 Feed，cold CAS | 46 / 51 / 71.646ms | 44 / 44 / 70.503ms | 44 / 44 / 78.622ms | 33 / 33 / 59.495ms |
| 有 Feed，warm CAS | 46 / 51 / 57.275ms | 44 / 44 / 46.942ms | 38 / 38 / 41.499ms | 33 / 33 / 33.076ms |

冻结前 validate 完成事件可能跨 capability boundary，因此 51/52 不等于同窗口 request started；当前 observer 直接关联请求，计数一致。08-07 worker queue/execute 累计 p50 为：无 Feed cold `2.070/18.135ms`、warm `1.869/12.173ms`；有 Feed cold `2.009/14.884ms`、warm `1.876/10.683ms`。目标 `≤30` 仍没有达到，不能宣称完成；启动恢复工作可能进入 cold 样本，基准边界限制已写入 JSON。

Provider burst（E 个 delta，另有一个 terminal），表内为 `worker requests / durable ModelStream transactions / wall p50`：

| E | 冻结前 | Phase 1 | 最终 durability policy |
|---:|---:|---:|---:|
| 1 | 6 / 2 / 37.028ms | 6 / 2 / 22.619ms | 6 / 2 / 28.582ms |
| 10 | 39 / 11 / 318.697ms | 39 / 11 / 130.234ms | 6 / 2 / 25.285ms |
| 33 | 108 / 34 / 773.125ms | 108 / 34 / 353.919ms | 6 / 2 / 32.621ms |
| 100 | 175 / 34 / 895.771ms | 175 / 34 / 434.905ms | 6 / 2 / 33.201ms |

这是 Provider callback 窗口的短 burst；完整 `dispatch()` 在 2026-08-07 复跑中 E=1/10/33/100 都是 17 个 RuntimeDB 请求、2 个 ModelStream 事务。审计确认旧 250ms/16KiB 行只保存“触发阈值的当前 delta”，没有任何生产恢复 reader 把它当可重建快照；该策略已取消。当前每 ModelRequest 只持久化首个普通 delta，`output_item_done` 与 terminal 仍同步 durable。

其他原始计数：

| 场景 | 冻结前 | 最终 |
|---|---:|---:|
| 32 个并发 warm Root validate/轮 | 32 execution；96 host ops；64 parses；wall p50 7.162ms | 1 execution + 31 join；3 host ops；2 parses；wall p50 0.910ms |
| duplicate 1KiB CAS prepare | publish/temp/file fsync/dir fsync = 1/1/1/8 | lookup hit 1；publish/temp/file/dir fsync = 0/0/0/0 |
| CAS mixed batch，4 输入/3 identity | publish/temp/file/dir = 4/4/4/32 | 1 hit、2 unique miss；2/2/2/16 |
| K=10 parallel terminal call inspections / DB snapshots | 30 / 30（冻结前控制流精确计数） | 10 / 1（实测） |
| K=10 serial 或严格 P/S 交替 inspections / DB snapshots | 84 / 84（冻结前控制流精确计数） | 10 / 10（实测） |
| K=10 PP/serial 交错 inspections / DB snapshots | 69 / 69（冻结前控制流精确计数） | 10 / group 数（实测） |
| parallel K Context transactions | K | 1 |
| serial K Context transactions | K | K；保留每个 serial durable milestone 后才派下一组 |

短命令 15 样本 p50：`true` 271.1ms、`printf x` 282.4ms、`rg --version` 267.3ms、`git status` 285.8ms；spawn 仅约 4.3～4.7ms，identity ready 约 47～66ms，terminal receipt 约 52ms。数据不支持 persistent shell。Provider build 单 attempt 为 1 次 Context materialize，但完整 request lifecycle 见 0.3。Feed 常态 1-change listener p50 0.0387ms，数据不支持优先改 Feed 队列。

### 0.3 2026-08-07 模型无关残余审计与实施

第二轮以 8 条互相独立的只读审计覆盖 DB RTT、Provider durability、Context/frontier、Feed、process、CAS、serial Context 和 progress/scheduler。所有实现仍以当前工作树为权威，没有把 Luna/Sol 的工具调用行为当成本地控制面证据。

本轮实际实施：

- ToolCall batch 参数从 `K × prepare()` 改为一次 `prepareBatch()`；
- terminal prefix 只读取本次已派发 group，并用一个 snapshot 读取连续候选；
- `terminateIfRequested()` 将 Turn 与 pending termination inputs 放入同一 snapshot；
- 同一 round 已验证的 immutable ModelRequest recipe 复用于 tool definition，避免重复 request/metadata/CAS 读取；
- re-drive 全历史 recipe 审计改为 `snapshotAll requests → 一次 metadata snapshot → readMany`，所有逐项校验保留；
- transfer 每文件完成与 timer 不再用 `force=true` 绕过已有 1 秒节流，start/final 仍强制；
- Provider checkpoint 修正为首 delta + semantic items 总上限 33，修复 cancel/fail 后 terminal 行数可超过合同上限的回归；
- metrics 的 ModelStream transaction count 只在 writer 实际 commit 后计 1，capacity rollback 不再伪报事务。

完整 Provider terminal → 下一轮 dispatch 窗口，5 样本 p50：

| 场景 | 修改前 requests / Root host ops / wall | 修改后 requests / Root host ops / wall |
|---|---:|---:|
| 单 read | 97 / 336 / 74.468ms | 88 / 306 / 85.662ms |
| K=10 parallel read | 125 / 351 / 94.949ms | 98 / 294 / 84.676ms |
| K=10 serial read | 538 / 1794 / 722.414ms | 493 / 1683 / 720.323ms |

单 read 与 serial 的 wall 没有稳定同比改善，说明共享 2 vCPU 的调度/OS cache 噪声大于这部分毫秒收益；请求和 host 操作是确定性验收指标。短命令保持 `true=73`、`printf/rg=80` 个请求，没有把无关路径的时延波动冒充本轮收益。

re-drive 的真实全历史审计：

| 历史 ModelRequest R | 修改前 requests / wall p50 | 修改后 requests / wall p50 |
|---:|---:|---:|
| 1 | 3 / 4.04ms | 2 / 2.511ms |
| 10 | 21 / 36.98ms | 2 / 7.606ms |
| 100 | 201 / 275.01ms | 2 / 11.004ms |
| 500 | 1001 / 1264.10ms | 2 / 56.634ms |

R=500 的 wall 在本轮可重复 5 样本中约快 22.3 倍；另一次 7 样本复跑为 49.63ms。它仍是 O(R) bytes/JSON/identity validation，只消除了 O(R) worker RTT 和 Root validate；没有新增 durable frontier/schema，也没有跳过历史错误检测。

Tool progress 与 transfer：

| 场景 | 修改前 | 修改后 |
|---|---:|---:|
| 1000 个唯一 `appendToolCallEvent` | 4000 requests / 1000 tx / 9000 CAS fsync / 14.400s | 未改通用 writer；保留为逐事件真实成本 |
| 1000 小文件 transfer 事件源 | 1002 progress / 1.094s capability | 3 progress / 1.414s capability |

第二行只实测 capability event source；不能把 3 乘以第一行单事件成本后冒充端到端实测。事件数从按文件增长改为按时间增长，final `percent=100/filesTransferred=1000` 保留。wall 的两次运行不可直接归因，确定收益是 progress 数减少 99.7% 和 durability backlog 不再由文件数制造。

其余审计结论：

- Context materialize：普通 create+首发 2 次，自动压缩未触发 3 次，一次 retry 3 次，真实 compression coordinate+commit 为 7 content + 2 structure；1000 segment warm materialize p50 13.14ms。先做 request-scoped 局部复用，不建全局 full-history projection cache。
- CAS：committed warm hit 已为 0 publish/fsync、p50 1.378ms；冷对象仍是 1 file + 8 directory fsync，相同物理 storage key 并发首发 8 caller 会做 8 publish/64 directory fsync。group-fsync 需要严格阶段 barrier，本轮不冒险实现。
- Feed：真实常态 1 change listener p50 0.0387ms，含 bridge clone 0.0718ms；真实日志 p95 5 records/2.5KiB。只有 200 records/343KiB 压力批次才到约 3～5.5ms p50，继续取消异步 projection 队列。
- Process：15 样本 `true/printf/rg/git status` 本地工具到 Context p50 约 267～286ms；spawn 4～5ms，terminal observation 约 52ms，worker request 106～118、CAS fsync 54～63。persistent shell 取消；`fs.watch` hint 与 reconcile single-flight 留作后续小项。
- Serial Context：保留一组一事务；K=10 serial 为 10 Context transactions，这是 provider 可见 milestone/side-effect 屏障，不合并。
- Mixed lane 已实施：ordinary cap 8、process/MCP cap 4、child durable-intent admission cap 8；三路同时补槽，不建设 DAG/semaphore registry。
- `parallel_tool_calls`/提示词：Luna/Sol 真负载证明显式字段不稳定，Sol 在当前 endpoint 上 field absent 可批量而 explicit true 反而没有可靠提升。模型/endpoint/prompt 路线不作为本地调度器优化，也不硬编码该字段。

验证：`compile`、Phase D 6/6、Phase E 3/3、Phase F 4/4、`check:plan` 均通过。`check:local` 全量首次为 247/251；其中一项是本轮 scan 语义变更后的旧期望，修正后定向通过。剩余三项均来自同一个既有 baseline/VSIX 证据 commit `c9ffaf5...` 与当前 `490765d...` 不一致，不是本轮代码失败；本任务没有伪造或覆盖本机打包证据。

### 0.4 验收状态、残余热点与取消项

Phase 1 已完成：compound `requireToolFacts`、fenced active Turn、terminal result、termination reads、Provider batch source/policy/recipe facts；Root in-flight single-flight；receipt happy-path 去重；CAS existing fast path；terminal cursor 和 Context prefix batch；有界 non-fail-fast slot-refill；可信 command classifier。generation fence、claim-before-side-effect、UNIQUE race、provider order、process identity 和 Client Feed barrier 均未删除。

未达到或保留的残余：

- 单 read capability 前 p50 已降为 33，但仍不是目标 30；主要剩余是 dependent Context/source facts、PlanReview/approval 和为关闭注册竞态而保留的 termination checks，不应靠删除 fence 或 schema 大改掩盖；
- Context new/mixed prefix 是固定 6 snapshot + 1 transaction，而不是单个 compound worker request；它已消除随 K 增长的请求和 parallel K 次 head transaction；
- serial Context 仍按 group 提交，避免在前一结果对模型可见前派下一 serial side effect；
- `request_seq` 已存在，历史 recipe 的 DB/CAS RTT 已合批为固定 2 请求；仍是 O(R) bytes/parse，process-local suffix frontier 尚未实现；
- Tool progress 逐事件 durability 已证实是热点；本轮修正唯一真实爆发源 transfer，未增加通用二次 batcher。每 request 的跨阶段 Context snapshot 共享已有次数证据但尚未实现；
- Feed 同步 listener 位于近路径，但当前耗时太小，不实施异步 projection；
- process spawn 不是短命令主要成本，不实施 persistent shell、spool 格式重写或多 worker。

本轮数据支持并已完成 Phase 2 的 Provider 首-delta durability、Context tool-pair batch、exact batched re-drive 和 transfer progress source throttling；不支持继续做 Feed 队列、重复 LLM batcher、全历史 projection cache 或大型 schema cutover。明确取消把“69 requests / 207 host ops”继续当作实测基线或验收下界；它只是旧控制流静态估算，和冻结工作树的真实 p50 `46～47 requests` 不一致。

### 0.5 2026-08-07 8/4/8 并发、热验证复用与 HOL 实测

同一机器、同一脚本、同一临时 Runtime；before 为一轮，after 复跑两轮并合并原始样本后的 p50：

| 场景 | before | after | 改善 |
|---|---:|---:|---:|
| 8 ordinary × 50ms | 102.062ms（cap 4） | 50.478ms（cap 8） | 50.5% |
| 4 process/MCP 类 × 80ms | 161.759ms（cap 2） | 80.429ms（cap 4） | 50.3% |
| 8 child durable-start | 366.518ms | 287.573ms | 21.5% |
| mixed 慢 child + 快 readonly：readonly durable | 278.589ms | 41.879ms | 85.0% |
| 同场景 capability→durable lag | 248.061ms | 18.729ms | 92.4% |
| 同场景整批返回 | 286.353ms | 260.901ms | 8.9% |

10 轮 1KiB read capability boundary：

| 场景 | before p50 | after p50 | 改善 | Root validate 累计改善 |
|---|---:|---:|---:|---:|
| 无 Feed cold CAS | 63.340ms | 51.592ms | 18.5% | 约 90%+ |
| 无 Feed warm CAS | 39.355ms | 19.881ms | 49.5% | 约 94% |
| 有 Feed cold CAS | 55.615ms | 46.307ms | 16.7% | 约 90%+ |
| 有 Feed warm CAS | 34.196ms | 18.751ms | 45.2% | 约 94% |

DB request 数仍为 33；本轮减少的是每个 request 重复读取 RootBinding pointer/epoch 的成本，不把逻辑调用次数冒充物理文件验证次数。MCP discovery 同时启动但不再属于 builtin readiness Promise，当前环境首轮预计直接移除此前实测的约 0.94～1.25s远端 discovery 门禁。

## 1. 最终结论

当前慢感的第一原因不是“调度器不够聪明”，而是：

```text
一个工具动作
  × 被拆成大量细碎 Repository 请求
  × 每个请求都检查 RootBinding，25ms 热突发共享物理 pointer/epoch 验证
  × 所有请求进入同一个 SQLite worker
  × 多个中间状态又分别 CAS publish/fsync
  × 结果与 Context、Client Feed 重复投影
```

原研究曾静态估算同一路径约 69 次 worker request、按每次 validate 3 个文件操作换算为 207 次 host 操作。冻结前 5 次实测的 request p50 实际为 46～47；因此 69/207 已取消为实测基线或“下界”。2026-08-07 当前 p50 为 33；完整原始计数与边界见第 0 节。

所以应按以下顺序优化：

1. **先减少请求数、CAS/fsync 数和重复物化；**
2. **再统一有界并发和资源冲突语义；**
3. **随后把纯工具和副作用工具拆成两条执行通道，删除纯工具不需要的可靠性状态；**
4. **最后才考虑流式提前启动工具。**

不建议先做多 worker、通用 DAG 调度、持久 shell 池或完整复制 Claude/Codex/Pi 的 runtime。这些会增加复杂度，但不能消除当前最大的乘法开销。

## 2. 研究基线与证据边界

### 2.1 Limcode

- 工作树：`/home/claude/limcode2`。
- 当前工作树存在大量用户未提交修改；本文件记录当前工作树实现和同机 before/after 基准，没有重置或清理。
- 关键热路径：
  - `backend/reliableKernel/agentLoop.ts`
  - `backend/reliableKernel/toolDispatcher.ts`
  - `backend/reliableKernel/effectControlPlane.ts`
  - `backend/reliableKernel/runtimeDatabase.ts`
  - `backend/reliableKernel/rootAuthority.ts`
  - `backend/reliableKernel/contentAddressedStore.ts`
  - `backend/reliableKernel/contextSequence.ts`
  - `backend/reliableKernel/modelProviderControlPlane.ts`
  - `backend/reliableKernel/processEffects.ts`
  - `backend/reliableKernel/clientFeed.ts`

### 2.2 Claude Code

- 研究对象严格为 `@anthropic-ai/claude-code@2.1.88` 的 sourcemap 还原源码：
  - `/home/claude/claude-code-sourcemap/restored-src`
  - 包文件：`claude-code-2.1.88.tgz`
  - `package/package.json`：`2.1.88`
  - 仓库提交：`a8a678cb6244e6770e1e421767ff0987a1d95549`
- 当前安装二进制是 2.1.220，但本文**不使用 2.1.88 源码推断 2.1.220 内部实现**。
- 还原树没有常规原厂测试可用于交叉验证；feature flag 的实际 rollout 比例未知。

### 2.3 Codex

- 源码：`/home/claude/codex`。
- 研究基线：`main@2b5bdcf67547860f2e5c5a605009a70026796b2b`。
- 本机二进制：`codex-cli 0.146.0`；release tag 与当前 main 已分叉。
- 文中的 Codex 精确行号对应当前 main，不等同于二进制 0.146.0 的固定源码行号。

### 2.4 Pi

- 源码：`/home/claude/pi`。
- 研究基线：`main@4c01c709380621c5ff2719162cd7a7973dcb2799`。
- 核心包版本：`0.83.0`。
- 当前 CLI 实际仍直接使用低层 `Agent` 与 coding-agent 自己的 `AgentSession/SessionManager`；没有把仓库中的通用 Harness 当成生产热路径。

## 3. 四套实现的交叉结论

| 维度 | Limcode 当前实现 | Claude Code 2.1.88 | Codex | Pi |
|---|---|---|---|---|
| 热循环 | durable domain facts 驱动，状态层多 | 长生命周期 generator + async queue | typed session/turn task + channel | 单 AgentLoop + 内存 context |
| 工具并发 | 连续 parallel 组；三路 slot-refill：ordinary cap=8、process/MCP cap=4、child durable-intent admission cap=8 | 输入级 `isConcurrencySafe`；回退路径 cap=10；流式路径直接链未见同样 cap | sampling request 一把 `RwLock`，read=parallel/write=serial | 默认 parallel；任一 sequential 工具可令整批串行 |
| 结果顺序 | durable finalizer + provider 顺序 Context | UI 可较早看到 safe 结果，模型下一请求消费 | 执行并发，`FuturesOrdered` 按 provider 顺序注入 | 完成事件可先到，模型结果按源顺序 |
| 工具启动时点 | 模型 terminal 后 | feature gate 下可在完整 `tool_use` block 后流式启动 | item done 后只入 future，模型流退出后才 poll/启动 | assistant 完成后执行 |
| 进程 | durable wrapper、spool、receipt、恢复，最重 | 每命令新 shell；环境快照；输出文件；可转后台 | process group、PTY/pipe、process-id 会话、有界输出 | process group、100ms 更新、有界 tail；无后台任务管理器 |
| 持久化 | SQLite + CAS；普通 model delta transient + 首 delta marker，item done/terminal 同步 durable | transcript 约 100ms 批 append，delta 不逐条落盘 | completed item 持久化，delta 多为 transient | message/tool result JSONL，热 context 在内存 |
| Context | immutable ContextSequence；terminal prefix 已 batch；普通 create+首发实测 2 次 materialize，re-drive recipe I/O 已合批 | 每轮仍全历史 normalize，依靠 prompt cache | 每轮仍可能深拷贝/normalize，WS 只减少网络重发 | 增量 push；provider 前仍完整转换历史 |
| 扩展 | MCP/agent/process 都进入统一可靠控制面 | 缓存、长连接、部分 lazy；hooks 仍可拖慢 | feature gate/cache/single-flight | 核心不内建 MCP/subagent/background job |
| 主要优点 | exact-once effect、崩溃恢复、稳定顺序 | 输入级并发安全、slot-refill、流式 overlap、批持久化 | typed 边界、进程管理、严格 WS suffix | 最短直接热路径、同文件队列、有界输出 |
| 不应照搬 | — | streaming fallback 双执行风险、无统一 cap、AgentTool 固定 safe | unbounded event、粗 RwLock、HOL、无全局 cap | 无上限 `Promise.all`、同步 JSONL、缺少后台恢复 |

三套参考实现共同说明：高效路径通常是“一个长生命周期循环 + 小型事件协议 + 直接函数调用 + 批量/异步持久化”。Limcode 的可靠性骨架有价值，但把每个内部中间步骤都做成独立 durable domain transition，已经超过个人项目需要。

## 4. 当前瓶颈排序

## 4.1 P0：请求颗粒度与 RootBinding 验证相乘

`RuntimeDatabase.request()` 每次都先执行 `authority.validate(binding)`，再向 worker `postMessage`：

- `backend/reliableKernel/runtimeDatabase.ts:392-403`
- `backend/reliableKernel/rootAuthority.ts:148-171`

正常验证会检查 pending marker、读取并解析 pointer、读取并解析 epoch：

- `backend/reliableKernel/rootAuthority.ts:322-353,369-381,431-438`

冻结前，一个逻辑事实集合仍被拆成多个顺序 snapshot。例如 `requireToolFacts()` 顺序读取 ToolCall、ToolExecution、Turn、Conversation、Lease；当前实现已改为固定 worker compound query：

- `backend/reliableKernel/effectControlPlane.ts:2045-2070`

问题不是 generation fence 本身，而是一个高层动作被拆成几十个 DB request，每个 request 又重复做同一组文件检查。

### 结论

- 保留 RootBinding generation/fence。
- 第一阶段不做跨时间 TTL 跳过验证，避免违反现有 `AGENTS.md:337-339`。
- 通过 compound snapshot/专用 worker query 将高层动作压到少量请求。
- 对同一时刻并发发起的验证做 single-flight，只共享正在进行的 Promise，不跨时间缓存。

## 4.2 P0：CAS 命中重复对象仍执行完整 durable publish

冻结前 `ContentAddressedStore.prepare()` 先 `publish()`，再查 SQLite 是否已有 ContentObject；当前实现已按本节 fast path 改造：

- `backend/reliableKernel/contentAddressedStore.ts:69-158`

即使 digest 对象已存在，也会创建临时文件、写入、file `fsync`、处理 link/EEXIST、校验已有对象、目录 `fsync`、删除临时文件并再次同步目录。

### 结论

将路径改为：

```text
计算 content identity
  → 一次 SQLite lookup
  → 已存在：直接复用 metadata，不创建临时文件、不 fsync
  → 未存在：执行现有 durable publish
  → 并发竞争：继续用 EEXIST + digest 校验兜底
```

ContentObject 行已经表达“CAS 对象在提交引用前完成 durable publish”的不变量。个人项目无需在每次命中时重新做一遍发布协议；完整性校验可以放到显式诊断或低频 scrub，不进入热路径。

## 4.3 P0：Effect happy path 状态层与重复事实读取过多

当前 effectful 工具通常经过：

```text
ToolCall
→ ToolExecution
→ Operation
→ Attempt
→ EffectIntent
→ dispatch envelope
→ EffectReceipt
→ ToolResultArtifact
→ ToolOutcome
→ ToolModelResult
→ Message/Revision
→ Context tool pair
```

每一阶段还可能重新读取 ToolCall/Turn/Conversation/Lease、CommandReceipt 和 CAS 内容。静态分解显示，effect prepare/claim/receipt/complete 在 finalization 之前约有 45 个 worker RTT 量级。

冻结前 `commitSource()` 还会重新查一次已经在公开方法中查过的 CommandReceipt；当前实现已传递内部 preflight token，同时保留 UNIQUE race 回读：

- `backend/reliableKernel/effectControlPlane.ts:2275-2327`

### 结论

短期先减少读取和重复 receipt 查询；中期将状态模型收敛为：

```text
ToolCall          不可变模型调用身份、规范化参数、冻结策略
ToolRun           当前执行状态、取消、attemptSeq、开始/结束时间
EffectRecord?     仅真实外部副作用需要；prepared/claimed/settled/unknown
ToolModelResult   模型可见终态与 provider 顺序
Process?          仅后台/可恢复进程需要独立领域对象
```

`Operation + Attempt + EffectIntent + EffectReceipt` 若没有独立复用和查询需求，应合并到 `ToolRun + EffectRecord`，而不是因为“可靠”就全部独立建表。项目仍在开发期，按现有规则可做 Runtime epoch reset，不写旧 schema 兼容链。

## 4.4 P0：流事件被同步持久化并反压 Provider

冻结前 Provider adapter 的每个 `onEvent` 都会 await `recordStreamEvent()`：

- `backend/reliableKernel/modelProviderControlPlane.ts:698-717`

`recordStreamEvent()` 对 event 做 preflight、CAS prepare 和 commit；前 33 个非终态 checkpoint 会各自 durable：

- `backend/reliableKernel/modelProviderControlPlane.ts:844-927`

Limcode 已有 32ms/24 events/1024 chars 的 LLM 事件批处理器，因此本轮没有再叠加相同 batcher；当前已经调整的是**durability policy**：

- `output_item_done`：同步 durable；
- terminal summary/fence：同步 durable；
- 普通 delta：直接 transient fanout，每 ModelRequest 只保留首个 progress marker；
- terminal 完整结果直接成为 authority，不为其前面的 pending delta 额外制造一笔事务。

250ms/16KiB 样本经审计不是可重建 checkpoint，已取消。非终态 checkpoint 的总上限是 `1 delta + 32 output_item_done`；下一 semantic item 明确失败，Completed 仍绕过容量并在同一事务写 fence/prune。

## 4.5 P0：Context 与历史在每轮重复完整扫描/物化

Provider dispatch build 单 attempt 实测 materialize Context 1 次，但完整普通 create+首发为 2 次，自动压缩检查未触发和一次 retry 都为 3 次。当前树已有 `request_seq` frontier；`resumeRequestSequence()` 仍逐项扫描历史 recipe，但 DB/CAS I/O 已合批为固定 2 个 DB 请求。`ContextSequence.materialize()` 每次仍返回完整 segment 内容：

- `backend/reliableKernel/contextSequence.ts:280-303`

### 结论

1. 优先做 request-scoped one-shot snapshot；estimate、compression、provider retry 只复用同一 immutable root 的数据。
2. 不建立全局 full-history provider projection cache；root 每轮变化，命中主要只发生在同一 request retry，还会与现有 CAS LRU/WS state 重复占内存。
3. `resumeRequestSequence()` 已先完成 exact batched full audit；后续可缓存每 Turn 的整数 frontier并只验证 suffix，cache miss/gap/root rebuild 回退 full audit。
4. tool pairs 按 terminal prefix 批量追加，而不是每个结果重复读取 source、CAS 和更新 root。

## 4.6 P1：多工具终态检查存在 O(K²)

冻结前 `dispatchProviderToolBatch()` 在每个 serial/parallel group 后都对整个 calls 数组调用 `appendTerminalToolPairsInOrder()`，结束后再调用一次；当前实现已使用 drive-local cursor：

- `backend/reliableKernel/agentLoop.ts:588-630`

冻结前每个 pair 又单独检查 ContextSegmentSource 并调用 `appendToolPair()`；当前实现已用 `appendToolPairsInOrderBatch()` 合并连续 prefix：

- `backend/reliableKernel/agentLoop.ts:1196-1220`
- `backend/reliableKernel/contextSequence.ts:208-277`

K 个 serial 调用时会反复从头扫描，最坏二次增长。

### 结论

在一次 drive 中维护 `terminalPrefixCursor`：

```text
上次已确认 prefix = p
本组完成后只检查 calls[p..]
遇到首个未 terminal 即停止
一次 snapshot 读取该连续 terminal prefix
一次事务追加全部未追加 pair
更新 cursor
```

目标是 K 个调用的检查和追加都为 O(K)。

## 4.7 P1：进程 wrapper 正确，但每个短命令支付完整恢复协议

当前 wrapper、identity、manifest、effect claim、spool import 和多个观察 cadence 能支持 Extension Host 重启后的后台恢复；这是 Limcode 比参考实现更强的能力，不应整体删除。

问题是短命令也支付同样的 DB/CAS/fsync 成本，且输出 chunk 使用细颗粒 durable publish，长期进程又依赖多套轮询。

### 结论

以下 wrapper 优化保留为后续候选，不立即建设 persistent shell；本轮短命令分段数据没有证明它们优先：

1. output spool 改为 `256KiB～1MiB 或 25～100ms` 的 append-only segment pack；
2. segment 内保留 seq/长度/CRC，terminal receipt 前强制同步最后一段和 manifest；
3. wrapper 通过 `fs.watch`/本地 IPC 提示 host，低频 poll 只做 level-triggered 兜底；
4. 多进程由一个 observer 批扫，不为每个进程常驻多个 timer；
5. prepare/claim 直接传递已经准备的 request/envelope，不立刻从 CAS 读回验证自己刚写入的内容。

只有实测表明 `rg/git status/true` 的 spawn 本身仍占主导时，再考虑“仅限后端确认的短只读命令”的 direct spawn fast path。不要先建常驻 shell 池。

## 4.8 P1：Client Feed 位于事务响应附近

worker 先发 commit，再发 response；host 同步遍历 commit listeners：

- `backend/reliableKernel/runtimeDatabase.ts:477-490`

Client Feed 会同步 scope、plain conversion、wire size 计算，并在 ACK 慢时进入 snapshot：

- `backend/reliableKernel/clientFeed.ts:264-365`

### 结论

结构上仍可将 listener 分为两类：

- **关键本地 wake hint**：只做 O(1) 入队/置位；
- **UI projection/feed/sidebar**：放入按 commitSeq 排序的异步队列，不能阻塞 transaction Promise。

保留 commitSeq、ACK、bounded queue 和 snapshot barrier。当前 trivial listener 仅 0.0558～0.3546ms，因此异步化本轮明确延期；如果后续真实 UI burst 证明它成为热点，再删除“在事务响应邻近路径同步完成重投影”的做法。

## 5. 哪些可靠性语义必须保留

个人项目仍应保留下列最小正确性骨架，因为删除后会直接产生重复副作用、错序或后台进程失控：

1. **Turn 单一 owner/ExecutionLease fence**：每个真正推进状态的 transaction 检查 generation。
2. **真实外部副作用 claim-before-side-effect**：file/process/MCP/subagent 等不能在 durable claim 前执行。
3. **Effect terminal receipt/unknown 状态**：外部结果晚到或 host 崩溃后，必须知道“已执行、失败还是未知”，不能盲目重发。
4. **稳定 ToolCall identity 与唯一约束**：恢复时不能生成第二次相同调用。
5. **provider 顺序的 tool call/result 配对**：执行可以并发，模型可见 Context 必须保持合法顺序。
6. **后台进程 identity/nonce/start fingerprint/terminal receipt**：防 PID reuse 和重复启动。
7. **Client Feed commitSeq/ACK/bounds/snapshot barrier**：Webview 不能看到半事务，也不能无限积压。

这些是正确性边界，不是企业级过度设计。

## 6. 哪些层可以简化或删除

以下内容对当前项目明显偏重，应直接减少，而不是继续增加兜底：

1. 每个 Repository 小读都独立做完整 root 文件验证；改成高层 compound request。
2. 同一内部命令 happy path 两次查询 CommandReceipt；改成一次 transaction insert，以 UNIQUE 处理罕见竞争。
3. 所有纯读取工具都建立 Operation/Attempt/EffectIntent/Receipt；纯工具走 direct lane。
4. 每个普通模型 delta、progress、stdout chunk 都建立完整 durable event；改成 transient + bounded checkpoint/segment。
5. 每轮重复 materialize 同一个 Context；改成一次 snapshot + projection cache。
6. 每次 re-drive 从头扫描全部 request；改成 active frontier。
7. 每个 terminal tool pair 单独更新 Context root；改成连续 prefix batch。
8. 每个 process 各自维护多套高频 timer；改成事件提示 + 统一低频批扫。
9. 每个内部确定性阶段都单独建 CommandReceipt；只在外部 callback、可重入 public command、跨进程 producer 边界使用 receipt。
10. 通用死信系统、分布式 broker、DAG scheduler、多租户 quota、在线 CAS GC、持久 shell 池：本项目不做。

## 7. 目标调度模型

## 7.1 冻结后的执行策略

模型提供的 `readonly`、`parallel` 只能作为 hint，不能成为并发安全或自动审批事实。当前 command schema 写明“explicit parallel/serial always wins”，并允许模型声明 `readonly=true` 参与自动审批：

- `backend/world/modules/tools/definitions/command/index.ts:66-78,107-119,232-273`

这不仅是权限问题，也会让真实副作用命令绕过串行屏障，属于调度正确性问题。

建议冻结如下最小结构：

```ts
interface FrozenToolExecutionPolicy {
  lane: 'direct' | 'effect' | 'interaction';
  parallelSafe: boolean;
  weight: number;
  readKeys: string[];
  writeKeys: string[];
  permissionClass: 'none' | 'confirm';
  reason: string;
}
```

规则：

- 模型 `serial` hint 可收紧为串行；
- 模型 `parallel` hint 只有后端 classifier 也确认 safe 时才采用；
- `readonly` 只能来自后端已解析参数后的 classifier；
- policy 在 ToolCall 入库前冻结，后续 permission、scheduler、executor 共用同一份不可变结果；
- 未知工具、解析失败、未知资源默认 serial/effect。

不需要构建复杂资源图。首版资源键只支持：

```text
file:<realpath>
workspace:<root>
process:<id>
mcp:<server>
conversation:<id>
child-agent:<type>
```

## 7.2 有界 slot-refill，而不是无上限 Promise.all

当前已有 `backend/capabilities/boundedConcurrency.ts`，但它是 fail-fast 并取消 sibling。工具批次应增加 non-fail-fast 变体：

```text
provider 顺序输入
  → 连续 parallel segment
  → 按 weight/capacity 和资源键准入
  → 任一完成立即补位
  → 每工具独立 AbortController
  → 普通错误只终止本工具
  → 明确的危险/共享依赖错误才取消 sibling
```

推荐首始常量，不急于做设置 UI：

- 普通 direct 工具：全局 capacity 4；
- process/MCP effect：全局 capacity 2～3；
- child agent：全局 capacity 2；
- 单 Turn 同时 active 工具：最多 4；
- 后续按基准和真实使用分布调整。

## 7.3 建议的工具分类

| 工具类型 | lane | 初始调度 |
|---|---|---|
| `read`、skills 元数据、只读列表 | direct | parallel，weight=1，按 file/catalog read key |
| task list 等内部单事务状态更新 | direct | conversation write key |
| `ask_user`、`submit_plan` | interaction | conversation 独占，进入 waiting，不走外部 Effect |
| edit/write/delete/transfer | effect | 按 realpath write key；未知路径 workspace 独占 |
| 后端静态确认的只读 command | effect/process | 可 parallel，process capacity |
| 其他 command | effect/process | workspace-process write key，默认 serial |
| MCP | effect | 默认 server key 串行；仅可信 registry 的 read-only hint 可并发 |
| run_agent | effect/child | child-agent key，session/global cap |

## 7.4 结果顺序

必须分开三个概念：

1. **执行完成顺序**：用于 UI 和释放 capacity；
2. **durable outcome 顺序**：可以按 2～5ms/16～32 条做 micro-batch，不必等整个 group；
3. **模型 Context 顺序**：始终按 provider ordinal 追加连续 terminal prefix。

这样可以避免 Pi/Codex 式的整组 straggler/HOL，同时保持合法 tool call/result 配对。

## 8. 目标执行模型：三条 lane

## 8.1 Direct lane

适用于无外部不可逆副作用、重复执行可接受的工具：read、skills、内部纯计算、简单内部状态更新。

```text
ToolCall batch transaction
→ bounded direct execute
→ result normalize
→ ToolRun terminal + ToolModelResult + Message/Revision + Context prefix batch
```

不创建 Operation/Attempt/EffectIntent/EffectReceipt。取消使用进程内 child signal；崩溃后根据 ToolCall terminal 与否重新执行即可。

## 8.2 Effect lane

适用于 file/process/MCP/subagent 等真实外部副作用：

```text
ToolCall
→ EffectRecord(prepared)
→ durable claim(claimed + lease generation)
→ external side effect
→ receipt(settled/unknown)
→ ToolModelResult
```

一个工具若只有一个外部 effect，不再拆独立 Operation、Attempt、Intent、Receipt 四张通用状态表；attemptSeq 和 request/receipt refs 放在 EffectRecord。确有多个独立子 effect 时，允许一个 ToolRun 对多个 EffectRecord。

## 8.3 Interaction lane

`ask_user`、`submit_plan` 等不是外部副作用，也不应套进 process/file effect 状态机：

```text
ToolCall
→ interaction waiting
→ user response/rejection
→ ToolModelResult
```

只保留一个 waiting record/link 和稳定 delivery identity。

## 9. 流式提前执行：最后做，而不是第一步做

Claude Code 2.1.88 在 feature gate 下可在完整 `tool_use` block 后启动工具；Codex 虽在 `output_item.done` 时构造 future，但直到模型流退出后才 poll；Pi 等 assistant 完成后执行。

Limcode 已有 durable `output_item_done` checkpoint，因此具备更早 admission 的基础。但流式启动主要带来：

- 与模型后续输出重叠；
- UI 更早看到结果；
- 模型仍只能在下一次请求消费结果。

建议分两步：

### 第一步

只对 direct、后端确认 parallel-safe 的读取工具启用：

```text
completed output item
→ stable identity + canonical args hash
→ durable ToolCall
→ bounded direct execute
→ UI outcome
→ assistant terminal 后按 ordinal 封口 Context
```

### 第二步

只有基准证明收益显著时，才允许 effect lane 提前 claim。必须满足：

- completed item 已 durable；
- stable ToolCall identity 和 args digest 已冻结；
- 第一个外部 effect claim 后设置 model-request side-effect fence；
- 禁止没有 stable resume identity 的 provider fallback/retry；
- 恢复按 ToolCall/EffectRecord 唯一约束续接，不能重发副作用。

不要复制 Claude 2.1.88 源码中已经警告的“mid-stream fallback 可能双执行工具”路径。

## 10. 分阶段实施计划

## Phase 0：建立本地基准与轻量指标

状态：已完成。指标默认关闭、只记录 metadata/count/timing，不记录正文、命令参数、路径或凭据。

只增加开发态计数和时间跨度，不建设长期 telemetry 平台：

- DB worker request 数、queue wait、execute time；
- RootAuthority validate 次数/耗时；
- CAS hit/publish/fsync 数；
- provider terminal → tool start → tool terminal → next model dispatch；
- Context materialize 次数/字节；
- terminal prefix scan 次数；
- feed synchronous listener time、queue depth、snapshot 次数；
- process spawn/identity/output import/terminal wake。

## Phase 1：最高收益、低风险热路径减法

状态：已完成代码和回归验证；第二轮 call-site 减法后单 read 为 33，目标 30 仍未完全达到，详见第 0 节。

1. 为 `requireToolFacts`、`requireActiveTurnContext`、terminal result、termination、provider definition 建 compound snapshot。
2. RootAuthority 同时发起验证 single-flight，并跨 25ms 成功热窗口复用；过期后重新验证。
3. 消除 CommandReceipt happy-path 双查；以 transaction UNIQUE 处理罕见竞争。
4. CAS `prepare/prepareBatch` 增加 SQLite-existing fast path。
5. `appendTerminalToolPairsInOrder` 使用 cursor，修复 O(K²)。
6. 并发入口使用 non-fail-fast bounded slot-refill；当前 ordinary/process-MCP/child admission 为 8/4/8。
7. 修正 command：模型 `parallel/readonly` 仅作 hint，后端 classifier 才是冻结事实。

验收目标：

- fresh `read` 到 capability start：冻结前 p50 46～47，当前 33；**未达到 30**；
- K 个 serial 工具 terminal/context 检查为 O(K)：完成，K=10 inspection 为 84→10、DB snapshot 为 84→10；
- duplicate CAS prepare：0 次 temp write、0 次 fsync：完成；
- 任一批次 active tool 数不超过对应 cap：完成，ordinary 8、process/MCP 4、child durable-intent admission 8。

## Phase 2：事件、Context 与 Feed 合批

状态：实施数据支持的 Provider、Context、re-drive 与 transfer source 小项；其他项保留或取消优先级。

1. **已完成并修正**：普通 model delta 改 transient + 首 delta marker；item done/terminal 仍同步 durable。250ms/16KiB 非可重建样本策略已取消。
2. **部分完成**：不增加通用 ToolCallEvent batcher；修复 transfer 每文件绕过已有 1 秒 throttle 的事件源。进程 stdout 继续以 spool 为 authority。
3. **已完成**：实现 `appendToolPairsInOrderBatch`。
4. 一次 model request 共享 request-scoped Context snapshot；不增加全历史 provider projection cache。
5. **已完成低风险部分**：全历史 re-drive 的 recipe I/O 合批为固定 2 DB 请求；process-local suffix frontier 保留为后续项。
6. **本轮取消**：Client Feed/UI projection 放入 commitSeq 异步队列；当前 listener 实测不足 0.4ms，不是主热点。

验收目标：

- Provider E=1000 普通 delta 不再对应 O(E) durable commit；transfer progress 不再按文件数产生 O(E) ToolCallEvent；
- 每次 model request 当前 Context materialize 不超过 1 次：**未完成**，普通 create+首发仍为 2 次；
- K 个 terminal tool pairs 使用 O(1) 批事务或按固定 batch 数增长；
- UI listener 不进入 DB response 的重 CPU 路径。

## Phase 3：执行 lane 与状态模型收敛

状态：部分实施；已拆 ordinary/process-MCP/child admission 三路并让 ordinary readonly lane 提前 durable settlement，但未进行 direct/effect schema cutover。

1. direct/effect/interaction 三 lane。
2. 纯工具删除 Operation/Attempt/EffectIntent/Receipt。
3. effect 工具将通用中间状态收敛为 ToolRun + EffectRecord。
4. 只在外部 callback/public re-entry/cross-process producer 边界保留 CommandReceipt。
5. 结果采用 adaptive micro-batch，Context 只追加 provider-order terminal prefix。

这是 schema cutover。按项目规则使用新的 Runtime epoch reset，不实现旧 Runtime schema fallback/migration；Agent/Workflow/Policy/Settings 等配置独立保留。

## Phase 4：进程热路径

状态：本轮不实施；spawn 实测只占 2.7～5.2ms，数据不支持 persistent shell 或 spool 重写优先级。

1. spool segment pack，减少 inode/rename/fsync。
2. wrapper event hint + 低频 level poll。
3. 单 observer 管理多个 process。
4. 去除 prepare/claim 后立即读回自己刚写 CAS 的步骤。
5. 实测后再决定是否增加静态只读短命令 direct spawn fast path。

验收目标：

- 100MiB 输出的 fsync/文件数至少下降一个数量级；
- 长期 P 个进程的空闲 DB 查询不再按 `P × 4/s` 线性增长；
- terminal receipt 与恢复完整性测试保持通过。

## Phase 5：可选的 durable streaming start

状态：明确不实施；仅在后续数据证明必要时重新评估。

先只启用 direct read tools；effect lane 放在单独 feature gate。要求有 shadow 指标和 mid-stream abort/retry 故障测试。

## 11. 基准矩阵与通过线

| 场景 | 变量 | 主要指标 |
|---|---|---|
| 单 `read` 1KiB | cold/warm CAS、无/有 Webview | worker RTT、Root FS、CAS fsync、capability-start p50/p95 |
| 工具批 | K=1/2/5/10/25；全 parallel/serial/交错 | active cap、terminal scan、Context transactions、总时延 |
| 短 command | `true`/`printf`/`rg`/`git status` | effect control、spawn、identity、output import 分段时延 |
| 长后台进程 | P=1/10/50 | idle DB requests/s、CPU、poll 数、completion wake |
| Provider 流 | E=1/10/33/100/1000 | durable checkpoint 数、terminal→tool start |
| 长 Turn | R=1/10/100/500 requests | re-drive DB 请求、frontier 命中、recipe CAS bytes |
| Context | S=10/100/1000 segments | materialize 次数、bytes、tokenize、projection cache hit |
| Feed | ACK=0/10/100/500ms，burst=1/10/50 | queue、snapshot、transaction response 影响 |
| Straggler | 1 慢 + 31 快 | UI outcome、durable outcome、model prefix HOL |
| 外部写锁 | 持锁 5s | busy timeout 行为；与正常基准分开报告 |

每项报告 p50/p95/p99，并同时报告操作计数。只看 wall time 会被 Provider 网络掩盖。

### 必须保持的回归门槛

- claim-before-side-effect；
- duplicate callback 不重复执行；
- provider call/result 顺序；
- process crash/restart/outcome-unknown；
- root switch/stale generation fence；
- client snapshot handoff；
- abort 后单一 terminal outcome；
- tool pair 批量追加的 idempotency。

## 12. 预期收益

原静态目标已由第 0 节实测取代。当前可确认的收益与未达项是：

1. 普通 read 的 pre-capability worker request 是冻结前 46～47，当前 33；20～30 目标没有达到。
2. `requireToolFacts` 5→1 request；有 fence 的 active Turn 3→1；terminal result 3→1；receipt happy path 少 1 request。
3. CAS duplicate fast path把 publish/temp/file/directory fsync 从 1/1/1/8 降到 0/0/0/0。
4. E=100 burst 的 durable ModelStream transaction 从 34 降到 2，worker request 从 175 降到 6。
5. Provider build 单 attempt 为 1 次 Context materialize，但完整普通 create+首发为 2 次；没有证据支持全局 projection cache，未实现。
6. tool-pair cursor/batch把 K=10 serial terminal inspections 从 84 降到 10，parallel terminal DB snapshots 从 30 降到 1，parallel Context transaction 从 10 降到 1。
7. R=500 re-drive 从 1001 requests/1264.10ms 降到 2 requests/56.634ms p50，同时保留 full-history audit。
8. 1000 文件 transfer progress 从 1002 降到 3；process segment spool 重写仍无数据支持，未实施。
9. bounded slot-refill 的 cap/non-fail-fast/order/parent-abort 均有回归测试；mixed lane 已实施为 8/4/8，readonly durable HOL 合并复跑 p50 从 278.589ms 降至 41.879ms。

真实毫秒收益必须由 Phase 0 基准确认；优化目标是减少本地控制面延迟，不会消除模型网络和推理时间。

## 13. 明确不做

为控制个人项目复杂度，本轮不建设：

- 通用 DAG/workflow scheduler；
- 多进程/分布式任务 broker；
- 多 SQLite worker 分片；
- 多租户 ACL、审计流水和 quota 平台；
- 通用死信队列；
- 默认 PTY/交互 shell；
- persistent shell pool；
- 每个 progress/delta 的永久 event sourcing；
- 在线 CAS GC/引用计数系统；
- MCP、skills、subagent 的完整生态级框架复制；
- 为旧未发布 Runtime schema 编写兼容、双写或 migration 链。

## 14. 推荐的实际执行顺序

```text
轻量指标
→ compound DB facts + CAS fast path + receipt 去重
→ O(K²) cursor/batch + 有界并发
→ delta/progress durability 降级 + Context snapshot/cache
→ direct/effect/interaction 三 lane
→ process segment/wakeup
→ 最后评估 streaming early start
```

如果只能先做三项，应选择：

1. **compound facts + Root validate single-flight；**
2. **CAS existing fast path；**
3. **tool-pair cursor/batch + stream durability 降级。**

这三项比先重写调度算法更可能直接改善当前“每次工具都慢”的体感。
