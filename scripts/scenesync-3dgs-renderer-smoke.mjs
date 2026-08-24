import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlRoot = path.join(repoRoot, 'html');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(repoRoot, '.playwright-browsers');
const { chromium } = await import('playwright');

const requestWebGPU = process.argv.includes('--webgpu');
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
const search = new URLSearchParams({ fixture: 'ring' });
if (requestWebGPU) search.set('webgpu', '1');
const url = `http://127.0.0.1:${address.port}/scenesync/experiments/3dgs-three-native-smoke.html?${search}`;

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    args: requestWebGPU ? ['--enable-unsafe-webgpu'] : [],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__gaussianSplatSmoke?.done === true, null, {
    timeout: 30000,
  });
  await page.waitForFunction(() => globalThis.__gaussianSplatSmoke?.rendered === true, null, {
    timeout: 15000,
  });
  const result = await page.evaluate(() => globalThis.__gaussianSplatSmoke);

  assert(!result.error, result.error || 'Gaussian smoke failed');
  assert(result.renderer === 'WebGPURenderer', 'Smoke did not use WebGPURenderer');
  assert(result.gaussianObjects >= 1, 'GLTF loader did not create GaussianSplat');
  assert(result.splatCount === 16, 'ring fixture splat count changed');
  assert(result.normalMeshes === 1, 'normal mesh did not coexist with GaussianSplat');
  assert(result.rendered === true, 'GaussianSplat frame was not rendered');
  if (!requestWebGPU) assert(result.backend === 'webgl', 'default backend must be WebGL');
  if (requestWebGPU) assert(result.backend === 'webgpu', '?webgpu=1 did not select WebGPU');
  assert(pageErrors.length === 0, `Page errors: ${pageErrors.join('\n')}`);
  assert(consoleErrors.length === 0, `Console errors: ${consoleErrors.join('\n')}`);

  console.log(JSON.stringify({ status: 'passed', url, ...result }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
