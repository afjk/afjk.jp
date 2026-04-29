import { createHmac, randomUUID } from 'node:crypto';

const LINK_TOKEN_SECRET = process.env.LINK_TOKEN_SECRET || 'dev-secret-key-change-in-production';
const LINK_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days
const PAIRING_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PAIRING_CODE_LENGTH = 6;

// In-memory storage for pairing codes and revoked tokens
// In production, use Redis or persistent store
export const pairingCodes = new Map(); // code -> { roomId, userId, expiresAt }
export const revokedTokens = new Map(); // linkId -> { revokedAt, reason }

function generatePairingCode() {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += Math.floor(Math.random() * 10);
  }
  return code;
}

function base64urlEncode(data) {
  return Buffer.from(data).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(str) {
  const padded = str + '=='.substring(0, (4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function createLinkToken(linkId, userId, roomId) {
  const now = Date.now();
  const exp = now + LINK_TOKEN_TTL_MS;

  const payload = {
    linkId,
    userId,
    roomId,
    iat: now,
    exp
  };

  const payloadStr = JSON.stringify(payload);
  const payloadB64 = base64urlEncode(payloadStr);

  const hmac = createHmac('sha256', LINK_TOKEN_SECRET);
  hmac.update(payloadB64);
  const signatureB64 = base64urlEncode(hmac.digest());

  return {
    linkToken: `${payloadB64}.${signatureB64}`,
    linkId,
    roomId,
    expiresAt: exp
  };
}

export function verifyLinkToken(token) {
  try {
    const [payloadB64, signatureB64] = token.split('.');
    if (!payloadB64 || !signatureB64) {
      return { valid: false, error: 'invalid format' };
    }

    const hmac = createHmac('sha256', LINK_TOKEN_SECRET);
    hmac.update(payloadB64);
    const expectedSig = base64urlEncode(hmac.digest());

    if (signatureB64 !== expectedSig) {
      return { valid: false, error: 'invalid signature' };
    }

    const payloadStr = base64urlDecode(payloadB64).toString('utf8');
    const payload = JSON.parse(payloadStr);

    if (payload.exp < Date.now()) {
      return { valid: false, error: 'token expired' };
    }

    if (revokedTokens.has(payload.linkId)) {
      return { valid: false, error: 'token revoked' };
    }

    return { valid: true, payload };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

export function initiatePairingCode(roomId, userId) {
  const code = generatePairingCode();
  const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;

  pairingCodes.set(code, {
    roomId,
    userId,
    expiresAt,
    redeemed: false
  });

  return {
    code,
    expiresAt
  };
}

export function redeemPairingCode(code) {
  const entry = pairingCodes.get(code);

  if (!entry) {
    return { ok: false, error: 'not found' };
  }

  if (Date.now() > entry.expiresAt) {
    pairingCodes.delete(code);
    return { ok: false, error: 'expired' };
  }

  if (entry.redeemed) {
    return { ok: false, error: 'already redeemed' };
  }

  // Mark as redeemed (keep in map until expiry for idempotency)
  entry.redeemed = true;

  const linkId = `lnk-${randomUUID()}`;
  const tokenData = createLinkToken(linkId, entry.userId, entry.roomId);

  return { ok: true, ...tokenData };
}

export function revokeLinkToken(linkId) {
  revokedTokens.set(linkId, {
    revokedAt: Date.now(),
    reason: 'user-revoked'
  });
}

// Cleanup expired pairing codes periodically
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of pairingCodes) {
    if (now > entry.expiresAt) {
      pairingCodes.delete(code);
    }
  }
  // Cleanup revoked tokens older than their original TTL
  for (const [linkId, revoked] of revokedTokens) {
    if (now > revoked.revokedAt + LINK_TOKEN_TTL_MS) {
      revokedTokens.delete(linkId);
    }
  }
}, 60000); // Every minute
