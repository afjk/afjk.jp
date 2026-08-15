import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidSceneDocument } from '../../scenesync-export/viewer/scene-document.js';
import { validateSingleHtmlEmbeddedAssets } from '../../scenesync-export/export/single-html-format.js';
import {
  HANDOFF_SOURCE_STATES,
  canonicalizeJsonValue,
  createAckMessage,
  createHandoffMessage,
  createReadyMessage,
  isValidHandoffId,
  transitionHandoffSourceState,
  validateAckMessage,
  validateHandoffMessage,
} from './protocol.js';

const sessionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const requestId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const sceneDocument = {
  format: 'scene-sync-export-scene', version: 2,
  objects: [{ id: 'box', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }],
};
const embeddedAssets = { 'assets/image.png': { mime: 'image/png', base64: 'iVBORw==' } };
const validationOptions = {
  isValidSceneDocument,
  validateEmbeddedAssets: validateSingleHtmlEmbeddedAssets,
  expectedSessionId: sessionId,
  expectedRequestId: requestId,
};

function message(overrides = {}) {
  return createHandoffMessage({ sessionId, requestId, sceneDocument, embeddedAssets, ...overrides });
}

test('protocol binds READY, SEND, and minimal ACK to session/request IDs', () => {
  assert.equal(isValidHandoffId('a'.repeat(21)), false);
  assert.equal(isValidHandoffId('a'.repeat(22)), true);
  assert.deepEqual(createReadyMessage({ sessionId, requestId }), {
    type: 'scene-sync-ready', version: 1, sessionId, requestId,
  });
  assert.deepEqual(message({ roomId: ' My ROOM! ' }), {
    type: 'scene-sync-handoff', version: 1, sessionId, requestId,
    roomId: 'myroom', mode: 'add', sceneDocument, embeddedAssets,
  });
  const ack = createAckMessage({ sessionId, requestId, ok: true });
  assert.deepEqual(ack, {
    type: 'scene-sync-handoff-ack', version: 1, sessionId, requestId, status: 'ok',
  });
  assert.equal(validateAckMessage(ack, { sessionId, requestId }).ok, true);
  assert.equal(validateAckMessage(ack, { sessionId, requestId: sessionId }).reason, 'handoff-session-mismatch');
});

test('handoff validates URL-authoritative room, type, version, mode, document, and assets', () => {
  const valid = message({ roomId: 'room-42' });
  assert.equal(validateHandoffMessage(valid, { ...validationOptions, expectedRoomId: 'room-42' }).valid, true);
  assert.equal(validateHandoffMessage(message(), validationOptions).valid, true);
  const cases = [
    [{ ...message(), type: 'wrong' }, 'invalid-handoff-type'],
    [{ ...message(), version: 2 }, 'unsupported-handoff-version'],
    [{ ...message(), requestId: sessionId }, 'handoff-session-mismatch'],
    [{ ...message(), mode: 'replace' }, 'unsupported-handoff-mode'],
    [{ ...valid, roomId: 'Room!' }, 'invalid-handoff-room-id'],
    [valid, 'handoff-room-mismatch'],
    [message({ sceneDocument: {} }), 'invalid-handoff-scene-document'],
    [message({ embeddedAssets: [] }), 'invalid-single-html-assets'],
    [message({ embeddedAssets: { '../escape.glb': embeddedAssets['assets/image.png'] } }), 'invalid-single-html-assets'],
  ];
  for (const [candidate, reason] of cases) {
    assert.equal(validateHandoffMessage(candidate, validationOptions).reason, reason);
  }
});

test('handoff accepts only an http(s), credential-free URL payload exclusive of embedded data', () => {
  const urlMessage = createHandoffMessage({ sessionId, requestId, sourceUrl: 'https://static.example/world/v4/' });
  const result = validateHandoffMessage(urlMessage, validationOptions);
  assert.equal(result.valid, true);
  assert.equal(result.sourceUrl, 'https://static.example/world/v4/');
  assert.equal(validateHandoffMessage({ ...urlMessage, sceneDocument, embeddedAssets }, validationOptions).reason, 'handoff-source-conflict');
  assert.equal(validateHandoffMessage({ ...urlMessage, sourceUrl: 'file:///tmp/scene.json' }, validationOptions).reason, 'invalid-handoff-source-url');
  assert.equal(validateHandoffMessage({ ...urlMessage, sourceUrl: 'https://u:p@static.example/a' }, validationOptions).reason, 'invalid-handoff-source-url');
  assert.equal(validateHandoffMessage({ ...urlMessage, sourceUrl: `https://static.example/${'a'.repeat(8192)}` }, validationOptions).reason, 'invalid-handoff-source-url');
});

test('strict canonical validation rejects structured-clone values that JSON would corrupt', () => {
  const cycle = { value: 1 };
  cycle.self = cycle;
  const invalidValues = [
    [cycle, 'handoff-cyclic-value'],
    [{ value: undefined }, 'handoff-non-json-value'],
    [{ value: 1n }, 'handoff-non-json-value'],
    [{ value: new Date() }, 'handoff-non-plain-object'],
    [{ value: Number.NaN }, 'handoff-non-finite-number'],
    [{ value: Number.POSITIVE_INFINITY }, 'handoff-non-finite-number'],
  ];
  for (const [value, reason] of invalidValues) {
    assert.equal(canonicalizeJsonValue(value).reason, reason);
  }
});

test('canonical objects safely preserve prototype-shaped JSON keys as own data', () => {
  const source = JSON.parse('{"__proto__":{"polluted":true},"constructor":"value","prototype":{"safe":true}}');
  const canonical = canonicalizeJsonValue(source);
  assert.equal(canonical.valid, true);
  assert.equal(Object.getPrototypeOf(canonical.value), null);
  assert.equal(Object.hasOwn(canonical.value, '__proto__'), true);
  assert.deepEqual(canonical.value.__proto__.polluted, true);
  assert.equal(canonical.value.constructor, 'value');
  assert.equal({}.polluted, undefined);

  const result = validateHandoffMessage(message({
    sceneDocument: {
      ...sceneDocument,
      metadata: JSON.parse('{"__proto__":{"polluted":true},"constructor":"scene"}'),
    },
  }), validationOptions);
  assert.equal(result.valid, true);
  assert.equal(Object.getPrototypeOf(result.sceneDocument.metadata), null);
  assert.equal(Object.hasOwn(result.sceneDocument.metadata, '__proto__'), true);
  assert.equal({}.polluted, undefined);
});

test('strict SceneDocument validation enforces finite exact transforms, IDs, duplicates, and limits', () => {
  const invalidObjects = [
    { ...sceneDocument.objects[0], position: [0, 0, 0, 1] },
    { ...sceneDocument.objects[0], rotation: [0, 0, 1] },
    { ...sceneDocument.objects[0], scale: [1, 1, Number.NaN] },
    { ...sceneDocument.objects[0], id: '' },
  ];
  for (const [index, object] of invalidObjects.entries()) {
    assert.equal(validateHandoffMessage(message({
      sceneDocument: { ...sceneDocument, objects: [object] },
    }), validationOptions).reason, index === 2 ? 'handoff-non-finite-number' : 'invalid-handoff-scene-object');
  }
  assert.equal(validateHandoffMessage(message({
    sceneDocument: { ...sceneDocument, objects: [sceneDocument.objects[0], { ...sceneDocument.objects[0] }] },
  }), validationOptions).reason, 'handoff-duplicate-object-id');
  assert.equal(validateHandoffMessage(message(), {
    ...validationOptions, limits: { maxObjectCount: 0 },
  }).reason, 'handoff-too-many-objects');
  assert.equal(validateHandoffMessage(message({
    sceneDocument: { ...sceneDocument, metadata: { nested: { deeper: true } } },
  }), { ...validationOptions, limits: { maxDepth: 2 } }).reason, 'handoff-too-deep');
  assert.equal(validateHandoffMessage(message(), {
    ...validationOptions, limits: { maxStringBytes: 1 },
  }).reason, 'handoff-strings-too-large');
});

test('handoff returns a detached canonical copy and reuses Single HTML size limits', () => {
  const original = message();
  const result = validateHandoffMessage(original, validationOptions);
  assert.equal(result.valid, true);
  assert.equal(Object.getPrototypeOf(result.message), null);
  assert.notEqual(result.message, original);
  assert.notEqual(result.sceneDocument, original.sceneDocument);
  original.sceneDocument.objects[0].position[0] = 99;
  assert.equal(result.sceneDocument.objects[0].position[0], 0);
  assert.equal(validateHandoffMessage(message(), {
    ...validationOptions, limits: { assetCount: 0 },
  }).reason, 'single-html-too-many-assets');
  assert.equal(validateHandoffMessage(message(), {
    ...validationOptions, limits: { documentBytes: 1 },
  }).reason, 'single-html-document-too-large');
});

test('handoff source state machine covers READY/SEND/ACK and failures', () => {
  let state = transitionHandoffSourceState(HANDOFF_SOURCE_STATES.IDLE, 'open');
  state = transitionHandoffSourceState(state, 'ready');
  assert.equal(state, HANDOFF_SOURCE_STATES.WAITING_ACK);
  assert.equal(transitionHandoffSourceState(state, 'ack'), HANDOFF_SOURCE_STATES.COMPLETE);
  assert.equal(transitionHandoffSourceState(HANDOFF_SOURCE_STATES.WAITING_READY, 'timeout'), HANDOFF_SOURCE_STATES.FAILED);
  assert.equal(transitionHandoffSourceState(HANDOFF_SOURCE_STATES.WAITING_ACK, 'closed'), HANDOFF_SOURCE_STATES.FAILED);
});
