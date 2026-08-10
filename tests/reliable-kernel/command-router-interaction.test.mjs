import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after } from 'node:test';

const root = process.cwd();
const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return { window: { async showWarningMessage() {} } };
  return originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const protocol = require(path.join(root, 'dist/extension/shared/protocol.js'));
const { VscodeReliableKernelCommandRouter } = require(path.join(
  root,
  'dist/extension/backend/application/reliableKernel/VscodeReliableKernelCommandRouter.js'
));

test('stale Turn interrupt is idempotently reported as already_terminal', async () => {
  const posted = [];
  const router = new VscodeReliableKernelCommandRouter({
    toolHost: { setStateChangeListener() {} }
  });
  router.maybeRow = async (domain, id) => {
    assert.equal(domain, 'Turn');
    assert.equal(id, 'turn-deleted');
    return undefined;
  };

  await router.dispatch('stale-turn-client', webview(posted), {
    id: 'interrupt-stale-turn',
    type: protocol.BridgeMessageType.TurnInterrupt,
    channel: 'command',
    payload: {
      conversationId: 'conversation-deleted',
      command: { commandId: 'interrupt-stale-turn' },
      turnId: 'turn-deleted',
      leaseEpoch: 0,
      cascadeChildAgents: true
    }
  });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, protocol.BridgeMessageType.TurnInterruptResult);
  assert.equal(posted[0].payload.status, 'already_terminal');
  assert.equal(posted[0].payload.cascadeChildAgents, true);
});

test('stale Conversation settings request returns scoped error without throwing', async () => {
  const posted = [];
  const router = new VscodeReliableKernelCommandRouter({
    toolHost: { setStateChangeListener() {} }
  });
  router.readConversationSettings = async () => undefined;

  await router.dispatch('stale-conversation-client', webview(posted), {
    id: 'get-stale-conversation-settings',
    type: protocol.BridgeMessageType.ConversationSettingsGet,
    channel: 'command',
    payload: { conversationId: 'conversation-deleted', section: 'common' }
  });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, protocol.BridgeMessageType.Error);
  assert.equal(posted[0].payload.code, 'stale_conversation');
  assert.equal(posted[0].payload.conversationId, 'conversation-deleted');
});

test('failed global settings read preserves section scope for Webview loading state', async () => {
  const posted = [];
  const router = new VscodeReliableKernelCommandRouter({
    toolHost: { setStateChangeListener() {} },
    configuration: {
      async loadGlobalSettings(section) {
        assert.equal(section, 'llmCompressionConfigs');
        throw new TypeError('Compression trigger uses removed fields.');
      }
    }
  });

  router.handle('settings-client', webview(posted), {
    id: 'get-invalid-compression-settings',
    type: protocol.BridgeMessageType.GlobalSettingsGet,
    channel: 'command',
    payload: { section: 'llmCompressionConfigs' }
  });

  await eventually(() => posted.length === 1);
  assert.equal(posted[0].type, protocol.BridgeMessageType.Error);
  assert.deepEqual(posted[0].scope, {
    kind: 'settings',
    level: 'global',
    id: 'llmCompressionConfigs'
  });
  assert.equal(posted[0].payload.requestType, protocol.BridgeMessageType.GlobalSettingsGet);
});


test('durable Interaction result is posted before a stalled Agent resume completes', async () => {
  const posted = [];
  const resume = deferred();
  const resumedConversations = [];
  const product = {
    toolHost: { setStateChangeListener() {} },
    application: {
      interactions: {
        async resolvePlanReview(input) {
          assert.equal(input.source.key, 'interaction:interaction-request:accept:fixed-interaction-command');
          return { won: true };
        }
      }
    },
    childAgents: {
      async resume(turnId) {
        assert.equal(turnId, 'owner-turn');
        return resume.promise;
      }
    },
    conversations: {
      resume(conversationId, turnId) {
        resumedConversations.push({ conversationId, turnId });
      }
    }
  };
  const router = new VscodeReliableKernelCommandRouter(product);
  router.requireRow = async (domain, id) => {
    assert.equal(domain, 'InteractionRequest');
    assert.equal(id, 'interaction-request');
    return { id, request_kind: 'plan_review', status: 'pending' };
  };
  router.list = async (domain, where, limit) => {
    assert.deepEqual(where, { request_id: 'interaction-request' });
    assert.equal(limit, 2);
    if (domain === 'InteractionOwnerLink') return [{ request_id: 'interaction-request', turn_id: 'owner-turn' }];
    if (domain === 'InteractionToolCallLink') return [{ request_id: 'interaction-request', tool_call_id: 'plan-tool' }];
    throw new Error(`Unexpected list domain ${domain}`);
  };

  await router.dispatch('interaction-client', webview(posted), {
    id: 'fixed-interaction-command',
    type: protocol.BridgeMessageType.InteractionResolve,
    channel: 'command',
    payload: {
      conversationId: 'conversation-one',
      interactionRequestId: 'interaction-request',
      interactionRevision: 1,
      ownerTurnId: 'owner-turn',
      decision: 'accept',
      response: { planProposalId: 'plan-proposal', executionTarget: 'current_conversation' }
    }
  });

  assert.equal(posted.length, 1, 'the direct durable receipt must not await resume');
  assert.equal(posted[0].type, protocol.BridgeMessageType.InteractionResult);
  assert.equal(posted[0].correlationId, 'fixed-interaction-command');
  assert.deepEqual(posted[0].payload, {
    requestType: 'plan_review',
    conversationId: 'conversation-one',
    targetId: 'interaction-request',
    status: 'committed'
  });
  assert.deepEqual(resumedConversations, []);

  resume.resolve(false);
  await eventually(() => resumedConversations.length === 1);
  assert.deepEqual(resumedConversations, [{ conversationId: 'conversation-one', turnId: 'owner-turn' }]);
});

function webview(posted) {
  return {
    async postMessage(message) {
      posted.push(message);
      return true;
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for Interaction resume');
}
