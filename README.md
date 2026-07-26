# Limcode test

Limcode test 是基于 [LimCode](https://github.com/Lianues/limcode2) 演进、由 [lurenxing628](https://github.com/lurenxing628) 独立维护的衍生项目。当前仓库独立管理发布与开发历史，并使用独立的扩展、命令、视图及数据命名空间，可与原版同时安装。

- 当前仓库：[lurenxing628/limcode2](https://github.com/lurenxing628/limcode2)
- 上游来源：[Lianues/limcode2](https://github.com/Lianues/limcode2)
- 开源许可：[GNU GPL v3](LICENSE)

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

## 快速开始

```bash
npm install
npm run build
```

然后在 VS Code 中按 `F5` 启动 Extension Development Host。

常用命令：

```text
Limcode test: Open AI Chat
Limcode test: Reveal Data Storage Folder
```

## 常用脚本

```bash
npm run compile          # 编译扩展后端 TS
npm run watch            # 监听并编译扩展后端 TS
npm run dev:webview      # 启动 Vue Webview Vite dev server
npm run build:webview    # 构建 Webview 静态资源
npm run build            # 编译后端 + 构建 Webview
npm run check            # 编译后端 + Webview 类型检查
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

- [Conversation 可靠存储权威模型](docs/conversation-storage-authority.md)
- [模型上下文投影、中断与压缩一致性](docs/model-context-projection.md)
- [后台进程 completion 可靠注入语义](docs/background-process-reliability.md)
