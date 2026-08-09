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
