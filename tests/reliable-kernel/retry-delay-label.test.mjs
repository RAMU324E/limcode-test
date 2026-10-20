import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

test('重试提示区分服务端等待、本地设置和强制重试', async () => {
  const server = await createWebviewSsrServer();
  try {
    const { reliableRetryDelaySourceLabel: label } = await server.ssrLoadModule(
      `${process.cwd()}/webview/src/domain/reliableTransientActivity.ts`);
    assert.equal(label({ retryConfiguredDelayMs: 3000, retryProviderDelayMs: 300_000, retryDelayMs: 300_000 }),
      '服务端要求至少等待 300 秒（本地设置：3 秒）');
    assert.equal(label({ retryConfiguredDelayMs: 3000, retryProviderDelayMs: 1000, retryDelayMs: 3000 }),
      '按本地设置（3 秒）');
    assert.equal(label({ retryConfiguredDelayMs: 3000, retryProviderDelayMs: 0, retryForced: true }),
      '强制重试，按本地设置（3 秒），忽略服务端等待');
    assert.equal(label({ retryConfiguredDelayMs: 0, retryForced: true }),
      '强制重试，按本地设置（自动退避），忽略服务端等待');
    assert.equal(label({ retryDelayMs: 300_000 }), '', 'older records do not invent a wait source');
  } finally { await server.close(); }
});
