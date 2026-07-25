import * as vscode from 'vscode';
import type { ConversationLlmSettingsRecord, GlobalSettingsRecord, InlineDataPart, LlmInvocationSettingsSnapshotRecord, LlmProviderConfigRecord, ToolDefinitionRecord } from '../../shared/protocol';
import {
  createLlmProviderCapability,
  createCommandCapability,
  BackgroundProcessManager,
  createWorkEnvironmentRuntimeCapability,
  createVsCodeFsCapability,
  createVsCodeStorageCapability,
  createWebviewCapability,
  createSkillCatalogCapability,
  createRulesCatalogCapability
} from '../capabilities';
import { createGlobalSettingsRecord } from '../capabilities/vscodeStorage/globalStatus';
import { createToolRegistry } from '../world/modules';
import type { ToolSchema } from '../world/modules/llm/contracts';
import { toolDefinitionRecord, type ToolDefinition } from '../world/modules/tools/registry';
import { EXTENSION_PACKAGE_NAME, EXTENSION_VERSION } from '../../shared/extensionIdentity';
import type { RuntimeEnv } from './RuntimeEnv';
import { McpRuntimeManager } from './mcpRuntimeManager';

export interface RuntimeAttachmentInput {
  attachmentId?: string;
  sourcePath?: string;
  mimeType?: string;
  name?: string;
}

export type RuntimeAttachmentResolver = (input: RuntimeAttachmentInput) => Promise<InlineDataPart>;

export interface RuntimeEnvSetup {
  env: RuntimeEnv;
  toolSchemas: ToolSchema[];
  toolDefinitions: ToolDefinitionRecord[];
  installAttachmentResolver(resolver: RuntimeAttachmentResolver): void;
}

/**
 * Runtime capability 装配入口。
 * 只负责把 VS Code 侧能力实现组装成 RuntimeEnv，不包含领域规则。
 */
export function createRuntimeEnv(context: vscode.ExtensionContext): RuntimeEnvSetup {
  const storage = createVsCodeStorageCapability(context);
  let attachmentResolver: RuntimeAttachmentResolver | undefined;
  const backgroundProcesses = new BackgroundProcessManager({ paths: () => storage.paths });
  const command = createCommandCapability({ backgroundProcesses });
  const workEnvironment = createWorkEnvironmentRuntimeCapability();
  const registry = createToolRegistry(command);
  const mcp = new McpRuntimeManager(storage);
  const llm = createLlmProviderCapability({
    settings: async (request) => {
      if (request && 'settingsSnapshot' in request && request.settingsSnapshot) return resolveSnapshotLlmProviderConfig(storage, request.settingsSnapshot, request.conversationId);
      const override = request && 'model' in request ? request.model : undefined;
      const overrideConfig = override?.providerConfigId ? await storage.loadLlmProviderConfigById(override.providerConfigId) : undefined;
      const base = overrideConfig ?? await storage.loadActiveLlmProviderConfig(request?.conversationId);
      const overrideModel = override?.model?.trim();
      const canUseOverrideModel = !!overrideModel && (!override?.providerConfigId || !!overrideConfig) && modelExistsInConfig(base, overrideModel);
      const resolved = {
        ...base,
        ...(canUseOverrideModel && override?.provider ? { provider: override.provider } : {}),
        ...(canUseOverrideModel ? { model: overrideModel } : {})
      };
      const withConversationModel = await applyConversationModelOverride(storage, request?.conversationId, resolved);
      return applyModelSpecificConfig(withConversationModel);
    },
    compressionSettings: async (request) => {
      const activeProvider = await storage.loadActiveLlmProviderConfig(request.conversationId);
      const config = request.methodConfigId
        ? await storage.loadLlmCompressionConfigById(request.methodConfigId)
        : await storage.loadActiveLlmCompressionConfig(activeProvider.id, activeProvider.model);
      return config;
    },
    activeCompressionSettings: async (request) => {
      if (request?.providerConfigId) return storage.loadActiveLlmCompressionConfig(request.providerConfigId, request.model);
      const activeProvider = await storage.loadActiveLlmProviderConfig(request?.conversationId);
      return storage.loadActiveLlmCompressionConfig(activeProvider.id, activeProvider.model);
    },
    headers: { 'User-Agent': `${EXTENSION_PACKAGE_NAME}/${EXTENSION_VERSION}` },
    proxy: async () => createGlobalSettingsRecord(context).proxy || undefined,
    resolveAttachment: async (input) => {
      if (!attachmentResolver) throw new Error('Canonical attachment resolver has not been installed.');
      return attachmentResolver(input);
    }
  });
  const fs = createVsCodeFsCapability();
  const webview = createWebviewCapability();
  const skills = createSkillCatalogCapability(context);
  const rules = createRulesCatalogCapability(context);
  const toolRuntimeDefinitions = registry.list();
  const toolSchemas = schemasForTools(toolRuntimeDefinitions);
  const toolDefinitions = recordsForTools(toolRuntimeDefinitions);

  return {
    env: {
      llm,
      fs,
      command,
      backgroundProcesses,
      workEnvironment,
      webview,
      storage,
      get paths() { return storage.paths; },
      tools: { registry: toolRuntimeDefinitions },
      mcp,
      skills,
      rules
    },
    toolSchemas,
    toolDefinitions,
    installAttachmentResolver(resolver) {
      if (attachmentResolver) throw new Error('Canonical attachment resolver is already installed.');
      attachmentResolver = resolver;
    }
  };
}

export function schemasForTools(tools: readonly ToolDefinition[]): ToolSchema[] {
  return tools.map((tool) => ({
    name: tool.declaration.name,
    description: tool.declaration.description,
    parameters: tool.declaration.parameters
  }));
}

export function recordsForTools(tools: readonly ToolDefinition[]): ToolDefinitionRecord[] {
  return tools.map((tool) => toolDefinitionRecord(tool));
}

async function applyConversationModelOverride(
  storage: ReturnType<typeof createVsCodeStorageCapability>,
  conversationId: string | undefined,
  config: LlmProviderConfigRecord
): Promise<LlmProviderConfigRecord> {
  if (!conversationId) return config;
  const stored = await storage.loadConversationSettings(conversationId, 'llm');
  const settings = stored?.settings as ConversationLlmSettingsRecord | undefined;
  const model = settings?.modelOverrides?.[config.id]?.trim();
  if (!model || model === config.model || !modelExistsInConfig(config, model)) return config;
  return { ...config, model };
}

function applyModelSpecificConfig(config: LlmProviderConfigRecord): LlmProviderConfigRecord {
  const modelId = config.model.trim();
  const modelConfig = modelId ? config.modelConfigs.find((candidate) => candidate.modelId === modelId) : undefined;
  if (!modelConfig) return config;
  const next: LlmProviderConfigRecord = {
    ...config,
    toolCallFormat: modelConfig.toolCallFormat,
    openaiResponsesTransport: modelConfig.openaiResponsesTransport,
    stream: modelConfig.stream,
    retryOnError: modelConfig.retryOnError,
    retryMaxAttempts: modelConfig.retryMaxAttempts,
    enableMultimodalTools: modelConfig.enableMultimodalTools,
    contextWindowTokens: modelConfig.contextWindowTokens,
    promptCache: modelConfig.promptCache
  };

  if (modelConfig.headers) next.headers = modelConfig.headers;
  else delete next.headers;
  if (modelConfig.generationConfig) next.generationConfig = modelConfig.generationConfig;
  else delete next.generationConfig;
  if (modelConfig.requestBody) next.requestBody = modelConfig.requestBody;
  else delete next.requestBody;
  return next;
}

function modelExistsInConfig(config: LlmProviderConfigRecord, model: string): boolean {
  const id = model.trim();
  if (!id) return false;
  return config.model?.trim() === id || config.models.some((candidate) => candidate.id.trim() === id);
}

async function resolveSnapshotLlmProviderConfig(
  storage: ReturnType<typeof createVsCodeStorageCapability>,
  snapshot: LlmInvocationSettingsSnapshotRecord,
  conversationId: string | undefined
): Promise<LlmProviderConfigRecord> {
  const storedConfig = snapshot.providerConfigId ? await storage.loadLlmProviderConfigById(snapshot.providerConfigId) : undefined;
  const base = storedConfig ?? await storage.loadActiveLlmProviderConfig(conversationId);
  const modelId = snapshot.modelId ?? base.model;
  const modelName = snapshot.modelName ?? snapshot.displayModelName ?? modelId;
  const resolved: LlmProviderConfigRecord = {
    ...base,
    apiKey: storedConfig?.apiKey ?? (!snapshot.providerConfigId ? base.apiKey : ''),
    id: snapshot.providerConfigId ?? base.id,
    name: snapshot.providerConfigName ?? base.name,
    ...(snapshot.provider ? { provider: snapshot.provider } : {}),
    ...(snapshot.baseUrl ? { baseUrl: snapshot.baseUrl } : {}),
    model: modelId,
    models: modelId ? [{ id: modelId, name: modelName }, ...base.models.filter((model) => model.id !== modelId)] : base.models,
    ...(snapshot.toolCallFormat ? { toolCallFormat: snapshot.toolCallFormat } : {}),
    ...(snapshot.openaiResponsesTransport ? { openaiResponsesTransport: snapshot.openaiResponsesTransport } : {}),
    ...(snapshot.stream !== undefined ? { stream: snapshot.stream } : {}),
    ...(snapshot.retryOnError !== undefined ? { retryOnError: snapshot.retryOnError } : {}),
    ...(snapshot.retryMaxAttempts !== undefined ? { retryMaxAttempts: snapshot.retryMaxAttempts } : {}),
    ...(snapshot.enableMultimodalTools !== undefined ? { enableMultimodalTools: snapshot.enableMultimodalTools } : {})
  };

  if (snapshot.contextWindowTokens !== undefined) resolved.contextWindowTokens = snapshot.contextWindowTokens;
  else delete resolved.contextWindowTokens;
  if (snapshot.generationConfig !== undefined) resolved.generationConfig = snapshot.generationConfig;
  else delete resolved.generationConfig;
  if (snapshot.requestBody !== undefined) resolved.requestBody = snapshot.requestBody;
  else delete resolved.requestBody;
  if (snapshot.headers !== undefined) {
    const headers = storedConfig?.headers ?? (!snapshot.providerConfigId ? base.headers : undefined);
    if (headers) resolved.headers = headers;
    else delete resolved.headers;
  } else {
    delete resolved.headers;
  }
  return resolved;
}
