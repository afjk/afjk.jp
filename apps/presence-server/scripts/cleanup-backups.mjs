import { createSceneSyncConfig } from '../src/scenesync/config.mjs';
import { cleanupOldBackups } from '../src/scenesync/glb-backup.mjs';

const config = createSceneSyncConfig(process.env);
const deleted = cleanupOldBackups({
  backupDir: config.glbBackupDir,
  retentionDays: config.glbBackupRetentionDays,
  log: message => console.log(`[SceneSync][cleanup] ${message}`),
});

if (!deleted.length) {
  console.log('[SceneSync][cleanup] nothing to delete');
} else {
  console.log(`[SceneSync][cleanup] deleted ${deleted.length} backup directories`);
}
