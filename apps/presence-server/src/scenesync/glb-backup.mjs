import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { isSceneSyncDeveloperMode, isWasabiBackupEnabled, shouldBackupGlb } from './config.mjs';

function todayDateString(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function createS3Client(config) {
  if (!config.glbBackupS3Bucket) return null;
  if (!config.glbBackupS3AccessKeyId || !config.glbBackupS3SecretAccessKey) return null;

  return new S3Client({
    region: config.glbBackupS3Region,
    endpoint: config.glbBackupS3Endpoint || undefined,
    credentials: {
      accessKeyId: config.glbBackupS3AccessKeyId,
      secretAccessKey: config.glbBackupS3SecretAccessKey,
    },
    forcePathStyle: true,
  });
}

function joinS3Key(...parts) {
  return parts
    .filter(Boolean)
    .map(part => String(part).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

function calculateDirectorySizeBytes(directory) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += calculateDirectorySizeBytes(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      total += statSync(fullPath).size;
    } catch {}
  }

  return total;
}

function getFreeBytes(directory) {
  try {
    const stats = statfsSync(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

async function saveToS3({ client, config, buffer, metadata, backupId, dateString }) {
  const baseKey = joinS3Key(config.glbBackupS3Prefix, dateString);
  const glbKey = joinS3Key(baseKey, `${backupId}.glb`);
  const metaKey = joinS3Key(baseKey, `${backupId}.json`);

  await client.send(new PutObjectCommand({
    Bucket: config.glbBackupS3Bucket,
    Key: glbKey,
    Body: buffer,
    ContentType: metadata.mimeType || 'model/gltf-binary',
    Metadata: {
      backupId,
      roomId: metadata.roomId || '',
      actorId: metadata.actorId || '',
      blobId: metadata.blobId || '',
      sha256: metadata.sha256 || '',
      source: metadata.source || '',
    },
  }));

  await client.send(new PutObjectCommand({
    Bucket: config.glbBackupS3Bucket,
    Key: metaKey,
    Body: JSON.stringify(metadata, null, 2),
    ContentType: 'application/json',
  }));

  return { glbKey, metaKey };
}

export function cleanupOldBackups({ backupDir, retentionDays = 7, now = Date.now(), log = () => {} }) {
  let entries;
  try {
    entries = readdirSync(backupDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const threshold = now - retentionDays * 24 * 60 * 60 * 1000;
  const deleted = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;

    const fullPath = path.resolve(backupDir, entry.name);
    const relative = path.relative(path.resolve(backupDir), fullPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;

    const timestamp = Date.parse(`${entry.name}T00:00:00.000Z`);
    if (!Number.isFinite(timestamp) || timestamp >= threshold) continue;

    rmSync(fullPath, { recursive: true, force: true });
    deleted.push(entry.name);
    log(`deleted backup directory: ${fullPath}`);
  }

  return deleted;
}

export function createGlbBackupManager(config, logger, internals = {}) {
  const getFreeBytesImpl = internals.getFreeBytes || getFreeBytes;
  const calculateDirectorySizeBytesImpl = internals.calculateDirectorySizeBytes || calculateDirectorySizeBytes;
  const estimatedMetadataBytes = Number.isFinite(internals.estimatedMetadataBytes)
    ? internals.estimatedMetadataBytes
    : 4096;

  return {
    async saveAcceptedGlb({ buffer, roomId, actorId, filename = '', mimeType = '', source = 'upload', blobId = null }) {
      // Check if backup should be skipped due to developer mode
      if (isSceneSyncDeveloperMode(config)) {
        logger?.log('glb_backup_skipped', { roomId, actorId, reason: 'developer_mode', size: buffer.length });
        return { saved: false, reason: 'developer_mode' };
      }

      // Check if backup is disabled via config
      if (!isWasabiBackupEnabled(config)) {
        logger?.log('glb_backup_skipped', { roomId, actorId, reason: 'backup_disabled', size: buffer.length });
        return { saved: false, reason: 'backup_disabled' };
      }

      if (!config.glbBackupEnabled) {
        logger?.log('glb_backup_skipped', { roomId, actorId, reason: 'disabled', size: buffer.length });
        return { saved: false, reason: 'disabled' };
      }

      try {
        const driver = config.glbBackupDriver || 'local';

        if (driver === 's3') {
          const s3Client = createS3Client(config);
          if (!s3Client) {
            logger?.log('glb_backup_skipped', {
              roomId,
              actorId,
              reason: 's3_config_missing',
              driver: 's3',
            });
            return { saved: false, reason: 's3_config_missing', driver: 's3' };
          }

          const backupId = `${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
          const dateString = todayDateString();
          const sha256 = createHash('sha256').update(buffer).digest('hex');
          const metadata = {
            backupId,
            timestamp: new Date().toISOString(),
            roomId,
            actorId,
            filename,
            mimeType,
            sizeBytes: buffer.length,
            source,
            blobId,
            sha256,
          };

          await saveToS3({ client: s3Client, config, buffer, metadata, backupId, dateString });

          logger?.log('glb_backup_saved', {
            roomId,
            actorId,
            backupId,
            fileSize: buffer.length,
            mimeType,
            driver: 's3',
          });
          return { saved: true, backupId, driver: 's3' };
        }

        // Local driver (default)
        mkdirSync(config.glbBackupDir, { recursive: true });

        const totalSize = calculateDirectorySizeBytesImpl(config.glbBackupDir);
        const projectedSize = totalSize + buffer.length + estimatedMetadataBytes;
        if (projectedSize > config.glbBackupMaxTotalBytes) {
          logger?.log('glb_backup_skipped', { roomId, actorId, reason: 'max_total_bytes_exceeded', totalSize });
          return { saved: false, reason: 'max_total_bytes_exceeded' };
        }

        const freeBytes = getFreeBytesImpl(config.glbBackupDir);
        if (freeBytes === null) {
          logger?.log('glb_backup_skipped', { roomId, actorId, reason: 'free_disk_unknown' });
          return { saved: false, reason: 'free_disk_unknown' };
        }
        if (freeBytes < config.glbBackupMinFreeBytes) {
          logger?.log('glb_backup_skipped', { roomId, actorId, reason: 'insufficient_disk_free', freeBytes });
          return { saved: false, reason: 'insufficient_disk_free' };
        }

        const dateDir = path.join(config.glbBackupDir, todayDateString());
        mkdirSync(dateDir, { recursive: true });

        const backupId = `${Date.now()}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
        const glbPath = path.join(dateDir, `${backupId}.glb`);
        const metaPath = path.join(dateDir, `${backupId}.json`);
        const sha256 = createHash('sha256').update(buffer).digest('hex');
        const metadata = {
          backupId,
          timestamp: new Date().toISOString(),
          roomId,
          actorId,
          filename,
          mimeType,
          sizeBytes: buffer.length,
          source,
          blobId,
          sha256,
        };

        writeFileSync(glbPath, buffer);
        writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf8');

        logger?.log('glb_backup_saved', { roomId, actorId, backupId, fileSize: buffer.length, mimeType });
        return { saved: true, backupId };
      } catch (error) {
        logger?.log('glb_backup_failed', { roomId, actorId, reason: error?.message || String(error), error: error?.stack || '' });
        return { saved: false, reason: 'error' };
      }
    },
  };
}

export function readBackupMetadata(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}
