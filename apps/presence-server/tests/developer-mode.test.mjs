import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createSceneSyncConfig, isSceneSyncDeveloperMode, isWasabiBackupEnabled, shouldBackupGlb } from '../src/scenesync/config.mjs';

test('Developer Mode Configuration', async (t) => {
  await t.test('should recognize developer mode enabled', () => {
    const config = createSceneSyncConfig({
      SCENE_SYNC_DEVELOPER_MODE: 'true',
      SCENE_SYNC_WASABI_BACKUP_ENABLED: 'true',
    });

    assert.equal(isSceneSyncDeveloperMode(config), true);
    assert.equal(isWasabiBackupEnabled(config), true);
  });

  await t.test('should recognize wasabi backup disabled', () => {
    const config = createSceneSyncConfig({
      SCENE_SYNC_DEVELOPER_MODE: 'false',
      SCENE_SYNC_WASABI_BACKUP_ENABLED: 'false',
    });

    assert.equal(isSceneSyncDeveloperMode(config), false);
    assert.equal(isWasabiBackupEnabled(config), false);
  });

  await t.test('should not backup when developer mode is enabled', () => {
    const config = createSceneSyncConfig({
      SCENE_SYNC_DEVELOPER_MODE: 'true',
      SCENE_SYNC_WASABI_BACKUP_ENABLED: 'true',
    });

    assert.equal(shouldBackupGlb(config), false);
  });

  await t.test('should backup when both developer mode and backup are properly configured', () => {
    const config = createSceneSyncConfig({
      SCENE_SYNC_DEVELOPER_MODE: 'false',
      SCENE_SYNC_WASABI_BACKUP_ENABLED: 'true',
    });

    assert.equal(shouldBackupGlb(config), true);
  });

  await t.test('should not backup when backup is disabled regardless of developer mode', () => {
    const config = createSceneSyncConfig({
      SCENE_SYNC_DEVELOPER_MODE: 'false',
      SCENE_SYNC_WASABI_BACKUP_ENABLED: 'false',
    });

    assert.equal(shouldBackupGlb(config), false);
  });

  await t.test('should use default values when env vars are not set', () => {
    const config = createSceneSyncConfig({});

    assert.equal(isSceneSyncDeveloperMode(config), false); // default false
    assert.equal(isWasabiBackupEnabled(config), true); // default true
    assert.equal(shouldBackupGlb(config), true); // should backup by default
  });

  await t.test('should handle various truthy values for developer mode', () => {
    for (const value of ['1', 'true', 'yes', 'on', 'TRUE', 'YES', 'ON']) {
      const config = createSceneSyncConfig({
        SCENE_SYNC_DEVELOPER_MODE: value,
      });
      assert.equal(isSceneSyncDeveloperMode(config), true, `Failed for value: ${value}`);
    }
  });

  await t.test('should handle various falsy values for developer mode', () => {
    for (const value of ['0', 'false', 'no', 'off', 'FALSE', 'NO', 'OFF', '', null, undefined]) {
      const config = createSceneSyncConfig({
        SCENE_SYNC_DEVELOPER_MODE: value,
      });
      assert.equal(isSceneSyncDeveloperMode(config), false, `Failed for value: ${value}`);
    }
  });
});
