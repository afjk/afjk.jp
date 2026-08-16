import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHandoffTokenPayload } from '../../../html/assets/js/scenesync/handoff/token-payload.js';
import { validateHandoffTokenPayload as validateServerPayload } from '../src/scenesync/handoff-token-payload.mjs';

const sceneDocument = () => ({
  format: 'scene-sync-export-scene', version: 2,
  objects: [{ id: 'cube', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }],
});

test('accepts canonical embedded and URL handoff token payloads', () => {
  const embedded = validateHandoffTokenPayload({ version: 1, mode: 'embedded', sceneDocument: sceneDocument(), embeddedAssets: { 'assets/a.txt': { mime: 'text/plain', base64: 'aGk=' } } });
  assert.equal(embedded.valid, true);
  assert.equal(Object.getPrototypeOf(embedded.payload), null);
  assert.equal(validateHandoffTokenPayload({ version: 1, mode: 'url', sourceUrl: 'https://example.test/export/' }).valid, true);
});

test('rejects invalid token payload schemas, unsafe base64, paths, MIME, and pollution', () => {
  const base = { version: 1, mode: 'embedded', sceneDocument: sceneDocument(), embeddedAssets: {} };
  assert.equal(validateHandoffTokenPayload({ ...base, embeddedAssets: { 'x.bin': { mime: 'application/octet-stream', base64: 'nope!' } } }).valid, false);
  assert.equal(validateHandoffTokenPayload({ ...base, embeddedAssets: { '../x': { mime: 'application/octet-stream', base64: '' } } }).valid, false);
  assert.equal(validateHandoffTokenPayload({ ...base, embeddedAssets: { 'x.svg': { mime: 'image/svg+xml', base64: '' } } }).valid, false);
  assert.equal(validateHandoffTokenPayload(JSON.parse('{"version":1,"mode":"embedded","sceneDocument":{"format":"scene-sync-export-scene","version":2,"objects":[]},"embeddedAssets":{"__proto__":{"mime":"text/plain","base64":""}}}')).valid, false);
  assert.equal(validateHandoffTokenPayload({ version: 1, mode: 'url', sourceUrl: 'https://user:pass@example.test/a' }).valid, false);
});

test('enforces decoded asset and scene document limits', () => {
  const base = { version: 1, mode: 'embedded', sceneDocument: sceneDocument(), embeddedAssets: {} };
  assert.equal(validateHandoffTokenPayload({ ...base, embeddedAssets: { 'x.bin': { mime: 'application/octet-stream', base64: 'AAAA' } } }, { maxDecodedBytes: 2 }).valid, false);
  assert.equal(validateHandoffTokenPayload(base, { maxSceneDocumentBytes: 10 }).valid, false);
});

test('browser and Docker-local validator agree on the shared payload corpus', () => {
  const corpus = [
    { version: 1, mode: 'embedded', sceneDocument: sceneDocument(), embeddedAssets: { 'a.txt': { mime: 'text/plain', base64: 'aGk=' } } },
    { version: 1, mode: 'url', sourceUrl: 'https://example.test/static/' },
    { version: 1, mode: 'url', sourceUrl: 'https://u:p@example.test/' },
    { version: 1, mode: 'embedded', sceneDocument: sceneDocument(), embeddedAssets: { '../bad': { mime: 'text/plain', base64: '' } } },
    { version: 1, mode: 'embedded', sceneDocument: sceneDocument(), embeddedAssets: { 'bad.svg': { mime: 'image/svg+xml', base64: '' } } },
    { version: 1, mode: 'embedded', sceneDocument: sceneDocument(), embeddedAssets: { 'bad.bin': { mime: 'application/octet-stream', base64: '!' } } },
  ];
  for (const value of corpus) assert.equal(validateServerPayload(value).valid, validateHandoffTokenPayload(value).valid);
});
