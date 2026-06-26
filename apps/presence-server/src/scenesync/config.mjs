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
  };

  if (env.NODE_ENV === 'production' && !config.actorHashSalt) {
    console.warn('[SceneSync] SCENE_SYNC_ACTOR_HASH_SALT is missing in production');
  }

  return config;
}
