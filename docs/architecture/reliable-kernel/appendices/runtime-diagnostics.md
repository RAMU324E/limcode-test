# 可靠 Runtime 有界诊断

## 定位

诊断日志是**观察数据**，不是 Runtime 领域 authority，不参与 Turn、Message、Tool、Feed commitSeq 或恢复判定。它位于当前 fenced `RootBinding.paths.dataRootPath/diagnostics/`，每次写入和读取前都由 `RootAuthority.validate(binding)` 重验完整 binding；root 切换后旧 journal fail closed。

## 隐私边界

只允许固定 metadata 字段：Conversation/Turn/ModelRequest/ToolCall/Feed session 身份、序号、阶段、状态、耗时、字节数、记录数和错误类型。

禁止持久化：

- prompt、system prompt、模型正文、thought、tool arguments/result；
- API key、Authorization、headers、代理凭据、密码；
- 文件正文、Diff 正文、路径、URI；
- 任意嵌套对象和未列入 allowlist 的字段；
- 原始错误 message/stack。

字符串 metadata 最长 192 字符；每个事件最多 16 个字段。非法事件直接计入 dropped counter，不能影响 Runtime 控制流。

## 容量与保留

- 内存 pending：最多 256 个事件；
- 单次 flush：最多 128 个事件；
- flush 延迟：750ms；
- 文件：`events.jsonl` + 3 个 rotation；
- 每文件：最多 1MiB；
- 总文件预算：最多 4MiB；
- 保留：7 天；
- inspector：最多返回 200 个事件和 100 个聚合 span。

诊断写入失败不会重试外部动作，也不会阻断 Agent loop；失败批次被丢弃，只暴露脱敏错误 code。

## 覆盖链路

### Provider 首包到首画

```text
agent.lifecycle(provider_dispatch_started)
→ provider.transient.first_event
→ webview.transient.painted
```

三者按 `modelRequestId` 聚合为 `provider-first-paint` span。Webview paint 使用双 `requestAnimationFrame`，表示状态应用后至少跨过一次浏览器绘制机会。

### Feed post / ACK / paint

```text
feed.data.posted
→ feed.data.acked 或 feed.data.post_failed
→ webview.feed.painted
```

按 `sessionId + messageSeq` 聚合为 `feed-roundtrip` span。空 changes 包不记录，避免诊断自身形成反馈回路。

### 完成态 Diff

```text
diff.open.requested
→ diff.cas.loaded
→ diff.editor.shown 或 diff.open.failed
```

按 `toolCallId` 聚合为 `diff-open` span。只记录成员数量和耗时，不记录文件路径或内容。

## 查看

Extension Development Host 中运行：

```text
Limcode test: Inspect Reliability State (Development)
```

输出中的 `diagnostics.events` 是原始脱敏事件，`diagnostics.spans` 是上述三类链路的有界聚合；`database.contextCasCache` 同时展示长上下文 CAS LRU 的 entries/bytes/hits/misses/evictions。
