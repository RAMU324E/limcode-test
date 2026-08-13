import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareNativeCompactContentsMultimodal } from '../../dist/extension/backend/capabilities/llmProvider.js';

const MIB = 1024 * 1024;

test('Native Compact validates multi-megabyte canonical media without RegExp stack overflow', async () => {
  const bytes = Buffer.alloc(4 * MIB, 0x31);
  const contents = [{
    role: 'user',
    parts: [{
      inlineData: {
        mimeType: 'image/png',
        name: 'large.png',
        data: bytes.toString('base64'),
        sizeBytes: bytes.byteLength
      }
    }]
  }];

  const prepared = await prepareNativeCompactContentsMultimodal(contents, {
    settings: undefined
  });
  assert.equal(prepared[0].parts[0].inlineData.data, contents[0].parts[0].inlineData.data);
  assert.equal(prepared[0].parts[0].inlineData.sizeBytes, bytes.byteLength);
});

test('Native Compact still rejects noncanonical media and declared-size mismatches', async () => {
  await assert.rejects(
    prepareNativeCompactContentsMultimodal([{
      role: 'user',
      parts: [{ inlineData: { mimeType: 'image/png', name: 'bad.png', data: 'Zh==' } }]
    }], { settings: undefined }),
    (error) => error?.name === 'LlmNativeCompactMediaError' && /not canonical base64/.test(error.message)
  );

  await assert.rejects(
    prepareNativeCompactContentsMultimodal([{
      role: 'user',
      parts: [{ inlineData: { mimeType: 'image/png', name: 'wrong-size.png', data: 'Zg==', sizeBytes: 2 } }]
    }], { settings: undefined }),
    (error) => error?.name === 'LlmNativeCompactMediaError' && /declared 2 bytes but resolved 1/.test(error.message)
  );
});
