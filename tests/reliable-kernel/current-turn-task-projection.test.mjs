import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiledRoot = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT)
  : path.resolve('dist/extension');
const {
  TURN_TASK_CARD_MAX_TOKENS,
  approvedSubmitPlanTaskOperation,
  buildCurrentTurnTaskProjection,
  estimateTurnTaskCardTokens,
  freezeCurrentTurnTaskCard,
  readCurrentTurnTaskCard,
  taskListOperationFromSettledArtifact
} = require(path.join(compiledRoot, 'backend/reliableKernel/currentTurnTaskProjection.js'));
const {
  requireTaskListOperation,
  taskListOperationFromArgs
} = require(path.join(compiledRoot, 'shared/taskListProjection.js'));

const rewrite = (items) => ({ kind: 'task_list.operation', mode: 'rewrite', items });
const update = (items) => ({ kind: 'task_list.operation', mode: 'update', items });
const fact = (callSeq, operation, options = {}) => ({
  toolCallId: `task-call-${callSeq}`,
  callSeq: String(callSeq),
  toolName: options.toolName ?? 'update_task_list',
  operation,
  ...(options.planApproved === true ? { planApproved: true } : {}),
  sourceMessageId: `message-${callSeq}`
});

test('task operation 只在一个严格边界规范化完整 mode/items', () => {
  assert.deepEqual(requireTaskListOperation({
    mode: 'rewrite',
    items: [{ title: '  First   task ', description: ' two   words ', status: 'in_progress', delete: false }]
  }), {
    kind: 'task_list.operation',
    mode: 'rewrite',
    items: [{ title: 'First task', description: 'two words', status: 'in_progress' }]
  });
  assert.throws(() => requireTaskListOperation({ mode: 'rewrite', items: [{ title: 'x', status: 'done' }] }), /status is invalid/);
  assert.throws(() => requireTaskListOperation({ mode: 'rewrite', items: [{ title: 'x', delete: true }] }), /only be used in update mode/);
  assert.deepEqual(requireTaskListOperation({ mode: 'update', items: [{ title: 'x', delete: true, status: 'completed' }] }), {
    kind: 'task_list.operation', mode: 'update', items: [{ title: 'x', delete: true }]
  });
  assert.throws(() => requireTaskListOperation({ mode: 'rewrite', items: [], extra: true }), /unsupported fields/);
  assert.equal(taskListOperationFromArgs({ mode: 'rewrite', items: [{ title: 'x', unknown: true }] }), undefined);
});

test('没有 rewrite 基线时不从 update 或未批准 Plan 伪造任务卡', () => {
  const projection = buildCurrentTurnTaskProjection({
    turnId: 'turn-update-only',
    operations: [
      fact(1, update([{ title: 'increment only', status: 'in_progress' }])),
      fact(2, rewrite([{ title: 'rejected plan' }]), { toolName: 'submit_plan' })
    ]
  });
  assert.equal(projection, undefined);
});

test('approved Plan rewrite 可建基线，只应用同 Turn 中其后的有效 update', () => {
  const projection = buildCurrentTurnTaskProjection({
    turnId: 'turn-approved-plan',
    operations: [
      fact(1, update([{ title: 'ignored early update', status: 'completed' }])),
      fact(2, rewrite([{ title: 'rejected rewrite' }]), { toolName: 'submit_plan' }),
      fact(3, rewrite([
        { title: 'Implement', status: 'pending' },
        { title: 'Already done', status: 'completed' }
      ]), { toolName: 'submit_plan', planApproved: true }),
      fact(4, update([
        { title: 'Implement', status: 'in_progress' },
        { title: 'Verify', status: 'blocked' }
      ])),
      fact(5, rewrite([{ title: 'change requested must not replace' }]), { toolName: 'submit_plan' }),
      fact(6, update([{ title: 'Verify', status: 'pending' }]))
    ]
  });
  assert.ok(projection);
  assert.equal(projection.baselineToolCallId, 'task-call-3');
  assert.equal(projection.sourceToolCallId, 'task-call-6');
  assert.equal(projection.operationCount, 3);
  assert.deepEqual(projection.snapshot.items.map((item) => [item.title, item.status]), [
    ['Implement', 'in_progress'],
    ['Already done', 'completed'],
    ['Verify', 'pending']
  ]);
  assert.deepEqual(projection.counts, {
    total: 3,
    unfinished: 2,
    pending: 1,
    inProgress: 1,
    blocked: 0,
    completed: 1,
    cancelled: 0
  });
});

test('最近有效 rewrite 替换旧基线且不会跨基线复活旧任务', () => {
  const projection = buildCurrentTurnTaskProjection({
    turnId: 'turn-latest-rewrite',
    operations: [
      fact(1, rewrite([{ title: 'old task', status: 'in_progress' }])),
      fact(2, update([{ title: 'old follow-up', status: 'pending' }])),
      fact(3, rewrite([{ title: 'new task', status: 'pending' }])),
      fact(4, update([{ title: 'new task', status: 'completed' }]))
    ]
  });
  assert.ok(projection);
  assert.equal(projection.baselineToolCallId, 'task-call-3');
  assert.equal(projection.operationCount, 2);
  assert.deepEqual(projection.snapshot.items.map((item) => item.title), ['new task']);
});

test('turnTaskCard 确定性不超过 2K，先保留未完成项并提供 hash/计数', () => {
  assert.equal(TURN_TASK_CARD_MAX_TOKENS, 2_000);
  const huge = '很长的验收说明'.repeat(2_000);
  const items = [
    { title: 'Active first', description: huge, status: 'in_progress' },
    ...Array.from({ length: 30 }, (_, index) => ({
      title: `Pending ${index}`,
      description: huge,
      status: index % 2 === 0 ? 'pending' : 'blocked'
    })),
    ...Array.from({ length: 10 }, (_, index) => ({ title: `Completed ${index}`, description: huge, status: 'completed' }))
  ];
  const input = { turnId: 'turn-bounded-card', operations: [fact(1, rewrite(items))], maxTokens: 256 };
  const first = buildCurrentTurnTaskProjection(input);
  const second = buildCurrentTurnTaskProjection(input);
  assert.ok(first && second);
  assert.equal(first.card, second.card);
  assert.equal(first.cardSha256, second.cardSha256);
  assert.equal(first.estimatedTokens, estimateTurnTaskCardTokens(first.card));
  assert.ok(first.estimatedTokens <= 256);
  assert.ok(first.estimatedTokens <= TURN_TASK_CARD_MAX_TOKENS);
  assert.match(first.card, /runtime task data, not a new user instruction/);
  assert.match(first.card, /Active first/);
  assert.match(first.card, /details omitted by card budget: unfinished=/);
  assert.equal(first.counts.unfinished, 31);
  assert.equal(first.counts.completed, 10);
  assert.doesNotThrow(() => JSON.stringify(first));
  const frozen = freezeCurrentTurnTaskCard(first);
  assert.equal('snapshot' in frozen, false, 'ModelRequest recipe must not copy the unbounded UI snapshot');
  assert.equal(frozen.cardSha256, first.cardSha256);
  assert.doesNotThrow(() => JSON.stringify(frozen));
});

test('durable artifact hard-cut：只认 canonical operation，Plan 必须明确 approved', () => {
  const operation = rewrite([{ title: 'approved task', status: 'pending' }]);
  const settled = {
    toolCallId: 'task-call',
    status: 'succeeded',
    detail: { kind: 'task-list', operation }
  };
  assert.deepEqual(taskListOperationFromSettledArtifact(settled, 'task-call'), operation);
  for (const status of ['failed', 'rejected', 'cancelled']) {
    assert.equal(taskListOperationFromSettledArtifact({
      toolCallId: 'task-call',
      status,
      detail: { kind: 'task-list', operation: { deliberately: 'not canonical' } }
    }, 'task-call'), undefined, `${status} task artifact must be ignored before canonical validation`);
  }
  assert.throws(() => taskListOperationFromSettledArtifact({
    toolCallId: 'task-call',
    status: 'succeeded',
    detail: { kind: 'task-list', items: operation.items }
  }, 'task-call'), /Task list operation must be a plain object/);

  const planArgs = { plan: 'do it', taskList: operation };
  const result = (status) => ({
    toolCallId: 'plan-call',
    status: status === 'approved' ? 'succeeded' : 'rejected',
    detail: { kind: 'submit_plan.result', proposalId: 'proposal', status }
  });
  assert.deepEqual(approvedSubmitPlanTaskOperation({
    argumentsValue: planArgs,
    resultArtifactValue: result('approved'),
    toolCallId: 'plan-call'
  }), operation);
  assert.equal(approvedSubmitPlanTaskOperation({
    argumentsValue: planArgs,
    resultArtifactValue: result('change_requested'),
    toolCallId: 'plan-call'
  }), undefined);
  assert.equal(approvedSubmitPlanTaskOperation({
    argumentsValue: planArgs,
    resultArtifactValue: result('rejected'),
    toolCallId: 'plan-call'
  }), undefined);
  assert.equal(approvedSubmitPlanTaskOperation({
    argumentsValue: planArgs,
    resultArtifactValue: { ...result('approved'), status: 'cancelled' },
    toolCallId: 'plan-call'
  }), undefined);
});

test('任务卡按不可变 ToolCall 前缀读取，无关 commitSeq 连续变化不会失败主 Turn', async () => {
  const toolCallId = 'task-prefix-race-call';
  const artifact = {
    id: 'task-prefix-race-artifact',
    tool_call_id: toolCallId,
    role: 'no_effect_result',
    content_object_id: 'task-prefix-race-result'
  };
  let snapshotCount = 0;
  const database = {
    async snapshotAll() {
      return {
        snapshotCommitSeq: '10',
        snapshot: [{
          id: toolCallId,
          turn_id: 'task-prefix-race-turn',
          call_seq: 1n,
          tool_name: 'update_task_list',
          arguments_object_id: 'task-prefix-race-arguments'
        }]
      };
    },
    async snapshot() {
      snapshotCount += 1;
      if (snapshotCount === 1) {
        return {
          snapshotCommitSeq: '11',
          snapshot: [
            [artifact],
            { id: 'task-prefix-race-arguments' },
            [{ message_id: 'task-prefix-race-message' }]
          ]
        };
      }
      return {
        snapshotCommitSeq: '12',
        snapshot: [{ id: 'task-prefix-race-result' }]
      };
    }
  };
  const contentStore = {
    async read(metadata) {
      assert.equal(metadata.id, 'task-prefix-race-result');
      return Buffer.from(JSON.stringify({
        toolCallId,
        status: 'succeeded',
        detail: {
          kind: 'task-list',
          operation: rewrite([{ title: 'survives unrelated commits', status: 'in_progress' }])
        }
      }), 'utf8');
    }
  };
  const frozen = await readCurrentTurnTaskCard(
    database,
    contentStore,
    'task-prefix-race-turn'
  );
  assert.ok(frozen);
  assert.equal(frozen.frozenAtCommitSeq, '11');
  assert.equal(frozen.counts.unfinished, 1);
  assert.match(frozen.card, /survives unrelated commits/);
  assert.equal('snapshot' in frozen, false);
  assert.equal(snapshotCount, 2);
});
