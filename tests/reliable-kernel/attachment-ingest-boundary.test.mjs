import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { AttachmentIngestService } from '../../dist/extension/backend/reliableKernel/attachmentIngest.js';

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
