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
const url = `http://127.0.0.1:${address.port}/scenesync/experiments/3dgs-three-webxr-stereo-smoke.html?fixture=ring`;

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
  await page.waitForFunction(() => globalThis.__threeGaussianXrStereoSmoke?.done === true, null, {
    timeout: 30000,
  });
  await page.waitForFunction(() => globalThis.__threeGaussianXrStereoSmoke?.rendered === true, null, {
    timeout: 15000,
  });
  await page.waitForFunction(() => globalThis.__threeGaussianXrStereoSmoke?.framesSampled >= 10, null, {
    timeout: 15000,
  });
  const result = await page.evaluate(() => globalThis.__threeGaussianXrStereoSmoke);

  assert(!result.error, result.error || 'Patched Three.js Gaussian smoke failed');
  assert(result.engine === 'Three.js', 'Smoke did not use Three.js');
  assert(
    result.revision === 'cbba126004263d0c32d3d6d05a4fe218d261fa47',
    'Three.js revision changed',
  );
  assert(
    result.patch === 'mediumpModelViewMatrix + cameraViewport.zw',
    'The candidate XR stereo patch changed',
  );
  assert(result.backend === 'webgl', 'Default backend is no longer WebGL');
  assert(result.gaussianObjects >= 1, 'Patched loader did not create a GaussianSplat');
  assert(result.splatCount === 16, 'ring fixture splat count changed');
  assert(result.normalObjects === 3, 'normal depth markers were not configured');
  assert(result.xrQualityPreset === 'quality', 'Three.js default XR quality preset changed');
  assert(result.xrFramebufferScale === 1, 'Three.js default XR framebuffer scale changed');
  assert(result.xrFoveation === 0, 'Three.js default XR foveation changed');
  assert(result.xrLocomotionSpeed === 1.8, 'Three.js XR locomotion speed changed');
  assert(result.xrVerticalLocomotionSpeed === 1.2, 'Three.js XR vertical speed changed');
  assert(result.xrTurnSpeedDegrees === 105, 'Three.js XR turn speed changed');
  assert(/left-stick/iu.test(result.xrLocomotion), 'Three.js PICO locomotion is unavailable');
  assert(/A up \/ B down/iu.test(result.xrLocomotion), 'Three.js PICO vertical locomotion is unavailable');
  assert(result.rendered === true, 'Patched Three.js Gaussian frame was not rendered');
  assert(result.timingMode === 'desktop', 'Desktop timing mode was not reported');
  assert(result.fps > 0, 'Frame rate was not measured');
  assert(result.frameTimeMs > 0, 'Average frame interval was not measured');
  assert(result.p95FrameTimeMs > 0, 'P95 frame interval was not measured');
  assert(pageErrors.length === 0, `Page errors: ${pageErrors.join('\n')}`);
  assert(consoleErrors.length === 0, `Console errors: ${consoleErrors.join('\n')}`);

  const localGlb = path.join(htmlRoot, 'scenesync/experiments/fixtures/ring-gaussian-splats.glb');
  await page.setInputFiles('#file-input', localGlb);
  await page.waitForFunction(() => {
    const smoke = globalThis.__threeGaussianXrStereoSmoke;
    return smoke?.done === true && smoke.rendered === true && smoke.source === 'ring-gaussian-splats.glb';
  }, null, { timeout: 15000 });
  const reloaded = await page.evaluate(() => globalThis.__threeGaussianXrStereoSmoke);
  assert(!reloaded.error, reloaded.error || 'Local KHR GLB reload failed');
  assert(reloaded.gaussianObjects >= 1, 'Local KHR GLB did not create a GaussianSplat');
  assert(reloaded.splatCount === 16, 'Local KHR GLB splat count changed');
  assert(pageErrors.length === 0, `Page errors after local GLB reload: ${pageErrors.join('\n')}`);
  assert(consoleErrors.length === 0, `Console errors after local GLB reload: ${consoleErrors.join('\n')}`);

  let realGlbTiming = null;
  const realGlbPath = process.env.SCENE_SYNC_3DGS_THREE_REAL_GLB;
  if (realGlbPath) {
    const filename = path.basename(realGlbPath);
    await page.setInputFiles('#file-input', path.resolve(realGlbPath));
    await page.waitForFunction((expectedSource) => {
      const smoke = globalThis.__threeGaussianXrStereoSmoke;
      return smoke?.source === expectedSource && smoke.done === true && smoke.rendered === true;
    }, filename, { timeout: 120000 });
    await page.waitForFunction(() => (
      globalThis.__threeGaussianXrStereoSmoke?.framesSampled >= 10
    ), null, { timeout: 120000 });
    const measured = await page.evaluate(() => globalThis.__threeGaussianXrStereoSmoke);
    assert(!measured.error, measured.error || 'Real KHR GLB timing load failed');
    assert(measured.splatCount > 16, 'Real KHR GLB did not replace the ring fixture');
    realGlbTiming = {
      source: measured.source,
      splatCount: measured.splatCount,
      fps: measured.fps,
      frameTimeMs: measured.frameTimeMs,
      p95FrameTimeMs: measured.p95FrameTimeMs,
      framesSampled: measured.framesSampled,
    };
  }

  const smoothUrl = `${url}&kernel=smooth`;
  await page.goto(smoothUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const smoke = globalThis.__threeGaussianXrStereoSmoke;
    return smoke?.done === true && smoke.rendered === true;
  }, null, { timeout: 30000 });
  const smooth = await page.evaluate(() => globalThis.__threeGaussianXrStereoSmoke);
  assert(!smooth.error, smooth.error || 'Smooth Three.js Gaussian kernel failed');
  assert(smooth.kernel === 'smooth 2.83 sigma normalized', 'Smooth kernel was not selected');
  assert(smooth.gaussianObjects >= 1, 'Smooth kernel did not create a GaussianSplat');
  assert(smooth.splatCount === 16, 'Smooth kernel fixture splat count changed');
  assert(pageErrors.length === 0, `Page errors after smooth kernel load: ${pageErrors.join('\n')}`);
  assert(consoleErrors.length === 0, `Console errors after smooth kernel load: ${consoleErrors.join('\n')}`);

  const comparisonUrl = `http://127.0.0.1:${address.port}/scenesync/experiments/3dgs-webxr-renderer-comparison.html?fixture=minimal&quality=balanced&kernel=upstream`;
  await page.goto(comparisonUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const comparison = globalThis.__gaussianXrRendererComparison;
    const playcanvas = document.querySelector('#playcanvas')?.contentWindow?.__playCanvasGaussianXrSmoke;
    const three = document.querySelector('#three')?.contentWindow?.__threeGaussianXrStereoSmoke;
    return comparison?.done && playcanvas?.done && playcanvas.rendered && three?.done && three.rendered;
  }, null, { timeout: 45000 });
  const comparison = await page.evaluate(() => ({
    parent: globalThis.__gaussianXrRendererComparison,
    playcanvas: document.querySelector('#playcanvas').contentWindow.__playCanvasGaussianXrSmoke,
    three: document.querySelector('#three').contentWindow.__threeGaussianXrStereoSmoke,
  }));
  assert(comparison.parent.qualityPreset === 'balanced', 'Comparison page quality selection was lost');
  assert(comparison.parent.framebufferScale === 0.85, 'Comparison page framebuffer scale changed');
  assert(comparison.parent.foveation === 0.3, 'Comparison page foveation changed');
  assert(comparison.playcanvas.xrQualityPreset === 'balanced', 'Comparison did not configure PlayCanvas equally');
  assert(comparison.three.xrQualityPreset === 'balanced', 'Comparison did not configure Three.js equally');
  assert(comparison.playcanvas.splatCount === 8, 'Comparison PlayCanvas fixture changed');
  assert(comparison.three.splatCount === 8, 'Comparison Three.js fixture changed');
  assert(comparison.three.kernel === 'upstream 2 sigma hard cutoff', 'Comparison Three.js kernel selection was lost');
  assert(pageErrors.length === 0, `Page errors after comparison load: ${pageErrors.join('\n')}`);
  assert(consoleErrors.length === 0, `Console errors after comparison load: ${consoleErrors.join('\n')}`);

  console.log(JSON.stringify({
    status: 'passed',
    url,
    ...result,
    localGlbReloaded: true,
    realGlbTiming,
    smoothKernel: { url: smoothUrl, kernel: smooth.kernel, rendered: smooth.rendered },
    comparison: {
      url: comparisonUrl,
      qualityPreset: comparison.parent.qualityPreset,
      playcanvasSplats: comparison.playcanvas.splatCount,
      threeSplats: comparison.three.splatCount,
    },
  }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
