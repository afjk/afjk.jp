import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_INLINE_HANDOFF_ENCODED_BYTES,
  MAX_INLINE_HANDOFF_DECODED_BYTES,
  decodeInlineHandoffPayload,
  encodeInlineHandoffPayload,
  isInlineHandoffEnvelopeEligible,
} from './inline-payload.js';

function envelope(embeddedAssets) {
  return {
    kind: 'scene-sync-inline-handoff', version: 1,
    sessionId: 's'.repeat(22), requestId: 'r'.repeat(22), roomId: null,
    payload: { version: 1, mode: 'embedded', sceneDocument: { format: 'scene-sync-export-scene', version: 2, objects: [] }, embeddedAssets },
  };
}

function base64Bytes(bytes) {
  return Buffer.alloc(bytes).toString('base64');
}

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

test('inline source eligibility shares 64 KiB asset and 32 asset-count boundaries', () => {
  assert.equal(isInlineHandoffEnvelopeEligible(envelope({
    'assets/boundary.bin': { mime: 'application/octet-stream', base64: base64Bytes(64 * 1024) },
  })), true);
  assert.equal(isInlineHandoffEnvelopeEligible(envelope({
    'assets/too-large.bin': { mime: 'application/octet-stream', base64: base64Bytes(64 * 1024 + 1) },
  })), false);
  const thirtyTwo = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [
    `assets/${index}.bin`, { mime: 'application/octet-stream', base64: base64Bytes(1) },
  ]));
  assert.equal(isInlineHandoffEnvelopeEligible(envelope(thirtyTwo)), true);
  assert.equal(isInlineHandoffEnvelopeEligible(envelope({
    ...thirtyTwo,
    'assets/33.bin': { mime: 'application/octet-stream', base64: base64Bytes(1) },
  })), false);
});
