import test from 'node:test';
import assert from 'node:assert/strict';

import { importSuperSplatUrl } from './supersplat.js';

test('SuperSplat URL import becomes a normal managed GLB with source metadata', async () => {
  const calls = {};
  const resolution = {
    provider: 'supersplat',
    sceneId: '56155c3f',
    pageUrl: 'https://superspl.at/scene/56155c3f',
    title: 'Lion',
    author: 'Example Artist',
    downloadable: true,
    license: {
      code: 'CC-BY-4.0',
      label: 'CC BY 4.0',
      url: 'https://creativecommons.org/licenses/by/4.0/',
    },
    attribution: {
      status: 'complete',
      text: '"Lion" by Example Artist\nSource: https://superspl.at/scene/56155c3f\nLicensed under CC BY 4.0',
      sourceUrl: 'https://superspl.at/scene/56155c3f',
      creators: [{ name: 'Example Artist', url: 'https://superspl.at/user/example' }],
      publisher: { name: 'example', url: 'https://superspl.at/user/example' },
    },
    asset: { format: 'sog-meta', url: 'https://d1.cloudfront.net/v1/meta.json', revision: 'v1' },
  };
  const model = { userData: {} };
  const result = await importSuperSplatUrl(resolution.pageUrl, {
    showToast: () => {},
    resolveSuperSplatScene: async () => resolution,
    downloadSuperSplatSource: async () => new File(['source'], 'Lion.supersplat.zip'),
    convertGaussianSplatFileToGlb: async (_file, options) => {
      calls.conversionOptions = options;
      return {
        file: new File(['glb'], 'Lion.supersplat.glb'),
        sourceFormat: 'sog',
        splatCount: 195099,
        shDegree: 2,
      };
    },
    generateObjectId: () => 'glb-supersplat',
    getSpawnTransform: () => ({
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    }),
    importGlbFileAsSceneObject: async (file, options) => {
      calls.file = file;
      calls.importOptions = options;
      return model;
    },
  });

  assert.equal(result.objectId, 'glb-supersplat');
  assert.equal(calls.conversionOptions.upAxisCorrection, 'flip-z-180');
  assert.match(calls.conversionOptions.glbAssetMetadata.copyright, /Example Artist/);
  assert.equal(
    calls.conversionOptions.glbAssetMetadata.extras.scenesync
      .gaussianSplatSource.attribution.status,
    'complete',
  );
  assert.equal(calls.file.name, 'Lion.supersplat.glb');
  assert.equal(calls.importOptions.name, 'Lion');
  assert.deepEqual(calls.importOptions.position, [1, 2, 3]);
  assert.equal(calls.importOptions.metadata.gaussianSplatSource.provider, 'supersplat');
  assert.equal(calls.importOptions.metadata.gaussianSplatSource.license.code, 'CC-BY-4.0');
  assert.equal(
    calls.importOptions.metadata.gaussianSplatSource.license.url,
    'https://creativecommons.org/licenses/by/4.0/',
  );
  assert.equal(
    calls.importOptions.metadata.gaussianSplatSource.attribution.creators[0].name,
    'Example Artist',
  );
  assert.equal(calls.importOptions.metadata.gaussianSplatSource.splatCount, 195099);
  assert.equal(model.userData.importedFrom.provider, 'supersplat');
});

test('SuperSplat URL import reports a resolver rejection and adds nothing', async () => {
  const toasts = [];
  let imported = false;
  const result = await importSuperSplatUrl('https://superspl.at/scene/private', {
    showToast: (toast) => toasts.push(toast),
    resolveSuperSplatScene: async () => {
      throw new Error('ダウンロードが許可されていません');
    },
    importGlbFileAsSceneObject: async () => { imported = true; },
  });

  assert.equal(result, null);
  assert.equal(imported, false);
  assert.deepEqual(toasts.at(-1), {
    type: 'error',
    message: 'ダウンロードが許可されていません',
  });
});
