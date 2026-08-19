import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const require = createRequire(import.meta.url);
const { ReliableKernelWebviewFeedBridge } = require(path.join(
  root,
  'dist/extension/backend/reliableKernel/webviewFeedBridge.js'
));

test('Feed waits for Ready, stays disconnected while hidden, and creates one fresh session on reveal', async () => {
  const feed = fakeFeed();
  const posted = [];
  const bridge = new ReliableKernelWebviewFeedBridge(
    feed,
    { async read() { throw new Error('detail read is not expected'); } },
    (error) => { throw error; }
  );
  const clientId = bridge.attach(webview(posted), {
    kind: 'mainPanel',
    panelId: 'feed-lifecycle-panel',
    conversationId: 'conversation-one'
  });

  await tick();
  assert.equal(feed.connectCalls.length, 0);
  assert.equal(snapshots(posted).length, 0);

  bridge.setVisible(clientId, false);
  bridge.reconnect(clientId);
  await tick();
  assert.equal(feed.connectCalls.length, 0, 'Ready must not connect a hidden retained Webview');
  assert.equal(snapshots(posted).length, 0);

  bridge.setVisible(clientId, true);
  await eventually(() => feed.connectCalls.length === 1 && snapshots(posted).length === 1);
  const first = feed.connectCalls[0];
  assert.equal(first.activeConversationId, 'conversation-one');

  bridge.setVisible(clientId, false);
  await eventually(() => feed.disconnected.includes(first.sessionId));
  const hiddenPostCount = posted.length;
  first.onFailure(new Error('late failure from the retired session'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(feed.connectCalls.length, 1, 'a retired hidden session must not arm recovery');
  assert.equal(posted.length, hiddenPostCount, 'hidden Webviews must receive no Feed frames');

  bridge.setVisible(clientId, true);
  await eventually(() => feed.connectCalls.length === 2 && snapshots(posted).length === 2);
  const second = feed.connectCalls[1];
  assert.notEqual(second.sessionId, first.sessionId);

  bridge.detach(clientId);
  await eventually(() => feed.disconnected.includes(second.sessionId));
  bridge.close();
});

test('stale visible renderer gets one exact resend, then Feed waits for a new Ready generation', async () => {
  const feed = fakeFeed();
  const posted = [];
  const errors = [];
  const bridge = new ReliableKernelWebviewFeedBridge(
    feed,
    { async read() { throw new Error('detail read is not expected'); } },
    (error) => errors.push(error),
    undefined,
    undefined,
    undefined,
    { ackTimeoutMs: 20, maxFrameResends: 1 }
  );
  const clientId = bridge.attach(webview(posted), {
    kind: 'mainPanel',
    panelId: 'stale-renderer-panel',
    conversationId: 'conversation-stale'
  });

  bridge.reconnect(clientId);
  await eventually(() => snapshots(posted).length === 2);
  const firstTwo = snapshots(posted).slice(0, 2);
  assert.equal(feed.connectCalls.length, 1, 'an ACK retry must not create a new Feed session');
  assert.deepEqual(
    firstTwo.map((message) => [message.sessionId, message.messageSeq]),
    [['session-1', '1'], ['session-1', '1']],
    'the retry must resend the exact same durable frame identity'
  );

  await eventually(() => feed.disconnected.includes('session-1'));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(feed.connectCalls.length, 1, 'a zombie renderer must remain suspended after retry exhaustion');
  assert.equal(snapshots(posted).length, 2);
  assert.ok(errors.length >= 2, 'both missed ACK windows should be observable');

  bridge.reconnect(clientId);
  await eventually(() => feed.connectCalls.length === 2 && snapshots(posted).length === 3);
  assert.equal(snapshots(posted)[2].sessionId, 'session-2');

  bridge.detach(clientId);
  await eventually(() => feed.disconnected.includes('session-2'));
  bridge.close();
});

test('tool_call_delta immediately flushes earlier transient output in stream order', async () => {
  const feed = fakeFeed();
  const posted = [];
  const bridge = new ReliableKernelWebviewFeedBridge(
    feed,
    { async read() { throw new Error('detail read is not expected'); } },
    (error) => { throw error; }
  );
  const clientId = bridge.attach(webview(posted), {
    kind: 'mainPanel',
    panelId: 'tool-preview-panel',
    conversationId: 'conversation-tool-preview'
  });
  bridge.reconnect(clientId);
  await eventually(() => snapshots(posted).length === 1);

  const transient = (streamSeq, content) => ({
    conversationId: 'conversation-tool-preview',
    turnId: 'turn-tool-preview',
    modelRequestId: 'request-tool-preview',
    requestSeq: '1',
    providerId: 'provider-tool-preview',
    modelId: 'model-tool-preview',
    attemptSeq: '1',
    socketGeneration: '1',
    afterCommitSeq: '0',
    observedAt: '2026-08-19T00:00:00.000Z',
    event: { kind: 'output_delta', streamSeq, content }
  });

  bridge.broadcastTransient(transient('1', { type: 'thought_delta', text: '先分析' }));
  await Promise.resolve();
  assert.equal(transientPosts(posted).length, 0, 'ordinary output still waits for the existing batch window');

  bridge.broadcastTransient(transient('2', {
    type: 'tool_call_delta',
    callId: 'call-tool-preview',
    name: 'write',
    argumentsDelta: '{"path":',
    replace: false
  }));
  await Promise.resolve();

  const [batch] = transientPosts(posted);
  assert.equal(batch?.type, 'reliable-kernel.transient-batch');
  assert.deepEqual(batch.events.map((entry) => entry.event.streamSeq), ['1', '2']);
  assert.deepEqual(batch.events.map((entry) => entry.event.content.type), [
    'thought_delta',
    'tool_call_delta'
  ]);

  bridge.close();
});

function fakeFeed() {
  let sequence = 0;
  const connectCalls = [];
  const disconnected = [];
  return {
    connectCalls,
    disconnected,
    async connect(options) {
      sequence += 1;
      const sessionId = `session-${sequence}`;
      const call = { ...options, sessionId };
      connectCalls.push(call);
      options.send({
        type: 'reliable-kernel.snapshot',
        sessionId,
        hostBootId: 'host-boot',
        messageSeq: '1',
        snapshotCommitSeq: '0',
        records: {},
        projections: {},
        projectionSpec: {}
      });
      return { sessionId, hostBootId: 'host-boot' };
    },
    disconnect(sessionId) {
      disconnected.push(sessionId);
    },
    acknowledge() {},
    requestSnapshot() {}
  };
}

function webview(posted) {
  return {
    async postMessage(message) {
      posted.push(message);
      return true;
    }
  };
}

function snapshots(posted) {
  return posted.filter((message) => message.type === 'reliable-kernel.snapshot');
}

function transientPosts(posted) {
  return posted.filter((message) =>
    message.type === 'reliable-kernel.transient'
    || message.type === 'reliable-kernel.transient-batch'
  );
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function eventually(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for Feed lifecycle transition');
}
