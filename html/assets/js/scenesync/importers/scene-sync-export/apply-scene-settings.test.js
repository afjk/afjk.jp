// Tests for apply-scene-settings.js
// Run: node --test html/assets/js/scenesync/importers/scene-sync-export/apply-scene-settings.test.js

import { test } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { applySceneDocumentSettings } from './apply-scene-settings.js';

test('applies envId from skybox and broadcasts scene-env', () => {
  const calls = { loadEnvironment: [], broadcast: [] };
  const environmentManager = {
    loadEnvironment: (envId, options) => calls.loadEnvironment.push({ envId, options }),
  };
  const broadcast = (payload) => calls.broadcast.push(payload);

  const result = applySceneDocumentSettings({ skybox: { envId: 'outdoor_night' } }, {
    environmentManager,
    broadcast,
  });

  deepStrictEqual(result, { envApplied: true, envId: 'outdoor_night' });
  strictEqual(calls.loadEnvironment.length, 1);
  strictEqual(calls.loadEnvironment[0].envId, 'outdoor_night');
  strictEqual(calls.loadEnvironment[0].options.broadcastChange, false);
  deepStrictEqual(calls.broadcast[0], { kind: 'scene-env', envId: 'outdoor_night' });
});

test('does nothing when skybox is absent (keeps current environment)', () => {
  const calls = { loadEnvironment: [], broadcast: [] };
  const environmentManager = {
    loadEnvironment: (envId, options) => calls.loadEnvironment.push({ envId, options }),
  };
  const broadcast = (payload) => calls.broadcast.push(payload);

  const result = applySceneDocumentSettings({}, { environmentManager, broadcast });

  deepStrictEqual(result, { envApplied: false });
  strictEqual(calls.loadEnvironment.length, 0);
  strictEqual(calls.broadcast.length, 0);
});

test('does nothing when skybox.envId is null', () => {
  const result = applySceneDocumentSettings({ skybox: { envId: null } }, {});
  deepStrictEqual(result, { envApplied: false });
});
