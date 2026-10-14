import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiled, 'backend/reliableKernel/index.js'));
const shared = require(path.join(compiled, 'shared/reliableKernelClientFeed.js'));
const NativeDatabase = require('better-sqlite3');
const { ExternalClientCommits } = require(path.join(compiled, 'backend/reliableKernel/externalClientCommits.js'));
const { runtimeHostLivenessDirectory } = require(path.join(compiled, 'backend/reliableKernel/runtimeHostControl.js'));
const NOW = '2026-10-15T00:00:00.000Z';
const insert = (domain, record) => kernel.DOMAIN_REPOSITORIES.domain(domain).insert(record);

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-external-feed-'));
  const root = await kernel.resetCandidateRuntimeRoot(directory);
  const database = await kernel.RuntimeDatabase.open(root.authority);
  const cas = kernel.ContentAddressedStore.forDatabase(root.authority, database);
  const feed = new kernel.BoundedClientFeed(database);
  const peer = new NativeDatabase(database.binding.paths.databasePath);
  const notices = new ExternalClientCommits();
  await notices.start('test-peer-token', async () => {});
  const registration = path.join(runtimeHostLivenessDirectory(database.binding.paths), 'notified-peer.json');
  await fs.writeFile(registration, JSON.stringify({ kind: 'limcode-runtime-host-liveness',
    dataSetId: database.binding.dataSetId, rootInstanceId: database.binding.rootInstanceId,
    rootGeneration: database.binding.rootGeneration, hostBootId: 'notified-peer', livenessId: 'test-peer-token',
    processId: process.pid, startedAt: NOW, heartbeatAt: NOW, clientCommitPort: notices.port }));
  const notify = (domain, id) => {
    const table = kernel.DOMAIN_REPOSITORIES.domain(domain).schema.table;
    const record = peer.prepare('SELECT * FROM "' + table + '" WHERE id = ?').get(id);
    notices.record({ commitSeq: '0', allocatedSequences: [], changes: [{ domain, id, kind: 'upsert', record }] });
  };
  try {
    await database.transaction(['self', 'peer'].flatMap(id => [
      insert('Conversation', { id, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
      insert('Turn', { id: id + '-turn', conversation_id: id, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW })
    ]));
    const frames = [];
    let nextFrame;
    const connection = await feed.connect({ activeConversationId: 'self', send(frame) { frames.push(frame); nextFrame?.(frame); } });
    const initial = shared.applyReliableKernelDataMessage(shared.createEmptyReliableKernelClientState(), frames[0]);
    feed.acknowledge(initial.ack);
    const waitFrame = () => new Promise(resolve => { nextFrame = resolve; });
    await run({ database, cas, feed, peer, notify, frames, connection, initial: initial.state, waitFrame });
  } finally {
    feed.close(); peer.close(); notices.close(); await fs.rm(registration, { force: true });
    await database.close(); await fs.rm(directory, { recursive: true, force: true });
  }
}

test('外部无关对话保存不重建当前整页，导航标题仍按递增前沿发送增量', { timeout: 15000 }, async () => {
  await fixture(async ({ database, feed, peer, notify, frames, connection, initial }) => {
    const snapshot = database.clientProjectionSnapshot.bind(database);
    let reads = 0;
    database.clientProjectionSnapshot = (...args) => { reads++; return snapshot(...args); };
    peer.prepare('UPDATE conversation SET title = ? WHERE id = ?').run('changed peer', 'peer');
    notify('Conversation', 'peer');
    await feed.pollExternalCommits();
    assert.equal(reads, 0);
    assert.equal(frames.length, 2);
    assert.equal(frames[1].type, 'reliable-kernel.changes');
    const applied = shared.applyReliableKernelDataMessage(initial, frames[1]);
    assert.equal(applied.snapshotRequired, false);
    assert.equal(applied.state.records.Conversation.peer.title, 'changed peer');
    feed.acknowledge({ ...connection, messageSeq: frames[1].messageSeq });
    peer.prepare('UPDATE turn SET updated_at = ? WHERE id = ?').run('2026-10-15T00:01:00.000Z', 'peer-turn');
    notify('Turn', 'peer-turn');
    await feed.pollExternalCommits();
    assert.equal(reads, 0);
    assert.equal(frames.length, 2, 'unrelated Turn metadata must not consume the ACK channel');
  });
});

test('外部修改当前视图仍刷新，后续外部导航增量不倒退本地提交前沿', { timeout: 15000 }, async () => {
  await fixture(async ({ database, feed, peer, notify, frames, connection, waitFrame }) => {
    const changed = waitFrame();
    peer.prepare('UPDATE turn SET updated_at = ? WHERE id = ?').run('2026-10-15T00:02:00.000Z', 'self-turn');
    notify('Turn', 'self-turn');
    await feed.pollExternalCommits();
    const snapshot = await changed;
    assert.equal(snapshot.type, 'reliable-kernel.snapshot');
    feed.acknowledge({ ...connection, messageSeq: snapshot.messageSeq });
    await database.transaction([kernel.DOMAIN_REPOSITORIES.domain('Conversation').update('peer', { title: 'local title', updated_at: NOW })]);
    const local = frames.at(-1);
    feed.acknowledge({ ...connection, messageSeq: local.messageSeq });
    peer.prepare('UPDATE conversation SET title = ? WHERE id = ?').run('external title', 'peer');
    notify('Conversation', 'peer');
    await feed.pollExternalCommits();
    const external = frames.at(-1);
    assert.equal(external.type, 'reliable-kernel.changes');
    assert.ok(BigInt(external.commitSeq) > BigInt(local.commitSeq));
    assert.equal(external.changes.find(change => change.record?.id === 'peer').record.title, 'external title');
  });
});

test('新面板读取较新的快照，不会抹掉旧面板尚未收到的外部导航变化', { timeout: 15000 }, async () => {
  await fixture(async ({ feed, peer, notify, frames, initial }) => {
    peer.prepare('UPDATE conversation SET title = ? WHERE id = ?').run('newer title', 'peer');
    notify('Conversation', 'peer');
    const newerFrames = [];
    const newer = await feed.connect({ activeConversationId: 'peer', send(frame) { newerFrames.push(frame); } });
    feed.acknowledge({ ...newer, messageSeq: newerFrames[0].messageSeq });
    await feed.pollExternalCommits();
    assert.equal(frames.length, 2);
    const applied = shared.applyReliableKernelDataMessage(initial, frames[1]);
    assert.equal(applied.snapshotRequired, false);
    assert.equal(applied.state.records.Conversation.peer.title, 'newer title');
  });
});

test('没有已登记提交通知的外部写入仍重取快照，不会漏掉窗口外旧消息删除', { timeout: 15000 }, async () => {
  await fixture(async ({ database, cas, feed, peer, connection }) => {
    feed.disconnect(connection.sessionId);
    const body = await cas.ingest(database, JSON.stringify({ role: 'user', parts: [{ text: 'test' }] }), 'application/vnd.limcode.message+json');
    const steps = [];
    for (let i = 1; i <= 205; i++) steps.push(
      insert('Message', { id: 'm' + i, created_at: NOW, updated_at: NOW, deleted_at: null }),
      insert('MessageRevision', { id: 'r' + i, message_id: 'm' + i, revision_seq: 1n, role: 'user', content_object_id: body.id, created_at: NOW }),
      insert('MessageCurrentRevisionLink', { id: 'c' + i, message_id: 'm' + i, revision_id: 'r' + i, updated_at: NOW }),
      insert('MessagePartOfConversation', { id: 'p' + i, message_id: 'm' + i, conversation_id: 'self', message_seq: BigInt(i), created_at: NOW })
    );
    await database.transaction(steps);
    const frames = [];
    let next;
    const current = await feed.connect({ activeConversationId: 'self', send(frame) { frames.push(frame); next?.(frame); } });
    feed.acknowledge({ ...current, messageSeq: frames[0].messageSeq });
    const update = new Promise(resolve => { next = resolve; });
    peer.prepare('UPDATE message SET deleted_at = ? WHERE id = ?').run(NOW, 'm1');
    await feed.pollExternalCommits();
    const snapshot = await update;
    assert.equal(snapshot.type, 'reliable-kernel.snapshot');
    assert.equal(snapshot.projections.activeConversationWindow.visibleMessageCount, '204');
  });
});

test('真实 Runtime 提交直接发布已有变化，通知缺口要求重取快照且不回查历史', { timeout: 15000 }, async () => {
  await fixture(async ({ database }) => {
    const source = database.externalClientCommits;
    const receiver = new ExternalClientCommits();
    const peer = { hostBootId: database.hostBootId, livenessId: database.livenessId, clientCommitPort: source.port };
    try {
      await receiver.poll([peer], true);
      await database.transaction([kernel.DOMAIN_REPOSITORIES.domain('Conversation').update('peer', { title: 'notified', updated_at: NOW })]);
      const changes = await receiver.poll([peer]);
      assert.equal(changes.find(change => change.domain === 'Conversation' && change.id === 'peer').record.title, 'notified');
      source.record({ commitSeq: '0', allocatedSequences: [], changes: Array.from({ length: 129 }, (_, i) =>
        ({ domain: 'Conversation', id: 'bound-' + i, kind: 'remove' })) });
      assert.equal(await receiver.poll([peer]), null);
    } finally { receiver.close(); }
  });
});

test('写入窗口在两次轮询之间开启后退出，不能被另一窗口的完整通知掩盖', { timeout: 15000 }, async () => {
  await fixture(async ({ database, feed, peer, notify, waitFrame }) => {
    const changed = waitFrame();
    peer.prepare('UPDATE turn SET updated_at = ? WHERE id = ?').run('2026-10-15T00:03:00.000Z', 'self-turn');
    peer.prepare('UPDATE turn SET updated_at = ? WHERE id = ?').run('2026-10-15T00:03:00.000Z', 'peer-turn');
    notify('Turn', 'peer-turn');
    await fs.writeFile(path.join(runtimeHostLivenessDirectory(database.binding.paths), '.client-membership'), 'writer-opened-and-closed');
    await feed.pollExternalCommits();
    assert.equal((await changed).type, 'reliable-kernel.snapshot');
  });
});
