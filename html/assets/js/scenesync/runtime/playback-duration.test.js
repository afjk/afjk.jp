import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateAnimationEntryPlaybackDuration,
  calculateScenePlaybackDuration,
} from './playback-duration.js';

test('keeps the default duration for empty scenes', () => {
  assert.equal(calculateScenePlaybackDuration(), 60);
});

test('uses the currently selected animation clip, not the longest clip', () => {
  const duration = calculateScenePlaybackDuration({
    animationEntries: [{
      clips: [{ duration: 24 }, { duration: 120 }],
      clipIndex: 0,
    }],
  });

  assert.equal(duration, 60);
});

test('extends duration when the selected animation clip is longer than the default', () => {
  const duration = calculateScenePlaybackDuration({
    animationEntries: [{
      clips: [{ duration: 24 }, { duration: 120 }],
      clipIndex: 1,
    }],
  });

  assert.equal(duration, 120);
});

test('includes companion morph clips for the active animation', () => {
  const duration = calculateScenePlaybackDuration({
    animationEntries: [{
      clips: [{ duration: 48 }, { duration: 96 }, { duration: 8 }],
      clipIndex: 0,
      companionClipIndices: [1],
    }],
  });

  assert.equal(duration, 96);
});

test('uses cached companionActions clip indices', () => {
  const duration = calculateScenePlaybackDuration({
    animationEntries: [{
      clips: [{ duration: 48 }, { duration: 96 }],
      clipIndex: 0,
      companionActions: [{ clipIndex: 1 }],
    }],
  });

  assert.equal(duration, 96);
});

test('accounts for animation speed', () => {
  assert.equal(calculateAnimationEntryPlaybackDuration({
    clips: [{ duration: 120 }],
    clipIndex: 0,
    speed: 2,
  }), 60);
});

test('accounts for negative animation offset in once mode', () => {
  assert.equal(calculateAnimationEntryPlaybackDuration({
    clips: [{ duration: 120 }],
    clipIndex: 0,
    speed: 1,
    offset: -30,
    mode: 'once',
  }), 150);
});

test('ignores zero-speed animation entries', () => {
  const duration = calculateScenePlaybackDuration({
    animationEntries: [{
      clips: [{ duration: 180 }],
      clipIndex: 0,
      speed: 0,
    }],
  });

  assert.equal(duration, 60);
});

test('ignores disabled animation entries', () => {
  const duration = calculateScenePlaybackDuration({
    animationEntries: [{
      enabled: false,
      clips: [{ duration: 180 }],
      clipIndex: 0,
    }],
  });

  assert.equal(duration, 60);
});

test('extends duration for physics playback', () => {
  const duration = calculateScenePlaybackDuration({
    physicsDuration: 75.234,
  });

  assert.equal(duration, 75.24);
});
