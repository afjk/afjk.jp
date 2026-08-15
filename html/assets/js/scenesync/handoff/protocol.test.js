import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidSceneDocument } from '../../scenesync-export/viewer/scene-document.js';
import { validateSingleHtmlEmbeddedAssets } from '../../scenesync-export/export/single-html-format.js';
import {
  HANDOFF_SOURCE_STATES,
  createAckMessage,
  createHandoffMessage,
  createReadyMessage,
  transitionHandoffSourceState,
  validateAckMessage,
  validateHandoffMessage,
} from './protocol.js';

const sceneDocument = {
  format: 'scene-sync-export-scene',
  version: 2,
  objects: [{
    id: 'box', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
  }],
};
const embeddedAssets = {
  'assets/image.png': { mime: 'image/png', base64: 'iVBORw==' },
};
const validationOptions = { isValidSceneDocument, validateEmbeddedAssets: validateSingleHtmlEmbeddedAssets };

test('handoff protocol creates READY, sanitized SEND, and metadata-free ACK messages', () => {
  assert.deepEqual(createReadyMessage(), { type: 'scene-sync-ready', version: 1 });
  assert.deepEqual(createHandoffMessage({
    roomId: ' My ROOM! ', sceneDocument, embeddedAssets,
  }), {
    type: 'scene-sync-handoff', version: 1, roomId: 'myroom', mode: 'add', sceneDocument, embeddedAssets,
  });
  assert.deepEqual(createAckMessage({ ok: true }), {
    type: 'scene-sync-handoff-ack', version: 1, status: 'ok',
  });
  assert.equal(validateAckMessage(createAckMessage({ ok: true })).ok, true);
});

test('handoff validates optional room and rejects invalid type, version, mode, document, and assets', () => {
  const valid = createHandoffMessage({ roomId: 'room-42', sceneDocument, embeddedAssets });
  assert.equal(validateHandoffMessage(valid, validationOptions).valid, true);
  assert.equal(validateHandoffMessage(createHandoffMessage({ sceneDocument, embeddedAssets }), validationOptions).valid, true);

  const cases = [
    [{ ...valid, type: 'wrong' }, 'invalid-handoff-type'],
    [{ ...valid, version: 2 }, 'unsupported-handoff-version'],
    [{ ...valid, mode: 'replace' }, 'unsupported-handoff-mode'],
    [{ ...valid, roomId: 'Room!' }, 'invalid-handoff-room-id'],
    [{ ...valid, sceneDocument: {} }, 'invalid-handoff-scene-document'],
    [{ ...valid, embeddedAssets: [] }, 'invalid-single-html-assets'],
    [{ ...valid, embeddedAssets: { '../escape.glb': embeddedAssets['assets/image.png'] } }, 'invalid-single-html-assets'],
  ];
  for (const [message, reason] of cases) {
    assert.equal(validateHandoffMessage(message, validationOptions).reason, reason);
  }
});

test('handoff reuses Single HTML count, per-asset, total, and document limits', () => {
  const message = createHandoffMessage({ sceneDocument, embeddedAssets });
  assert.equal(validateHandoffMessage(message, {
    ...validationOptions, limits: { assetCount: 0 },
  }).reason, 'single-html-too-many-assets');
  assert.equal(validateHandoffMessage(message, {
    ...validationOptions, limits: { assetBytes: 1 },
  }).reason, 'single-html-asset-too-large');
  assert.equal(validateHandoffMessage(message, {
    ...validationOptions, limits: { totalAssetBytes: 1 },
  }).reason, 'single-html-assets-too-large');
  assert.equal(validateHandoffMessage(message, {
    ...validationOptions, limits: { documentBytes: 1 },
  }).reason, 'single-html-document-too-large');
});

test('handoff source state machine covers READY/SEND/ACK and failures', () => {
  let state = transitionHandoffSourceState(HANDOFF_SOURCE_STATES.IDLE, 'open');
  assert.equal(state, HANDOFF_SOURCE_STATES.WAITING_READY);
  state = transitionHandoffSourceState(state, 'ready');
  assert.equal(state, HANDOFF_SOURCE_STATES.WAITING_ACK);
  state = transitionHandoffSourceState(state, 'ack');
  assert.equal(state, HANDOFF_SOURCE_STATES.COMPLETE);
  assert.equal(transitionHandoffSourceState(HANDOFF_SOURCE_STATES.WAITING_READY, 'timeout'), HANDOFF_SOURCE_STATES.FAILED);
  assert.equal(transitionHandoffSourceState(HANDOFF_SOURCE_STATES.WAITING_ACK, 'closed'), HANDOFF_SOURCE_STATES.FAILED);
  assert.equal(transitionHandoffSourceState(HANDOFF_SOURCE_STATES.IDLE, 'blocked'), HANDOFF_SOURCE_STATES.FAILED);
});
