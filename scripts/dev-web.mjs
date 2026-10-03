// Local Web + Presence runner; no Docker, credentials, or production services.
import { createServer, request as httpRequest } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const htmlRoot = await realpath(path.join(repoRoot, 'html'));
const dataRoot = path.resolve(process.env.AFJK_DEV_DATA_DIR || path.join(repoRoot, 'logs', 'web-dev'));
const host = '127.0.0.1';
const webPort = Number(process.env.WEB_PORT || 8888);
const presencePort = Number(process.env.PRESENCE_PORT || 8787);
for (const port of [webPort, presencePort]) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('WEB_PORT and PRESENCE_PORT must be integers from 1 to 65535');
  }
}
if (process.env.NODE_ENV === 'production') {
  throw new Error('dev:web is for local development only');
}
await mkdir(dataRoot, { recursive: true });
// Use the already-installed, lockfile-resolved packages for local development.
// Shared chunks preserve class identity between core, extensions and functions.
const dependencyRoot = path.join(dataRoot, 'browser-deps');
const dependencyNames = ['core', 'extensions', 'functions'];
await build({
  entryPoints: Object.fromEntries(dependencyNames.map(name => [
    name, fileURLToPath(import.meta.resolve(`@gltf-transform/${name}`)),
  ])),
  bundle: true, splitting: true, format: 'esm', platform: 'browser',
  outdir: dependencyRoot, logLevel: 'warning',
});
// These settings apply only to this process. Do not read or change .env/auth.
Object.assign(process.env, {
  STATS_FILE: path.join(dataRoot, 'stats.json'),
  STATS_ARCHIVE_DIR: path.join(dataRoot, 'archive'),
  BLOB_DIR: path.join(dataRoot, 'blobs'),
  SCENE_SYNC_LOG_DIR: path.join(dataRoot, 'presence'),
  SCENE_SYNC_GLB_BACKUP_DRIVER: 'local',
  SCENE_SYNC_GLB_BACKUP_DIR: path.join(dataRoot, 'backups'),
  SCENE_SYNC_HANDOFF_TOKEN_DIR: path.join(dataRoot, 'handoff'),
});
const { createPresenceServer } = await import('../apps/presence-server/src/server.mjs');
const presence = createPresenceServer();
const mime = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain',
}));
const insideRoot = (root, file) => file.startsWith(`${root}${path.sep}`) || file === root;
const web = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Match the production /presence HTTP route for blob uploads/downloads.
  // The WebSocket URL remains explicit in the development URL printed below.
  if (req.url === '/presence' || req.url.startsWith('/presence/')) {
    const upstream = httpRequest({
      hostname: host, port: presencePort,
      path: req.url.slice('/presence'.length) || '/', method: req.method,
      headers: { ...req.headers, host: `${host}:${presencePort}` },
    }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    const url = new URL(req.url, `http://${host}`);
    const localDependency = url.pathname.startsWith('/__dev__/gltf/');
    const root = localDependency ? dependencyRoot : htmlRoot;
    const requestPath = localDependency ? url.pathname.slice('/__dev__/gltf'.length) : url.pathname;
    let file = path.resolve(root, `.${decodeURIComponent(requestPath)}`);
    if (!insideRoot(root, file)) { res.writeHead(403).end(); return; }
    file = await realpath(file);
    if (!insideRoot(root, file)) { res.writeHead(403).end(); return; }
    let info = await stat(file);
    if (info.isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        res.writeHead(301, { Location: `${url.pathname}/${url.search}` }).end();
        return;
      }
      file = await realpath(path.join(file, 'index.html'));
      if (!insideRoot(root, file)) { res.writeHead(403).end(); return; }
      info = await stat(file);
    }
    if (!info.isFile()) { res.writeHead(404).end(); return; }
    if (file === path.join(htmlRoot, 'scenesync', 'index.html')) {
      let html = await readFile(file, 'utf8');
      for (const name of dependencyNames) {
        html = html.replaceAll(
          `https://esm.sh/@gltf-transform/${name}@4.3.0`,
          `/__dev__/gltf/${name}.js`,
        );
      }
      res.writeHead(200, { 'Content-Type': mime.get('.html'), 'Content-Length': Buffer.byteLength(html) });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }
    res.writeHead(200, {
      'Content-Type': mime.get(path.extname(file).toLowerCase()) || 'application/octet-stream',
      'Content-Length': info.size,
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (error) {
    res.writeHead(error instanceof URIError ? 400 : 404).end();
  }
});

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  web.closeAllConnections();
  await Promise.all([
    new Promise(resolve => web.close(resolve)),
    presence.stop(),
  ]);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  await listen(presence, presencePort);
  await listen(web, webPort);
  const endpoint = encodeURIComponent(`ws://${host}:${presencePort}`);
  console.log(`Web: http://${host}:${webPort}/`);
  console.log(`Scene Sync: http://${host}:${webPort}/scenesync/?room=local-dev&presence=${endpoint}&dev=1`);
  console.log(`Local data: ${dataRoot}`);
  console.log('Loopback only. Reload the browser after editing html/. Ctrl+C to stop.');
} catch (error) {
  console.error(`dev:web failed: ${error.message}`);
  process.exitCode = 1;
  await stop();
}
