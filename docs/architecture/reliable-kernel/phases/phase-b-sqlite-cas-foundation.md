# 阶段 B：SQLite 与 CAS 地基

## 前置条件

只有 r4 计划收口且 `npm run check:contracts:plan` 退出 0 后才开始本阶段。不得把计划合同的 PENDING 项伪造成 foundation 已实现。

## 目标

让 SQLite 接管小型 Runtime 事务，让 CAS 接管大内容，让 RootAuthority 接管 fenced data root；停止扩建自制文件数据库。

## 主要工作

- 按 targets.json 验证 SQLite driver 与当前 VS Code Electron ABI；
- 建立 single dedicated writer、WAL snapshot reader、foreign keys、busy timeout 与 savepoint nesting；
- 通过 `getPaths()` + RootAuthority 建立 immutable `RootBinding { paths, dataSetId, rootInstanceId, rootGeneration, pointerRevision, runtimeKernelEpoch }`；
- 每个 request/transaction 开始时重验 binding generation；root switch 只通过 restart/reopen；
- 创建单个 `limcode.sqlite`；
- 按 authority.json 的 72 个 Runtime domain exact set 建独立 table、Repository、Codec、mutation/client mapping 与 delete/reset policy；
- 首发不创建 ChildTurnLink、ProviderContinuation、ClientChangeLog、AskUser、TaskList 或 MCP 专表；
- 创建 CAS 与 ContentObject metadata；先 publish CAS，再 commit SQLite reference；
- 建立 commitSeq source 与 transaction result changes 接口，为 snapshot/feed barrier 提供原子水位；
- 建立开发 candidate root reset 与 RootBinding pending/epoch protocol；
- 输出 B frozen interface：transaction API、Repository set、commit result、snapshot barrier 与 RootAuthority API。

## Context 与 retention 基线

- ContextSequenceNode 为可分支 parent DAG；
- ContextSequenceRoot.root_node_id 非 UNIQUE；
- ConversationContextHeadLink 显式 current root；
- root/node 与 projection 首发保留到 Runtime dataset reset；
- 不做在线 Context GC 或 CAS refcount；
- ProviderContinuation 首发禁用，因此不建对应 table。

## physical migration 边界

B 只实现 candidate root 与 RootBinding foundation，不执行真实 production cutover。production archive/filter actor 属于 G，但 B 必须提供其需要的 current root binding、pending、epoch 与 fail-closed open API。

配置仍由独立 configuration roots 保存；不得为了共用 SQLite 事务把 Settings、Agent、Workflow、Policy、Prompt、ModelProfile、WorkEnvironment 或 RuntimeContext 移入 Runtime database。

## 刻意不做

- generic JSON table 或 arbitrary business SQL batch；
- old/new dual writer；
- legacy Runtime import/fallback；
- incremental schema migration chain；
- online database move；
- online Context/CAS GC；
- ClientChangeLog；
- process wrapper、MCP dispatch、subagent recovery 等 D/F 领域实现。

## 完成标准

- SQLite 可独立 create/commit/rollback/reopen；
- foreign keys、partial UNIQUE 与 indexes 真实生效；
- 72 个 target domain exact set 与 schema manifest 一致；
- CAS committed reference 永不指向缺失对象；
- RootBinding stale generation fail closed；
- empty root 无 legacy migration 可创建 current epoch；
- SQLite/CAS 失败不走旧 writer；
- foundation gate 的每个 stable ID 都有真实 handler 与证据。
