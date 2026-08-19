# Limcode Test

Limcode Test 是基于 [LimCode](https://github.com/Lianues/limcode2) 演进、由 [lurenxing628](https://github.com/lurenxing628) 独立维护的衍生项目。当前仓库独立管理发布与开发历史，并使用独立的扩展、命令、视图及数据命名空间，可与原版同时安装。

- 当前仓库：[lurenxing628/limcode-test](https://github.com/lurenxing628/limcode-test)
- 上游来源：[Lianues/limcode2](https://github.com/Lianues/limcode2)
- 开源许可：[GNU GPL v3](LICENSE)

## 和原版的区别

Limcode Test 不是简单改名。它仍然是在 VS Code 中使用的对话助手，但对话如何运行、保存和恢复已经和原版有很大区别，主要部分都重新做过。

具体重做的内容：

- 重新设计了对话的运行和保存方式，让消息、工具操作和任务状态都有清楚记录。
- 重新做了中断和恢复。对话被打断、工具超时或程序重开后，可以接着原来的任务，减少丢消息、重复执行和一直等待。
- 重新做了长对话处理。打开长对话时先显示最近内容，内容过多时整理较早部分，并尽量保留当前任务和重要结果。
- 重新做了工具、文件和后台任务的执行过程，补上结束确认、临时文件清理和意外退出后的处理。
- 重新做了子助手协作，让它们能独立完成部分任务并把结果带回原对话，同时限制创建层数。
- 重新做了历史记录、附件、本地图片和设置同步，并改进启动、滚动和展开内容时的速度。
- 删除了原来的旧运行代码，统一使用新的运行方式。

其他工作：

- 增加了自动测试、多系统检查和性能测量。
- 整理了提交历史和开发规则，完善了项目文档，并迁入奥德赛组织，方便多人分开修改、一起维护。

## 当前能力

- 主 Webview 提供基础 AI 对话界面。
- Webview 通过 bridge 发送 `chat:send`，后端 ECS chat systems 生成 assistant 消息并触发 `llm.start` effect。
- LLM capability 使用通用 provider 命名；当前基础链路默认跑 Deepseek：
  - Base URL: `https://api.deepseek.com/v1`
  - Model: `deepseek-v4-flash`
- LLM API 设置保存为 VS Code `globalStorageUri` 下的明文文件：
  - `settings/llm-api.json`
  - Webview 顶部“LLM 设置”可以直接查看和修改 `provider/baseUrl/model/apiKey/temperature`。
- 对话持久化也通过 VS Code `globalStorageUri`，并在文件层面拆分 agent、conversation、link：
  - `agents/index.json` + `agents/records/{timeSlugHash}.json`：只保存 agent 组件投影。
  - `conversations/index.json` + `conversations/{timeSlugHash}/conversation.json`：只保存对话元数据。
  - `conversations/{timeSlugHash}/messages/index.json` + `messages/chunks/000000.json`：保存该对话的消息块和消息关联的 toolCalls。
  - `agent-conversation-links/index.json` + `agent-conversation-links/records/{timeSlugHash}.json`：只保存 agent 与 conversation 的 link 关系。
- `RuntimeEnv.paths` 记录插件全局数据目录，以及 agents / conversations / links / settings 等独立数据根目录和索引路径。

> 当前开发阶段按需求把 LLM API Key 明文保存到 `settings/llm-api.json`，不使用环境变量，也不使用 VS Code SecretStorage。

## 支持平台

Release 提供以下本地 VS Code Extension Host 制品：

- Windows x64
- Linux x64
- macOS x64（Intel）
- macOS arm64（Apple Silicon）

各平台 VSIX 均包含对应的 `better-sqlite3` 原生模块；请按操作系统和 CPU 架构选择安装包。

## 快速开始

```bash
npm install
npm run build
```

然后在 VS Code 中按 `F5` 启动 Extension Development Host。

常用命令：

```text
Limcode Test: Open AI Chat
Limcode Test: Reveal Data Storage Folder
```

## 协作开发

- 从 `main` 创建独立分支进行开发。
- 通过 Pull Request 合并改动，不直接改写已经共享的历史。
- 提交消息只写简明中文标题，不添加类型前缀，也不写正文。
- 提交前运行 `npm run check:plan:tracked`，确保构建、类型检查和测试通过。

## 常用脚本

```bash
npm run compile          # 编译扩展后端 TS
npm run watch            # 监听并编译扩展后端 TS
npm run dev:webview      # 启动 Vue Webview Vite dev server
npm run build:webview    # 构建 Webview 静态资源
npm run build                  # 编译后端 + 构建 Webview
npm run check                  # 构建、类型检查和可靠内核计划合同校验
npm run check:local            # 在上述校验后，再运行本地测试
npm run package:linux          # 打包 Linux x64 VSIX
npm run package:win32          # 打包 Windows x64 VSIX
npm run package:darwin-x64     # 打包 macOS Intel VSIX
npm run package:darwin-arm64   # 打包 macOS Apple Silicon VSIX
```

## 目录概览

```text
backend/                 # ECS world、application composition root、capabilities
shared/                  # Webview 与扩展共享协议
vscode/                  # VS Code extension entry、commands、panels、views
webview/                 # Vue Webview 前端
docs/                    # 架构与开发约束说明
```

## 架构文档

- [新运行系统架构](docs/architecture/reliable-kernel/README.md)：当前运行架构、约束合同和检查规则。
- [Conversation 可靠存储权威模型](docs/conversation-storage-authority.md)：当前文件后端实现说明；对应能力切换后转为历史记录。
- [模型上下文投影、中断与压缩一致性](docs/model-context-projection.md)：当前实现说明；Provider/Context 能力切换后转为历史记录。
- [后台进程 completion 可靠注入语义](docs/background-process-reliability.md)：当前实现说明；Runtime/Tool/File 能力切换后转为历史记录。
