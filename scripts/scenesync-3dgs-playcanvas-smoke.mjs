import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlRoot = path.join(repoRoot, 'html');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(repoRoot, '.playwright-browsers');
const { chromium } = await import('playwright');

const mimeByExtension = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.glb', 'model/gltf-binary'],
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createStaticServer() {
  return new Promise((resolve, reject) => {
    const server = createServer(async (request, response) => {
      const pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
      const filePath = path.resolve(htmlRoot, `.${pathname}`);
      if (!filePath.startsWith(`${htmlRoot}${path.sep}`)) {
        response.writeHead(400).end('Bad request');
        return;
      }
      try {
        const body = await readFile(filePath);
        response.writeHead(200, {
          'content-type': mimeByExtension.get(path.extname(filePath)) || 'application/octet-stream',
          'content-length': body.byteLength,
        });
        response.end(body);
      } catch {
        response.writeHead(404).end('Not found');
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

const server = await createStaticServer();
const address = server.address();
const url = `http://127.0.0.1:${address.port}/scenesync/experiments/3dgs-playcanvas-webxr-smoke.html?fixture=ring`;

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || /WebGL: INVALID_OPERATION/iu.test(message.text())) {
      consoleErrors.push(message.text());
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__playCanvasGaussianXrSmoke?.done === true, null, {
    timeout: 30000,
  });
  await page.waitForFunction(() => globalThis.__playCanvasGaussianXrSmoke?.rendered === true, null, {
    timeout: 15000,
  });
  await page.waitForFunction(() => globalThis.__playCanvasGaussianXrSmoke?.framesSampled >= 10, null, {
    timeout: 15000,
  });
  const result = await page.evaluate(() => globalThis.__playCanvasGaussianXrSmoke);

  assert(!result.error, result.error || 'PlayCanvas Gaussian smoke failed');
  assert(result.engine === 'PlayCanvas', 'Smoke did not use PlayCanvas');
  assert(result.engineVersion === '2.21.4', 'PlayCanvas revision changed');
  assert(result.renderer === 'GSPLAT_RENDERER_RASTER_CPU_SORT', 'XR-capable CPU sort renderer was not selected');
  assert(result.currentRenderer === 'raster CPU sort', 'PlayCanvas did not activate the requested CPU sort renderer');
  assert(result.format === 'KHR_gaussian_splatting GLB', 'Smoke did not load the normalized KHR GLB');
  assert(result.gaussianObjects >= 1, 'PlayCanvas container did not create a GSplat component');
  assert(result.splatCount === 16, 'ring fixture splat count changed');
  assert(result.normalObjects === 3, 'normal depth markers were not configured');
  assert(result.cameraControls === 'orbit-pan-zoom-wasd', 'PlayCanvas camera controls are unavailable');
  assert(result.rendered === true, 'PlayCanvas GSplat frame was not rendered');
  assert(result.timingMode === 'desktop', 'Desktop timing mode was not reported');
  assert(result.fps > 0, 'Frame rate was not measured');
  assert(result.frameTimeMs > 0, 'Average frame interval was not measured');
  assert(result.p95FrameTimeMs > 0, 'P95 frame interval was not measured');
  assert(pageErrors.length === 0, `Page errors: ${pageErrors.join('\n')}`);
  assert(consoleErrors.length === 0, `Console errors: ${consoleErrors.join('\n')}`);

  const initialCameraPosition = result.cameraPosition;
  await page.mouse.move(720, 420);
  await page.mouse.down();
  await page.mouse.move(640, 360, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction((initialPosition) => {
    const smoke = globalThis.__playCanvasGaussianXrSmoke;
    return smoke?.cameraInputEvents > 0 && smoke.cameraPosition.some(
      (value, index) => Math.abs(value - initialPosition[index]) > 0.01,
    );
  }, initialCameraPosition, { timeout: 5000 });
  const movedCamera = await page.evaluate(() => globalThis.__playCanvasGaussianXrSmoke.cameraPosition);
  await page.click('#reset-camera');
  await page.waitForFunction((initialPosition) => (
    globalThis.__playCanvasGaussianXrSmoke.cameraPosition.every(
      (value, index) => Math.abs(value - initialPosition[index]) < 0.0001,
    )
  ), initialCameraPosition, { timeout: 5000 });

  await page.mouse.move(720, 420);
  await page.mouse.wheel(0, -300);
  await page.waitForFunction((initialPosition) => (
    globalThis.__playCanvasGaussianXrSmoke.cameraPosition.some(
      (value, index) => Math.abs(value - initialPosition[index]) > 0.01,
    )
  ), initialCameraPosition, { timeout: 5000 });
  const zoomedCamera = await page.evaluate(() => globalThis.__playCanvasGaussianXrSmoke.cameraPosition);
  await page.click('#reset-camera');

  await page.keyboard.down('w');
  await page.waitForTimeout(250);
  await page.keyboard.up('w');
  await page.waitForFunction(() => (
    Math.abs(globalThis.__playCanvasGaussianXrSmoke.cameraTarget[2]) > 0.01
  ), null, { timeout: 5000 });
  const keyboardTarget = await page.evaluate(() => globalThis.__playCanvasGaussianXrSmoke.cameraTarget);
  await page.click('#reset-camera');

  const directImports = [];
  for (const extension of ['sog', 'ply']) {
    const filename = `ring-gaussian-splats.${extension}`;
    const fixture = path.join(htmlRoot, 'scenesync/experiments/fixtures', filename);
    await page.setInputFiles('#file-input', fixture);
    try {
      await page.waitForFunction((expectedSource) => (
        globalThis.__playCanvasGaussianXrSmoke?.source === expectedSource
      ), filename, { timeout: 5000 });
      await page.waitForFunction(() => {
        const smoke = globalThis.__playCanvasGaussianXrSmoke;
        return smoke?.error || (smoke?.done === true && smoke.rendered === true);
      }, null, { timeout: 30000 });
    } catch (error) {
      const stalled = await page.evaluate(() => globalThis.__playCanvasGaussianXrSmoke);
      throw new Error(`${filename} stalled: ${JSON.stringify({ stalled, pageErrors, consoleErrors })}`, {
        cause: error,
      });
    }
    const imported = await page.evaluate(() => globalThis.__playCanvasGaussianXrSmoke);
    assert(!imported.error, imported.error || `PlayCanvas ${extension.toUpperCase()} import failed`);
    assert(imported.format === extension.toUpperCase(), `PlayCanvas did not identify ${extension.toUpperCase()}`);
    assert(imported.gaussianObjects >= 1, `${extension.toUpperCase()} did not create a GSplat component`);
    assert(imported.splatCount === 16, `${extension.toUpperCase()} fixture splat count changed`);
    directImports.push({ format: imported.format, splatCount: imported.splatCount });
  }
  assert(pageErrors.length === 0, `Page errors after direct imports: ${pageErrors.join('\n')}`);
  assert(consoleErrors.length === 0, `Console errors after direct imports: ${consoleErrors.join('\n')}`);

  let realSogTiming = null;
  const realSogPath = process.env.SCENE_SYNC_3DGS_PLAYCANVAS_REAL_SOG;
  if (realSogPath) {
    const filename = path.basename(realSogPath);
    await page.setInputFiles('#file-input', path.resolve(realSogPath));
    await page.waitForFunction((expectedSource) => {
      const smoke = globalThis.__playCanvasGaussianXrSmoke;
      return smoke?.source === expectedSource && smoke.done === true && smoke.rendered === true;
    }, filename, { timeout: 120000 });
    await page.waitForFunction(() => (
      globalThis.__playCanvasGaussianXrSmoke?.framesSampled >= 60
    ), null, { timeout: 30000 });
    const measured = await page.evaluate(() => globalThis.__playCanvasGaussianXrSmoke);
    assert(!measured.error, measured.error || 'Real SOG timing load failed');
    assert(measured.splatCount > 16, 'Real SOG did not replace the ring fixture');
    realSogTiming = {
      source: measured.source,
      splatCount: measured.splatCount,
      fps: measured.fps,
      frameTimeMs: measured.frameTimeMs,
      p95FrameTimeMs: measured.p95FrameTimeMs,
      framesSampled: measured.framesSampled,
    };
  }

  console.log(JSON.stringify({
    status: 'passed',
    url,
    ...result,
    cameraMoved: movedCamera,
    cameraZoomed: zoomedCamera,
    cameraKeyboardTarget: keyboardTarget,
    cameraReset: true,
    directImports,
    realSogTiming,
  }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
