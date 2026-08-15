import { createHash } from 'node:crypto';

export function createActorId({ ip = '', userAgent = '', salt = '', length = 24 }) {
  const hash = createHash('sha256')
    .update(`${ip}|${userAgent}|${salt}`)
    .digest('hex');
  return hash.slice(0, Math.max(8, Math.min(length, 64)));
}

export function getActorIdFromRequest(req, salt = '', { trustProxy = false } = {}) {
  const real = trustProxy ? req.headers['x-real-ip'] : '';
  const ip = real ? String(real).trim() : (req.socket?.remoteAddress || '');
  const userAgent = String(req.headers['user-agent'] || '');
  return createActorId({ ip, userAgent, salt });
}
