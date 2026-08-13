import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalBase64MaxCharacters,
  decodeCanonicalBase64,
  isCanonicalBase64
} from '../../dist/extension/backend/capabilities/canonicalBase64.js';

const MIB = 1024 * 1024;
const ATTACHMENT_LIMIT_BYTES = 20 * MIB;

test('canonical base64 safely accepts an exact 20 MiB attachment', () => {
  const bytes = Buffer.alloc(ATTACHMENT_LIMIT_BYTES, 0xa5);
  const encoded = bytes.toString('base64');
  assert.equal(encoded.length, canonicalBase64MaxCharacters(ATTACHMENT_LIMIT_BYTES));

  const decoded = decodeCanonicalBase64(encoded, { maxBytes: ATTACHMENT_LIMIT_BYTES });
  assert.equal(decoded.byteLength, ATTACHMENT_LIMIT_BYTES);
  assert.equal(decoded.equals(bytes), true);
});

test('canonical base64 rejects over-limit input before Buffer allocation', () => {
  const oversized = Buffer.alloc(ATTACHMENT_LIMIT_BYTES + 1, 0x5a).toString('base64');
  assert.throws(
    () => decodeCanonicalBase64(oversized, { maxBytes: ATTACHMENT_LIMIT_BYTES }),
    (error) => error instanceof RangeError && /exceeds 20971520 bytes/.test(error.message)
  );
});

test('canonical base64 rejects permissive decoder inputs and noncanonical trailing bits', () => {
  for (const value of ['A', '!!!!', 'YW Jj', 'YWJj\n', 'Zh==', 'AAAA=']) {
    assert.equal(isCanonicalBase64(value), false, value);
    assert.throws(() => decodeCanonicalBase64(value), /canonical base64/);
  }
  assert.equal(decodeCanonicalBase64('Zg==').toString('utf8'), 'f');
});

test('multi-megabyte canonical base64 no longer uses a stack-growing RegExp', () => {
  const encoded = Buffer.alloc(4 * MIB, 0x41).toString('base64');
  assert.doesNotThrow(() => decodeCanonicalBase64(encoded));
});
