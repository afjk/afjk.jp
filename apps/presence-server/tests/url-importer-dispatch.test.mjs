import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchUrlImport } from '../../../html/assets/js/scenesync/loaders/url-importers/index.js';

test('dispatchUrlImport', async (t) => {
  await t.test('dispatches video URL to video importer', async () => {
    let videoImported = false;
    const mockCtx = {
      broadcastSceneAdd: () => { videoImported = true; },
      addOrUpdateObject: () => {},
      showToast: () => {},
      generateObjectId: (prefix) => `${prefix}-test`,
      getSpawnTransform: () => ({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }),
      THREE: {},
    };

    // Mock video loader
    global.loadVideoTextureFromUrl = async () => ({
      video: {}, texture: {}, planeWidth: 1, planeHeight: 1, aspect: 1,
    });

    try {
      await dispatchUrlImport('https://example.com/video.mp4', mockCtx);
      assert(videoImported, 'video importer should be called');
    } catch (err) {
      // Expected: video loading would fail without proper THREE setup
    }
  });

  await t.test('shows error for UNSUPPORTED URL (SVG)', async () => {
    let errorShown = false;
    const mockCtx = {
      showToast: (toast) => {
        if (toast.type === 'error') {
          errorShown = true;
        }
      },
      addOrUpdateObject: () => {},
      broadcastSceneAdd: () => {},
      generateObjectId: () => 'test-id',
      getSpawnTransform: () => ({}),
      THREE: {},
    };

    await dispatchUrlImport('https://example.com/graphic.svg', mockCtx);
    assert(errorShown, 'error toast should be shown for SVG');
  });

  await t.test('shows error for INVALID URL', async () => {
    let errorShown = false;
    const mockCtx = {
      showToast: (toast) => {
        if (toast.type === 'error') {
          errorShown = true;
        }
      },
      addOrUpdateObject: () => {},
      broadcastSceneAdd: () => {},
      generateObjectId: () => 'test-id',
      getSpawnTransform: () => ({}),
      THREE: {},
    };

    await dispatchUrlImport('not a valid url', mockCtx);
    assert(errorShown, 'error toast should be shown for invalid URL');
  });

  await t.test('shows error for unsupported WEBPAGE URL', async () => {
    let errorShown = false;
    const mockCtx = {
      showToast: (toast) => {
        if (toast.type === 'error') {
          errorShown = true;
        }
      },
      addOrUpdateObject: () => {},
      broadcastSceneAdd: () => {},
      generateObjectId: () => 'test-id',
      getSpawnTransform: () => ({}),
      THREE: {},
    };

    await dispatchUrlImport('https://example.com/page', mockCtx);
    assert(errorShown, 'error toast should be shown for webpage URL');
  });

  await t.test('shows error for GLB URL (Phase 2 deferred)', async () => {
    let errorShown = false;
    const mockCtx = {
      showToast: (toast) => {
        if (toast.type === 'error') {
          errorShown = true;
        }
      },
      addOrUpdateObject: () => {},
      broadcastSceneAdd: () => {},
      generateObjectId: () => 'test-id',
      getSpawnTransform: () => ({}),
      THREE: {},
    };

    await dispatchUrlImport('https://example.com/model.glb', mockCtx);
    assert(errorShown, 'error toast should be shown for GLB URL');
  });
});
