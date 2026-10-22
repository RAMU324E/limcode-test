import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
const { ModelProviderControlPlane } = load('backend/reliableKernel/modelProviderControlPlane.js');
const { projectTurnReminder, requestTurnReminderDelivery, recipeCurrentTurnInputs } = load('backend/reliableKernel/turnReminderProjection.js');

const responses = { model: { provider: 'openai-responses' } };
const ordinary = { kind: 'reliable-agent-turn', turnReminderDelivery: 'user_history' };
const source = (segmentId, recipeId, segmentKind = 'message') => ({
  segmentId, segmentKind, messageRole: segmentKind === 'message' ? 'model' : null,
  sourceRecipeObjectId: recipeId
});

function fixture(objects) {
  const bodies = new Map(Object.entries(objects).map(([id, value]) => [id, Buffer.from(JSON.stringify(value))]));
  const reads = [];
  const metadata = id => ({ id, content_type: 'application/json', byte_length: BigInt(bodies.get(id).length) });
  const database = { async snapshot(commands) {
    return { snapshot: commands.map(command => metadata(command.id)) };
  } };
  const store = { async readMany(items) {
    reads.push(...items.map(item => item.id));
    return items.map(item => bodies.get(item.id));
  } };
  return { plane: new ModelProviderControlPlane(database, store), reads };
}

test('Responses 新请求冻结 user 历史语义，快照文字在重放时不变，旧 recipe 保留原文', () => {
  assert.equal(requestTurnReminderDelivery(responses), 'user_history');
  assert.equal(requestTurnReminderDelivery({ model: { provider: 'claude', claudeTurnScopedReminders: true } }), 'claude_turn_scoped');
  assert.equal(requestTurnReminderDelivery({ model: { provider: 'claude' } }), undefined);
  const card = { kind: 'reliable-agent-turn', runtimeStatusCard: { card: 'runningProcesses=1' } };
  assert.equal(projectTurnReminder(card).content, 'runningProcesses=1');
  const frozen = { ...card, turnReminderDelivery: 'user_history' };
  const content = projectTurnReminder(frozen).content;
  assert.match(content, /before the assistant response immediately following this message/);
  assert.match(content, /historical evidence/);
  assert.equal(projectTurnReminder(JSON.parse(JSON.stringify(frozen))).content, content);
});

test('历史提醒在同一 recipe 的首个真实输出前只放一次，分支选择和跨模型读取复用冻结事实', async () => {
  const { plane, reads } = fixture({
    first: { ...ordinary, runtimeStatusCard: { card: 'runningProcesses=1' } },
    second: { ...ordinary, runtimeStatusCard: { card: 'runningProcesses=0' } },
    legacy: { kind: 'reliable-agent-turn', runtimeStatusCard: { card: 'legacy' } }
  });
  const history = [source('call-a', 'first', 'tool_pair'), source('text-a', 'first'),
    source('text-b', 'second'), source('old', 'legacy')];
  const entries = await plane.materializeTurnReminderHistory(responses, ordinary, history);
  assert.deepEqual(entries.map(entry => [entry.segmentId, entry.delivery]), [
    ['call-a', 'user_history'], ['text-b', 'user_history']
  ]);
  assert.match(entries[0].content, /runningProcesses=1$/);
  assert.match(entries[1].content, /runningProcesses=0$/);
  // Removing the first output moves the snapshot before the next surviving output.
  assert.equal(entries[0].budgetSegmentId, 'text-a');
  assert.deepEqual(reads, ['first', 'second', 'legacy']);
  const fork = await plane.materializeTurnReminderHistory({ model: { provider: 'claude' } }, ordinary,
    [source('fork-a', 'first', 'tool_pair')]);
  assert.deepEqual(fork.map(entry => entry.segmentId), ['fork-a']);
  assert.equal(fork[0].content, entries[0].content);
  assert.deepEqual(reads, ['first', 'second', 'legacy']);
});

test('重注入输入随首个发送位置保留一次，原生压缩保留历史，文本摘要不重复引入状态快照', async () => {
  const input = { messageRevisionId: 'input-revision', contentObjectId: 'input', reinject: true };
  const { plane } = fixture({
    first: { ...ordinary, currentTurnInput: input, attachmentCatalogState: { catalog: [], placements: [] } },
    second: { ...ordinary, currentTurnInput: input, attachmentCatalogState: { catalog: [], placements: [] },
      runtimeStatusCard: { card: 'latest' } },
    input: { role: 'user', parts: [{ text: 'original task' }] }
  });
  const history = [source('first-output', 'first'), source('second-output', 'second')];
  const compact = { kind: 'reliable-context-compression', compressionMethodKind: 'provider_native' };
  const entries = await plane.materializeTurnReminderHistory(responses, compact, history);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].reinjectedInputs[0].messageRevisionId, 'input-revision');
  assert.equal(entries[0].reinjectedInputs[0].budgetSegmentId, 'second-output');
  assert.equal(entries[1].reinjectedInputs, undefined);
  assert.match(entries[1].content, /latest$/);
  assert.equal(await plane.materializeTurnReminderHistory(responses,
    { ...compact, compressionMethodKind: 'llm_summary' }, history), undefined);
  assert.equal(await plane.materializeTurnReminderHistory(responses,
    { ...compact, sourceReplay: 'immutable_provenance' }, history), undefined);
});


test('有序输入集合按独立修订冻结和重放，缺项、乱序与混合身份拒绝', async () => {
  const inputs = ['a', 'b'].map(id => ({ kind: 'current_turn_input', messageId: `message-${id}`,
    messageRevisionId: `revision-${id}`, contentObjectId: `body-${id}`, reinject: true, estimatedTokens: 8 }));
  const recipe = { ...ordinary, currentTurnInputs: inputs, attachmentCatalogState: { catalog: [], placements: [] } };
  const objects = { first: recipe, second: { ...recipe, runtimeStatusCard: { card: 'second-round' } },
    'body-a': { role: 'user', parts: [{ text: 'first input' }] },
    'body-b': { role: 'user', parts: [{ text: 'second input' }] } };
  const { plane } = fixture(objects);
  const history = await plane.materializeTurnReminderHistory(responses, ordinary,
    [source('first-text', 'first'), source('first-call', 'first', 'tool_pair'), source('next-text', 'second')]);
  assert.deepEqual(history[0].reinjectedInputs.map(input => input.messageRevisionId), ['revision-a', 'revision-b']);
  assert.equal(history[1].reinjectedInputs, undefined);
  assert.match(history[1].content, /second-round$/);
  assert.deepEqual(await plane.materializeTurnReminderHistory(responses,
    { kind: 'reliable-context-compression', compressionMethodKind: 'provider_native' },
    [source('first-text', 'first'), source('next-text', 'second')]),
    history.map(entry => ({ ...entry, budgetSegmentId: entry.segmentId })));
  assert.throws(() => recipeCurrentTurnInputs({ ...recipe, currentTurnInput: inputs[0] }), /conflicting/);
  assert.throws(() => recipeCurrentTurnInputs({ ...recipe, currentTurnInputs: [inputs[0], inputs[0]] }), /duplicate/);

  const rows = {
    Turn: [{ id: 'turn', conversation_id: 'conversation' }],
    MessageTurnLink: [...inputs].reverse().map(input => ({ turn_id: 'turn', message_id: input.messageId, role: 'input' })),
    MessagePartOfConversation: inputs.map((input, index) => ({ message_id: input.messageId,
      conversation_id: 'conversation', message_seq: BigInt(index + 4) })),
    MessageRevision: inputs.map(input => ({ id: input.messageRevisionId, message_id: input.messageId,
      role: 'user', content_object_id: input.contentObjectId }))
  };
  const read = command => command.domain === 'ContentObject'
    ? { id: command.id, content_type: 'application/json' }
    : command.kind === 'get' ? rows[command.domain]?.find(row => row.id === command.id) ?? null
    : (rows[command.domain] ?? []).filter(row => Object.entries(command.where ?? {}).every(([key, value]) => row[key] === value));
  const provider = new ModelProviderControlPlane({
    async snapshot(commands) { return { snapshot: commands.map(read) }; },
    async snapshotAll(command) { return { snapshot: read(command) }; }
  }, { async read(metadata) { return Buffer.from(JSON.stringify(objects[metadata.id])); } });
  const materialized = await provider.materializeRequestAddenda(recipe, 'turn');
  assert.deepEqual(materialized.requestAddenda.currentTurnInputs.map(input => input.messageId), ['message-a', 'message-b']);
  await assert.rejects(provider.materializeRequestAddenda({ ...recipe, currentTurnInputs: inputs.slice(0, 1) }, 'turn'), /complete ordered/);
  await assert.rejects(provider.materializeRequestAddenda({ ...recipe, currentTurnInputs: [...inputs].reverse() }, 'turn'), /provenance/);
  await assert.rejects(provider.materializeRequestAddenda({ ...recipe, currentTurnInputs: [
    { ...inputs[0], contentObjectId: inputs[1].contentObjectId }, inputs[1]
  ] }, 'turn'), /conflicts/);

  // A fork keeps the original recipe ids even after source messages are deleted. Each position
  // must prove its own copied revision and immutable segment; equal CAS bytes are not identity.
  rows.MessageTurnLink = inputs.map(input => ({ turn_id: 'turn', message_id: `copy-${input.messageId}`, role: 'input' }));
  rows.MessagePartOfConversation = inputs.map((input, index) => ({ message_id: `copy-${input.messageId}`,
    conversation_id: 'conversation', message_seq: BigInt(index + 1) }));
  rows.MessageRevision = inputs.map(input => ({ id: `copy-${input.messageRevisionId}`, message_id: `copy-${input.messageId}`,
    revision_seq: 1n, role: 'user', content_object_id: input.contentObjectId }));
  rows.ContextSegment = inputs.map(input => ({ id: `segment-${input.messageRevisionId}`, segment_kind: 'message',
    content_object_id: input.contentObjectId }));
  rows.ContextSegmentSource = inputs.flatMap(input => [input.messageRevisionId, `copy-${input.messageRevisionId}`].map(id => ({
    source_kind: 'message_revision', source_id: id, source_revision: 1n, segment_id: `segment-${input.messageRevisionId}`
  })));
  const copied = await provider.materializeRequestAddenda(recipe, 'turn');
  assert.deepEqual(copied, materialized);
  await assert.rejects(provider.materializeRequestAddenda({ ...recipe, currentTurnInputs: [...inputs].reverse() }, 'turn'), /copied revision/);
});
