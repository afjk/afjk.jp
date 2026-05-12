import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

function toDateString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function byteLength(text) {
  return Buffer.byteLength(String(text), 'utf8');
}

function sanitizeValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (typeof value === 'string') {
    return value.length > 256 ? `${value.slice(0, 256)}…` : value;
  }
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.length > 20 ? { summary: 'array', length: value.length } : value.map(sanitizeValue);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'ip' || key === 'remoteAddress' || key === 'rawPayload' || key === 'payload') continue;
      out[key] = sanitizeValue(nested);
    }
    return out;
  }
  return String(value);
}

function compactEntry(entry) {
  const compact = {
    event: entry.event,
    timestamp: entry.timestamp,
    roomId: entry.roomId,
    actorId: entry.actorId,
    kind: entry.kind,
    payloadSize: entry.payloadSize,
    fileSize: entry.fileSize,
    mimeType: entry.mimeType,
    reason: entry.reason,
  };

  if (entry.error && typeof entry.error === 'string') {
    compact.stackHash = createHash('sha256').update(entry.error).digest('hex').slice(0, 16);
  }

  return compact;
}

export function createSceneSyncLogger({ enabled = true, logDir = './logs', maxLineBytes = 4096 } = {}) {
  if (!enabled) {
    return { log() {} };
  }

  return {
    log(event, fields = {}) {
      try {
        mkdirSync(logDir, { recursive: true });
        const entry = sanitizeValue({
          event,
          timestamp: new Date().toISOString(),
          ...fields,
        });
        let line = JSON.stringify(entry);
        if (byteLength(line) > maxLineBytes) {
          line = JSON.stringify(compactEntry(entry));
        }
        if (byteLength(line) > maxLineBytes) {
          line = JSON.stringify({
            event,
            timestamp: entry.timestamp,
            reason: 'log_entry_truncated',
          });
        }

        const filePath = path.resolve(logDir, `scene-sync-${toDateString()}.ndjson`);
        appendFileSync(filePath, `${line}\n`, 'utf8');
      } catch (error) {
        console.warn('[SceneSync][logger] write failed:', error?.message || String(error));
      }
    },
  };
}
