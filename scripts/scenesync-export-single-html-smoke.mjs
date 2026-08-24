import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SINGLE_HTML_HANDOFF_SOURCES,
  VIEWER_SOURCES,
} from '../html/assets/js/scenesync-export/export/build-export-package.js';
import { buildSingleHtmlDocument } from '../html/assets/js/scenesync-export/export/single-html-format.js';
import { createDracoTriangleGlb } from './lib/scenesync-e2e-fixtures.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gaussianFixturePath = path.join(
  repoRoot,
  'html/scenesync/experiments/fixtures/ring-gaussian-splats.glb',
);
const hdriFixturePath = path.join(repoRoot, 'html/assets/hdri/studio.hdr');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(repoRoot, '.playwright-browsers');
const { chromium } = await import('playwright');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function align4(length) {
  return (length + 3) & ~3;
}

// A complete, tiny triangle GLB keeps this test self-contained while ensuring
// GLTFLoader consumes an embedded binary asset rather than a primitive fallback.
function createTriangleGlb() {
  const json = new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: 42 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
  }));
  const jsonLength = align4(json.length);
  const binaryLength = 44;
  const glb = new Uint8Array(12 + 8 + jsonLength + 8 + binaryLength);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, glb.length, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.set(json, 20);
  glb.fill(0x20, 20 + json.length, 20 + jsonLength);
  const binaryOffset = 20 + jsonLength;
  view.setUint32(binaryOffset, binaryLength, true);
  view.setUint32(binaryOffset + 4, 0x004e4942, true);
  const data = new DataView(glb.buffer, binaryOffset + 8);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => data.setFloat32(index * 4, value, true));
  data.setUint16(36, 0, true);
  data.setUint16(38, 1, true);
  data.setUint16(40, 2, true);
  return glb;
}

function createToneWav() {
  const sampleRate = 8000;
  const sampleCount = sampleRate;
  const wav = new Uint8Array(44 + sampleCount);
  const view = new DataView(wav.buffer);
  wav.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 36 + sampleCount, true);
  wav.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  wav.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, sampleCount, true);
  for (let index = 0; index < sampleCount; index += 1) {
    wav[44 + index] = 128 + Math.round(48 * Math.sin((2 * Math.PI * 440 * index) / sampleRate));
  }
  return wav;
}

function createTinyWebm() {
  return Uint8Array.from(Buffer.from(
    'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwH/////////EU2bdKtNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHLTbuMU6uEElTDZ1OsggEY7AEAAAAAAABoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmpSrXsYMPQkBNgIxMYXZmNjIuMy4xMDBXQYxMYXZmNjIuMy4xMDAWVK5ryK4BAAAAAAAAP9eBAXPFiAeNfLrYrNMlnIEAIrWcg3VuZIiBAIaFVl9WUDmDgQEj44OEAmJaAOCQsIEQuoEQmoECVbCEVbmBARJUw2fbc3OfY8CAZ8iZRaOHRU5DT0RFUkSHjExhdmY2Mi4zLjEwMHNztmPAi2PFiAeNfLrYrNMlZ8ilRaOHRU5DT0RFUkSHmExhdmM2Mi4xMS4xMDAgbGlidnB4LXZwOR9DtnVArueBAKOrgQAAgIJJg0IAAPAA9gA4JBwYSgAAMGAAABC///cdr////1/f////8irAAKOTgQAoAIYAQJKcAFAAAANgAABCQKOTgQBQAIYAQJKcAE7gAANgAABCQKOTgQB4AIYAQJKcAFAAAANgAABCQKOTgQCgAIYAQJKcAE1AAANgAABCQKOTgQDIAIYAQJKcAFAAAANgAABCQKOTgQDwAIYAQJKcAE7gAANgAABCQA==',
    'base64',
  ));
}

function addSingleHtmlTestInstrumentation(viewerFiles) {
  const viewerEntry = viewerFiles['viewer/viewer.js'];
  assert(typeof viewerEntry === 'string', 'Viewer entry source is unavailable for test instrumentation');
  const instrumented = viewerEntry
    .replace(
      'const scene = new THREE.Scene();',
      'const scene = new THREE.Scene();\n  globalThis.__SCENE_SYNC_SINGLE_HTML_TEST_SCENE__ = scene;',
    )
    .replace(
      'const bgmAudio = viewerCore.getBgmAudio();',
      'const bgmAudio = viewerCore.getBgmAudio();\n  globalThis.__SCENE_SYNC_SINGLE_HTML_TEST_BGM_AUDIO__ = bgmAudio;',
    );
  assert(instrumented.includes('__SCENE_SYNC_SINGLE_HTML_TEST_SCENE__'), 'Unable to instrument viewer scene for physics observation');
  assert(instrumented.includes('__SCENE_SYNC_SINGLE_HTML_TEST_BGM_AUDIO__'), 'Unable to instrument viewer audio for playback observation');
  return { ...viewerFiles, 'viewer/viewer.js': instrumented };
}

async function loadViewerFiles() {
  const files = {};
  for (const { src, dest, binary = false, transform = null } of [
    ...VIEWER_SOURCES,
    ...SINGLE_HTML_HANDOFF_SOURCES,
  ]) {
    const absolutePath = path.join(repoRoot, 'html', src.replace(/^\//u, ''));
    const raw = await readFile(absolutePath);
    const content = binary ? raw : raw.toString('utf8');
    files[dest] = typeof transform === 'function' ? transform(content) : content;
  }
  return files;
}

const sceneDocument = {
  format: 'scene-sync-export-scene',
  version: 2,
  units: 'meters',
  objects: [
    {
      id: 'ground', position: [0, -0.1, 0], rotation: [0, 0, 0, 1], scale: [4, 0.2, 4],
      asset: { type: 'primitive', primitive: 'box', color: '#555555' },
      physics: { enabled: true, bodyType: 'static', shape: 'box', halfExtents: [2, 0.1, 2] },
    },
    {
      id: 'box', position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      asset: { type: 'primitive', primitive: 'box', color: '#4488ff' },
      physics: { enabled: true, bodyType: 'dynamic', shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
    },
    {
      id: 'image', position: [-2, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      asset: { type: 'image', path: 'assets/pixel.png' },
    },
    {
      id: 'mesh', position: [2, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      asset: { type: 'mesh', path: 'assets/triangle.glb' },
    },
    {
      id: 'gaussian', position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [2, 2, 2],
      asset: { type: 'mesh', path: 'assets/ring-gaussian-splats.glb' },
    },
    {
      id: 'text', position: [0, 2.5, -1], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      asset: { type: 'text', source: 'inline', text: 'SceneSync WebGPU', color: '#ffffff' },
    },
    {
      id: 'video', position: [-2, 2, -1], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      asset: { type: 'video', path: 'assets/tiny.webm' },
    },
    {
      id: 'draco', position: [2, 2, -1], rotation: [0, 0, 0, 1], scale: [1, 1, 1],
      asset: { type: 'mesh', path: 'assets/draco-triangle.glb' },
    },
  ],
  skybox: { asset: { path: 'assets/studio.hdr' } },
  bgm: { asset: { path: 'assets/tone.wav' }, loop: true, volume: 0 },
  physics: { enabled: true, duration: 2, worldOptions: { gravity: -9.81 } },
  behaviors: { scene: { nodes: [], edges: [] } },
};

let browser;
let tempDir;
try {
  const viewerFiles = addSingleHtmlTestInstrumentation(await loadViewerFiles());
  const html = await buildSingleHtmlDocument({
    sceneDocument,
    manifest: {
      format: 'scene-sync-export', version: 1,
      singleHtml: { format: 'single-html-v1', version: 1 },
    },
    files: {
      'assets/pixel.png': Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL8WQAAAABJRU5ErkJggg==', 'base64')),
      'assets/triangle.glb': createTriangleGlb(),
      'assets/ring-gaussian-splats.glb': await readFile(gaussianFixturePath),
      'assets/studio.hdr': await readFile(hdriFixturePath),
      'assets/tiny.webm': createTinyWebm(),
      'assets/draco-triangle.glb': createDracoTriangleGlb(),
      'assets/tone.wav': createToneWav(),
    },
    viewerFiles,
  });
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'scene-sync-single-html-'));
  const htmlPath = path.join(tempDir, 'portable-scene.html');
  await writeFile(htmlPath, html);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const pageErrors = [];
  const consoleErrors = [];
  const requestUrls = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') consoleErrors.push(message.text());
  });
  page.on('request', (request) => requestUrls.push(request.url()));
  await page.addInitScript(() => {
    window.open = (url) => {
      globalThis.__SCENE_SYNC_SINGLE_HTML_TEST_OPEN_URL__ = String(url);
      return null;
    };
  });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('loading-overlay')?.classList.contains('hidden'), null, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('[data-player-play-pause]'), null, { timeout: 10000 });
  await page.waitForFunction(() => (
    globalThis.__sceneSyncViewerDiagnostics?.rendered === true
    && globalThis.__sceneSyncViewerDiagnostics?.gaussianObjects >= 1
  ), null, { timeout: 20000 });
  assert(await page.locator('#scene-sync-handoff').isHidden(), 'Open in Scene Sync must start collapsed');
  await page.locator('#scene-sync-handoff-toggle').click();
  await page.locator('#scene-sync-handoff-room').fill(' Smoke Room! ');
  await page.locator('#scene-sync-handoff button[type="submit"]').click();
  await page.waitForFunction(() => document.getElementById('scene-sync-handoff-status')?.textContent.includes('Popup was blocked'));
  await page.waitForTimeout(800);
  await page.waitForFunction(() => globalThis.__SCENE_SYNC_SINGLE_HTML_TEST_BGM_AUDIO__?.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA, null, { timeout: 10000 });
  const initialDynamicBodyY = await page.evaluate(() => {
    let box = null;
    globalThis.__SCENE_SYNC_SINGLE_HTML_TEST_SCENE__?.traverse((object) => {
      if (object.userData?.objectId === 'box') box = object;
    });
    return box?.position?.y;
  });
  assert(Number.isFinite(initialDynamicBodyY), 'Dynamic physics body was not added to the viewer scene');
  await page.locator('[data-player-play-pause]').click();
  await page.waitForFunction(() => document.querySelector('[data-player-play-pause]')?.dataset.playerPlaying === '1');
  await page.locator('#viewer-controls button', { hasText: 'Play BGM' }).click();
  await page.waitForFunction(() => {
    const audio = globalThis.__SCENE_SYNC_SINGLE_HTML_TEST_BGM_AUDIO__;
    return audio?.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && audio.error === null && audio.paused === false;
  }, null, { timeout: 10000 });
  await page.waitForFunction((initialY) => {
    let box = null;
    globalThis.__SCENE_SYNC_SINGLE_HTML_TEST_SCENE__?.traverse((object) => {
      if (object.userData?.objectId === 'box') box = object;
    });
    return Number.isFinite(box?.position?.y) && box.position.y < initialY - 0.05;
  }, initialDynamicBodyY, { timeout: 10000 });
  await page.locator('[data-player-rate="2"]').click();
  await page.locator('[data-player-seek]').evaluate((element) => {
    element.value = '0.5';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('[data-player-play-pause]').click();
  await page.waitForFunction(() => document.querySelector('[data-player-play-pause]')?.dataset.playerPlaying === '0');
  const state = await page.evaluate(() => ({
    format: document.querySelector('meta[name="scene-sync-export-format"]')?.content,
    hasAssets: Boolean(window.__SCENE_SYNC_SINGLE_HTML_ASSET_URLS__),
    hasSceneDocument: Boolean(window.__SCENE_SYNC_SINGLE_HTML_SCENE_DOCUMENT__),
    gaussian: globalThis.__sceneSyncViewerDiagnostics || null,
    canvasWidth: document.getElementById('viewer-canvas')?.width || 0,
    videoTextures: (() => {
      let count = 0;
      globalThis.__SCENE_SYNC_SINGLE_HTML_TEST_SCENE__?.traverse((object) => {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (material?.map?.isVideoTexture) count += 1;
        }
      });
      return count;
    })(),
    loading: document.getElementById('loading-overlay')?.textContent,
    fileWarningVisible: !document.getElementById('file-protocol-warning')?.classList.contains('hidden'),
    missingNoticeVisible: !document.getElementById('missing-notice')?.classList.contains('hidden'),
    playerRate: document.querySelector('[data-player-rate="2"]')?.dataset.active,
    playerTime: document.querySelector('[data-player-current-time]')?.textContent,
    bgmControlPresent: [...document.querySelectorAll('#viewer-controls button')].some((button) => button.textContent.includes('BGM')),
    handoff: {
      present: Boolean(document.getElementById('scene-sync-handoff')),
      room: document.getElementById('scene-sync-handoff-room')?.value,
      status: document.getElementById('scene-sync-handoff-status')?.textContent,
      openUrl: globalThis.__SCENE_SYNC_SINGLE_HTML_TEST_OPEN_URL__ || null,
    },
    bgmAudio: (() => {
      const audio = globalThis.__SCENE_SYNC_SINGLE_HTML_TEST_BGM_AUDIO__;
      return audio ? { readyState: audio.readyState, paused: audio.paused, error: audio.error?.message || null } : null;
    })(),
    dynamicBodyY: (() => {
      let box = null;
      globalThis.__SCENE_SYNC_SINGLE_HTML_TEST_SCENE__?.traverse((object) => {
        if (object.userData?.objectId === 'box') box = object;
      });
      return box?.position?.y;
    })(),
  }));
  assert(pageErrors.length === 0, `Page errors: ${pageErrors.join('\n')}`);
  assert(!consoleErrors.some((message) => message.includes('Rapier initialization failed')), `Rapier failed to initialize: ${consoleErrors.join('\n')}`);
  assert(state.format === 'single-html-v1', 'Single HTML format marker was not preserved');
  assert(state.hasAssets && state.hasSceneDocument, 'Embedded resolver payload was not initialized');
  assert(state.canvasWidth > 0, 'Viewer canvas was not initialized');
  assert(state.gaussian?.renderer === 'WebGPURenderer', 'Single HTML viewer did not use WebGPURenderer');
  assert(state.gaussian?.backend === 'webgl', 'Single HTML viewer default backend was not WebGL');
  assert(state.gaussian?.xrEnabled === true, 'Single HTML viewer WebXR integration was not enabled');
  assert(state.gaussian?.gaussianObjects >= 1, 'Single HTML viewer did not create a GaussianSplat');
  assert(state.gaussian?.splatCount === 16, 'Single HTML viewer did not preserve all fixture splats');
  assert(state.gaussian?.objectCount === 8, 'Single HTML did not load Gaussian, Draco, media, text, and primitive objects together');
  assert(state.gaussian?.rendered === true, 'Single HTML viewer did not render a GaussianSplat frame');
  assert(state.gaussian?.environmentLoaded === true, 'Single HTML HDRI/PMREM environment did not load');
  assert(state.videoTextures >= 1, 'Single HTML VideoTexture object did not initialize');
  assert(requestUrls.some((requestUrl) => (
    requestUrl.includes('cbba126004263d0c32d3d6d05a4fe218d261fa47')
    && /draco_decoder(?:\.wasm|\.js)$/u.test(requestUrl)
  )), 'Single HTML did not use the pinned Three.js Draco decoder');
  assert(!state.fileWarningVisible, 'Single HTML should not show the Static ZIP file:// warning');
  assert(!state.missingNoticeVisible, 'Embedded image or GLB was reported missing');
  assert(state.playerRate === 'true' && state.playerTime !== '00:00.00', 'Playback controls did not update the embedded scene clock');
  assert(state.bgmControlPresent, 'Embedded audio did not produce a playback control');
  assert(state.handoff.present, 'Single HTML did not render the Open in Scene Sync controls');
  assert(state.handoff.room === 'smokeroom', 'Single HTML did not sanitize the optional Room ID');
  // Claude-style nested srcdoc sandbox: this is the one proof-positive case
  // where the control is pre-disabled rather than waiting for window.open.
  const embeddedPage = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await embeddedPage.setContent('<iframe id="embedded" sandbox="allow-scripts allow-same-origin"></iframe>');
  await embeddedPage.locator('#embedded').evaluate((frame, source) => { frame.srcdoc = source; }, html);
  const embedded = embeddedPage.frames().find((frame) => frame !== embeddedPage.mainFrame());
  // The form stays collapsed here: a sandboxed viewer cannot start, so its
  // loading overlay covers the toggle. Pre-disabled state is what matters.
  await embedded.waitForSelector('#scene-sync-handoff button[type="submit"]', { state: 'attached' });
  const embeddedState = await embedded.evaluate(() => ({
    input: document.getElementById('scene-sync-handoff-room')?.disabled,
    primaryButton: document.querySelector('#scene-sync-handoff button[type="submit"]')?.disabled,
    tokenButtonVisible: !document.querySelector('.scene-sync-token-transfer')?.hidden,
    status: document.getElementById('scene-sync-handoff-status')?.textContent,
  }));
  assert(embeddedState.input === false && embeddedState.primaryButton && embeddedState.tokenButtonVisible,
    'proof-positive sandbox must keep the room enabled, disable primary Open, and offer token transfer');
  assert(embeddedState.status?.includes('Popup access is unavailable here. Use token transfer instead.'), 'sandboxed token-transfer guidance was not shown');
  await embeddedPage.close();
  // Opaque-origin sandboxes cannot expose frameElement to their child. That is
  // inconclusive by design: leave controls enabled and retain runtime popup
  // blocking rather than guessing from a provider/frame heuristic.
  const opaquePage = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await opaquePage.setContent('<iframe id="opaque" sandbox="allow-scripts allow-forms"></iframe>');
  await opaquePage.locator('#opaque').evaluate((frame, source) => { frame.srcdoc = source; }, html);
  const opaque = opaquePage.frames().find((frame) => frame !== opaquePage.mainFrame());
  await opaque.waitForSelector('#scene-sync-handoff button[type="submit"]', { state: 'attached' });
  assert(await opaque.locator('#scene-sync-handoff-room').isDisabled() === false, 'opaque sandbox must not be pre-disabled');
  assert(await opaque.locator('#scene-sync-handoff button[type="submit"]').isDisabled() === false, 'opaque sandbox must retain runtime fallback');
  await opaque.locator('#scene-sync-handoff').evaluate((form) => form.requestSubmit());
  await opaque.waitForFunction(() => document.getElementById('scene-sync-handoff-status')?.textContent.includes('Popup was blocked'), null, { timeout: 10_000 });
  await opaquePage.close();
  assert(new URL(state.handoff.openUrl).searchParams.get('handoff') === '1', 'Single HTML handoff URL omitted handoff mode');
  assert(new URL(state.handoff.openUrl).searchParams.get('room') === 'smokeroom', 'Single HTML handoff URL omitted the sanitized room');
  assert(state.handoff.status.includes('Popup was blocked'), 'Single HTML did not show popup-blocked feedback');
  assert(state.bgmAudio?.readyState >= 2 && state.bgmAudio.error === null && state.bgmAudio.paused === false, 'Embedded audio did not become playable after a user action');
  assert(state.dynamicBodyY < initialDynamicBodyY - 0.05, 'Rapier did not move the dynamic body under gravity');
  assert(!requestUrls.some((url) => url.startsWith('file:') && url !== pathToFileURL(htmlPath).href), `Unexpected sibling file request: ${requestUrls.join(', ')}`);
  assert(!requestUrls.some((url) => /rapier_wasm3d_bg\.wasm|assets\/(?:pixel\.png|triangle\.glb|draco-triangle\.glb|ring-gaussian-splats\.glb|studio\.hdr|tiny\.webm|tone\.wav)/u.test(url)), `Embedded assets used a sibling request: ${requestUrls.join(', ')}`);
  console.log(JSON.stringify({ status: 'passed', ...state, requestUrls }, null, 2));
} finally {
  await browser?.close();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
}
