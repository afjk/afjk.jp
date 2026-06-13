import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSceneDocumentAssets } from './resolve-export-assets.js';
import { applySceneDocument } from './apply-scene-document.js';
import { applySceneDocumentSettings } from './apply-scene-settings.js';

function createFakeZip(files) {
  return {
    file(path) {
      const data = files[path];
      if (!data) return null;
      return {
        async async(type) {
          assert.equal(type, 'arraybuffer');
          return data;
        },
      };
    },
  };
}

function arrayBufferOfLength(length) {
  return new Uint8Array(Array.from({ length }, (_, index) => index + 1)).buffer;
}

test('E2E: exported static assets and SceneSync import resolve to the same source files', async () => {
  const files = {
    'assets/poster.jpg': arrayBufferOfLength(11),
    'assets/story.md': arrayBufferOfLength(13),
    'assets/speaker.mp3': arrayBufferOfLength(17),
    'assets/bgm.mp3': arrayBufferOfLength(19),
  };
  const sourcePathBySize = new Map(
    Object.entries(files).map(([path, buffer]) => [buffer.byteLength, path])
  );
  const uploadedUrlToSourcePath = new Map();

  const zip = createFakeZip(files);
  const uploadBlobToStore = async (blob, mime, extension) => {
    const sourcePath = sourcePathBySize.get(blob.size);
    assert.ok(sourcePath, `unexpected upload size: ${blob.size}`);
    const url = `https://blob.test/${sourcePath.replace(/^assets\//, '')}`;
    uploadedUrlToSourcePath.set(url, sourcePath);
    return { path: `uploaded/${sourcePath.split('/').pop()}`, url, mime, extension };
  };

  const exportedSceneDocument = {
    format: 'scene-sync-export-scene',
    version: 1,
    units: 'meters',
    skybox: { type: 'env', envId: 'outdoor_day', asset: { path: 'assets/env.hdr' } },
    bgm: {
      url: 'https://example.com/bgm.mp3',
      name: 'BGM',
      loop: true,
      volume: 0.5,
      asset: { path: 'assets/bgm.mp3', mime: 'audio/mpeg' },
    },
    objects: [
      {
        id: 'box',
        name: 'Box',
        position: [0, 0.5, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        visible: true,
        asset: { type: 'primitive', primitive: 'box', color: '#4488ff' },
      },
      {
        id: 'poster',
        name: 'Poster',
        position: [1, 1, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        visible: true,
        asset: {
          type: 'image',
          source: 'url',
          url: 'https://example.com/poster.jpg',
          path: 'assets/poster.jpg',
          mime: 'image/jpeg',
        },
      },
      {
        id: 'story',
        name: 'Story',
        position: [-1, 1, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        visible: true,
        asset: {
          type: 'text',
          source: 'url',
          url: 'https://example.com/story.md',
          path: 'assets/story.md',
          mime: 'text/markdown',
          format: 'markdown',
        },
      },
      {
        id: 'speaker',
        name: 'Speaker',
        position: [0, 1, 1],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        visible: true,
        asset: { type: 'primitive', primitive: 'sphere', color: '#ffffff' },
        audioSources: {
          default: {
            url: 'https://example.com/speaker.mp3',
            loop: true,
            playOnAwake: true,
            asset: { path: 'assets/speaker.mp3', mime: 'audio/mpeg' },
          },
        },
      },
    ],
  };

  const { document: importDocument } = await resolveSceneDocumentAssets(exportedSceneDocument, { zip });

  const addedPayloads = [];
  const broadcasts = [];
  const stats = await applySceneDocument(importDocument, {
    managedObjects: new Map(),
    addOrUpdateObject: (id, payload) => addedPayloads.push(payload),
    broadcast: (payload) => broadcasts.push(payload),
    zip,
    uploadBlobToStore,
  });

  const bgmCalls = [];
  const settings = await applySceneDocumentSettings(importDocument, {
    environmentManager: { loadEnvironment() {} },
    applySceneBgm: (bgm) => bgmCalls.push(bgm),
    broadcast: (payload) => broadcasts.push(payload),
    zip,
    uploadBlobToStore,
  });

  assert.deepEqual(stats, { total: 4, added: 4, updated: 0, glbImported: 0, skippedAssets: 0 });
  assert.equal(settings.envApplied, true);
  assert.equal(settings.bgmApplied, true);

  const byId = new Map(addedPayloads.map((payload) => [payload.objectId, payload]));
  assert.equal(byId.get('box').asset.primitive, 'box');

  assert.equal(uploadedUrlToSourcePath.get(byId.get('poster').asset.url), 'assets/poster.jpg');
  assert.equal(byId.get('poster').asset.path, undefined);

  assert.equal(uploadedUrlToSourcePath.get(byId.get('story').asset.url), 'assets/story.md');
  assert.equal(byId.get('story').asset.path, undefined);
  assert.equal(byId.get('story').asset.source, 'url');

  assert.equal(
    uploadedUrlToSourcePath.get(byId.get('speaker').audioSources.default.url),
    'assets/speaker.mp3'
  );
  assert.equal(byId.get('speaker').audioSources.default.asset, undefined);

  assert.equal(uploadedUrlToSourcePath.get(bgmCalls[0].url), 'assets/bgm.mp3');
  assert.equal(broadcasts.filter((payload) => payload.kind === 'scene-add').length, 4);
  assert.equal(broadcasts.some((payload) => payload.kind === 'scene-bgm'), true);
});
