// Tests for apply-scene-settings.js
// Run: node --test html/assets/js/scenesync/importers/scene-sync-export/apply-scene-settings.test.js

import { test } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { applySceneDocumentSettings } from './apply-scene-settings.js';

function createFakeZip(files) {
  return {
    file(path) {
      const data = files[path];
      if (!data) return null;
      return {
        async async(type) {
          strictEqual(type, 'arraybuffer');
          return data;
        },
      };
    },
  };
}

test('applies envId from skybox and broadcasts scene-env', async () => {
  const calls = { loadEnvironment: [], broadcast: [] };
  const environmentManager = {
    loadEnvironment: (envId, options) => calls.loadEnvironment.push({ envId, options }),
  };
  const broadcast = (payload) => calls.broadcast.push(payload);

  const result = await applySceneDocumentSettings({ skybox: { envId: 'outdoor_night' } }, {
    environmentManager,
    broadcast,
  });

  deepStrictEqual(result, { envApplied: true, envId: 'outdoor_night' });
  strictEqual(calls.loadEnvironment.length, 1);
  strictEqual(calls.loadEnvironment[0].envId, 'outdoor_night');
  strictEqual(calls.loadEnvironment[0].options.broadcastChange, false);
  deepStrictEqual(calls.broadcast[0], { kind: 'scene-env', envId: 'outdoor_night' });
});

test('applies BGM from ZIP-bundled asset via shared Scene Sync URL', async () => {
  const calls = { bgm: [], broadcast: [], uploads: [] };
  const zip = createFakeZip({
    'assets/bgm.mp3': new Uint8Array([1, 2, 3]).buffer,
  });
  const uploadBlobToStore = async (blob, mime, extension) => {
    calls.uploads.push({ blob, mime, extension });
    return { path: `bgm${extension}`, url: `https://blob.test/bgm${extension}` };
  };

  const result = await applySceneDocumentSettings({
    bgm: {
      version: 1,
      url: 'https://example.com/bgm.mp3',
      name: 'BGM',
      loop: false,
      volume: 0.4,
      playback: { mode: 'local-loop' },
      importAsset: {
        kind: 'blob-file',
        path: 'assets/bgm.mp3',
        originalName: 'bgm.mp3',
        mime: 'audio/mpeg',
      },
    },
  }, {
    zip,
    uploadBlobToStore,
    applySceneBgm: (bgm, options) => calls.bgm.push({ bgm, options }),
    broadcast: (payload) => calls.broadcast.push(payload),
  });

  deepStrictEqual(result, {
    envApplied: false,
    bgmApplied: true,
    bgmUrl: 'https://blob.test/bgm.mp3',
  });
  deepStrictEqual(calls.uploads.map((u) => [u.mime, u.extension]), [['audio/mpeg', '.mp3']]);
  strictEqual(calls.bgm.length, 1);
  deepStrictEqual(calls.bgm[0].bgm, {
    version: 1,
    url: 'https://blob.test/bgm.mp3',
    name: 'BGM',
    loop: false,
    volume: 0.4,
    playback: { mode: 'local-loop' },
  });
  deepStrictEqual(calls.broadcast[0], {
    kind: 'scene-bgm',
    bgm: calls.bgm[0].bgm,
  });
});

test('does nothing when skybox is absent (keeps current environment)', async () => {
  const calls = { loadEnvironment: [], broadcast: [] };
  const environmentManager = {
    loadEnvironment: (envId, options) => calls.loadEnvironment.push({ envId, options }),
  };
  const broadcast = (payload) => calls.broadcast.push(payload);

  const result = await applySceneDocumentSettings({}, { environmentManager, broadcast });

  deepStrictEqual(result, { envApplied: false });
  strictEqual(calls.loadEnvironment.length, 0);
  strictEqual(calls.broadcast.length, 0);
});

test('does nothing when skybox.envId is null', async () => {
  const result = await applySceneDocumentSettings({ skybox: { envId: null } }, {});
  deepStrictEqual(result, { envApplied: false });
});
