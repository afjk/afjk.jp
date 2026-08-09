import http from 'node:http';
import zlib from 'node:zlib';

const host = process.env.SCENESYNC_REMOTE_ASSET_TEST_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.SCENESYNC_REMOTE_ASSET_TEST_PORT || '18788', 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('SCENESYNC_REMOTE_ASSET_TEST_PORT must be an integer from 1 to 65535');
}

const counts = new Map();
let activeSlowRequests = 0;
let maxActiveSlowRequests = 0;
const validGlb = createMinimalGlb();
const invalidGlb = Buffer.alloc(12);
invalidGlb.write('nope', 0, 'ascii');
invalidGlb.writeUInt32LE(2, 4);
invalidGlb.writeUInt32LE(invalidGlb.length, 8);
const validPng = createPng(2, 1, Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]));
const oversizedPngHeader = createPngHeader(8193, 1);
const jpegDimensions = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01,
  0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9,
]);
const webpDimensions = createWebpExtendedHeader(1, 1);

function createMinimalGlb() {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{}] }), 'utf8');
  const paddedJsonLength = Math.ceil(json.length / 4) * 4;
  const output = Buffer.alloc(12 + 8 + paddedJsonLength, 0x20);
  output.write('glTF', 0, 'ascii');
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(paddedJsonLength, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  json.copy(output, 20);
  return output;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function createPngHeader(width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([signature, pngChunk('IHDR', ihdr)]);
}

function createPng(width, height, rgba) {
  const header = createPngHeader(width, height);
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let row = 0; row < height; row += 1) {
    rgba.copy(scanlines, row * (1 + width * 4) + 1, row * width * 4, (row + 1) * width * 4);
  }
  return Buffer.concat([
    header,
    pngChunk('IDAT', zlib.deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createWebpExtendedHeader(width, height) {
  const output = Buffer.alloc(30);
  output.write('RIFF', 0, 'ascii');
  output.writeUInt32LE(22, 4);
  output.write('WEBP', 8, 'ascii');
  output.write('VP8X', 12, 'ascii');
  output.writeUInt32LE(10, 16);
  output.writeUIntLE(width - 1, 24, 3);
  output.writeUIntLE(height - 1, 27, 3);
  return output;
}

function increment(pathname) {
  const next = (counts.get(pathname) || 0) + 1;
  counts.set(pathname, next);
  return next;
}

function send(res, status, body = Buffer.alloc(0), headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': body.length,
    ...headers,
  });
  res.end(body);
}

function sendGlb(res) {
  send(res, 200, validGlb, { 'content-type': 'model/gltf-binary' });
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || '/', `http://${host}`).pathname;

  if (pathname === '/reset') {
    counts.clear();
    activeSlowRequests = 0;
    maxActiveSlowRequests = 0;
    send(res, 204);
    return;
  }
  if (pathname === '/counts') {
    const snapshot = Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
    send(res, 200, Buffer.from(JSON.stringify(snapshot)), { 'content-type': 'application/json' });
    return;
  }
  if (pathname === '/stats') {
    const snapshot = Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
    send(res, 200, Buffer.from(JSON.stringify({
      counts: snapshot,
      activeSlowRequests,
      maxActiveSlowRequests,
    })), { 'content-type': 'application/json' });
    return;
  }

  const attempt = increment(pathname);
  switch (pathname) {
    case '/glb/valid':
    case '/glb/hash-mismatch':
    case '/glb/replacement':
      sendGlb(res);
      return;
    case '/glb/invalid':
      send(res, 200, invalidGlb, { 'content-type': 'model/gltf-binary' });
      return;
    case '/text':
      send(res, 200, Buffer.from('Scene Sync UTF-8 fixture: 月', 'utf8'), {
        'content-type': 'text/plain; charset=utf-8',
      });
      return;
    case '/text/invalid-utf8':
      send(res, 200, Buffer.from([0xc3, 0x28]), { 'content-type': 'text/plain' });
      return;
    case '/text/oversize':
      send(res, 200, Buffer.alloc(1024 * 1024 + 1, 0x61), { 'content-type': 'text/plain' });
      return;
    case '/image/png':
      send(res, 200, validPng, { 'content-type': 'image/png' });
      return;
    case '/image/jpeg-header':
      send(res, 200, jpegDimensions, { 'content-type': 'image/jpeg' });
      return;
    case '/image/webp-header':
      send(res, 200, webpDimensions, { 'content-type': 'image/webp' });
      return;
    case '/image/oversize-dimensions':
      send(res, 200, oversizedPngHeader, { 'content-type': 'image/png' });
      return;
    case '/retry/first-503':
      if (attempt === 1) {
        send(res, 503, Buffer.from('temporary'));
      } else {
        sendGlb(res);
      }
      return;
    case '/retry/always-503':
    case '/retry/backoff-cancel':
      send(res, 503, Buffer.from('temporary'));
      return;
    case '/retry/408':
    case '/retry/425':
    case '/retry/429':
    case '/retry/500': {
      const status = Number.parseInt(pathname.slice('/retry/'.length), 10);
      if (attempt === 1) {
        send(res, status, Buffer.from('temporary'));
      } else {
        sendGlb(res);
      }
      return;
    }
    case '/retry/empty':
      send(res, 200);
      return;
    case '/status/404':
      send(res, 404, Buffer.from('missing'));
      return;
    case '/redirect':
      send(res, 302, Buffer.alloc(0), { location: '/glb/valid' });
      return;
    case '/slow/update':
    case '/slow/cancel':
    case '/slow/concurrency/a':
    case '/slow/concurrency/b':
    case '/slow/concurrency/c':
      activeSlowRequests += 1;
      maxActiveSlowRequests = Math.max(maxActiveSlowRequests, activeSlowRequests);
      setTimeout(() => {
        activeSlowRequests -= 1;
        sendGlb(res);
      }, 250);
      return;
    default:
      send(res, 404, Buffer.from('missing'));
  }
});

server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.listen(port, host, () => {
  process.stdout.write(`[remote-asset-fixture] listening on ${host}:${port}\n`);
});

function close() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', close);
process.on('SIGTERM', close);
