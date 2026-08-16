function parseIntEnv(value, fallback, min = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

function parseBoolEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function createSceneSyncConfig(env = process.env) {
  const config = {
    maxUploadBytes: parseIntEnv(env.SCENE_SYNC_MAX_UPLOAD_BYTES, 524_288_000, 1),
    maxJsonBytes: parseIntEnv(env.SCENE_SYNC_MAX_JSON_BYTES, 1_048_576, 1),
    maxRoomConnections: parseIntEnv(env.SCENE_SYNC_MAX_ROOM_CONNECTIONS, 20, 1),
    maxObjectsPerRoom: parseIntEnv(env.SCENE_SYNC_MAX_OBJECTS_PER_ROOM, 500, 1),
    logEnabled: parseBoolEnv(env.SCENE_SYNC_LOG_ENABLED, true),
    logDir: env.SCENE_SYNC_LOG_DIR || './logs',
    logMaxLineBytes: parseIntEnv(env.SCENE_SYNC_LOG_MAX_LINE_BYTES, 4096, 256),
    actorHashSalt: env.SCENE_SYNC_ACTOR_HASH_SALT || '',
    ipHashSalt: env.SCENE_SYNC_IP_HASH_SALT || '',
    connectionSummaryIntervalMs: parseIntEnv(env.SCENE_SYNC_CONNECTION_SUMMARY_INTERVAL_MS, 60000, 0),
    glbBackupEnabled: parseBoolEnv(env.SCENE_SYNC_GLB_BACKUP_ENABLED, true),
    glbBackupDriver: env.SCENE_SYNC_GLB_BACKUP_DRIVER || 'local',
    glbBackupDir: env.SCENE_SYNC_GLB_BACKUP_DIR || './scene-sync-glb-backup',
    glbBackupRetentionDays: parseIntEnv(env.SCENE_SYNC_GLB_BACKUP_RETENTION_DAYS, 7, 1),
    glbBackupMaxTotalBytes: parseIntEnv(env.SCENE_SYNC_GLB_BACKUP_MAX_TOTAL_BYTES, 1_073_741_824, 1),
    glbBackupMinFreeBytes: parseIntEnv(env.SCENE_SYNC_GLB_BACKUP_MIN_FREE_BYTES, 1_073_741_824, 0),
    glbBackupS3Endpoint: env.SCENE_SYNC_GLB_BACKUP_S3_ENDPOINT || '',
    glbBackupS3Region: env.SCENE_SYNC_GLB_BACKUP_S3_REGION || 'ap-northeast-1',
    glbBackupS3Bucket: env.SCENE_SYNC_GLB_BACKUP_S3_BUCKET || '',
    glbBackupS3Prefix: env.SCENE_SYNC_GLB_BACKUP_S3_PREFIX || 'scene-sync/backups/glb',
    glbBackupS3AccessKeyId: env.SCENE_SYNC_GLB_BACKUP_S3_ACCESS_KEY_ID || '',
    glbBackupS3SecretAccessKey: env.SCENE_SYNC_GLB_BACKUP_S3_SECRET_ACCESS_KEY || '',
    uploadsPerActorPerMinute: parseIntEnv(env.SCENE_SYNC_UPLOADS_PER_ACTOR_PER_MINUTE, 10, 1),
    serverPullsPerActorPerMinute: parseIntEnv(env.SCENE_SYNC_SERVER_PULLS_PER_ACTOR_PER_MINUTE, 3, 1),
    // Process-private runtime state; production compose explicitly uses /data.
    handoffTokenDir: env.SCENE_SYNC_HANDOFF_TOKEN_DIR || join(tmpdir(), `scene-sync-handoff-${process.pid}`),
    // 32 MiB decoded payloads can be ~44.8 MiB JSON after base64. This is a
    // separate streamed cap, never the general 1 MiB control-plane cap.
    handoffTokenMaxEncodedBytes: parseIntEnv(env.SCENE_SYNC_HANDOFF_TOKEN_MAX_ENCODED_BYTES, 56 * 1024 * 1024, 1),
    handoffTokenMaxStagedBytes: parseIntEnv(env.SCENE_SYNC_HANDOFF_TOKEN_MAX_STAGED_BYTES, 128 * 1024 * 1024, 1),
    handoffTokenMinFreeBytes: parseIntEnv(env.SCENE_SYNC_HANDOFF_TOKEN_MIN_FREE_BYTES, 256 * 1024 * 1024, 0),
    handoffTokenMaxEntries: parseIntEnv(env.SCENE_SYNC_HANDOFF_TOKEN_MAX_ENTRIES, 32, 1),
    handoffTokenMaxActiveUploads: parseIntEnv(env.SCENE_SYNC_HANDOFF_TOKEN_MAX_ACTIVE_UPLOADS, 4, 1),
    handoffTokenUploadsPerIpPerMinute: parseIntEnv(env.SCENE_SYNC_HANDOFF_TOKEN_UPLOADS_PER_IP_PER_MINUTE, 6, 1),
    handoffTokenUploadIdleTimeoutMs: parseIntEnv(env.SCENE_SYNC_HANDOFF_TOKEN_UPLOAD_IDLE_TIMEOUT_MS, 60_000, 1),
    handoffTokenUploadMaxDurationMs: Math.min(parseIntEnv(env.SCENE_SYNC_HANDOFF_TOKEN_UPLOAD_MAX_DURATION_MS, 10 * 60 * 1000, 1), 10 * 60 * 1000),
    handoffTokenClaimsPerIpPerMinute: parseIntEnv(env.SCENE_SYNC_HANDOFF_TOKEN_CLAIMS_PER_IP_PER_MINUTE, 30, 1),
    handoffTokenMaxActiveClaims: parseIntEnv(env.SCENE_SYNC_HANDOFF_TOKEN_MAX_ACTIVE_CLAIMS, 2, 1),
    serverPullMaxLiveBytes: parseIntEnv(env.SCENE_SYNC_SERVER_PULL_MAX_LIVE_BYTES, 524_288_000, 1),
    serverPullAllowedOrigins: (env.SCENE_SYNC_SERVER_PULL_ALLOWED_ORIGINS || 'https://afjk.jp,https://staging.afjk.jp')
      .split(',').map((value) => value.trim().replace(/\/$/u, '')).filter(Boolean),
    trustReverseProxy: parseBoolEnv(env.SCENE_SYNC_TRUST_REVERSE_PROXY, false),
  };

  if (env.NODE_ENV === 'production' && !config.actorHashSalt) {
    console.warn('[SceneSync] SCENE_SYNC_ACTOR_HASH_SALT is missing in production');
  }

  return config;
}
import { tmpdir } from 'node:os';
import { join } from 'node:path';
