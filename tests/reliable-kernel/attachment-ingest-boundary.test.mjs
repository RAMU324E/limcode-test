import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { AttachmentIngestService } from '../../dist/extension/backend/reliableKernel/attachmentIngest.js';
import {
  collectAttachmentCatalogFromStoredItems,
  renderAttachmentCatalog
} from '../../dist/extension/backend/reliableKernel/attachmentCatalog.js';
import { readFileTool } from '../../dist/extension/backend/world/modules/tools/definitions/readFile/index.js';

const MIB = 1024 * 1024;
const ATTACHMENT_LIMIT_BYTES = 20 * MIB;

function serviceFixture() {
  let prepareBatchCalls = 0;
  const contentStore = {
    async prepareBatch(_database, inputs) {
      prepareBatchCalls += 1;
      return inputs.map(({ content, contentType }, index) => {
        const bytes = Buffer.from(content);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        return {
          metadata: {
            id: `content-${index}-${sha256}`,
            content_type: contentType,
            sha256,
            byte_length: BigInt(bytes.byteLength),
            storage_key: `sha256/${sha256.slice(0, 2)}/${sha256}`,
            created_at: '2026-01-01T00:00:00.000Z'
          }
        };
      });
    }
  };
  const settingsAuthority = {
    async loadGlobalSettings(section) {
      assert.equal(section, 'attachments');
      return {
        section,
        settings: { maxStoredInlineFileMb: 20 },
        filePath: 'settings/attachments.json'
      };
    }
  };
  return {
    service: new AttachmentIngestService({}, contentStore, settingsAuthority),
    prepareBatchCalls: () => prepareBatchCalls
  };
}

function inlineAttachment(data, sizeBytes = undefined) {
  return {
    ok: true,
    parts: [{
      inlineData: {
        mimeType: 'image/png',
        name: 'twenty-megabytes.png',
        data,
        storage: 'embedded',
        status: 'available',
        ...(sizeBytes === undefined ? {} : { sizeBytes })
      }
    }]
  };
}

test('AttachmentIngest accepts an exact 20 MiB embedded attachment and externalizes it', async () => {
  const { service, prepareBatchCalls } = serviceFixture();
  const bytes = Buffer.alloc(ATTACHMENT_LIMIT_BYTES, 0x6d);
  const admission = await service.prepareValueAttachments(
    inlineAttachment(bytes.toString('base64'), bytes.byteLength),
    '20 MiB attachment'
  );

  assert.equal(admission.totalBytes, ATTACHMENT_LIMIT_BYTES);
  assert.equal(admission.attachments.length, 1);
  assert.equal(admission.attachments[0].sizeBytes, ATTACHMENT_LIMIT_BYTES);
  assert.equal(admission.value.parts[0].inlineData.data, undefined);
  assert.equal(admission.value.parts[0].inlineData.storage, 'managed');
  assert.equal(prepareBatchCalls(), 1);
});

test('AttachmentIngest rejects encoded data over 20 MiB before CAS preparation', async () => {
  const { service, prepareBatchCalls } = serviceFixture();
  const oversizedCanonicalLength = Math.ceil((ATTACHMENT_LIMIT_BYTES + 1) / 3) * 4;
  const oversized = 'A'.repeat(oversizedCanonicalLength);

  await assert.rejects(
    service.prepareValueAttachments(inlineAttachment(oversized), 'oversized attachment'),
    (error) => error?.name === 'AttachmentSizeLimitError'
      && /20971520 byte limit/.test(error.message)
  );
  assert.equal(prepareBatchCalls(), 0);
});

test('Attachment catalog keeps only lightweight immutable metadata across message, tool and compression envelopes', () => {
  const first = {
    attachmentId: 'attachment-pdf-one',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 42_000
  };
  const second = {
    attachmentId: 'attachment-image-two',
    name: 'diagram.png',
    mimeType: 'image/png',
    sizeBytes: 8_192
  };
  const items = [
    {
      contentType: 'application/vnd.limcode.message+json',
      content: JSON.stringify({
        role: 'user',
        parts: [{ inlineData: {
          ...first,
          sha256: 'a'.repeat(64),
          sourcePath: '/private/report.pdf',
          data: Buffer.from('must-not-enter-catalog').toString('base64'),
          storage: 'managed'
        } }]
      })
    },
    {
      contentType: 'application/vnd.limcode.context-tool-pair+json',
      content: JSON.stringify({
        kind: 'tool_pair',
        toolModelResult: {
          result: JSON.stringify({ ok: true, detail: { parts: [{ inlineData: {
            ...second,
            sha256: 'b'.repeat(64),
            storage: 'managed'
          } }] } })
        }
      })
    },
    {
      contentType: 'application/vnd.limcode.compression-contents+json',
      content: JSON.stringify({
        kind: 'compression_contents',
        version: 1,
        contents: [{ role: 'model', parts: [{ text: 'summary' }] }],
        attachmentCatalog: [first]
      })
    }
  ];

  const catalog = collectAttachmentCatalogFromStoredItems(items);
  assert.deepEqual(catalog, [first, second]);
  const rendered = renderAttachmentCatalog(catalog);
  assert.ok(rendered);
  const text = rendered.parts[0].text;
  assert.match(text, /read/);
  assert.match(text, /attachment-pdf-one/);
  assert.match(text, /attachment-image-two/);
  assert.doesNotMatch(text, /sha256|sourcePath|private|must-not-enter-catalog|data/);
});

test('read materializes an existing managed attachment by attachmentId without embedding bytes itself', async () => {
  const requested = [];
  const managed = {
    inlineData: {
      attachmentId: 'attachment-existing-pdf',
      name: 'existing.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 123_456,
      sha256: 'c'.repeat(64),
      storage: 'managed',
      status: 'available'
    }
  };
  const deps = {
    fs: new Proxy({}, { get: () => () => { throw new Error('filesystem must not run'); } }),
    command: {},
    workEnvironment: {},
    skills: {},
    attachments: {
      async reference(attachmentId) {
        requested.push(attachmentId);
        return structuredClone(managed);
      }
    }
  };
  const context = { settingsSnapshot: { enableMultimodalTools: true }, emit() {} };
  const result = await readFileTool.execute(
    { attachmentId: 'attachment-existing-pdf', mode: 'attachment', items: [{}] },
    deps,
    context
  );

  assert.equal(result.ok, true);
  assert.deepEqual(requested, ['attachment-existing-pdf']);
  assert.deepEqual(result.output, {
    attachmentId: 'attachment-existing-pdf',
    name: 'existing.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 123_456
  });
  assert.deepEqual(result.parts, [managed]);
  assert.equal(result.parts[0].inlineData.data, undefined);

  const missingMode = await readFileTool.execute(
    { attachmentId: 'attachment-existing-pdf' },
    deps,
    context
  );
  assert.equal(missingMode.ok, false);
  assert.match(String(missingMode.output), /mode="attachment"/);

  const conflict = await readFileTool.execute(
    { path: 'other.pdf', attachmentId: 'attachment-existing-pdf', mode: 'attachment' },
    deps,
    context
  );
  assert.equal(conflict.ok, false);
  assert.match(String(conflict.output), /exactly one/);
});
