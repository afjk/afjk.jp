import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the production sender with its scene/transport collaborators supplied.
// This catches omitted fields in the actual late-join response, without booting WebGPU.
const source = readFileSync(new URL('./scene.js', import.meta.url), 'utf8');
const handler = source.match(/async function respondToSceneRequest\(from, requestId\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(handler, 'production scene-request handler is present');

function object(userData, visible = true) {
  return { name: 'Shared object', userData, visible,
    position: { toArray: () => [1, 2, 3] },
    quaternion: { toArray: () => [0, 0, 0, 1] },
    scale: { toArray: () => [1, 1, 1] } };
}

async function snapshot(objects, sceneSyncReady = true) {
  const sent = [];
  const send = vm.runInNewContext(`(${handler})`, {
    sceneSyncReady, managedObjects: new Map(objects), structuredClone,
    console: { log() {} }, scenePhysicsRuntime: { getInitialBodyPoses: () => null },
    isSampleCubeObjectId: id => id === 'sample',
    serializeObjectClockForSceneSync: () => null,
    computeWorldBoundsForExternalUse: () => null,
    getObjectAudioSourcesForSerialize: () => null,
    getObjectPhysicsForSerialize: () => null,
    presenceState: { ws: { readyState: 1 } }, WebSocket: { OPEN: 1 },
    environmentManager: { getCurrentEnvId: () => 'studio' },
    serializeSceneBgm: () => null,
    loomIntegration: { exportState: () => ({ scene: null, objects: {} }) },
    getScenePhysicsForSerialize: () => null,
    sendHandoff: message => sent.push(message),
  });
  await send({ id: 'late-peer', nickname: 'Late peer' }, 'request-1');
  // Cross the wire as the real transport does (also removes VM prototype differences).
  return JSON.parse(JSON.stringify(sent));
}

test('browser-only late join retains a hidden Block and its editable identity', async () => {
  const metadata = { deskOSBlock: { type: 'DeskOS.Block', version: 1, pieceId: 'stroke-1', material: 'clear' } };
  const asset = { type: 'primitive', primitive: 'box', color: '#ffcc52' };
  const [message] = await snapshot([['block', object({ asset, metadata }, false)]]);
  assert.equal(message.targetId, 'late-peer');
  assert.equal(message.payload.requestId, 'request-1');
  assert.equal(message.payload.objects.block.visible, false);
  assert.deepEqual(message.payload.objects.block.metadata, metadata);
  assert.deepEqual(message.payload.objects.block.asset, asset);
});

test('GLB metadata and asset references survive while unrelated userData stays private', async () => {
  const metadata = { authoring: { label: 'sample', tags: ['model'] } };
  const [message] = await snapshot([['glb', object({ metadata, asset: { type: 'glb', meshPath: 'mesh-1' }, meshPath: 'mesh-1', internalCache: 'do not serialize' })]]);
  const entry = message.payload.objects.glb;
  assert.deepEqual(entry.metadata, metadata);
  assert.equal(entry.meshPath, 'mesh-1');
  assert.equal(entry.visible, true);
  assert.equal(entry.internalCache, undefined);
  entry.metadata.authoring.tags.push('changed');
  assert.deepEqual(metadata.authoring.tags, ['model']);
});

test('objects without metadata remain valid and sample objects stay excluded', async () => {
  const [message] = await snapshot([['plain', object({})], ['sample', object({})]]);
  assert.deepEqual(Object.keys(message.payload.objects), ['plain']);
  assert.equal(message.payload.objects.plain.visible, true);
  assert.equal(message.payload.objects.plain.metadata, undefined);
});

test('an unready participant does not send a partial snapshot', async () => {
  assert.deepEqual(await snapshot([['plain', object({})]], false), []);
});
