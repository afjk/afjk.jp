import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_INLINE_HANDOFF_ENCODED_BYTES,
  MAX_INLINE_HANDOFF_DECODED_BYTES,
  decodeInlineHandoffPayload,
  encodeInlineHandoffPayload,
} from './inline-payload.js';

test('inline payload encoding round-trips compact UTF-8 JSON', () => {
  const payload = { version: 1, mode: 'embedded', sceneDocument: { title: '小さな scene' }, embeddedAssets: {} };
  const encoded = encodeInlineHandoffPayload(payload);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/u);
  assert.deepEqual(decodeInlineHandoffPayload(encoded), { valid: true, value: payload });
});

test('inline payload decoder rejects malformed, oversized, and invalid UTF-8 encodings', () => {
  assert.equal(decodeInlineHandoffPayload('%%%').valid, false);
  assert.equal(decodeInlineHandoffPayload('wA').valid, false, 'invalid UTF-8 is rejected');
  assert.equal(decodeInlineHandoffPayload('a'.repeat(MAX_INLINE_HANDOFF_ENCODED_BYTES + 1)).valid, false);
  assert.equal(encodeInlineHandoffPayload({ value: 'x'.repeat(129 * 1024) }), null, 'sources stay under the conservative 128 KiB cap');
  assert.equal(encodeInlineHandoffPayload({ value: 'x'.repeat(385 * 1024) }, { maxDecodedBytes: MAX_INLINE_HANDOFF_DECODED_BYTES }), null);
});
