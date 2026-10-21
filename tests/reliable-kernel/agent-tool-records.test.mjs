import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { openDeliveryFixture, load } from './collaboration-delivery-fixture.mjs';

const { projectToolResultBatch } = load('backend/reliableKernel/modelFacingContextProjection.js');
const { projectRuntimeDeliveryForModel, renderRuntimeDeliveryModelEnvelope } = load('backend/reliableKernel/runtimeDeliveryProjection.js');
const { estimateJsonTokens } = load('backend/reliableKernel/modelTokenEstimator.js');
const { selectCollaborationToolArguments } = load('backend/reliableKernel/collaborationToolDispatcher.js');
const { projectToolResultForModel, resolveModelToolArguments } = load('backend/reliableKernel/modelHandleCatalog.js');
let f;
before(async () => { f = await openDeliveryFixture(); });
after(async () => { await f?.close(); });

test('agent reports between the old and new limits survive delivery and tool projection', () => {
  const report = '结论证据。'.repeat(1500);
  const projection = projectRuntimeDeliveryForModel({ kind: 'child_answer', phase: 'current_turn',
    deliveryId: 'delivery', inboxItemId: 'inbox', targetTurnId: 'parent-turn', deliveredAt: '2026-10-19T00:00:00.000Z',
    childExecutionId: 'child', answerBridgeId: 'bridge', submissionId: 'submission', sourceTurnId: 'child-turn',
    title: 'Report', contentType: 'text/plain', content: report, status: 'submitted' });
  const catalog = { entries: [{ kind: 'child', ref: 'A1', target: 'bridge' }] };
  const rendered = renderRuntimeDeliveryModelEnvelope(projection.envelope, undefined, catalog);
  assert.ok(rendered.includes(report));
  for (const toolName of ['run_agent', 'read_agent_answer', 'read_agent_messages', 'read_conversation']) {
    const result = projectToolResultBatch([{ toolName, response: { content: report } }]).items[0];
    assert.equal(result.truncated, false, toolName);
    assert.equal(result.response.content, report);
  }
  assert.equal(projectToolResultBatch([{ toolName: 'shell', response: { content: report } }]).items[0].truncated, true);
});

test('larger collaboration messages can be sent and their full text fits fewer read pages', async () => {
  const s = await f.scenario('large-report'), text = '报告😀'.repeat(10000);
  assert.ok(Buffer.byteLength(text) > 64000);
  const sent = await s.send('left', 'root', 'message', text);
  const page = await f.app.runtime.collaboration.readMessage({ conversationId: s.root, messageId: sent.messageId });
  assert.ok(estimateJsonTokens(page.text) > 2400);
  let whole = page.text;
  for (let offset = page.nextOffset; offset !== null;) {
    const next = await f.app.runtime.collaboration.readMessage({ conversationId: s.root, messageId: sent.messageId, offset });
    whole += next.text; offset = next.nextOffset;
  }
  assert.equal(whole, text);
});

test('tool summaries read metadata only, page exact calls and leave execution untouched', async () => {
  const s = await f.scenario('tool-list');
  for (const name of ['shell', 'read', 'edit']) await s.source('left', name, { command: 'PRIVATE_COMMAND' });
  const scope = { conversationId: s.root, targetConversationId: s.left };
  const callsBefore = await f.rows('ToolCall', { turn_id: s.turn('left') });
  const read = f.app.contentStore.read;
  f.app.contentStore.read = async () => { assert.fail('Listing tool metadata must not read argument/result bodies'); };
  let first, second;
  try {
    first = await f.app.runtime.collaboration.readToolActivity({ ...scope, limit: 2 });
    second = await f.app.runtime.collaboration.readToolActivity({ ...scope, cursor: first.nextCursor });
    const replay = await f.app.runtime.collaboration.readToolActivity({ ...scope, cursor: first.rereadCursor });
    assert.deepEqual(replay.tools, first.tools);
  } finally { f.app.contentStore.read = read; }
  assert.equal(first.tools.length, 2);
  assert.equal(second.tools.length, 1);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(new Set([...first.tools, ...second.tools].map(tool => tool.toolName)), new Set(['shell', 'read', 'edit']));
  assert.ok(!JSON.stringify(first).includes('PRIVATE_COMMAND'));
  assert.deepEqual(await f.rows('ToolCall', { turn_id: s.turn('left') }), callsBefore);
  await assert.rejects(f.app.runtime.collaboration.readToolActivity({ conversationId: s.outsider, targetConversationId: s.left }), /not enabled/);
  await assert.rejects(f.app.runtime.collaboration.readToolActivity({ ...scope, targetConversationId: s.right, cursor: first.nextCursor }), /another conversation/);
});

test('stored shell arguments and results are readable in full through detail cursors', async () => {
  const s = await f.scenario('tool-detail'), command = { command: 'printf "中文😀"', cwd: '/workspace' };
  const source = await s.source('left', 'shell', command);
  const output = '检查结果😀\n'.repeat(9000), detail = { exitCode: 7, stdout: output, stderr: 'test failure' };
  await f.app.runtime.effects.settleWithoutEffect({ source: { kind: 'internal', key: `result:${source.toolCallId}` },
    toolCallId: source.toolCallId, status: 'failed', detail });
  const scope = { conversationId: s.root, targetConversationId: s.left };
  const list = await f.app.runtime.collaboration.readToolActivity(scope);
  assert.equal(list.tools[0].status, 'failed');
  const args = await f.app.runtime.collaboration.readToolActivity({ ...scope, cursor: list.tools[0].argumentsCursor });
  assert.deepEqual(JSON.parse(args.text), command);
  const chunks = [];
  for (let cursor = list.tools[0].resultCursor; cursor !== null;) {
    const page = await f.app.runtime.collaboration.readToolActivity({ ...scope, cursor });
    assert.ok(estimateJsonTokens(page) < 12000);
    chunks.push(page.text); cursor = page.nextCursor;
  }
  assert.ok(chunks.length > 1);
  const stored = JSON.parse(chunks.join(''));
  assert.equal(stored.detail.exitCode, 7);
  assert.equal(stored.detail.stdout, output);
  const catalog = { entries: [{ kind: 'conversation', ref: 'C1', target: s.left }] };
  const projected = projectToolResultForModel('read_agent_messages', list, catalog);
  assert.equal(projected.conversationRef, 'C1');
  assert.equal(projected.tools[0].resultCursor, list.tools[0].resultCursor);
  const resolved = resolveModelToolArguments('read_agent_messages', { view: 'tools', conversationRef: 'C1', cursor: projected.tools[0].resultCursor }, catalog);
  assert.equal(resolved.targetConversationId, s.left);
  assert.equal(resolved.cursor, list.tools[0].resultCursor);
  const selected = selectCollaborationToolArguments('read_agent_messages', { ...resolved, messageRef: 'unused', offset: 3 });
  assert.equal(selected.arguments.cursor, resolved.cursor);
  assert.equal(selected.arguments.messageRef, undefined);
});
