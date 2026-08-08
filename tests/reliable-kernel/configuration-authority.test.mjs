import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const vscode = createVscodeStub();
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const { createVscodeStoragePaths } = require('../../dist/extension/backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = require('../../dist/extension/backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { VscodeConfigurationAuthority } = require('../../dist/extension/backend/reliableKernel/vscodeConfigurationAuthority.js');
const { resolveToolPolicyLayers } = require('../../dist/extension/shared/toolPolicyResolution.js');
const { workEnvironmentIdFromUri } = require('../../dist/extension/shared/workEnvironmentCatalog.js');

async function saveLatestGlobalSettings(authority, section, settings) {
  const current = await authority.loadGlobalSettings(section);
  return authority.saveGlobalSettings(section, settings, current.revision);
}

test('ToolPolicy 层按能力上界收窄、深合并配置，并保持来源 deny 单调', () => {
  const resolved = resolveToolPolicyLayers([
    {
      scopeKind: 'global',
      policy: {
        id: 'global-policy',
        allowedTools: ['read', 'write', 'bash'],
        preset: 'yolo',
        toolConfigs: {
          bash: {
            config: { limits: { lines: 20, chars: 1000 }, cwd: 'global' },
            autoApproveExecution: false,
            display: { autoExpand: false, autoOpenDiffPreview: true }
          }
        },
        sourceConfigs: {
          exa: { enabled: false, disabledTools: ['exa_global_denied'] }
        }
      }
    },
    {
      scopeKind: 'agent',
      policy: {
        id: 'agent-policy',
        allowedTools: ['read', 'bash', 'skills'],
        preset: 'inherit',
        toolConfigs: {
          bash: {
            config: { limits: { chars: 500 }, cwd: 'agent' },
            autoApproveExecution: true,
            display: { autoExpand: true }
          }
        },
        sourceConfigs: {
          exa: { enabled: true, disabledTools: ['exa_agent_denied'] }
        }
      }
    },
    {
      scopeKind: 'workflow',
      policy: {
        id: 'workflow-policy',
        allowedTools: ['bash'],
        preset: 'inherit'
      }
    }
  ], ['read', 'write', 'bash', 'skills', 'delete']);

  assert.equal(resolved.id, 'workflow-policy');
  assert.equal(resolved.preset, 'yolo');
  assert.deepEqual(resolved.allowedTools, ['bash']);
  assert.deepEqual(resolved.toolConfigs.bash, {
    config: { limits: { lines: 20, chars: 500 }, cwd: 'agent' },
    autoApproveExecution: true,
    display: { autoExpand: true, autoOpenDiffPreview: true }
  });
  assert.deepEqual(resolved.sourceConfigs.exa, {
    enabled: false,
    disabledTools: ['exa_agent_denied', 'exa_global_denied']
  });
});

test('VscodeConfigurationAuthority 独立持久化配置记录/Link，并按 Run→Conversation→Workflow→Agent→Global 冻结 authority', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-configuration-authority-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const authority = new VscodeConfigurationAuthority(() => paths);
    const provider = {
      ...createDefaultLlmProviderConfig({ name: '测试 Provider' }),
      id: 'provider:test',
      model: 'model:test',
      models: [{ id: 'model:test', name: '测试模型' }],
      systemPromptPrefix: '渠道默认前置要求',
      modelConfigs: [{
        id: 'model-config:test',
        modelId: 'model:test',
        toolCallFormat: 'function-call',
        openaiResponsesTransport: 'http',
        stream: true,
        retryOnError: true,
        retryMaxAttempts: 3,
        enableMultimodalTools: true,
        contextWindowTokens: 180_000,
        systemPromptPrefix: '模型专属前置要求',
        createdAt: 1,
        updatedAt: 1
      }]
    };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [provider] });
    await saveLatestGlobalSettings(authority, 'llm', { activeProviderConfigId: provider.id });

    const folderPath = path.join(root, 'workspace');
    await fs.mkdir(folderPath, { recursive: true });
    const folderUri = vscode.Uri.file(folderPath).toString();
    await authority.synchronizeWorkspaceFolders([{ uri: folderUri, name: 'Workspace', rootPath: folderPath, index: 0 }]);
    const workEnvironmentId = workEnvironmentIdFromUri(folderUri);

    const agent = await authority.mutations.createAgent({ name: '配置 Agent', kind: 'custom' });
    const workflow = await authority.mutations.createWorkflow({ name: '可靠 Workflow' });
    await authority.mutations.selectConversationWorkflow({
      conversationId: 'conversation:test',
      scopeKind: 'workflow',
      workflowId: workflow.id
    });
    await authority.mutations.setModelProfile({
      scopeKind: 'conversation',
      scopeId: 'conversation:test',
      name: '对话模型',
      providerConfigId: provider.id,
      provider: provider.provider,
      model: 'model:test'
    });
    await authority.mutations.setToolPolicy({
      scopeKind: 'global',
      name: '全局工具',
      allowedTools: ['read'],
      sourceConfigs: {
        'mcp-exa': { enabled: true, disabledTools: ['exa_hidden'] }
      }
    });
    await authority.mutations.setToolPolicy({
      scopeKind: 'workflow',
      scopeId: workflow.id,
      name: 'Workflow 工具',
      allowedTools: ['read', 'skills']
    });
    await authority.mutations.setPlanReviewPolicy({
      scopeKind: 'workflow',
      scopeId: workflow.id,
      mode: 'before_mutation',
      allowReadonlyBeforeApproval: true,
      requireForToolRiskLevels: ['write']
    });
    await authority.mutations.setSystemPrompt({ scopeKind: 'global', name: '全局规则', text: 'GLOBAL' });
    await authority.mutations.setSystemPrompt({ scopeKind: 'agent', scopeId: agent.id, name: 'Agent 规则', text: 'AGENT' });
    await authority.mutations.setSystemPrompt({ scopeKind: 'workflow', scopeId: workflow.id, name: '工作流规则', text: 'WORKFLOW' });
    await authority.mutations.setSystemPrompt({ scopeKind: 'conversation', scopeId: 'conversation:test', name: '对话规则', text: 'CONVERSATION' });
    await authority.mutations.setRuntimeContext({
      scopeKind: 'conversation',
      scopeId: 'conversation:test',
      template: 'RUNTIME-CONTEXT'
    });
    await authority.mutations.setWorkEnvironmentPolicy({
      scopeKind: 'conversation',
      scopeId: 'conversation:test',
      enabled: true,
      allowedWorkEnvironmentIds: [workEnvironmentId],
      defaultWorkEnvironmentId: workEnvironmentId
    });
    await authority.mutations.selectConversationWorkEnvironment('conversation:test', workEnvironmentId);

    const snapshot = await authority.configurationClientState();
    assert.equal(snapshot.agents.some((record) => record.id === agent.id), true);
    assert.equal(snapshot.workflows.some((record) => record.id === workflow.id), true);
    assert.equal(snapshot.workflows.some((record) => record.id === 'builtin:plan'), true);
    assert.equal(snapshot.conversationWorkflowSelections.length, 1);
    assert.equal(snapshot.conversationWorkEnvironmentLinks.length, 1);
    assert.equal(snapshot.workEnvironments.find((record) => record.id === workEnvironmentId)?.available, true);

    const compiled = await authority.compile({
      conversationId: 'conversation:test',
      turnId: 'turn:test',
      executorAgentId: agent.id,
      intentKind: 'input'
    });
    const frozen = JSON.parse(compiled.authoritySnapshot.content);
    assert.equal(frozen.model.providerConfigId, provider.id);
    assert.equal(frozen.model.modelId, 'model:test');
    assert.equal(frozen.model.systemPromptPrefix, '模型专属前置要求');
    assert.deepEqual(frozen.toolPolicy.allowedTools, ['read']);
    assert.deepEqual(frozen.toolPolicy.sourceConfigs, {
      'mcp-exa': { enabled: true, disabledTools: ['exa_hidden'] }
    });
    assert.equal(frozen.planReviewPolicy.mode, 'before_mutation');
    assert.deepEqual(frozen.planReviewPolicy.requireForToolRiskLevels, ['write']);
    assert.equal(
      frozen.systemPrompt.text,
      '[全局规则]\nGLOBAL\n\n[Agent 规则]\nAGENT\n\n[工作流规则]\nWORKFLOW\n\n[对话规则]\nCONVERSATION'
    );
    assert.equal(frozen.runtimeContext.template, 'RUNTIME-CONTEXT');
    assert.equal(frozen.workEnvironmentPolicy.enabled, true);
    assert.deepEqual(frozen.workEnvironmentPolicy.allowedWorkEnvironmentIds, [workEnvironmentId]);
    assert.equal(frozen.workEnvironmentPolicy.defaultWorkEnvironmentId, workEnvironmentId);

    const changedProvider = {
      ...provider,
      modelConfigs: provider.modelConfigs.map((modelConfig) => ({
        ...modelConfig,
        systemPromptPrefix: '后来修改的模型要求',
        updatedAt: 2
      }))
    };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [changedProvider] });
    const afterSettingsChange = JSON.parse((await authority.compile({
      conversationId: 'conversation:test',
      turnId: 'turn:after-settings-change',
      executorAgentId: agent.id,
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.equal(frozen.model.systemPromptPrefix, '模型专属前置要求');
    assert.equal(afterSettingsChange.model.systemPromptPrefix, '后来修改的模型要求');

    await authority.mutations.clearToolPolicy('workflow', workflow.id);
    const inherited = JSON.parse((await authority.compile({
      conversationId: 'conversation:test',
      turnId: 'turn:inherited',
      executorAgentId: agent.id,
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.deepEqual(inherited.toolPolicy.allowedTools, ['read']);
    assert.deepEqual(inherited.toolPolicy.sourceConfigs, {
      'mcp-exa': { enabled: true, disabledTools: ['exa_hidden'] }
    });

    await authority.mutations.deleteWorkflow(workflow.id);
    const afterDelete = await authority.configurationClientState();
    assert.equal(afterDelete.workflows.some((record) => record.id === workflow.id), false);
    assert.equal(afterDelete.conversationWorkflowSelections.length, 0);
    assert.equal(afterDelete.systemPromptScopeLinks.some((link) => link.scopeKind === 'workflow' && link.scopeId === workflow.id), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('VscodeConfigurationAuthority 让 Agent 缺省 preset 继承全局 YOLO，同时保留能力上界与逐工具配置', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-configuration-yolo-inherit-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const authority = new VscodeConfigurationAuthority(() => paths);
    const provider = {
      ...createDefaultLlmProviderConfig({ name: 'YOLO Provider' }),
      id: 'provider:yolo',
      model: 'model:yolo',
      models: [{ id: 'model:yolo', name: 'YOLO 模型' }],
      modelConfigs: []
    };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [provider] });
    await saveLatestGlobalSettings(authority, 'llm', { activeProviderConfigId: provider.id });
    await authority.mutations.setToolPolicy({
      scopeKind: 'global',
      name: '全局 YOLO',
      preset: 'yolo',
      allowedTools: ['read', 'write', 'edit', 'delete', 'bash', 'skills'],
      toolConfigs: {
        write: { config: {}, autoApproveExecution: true, autoApplyChange: true },
        edit: { config: {}, autoApproveExecution: true, autoApplyChange: true },
        delete: { config: {}, autoApproveExecution: true, autoApplyChange: true },
        bash: {
          config: { limits: { lines: 40, chars: 2000 }, cwd: 'global' },
          display: { autoExpand: false }
        }
      },
      sourceConfigs: { exa: { enabled: true, disabledTools: ['exa_global_denied'] } }
    });
    await authority.mutations.setToolPolicy({
      scopeKind: 'agent',
      scopeId: 'main',
      name: 'Main 上界',
      allowedTools: ['read', 'write', 'edit', 'delete', 'bash'],
      toolConfigs: {
        bash: {
          config: { limits: { chars: 500 }, cwd: 'agent' },
          display: { autoExpand: true }
        }
      },
      sourceConfigs: { exa: { enabled: true, disabledTools: ['exa_agent_denied'] } }
    });

    const frozen = JSON.parse((await authority.compile({
      conversationId: 'conversation:yolo',
      turnId: 'turn:yolo',
      executorAgentId: 'main',
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.equal(frozen.toolPolicy.preset, 'yolo');
    assert.deepEqual(frozen.toolPolicy.allowedTools, ['bash', 'delete', 'edit', 'read', 'write']);
    assert.equal(frozen.toolPolicy.toolConfigs.write.autoApproveExecution, true);
    assert.equal(frozen.toolPolicy.toolConfigs.edit.autoApplyChange, true);
    assert.equal(frozen.toolPolicy.toolConfigs.delete.autoApplyChange, true);
    assert.deepEqual(frozen.toolPolicy.toolConfigs.bash, {
      config: { limits: { lines: 40, chars: 500 }, cwd: 'agent' },
      display: { autoExpand: true }
    });
    assert.deepEqual(frozen.toolPolicy.sourceConfigs.exa, {
      enabled: true,
      disabledTools: ['exa_agent_denied', 'exa_global_denied']
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Workspace同步修复悬空WorkEnvironmentPolicy默认项并保留disabled本地边界模式', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-work-environment-rebind-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const authority = new VscodeConfigurationAuthority(() => paths);
    const firstPath = path.join(root, 'workspace-first');
    const secondPath = path.join(root, 'workspace-second');
    await fs.mkdir(firstPath, { recursive: true });
    await fs.mkdir(secondPath, { recursive: true });
    const firstUri = vscode.Uri.file(firstPath).toString();
    const secondUri = vscode.Uri.file(secondPath).toString();
    const firstId = workEnvironmentIdFromUri(firstUri);
    const secondId = workEnvironmentIdFromUri(secondUri);

    await authority.synchronizeWorkspaceFolders([{ uri: firstUri, name: 'First', rootPath: firstPath, index: 0 }]);
    await authority.mutations.setWorkEnvironmentPolicy({
      scopeKind: 'global',
      enabled: false,
      allowedWorkEnvironmentIds: [firstId],
      defaultWorkEnvironmentId: firstId
    });
    await authority.synchronizeWorkspaceFolders([{ uri: secondUri, name: 'Second', rootPath: secondPath, index: 0 }]);

    const snapshot = await authority.configurationClientState();
    const policy = snapshot.workEnvironmentPolicies.find((record) => record.id === 'work-environment-policy:global:global');
    assert.ok(policy);
    assert.equal(policy.enabled, false);
    assert.equal(policy.allowedWorkEnvironmentIds.includes(firstId), true);
    assert.equal(policy.allowedWorkEnvironmentIds.includes(secondId), true);
    assert.equal(policy.defaultWorkEnvironmentId, secondId);
    assert.equal(snapshot.workEnvironments.find((record) => record.id === firstId)?.available, false);
    assert.equal(snapshot.workEnvironments.find((record) => record.id === secondId)?.available, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function createVscodeStub() {
  const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
  class Uri {
    constructor(fsPath) {
      this.scheme = 'file';
      this.fsPath = path.resolve(fsPath);
      this.path = this.fsPath.split(path.sep).join('/');
    }
    static file(filePath) { return new Uri(filePath); }
    static joinPath(base, ...segments) { return new Uri(path.join(base.fsPath, ...segments)); }
    toString() { return `file://${this.path}`; }
  }
  return {
    Uri,
    FileType,
    workspace: {
      fs: {
        async createDirectory(uri) { await fs.mkdir(uri.fsPath, { recursive: true }); },
        async readFile(uri) { return fs.readFile(uri.fsPath); },
        async writeFile(uri, bytes) {
          await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fs.writeFile(uri.fsPath, bytes);
        },
        async readDirectory(uri) {
          const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
          return entries.map((entry) => [
            entry.name,
            entry.isDirectory() ? FileType.Directory : entry.isFile() ? FileType.File : FileType.Unknown
          ]);
        },
        async delete(uri) { await fs.rm(uri.fsPath, { recursive: true, force: true }); },
        async stat(uri) {
          const stat = await fs.stat(uri.fsPath);
          return {
            type: stat.isDirectory() ? FileType.Directory : FileType.File,
            ctime: stat.ctimeMs,
            mtime: stat.mtimeMs,
            size: stat.size
          };
        }
      }
    }
  };
}
