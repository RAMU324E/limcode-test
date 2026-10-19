import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { URI } from 'vscode-uri';
import { createConfigurationUiGraph } from './configuration-ui-fixture.mjs';
import { compiled, installVscode, temporaryRoot } from './configuration-smoke-fixture.mjs';

const host = installVscode();
host.vscode.Uri = URI;
const { resolveDroppedResources } = compiled('backend/application/reliableKernel/droppedResources.js');
const { VscodeReliableKernelCommandRouter } = compiled('backend/application/reliableKernel/VscodeReliableKernelCommandRouter.js');
const T = compiled('shared/protocol.js').BridgeMessageType;
const originalDocument = globalThis.document;
let graph;
before(async () => { globalThis.document = new EventTarget(); graph = await createConfigurationUiGraph(); });
after(async () => {
  await graph?.close(); host.dispose();
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});

function dropEvent(values = {}, files = []) {
  return {
    shiftKey: true, prevented: false, stopped: false,
    dataTransfer: { files, items: files.map(file => ({ kind: 'file', getAsFile: () => file })),
      types: [...Object.keys(values), ...(files.length ? ['Files'] : [])], getData: type => values[type] ?? '' },
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }
  };
}

function editor(t, props = {}) {
  const f = graph.session(t), changes = [], attachments = [];
  const mounted = f.mount('RichEditor', { modelValue: '', 'onUpdate:modelValue': value => changes.push(value),
    'onPaste-files': files => attachments.push(files), ...props });
  const reply = (request, results) => f.receive({ id: `reply:${request.id}`, type: T.FsStatResult,
    correlationId: request.id, payload: { results } });
  return { ...f, mounted, changes, attachments, reply };
}

async function statDrop(paths, correlationId = 'drop') {
  const router = Object.create(VscodeReliableKernelCommandRouter.prototype), messages = [];
  await router.postFsStats({ async postMessage(message) { messages.push(message); return true; } }, paths, correlationId);
  return messages[0];
}

test('拖放解析合并裸路径、URI列表和VS Code资源JSON，不递归猜测无关字段', () => {
  const first = '/tmp/中文 file.ts', second = '/tmp/b.ts';
  const firstUri = URI.file(first), secondUri = URI.file(second);
  const resources = resolveDroppedResources([
    `${first}\n${second}`, `# resources\r\n${firstUri}\r\n${secondUri}`,
    JSON.stringify([first, second]), JSON.stringify([firstUri.toString(), secondUri.toString()]),
    JSON.stringify([{ resource: firstUri.toJSON() }, { resource: secondUri.with({ fragment: 'L2,1' }).toString(), contents: '/tmp/not-a-resource' }]),
    JSON.stringify(firstUri.toJSON()), JSON.stringify(first),
    'application/octet-stream:file.ts:file:///tmp/unrelated', 'https://example.com/file',
    '{bad json', JSON.stringify({ nested: { resource: '/tmp/ignored' }, contents: '/tmp/ignored' })
  ]);
  assert.deepEqual(resources.map(uri => uri.fsPath), [first, second]);
  assert.equal(resolveDroppedResources(['/tmp/a\\b.ts'])[0].fsPath, '/tmp/a\\b.ts');
});

test('Windows盘符与UNC路径只作路径转换，不破坏编码或远程URI身份', () => {
  const resources = resolveDroppedResources([
    'C:\\work\\中文 file.ts', 'file:///C:/work/%E4%B8%AD%E6%96%87%20file.ts',
    '\\\\server\\share\\file.ts', 'file://server/share/file.ts',
    'vscode-remote://ssh-remote+host/home/user/file.ts#L4',
    JSON.stringify([{ resource: { scheme: 'vscode-remote', authority: 'ssh-remote+host', path: '/home/user/file.ts' } }])
  ]);
  assert.equal(resources.length, 3);
  assert.equal(resources[0].path, '/C:/work/中文 file.ts');
  assert.equal(resources[1].authority, 'server');
  assert.equal(resources[1].path, '/share/file.ts');
  assert.equal(resources[2].scheme, 'vscode-remote');
  assert.equal(resources[2].authority, 'ssh-remote+host');
  assert.equal(resources[2].fragment, '');
});

test('真实Router对重复拖放格式每个文件只stat一次，返回文件、目录和不存在结果', async t => {
  const root = await temporaryRoot(t, 'drop-stat'), file = path.join(root, '中文 file.txt'), missing = path.join(root, 'missing');
  await fs.writeFile(file, 'test');
  const spy = t.mock.method(host.vscode.workspace.fs, 'stat');
  const message = await statDrop([`${file}\n${root}\n${missing}`, URI.file(file).toString(), JSON.stringify([file]),
    JSON.stringify([{ resource: URI.file(file).toJSON() }])]);
  assert.equal(spy.mock.callCount(), 3);
  assert.equal(message.correlationId, 'drop');
  assert.deepEqual(message.payload.results, [
    { path: file, exists: true, isDirectory: false },
    { path: root, exists: true, isDirectory: true },
    { path: missing, exists: false, isDirectory: false }
  ]);
});

test('远程拖放交给原URI文件系统，不改为宿主本地路径', async t => {
  const uri = URI.parse('vscode-remote://ssh-remote+host/home/user/file.ts');
  const spy = t.mock.method(host.vscode.workspace.fs, 'stat', async value => {
    assert.equal(value.scheme, uri.scheme);
    assert.equal(value.authority, uri.authority);
    assert.equal(value.path, uri.path);
    return { type: host.vscode.FileType.File };
  });
  const message = await statDrop([uri.toString()]);
  assert.equal(spy.mock.callCount(), 1);
  assert.equal(message.payload.results[0].path, uri.toString());
  assert.equal(message.payload.results[0].exists, true);
});

for (const kind of ['text/plain', 'text/uri-list', 'ResourceURLs', 'CodeEditors']) {
  test(`Shift拖入多文件通过实际编辑器与Router插入路径：${kind}`, async t => {
    const f = editor(t), root = await temporaryRoot(t, 'drop-editor');
    const files = [path.join(root, 'one.txt'), path.join(root, 'two.txt')];
    await Promise.all(files.map(file => fs.writeFile(file, 'test')));
    const uris = files.map(file => URI.file(file));
    const raw = kind === 'text/plain' ? files.join('\n') : kind === 'text/uri-list' ? uris.join('\r\n')
      : kind === 'ResourceURLs' ? JSON.stringify(uris.map(uri => uri.toString()))
        : JSON.stringify(uris.map(uri => ({ resource: uri.toJSON() })));
    const event = dropEvent({ [kind]: raw });
    f.mounted.view.onDrop(event);
    assert.equal(event.prevented, true);
    const request = f.last(T.FsStatGet);
    const message = await statDrop(request.payload.paths, request.id);
    f.receive(message);
    await graph.vue.nextTick();
    assert.equal(f.changes.length, 1);
    for (const file of files) assert.ok(f.changes[0].includes(`@${file}`));
    assert.deepEqual(f.attachments, []);
    f.receive(message);
    assert.equal(f.changes.length, 1, '处理完应移除订阅，重复回执不重复插入');
  });
}

test('只有标准File的拖放复用附件入口，不猜路径也不发stat请求', t => {
  const f = editor(t), file = new File(['hello'], 'note.txt', { type: 'text/plain' });
  const event = dropEvent({}, [file]);
  f.mounted.view.onDragOver(event);
  assert.equal(f.mounted.view.pathDragActive, true);
  f.mounted.view.onDrop(event);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(f.mounted.view.pathDragActive, false);
  assert.equal(f.messagesOf(T.FsStatGet).length, 0);
  assert.deepEqual(f.attachments, [[file]]);
});

test('File伴随无路径元数据时按附件处理；可解析但不存在的路径不伪装成附件', t => {
  const f = editor(t), file = new File(['hello'], 'note.txt', { type: 'text/plain' });
  f.mounted.view.onDrop(dropEvent({ 'text/plain': 'note.txt' }, [file]));
  f.reply(f.last(T.FsStatGet), []);
  assert.deepEqual(f.attachments, [[file]]);
  f.mounted.view.onDrop(dropEvent({ 'text/uri-list': 'file:///missing/note.txt' }, [file]));
  f.reply(f.last(T.FsStatGet), [{ path: '/missing/note.txt', exists: false, isDirectory: false }]);
  assert.equal(f.attachments.length, 1);
  assert.deepEqual(f.changes, []);
});

test('禁用输入框不接受拖放', t => {
  const disabled = editor(t, { disabled: true });
  disabled.mounted.view.onDrop(dropEvent({ 'text/plain': '/tmp/a.ts' }));
  assert.equal(disabled.messagesOf(T.FsStatGet).length, 0);
  assert.deepEqual(disabled.changes, []);
});

test('拖放只处理自身回执，错误与组件卸载会释放订阅', t => {
  const f = editor(t);
  const results = [{ path: '/tmp/a.ts', exists: true, isDirectory: false }];
  f.mounted.view.onDrop(dropEvent({ 'text/plain': '/tmp/a.ts' }));
  const request = f.last(T.FsStatGet);
  f.reply({ id: 'unrelated' }, results);
  assert.deepEqual(f.changes, []);
  f.receive({ type: T.Error, correlationId: request.id, payload: { message: 'failed' } });
  f.reply(request, results);
  assert.deepEqual(f.changes, []);
  f.mounted.view.onDrop(dropEvent({ 'text/plain': '/tmp/a.ts' }));
  const unmountedRequest = f.last(T.FsStatGet);
  f.mounted.unmount();
  f.reply(unmountedRequest, results);
  assert.deepEqual(f.changes, []);
});
