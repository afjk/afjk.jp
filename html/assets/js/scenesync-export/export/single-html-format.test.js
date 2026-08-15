import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SINGLE_HTML_EXPORT_FORMAT,
  buildSingleHtmlDocument,
  encodeSingleHtmlAssets,
  rewriteSingleHtmlModuleImports,
  stringifySafeEmbeddedJson,
} from './single-html-format.js';

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
