import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importAudioUrl } from '../../../html/assets/js/scenesync/loaders/url-importers/audio.js';
import { dispatchUrlImport } from '../../../html/assets/js/scenesync/loaders/url-importers/index.js';

test('importAudioUrl', async (t) => {
  await t.test('successfully imports audio URL when context has required functions', async () => {
    const mockCtx = {
      broadcastSceneBgm: (payload) => {
        assert.equal(payload.kind, 'scene-bgm');
        assert.equal(payload.bgm.url, 'https://example.com/music.mp3');
      },
      applySceneBgm: (bgm) => {
        assert.equal(bgm.version, 1);
        assert.equal(bgm.url, 'https://example.com/music.mp3');
        assert.equal(bgm.loop, true);
        assert.equal(bgm.volume, 1);
      },
      showToast: (toast) => {
        assert.equal(toast.type, 'success');
      },
    };

    const result = await importAudioUrl('https://example.com/music.mp3', mockCtx);
    assert(result.payload, 'should return payload');
    assert.equal(result.payload.kind, 'scene-bgm');
  });

  await t.test('sets object audio when an object target is resolved', async () => {
    let setCalled = false;
    const mockCtx = {
      resolveObjectAudioTarget: () => 'speaker-1',
      setObjectAudioComponent: (objectId, audio) => {
        setCalled = true;
        assert.equal(objectId, 'speaker-1');
        assert.equal(audio.url, 'https://example.com/sound.mp3');
        assert.equal(audio.playOnAwake, true);
        assert.equal(audio.loop, true);
        return { type: 'scene-graph-set', scope: { object: objectId } };
      },
      showToast: (toast) => {
        assert.equal(toast.type, 'success');
      },
    };

    const result = await importAudioUrl('https://example.com/sound.mp3', mockCtx);
    assert.equal(setCalled, true);
    assert.equal(result.objectId, 'speaker-1');
    assert.equal(result.payload.type, 'scene-graph-set');
  });

  await t.test('object audio does not require BGM functions', async () => {
    const mockCtx = {
      resolveObjectAudioTarget: () => 'speaker-1',
      setObjectAudioComponent: () => ({ type: 'scene-graph-set' }),
      showToast: () => {},
    };

    await importAudioUrl('https://example.com/sound.mp3', mockCtx);
  });

  await t.test('rejects object audio context missing setter', async () => {
    const mockCtx = {
      resolveObjectAudioTarget: () => 'speaker-1',
      showToast: () => {},
    };

    try {
      await importAudioUrl('https://example.com/sound.mp3', mockCtx);
      assert.fail('should throw error when setObjectAudioComponent is missing');
    } catch (err) {
      assert.match(err.message, /audio importer requires ctx.setObjectAudioComponent/);
    }
  });

  await t.test('rejects incomplete context: missing broadcastSceneBgm', async () => {
    const mockCtx = {
      applySceneBgm: () => {},
      showToast: () => {},
    };

    try {
      await importAudioUrl('https://example.com/music.mp3', mockCtx);
      assert.fail('should throw error when broadcastSceneBgm is missing');
    } catch (err) {
      assert.match(err.message, /audio importer requires ctx.broadcastSceneBgm/);
    }
  });

  await t.test('rejects incomplete context: missing applySceneBgm', async () => {
    const mockCtx = {
      broadcastSceneBgm: () => {},
      showToast: () => {},
    };

    try {
      await importAudioUrl('https://example.com/music.mp3', mockCtx);
      assert.fail('should throw error when applySceneBgm is missing');
    } catch (err) {
      assert.match(err.message, /audio importer requires ctx.applySceneBgm/);
    }
  });

  await t.test('rejects incomplete context: missing showToast', async () => {
    const mockCtx = {
      broadcastSceneBgm: () => {},
      applySceneBgm: () => {},
    };

    try {
      await importAudioUrl('https://example.com/music.mp3', mockCtx);
      assert.fail('should throw error when showToast is missing');
    } catch (err) {
      assert.match(err.message, /audio importer requires ctx.showToast/);
    }
  });

  await t.test('handles audio URL with special characters in filename', async () => {
    let broadcastCalled = false;
    let applyCalled = false;

    const mockCtx = {
      broadcastSceneBgm: (payload) => {
        broadcastCalled = true;
        assert(payload.bgm.name.includes('song'), 'should decode filename correctly');
      },
      applySceneBgm: (bgm) => {
        applyCalled = true;
        assert.equal(bgm.loop, true);
      },
      showToast: () => {},
    };

    await importAudioUrl('https://example.com/path/song%20with%20spaces.mp3', mockCtx);
    assert(broadcastCalled, 'broadcastSceneBgm should be called');
    assert(applyCalled, 'applySceneBgm should be called');
  });
});

test('dispatchUrlImport with audio URL', async (t) => {
  await t.test('dispatches audio URL to audio importer when context has BGM functions', async () => {
    let audioImported = false;
    const mockCtx = {
      broadcastSceneBgm: () => { audioImported = true; },
      applySceneBgm: () => {},
      showToast: () => {},
      addOrUpdateObject: () => {},
      broadcastSceneAdd: () => {},
      generateObjectId: () => 'test-id',
      getSpawnTransform: () => ({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }),
      THREE: {},
    };

    await dispatchUrlImport('https://example.com/music.mp3', mockCtx);
    assert(audioImported, 'audio importer should be called');
  });

  await t.test('dispatches audio URL and calls broadcastSceneBgm not broadcastSceneAdd', async () => {
    let bgmBroadcasted = false;
    let sceneBroadcasted = false;

    const mockCtx = {
      broadcastSceneBgm: (payload) => {
        bgmBroadcasted = true;
        assert.equal(payload.kind, 'scene-bgm', 'should broadcast scene-bgm not scene-add');
      },
      broadcastSceneAdd: (payload) => {
        sceneBroadcasted = true;
      },
      applySceneBgm: () => {},
      showToast: () => {},
      addOrUpdateObject: () => {},
      generateObjectId: () => 'test-id',
      getSpawnTransform: () => ({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }),
      THREE: {},
    };

    await dispatchUrlImport('https://example.com/bgm.wav', mockCtx);
    assert(bgmBroadcasted, 'broadcastSceneBgm should be called');
    assert(!sceneBroadcasted, 'broadcastSceneAdd should NOT be called for audio');
  });
});
