import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomFillSync } from 'node:crypto';
import { test } from 'node:test';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const { prepareLlmStartRequestMultimodal, prepareNativeCompactContentsMultimodal } =
  require('../../dist/extension/backend/capabilities/llmRequestContentPreparation.js');
const { normalizeHistoryImageSettings } = require('../../dist/extension/shared/historyImages.js');
const pixels = randomFillSync(Buffer.alloc(1024 * 1536 * 3));
const png = await sharp(pixels, { raw: { width: 1024, height: 1536, channels: 3 } }).png().toBuffer();
const image = id => ({ inlineData: {
  attachmentId: id, mimeType: 'image/png', name: 'source.png', data: png.toString('base64'), sizeBytes: png.length
} });
const request = (contents, historyImages = { maxDimension: 1024, maxMB: 16 }) => ({
  id: 'images', contents, tools: [], settingsSnapshot: { historyImages }
});

test('历史消息及工具图片缩小，当前上传保留原图，原始附件和签名不变，后续请求复用缩图', async () => {
  const historical = image('historical'), toolImage = image('tool-image'), current = image('current');
  const contents = [
    { role: 'user', parts: [{ text: 'compare images' }, historical] },
    { role: 'model', parts: [{ id: 'read-1', functionCall: { name: 'read', args: {} }, thoughtSignature: 'keep-signature' }] },
    { role: 'user', parts: [{ id: 'read-1', functionResponse: { name: 'read', response: { output: 'original metadata' }, parts: [toolImage] } }] },
    { role: 'user', parts: [current] }
  ];
  const before = structuredClone(contents);
  const input = { ...request(contents), currentTurnImageAttachmentIds: ['current'] };
  const output = await prepareLlmStartRequestMultimodal(input, {});
  const resized = output.contents[0].parts[1];
  const nested = output.contents[2].parts[0].functionResponse.parts[0];
  for (const part of [resized, nested]) {
    const metadata = await sharp(Buffer.from(part.inlineData.data, 'base64')).metadata();
    assert.deepEqual([metadata.width, metadata.height], [683, 1024]);
    assert.equal(part.inlineData.attachmentId, undefined);
    assert.ok(part.inlineData.data.length < historical.inlineData.data.length);
  }
  assert.equal(output.contents[3].parts[0].inlineData.data, current.inlineData.data);
  assert.equal(output.contents[1].parts[0].thoughtSignature, 'keep-signature');
  assert.deepEqual(output.contents[2].parts[0].functionResponse.response, { output: 'original metadata' });
  assert.deepEqual(contents, before);

  // Cached inputs bypass both attachment reading and image encoding on later requests.
  const reference = { inlineData: { attachmentId: 'historical', mimeType: 'image/png' } };
  const cached = await prepareLlmStartRequestMultimodal(request([{ role: 'user', parts: [reference] }]), {
    resolveAttachment() { throw new Error('cached image should not be reread'); }
  });
  assert.equal(cached.contents[0].parts[0].inlineData.data, resized.inlineData.data);
});

test('预算累计每次出现的 base64 长度，包含当前图片；关闭省略时超限报错，0 可关闭限制', async () => {
  const tiny = { inlineData: { mimeType: 'image/png', data: 'a'.repeat(600_000) } };
  const contents = [{ role: 'user', parts: [tiny, tiny] }];
  const before = structuredClone(contents);
  await assert.rejects(prepareLlmStartRequestMultimodal(request(contents, { maxDimension: 0, maxMB: 1, omitOldestEnabled: false }), {}),
    error => error.code === 'image_budget_exceeded' && /1 MB/.test(error.message));
  assert.deepEqual(contents, before);
  assert.equal((await prepareLlmStartRequestMultimodal(request(contents, { maxDimension: 0, maxMB: 0 }), {}))
    .contents[0].parts.length, 2);
  const exact = await prepareLlmStartRequestMultimodal(request([{ role: 'user', parts: [
    { inlineData: { mimeType: 'image/png', data: 'a'.repeat(1_000_000) } }
  ] }], { maxDimension: 0, maxMB: 1 }), {});
  assert.equal(exact.contents[0].parts[0].inlineData.data.length, 1_000_000);
  await assert.rejects(prepareLlmStartRequestMultimodal({
    ...request([{ role: 'user', parts: [image('large-current')] }], { maxDimension: 1024, maxMB: 1 }),
    currentTurnImageAttachmentIds: ['large-current']
  }, {}), { code: 'image_budget_exceeded' });
  await assert.rejects(prepareLlmStartRequestMultimodal({
    ...request([{ role: 'user', parts: [{ inlineData: { attachmentId: 'resolved-current', mimeType: 'image/png' } }] }], { maxMB: 1 }),
    currentTurnImageAttachmentIds: ['resolved-current']
  }, { async resolveAttachment() { return { inlineData: { mimeType: 'image/png', data: 'a'.repeat(1_000_001) } }; } }),
  { code: 'image_budget_exceeded' });
});

test('缩图、体积限制与历史省略独立生效，关闭不会改变原始图片', async () => {
  const contents = [{ role: 'user', parts: [image('switch-combinations')] }];
  const before = structuredClone(contents);
  for (const resizeEnabled of [false, true]) {
    for (const limitEnabled of [false, true]) {
      for (const omitOldestEnabled of [false, true]) {
        const promise = prepareLlmStartRequestMultimodal(request(contents, {
          resizeEnabled, limitEnabled, omitOldestEnabled, maxDimension: 1024, maxMB: 4
        }), {});
        if (!resizeEnabled && limitEnabled && !omitOldestEnabled) {
          await assert.rejects(promise, { code: 'image_budget_exceeded' });
          continue;
        }
        const part = (await promise).contents[0].parts[0];
        if (!resizeEnabled && limitEnabled) assert.match(part.text, /历史图片本次未发送/);
        else if (resizeEnabled) assert.ok(part.inlineData.data.length < contents[0].parts[0].inlineData.data.length);
        else assert.equal(part.inlineData.data, contents[0].parts[0].inlineData.data);
      }
    }
  }
  assert.deepEqual(contents, before);
});

test('同图并发首次只缩放一次，关闭再开启缩图复用缓存且仍按发送次数计预算', async () => {
  const originalSharp = require('sharp'), sharpModule = require.cache[require.resolve('sharp')];
  let encodes = 0, reads = 0;
  sharpModule.exports = new Proxy(originalSharp, { apply(target, self, args) {
    encodes++;
    return Reflect.apply(target, self, args);
  } });
  const source = image('concurrent-toggle-cache');
  const reference = { inlineData: { attachmentId: source.inlineData.attachmentId, mimeType: 'image/png' } };
  const contents = [{ role: 'user', parts: [reference, reference] }];
  const options = { async resolveAttachment() { reads++; return source; } };
  try {
    const resized = await prepareLlmStartRequestMultimodal(request(contents), options);
    assert.equal(encodes, 1);
    assert.equal(reads, 1);
    const original = await prepareLlmStartRequestMultimodal(request(contents, { resizeEnabled: false, maxMB: 0 }), options);
    assert.equal(original.contents[0].parts[0].inlineData.data, source.inlineData.data);
    assert.equal(encodes, 1);
    assert.equal(reads, 2);
    const reused = await prepareLlmStartRequestMultimodal(request(contents, { maxMB: 4 }), {
      resolveAttachment() { throw new Error('re-enabled image should reuse cached bytes'); }
    });
    assert.match(reused.contents[0].parts[0].text, /历史图片本次未发送/);
    assert.equal(reused.contents[0].parts[1].inlineData.data, resized.contents[0].parts[1].inlineData.data);
    assert.equal(encodes, 1);
  } finally { sharpModule.exports = originalSharp; }
});

test('超限从最旧历史开始省略，忽略异步读取顺序，保留工具结果、当前图片、签名和原件', async () => {
  const reference = id => ({ inlineData: { attachmentId: id, mimeType: 'image/png', name: `${id}.png` } });
  const contents = [
    { role: 'user', parts: [{ text: 'old text' }, reference('oldest')] },
    { role: 'model', parts: [{ id: 'read', functionCall: { name: 'read', args: {} }, thoughtSignature: 'signature' }] },
    { role: 'user', parts: [{ id: 'read', functionResponse: { name: 'read', response: { output: 'keep result' }, parts: [reference('middle')] } }] },
    { role: 'user', parts: [reference('newest'), reference('current')] }
  ];
  const before = structuredClone(contents), completed = [];
  let releaseOldest;
  const oldestReady = new Promise(resolve => { releaseOldest = resolve; });
  const result = await prepareLlmStartRequestMultimodal({
    ...request(contents, { resizeEnabled: false, maxMB: 1 }), currentTurnImageAttachmentIds: ['current']
  }, { async resolveAttachment({ attachmentId }) {
    if (attachmentId === 'oldest') await oldestReady;
    if (attachmentId === 'current') releaseOldest();
    completed.push(attachmentId);
    return { inlineData: { attachmentId, mimeType: 'image/png', data: 'a'.repeat(attachmentId === 'current' ? 200_000 : 600_000) } };
  } });
  assert.equal(completed.at(-1), 'oldest');
  assert.equal(result.contents[0].parts[0].text, 'old text');
  assert.match(result.contents[0].parts[1].text, /oldest/);
  assert.equal(result.contents[1].parts[0].thoughtSignature, 'signature');
  const response = result.contents[2].parts[0];
  assert.equal(response.id, 'read');
  assert.equal(response.functionResponse.name, 'read');
  assert.equal(response.functionResponse.response.output, 'keep result');
  assert.match(response.functionResponse.response.multimodalAttachmentPlaceholders[0], /middle/);
  assert.deepEqual(response.functionResponse.parts, []);
  assert.deepEqual(result.contents[3].parts.map(part => part.inlineData.attachmentId), ['newest', 'current']);
  assert.deepEqual(contents, before);
});

test('原图设置、纯文字、PDF 与原生压缩沿用各自输入；冻结策略优先于当前设置', async () => {
  const original = image('original-policy');
  const input = request([{ role: 'user', parts: [original] }], { maxDimension: 0, maxMB: 0 });
  const output = await prepareLlmStartRequestMultimodal(input, {}, undefined, { maxDimension: 512, maxMB: 1 });
  assert.equal(output.contents[0].parts[0].inlineData.data, original.inlineData.data);
  const pdf = { inlineData: { mimeType: 'application/pdf', data: 'a'.repeat(2_000_000) } };
  const mixed = request([{ role: 'user', parts: [{ text: 'text' }, pdf] }], { maxDimension: 1024, maxMB: 1 });
  assert.deepEqual((await prepareLlmStartRequestMultimodal(mixed, {})).contents, mixed.contents);
  assert.deepEqual(await prepareNativeCompactContentsMultimodal(input.contents, {}), input.contents);
  assert.deepEqual(normalizeHistoryImageSettings(), {
    resizeEnabled: true, limitEnabled: true, omitOldestEnabled: true, maxDimension: 1024, maxMB: 16
  });
  assert.deepEqual(normalizeHistoryImageSettings({ resizeEnabled: false, limitEnabled: false, omitOldestEnabled: false, maxDimension: 2048, maxMB: 3 }),
    { resizeEnabled: false, limitEnabled: false, omitOldestEnabled: false, maxDimension: 2048, maxMB: 3 });
});
