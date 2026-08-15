import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VIEWER_SOURCES,
  generateExportIndexHtml,
} from '../html/assets/js/scenesync-export/export/build-export-package.js';
import { generateManifest } from '../html/assets/js/scenesync-export/export/export-manifest.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const htmlRoot = path.join(repoRoot, 'html');
const browserPath = path.join(repoRoot, '.playwright-browsers');

process.env.PLAYWRIGHT_BROWSERS_PATH ||= browserPath;

const keepTemp = process.argv.includes('--keep-temp');
const smokeTitle = 'Scene Sync Static Viewer Smoke';

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sendBuffer(res, status, body, headers = {}) {
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,HEAD,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'content-length': body.byteLength,
    ...headers,
  });
  res.end(body);
}

function serverUrl(server) {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Static server did not expose a TCP address');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function resolveStaticPath(rootDir, rawUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl || '/', 'http://localhost').pathname);
  } catch {
    return null;
  }

  if (pathname.endsWith('/')) {
    pathname = `${pathname}index.html`;
  }

  const candidate = path.resolve(rootDir, `.${pathname}`);
  if (!candidate.startsWith(`${rootDir}${path.sep}`) && candidate !== rootDir) {
    return null;
  }
  return { filePath: candidate, pathname };
}

function createStaticServer(rootDir, requestLog) {
  const server = createServer(async (req, res) => {
    const resolved = resolveStaticPath(rootDir, req.url);
    const entry = {
      method: req.method,
      pathname: resolved?.pathname || null,
      status: null,
    };
    requestLog.push(entry);

    const send = (status, body, headers = {}) => {
      entry.status = status;
      sendBuffer(res, status, body, headers);
    };

    if (req.method === 'OPTIONS') {
      send(204, Buffer.alloc(0));
      return;
    }

    if (resolved?.pathname === '/favicon.ico') {
      send(204, Buffer.alloc(0));
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(405, Buffer.from('Method not allowed'), {
        'content-type': 'text/plain; charset=utf-8',
      });
      return;
    }

    if (!resolved) {
      send(400, Buffer.from('Bad request'), {
        'content-type': 'text/plain; charset=utf-8',
      });
      return;
    }

    try {
      const body = await readFile(resolved.filePath);
      const contentType = mimeTypes.get(path.extname(resolved.filePath).toLowerCase())
        || 'application/octet-stream';
      send(200, req.method === 'HEAD' ? Buffer.alloc(0) : body, {
        'content-type': contentType,
        ...(req.method === 'HEAD' ? { 'content-length': body.byteLength } : {}),
      });
    } catch {
      send(404, Buffer.from('Not found'), {
        'content-type': 'text/plain; charset=utf-8',
      });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function createSmokeSceneDocument() {
  return {
    format: 'scene-sync-export-scene',
    version: 2,
    title: smokeTitle,
    units: 'meters',
    objects: [
      {
        id: 'smoke-floor',
        name: 'Smoke Floor',
        position: [0, -0.05, 0],
        rotation: [0, 0, 0, 1],
        scale: [6, 0.1, 6],
        visible: true,
        asset: {
          type: 'primitive',
          primitive: 'box',
          color: '#3b4658',
        },
        physics: {
          version: 1,
          enabled: true,
          bodyType: 'static',
          shape: 'box',
          halfExtents: [3, 0.05, 3],
          restitution: 0.1,
          friction: 0.8,
        },
      },
      {
        id: 'smoke-box',
        name: 'Smoke Box',
        position: [0, 1.25, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        visible: true,
        asset: {
          type: 'primitive',
          primitive: 'box',
          color: '#4f9cff',
        },
        physics: {
          version: 1,
          enabled: true,
          bodyType: 'dynamic',
          shape: 'box',
          mass: 1,
          halfExtents: [0.5, 0.5, 0.5],
          velocity: [0, 0, 0],
          angularVelocity: [0, 0, 0],
          restitution: 0.2,
          friction: 0.5,
        },
      },
    ],
    physics: {
      version: 1,
      enabled: true,
      duration: 1.5,
      worldOptions: {
        gravity: [0, -9.81, 0],
        ground: {
          y: 0,
          restitution: 0.2,
          friction: 0.5,
        },
        timestep: 1 / 60,
      },
    },
    skybox: null,
    bgm: null,
  };
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function copyViewerSources(exportRoot) {
  const copied = [];
  for (const source of VIEWER_SOURCES) {
    const sourcePath = path.join(htmlRoot, source.src.replace(/^\/+/, ''));
    const destPath = path.join(exportRoot, source.dest);
    await mkdir(path.dirname(destPath), { recursive: true });

    if (source.binary) {
      const body = await readFile(sourcePath);
      await writeFile(destPath, body);
    } else {
      const input = await readFile(sourcePath, 'utf8');
      const output = typeof source.transform === 'function' ? source.transform(input) : input;
      await writeFile(destPath, output, 'utf8');
    }
    copied.push(source.dest);
  }
  return copied;
}

async function createExportFixture() {
  const exportRoot = await mkdtemp(path.join(tmpdir(), 'scenesync-static-viewer-smoke-'));
  await writeFile(path.join(exportRoot, 'index.html'), generateExportIndexHtml(), 'utf8');
  await writeJson(path.join(exportRoot, 'scene.json'), createSmokeSceneDocument());
  await writeJson(path.join(exportRoot, 'manifest.json'), generateManifest({
    assetManifest: [],
    missingAssets: [],
    cdnDependent: true,
    metadata: {
      title: smokeTitle,
      description: 'Minimal exported Scene Sync scene used by the static viewer smoke test.',
      tags: ['smoke-test'],
      author: 'Scene Sync',
    },
  }));

  const copied = await copyViewerSources(exportRoot);
  return { exportRoot, copied };
}

async function assertExportFixture(exportRoot, copied) {
  assert(copied.includes('viewer/rapier/rapier.js'), 'Rapier JS source was not copied');
  assert(copied.includes('viewer/rapier/rapier_wasm3d_bg.wasm'), 'Rapier WASM source was not copied');
  assert(copied.includes('scenesync/runtime/event-timeline.js'), 'event timeline runtime was not copied');
  assert(copied.includes('scenesync/handoff/source.js'), 'Static handoff source was not copied');

  await stat(path.join(exportRoot, 'viewer/rapier/rapier.js'));
  await stat(path.join(exportRoot, 'viewer/rapier/rapier_wasm3d_bg.wasm'));
  await stat(path.join(exportRoot, 'scenesync/runtime/event-timeline.js'));
  await stat(path.join(exportRoot, 'scenesync/handoff/source.js'));

  const indexHtml = await readFile(path.join(exportRoot, 'index.html'), 'utf8');
  assert(/<link rel="scene-sync-export" href="\.\/scene\.json">/u.test(indexHtml), 'Static export marker is missing');

  const rapierJs = await readFile(path.join(exportRoot, 'viewer/rapier/rapier.js'), 'utf8');
  assert(!/sourceMappingURL=/u.test(rapierJs), 'Rapier JS still references a source map that is not exported');
}

function relevantConsoleErrors(consoleMessages) {
  return consoleMessages.filter((entry) => {
    const text = String(entry.text || '');
    if (entry.type === 'warning' && /\b(Rapier|scene-physics|WebAssembly|wasm)\b/iu.test(text)) return true;
    if (entry.type !== 'error') return false;
    if (/GL Driver Message .*ReadPixels/.test(entry.text)) return false;
    return true;
  });
}

async function waitForRenderedScenePixels(page) {
  await page.waitForFunction(() => {
    const canvas = document.getElementById('viewer-canvas');
    const gl = canvas?.getContext?.('webgl2') || canvas?.getContext?.('webgl');
    if (!gl || gl.drawingBufferWidth <= 0 || gl.drawingBufferHeight <= 0) return false;

    const points = [];
    for (let y = 0.22; y <= 0.78; y += 0.08) {
      for (let x = 0.22; x <= 0.78; x += 0.08) {
        points.push([x, y]);
      }
    }
    const samples = [];
    const pixel = new Uint8Array(4);
    for (const [xRatio, yRatio] of points) {
      const x = Math.max(0, Math.min(gl.drawingBufferWidth - 1, Math.floor(gl.drawingBufferWidth * xRatio)));
      const y = Math.max(0, Math.min(gl.drawingBufferHeight - 1, Math.floor(gl.drawingBufferHeight * yRatio)));
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      samples.push(Array.from(pixel));
    }
    const visibleSamples = samples.filter(([, , , alpha]) => alpha > 0);
    const buckets = new Set(visibleSamples.map(([red, green, blue, alpha]) => (
      `${red >> 4}:${green >> 4}:${blue >> 4}:${alpha >> 4}`
    )));
    const ranges = visibleSamples.reduce((acc, [red, green, blue]) => ({
      minRed: Math.min(acc.minRed, red),
      maxRed: Math.max(acc.maxRed, red),
      minGreen: Math.min(acc.minGreen, green),
      maxGreen: Math.max(acc.maxGreen, green),
      minBlue: Math.min(acc.minBlue, blue),
      maxBlue: Math.max(acc.maxBlue, blue),
    }), {
      minRed: 255,
      maxRed: 0,
      minGreen: 255,
      maxGreen: 0,
      minBlue: 255,
      maxBlue: 0,
    });
    const maxChannelRange = Math.max(
      ranges.maxRed - ranges.minRed,
      ranges.maxGreen - ranges.minGreen,
      ranges.maxBlue - ranges.minBlue,
    );

    window.__sceneSyncStaticViewerSmokePixels = {
      samples,
      visibleSampleCount: visibleSamples.length,
      bucketCount: buckets.size,
      maxChannelRange,
    };
    return visibleSamples.length >= 24 && buckets.size >= 3 && maxChannelRange >= 24;
  }, null, { timeout: 15000 });
}

function assertRequested(requestLog, pattern, label) {
  assert(
    requestLog.some((entry) => pattern.test(entry.pathname || '') && entry.status >= 200 && entry.status < 300),
    `${label} was not requested successfully by the static viewer`
  );
}

async function runViewerSmoke(exportRoot) {
  const { chromium } = await import('playwright');
  const requestLog = [];
  const server = await createStaticServer(exportRoot, requestLog);
  const result = {
    url: `${serverUrl(server)}/index.html`,
    requestLog,
    console: [],
    pageErrors: [],
    requestFailures: [],
    httpErrors: [],
    canvas: null,
  };

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    page.on('console', (message) => {
      result.console.push({
        type: message.type(),
        text: message.text(),
      });
    });
    page.on('pageerror', (error) => {
      result.pageErrors.push(error.stack || error.message || String(error));
    });
    page.on('requestfailed', (request) => {
      result.requestFailures.push({
        url: request.url(),
        failure: request.failure()?.errorText || 'unknown',
      });
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        result.httpErrors.push({
          url: response.url(),
          status: response.status(),
        });
      }
    });

    await page.goto(result.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#viewer-canvas', { state: 'attached', timeout: 10000 });
    await page.waitForFunction(() => (
      document.getElementById('loading-overlay')?.classList.contains('hidden') === true
    ), null, { timeout: 20000 });
    await page.waitForSelector('[data-player-play-pause]', { state: 'attached', timeout: 10000 });
    await page.waitForTimeout(1200);
    await waitForRenderedScenePixels(page);

    result.canvas = await page.evaluate(() => {
      const canvas = document.getElementById('viewer-canvas');
      const loadingOverlay = document.getElementById('loading-overlay');
      const missingNotice = document.getElementById('missing-notice');
      return {
        width: canvas?.width || 0,
        height: canvas?.height || 0,
        clientWidth: canvas?.clientWidth || 0,
        clientHeight: canvas?.clientHeight || 0,
        loadingHidden: loadingOverlay?.classList.contains('hidden') === true,
      missingHidden: missingNotice?.classList.contains('hidden') === true,
      handoffPresent: Boolean(document.getElementById('scene-sync-handoff')),
      handoffSourceUrl: location.href,
      pixelSamples: window.__sceneSyncStaticViewerSmokePixels || [],
      };
    });

    assert(result.canvas.width > 0 && result.canvas.height > 0, 'Viewer canvas was not sized');
    assert(result.canvas.loadingHidden, 'Viewer loading overlay did not finish');
    assert(result.canvas.missingHidden, 'Viewer reported missing scene assets');
    assert(result.canvas.handoffPresent, 'Static viewer did not mount Open in Scene Sync');
    assert(result.canvas.handoffSourceUrl === result.url, 'Static viewer handoff did not use its published page URL');
    assert(result.httpErrors.length === 0, `HTTP errors while loading viewer: ${JSON.stringify(result.httpErrors, null, 2)}`);
    assert(result.requestFailures.length === 0, `Request failures while loading viewer: ${JSON.stringify(result.requestFailures, null, 2)}`);
    assert(result.pageErrors.length === 0, `Page errors while loading viewer: ${result.pageErrors.join('\n')}`);
    assertRequested(result.requestLog, /^\/viewer\/viewer\.js$/u, 'Viewer entry module');
    assertRequested(result.requestLog, /^\/viewer\/rapier\/rapier\.js$/u, 'Rapier JS runtime');
    assertRequested(result.requestLog, /^\/scenesync\/runtime\/event-timeline\.js$/u, 'Scene event timeline runtime');

    const consoleErrors = relevantConsoleErrors(result.console);
    assert(consoleErrors.length === 0, `Console errors while loading viewer: ${JSON.stringify(consoleErrors, null, 2)}`);

    return result;
  } finally {
    await browser?.close();
    await closeServer(server);
  }
}

async function run() {
  const { exportRoot, copied } = await createExportFixture();
  const summary = {
    status: 'pending',
    exportRoot,
    keepTemp,
    copiedFiles: copied.length,
    url: null,
    canvas: null,
  };

  try {
    await assertExportFixture(exportRoot, copied);
    const smokeResult = await runViewerSmoke(exportRoot);
    summary.status = 'passed';
    summary.url = smokeResult.url;
    summary.canvas = smokeResult.canvas;
    summary.requests = smokeResult.requestLog.filter((entry) => (
      entry.status >= 400 || /rapier|event-timeline|scene\.json|viewer\.js/u.test(entry.pathname || '')
    ));
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    summary.status = 'failed';
    summary.error = error.stack || error.message || String(error);
    console.error(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
  } finally {
    if (!keepTemp) {
      await rm(exportRoot, { recursive: true, force: true });
    }
  }
}

await run();
