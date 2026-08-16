import { mkdirSync, readdirSync, renameSync, statfsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { validateHandoffTokenPayload } from './handoff-token-payload.mjs';

function failure(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

/** Disk-backed, process-local, one-use token state.  Payload files are never
 * exposed through HTTP; parsing on claim is bounded by maxEncodedBytes. */
export function createHandoffTokenStore({
  dir, ttlMs = 10 * 60 * 1000, maxEntries = 32, maxActiveUploads = 4,
  maxStagedBytes = 128 * 1024 * 1024, maxEncodedBytes = 45 * 1024 * 1024,
  minFreeBytes = 256 * 1024 * 1024, now = () => Date.now(),
} = {}) {
  const entries = new Map();
  let reservedBytes = 0;
  let liveBytes = 0;
  let requestReservations = 0;
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (/^(?:\.[a-f0-9]{64}|\.upload-[0-9a-f-]{36})\.part$|^[a-f0-9]{64}\.json$/u.test(name)) {
      try { unlinkSync(`${dir}/${name}`); } catch {}
    }
  }

  const tokenKey = (token) => createHash('sha256').update(token).digest('hex');
  const partPath = (token) => `${dir}/.${tokenKey(token)}.part`;
  const readyPath = (token) => `${dir}/${tokenKey(token)}.json`;
  const erase = (key, entry) => {
    if (!entry) return;
    entries.delete(key);
    if (entry.state === 'pending') reservedBytes = Math.max(0, reservedBytes - maxEncodedBytes);
    else liveBytes = Math.max(0, liveBytes - entry.size);
    try { unlinkSync(entry.file || `${dir}/.${key}.part`); } catch {}
  };

  return {
    reserveRequest() {
      this.sweep();
      if ([...entries.values()].filter((entry) => entry.state === 'pending').length + requestReservations >= maxActiveUploads) throw failure(429, 'handoff-token-capacity');
      if (liveBytes + reservedBytes + (requestReservations + 1) * maxEncodedBytes > maxStagedBytes) throw failure(429, 'handoff-token-quota');
      const fs = statfsSync(dir);
      if (Number(fs.bavail) * Number(fs.bsize) < minFreeBytes + maxEncodedBytes) throw failure(507, 'handoff-token-disk-full');
      requestReservations += 1;
    },
    releaseRequest() { requestReservations = Math.max(0, requestReservations - 1); },
    begin(token, { requestReserved = false } = {}) {
      this.sweep();
      const key = tokenKey(token);
      if (entries.has(key)) throw failure(409, 'handoff-token-conflict');
      if (entries.size >= maxEntries || [...entries.values()].filter((entry) => entry.state === 'pending').length >= maxActiveUploads) {
        throw failure(429, 'handoff-token-capacity');
      }
      if (requestReserved) {
        if (requestReservations < 1) throw failure(429, 'handoff-token-capacity');
        requestReservations -= 1;
      } else {
        if (liveBytes + reservedBytes + requestReservations * maxEncodedBytes + maxEncodedBytes > maxStagedBytes) throw failure(429, 'handoff-token-quota');
        const fs = statfsSync(dir);
        if (Number(fs.bavail) * Number(fs.bsize) < minFreeBytes + maxEncodedBytes) throw failure(507, 'handoff-token-disk-full');
      }
      const entry = { state: 'pending', expiresAt: now() + ttlMs, file: partPath(token), size: 0 };
      entries.set(key, entry); reservedBytes += maxEncodedBytes;
      return entry;
    },
    publish(token, byteSize, { sessionId, requestId } = {}) {
      const entry = entries.get(tokenKey(token));
      if (!entry || entry.state !== 'pending') throw failure(409, 'handoff-token-not-pending');
      if (byteSize > maxEncodedBytes) throw failure(413, 'handoff-token-body-too-large');
      renameSync(partPath(token), readyPath(token));
      reservedBytes = Math.max(0, reservedBytes - maxEncodedBytes);
      liveBytes += byteSize;
      entry.state = 'ready'; entry.file = readyPath(token); entry.size = byteSize;
      entry.expiresAt = now() + ttlMs;
      entry.sessionId = sessionId; entry.requestId = requestId;
      return entry.expiresAt;
    },
    cancel(token) { const key = tokenKey(token); erase(key, entries.get(key)); },
    async claim(token, { sessionId, requestId } = {}) {
      this.sweep();
      const key = tokenKey(token);
      const entry = entries.get(key);
      if (!entry || entry.state !== 'ready') return { state: 'pending' };
      if (entry.sessionId !== sessionId || entry.requestId !== requestId) return { state: 'binding-mismatch' };
      let raw;
      try { raw = await readFile(entry.file); } catch { entries.delete(key); liveBytes = Math.max(0, liveBytes - entry.size); return { state: 'invalid' }; }
      const consumeInvalid = () => {
        if (entries.get(key) === entry && entry.state === 'ready') {
          entries.delete(key); liveBytes = Math.max(0, liveBytes - entry.size); try { unlinkSync(entry.file); } catch {}
        }
        return { state: 'invalid' };
      };
      if (raw.length > maxEncodedBytes) return consumeInvalid();
      try {
        const parsed = JSON.parse(raw.toString('utf8'));
        const result = validateHandoffTokenPayload(parsed.payload);
        if (!result.valid || parsed.sessionId !== sessionId || parsed.requestId !== requestId) return consumeInvalid();
        // Compare-and-delete occurs without an await, so two finished reads
        // cannot both return the payload.
        if (entries.get(key) !== entry || entry.state !== 'ready' || entry.expiresAt <= now()) return { state: 'pending' };
        entries.delete(key); liveBytes = Math.max(0, liveBytes - entry.size);
        void unlink(entry.file).catch(() => {});
        return { state: 'ready', payload: result.payload };
      } catch { return consumeInvalid(); }
    },
    sweep() { for (const [key, entry] of entries) if (entry.expiresAt <= now()) erase(key, entry); },
    paths: { partPath, readyPath },
    stats: () => ({ entries: entries.size, reservedBytes, liveBytes, requestReservations }),
  };
}
