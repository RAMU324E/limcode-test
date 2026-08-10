const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const root = process.cwd();

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function loadProjection() {
  const absolute = path.join(root, 'webview/src/domain/reliableAgentStatusProjection.ts');
  const output = ts.transpileModule(source('webview/src/domain/reliableAgentStatusProjection.ts'), {
    fileName: absolute,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const loaded = { exports: {} };
  Function('require', 'module', 'exports', `${output}\n//# sourceURL=${absolute}`)(require, loaded, loaded.exports);
  return loaded.exports;
}

const { projectReliableAgentStatus } = loadProjection();

test('Agent status separates current child activity from the original task', () => {
  const projection = projectReliableAgentStatus({
    conversationId: 'parent-conversation',
    agentNames: new Map([
      ['parent-agent', 'Main'],
      ['child-agent', 'Worker']
    ]),
    records: {
      Turn: {
        parent: { id: 'parent-turn', conversation_id: 'parent-conversation', status: 'active' }
      },
      AgentConversationLink: {
        parent: { id: 'parent-agent-link', conversation_id: 'parent-conversation', agent_id: 'parent-agent', role: 'default' },
        child: { id: 'child-agent-link', conversation_id: 'child-conversation', agent_id: 'child-agent', role: 'default' }
      },
      ChildExecution: {
        child: { id: 'child-execution', child_conversation_id: 'child-conversation', status: 'active' }
      },
      ChildExecutionParentLink: {
        child: {
          id: 'child-parent-link',
          child_execution_id: 'child-execution',
          parent_turn_id: 'parent-turn',
          source_tool_call_id: 'run-agent-tool'
        }
      },
      ChildExecutionActivity: {
        child: {
          id: 'child-execution',
          child_execution_id: 'child-execution',
          kind: 'tool',
          summary: '正在运行命令 · npm test'
        }
      }
    }
  });

  assert.equal(projection.currentAgentName, 'Main');
  assert.equal(projection.children.length, 1);
  assert.equal(projection.children[0].agentName, 'Worker');
  assert.equal(projection.children[0].activitySummary, '正在运行命令 · npm test');
  assert.equal(projection.children[0].interruptible, true);
  assert.equal(projection.children[0].group, 'executing');
});

test('interrupted and permanently terminal children do not expose a stop action', () => {
  const projection = projectReliableAgentStatus({
    conversationId: 'parent-conversation',
    agentNames: new Map(),
    records: {
      Turn: { parent: { id: 'parent-turn', conversation_id: 'parent-conversation' } },
      ChildExecution: {
        interrupted: { id: 'child-interrupted', child_conversation_id: 'child-a', status: 'interrupted' },
        closed: { id: 'child-closed', child_conversation_id: 'child-b', status: 'closed' }
      },
      ChildExecutionParentLink: {
        interrupted: { id: 'link-a', child_execution_id: 'child-interrupted', parent_turn_id: 'parent-turn', source_tool_call_id: 'tool-a' },
        closed: { id: 'link-b', child_execution_id: 'child-closed', parent_turn_id: 'parent-turn', source_tool_call_id: 'tool-b' }
      }
    }
  });
  assert.deepEqual(projection.children.map((child) => child.interruptible), [false, false]);
});

test('UI and product routes bind recursive stop to child-isolated activity facts', () => {
  const panel = source('webview/src/components/input/ReliableAgentStatusPanel.vue');
  const worker = source('backend/reliableKernel/databaseWorker.ts');
  const router = source('backend/application/reliableKernel/VscodeReliableKernelCommandRouter.ts');
  const facade = source('backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.ts');
  const sidebar = source('webview/src/sidebar/SidebarApp.vue');
  assert.match(panel, /BridgeMessageType\.ToolExecutionCancel/);
  assert.match(panel, /终止该 Agent 及其启动的所有子 Agent/);
  assert.match(panel, /child\.activitySummary/);
  assert.match(worker, /Child ToolCall\/ModelRequest rows stay isolated/);
  assert.match(worker, /capture_child_activity_from_/);
  assert.match(router, /product\.childAgents\.interruptSubtree/);
  assert.match(facade, /sidebar-child-interrupt/);
  assert.match(sidebar, /终止此子 Agent 及其启动的所有子 Agent/);
});

test('parent feed receives a bounded child activity change without child ToolCall leakage', async () => {
  const kernel = require(path.join(root, 'dist/extension/backend/reliableKernel/index.js'));
  const parent = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'limcode-child-activity-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const app = await kernel.ReliableKernelApplication.open(authority, runtimeDependencies());
  try {
    const conversationId = 'child-activity-parent';
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId,
        title: 'Child activity parent',
        status: 'active',
        created_at: now,
        updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: 'child-activity-parent-agent-link',
        conversation_id: conversationId,
        agent_id: 'agent-main',
        role: 'default',
        created_at: now,
        updated_at: now
      })
    ]);
    const parentTurn = await app.turns.input({
      source: { kind: 'command', key: 'child-activity-parent-input' },
      conversationId,
      leaseOwnerId: 'child-activity-parent-owner',
      hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      content: 'delegate work'
    });
    await app.runtime.effects.createToolCall({
      source: { kind: 'internal', key: 'child-activity-run-agent-call' },
      toolCallId: 'child-activity-run-agent-call',
      turnId: parentTurn.turnId,
      toolName: 'run_agent',
      arguments: { prompt: 'inspect the workspace' }
    });
    const child = await app.runtime.children.spawn({
      sourceToolCallId: 'child-activity-run-agent-call',
      childAgentId: 'agent-child',
      prompt: 'inspect the workspace',
      completionPolicy: 'wait_for_answer',
      waitDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
      leaseOwnerId: `child-driver:${app.database.hostBootId}`,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString()
    });

    const posted = [];
    const connection = await app.runtime.clientFeed.connect({
      activeConversationId: conversationId,
      send(message) { posted.push(message); }
    });
    const snapshot = posted[0];
    assert.equal(snapshot.type, 'reliable-kernel.snapshot');
    assert.equal(
      snapshot.projections.subagentDeliverySummary.childExecutionActivities[0]?.child_execution_id,
      child.childExecutionId
    );
    app.runtime.clientFeed.acknowledge({
      sessionId: connection.sessionId,
      hostBootId: connection.hostBootId,
      messageSeq: snapshot.messageSeq
    });

    await app.runtime.effects.createToolCall({
      source: { kind: 'internal', key: 'child-activity-shell-call' },
      toolCallId: 'child-activity-shell-call',
      turnId: child.childTurnId,
      toolName: 'shell',
      arguments: { command: 'npm test -- --runInBand' }
    });
    await new Promise((resolve) => setImmediate(resolve));
    const update = posted.at(-1);
    assert.equal(update.type, 'reliable-kernel.changes');
    assert.equal(update.changes.some((change) => change.type === 'ToolCall'), false);
    const activity = update.changes.find((change) => change.type === 'ChildExecutionActivity');
    assert.equal(activity?.record?.child_execution_id, child.childExecutionId);
    assert.equal(activity?.record?.kind, 'tool');
    assert.match(activity?.record?.summary ?? '', /等待运行命令.*npm test -- --runInBand/);
  } finally {
    await app.close();
    await fsPromises.rm(parent, { recursive: true, force: true });
  }
});

function runtimeDependencies() {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: {
            content: JSON.stringify({ providerConfigId: 'provider-local', modelId: 'model-local' })
          },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              executorAgentId: request.executorAgentId,
              modelProfile: {
                compressionThresholdTokens: 100000,
                contextWindowTokens: 128000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              model: { providerConfigId: 'provider-local', modelId: 'model-local' },
              policies: { toolPolicyId: 'tools-default', systemPromptId: 'prompt-default' }
            })
          }
        };
      }
    },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: {
      async toolAnnotations() { return {}; },
      async callTool() { return null; }
    },
    mcpPolicyGate: {
      async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; }
    },
    attachmentSettings: {
      async loadGlobalSettings() {
        return {
          section: 'attachments',
          settings: { maxStoredInlineFileMb: 25 },
          filePath: 'settings/attachments.json'
        };
      }
    },
    providers: {
      resolve(providerId) {
        return {
          providerId,
          async sendFullRequest() { throw new Error('fixture provider was not configured'); }
        };
      }
    },
    toolDispatcher: {
      definitions() { return []; },
      async dispatch() { throw new Error('fixture tool dispatcher was not configured'); }
    }
  };
}
