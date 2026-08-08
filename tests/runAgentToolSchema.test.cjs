const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const root = process.cwd();
const extensionDist = process.env.LIMCODE_EXTENSION_DIST
  ? path.resolve(process.env.LIMCODE_EXTENSION_DIST)
  : path.join(root, 'dist/extension');

function fromDist(relativePath) {
  return require(path.join(extensionDist, relativePath));
}

const { ReliableChildAgentCoordinator } = fromDist('backend/reliableKernel/childAgentCoordinator.js');
const { stablePhaseFId } = fromDist('backend/reliableKernel/phaseFIdentity.js');
const { runAgentTool } = fromDist('backend/world/modules/tools/definitions/runAgent/index.js');
const { readAgentAnswerTool } = fromDist('backend/world/modules/tools/definitions/agentAnswer/index.js');
const { deleteTool } = fromDist('backend/world/modules/tools/definitions/delete/index.js');

test('Agent 工具声明说明异步用法，并只标记无条件必填参数', () => {
  assert.match(runAgentTool.declaration.description, /Child Agents are asynchronous/);
  assert.match(runAgentTool.declaration.description, /Do NOT poll read_agent_answer/);
  assert.match(runAgentTool.declaration.description, /Never interrupt merely because/);
  assert.match(runAgentTool.declaration.parameters.properties.foregroundWaitMs.description, /Optional in run mode/);
  assert.equal(runAgentTool.declaration.parameters.properties.foregroundWaitMs.minimum, 0);
  assert.equal(runAgentTool.declaration.parameters.properties.foregroundWaitMs.maximum, 86_400_000);
  assert.equal(runAgentTool.declaration.parameters.properties.foregroundWaitMs.multipleOf, 1);

  assert.equal(runAgentTool.declaration.parameters.required, undefined,
    'prompt 只在 run 模式必填，不能让 interrupt 模式也被 JSON schema 拒绝');
  assert.deepEqual(readAgentAnswerTool.declaration.parameters.required, ['answerBridgeId']);
  assert.deepEqual(deleteTool.declaration.parameters.required, ['paths']);
});

test('可靠 run_agent 省略 foregroundWaitMs 时立即转后台，run 与 interrupt 的 prompt 校验保持分开', async () => {
  const toolCallId = 'optional-wait-tool-call';
  const answerBridgeId = stablePhaseFId('answer_bridge', toolCallId);
  let spawnCommand;
  let resolvedSelection;
  const coordinator = new ReliableChildAgentCoordinator({
    database: {
      hostBootId: 'optional-wait-host',
      async snapshot() {
        return { snapshot: [{ id: 'interrupt-bridge', child_execution_id: 'interrupt-child' }] };
      }
    },
    effects: {
      async settleWithoutEffect(input) {
        return { status: input.status };
      }
    },
    children: {
      async spawn(command) {
        spawnCommand = command;
        return {
          answerBridgeId,
          effectIntentId: 'spawn-effect',
          attemptId: 'spawn-attempt',
          childExecutionId: 'spawn-child',
          childTurnId: 'spawn-turn'
        };
      },
      async claimSpawnDispatch() { return true; },
      async recordSpawnReceipt() { return { effectReceiptId: 'spawn-receipt' }; },
      async reconcileSpawnReceipt() {},
      async finalizeWaitSettlement(requestedToolCallId) {
        return { toolCallId: requestedToolCallId, status: 'succeeded' };
      },
      async readExecutionSnapshot() {
        return { childExecution: { id: 'interrupt-child' } };
      },
      async interruptSubtree() {
        return {
          rootChildExecutionId: 'interrupt-child',
          activeTurnIds: [],
          cancelledIntentIds: []
        };
      }
    },
    answers: {},
    deliveries: {},
    modelProvider: {},
    turns: {},
    agentLoop: {},
    agents: {
      async resolve(selection) {
        resolvedSelection = selection;
        return { agentId: 'agent-child', agentType: 'worker' };
      }
    }
  });
  coordinator.launch = () => {};

  const background = await coordinator.dispatch({
    turnId: 'parent-turn',
    modelRequestId: 'parent-request',
    toolCallId,
    toolName: 'run_agent',
    arguments: { prompt: 'inspect in the background', agent: { type: 'worker' } }
  });
  assert.deepEqual(resolvedSelection, { agentType: 'worker' });
  assert.equal(spawnCommand.completionPolicy, 'background');
  assert.equal('waitDeadlineAt' in spawnCommand, false);
  assert.match(spawnCommand.prompt, /inspect in the background/);
  assert.equal(background.disposition, 'settled');

  await assert.rejects(() => coordinator.dispatch({
    turnId: 'parent-turn',
    modelRequestId: 'missing-prompt-request',
    toolCallId: 'missing-prompt-tool-call',
    toolName: 'run_agent',
    arguments: { mode: 'run' }
  }), /run_agent\.prompt must be non-empty/);

  const interrupted = await coordinator.dispatch({
    turnId: 'parent-turn',
    modelRequestId: 'interrupt-request',
    toolCallId: 'interrupt-tool-call',
    toolName: 'run_agent',
    arguments: { mode: 'interrupt', answerBridgeId: 'interrupt-bridge' }
  });
  assert.equal(interrupted.disposition, 'settled');
});
