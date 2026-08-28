import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { generateExportIndexHtml } from '../export/build-export-package.js';
import { createSingleHtmlManifest } from '../export/build-single-html-export.js';
import { buildSingleHtmlDocument } from '../export/single-html-format.js';
import {
  SCENE_SYNC_DRACO_DECODER_PATH,
  SCENE_SYNC_THREE_BASE_URL,
  SCENE_SYNC_THREE_IMPORTS,
  SCENE_SYNC_THREE_REVISION,
  SCENE_SYNC_THREE_RUNTIME_LABEL,
  createSceneSyncRendererOptions,
} from './three-runtime.js';

const editorIndexUrl = new URL('../../../../scenesync/index.html', import.meta.url);
const editorGlbLoaderUrl = new URL('../../../../assets/js/scenesync/loaders/glb-file-loader.js', import.meta.url);
const editorThreeAppUrl = new URL('../../../../assets/js/scenesync/core/three-app.js', import.meta.url);
const editorGltfConfigUrl = new URL('../../../../assets/js/scenesync/loaders/gltf-loader-config.js', import.meta.url);
const staticViewerEntryUrl = new URL('./static-viewer-entry.js', import.meta.url);
const gaussianPatchUrl = new URL('../../../../assets/js/scenesync/loaders/gaussian-splat-three-patch.js', import.meta.url);

function parseStaticImportMap(html) {
  const match = String(html).match(/<script type="importmap">\s*([\s\S]*?)\s*<\/script>/u);
  assert.ok(match, 'import map was not generated');
  return JSON.parse(match[1]).imports;
}

function assertPinnedImports(imports, label) {
  assert.equal(imports.three, SCENE_SYNC_THREE_IMPORTS.three, `${label}: three`);
  assert.equal(imports['three/webgpu'], SCENE_SYNC_THREE_IMPORTS['three/webgpu'], `${label}: three/webgpu`);
  assert.equal(imports['three/tsl'], SCENE_SYNC_THREE_IMPORTS['three/tsl'], `${label}: three/tsl`);
  assert.equal(imports['three/addons/'], SCENE_SYNC_THREE_IMPORTS['three/addons/'], `${label}: addons`);
  assert.equal(imports.three, imports['three/webgpu'], `${label}: core builds must be identical`);
}

test('Editor, Static ZIP, Single HTML, and Draco stay on one pinned Three.js revision', async () => {
  const editorIndex = await readFile(editorIndexUrl, 'utf8');
  const editorGlbLoader = await readFile(editorGlbLoaderUrl, 'utf8');
  const staticIndex = generateExportIndexHtml();
  const singleHtml = await buildSingleHtmlDocument({
    sceneDocument: { format: 'scene-sync-export-scene', version: 2, objects: [] },
    manifest: { format: 'scene-sync-export', version: 1 },
    files: {},
    viewerFiles: {},
  });

  assertPinnedImports(parseStaticImportMap(editorIndex), 'Editor');
  assertPinnedImports(parseStaticImportMap(staticIndex), 'Static ZIP');

  for (const url of Object.values(SCENE_SYNC_THREE_IMPORTS)) {
    assert.ok(singleHtml.includes(url), `Single HTML omitted ${url}`);
  }
  assert.ok(SCENE_SYNC_DRACO_DECODER_PATH.startsWith(SCENE_SYNC_THREE_BASE_URL));
  assert.match(editorGlbLoader, /SCENE_SYNC_DRACO_DECODER_PATH/u);
  assert.doesNotMatch(editorGlbLoader, /['"]\/draco\//u);

  for (const document of [editorIndex, staticIndex, singleHtml, SCENE_SYNC_DRACO_DECODER_PATH]) {
    assert.ok(document.includes(SCENE_SYNC_THREE_REVISION));
    assert.equal(document.includes('three@0.170.0'), false);
  }

  const manifest = createSingleHtmlManifest({ assetManifest: [], missingAssets: [] });
  assert.equal(manifest.viewer.cdnDependent, true);
  assert.ok(manifest.viewer.cdnDependencies.includes(SCENE_SYNC_THREE_RUNTIME_LABEL));
  assert.equal(manifest.viewer.cdnDependencies.includes('three@0.170.0'), false);
});

test('Editor and Export Viewer retain WebXR setup after renderer migration', async () => {
  const [editorThreeApp, staticViewerEntry] = await Promise.all([
    readFile(editorThreeAppUrl, 'utf8'),
    readFile(staticViewerEntryUrl, 'utf8'),
  ]);
  assert.match(editorThreeApp, /renderer\.xr\.enabled = true/u);
  assert.match(editorThreeApp, /setReferenceSpaceType\('local-floor'\)/u);
  assert.match(staticViewerEntry, /renderer\.xr\.enabled = true/u);
  assert.match(staticViewerEntry, /'immersive-vr'/u);
  assert.match(staticViewerEntry, /'immersive-ar'/u);
  assert.match(staticViewerEntry, /'local-floor'/u);
});

test('Editor and exports share the pinned Gaussian XR stereo patch', async () => {
  const [editorThreeApp, editorGltfConfig, gaussianPatch] = await Promise.all([
    readFile(editorThreeAppUrl, 'utf8'),
    readFile(editorGltfConfigUrl, 'utf8'),
    readFile(gaussianPatchUrl, 'utf8'),
  ]);
  const staticIndex = generateExportIndexHtml();
  const singleHtml = await buildSingleHtmlDocument({
    sceneDocument: { format: 'scene-sync-export-scene', version: 2, objects: [] },
    manifest: { format: 'scene-sync-export', version: 1 },
    files: {},
    viewerFiles: {
      'scenesync/loaders/gaussian-splat-three-patch.js': gaussianPatch,
    },
  });

  assert.doesNotMatch(editorThreeApp, /initializeSceneSyncGLTFLoaderExtensions/u);
  assert.match(editorGltfConfig, /await initializeSceneSyncGLTFLoaderExtensions/u);
  assert.match(gaussianPatch, /mediumpModelViewMatrix/u);
  assert.match(gaussianPatch, /cameraViewport\.zw/u);
  assert.match(gaussianPatch, /smooth-kernel/u);
  assert.ok(staticIndex.includes(SCENE_SYNC_THREE_REVISION));
  assert.ok(singleHtml.includes('xr-stereo-mediumpModelViewMatrix-cameraViewport-smooth-kernel'));
});

test('renderer backend selection defaults to WebGL and requires ?webgpu=1 for WebGPU', () => {
  assert.equal(createSceneSyncRendererOptions({ antialias: true }, '').forceWebGL, true);
  assert.equal(createSceneSyncRendererOptions({}, '?webgpu=0').forceWebGL, true);
  assert.equal(createSceneSyncRendererOptions({}, '?webgpu=1').forceWebGL, false);
});
