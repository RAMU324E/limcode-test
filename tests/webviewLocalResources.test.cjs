const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

class MockUri {
  constructor(scheme, authority, uriPath) {
    this.scheme = scheme;
    this.authority = authority || '';
    this.path = normalizeUriPath(uriPath);
    this.fsPath = this.scheme === 'file'
      ? /^\/[a-zA-Z]:\//.test(this.path) ? this.path.slice(1) : this.path
      : this.path;
  }
  static file(fsPath) {
    const normalized = String(fsPath).replace(/\\/g, '/');
    return new MockUri('file', '', /^[a-zA-Z]:\//.test(normalized) ? `/${normalized}` : normalized);
  }
  static from(value) { return new MockUri(value.scheme, value.authority, value.path); }
  static joinPath(base, ...segments) {
    return new MockUri(base.scheme, base.authority, [base.path.replace(/\/$/, ''), ...segments].join('/'));
  }
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
}

function normalizeUriPath(value) {
  const slashed = String(value || '/').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  return slashed.startsWith('/') ? slashed : `/${slashed}`;
}

const remoteAuthority = 'ssh-remote+example';
const vscodeMock = {
  Uri: MockUri,
  workspace: {
    workspaceFolders: [{
      uri: MockUri.from({ scheme: 'vscode-remote', authority: remoteAuthority, path: '/workspace/project' })
    }]
  }
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};
const {
  getWebviewHtml,
  getWebviewLocalResourceRoots,
  getWebviewStaticResourceRoots,
  resolveLocalFileSourceUri
} = require('../dist/extension/vscode/webview/getWebviewHtml.js');
Module._load = originalLoad;

const extensionUri = MockUri.from({
  scheme: 'vscode-remote',
  authority: remoteAuthority,
  path: '/home/user/.vscode/extensions/limcode'
});

test('设置页仍只加载扩展静态资源', () => {
  const roots = getWebviewStaticResourceRoots(extensionUri);
  assert.equal(roots.length, 1);
  assert.match(roots[0].toString(), /dist\/webview$/);
});

test('Remote POSIX 本地路径映射到远程扩展主机', () => {
  const roots = getWebviewLocalResourceRoots(extensionUri);
  const resolved = resolveLocalFileSourceUri('/tmp/shot.png', extensionUri);
  assert.ok(roots.some((uri) => uri.scheme === 'vscode-remote' && uri.path === '/'));
  assert.equal(resolved?.scheme, 'vscode-remote');
  assert.equal(resolved?.authority, remoteAuthority);
  assert.equal(resolved?.path, '/tmp/shot.png');
});

test('只有启用本地 Markdown 的页面注入资源映射', () => {
  const previousDevServer = process.env.VSCODE_WEBVIEW_DEV_SERVER;
  process.env.VSCODE_WEBVIEW_DEV_SERVER = 'http://127.0.0.1:31819';
  try {
    const webview = {
      cspSource: 'https://webview.test',
      asWebviewUri(uri) {
        return { toString: () => `https://resource.test/${encodeURIComponent(uri.scheme)}${uri.path}` };
      }
    };
    const enabled = getWebviewHtml(webview, extensionUri, { enableLocalFileResources: true });
    const disabled = getWebviewHtml(webview, extensionUri, { enableLocalFileResources: false });
    assert.match(enabled, /name="limcode-local-resource-mappings"/);
    assert.doesNotMatch(disabled, /limcode-local-resource-mappings/);
  } finally {
    if (previousDevServer === undefined) delete process.env.VSCODE_WEBVIEW_DEV_SERVER;
    else process.env.VSCODE_WEBVIEW_DEV_SERVER = previousDevServer;
  }
});
