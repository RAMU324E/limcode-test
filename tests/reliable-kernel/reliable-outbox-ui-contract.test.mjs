import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = process.cwd();
const kernel = require(path.join(root, 'dist/extension/backend/reliableKernel/index.js'));
const client = require(path.join(root, 'dist/extension/shared/reliableKernelClientFeed.js'));

test('outbox 的持久命令回执与会话变更原子可见，宿主重开后仍按会话隔离', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-outbox-feed-'));
  let database;
  let feed;
  t.after(async () => {
    feed?.close();
    try {
      await database?.close();
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
  const candidate = await kernel.resetCandidateRuntimeRoot(parent);
  database = await kernel.RuntimeDatabase.open(candidate.authority);
  const at = '2026-09-11T00:00:00.000Z';
  await database.transaction(['conversation-a', 'conversation-b'].map((id) =>
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
      id, title: id, status: 'active', created_at: at, updated_at: at
    })
  ));

  const frames = [];
  let state = client.createEmptyReliableKernelClientState();
  const consume = () => {
    const frame = frames.shift();
    const applied = client.applyReliableKernelDataMessage(state, frame);
    assert.equal(applied.snapshotRequired, false, applied.reason);
    state = applied.state;
    if (applied.ack) feed.acknowledge(applied.ack);
    return frame;
  };
  const assertVisibleReceipt = () => {
    const receipts = Object.values(state.records.ConversationCommandReceipt ?? {});
    assert.deepEqual(receipts.map((receipt) => receipt.command_id), ['outbox-command-a']);
    assert.equal(receipts[0].conversation_id, 'conversation-a');
    assert.equal(state.records.Conversation['conversation-a'].title, 'committed with receipt');
  };

  feed = new kernel.BoundedClientFeed(database);
  await feed.connect({ activeConversationId: 'conversation-a', send(frame) { frames.push(frame); } });
  consume();
  await database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').update('conversation-a', {
      title: 'committed with receipt', updated_at: at
    }),
    kernel.DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
      id: 'receipt-a', source_kind: 'command', source_key: 'outbox-command-a',
      conversation_id: 'conversation-a', turn_id: null, created_at: at
    }),
    kernel.DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
      id: 'receipt-b', source_kind: 'command', source_key: 'other-conversation-command',
      conversation_id: 'conversation-b', turn_id: null, created_at: at
    }),
    kernel.DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
      id: 'receipt-internal', source_kind: 'internal', source_key: 'internal-command',
      conversation_id: 'conversation-a', turn_id: null, created_at: at
    })
  ]);
  assert.equal(consume().type, 'reliable-kernel.changes');
  assertVisibleReceipt();
  assert.equal(frames.length, 0, 'one committed change must not expose a partial follow-up frame');

  feed.close();
  await database.close();
  database = await kernel.RuntimeDatabase.open(candidate.authority);
  feed = new kernel.BoundedClientFeed(database);
  state = client.createEmptyReliableKernelClientState();
  await feed.connect({ activeConversationId: 'conversation-a', send(frame) { frames.push(frame); } });
  assert.equal(consume().type, 'reliable-kernel.snapshot');
  assertVisibleReceipt();
});
