import assert from 'node:assert/strict';
import test from 'node:test';

import { getEditorPlayerDeactivateSceneClockOptions } from './editor-player-transport.js';

test('editor player close preserves and resumes the local timeline', () => {
  assert.deepEqual(getEditorPlayerDeactivateSceneClockOptions(), {
    preserveLocalTimeline: true,
    resumeLocalTimeline: true,
  });
});
