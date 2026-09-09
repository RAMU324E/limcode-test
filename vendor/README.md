# 固定模型接入库构建

本目录维护 `unified-llm-provider` 的观察接口与 Astra 原生适配补丁及固定安装包。

- 上游：`https://github.com/Lianues/unified-llm-provider`，许可证 MIT。
- 基础发布：0.1.35，源码提交 `3cb58dad30bda99d7c414ba5dd230745e6298bdb`。
- 本地构建：0.1.35-limcode.2。在 limcode.1 的只读观察接口之上增加：
  - function 工具声明与 function_call 输入/解码 item 的 `async` 标记无损透传（Astra 异步工具）；
  - 可选原生解码模式（provider 内部构造开启；LimCode WebSocket 会话不开启），精确 Astra 模型在 SSE 解码时附加 `nativeEvent`（response.created/completed/incomplete）与终端 `completedContents`；
  - Astra 显式缓存断点：顶层 instructions 转为带 `prompt_cache_breakpoint` 的 developer 输入消息（GPT-5.6+ 语义），其余模型行为不变。
- `unified-llm-provider.patch` 是源码差异，不直接作用于依赖安装目录。
- `provider-debug-provenance.json` 记录基础提交、补丁与安装包摘要。
- 重建：在项目根目录运行 `node scripts/reliable-kernel/build-provider-debug-fork.mjs`。
- 验证：运行 `node scripts/reliable-kernel/build-provider-debug-fork.mjs --check` 核对已固定的补丁和安装包。

观察接口不开启原库的累计全文调试功能；除上述 Astra 适配外不改变请求编码、解析规则和工具执行。升级此依赖时必须重新检查补丁和测试，不允许静默退回没有观察接口的版本。
