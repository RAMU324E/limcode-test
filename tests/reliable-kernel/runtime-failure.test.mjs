import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { RuntimeDatabase, resetCandidateRuntimeRoot, replaceHostRecord } = require(path.join(compiled, 'backend/reliableKernel/runtimeDatabase.js'));

async function home(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'limcode-runtime-failure-'));
  const root = await resetCandidateRuntimeRoot(directory);
  const database = await RuntimeDatabase.open(root.authority);
  t.after(async () => { await database.close(); await rm(directory, { recursive: true, force: true }); });
  return database;
}

test('idle heartbeat failure notifies once and preserves the first error on later requests', async t => {
  const database = await home(t);
  const failure = Object.assign(new Error('heartbeat replacement denied'), { code: 'EACCES' });
  const failures = [];
  database.onClose(error => failures.push(error));
  t.mock.method(database, 'writeHostHeartbeat', async () => { throw failure; });
  database.heartbeatTimer._onTimeout();
  await database.heartbeatTask;
  assert.deepEqual(failures, [failure]);
  await assert.rejects(database.snapshot([]), error => error === failure);
  await assert.rejects(database.withHistoryPreparation(async () => undefined), /heartbeat replacement denied/);
  database.onClose(error => assert.equal(error, failure));
  await database.close();
  assert.equal(failures.length, 1);
});

test('worker fatal retains original SQLite error and graceful close has no failure', async t => {
  const database = await home(t);
  const failures = [];
  database.onClose(error => failures.push(error));
  database.worker.emit('message', { type: 'fatal', error: { name: 'SqliteError', message: 'test worker fatal', code: 'SQLITE_IOERR' } });
  await assert.rejects(database.snapshot([]), /test worker fatal/);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /test worker fatal/);
});

test('normal close emits no fault', async t => {
  const database = await home(t);
  const reasons = [];
  database.onClose(reason => reasons.push(reason));
  await database.close();
  assert.deepEqual(reasons, [undefined]);
});

test('Windows record replacement retries the same paths and immediately rejects unrelated failures', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  const paths = [];
  const rename = t.mock.method(fs, 'rename', async (...args) => {
    paths.push(args);
    if (paths.length === 1) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
  });
  await replaceHostRecord('record.tmp', 'record.json');
  assert.deepEqual(paths, [['record.tmp', 'record.json'], ['record.tmp', 'record.json']]);
  const full = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  rename.mock.mockImplementation(async () => { throw full; });
  await assert.rejects(replaceHostRecord('record.tmp', 'record.json'), error => error === full);
  assert.equal(rename.mock.callCount(), 3);
});
