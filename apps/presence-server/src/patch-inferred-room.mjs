import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, 'server.mjs');
const source = readFileSync(serverPath, 'utf8');

const previousInferRoomFromReq = `function inferRoomFromReq(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const first = forwarded ? forwarded.split(',')[0].trim() : null;
  const ip = first || req.socket.remoteAddress || 'global';
  if (ip.includes(':')) {
    return ip.replace('::ffff:', '').split(':')[0] || 'global-v6';
  }
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
  }
  return ip || 'global';
}`;

const canonicalInferRoomFromReq = `function inferRoomFromReq(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const first = forwarded ? forwarded.split(',')[0].trim() : null;
  const ip = first || req.socket.remoteAddress || 'global';
  if (ip.includes(':')) {
    return sanitizeRoom(ip.replace('::ffff:', '').split(':')[0]) || 'global-v6';
  }
  const parts = ip.split('.');
  if (parts.length === 4) {
    return sanitizeRoom(`${parts[0]}-${parts[1]}-${parts[2]}-x`) || 'global';
  }
  return sanitizeRoom(ip) || 'global';
}`;

const previousRoomSelection = `const roomOverride = sanitizeRoom(url.searchParams.get('room'));
    const roomId = roomOverride || inferRoomFromReq(req);`;

const canonicalRoomSelection = `const roomOverride = sanitizeRoom(url.searchParams.get('room'));
    const roomId = roomOverride || inferRoomFromReq(req) || 'global';`;

let next = source;
next = next.replace(previousInferRoomFromReq, canonicalInferRoomFromReq);
next = next.replace(previousRoomSelection, canonicalRoomSelection);

if (next === source) {
  console.log('[presence-server] inferred room canonicalization patch was already applied or source changed.');
} else {
  writeFileSync(serverPath, next, 'utf8');
  console.log('[presence-server] patched inferred room canonicalization.');
}
