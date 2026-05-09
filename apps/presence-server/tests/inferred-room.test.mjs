import test from 'node:test';
import assert from 'node:assert/strict';

function sanitizeRoom(raw) {
  if (!raw) return null;
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9\-]/g, '').slice(0, 32);
  return cleaned || null;
}

function inferRoomFromReq(req) {
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
}

test('inferred IPv4 room is canonical and safe for AI link paths', () => {
  const roomId = inferRoomFromReq({
    headers: { 'x-forwarded-for': '133.201.97.123' },
    socket: {}
  });

  assert.equal(roomId, '133-201-97-x');
  assert.equal(sanitizeRoom(roomId), roomId);
});

test('inferred IPv4 room uses the first forwarded address', () => {
  const roomId = inferRoomFromReq({
    headers: { 'x-forwarded-for': '133.201.97.123, 10.0.0.1' },
    socket: {}
  });

  assert.equal(roomId, '133-201-97-x');
});

test('inferred IPv6 room is sanitized', () => {
  const roomId = inferRoomFromReq({
    headers: { 'x-forwarded-for': '2001:db8::1' },
    socket: {}
  });

  assert.equal(roomId, '2001');
  assert.equal(sanitizeRoom(roomId), roomId);
});
