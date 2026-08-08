const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyCommandCall,
  createCommandTool,
  isReadonlyCommandCall
} = require('../dist/extension/backend/world/modules/tools/definitions/command/index.js');

const commandTool = createCommandTool({ toolName: 'bash', description: 'bash' });

test('命令默认直接执行，并接受模型明确给出的只读与并行提示', () => {
  assert.equal(commandTool.declaration.metadata.defaultAutoApproveExecution, true);

  const hinted = {
    command: 'npm install',
    readonly: 'true',
    scheduling: 'parallel'
  };
  assert.equal(classifyCommandCall(hinted).readonly, false, '本地分类仍可用于诊断');
  assert.equal(isReadonlyCommandCall(hinted), true, '权限判断接受模型只读提示');
  assert.deepEqual(commandTool.scheduling(hinted), {
    mode: 'parallel',
    reason: 'model_selected_parallel'
  });

  assert.equal(commandTool.scheduling({ command: 'touch a', wait: 'false' }).mode, 'parallel');
  assert.equal(commandTool.scheduling({ command: 'touch a' }).mode, 'serial');
  assert.equal(commandTool.scheduling({ command: 'rg needle src' }).mode, 'parallel');
});
