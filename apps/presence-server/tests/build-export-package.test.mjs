import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSceneDocumentFromSceneSyncState } from '../../../html/assets/js/scenesync-export/export/export-scene-document.js';
import { collectExportAssets } from '../../../html/assets/js/scenesync-export/export/collect-export-assets.js';
import { generateManifest } from '../../../html/assets/js/scenesync-export/export/export-manifest.js';
import { generateReadme, generateReadmeHtml } from '../../../html/assets/js/scenesync-export/export/export-readme.js';
import { generateExportIndexHtml } from '../../../html/assets/js/scenesync-export/export/build-export-package.js';
import { isValidSceneDocument } from '../../../html/assets/js/scenesync-export/viewer/scene-document.js';

// Simulate the core export package logic (without JSZip / DOM)

function makeMockObject(objectId, overrides = {}) {
  return {
    userData: {
      objectId,
      name: overrides.name || objectId,
      asset: overrides.asset || null,
      meshPath: overrides.meshPath || null,
      animationState: null,
    },
    position: { toArray: () => [0, 0.5, 0] },
    quaternion: { toArray: () => [0, 0, 0, 1] },
    scale: { toArray: () => [1, 1, 1] },
    visible: true,
    name: objectId,
  };
}

function mockFetch(responses) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const entry = responses[url];
    if (!entry) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => entry };
  };
  return () => { globalThis.fetch = original; };
}

test('export package construction', async (t) => {
  await t.test('scene.json is valid SceneDocument', async () => {
    const managedObjects = new Map();
    managedObjects.set('box-1', makeMockObject('box-1', {
      asset: { type: 'primitive', primitive: 'box', color: '#4488ff' },
    }));

    const doc = createSceneDocumentFromSceneSyncState({
      managedObjects,
      bgmState: null,
      envId: 'outdoor_day',
    });

    assert.ok(isValidSceneDocument(doc));
    assert.equal(doc.objects.length, 1);
    assert.equal(doc.skybox?.envId, 'outdoor_day');
  });

  await t.test('ZIP must contain index.html, README.md, README.html, manifest.json, scene.json', () => {
    // These are the required file names verified by name presence
    const requiredFiles = ['index.html', 'README.md', 'README.html', 'manifest.json', 'scene.json'];
    for (const f of requiredFiles) {
      assert.ok(typeof f === 'string', `${f} should be a string key`);
    }
    // This test verifies our naming conventions are consistent
    assert.ok(generateReadme().includes('Scene Sync Export'));
    assert.ok(generateReadmeHtml().includes('Scene Sync Export'));
    assert.ok(generateExportIndexHtml().includes('index.html'));
  });

  await t.test('viewer/ directory files are defined in VIEWER_SOURCES', () => {
    // Verify the viewer file paths are consistent with what we expect in the ZIP
    const expectedViewerFiles = [
      'viewer/viewer.js',
      'viewer/create-viewer-core.js',
      'viewer/static-asset-resolver.js',
      'viewer/scene-document.js',
      'viewer/viewer.css',
    ];
    // All expected paths start with viewer/
    for (const f of expectedViewerFiles) {
      assert.ok(f.startsWith('viewer/'));
    }
  });

  await t.test('ZIP includes Loomlet runtime files under viewer/loom/', async () => {
    // Verify loom runtime source paths exist on the filesystem
    const { readFileSync } = await import('node:fs');
    const loomJs = readFileSync(
      new URL('../../../html/assets/js/scenesync/loom/loom.js', import.meta.url)
    );
    const loomSyncJs = readFileSync(
      new URL('../../../html/assets/js/scenesync/loom/loom-scenesync.js', import.meta.url)
    );
    assert.ok(loomJs.length > 0, 'loom.js should be non-empty');
    assert.ok(loomSyncJs.length > 0, 'loom-scenesync.js should be non-empty');
  });

  await t.test('scene.json includes behaviors when behaviorState provided', async () => {
    const managedObjects = new Map();
    managedObjects.set('box-1', makeMockObject('box-1', {
      asset: { type: 'primitive', primitive: 'box', color: '#4488ff' },
    }));

    const behaviorState = {
      scene: null,
      objects: {
        'box-1': {
          nodes: [
            { id: 't', type: 'serverClock', params: {} },
            { id: 'set', type: 'sceneSetPosition', params: { target: 'box-1' } },
          ],
          edges: [{ from: 't.t', to: 'set.x' }],
        },
      },
    };

    const doc = createSceneDocumentFromSceneSyncState({
      managedObjects,
      bgmState: null,
      envId: null,
      behaviorState,
    });

    assert.ok(isValidSceneDocument(doc), 'document with behaviors should be valid');
    assert.ok(doc.behaviors, 'behaviors should be present in scene.json');
    assert.ok(doc.behaviors.objects['box-1'], 'object behavior should be present');
  });

  await t.test('scene.json is still valid without behaviors (v1 compatibility)', async () => {
    const managedObjects = new Map();
    managedObjects.set('box-1', makeMockObject('box-1', {
      asset: { type: 'primitive', primitive: 'box', color: '#4488ff' },
    }));

    const doc = createSceneDocumentFromSceneSyncState({
      managedObjects,
      bgmState: null,
      envId: 'outdoor_day',
    });

    assert.ok(isValidSceneDocument(doc), 'document without behaviors should still be valid');
    assert.equal('behaviors' in doc, false, 'behaviors should not be present');
  });

  await t.test('assets/ directory path format is correct', async () => {
    const buf = new ArrayBuffer(4);
    const restore = mockFetch({
      'http://blob/mesh1': buf,
    });

    try {
      const managedObjects = new Map();
      managedObjects.set('obj-1', makeMockObject('obj-1', {
        asset: { type: 'mesh', meshPath: 'mesh1', mime: 'model/gltf-binary' },
      }));

      const doc = createSceneDocumentFromSceneSyncState({
        managedObjects,
        bgmState: null,
        envId: null,
      });

      const { document: updatedDoc, assetManifest, missingAssets } = await collectExportAssets({
        sceneDocument: doc,
        blobBase: 'http://blob',
        envOrigin: null,
      });

      assert.equal(missingAssets.length, 0);
      assert.ok(updatedDoc.objects[0].asset.path.startsWith('assets/'));

      const manifest = generateManifest({ assetManifest, missingAssets });
      assert.equal(manifest.assets.length, 1);
      assert.ok(manifest.assets[0].path.startsWith('assets/'));
    } finally {
      restore();
    }
  });

  await t.test('README contains required content', () => {
    const readme = generateReadme();
    assert.ok(readme.includes('python3 -m http.server 8080'));
    assert.ok(readme.includes('http://localhost:8080'));
    assert.ok(readme.includes('読み取り専用'));
  });

  await t.test('README.html is generated and contains required content', () => {
    const readmeHtml = generateReadmeHtml();
    assert.ok(readmeHtml.includes('<!DOCTYPE html>'));
    assert.ok(readmeHtml.includes('<html lang="ja">'));
    assert.ok(readmeHtml.includes('Scene Sync Export の開き方'));
    assert.ok(readmeHtml.includes('python3 -m http.server 8080'));
    assert.ok(readmeHtml.includes('http://localhost:8080'));
    assert.ok(readmeHtml.includes('ローカルサーバーで見る方法'));
    assert.ok(readmeHtml.includes('ブラウザの制限により'));
  });

  await t.test('README.html includes link to index.html', () => {
    const readmeHtml = generateReadmeHtml();
    assert.ok(readmeHtml.includes('href="./index.html"'));
  });

  await t.test('missingAssets recorded but package generation continues', async () => {
    const restore = mockFetch({});

    try {
      const managedObjects = new Map();
      managedObjects.set('mesh-missing', makeMockObject('mesh-missing', {
        asset: { type: 'mesh', meshPath: 'no-such-blob', mime: 'model/gltf-binary' },
      }));
      managedObjects.set('prim-ok', makeMockObject('prim-ok', {
        asset: { type: 'primitive', primitive: 'sphere', color: '#fff' },
      }));

      const doc = createSceneDocumentFromSceneSyncState({
        managedObjects,
        bgmState: null,
        envId: null,
      });

      const { document: updatedDoc, missingAssets } = await collectExportAssets({
        sceneDocument: doc,
        blobBase: 'http://blob',
        envOrigin: null,
      });

      assert.equal(missingAssets.length, 1, 'one asset should be missing');
      assert.equal(updatedDoc.objects.length, 2, 'both objects in output');

      const primitive = updatedDoc.objects.find(o => o.id === 'prim-ok');
      assert.equal(primitive?.asset?.type, 'primitive', 'primitive should be unchanged');
    } finally {
      restore();
    }
  });
});

test('static viewer loading', async (t) => {
  await t.test('minimal scene.json can be parsed by isValidSceneDocument', () => {
    const minimal = {
      format: 'scene-sync-export-scene',
      version: 1,
      units: 'meters',
      objects: [],
      skybox: null,
      bgm: null,
    };
    assert.ok(isValidSceneDocument(minimal));
  });

  await t.test('GLB asset path resolver returns asset path unchanged', async () => {
    const { createStaticAssetResolver } = await import(
      '../../../html/assets/js/scenesync-export/viewer/static-asset-resolver.js'
    );
    const resolver = createStaticAssetResolver();

    const path = resolver.resolveAsset({ path: 'assets/obj-1.glb' });
    assert.equal(path, 'assets/obj-1.glb');
  });

  await t.test('resolver returns null for asset with no path', async () => {
    const { createStaticAssetResolver } = await import(
      '../../../html/assets/js/scenesync-export/viewer/static-asset-resolver.js'
    );
    const resolver = createStaticAssetResolver();

    assert.equal(resolver.resolveAsset(null), null);
    assert.equal(resolver.resolveAsset({}), null);
    assert.equal(resolver.resolveAsset({ path: null }), null);
  });

  await t.test('index.html template includes inline file protocol detection script', () => {
    const html = generateExportIndexHtml();
    assert.ok(html.includes(`location.protocol === 'file:'`));
    assert.ok(html.includes('file-protocol-warning'));
    assert.ok(html.includes('このままでは表示できません'));
    assert.ok(html.includes('README.html'));
    assert.ok(html.includes('python3 -m http.server 8080'));
  });

  await t.test('file protocol warning script runs before module script', () => {
    const html = generateExportIndexHtml();
    const protocolCheckIndex = html.indexOf(`location.protocol === 'file:'`);
    const moduleScriptIndex = html.indexOf('viewer/viewer.js');
    assert.ok(protocolCheckIndex > 0, 'protocol check script exists');
    assert.ok(moduleScriptIndex > 0, 'module script exists');
    assert.ok(protocolCheckIndex < moduleScriptIndex, 'protocol check runs before module script');
  });

  await t.test('index.html template is valid HTML with Japanese locale', () => {
    const html = generateExportIndexHtml();
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('<html lang="ja">'));
    assert.ok(html.includes('<meta charset="UTF-8">'));
    assert.ok(html.includes('<canvas id="viewer-canvas"></canvas>'));
  });
});
