import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UP_AXIS_ROTATIONS,
  applyGlbAssetMetadata,
  packGlb,
  splitGlb,
  wrapGlbSceneInRotationNode,
} from './glb-root-transform.js';

function sampleGlb(json = {}, bin = new Uint8Array([1, 2, 3, 4, 5])) {
  return packGlb({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
    buffers: [{ byteLength: bin.byteLength }],
    ...json,
  }, bin);
}

test('a packed GLB splits back into what went in', () => {
  const bin = new Uint8Array([9, 8, 7]);
  const { json, bin: roundTripped } = splitGlb(sampleGlb({}, bin));

  assert.equal(json.asset.version, '2.0');
  assert.deepEqual(Array.from(roundTripped.subarray(0, 3)), [9, 8, 7]);
});

test('chunks are padded to four bytes and the header length matches', () => {
  const glb = sampleGlb({ asset: { version: '2.0', generator: 'x' } }, new Uint8Array([1]));
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);

  assert.equal(glb.byteLength % 4, 0, 'the whole file should be four byte aligned');
  assert.equal(view.getUint32(8, true), glb.byteLength, 'declared length must match the file');
  assert.equal(view.getUint32(12, true) % 4, 0, 'the JSON chunk should be padded');
});

test('a GLB with no BIN chunk stays that way', () => {
  const glb = packGlb({ asset: { version: '2.0' } }, null);
  const { bin } = splitGlb(glb);
  assert.equal(bin, null);
  assert.equal(new DataView(glb.buffer).getUint32(8, true), glb.byteLength);
});

test('asset metadata is added without changing the binary payload', () => {
  const bin = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
  const updated = applyGlbAssetMetadata(sampleGlb({
    asset: { version: '2.0', extras: { existing: true } },
  }, bin), {
    copyright: '"Lion" by Renaud\nLicensed under CC BY 4.0',
    extras: {
      scenesync: {
        gaussianSplatSource: { provider: 'supersplat', sceneId: '56155c3f' },
      },
    },
  });
  const { json, bin: updatedBin } = splitGlb(updated);

  assert.match(json.asset.copyright, /Renaud/);
  assert.equal(json.asset.extras.existing, true);
  assert.equal(json.asset.extras.scenesync.gaussianSplatSource.sceneId, '56155c3f');
  assert.deepEqual(Array.from(updatedBin.subarray(0, bin.length)), Array.from(bin));
});

test('asset metadata preserves existing copyright and Scene Sync extras', () => {
  const updated = applyGlbAssetMetadata(sampleGlb({
    asset: {
      version: '2.0',
      copyright: 'Original notice',
      extras: { scenesync: { existing: true } },
    },
  }), {
    copyright: 'Attribution notice',
    extras: { scenesync: { gaussianSplatSource: { provider: 'supersplat' } } },
  });
  const { json } = splitGlb(updated);

  assert.equal(json.asset.copyright, 'Original notice\nAttribution notice');
  assert.equal(json.asset.extras.scenesync.existing, true);
  assert.equal(json.asset.extras.scenesync.gaussianSplatSource.provider, 'supersplat');
});

test('wrapping parents the scene roots under one rotated node', () => {
  const wrapped = wrapGlbSceneInRotationNode(sampleGlb(), UP_AXIS_ROTATIONS['flip-x-180']);
  const { json } = splitGlb(wrapped);

  assert.deepEqual(json.scenes[0].nodes, [1], 'the scene root should be the new node');
  assert.deepEqual(json.nodes[1].rotation, [1, 0, 0, 0]);
  assert.deepEqual(json.nodes[1].children, [0]);
  assert.deepEqual(json.nodes[0], { mesh: 0 }, 'the original node is untouched');
});

test('wrapping keeps the binary payload byte for byte', () => {
  const bin = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
  const wrapped = wrapGlbSceneInRotationNode(sampleGlb({}, bin), [1, 0, 0, 0]);

  const { bin: after } = splitGlb(wrapped);
  assert.deepEqual(Array.from(after.subarray(0, bin.length)), Array.from(bin));
});

test('a multi-root scene is wrapped as a whole', () => {
  const glb = sampleGlb({
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0 }, { mesh: 0 }],
  });

  const { json } = splitGlb(wrapGlbSceneInRotationNode(glb, [1, 0, 0, 0]));
  assert.deepEqual(json.scenes[0].nodes, [2]);
  assert.deepEqual(json.nodes[2].children, [0, 1]);
});

test('a GLB without a usable scene is refused rather than silently wrapped', () => {
  assert.throws(
    () => wrapGlbSceneInRotationNode(sampleGlb({ scenes: [{ nodes: [] }] }), [1, 0, 0, 0]),
    /no scene nodes/,
  );
});

test('a corrupt container is rejected', () => {
  assert.throws(() => splitGlb(new Uint8Array(8)), /too short/);

  const badMagic = sampleGlb();
  badMagic[0] = 0;
  assert.throws(() => splitGlb(badMagic), /magic/);

  const truncated = sampleGlb().slice(0, 30);
  assert.throws(() => splitGlb(truncated), /length|chunk/);
});
