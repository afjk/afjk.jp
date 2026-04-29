import crypto from 'node:crypto';
import { verifyLinkToken } from './link-token.mjs';

const GPT_SESSION_VERSION = 'v1';
const GPT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey() {
  const secret = process.env.GPT_SESSION_SECRET;
  if (!secret) {
    console.warn('[gpt-session] GPT_SESSION_SECRET is not set; using insecure fallback');
    return crypto.createHash('sha256').update('insecure-fallback-key').digest();
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function b64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function encodeSession(linkToken, payload) {
  const now = Date.now();
  const sourceExp = Number(payload?.exp ?? payload?.expiresAt ?? 0);
  const sessionExp = Math.min(sourceExp, now + GPT_SESSION_TTL_MS);

  const body = JSON.stringify({
    t: linkToken,
    e: sessionExp,
  });

  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, ciphertext, tag]);

  return {
    sessionId: `${GPT_SESSION_VERSION}.${b64urlEncode(combined)}`,
    expiresAt: sessionExp,
    roomId: payload?.roomId || '',
  };
}

export function decodeSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.startsWith(`${GPT_SESSION_VERSION}.`)) {
    return { ok: false, error: 'invalid session format', status: 401 };
  }

  try {
    const combined = b64urlDecode(sessionId.slice(GPT_SESSION_VERSION.length + 1));
    if (combined.length < IV_LEN + TAG_LEN + 1) {
      return { ok: false, error: 'session too short', status: 401 };
    }

    const iv = combined.subarray(0, IV_LEN);
    const tag = combined.subarray(combined.length - TAG_LEN);
    const ciphertext = combined.subarray(IV_LEN, combined.length - TAG_LEN);

    const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const body = JSON.parse(plaintext);

    if (typeof body.e !== 'number' || body.e <= Date.now()) {
      return { ok: false, error: 'session expired', status: 401 };
    }

    const verified = verifyLinkToken(body.t);
    if (!verified.valid) {
      return { ok: false, error: verified.error || 'invalid linkToken', status: 401 };
    }

    return { ok: true, linkToken: body.t, payload: verified.payload };
  } catch {
    return { ok: false, error: 'session decode failed', status: 401 };
  }
}
