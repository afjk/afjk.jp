import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryManager } from './history-manager.js';

test('remove history restores object physics and audio sources on undo', () => {
  const physics = {
    version: 1,
    enabled: true,
    bodyType: 'dynamic',
    shape: 'sphere',
    mass: 1,
    restitution: 0.4,
    friction: 0.5,
    velocity: [0, 0, 0],
  };
  const audioSources = {
    default: {
      type: 'audioSource',
      name: 'default',
      url: 'https://example.com/sound.mp3',
    },
  };

  const entry = HistoryManager.createRemoveEntry(
    'ball',
    'Ball',
    { type: 'primitive', primitive: 'sphere' },
    [0, 2, 0],
    [0, 0, 0, 1],
    [1, 1, 1],
    { physics, audioSources },
  );

  assert.deepEqual(entry.forward, {
    kind: 'scene-remove',
    objectId: 'ball',
  });
  assert.equal(entry.backward.kind, 'scene-add');
  assert.deepEqual(entry.backward.physics, physics);
  assert.deepEqual(entry.backward.audioSources, audioSources);
});

test('remove history omits optional restore fields when they are not provided', () => {
  const entry = HistoryManager.createRemoveEntry(
    'box',
    'Box',
    { type: 'primitive', primitive: 'box' },
    [0, 0, 0],
    [0, 0, 0, 1],
    [1, 1, 1],
  );

  assert.equal(Object.prototype.hasOwnProperty.call(entry.backward, 'physics'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entry.backward, 'audioSources'), false);
});
