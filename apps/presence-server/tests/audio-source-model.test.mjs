import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAudioSource,
  normalizeAudioSourcesMap,
  mergeAudioSourcesPatch,
  validateAudioSourcesMap,
  normalizeAudioSourceSync,
  isHttpUrl,
  DEFAULT_AUDIO_SOURCE_NAME,
} from '../../../html/assets/js/scenesync/audio/audio-source.js';

test('normalizeAudioSource', async (t) => {
  await t.test('applies defaults and trims url', () => {
    const source = normalizeAudioSource({ url: '  https://example.com/a.mp3  ' });
    assert.equal(source.type, 'audioSource');
    assert.equal(source.name, DEFAULT_AUDIO_SOURCE_NAME);
    assert.equal(source.url, 'https://example.com/a.mp3');
    assert.equal(source.volume, 1);
    assert.equal(source.loop, false);
    assert.equal(source.playOnAwake, false);
    assert.equal(source.offset, 0);
    assert.equal(source.playbackRate, 1);
    assert.equal(source.spatial, true);
    assert.equal(source.sync, undefined);
  });

  await t.test('returns null without a url', () => {
    assert.equal(normalizeAudioSource({ name: 'x' }), null);
    assert.equal(normalizeAudioSource(null), null);
  });

  await t.test('honors explicit name from options', () => {
    const source = normalizeAudioSource({ url: 'https://example.com/a.mp3' }, { name: 'music' });
    assert.equal(source.name, 'music');
  });

  await t.test('clamps volume and coerces flags', () => {
    const source = normalizeAudioSource({
      url: 'https://example.com/a.mp3',
      volume: 5,
      loop: true,
      playOnAwake: true,
      playbackRate: 0,
      spatial: false,
      offset: -2,
    });
    assert.equal(source.volume, 1);
    assert.equal(source.loop, true);
    assert.equal(source.playOnAwake, true);
    assert.equal(source.playbackRate, 1); // 0 falls back to default
    assert.equal(source.spatial, false);
    assert.equal(source.offset, 0); // negative falls back to default
  });

  await t.test('normalizes sync block', () => {
    const source = normalizeAudioSource({
      url: 'https://example.com/a.mp3',
      sync: { mode: 'animation', animationClipName: 'dance', offset: 0.5, resyncOnLoop: false, driftThreshold: 0.1 },
    });
    assert.deepEqual(source.sync, {
      mode: 'animation',
      offset: 0.5,
      resyncOnLoop: false,
      animationClipName: 'dance',
      driftThreshold: 0.1,
    });
  });
});

test('normalizeAudioSourceSync defaults', () => {
  assert.equal(normalizeAudioSourceSync(null), null);
  assert.deepEqual(normalizeAudioSourceSync({}), { mode: 'none', offset: 0, resyncOnLoop: true });
});

test('normalizeAudioSourcesMap drops invalid and null entries', () => {
  const map = normalizeAudioSourcesMap({
    default: { url: 'https://example.com/a.mp3' },
    broken: { name: 'broken' },
    removed: null,
  });
  assert.deepEqual(Object.keys(map), ['default']);
});

test('mergeAudioSourcesPatch', async (t) => {
  const existing = {
    default: normalizeAudioSource({ url: 'https://example.com/a.mp3' }),
  };

  await t.test('adds a new source', () => {
    const merged = mergeAudioSourcesPatch(existing, {
      voice: { url: 'https://example.com/v.mp3' },
    });
    assert.deepEqual(Object.keys(merged).sort(), ['default', 'voice']);
  });

  await t.test('removes a source when value is null', () => {
    const merged = mergeAudioSourcesPatch(existing, { default: null });
    assert.deepEqual(Object.keys(merged), []);
  });

  await t.test('does not mutate the existing map', () => {
    mergeAudioSourcesPatch(existing, { default: null });
    assert.ok(existing.default);
  });
});

test('validateAudioSourcesMap', async (t) => {
  await t.test('accepts null (clear)', () => {
    assert.equal(validateAudioSourcesMap(null).ok, true);
  });
  await t.test('accepts a valid map', () => {
    assert.equal(validateAudioSourcesMap({ default: { url: 'https://example.com/a.mp3', loop: true } }).ok, true);
  });
  await t.test('accepts null source value (removal patch)', () => {
    assert.equal(validateAudioSourcesMap({ default: null }).ok, true);
  });
  await t.test('rejects arrays', () => {
    assert.equal(validateAudioSourcesMap([]).ok, false);
  });
  await t.test('rejects missing url', () => {
    assert.equal(validateAudioSourcesMap({ default: { loop: true } }).ok, false);
  });
  await t.test('rejects non-boolean loop', () => {
    assert.equal(validateAudioSourcesMap({ default: { url: 'https://x/a.mp3', loop: 'yes' } }).ok, false);
  });
});

test('isHttpUrl', () => {
  assert.equal(isHttpUrl('https://example.com/a.mp3'), true);
  assert.equal(isHttpUrl('http://example.com/a.mp3'), true);
  assert.equal(isHttpUrl('ftp://example.com/a.mp3'), false);
  assert.equal(isHttpUrl('not a url'), false);
});
