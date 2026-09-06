# 固定模型接入库构建

本目录维护 `unified-llm-provider` 的最小观察接口补丁及固定安装包。

- 上游：`https://github.com/Lianues/unified-llm-provider`，许可证 MIT。
- 基础发布：0.1.35，源码提交 `3cb58dad30bda99d7c414ba5dd230745e6298bdb`。
- 本地构建：0.1.35-limcode.1，仅增加实际解析过程的只读观察接口及来源弱引用。
- `unified-llm-provider.patch` 是源码差异，不直接作用于依赖安装目录。
- `provider-debug-provenance.json` 记录基础提交、补丁与安装包摘要。
- 重建：在项目根目录运行 `node scripts/reliable-kernel/build-provider-debug-fork.mjs`。
- 验证：运行 `node scripts/reliable-kernel/build-provider-debug-fork.mjs --check` 核对已固定的补丁和安装包。

观察接口不开启原库的累计全文调试功能，不改变请求编码、解析规则和工具执行。升级此依赖时必须重新检查补丁和测试，不允许静默退回没有观察接口的版本。
