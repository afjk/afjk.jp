import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

import { hasValidGlbMagic, validateUpload } from '../src/scenesync/upload-guards.mjs';
import { createPerActorRateLimiter } from '../src/scenesync/rate-limit.mjs';
import { validateSceneSyncPayload } from '../src/scenesync/message-schema.mjs';
import { createSceneSyncLogger } from '../src/scenesync/logger.mjs';
import { createGlbBackupManager, cleanupOldBackups } from '../src/scenesync/glb-backup.mjs';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'scenesync-guards-'));
const logDir = path.join(tmpRoot, 'logs');
const backupDir = path.join(tmpRoot, 'backups');

let server;
let baseUrl;
let wsBaseUrl;

async function startServerWithEnv() {
  process.env.SCENE_SYNC_MAX_UPLOAD_BYTES = '64';
  process.env.SCENE_SYNC_MAX_JSON_BYTES = '256';
  process.env.SCENE_SYNC_MAX_ROOM_CONNECTIONS = '2';
  process.env.SCENE_SYNC_MAX_OBJECTS_PER_ROOM = '2';
  process.env.SCENE_SYNC_UPLOADS_PER_ACTOR_PER_MINUTE = '2';
  process.env.SCENE_SYNC_LOG_DIR = logDir;
  process.env.SCENE_SYNC_GLB_BACKUP_DIR = backupDir;
  process.env.SCENE_SYNC_GLB_BACKUP_MAX_TOTAL_BYTES = '1048576';
  process.env.SCENE_SYNC_GLB_BACKUP_MIN_FREE_BYTES = '0';
  process.env.SCENE_SYNC_ACTOR_HASH_SALT = 'test-salt';
  process.env.GPT_SESSION_SECRET ||= 'test-gpt-session-secret';

  const moduleUrl = new URL(`../src/server.mjs?guards=${Date.now()}`, import.meta.url);
  const { createPresenceServer } = await import(moduleUrl.href);
  server = createPresenceServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  wsBaseUrl = `ws://127.0.0.1:${address.port}/ws`;
}

before(async () => {
  await startServerWithEnv();
});

after(async () => {
  if (server) {
    await server.stop();
  }
});

describe('Scene Sync guard helpers', () => {
  it('GLB magic check accepts valid glTF header', () => {
    assert.equal(hasValidGlbMagic(Buffer.from('glTFtest')), true);
  });

  it('GLB magic check rejects invalid header', () => {
    assert.equal(hasValidGlbMagic(Buffer.from('bad!test')), false);
  });

  it('upload size limit rejects oversized file', () => {
    const result = validateUpload({
      size: 65,
      mimeType: 'model/gltf-binary',
      filename: 'box.glb',
      buffer: Buffer.from('glTF'),
      maxUploadBytes: 64,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 413);
  });

  it('unsupported MIME/type is rejected', () => {
    const result = validateUpload({
      size: 10,
      mimeType: 'text/plain',
      filename: 'note.txt',
      buffer: Buffer.from('hello'),
      maxUploadBytes: 64,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 415);
  });

  it('per-actor upload rate limit rejects excessive uploads', () => {
    const limiter = createPerActorRateLimiter(2, 60_000);
    assert.equal(limiter.allow('actor-a', 1), true);
    assert.equal(limiter.allow('actor-a', 2), true);
    assert.equal(limiter.allow('actor-a', 3), false);
  });

  it('schema validation rejects NaN', () => {
    const result = validateSceneSyncPayload({ kind: 'scene-delta', objectId: 'o1', position: [NaN, 0, 0] });
    assert.equal(result.ok, false);
  });

  it('schema validation rejects Infinity', () => {
    const result = validateSceneSyncPayload({ kind: 'scene-delta', objectId: 'o1', scale: [1, Infinity, 1] });
    assert.equal(result.ok, false);
  });

  it('batch ops limit rejects too many ops', () => {
    const result = validateSceneSyncPayload({
      kind: 'scene-batch',
      ops: Array.from({ length: 101 }, (_, i) => ({ kind: 'scene-remove', objectId: `o-${i}` })),
    });
    assert.equal(result.ok, false);
  });

  it('accepts existing protocol control messages', () => {
    assert.equal(validateSceneSyncPayload({ kind: 'scene-avatar', position: [0, 1, 2] }).ok, true);
    assert.equal(validateSceneSyncPayload({ kind: 'scene-lock', objectId: 'obj-1' }).ok, true);
    assert.equal(validateSceneSyncPayload({ kind: 'scene-unlock', objectId: 'obj-1' }).ok, true);
    assert.equal(validateSceneSyncPayload({ kind: 'ai-link-established', linkId: 'l1' }).ok, true);
    assert.equal(validateSceneSyncPayload({ kind: 'ai-link-revoked', linkId: 'l1' }).ok, true);
  });

  it('rejects scene-batch with NaN in nested op', () => {
    const result = validateSceneSyncPayload({
      kind: 'scene-batch',
      ops: [{ kind: 'scene-delta', objectId: 'o1', position: [NaN, 0, 0] }],
    });
    assert.equal(result.ok, false);
  });

  it('rejects scene-batch with Infinity in nested op', () => {
    const result = validateSceneSyncPayload({
      kind: 'scene-batch',
      ops: [{ kind: 'scene-delta', objectId: 'o1', scale: [1, Infinity, 1] }],
    });
    assert.equal(result.ok, false);
  });

  it('rejects scene-batch with unsupported nested kind', () => {
    const result = validateSceneSyncPayload({
      kind: 'scene-batch',
      ops: [{ kind: 'scene-not-supported' }],
    });
    assert.equal(result.ok, false);
  });

  it('accepts valid scene-batch ops', () => {
    const result = validateSceneSyncPayload({
      kind: 'scene-batch',
      ops: [
        { kind: 'scene-add', objectId: 'o1', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        { kind: 'scene-delta', objectId: 'o1', position: [1, 0, 0] },
      ],
    });
    assert.equal(result.ok, true);
  });
});

describe('Scene Sync server guards', () => {
  it('rejects oversized upload body', async () => {
    const response = await fetch(`${baseUrl}/blob/large.glb`, {
      method: 'POST',
      headers: { 'Content-Type': 'model/gltf-binary', 'User-Agent': 'guard-size-test' },
      body: Buffer.concat([Buffer.from('glTF'), Buffer.alloc(80)]),
    });
    assert.equal(response.status, 413);
  });

  it('rejects unsupported upload type', async () => {
    const response = await fetch(`${baseUrl}/blob/file.txt`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'User-Agent': 'guard-type-test' },
      body: Buffer.from('hello'),
    });
    assert.equal(response.status, 415);
  });

  it('rejects application/octet-stream upload without extension', async () => {
    const response = await fetch(`${baseUrl}/blob/noext`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'User-Agent': 'guard-octet-noext-test' },
      body: Buffer.from('glTFpayload'),
    });
    assert.equal(response.status, 415);
  });

  it('accepts application/octet-stream GLB with valid magic', async () => {
    const response = await fetch(`${baseUrl}/blob/octet-valid.glb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'User-Agent': 'guard-octet-valid-test' },
      body: Buffer.from('glTFpayload'),
    });
    assert.equal(response.status, 201);
  });

  it('rejects application/octet-stream GLB with invalid magic', async () => {
    const response = await fetch(`${baseUrl}/blob/octet-invalid.glb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'User-Agent': 'guard-octet-invalid-test' },
      body: Buffer.from('BAD!payload'),
    });
    assert.equal(response.status, 400);
  });

  it('rejects invalid glb upload magic', async () => {
    const response = await fetch(`${baseUrl}/blob/bad.glb`, {
      method: 'POST',
      headers: { 'Content-Type': 'model/gltf-binary', 'User-Agent': 'guard-glb-bad-test' },
      body: Buffer.from('BAD!payload'),
    });
    assert.equal(response.status, 400);
  });

  it('accepts valid glb upload magic', async () => {
    const response = await fetch(`${baseUrl}/blob/good.glb`, {
      method: 'POST',
      headers: { 'Content-Type': 'model/gltf-binary', 'User-Agent': 'guard-glb-good-test' },
      body: Buffer.from('glTFpayload'),
    });
    assert.equal(response.status, 201);
  });

  it('rejects per-actor excessive uploads with 429', async () => {
    const headers = { 'Content-Type': 'image/png', 'User-Agent': 'guard-rate-test' };
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const first = await fetch(`${baseUrl}/blob/rate1.png`, { method: 'POST', headers, body });
    const second = await fetch(`${baseUrl}/blob/rate2.png`, { method: 'POST', headers, body });
    const third = await fetch(`${baseUrl}/blob/rate3.png`, { method: 'POST', headers, body });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(third.status, 429);
  });

  it('rejects oversized JSON body', async () => {
    const response = await fetch(`${baseUrl}/api/room/size-test/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'scene-add', objectId: 'x', pad: 'a'.repeat(500) }),
    });
    assert.equal(response.status, 413);
  });

  it('accepts existing avatar/lock/unlock protocol messages', async () => {
    const headers = { 'Content-Type': 'application/json' };
    const avatar = await fetch(`${baseUrl}/api/room/protocol-compat/broadcast`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'scene-avatar', position: [0, 1, 2], rotation: [0, 0, 0, 1] }),
    });
    const lock = await fetch(`${baseUrl}/api/room/protocol-compat/broadcast`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'scene-lock', objectId: 'obj-1' }),
    });
    const unlock = await fetch(`${baseUrl}/api/room/protocol-compat/broadcast`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'scene-unlock', objectId: 'obj-1' }),
    });

    assert.equal(avatar.status, 200);
    assert.equal(lock.status, 200);
    assert.equal(unlock.status, 200);
  });

  it('enforces object count limit for scene-add', async () => {
    const headers = { 'Content-Type': 'application/json' };
    const add1 = await fetch(`${baseUrl}/api/room/object-limit/broadcast`, { method: 'POST', headers, body: JSON.stringify({ kind: 'scene-add', objectId: 'o1' }) });
    const add2 = await fetch(`${baseUrl}/api/room/object-limit/broadcast`, { method: 'POST', headers, body: JSON.stringify({ kind: 'scene-add', objectId: 'o2' }) });
    const add3 = await fetch(`${baseUrl}/api/room/object-limit/broadcast`, { method: 'POST', headers, body: JSON.stringify({ kind: 'scene-add', objectId: 'o3' }) });
    assert.equal(add1.status, 200);
    assert.equal(add2.status, 200);
    assert.equal(add3.status, 429);
  });

  it('keeps object count unchanged when rejecting invalid scene-batch', async () => {
    const headers = { 'Content-Type': 'application/json' };
    const add1 = await fetch(`${baseUrl}/api/room/object-limit-atomic/broadcast`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'scene-add', objectId: 'o1' }),
    });
    assert.equal(add1.status, 200);

    const rejectedBatch = await fetch(`${baseUrl}/api/room/object-limit-atomic/broadcast`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: 'scene-batch',
        ops: [
          { kind: 'scene-add', objectId: 'o2' },
          { kind: 'scene-add', objectId: 'o3' },
        ],
      }),
    });
    assert.equal(rejectedBatch.status, 429);

    const add2 = await fetch(`${baseUrl}/api/room/object-limit-atomic/broadcast`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'scene-add', objectId: 'o2' }),
    });
    const add3 = await fetch(`${baseUrl}/api/room/object-limit-atomic/broadcast`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'scene-add', objectId: 'o3' }),
    });
    assert.equal(add2.status, 200);
    assert.equal(add3.status, 429);
  });

  it('enforces room connection limit', async () => {
    const ws1 = new WebSocket(`${wsBaseUrl}?room=room-limit`);
    const ws2 = new WebSocket(`${wsBaseUrl}?room=room-limit`);
    const ws3 = new WebSocket(`${wsBaseUrl}?room=room-limit`);
    const thirdEvents = [];
    ws3.on('message', (raw) => {
      thirdEvents.push(JSON.parse(raw.toString()));
    });

    await Promise.all([
      new Promise((resolve) => ws1.once('open', resolve)),
      new Promise((resolve) => ws2.once('open', resolve)),
      new Promise((resolve) => ws3.once('open', resolve)),
    ]);

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      ws3.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    assert.equal(thirdEvents.some(event => event.error === 'room_full') || ws3.readyState === WebSocket.CLOSED, true);

    ws1.terminate();
    ws2.terminate();
    ws3.terminate();
  });
});

describe('Scene Sync logger and backup', () => {
  it('logger writes valid NDJSON and respects max line size', () => {
    const localDir = path.join(tmpRoot, 'logger-test');
    const logger = createSceneSyncLogger({ enabled: true, logDir: localDir, maxLineBytes: 120 });
    logger.log('schema_invalid', {
      roomId: 'room-a',
      actorId: 'actor-a',
      reason: 'x'.repeat(1000),
      payload: { huge: 'y'.repeat(1000) },
    });

    const logPath = path.join(localDir, `scene-sync-${new Date().toISOString().slice(0, 10)}.ndjson`);
    const content = readFileSync(logPath, 'utf8').trim();
    const lines = content.split('\n');
    assert.ok(lines.length >= 1);

    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
      assert.ok(Buffer.byteLength(line, 'utf8') <= 120);
    }
  });

  it('GLB backup writes .glb and .json metadata', async () => {
    const localBackup = path.join(tmpRoot, 'backup-write');
    const manager = createGlbBackupManager({
      glbBackupEnabled: true,
      glbBackupDriver: 'local',
      glbBackupDir: localBackup,
      glbBackupMaxTotalBytes: 1_000_000,
      glbBackupMinFreeBytes: 0,
    }, createSceneSyncLogger({ enabled: false }));

    const result = await manager.saveAcceptedGlb({
      buffer: Buffer.from('glTFpayload'),
      roomId: 'room-a',
      actorId: 'actor-a',
      filename: 'box.glb',
      mimeType: 'model/gltf-binary',
      source: 'upload',
      blobId: 'blob-a',
    });

    assert.equal(result.saved, true);

    const dayDir = path.join(localBackup, new Date().toISOString().slice(0, 10));
    const files = readdirSync(dayDir);
    const glb = files.find(name => name.endsWith('.glb'));
    const json = files.find(name => name.endsWith('.json'));
    assert.ok(glb);
    assert.ok(json);

    const metadata = JSON.parse(readFileSync(path.join(dayDir, json), 'utf8'));
    assert.equal(metadata.roomId, 'room-a');
    assert.equal(metadata.actorId, 'actor-a');
    assert.equal(metadata.blobId, 'blob-a');
  });

  it('GLB backup skips when total backup size is over limit', async () => {
    const localBackup = path.join(tmpRoot, 'backup-skip');
    mkdirSync(localBackup, { recursive: true });
    writeFileSync(path.join(localBackup, 'existing.bin'), Buffer.alloc(32));

    const manager = createGlbBackupManager({
      glbBackupEnabled: true,
      glbBackupDriver: 'local',
      glbBackupDir: localBackup,
      glbBackupMaxTotalBytes: 8,
      glbBackupMinFreeBytes: 0,
    }, createSceneSyncLogger({ enabled: false }));

    const result = await manager.saveAcceptedGlb({
      buffer: Buffer.from('glTFpayload'),
      roomId: 'room-b',
      actorId: 'actor-b',
      filename: 'box.glb',
      mimeType: 'model/gltf-binary',
    });

    assert.equal(result.saved, false);
    assert.equal(result.reason, 'max_total_bytes_exceeded');
  });

  it('GLB backup skips when projected size would exceed max', async () => {
    const localBackup = path.join(tmpRoot, 'backup-projected-skip');
    mkdirSync(localBackup, { recursive: true });
    writeFileSync(path.join(localBackup, 'existing.bin'), Buffer.alloc(32));

    const manager = createGlbBackupManager({
      glbBackupEnabled: true,
      glbBackupDriver: 'local',
      glbBackupDir: localBackup,
      glbBackupMaxTotalBytes: 50,
      glbBackupMinFreeBytes: 0,
    }, createSceneSyncLogger({ enabled: false }), {
      estimatedMetadataBytes: 16,
    });

    const result = await manager.saveAcceptedGlb({
      buffer: Buffer.from('glTFpayload'),
      roomId: 'room-c',
      actorId: 'actor-c',
      filename: 'model.glb',
      mimeType: 'model/gltf-binary',
    });

    assert.equal(result.saved, false);
    assert.equal(result.reason, 'max_total_bytes_exceeded');
    const dayDir = path.join(localBackup, new Date().toISOString().slice(0, 10));
    assert.equal(existsSync(dayDir), false);
  });

  it('GLB backup skips when free disk state is unknown', async () => {
    const localBackup = path.join(tmpRoot, 'backup-free-unknown');
    const manager = createGlbBackupManager({
      glbBackupEnabled: true,
      glbBackupDriver: 'local',
      glbBackupDir: localBackup,
      glbBackupMaxTotalBytes: 1_000_000,
      glbBackupMinFreeBytes: 0,
    }, createSceneSyncLogger({ enabled: false }), {
      getFreeBytes: () => null,
    });

    const result = await manager.saveAcceptedGlb({
      buffer: Buffer.from('glTFpayload'),
      roomId: 'room-d',
      actorId: 'actor-d',
      filename: 'model.glb',
      mimeType: 'model/gltf-binary',
    });

    assert.equal(result.saved, false);
    assert.equal(result.reason, 'free_disk_unknown');
  });

  it('GLB backup s3 driver skips when s3 config is missing', async () => {
    const manager = createGlbBackupManager({
      glbBackupEnabled: true,
      glbBackupDriver: 's3',
      glbBackupS3Bucket: '',
      glbBackupS3AccessKeyId: '',
      glbBackupS3SecretAccessKey: '',
    }, createSceneSyncLogger({ enabled: false }));

    const result = await manager.saveAcceptedGlb({
      buffer: Buffer.from('glTFpayload'),
      roomId: 'room-s3-config',
      actorId: 'actor-s3-config',
      filename: 'box.glb',
      mimeType: 'model/gltf-binary',
    });

    assert.equal(result.saved, false);
    assert.equal(result.reason, 's3_config_missing');
    assert.equal(result.driver, 's3');
  });

  it('cleanup deletes old backups and keeps recent backups', () => {
    const localBackup = path.join(tmpRoot, 'backup-cleanup');
    mkdirSync(path.join(localBackup, '2020-01-01'), { recursive: true });
    mkdirSync(path.join(localBackup, '2099-01-01'), { recursive: true });

    const deleted = cleanupOldBackups({
      backupDir: localBackup,
      retentionDays: 7,
      now: Date.parse('2026-05-12T00:00:00.000Z'),
    });

    assert.deepEqual(deleted, ['2020-01-01']);
    assert.equal(existsSync(path.join(localBackup, '2020-01-01')), false);
    assert.equal(existsSync(path.join(localBackup, '2099-01-01')), true);
  });
});
