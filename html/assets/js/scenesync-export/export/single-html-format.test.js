import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SINGLE_HTML_EXPORT_FORMAT,
  buildSingleHtmlDocument,
  encodeSingleHtmlAssets,
  createSingleHtmlAssetZip,
  parseSingleHtmlExportDocument,
  rewriteSingleHtmlModuleImports,
  stringifySafeEmbeddedJson,
} from './single-html-format.js';
import { isValidSceneDocument } from '../viewer/scene-document.js';

test('single HTML format safely embeds versioned manifest, SceneDocument, and binary assets', async () => {
  const sceneDocument = {
    format: 'scene-sync-export-scene',
    version: 2,
    title: '</script><img src=x onerror=alert(1)>',
    objects: [
      {
        id: 'primitive-object', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
        asset: { type: 'primitive', primitive: 'box' },
      },
      {
        id: 'image-object', position: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
        asset: { type: 'image', path: 'assets/texture.png' },
      },
      {
        id: 'glb-object', position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
        asset: { type: 'mesh', path: 'assets/model.glb' },
        physics: { enabled: true, bodyType: 'dynamic' },
      },
    ],
    loomlet: { graphs: [{ id: 'interaction-graph' }] },
  };
  const manifest = {
    format: 'scene-sync-export',
    version: 1,
    singleHtml: { format: SINGLE_HTML_EXPORT_FORMAT, version: 1 },
  };
  const html = await buildSingleHtmlDocument({
    sceneDocument,
    manifest,
    files: {
      'assets/model.glb': new Uint8Array([0, 1, 2, 255]).buffer,
      'assets/texture.png': new Uint8Array([137, 80, 78, 71]).buffer,
      'assets/bgm.mp3': new Uint8Array([3, 4, 5]).buffer,
    },
    viewerFiles: {
      'viewer/viewer.css': '#viewer-canvas { display: block; }',
      'viewer/player-shell.css': '.player-shell { display: block; }',
      'viewer/viewer.js': "import { value } from './core.js'; globalThis.value = value;",
      'viewer/core.js': 'export const value = 1;',
      'viewer/rapier/rapier.js': 'export default {};',
      'viewer/rapier/rapier_wasm3d_bg.wasm': new Uint8Array([0, 97, 115, 109]).buffer,
    },
  });

  assert.match(html, new RegExp(`scene-sync-export-format" content="${SINGLE_HTML_EXPORT_FORMAT}`));
  assert.match(html, /"base64":"AAEC\/w=="/);
  assert.match(html, /"mime":"image\/png","base64":"iVBORw=="/);
  assert.match(html, /__SCENE_SYNC_SINGLE_HTML_ASSET_URLS__/);
  assert.match(html, /scene-sync-single-html\/viewer\/core\.js/);
  assert.match(html, /rapier_wasm3d_bg\.wasm/);
  assert.equal(html.includes('</script><img'), false);
  assert.match(html, /"physics":\{"enabled":true/);
  assert.match(html, /"loomlet":\{"graphs"/);
  assert.match(html, /"primitive":"box"/);
});

test('asset encoding preserves binary bytes and mime types for the runtime resolver', async () => {
  const assets = await encodeSingleHtmlAssets({
    'assets/texture.png': new Uint8Array([137, 80, 78, 71]).buffer,
    'assets/audio.ogg': new Blob([new Uint8Array([79, 103, 103, 83])], { type: 'audio/ogg' }),
  });

  assert.deepEqual(assets['assets/texture.png'], { mime: 'image/png', base64: 'iVBORw==' });
  assert.deepEqual(assets['assets/audio.ogg'], { mime: 'audio/ogg', base64: 'T2dnUw==' });
});

test('module import rewrite keeps viewer modules self-contained', () => {
  const source = "import { createCore } from './core.js'; export { thing } from '../shared/thing.js';";
  const rewritten = rewriteSingleHtmlModuleImports(source, 'viewer/viewer.js');
  assert.match(rewritten, /from 'scene-sync-single-html\/viewer\/core\.js'/);
  assert.match(rewritten, /from 'scene-sync-single-html\/shared\/thing\.js'/);
});

test('safe JSON escaping prevents script element termination', () => {
  const encoded = stringifySafeEmbeddedJson({ value: '</script>&\u2028\u2029' });
  assert.equal(encoded.includes('</script>'), false);
  assert.equal(encoded.includes('&'), false);
  assert.match(encoded, /\\u003C\/script\\u003E/);
});

test('Single HTML export parses without DOM execution and restores embedded binary assets', async () => {
  const sceneDocument = {
    format: 'scene-sync-export-scene',
    version: 2,
    physics: { enabled: true, gravity: [0, -9.81, 0] },
    loomlet: { graphs: [{ id: 'loomlet-1', nodes: [] }] },
    objects: [{
      id: 'poster', position: [2, 3, 4], rotation: [0, 0.5, 0, 0.5], scale: [2, 2, 2],
      asset: { type: 'image', path: 'assets/poster.png' },
    }],
  };
  const html = await buildSingleHtmlDocument({
    sceneDocument,
    manifest: { singleHtml: { format: SINGLE_HTML_EXPORT_FORMAT, version: 1 } },
    files: { 'assets/poster.png': new Uint8Array([137, 80, 78, 71]).buffer },
    viewerFiles: {},
  });

  const parsed = parseSingleHtmlExportDocument(html, { isValidSceneDocument });
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.sceneDocument, sceneDocument);
  const buffer = await createSingleHtmlAssetZip(parsed.payload.assets)
    .file('assets/poster.png').async('arraybuffer');
  assert.deepEqual(Array.from(new Uint8Array(buffer)), [137, 80, 78, 71]);
});

test('Single HTML parser rejects malformed marker, version, document, and assets', () => {
  const base = {
    format: SINGLE_HTML_EXPORT_FORMAT,
    version: 1,
    sceneDocument: { format: 'scene-sync-export-scene', version: 2, objects: [] },
    assets: {},
  };
  const htmlFor = (marker, payload) => `<meta name="scene-sync-export-format" content="${marker}"><script id="scene-sync-single-html-payload" type="application/json">${JSON.stringify(payload)}</script>`;

  assert.equal(parseSingleHtmlExportDocument(htmlFor('single-html-v999', base), { isValidSceneDocument }).reason, 'invalid-single-html-marker');
  assert.equal(parseSingleHtmlExportDocument(htmlFor(SINGLE_HTML_EXPORT_FORMAT, { ...base, version: 99 }), { isValidSceneDocument }).reason, 'unsupported-single-html-version');
  assert.equal(parseSingleHtmlExportDocument(htmlFor(SINGLE_HTML_EXPORT_FORMAT, { ...base, sceneDocument: {} }), { isValidSceneDocument }).reason, 'invalid-single-html-scene-document');
  assert.equal(parseSingleHtmlExportDocument(htmlFor(SINGLE_HTML_EXPORT_FORMAT, { ...base, assets: { 'bad.bin': { mime: 'application/octet-stream', base64: 'not base64!' } } }), { isValidSceneDocument }).reason, 'invalid-single-html-assets');
});

test('Single HTML parser ignores comments and data-* attributes while accepting quoted case-insensitive attributes', () => {
  const payload = JSON.stringify({
    format: SINGLE_HTML_EXPORT_FORMAT,
    version: 1,
    sceneDocument: { format: 'scene-sync-export-scene', version: 2, objects: [] },
    assets: {},
  });
  const html = `<!-- <meta name="scene-sync-export-format" content="single-html-v1"><script id="scene-sync-single-html-payload">bad</script> -->
    <meta data-name="scene-sync-export-format" content="single-html-v1">
    <script data-id="scene-sync-single-html-payload">bad</script>
    <META NAME='scene-sync-export-format' CONTENT='single-html-v1'>
    <SCRIPT ID='scene-sync-single-html-payload' TYPE='application/json'>${payload}</SCRIPT>`;
  const parsed = parseSingleHtmlExportDocument(html, { isValidSceneDocument });
  assert.equal(parsed.valid, true);
  assert.equal(parsed.sceneDocument.format, 'scene-sync-export-scene');
});

test('Single HTML parser ignores fake tags in raw script/style text and keeps quote-aware real tags', () => {
  const payload = JSON.stringify({
    format: SINGLE_HTML_EXPORT_FORMAT,
    version: 1,
    sceneDocument: { format: 'scene-sync-export-scene', version: 2, objects: [] },
    assets: {},
  });
  const html = `<meta NAME="scene-sync-export-format" data-note=">" CONTENT='single-html-v1'>
    <script>const fake = '<meta name="scene-sync-export-format" content="single-html-v1"><script id="scene-sync-single-html-payload">';</script>
    <style>.fake::before { content: '<meta name="scene-sync-export-format" content="single-html-v1"><script id="scene-sync-single-html-payload">'; }</style>
    <SCRIPT data-note='>' ID="scene-sync-single-html-payload" type="application/json">${payload}</SCRIPT>
    <script>const anotherFake = '<script id="scene-sync-single-html-payload">';</script>`;
  const parsed = parseSingleHtmlExportDocument(html, { isValidSceneDocument });
  assert.equal(parsed.valid, true);
  assert.equal(parsed.sceneDocument.version, 2);
});

test('Single HTML parser enforces document, asset count, decoded asset, total asset, and safe path limits before decoding', () => {
  const payload = {
    format: SINGLE_HTML_EXPORT_FORMAT,
    version: 1,
    sceneDocument: { format: 'scene-sync-export-scene', version: 2, objects: [] },
    assets: { 'assets/a.bin': { mime: 'application/octet-stream', base64: 'AAAA' } },
  };
  const htmlFor = (value) => `<meta name="scene-sync-export-format" content="single-html-v1"><script id="scene-sync-single-html-payload">${JSON.stringify(value)}</script>`;
  assert.equal(parseSingleHtmlExportDocument(htmlFor(payload), { isValidSceneDocument, limits: { documentBytes: 1 } }).reason, 'single-html-document-too-large');
  assert.equal(parseSingleHtmlExportDocument(htmlFor(payload), { isValidSceneDocument, limits: { assetBytes: 2 } }).reason, 'single-html-asset-too-large');
  assert.equal(parseSingleHtmlExportDocument(htmlFor({ ...payload, assets: {
    'assets/a.bin': payload.assets['assets/a.bin'], 'assets/b.bin': payload.assets['assets/a.bin'],
  } }), { isValidSceneDocument, limits: { assetCount: 1 } }).reason, 'single-html-too-many-assets');
  assert.equal(parseSingleHtmlExportDocument(htmlFor({ ...payload, assets: {
    'assets/a.bin': payload.assets['assets/a.bin'], 'assets/b.bin': payload.assets['assets/a.bin'],
  } }), { isValidSceneDocument, limits: { totalAssetBytes: 5 } }).reason, 'single-html-assets-too-large');
  assert.equal(parseSingleHtmlExportDocument(htmlFor({ ...payload, assets: {
    '../escape.bin': payload.assets['assets/a.bin'],
  } }), { isValidSceneDocument }).reason, 'invalid-single-html-assets');
});
