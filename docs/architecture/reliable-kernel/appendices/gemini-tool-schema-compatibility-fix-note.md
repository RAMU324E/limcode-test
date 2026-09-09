# Gemini 工具 Schema 兼容补充

## 问题与原因

Live2D MCP 的 rig_transform 在 operations[].selection.radius、range.radius 和 selection.radius 上声明 exclusiveMinimum: 0，表示半径必须严格大于 0。原生 Gemini 的 functionDeclarations.parameters 使用受限 Schema，不接受 exclusiveMinimum / exclusiveMaximum，请求会在生成开始前被拒绝。

此前的 edit oneOf、propertyNames 和 multipleOf 修复没有覆盖这两个关键词。这是工具声明兼容缺口，不是工具参数 JSON 损坏，也不是重试能恢复的临时繁忙。

OpenAI 兼容格式此前只经过通用 OpenAI Schema 转换，同样保留这些关键词。转发层若将其映射到 Gemini 受限 parameters，也可能报同类错误；不能据此断言所有 OpenAI 兼容 Gemini 上游都会失败。

## 修复范围

- 原生 Gemini 与可识别为 Gemini 的 OpenAI 兼容模型共用现有 Schema 转换，递归移除不受支持的 exclusiveMinimum / exclusiveMaximum。
- OpenAI 兼容模式按最终模型名称识别，支持渠道路径、方括号前缀和大小写；不能只因渠道名含 Gemini 就处理 GPT / Qwen。
- 区分 Schema 关键词与 properties 中的工具参数名称，保留恰好名为 exclusiveMinimum、exclusiveMaximum、propertyNames、title 的参数及 required。
- 只重建出站工具声明。MCP 原始 Schema、工具执行、历史参数和结果、思考签名、其他模型的声明都不修改。
- 不调整重试分类，不修改依赖包，不迁移运行时数据，也不增加配置项。

兼容转换会弱化模型侧的严格开区间约束；原有 minimum / maximum 等受支持约束仍保留，最终合法性继续由工具实现校验。没有通过任意 epsilon 或改写参数值来模拟严格边界。

## 验证

- 新增回归先在旧实现复现：Gemini 原生及 OpenAI 兼容模式均透传不支持字段；非 Gemini 保持原样。
- dry-run 和真实 SDK 出站拦截覆盖三处深层 radius、上下界、同名参数、原始输入不可变，以及 Gemini 签名和工具调用 ID 不变。
- 原失败请求的 60 个冻结工具声明只读离线对照：原生 Gemini 恰好移除三处 exclusiveMinimum；OpenAI 兼容 Gemini 输出与原生一致；GPT 声明与旧版一致。
- 上述验证不访问用户模型服务，不调用 MCP 工具；OpenAI 兼容模式的上游风险由透传行为和受限 Schema 合同确认，未声称所有网关都已进行联网实测。

相关测试入口：

- tests/openAIResponsesWebSocket.test.cjs
- tests/reliable-kernel/provider-wire-invariant.test.mjs
- tests/reliable-kernel/provider-websocket-policy.test.mjs

字段合同参考：https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta 中的 Schema 与 FunctionDeclaration。
