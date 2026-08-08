import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const distRoot = path.resolve('dist/extension');

function emittedRequireClosure(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/require\(["']([^"']+)["']\)/g)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      let target = path.resolve(path.dirname(file), specifier);
      if (fs.existsSync(`${target}.js`)) target = `${target}.js`;
      else if (fs.existsSync(path.join(target, 'index.js'))) target = path.join(target, 'index.js');
      else continue;
      stack.push(target);
    }
  }
  return [...seen].map((file) => `/${path.relative(distRoot, file).split(path.sep).join('/')}`);
}

test('VS Code 可靠产品组合根只装配新 SQLite/CAS Runtime 且不可达旧 writer', () => {
  const entry = path.join(
    distRoot,
    'backend/application/reliableKernel/VscodeReliableKernelProductRuntime.js'
  );
  assert.equal(fs.existsSync(entry), true);
  const graph = emittedRequireClosure(entry);
  const forbidden = [
    '/backend/reliability/',
    '/backend/application/BackendApplication.js',
    '/backend/world/modules/agentRun/',
    '/backend/application/conversationFork.js',
    '/backend/capabilities/vscodeStorage/clientStateStore.js',
    '/shared/runLifecycle.js',
    '/shared/agentRunActivity.js'
  ];
  for (const selector of forbidden) {
    assert.equal(
      graph.some((file) => file.includes(selector)),
      false,
      `${path.relative(distRoot, entry)} reaches ${selector}`
    );
  }
  assert.ok(graph.includes('/backend/reliableKernel/runtimeApplication.js'));
  assert.ok(graph.includes('/backend/reliableKernel/childAgentCoordinator.js'));
  assert.ok(graph.includes('/backend/reliableKernel/llmCapabilityProviderRegistry.js'));
  assert.ok(graph.includes('/backend/reliableKernel/toolDispatcher.js'));
  assert.ok(graph.includes('/backend/application/reliableKernel/VscodeReliableFileDiffEditor.js'));
});

test('扩展先注册可见界面再启动后台恢复，激活不等待全库扫描', () => {
  const extensionSource = fs.readFileSync(path.resolve('vscode/extension.ts'), 'utf8');
  const sidebarRegistration = extensionSource.indexOf('registerSidebarEntryView(context, application)');
  const hydrationStart = extensionSource.indexOf('application.startHydration()');
  const recoveryStart = extensionSource.indexOf('application.startRuntimeRecovery()');
  assert.ok(sidebarRegistration >= 0, 'extension activation must register the sidebar');
  assert.ok(hydrationStart > sidebarRegistration, 'history hydration must start only after the visible surface');
  assert.ok(recoveryStart > sidebarRegistration, 'durable recovery must start only after the VS Code surface is registered');
  assert.equal(/await\s+application\.startHydration\(\)/.test(extensionSource), false);
  assert.equal(
    /await\s+application\.startRuntimeRecovery\(\)/.test(extensionSource),
    false,
    'extension activation must not wait for the full durable recovery scan'
  );

  const productSource = fs.readFileSync(
    path.resolve('backend/application/reliableKernel/VscodeReliableKernelProductRuntime.ts'),
    'utf8'
  );
  const openStart = productSource.indexOf('public static async open(');
  const recoveryMethodStart = productSource.indexOf('public startRecovery()');
  assert.ok(openStart >= 0 && recoveryMethodStart > openStart);
  assert.equal(
    productSource.slice(openStart, recoveryMethodStart).includes('application.recover()'),
    false,
    'product composition must not hide a blocking recovery scan inside open()'
  );
  assert.equal(
    /await\s+toolHost\.initialize\(\)/.test(productSource.slice(openStart, recoveryMethodStart)),
    false,
    'skills/rules/MCP discovery must not block product open'
  );
  assert.equal(
    /await\s+configuration\.synchronizeWorkspaceFolders/.test(productSource.slice(openStart, recoveryMethodStart)),
    false,
    'workspace configuration synchronization must be lazy until post-activation startup'
  );
});

test('MCP discovery starts in background and does not hold builtin capability readiness', () => {
  const source = fs.readFileSync(
    path.resolve('backend/application/reliableKernel/VscodeReliableToolHost.ts'),
    'utf8'
  );
  const initializeStart = source.indexOf('public initialize(): Promise<void>');
  const initializeEnd = source.indexOf('public setStateChangeListener', initializeStart);
  assert.ok(initializeStart >= 0 && initializeEnd > initializeStart);
  const initialize = source.slice(initializeStart, initializeEnd);
  const coreWait = initialize.match(/this\.initialization \?\?= Promise\.all\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
  assert.match(coreWait, /this\.skills\.refresh\(\)/);
  assert.match(coreWait, /this\.rules\.refresh\(\)/);
  assert.doesNotMatch(coreWait, /mcp\.refreshFromSettings/);
  assert.match(initialize, /this\.mcpInitialization \?\?= this\.mcp\.refreshFromSettings/);
  assert.match(initialize, /return this\.initialization/);
});


test('MCP discovery generations are cancellable and connect independent servers in parallel', () => {
  const source = fs.readFileSync(path.resolve('backend/application/mcpRuntimeManager.ts'), 'utf8');
  assert.match(source, /activeRefresh\?\.controller\.abort/);
  assert.match(source, /client\.connect\(transport, \{ signal \}\)/);
  assert.match(source, /client\.listTools\(undefined, \{ signal \}\)/);
  assert.match(source, /Promise\.all\(connectable\.map/);
  assert.doesNotMatch(source, /this\.refreshing\s*=\s*this\.refreshing\.then/);
});
