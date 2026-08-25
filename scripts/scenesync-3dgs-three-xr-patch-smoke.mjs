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
  assert(result.rendered === true, 'Patched Three.js Gaussian frame was not rendered');
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

  console.log(JSON.stringify({ status: 'passed', url, ...result, localGlbReloaded: true }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
