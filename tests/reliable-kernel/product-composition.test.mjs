import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const distRoot = path.resolve('dist/extension');
const require = createRequire(import.meta.url);



test('ApplicationStartup keeps backend evaluation demand-driven and single-flight', async () => {
  const { ApplicationStartup } = require(path.join(distRoot, 'vscode/ApplicationStartup.js'));
  const startup = new ApplicationStartup();
  const application = { marker: 'ready' };
  let starts = 0;
  startup.setStarter(() => {
    starts += 1;
    startup.resolve(application);
  });

  assert.equal(starts, 0, 'surface registration alone must not evaluate the backend');
  assert.equal(startup.pending(), undefined, 'an unused activation has no pending backend to close');
  const first = startup.wait();
  const second = startup.wait();
  assert.equal(starts, 1);
  assert.equal(first, second);
  assert.equal(startup.pending(), first);
  assert.equal(await first, application);
});

