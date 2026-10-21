import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const originalExecFile = childProcess.execFile;
const platform = Object.getOwnPropertyDescriptor(process, 'platform');
let calls = [];
let probe = async () => ({ stdout: '638000000000000000', stderr: '' });
function fakeExecFile() { throw new Error('The probe uses the promise form.'); }
fakeExecFile[promisify.custom] = (file, args, options) => {
  calls.push({ file, args, options });
  return probe();
};
childProcess.execFile = fakeExecFile;
const protocol = require('../../dist/extension/backend/reliableKernel/processProtocol.js');
const claims = require('../../dist/extension/backend/reliableKernel/runtimeClaimPrimitives.js');
childProcess.execFile = originalExecFile;
after(() => Object.defineProperty(process, 'platform', platform));
function windows() {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  calls = [];
}

test('Windows查询等待期间定时器继续，同一PID重叠查询共用结果但不缓存旧身份', async () => {
  windows();
  let release;
  probe = () => new Promise(resolve => { release = () => resolve({ stdout: '638000000000000000', stderr: '' }); });
  const first = protocol.readProcessStartFingerprintAsync(process.pid);
  const second = protocol.readProcessStartFingerprintAsync(String(process.pid));
  assert.equal(first, second);
  assert.equal(calls.length, 1);
  let finished = false;
  void first.then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(finished, false, 'timers must run while the OS query remains pending');
  release();
  assert.equal(await first, `win32-process:${process.pid}:638000000000000000`);
  const next = protocol.readProcessStartFingerprintAsync(process.pid);
  assert.equal(calls.length, 2);
  release();
  await next;
  assert.equal(calls[0].options.windowsHide, true);
});

test('Windows查询保留超时重试与身份判定，失败后允许重新查询', async () => {
  windows();
  probe = async () => { throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }); };
  await assert.rejects(protocol.readProcessStartFingerprintAsync(process.pid), { code: 'ETIMEDOUT' });
  assert.deepEqual(calls.map(call => call.options.timeout), [3000, 6000, 10000]);
  probe = async () => ({ stdout: '638000000000000000', stderr: '' });
  assert.equal(await claims.classifyRecordedProcess(process.pid, `win32-process:${process.pid}:638000000000000000`), 'alive');
  assert.equal(await claims.classifyRecordedProcess(process.pid, `win32-process:${process.pid}:1`), 'dead');
});

test('命令轮询调用异步探测，查询失败保持unknown并等待CIM检查', async t => {
  windows();
  const { ProcessControlPlane } = require('../../dist/extension/backend/reliableKernel/processEffects.js');
  const fs = require('node:fs/promises');
  t.mock.method(childProcess, 'spawnSync', () => { throw new Error('synchronous process probe reached'); });
  const identity = `win32-process:${process.pid}:638000000000000000`;
  let release;
  probe = () => new Promise(resolve => { release = () => resolve({ stdout: '638000000000000000', stderr: '' }); });
  t.mock.method(fs, 'readFile', async () => { throw Object.assign(new Error('no receipt'), { code: 'ENOENT' }); });
  const pending = ProcessControlPlane.prototype.observeVerifiedIdentity.call({}, {
    processId: 'command', wrapperPid: String(process.pid), childPid: String(process.pid), startFingerprint: identity
  }, '/absent-probe-spool');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  release();
  assert.equal((await pending).state, 'running');
  t.mock.restoreAll();
  probe = async () => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }); };
  assert.equal((await claims.inspectRecordedProcess(process.pid, identity)).state, 'unknown');
  assert.equal(calls.at(-1).args.at(-1).includes('Get-CimInstance'), true);
});

test('macOS进程与wrapper查询同样异步，ps无匹配进程保留ENOENT语义', async () => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  calls = [];
  probe = async () => ({ stdout: `${process.pid} ${process.pid} Tue Oct 20 12:00:00 2026`, stderr: '' });
  assert.match(await protocol.readProcessStartFingerprintAsync(process.pid), new RegExp(`^darwin-ps:${process.pid}:`));
  assert.equal(calls[0].file, '/bin/ps');
  const launchPath = require('node:path').resolve('/tmp/probe/launch.json');
  probe = async () => ({ stdout: `node ${launchPath}`, stderr: '' });
  assert.equal(await protocol.isWrapperProcessReachableAsync(String(process.pid), launchPath), true);
  probe = async () => { throw Object.assign(new Error('no such process'), { code: 1 }); };
  await assert.rejects(protocol.readProcessStartFingerprintAsync(process.pid), { code: 'ENOENT' });
});
