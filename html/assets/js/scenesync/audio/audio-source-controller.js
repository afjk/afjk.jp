/**
 * Scene Sync AudioSource playback controller / host API.
 *
 * オブジェクトに付いた AudioSource component（audioSources map）を実際の音声再生に反映し、
 * Loomlet から呼ばれる低レベル操作（play/pause/stop/seek/playOneShot/setVolume/setClip）と
 * Animation 同期補助（syncToAnimation/unsync）を提供する。
 *
 * 再生条件や演出ロジック（ボタンSE・衝突音・キャラクター音声切替など）はここには含めない。
 * それらは Loomlet 側がこの host API を呼んで実装する。
 *
 * DOM 依存（Audio 要素生成）は createAudio 経由で注入できるためテスト可能。
 */

import {
  normalizeAudioSource,
  normalizeAudioSourcesMap,
  normalizeAudioSourceSync,
  DEFAULT_AUDIO_SOURCE_NAME,
} from './audio-source.js';

function defaultNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function defaultCreateAudio(url) {
  const audio = new Audio();
  audio.src = url;
  audio.preload = 'auto';
  return audio;
}

function safePause(audio) {
  try { audio?.pause?.(); } catch { /* noop */ }
}

function safeSeek(audio, time) {
  if (!audio) return;
  if (!Number.isFinite(time) || time < 0) return;
  try { audio.currentTime = time; } catch { /* noop */ }
}

export function createAudioSourceController(deps = {}) {
  const {
    createAudio = defaultCreateAudio,
    getObjectRuntimeTime = () => 0,
    getAnimationSample = null,
    isObjectBeingEdited = () => false,
    showToast = null,
    now = defaultNow,
  } = deps;

  // objectId -> Map<name, entry>
  // entry: { config, audio, desiredState, started, autoplayBlocked, lastSampleTime }
  const objects = new Map();
  const oneShots = new Set();

  function getEntryMap(objectId, create = false) {
    let map = objects.get(objectId);
    if (!map && create) {
      map = new Map();
      objects.set(objectId, map);
    }
    return map || null;
  }

  function getEntry(objectId, name = DEFAULT_AUDIO_SOURCE_NAME) {
    return getEntryMap(objectId)?.get(name) || null;
  }

  function applyAudioElementConfig(audio, config) {
    if (!audio) return;
    audio.loop = config.loop === true;
    audio.volume = typeof config.volume === 'number' ? Math.max(0, Math.min(1, config.volume)) : 1;
    if (typeof config.playbackRate === 'number' && config.playbackRate > 0) {
      try { audio.playbackRate = config.playbackRate; } catch { /* noop */ }
    }
  }

  function disposeEntry(entry) {
    if (!entry?.audio) return;
    safePause(entry.audio);
    try {
      entry.audio.src = '';
      entry.audio.load?.();
    } catch { /* noop */ }
    entry.audio = null;
  }

  function desiredStateForConfig(config, fallback) {
    if (config.state === 'playing' || config.state === 'paused' || config.state === 'stopped') {
      return config.state;
    }
    if (config.playOnAwake) return 'playing';
    return fallback || 'stopped';
  }

  /**
   * オブジェクトの audioSources 全体を再生エンジンへ反映する（reconcile）。
   * @param {string} objectId
   * @param {Record<string, object>} sourcesMap
   */
  function setObjectAudioSources(objectId, sourcesMap) {
    if (!objectId) return;
    const normalized = normalizeAudioSourcesMap(sourcesMap);
    const map = getEntryMap(objectId, true);

    // remove entries no longer present
    for (const name of Array.from(map.keys())) {
      if (!normalized[name]) {
        disposeEntry(map.get(name));
        map.delete(name);
      }
    }

    for (const [name, config] of Object.entries(normalized)) {
      let entry = map.get(name);
      if (!entry) {
        entry = {
          config,
          audio: null,
          desiredState: desiredStateForConfig(config, 'stopped'),
          started: false,
          autoplayBlocked: false,
          lastSampleTime: null,
        };
        map.set(name, entry);
      } else {
        const urlChanged = entry.config?.url !== config.url;
        entry.config = config;
        if (urlChanged) {
          disposeEntry(entry);
          entry.started = false;
        }
        // explicit state in payload overrides current desired state
        if (config.state === 'playing' || config.state === 'paused' || config.state === 'stopped') {
          entry.desiredState = config.state;
        }
      }
    }

    if (map.size === 0) {
      objects.delete(objectId);
    }
  }

  function ensureAudio(entry) {
    if (entry.audio) return entry.audio;
    if (!entry.config?.url) return null;
    const audio = createAudio(entry.config.url);
    applyAudioElementConfig(audio, entry.config);
    entry.audio = audio;
    entry.autoplayBlocked = false;
    return audio;
  }

  function tryPlay(entry, objectId, name) {
    const audio = ensureAudio(entry);
    if (!audio) return;
    if (!audio.paused) return;
    const result = audio.play?.();
    if (result && typeof result.then === 'function') {
      result.then(() => {
        entry.autoplayBlocked = false;
      }).catch((err) => {
        if (!entry.autoplayBlocked) {
          entry.autoplayBlocked = true;
          console.warn('[SceneSync] AudioSource autoplay blocked:', err?.message);
          showToast?.({
            type: 'warning',
            message: 'オブジェクト音声の自動再生がブロックされました',
          });
        }
      });
    }
  }

  // ── Host API ──────────────────────────────────────────

  function play(objectId, name = DEFAULT_AUDIO_SOURCE_NAME) {
    const entry = getEntry(objectId, name);
    if (!entry) return false;
    entry.desiredState = 'playing';
    entry.started = true;
    tryPlay(entry, objectId, name);
    return true;
  }

  function pause(objectId, name = DEFAULT_AUDIO_SOURCE_NAME) {
    const entry = getEntry(objectId, name);
    if (!entry) return false;
    entry.desiredState = 'paused';
    safePause(entry.audio);
    return true;
  }

  function stop(objectId, name = DEFAULT_AUDIO_SOURCE_NAME) {
    const entry = getEntry(objectId, name);
    if (!entry) return false;
    entry.desiredState = 'stopped';
    safePause(entry.audio);
    safeSeek(entry.audio, 0);
    return true;
  }

  function seek(objectId, name = DEFAULT_AUDIO_SOURCE_NAME, time = 0) {
    const entry = getEntry(objectId, name);
    if (!entry) return false;
    safeSeek(ensureAudio(entry), time);
    return true;
  }

  function setVolume(objectId, name = DEFAULT_AUDIO_SOURCE_NAME, volume = 1) {
    const entry = getEntry(objectId, name);
    if (!entry) return false;
    const clamped = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 1));
    entry.config = { ...entry.config, volume: clamped };
    if (entry.audio) entry.audio.volume = clamped;
    return true;
  }

  /**
   * AudioSource の clip(url) を差し替える。再生中なら新しい clip を読み込む。
   * 注意: component（audioSources map）への永続反映は呼び出し側（scene.js）が broadcast で行う。
   */
  function setClip(objectId, name = DEFAULT_AUDIO_SOURCE_NAME, url) {
    const entry = getEntry(objectId, name);
    if (!entry) return false;
    const source = normalizeAudioSource({ ...entry.config, url, name }, { name });
    if (!source) return false;
    const wasPlaying = entry.desiredState === 'playing';
    entry.config = source;
    disposeEntry(entry);
    entry.started = false;
    if (wasPlaying) tryPlay(entry, objectId, name);
    return true;
  }

  /**
   * 毎回頭から鳴らす単発再生（ボタンSE・衝突音用）。
   * component の再生状態には影響しない。
   */
  function playOneShot(objectId, name = DEFAULT_AUDIO_SOURCE_NAME, options = {}) {
    const entry = getEntry(objectId, name);
    const url = options.url || entry?.config?.url;
    if (!url) return false;
    const audio = createAudio(url);
    audio.loop = false;
    audio.volume = typeof options.volume === 'number'
      ? Math.max(0, Math.min(1, options.volume))
      : (entry?.config?.volume ?? 1);
    if (typeof options.playbackRate === 'number' && options.playbackRate > 0) {
      try { audio.playbackRate = options.playbackRate; } catch { /* noop */ }
    }
    const cleanup = () => {
      oneShots.delete(audio);
      try { audio.src = ''; audio.load?.(); } catch { /* noop */ }
    };
    audio.addEventListener?.('ended', cleanup, { once: true });
    oneShots.add(audio);
    safeSeek(audio, Number.isFinite(options.offset) ? options.offset : 0);
    const result = audio.play?.();
    if (result && typeof result.then === 'function') {
      result.catch(() => cleanup());
    }
    return true;
  }

  function syncToAnimation(objectId, name = DEFAULT_AUDIO_SOURCE_NAME, options = {}) {
    const entry = getEntry(objectId, name);
    if (!entry) return false;
    const sync = normalizeAudioSourceSync({ mode: 'animation', ...options });
    entry.config = { ...entry.config, sync };
    entry.lastSampleTime = null;
    return true;
  }

  function unsync(objectId, name = DEFAULT_AUDIO_SOURCE_NAME) {
    const entry = getEntry(objectId, name);
    if (!entry) return false;
    const next = { ...entry.config };
    delete next.sync;
    entry.config = next;
    entry.lastSampleTime = null;
    return true;
  }

  // ── tick ──────────────────────────────────────────────

  function getTimelineTargetTime(objectId, entry, nowMs, clockState) {
    const audio = entry.audio;
    const duration = Number.isFinite(audio?.duration) && audio.duration > 0 ? audio.duration : null;
    const runtimeTime = getObjectRuntimeTime(objectId, nowMs, clockState);
    if (!duration && clockState?.mode === 'host-follow' && runtimeTime > 3600) {
      return null;
    }
    let target = (entry.config.offset || 0) + runtimeTime;
    if (duration) {
      target = entry.config.loop ? ((target % duration) + duration) % duration : Math.min(target, duration);
    }
    return Math.max(0, target);
  }

  function applyTransportPlaybackRate(audio, config, clockState) {
    if (!audio) return;
    const sourceRate = typeof config.playbackRate === 'number' && config.playbackRate > 0
      ? config.playbackRate
      : 1;
    const transportRate = Number.isFinite(clockState?.rate) && clockState.rate > 0
      ? clockState.rate
      : 1;
    try { audio.playbackRate = sourceRate * transportRate; } catch { /* noop */ }
  }

  function tickEntry(objectId, name, entry, nowMs, clockState = null) {
    const config = entry.config;
    if (!config?.url) return;

    // while edited, freeze playback to start (matches inspector editing UX)
    if (isObjectBeingEdited(objectId)) {
      if (entry.audio) {
        safePause(entry.audio);
        safeSeek(entry.audio, config.offset || 0);
      }
      return;
    }

    // initial autoplay
    if (!entry.started && config.playOnAwake && entry.desiredState !== 'stopped') {
      entry.started = true;
      entry.desiredState = 'playing';
      const audio = ensureAudio(entry);
      applyTransportPlaybackRate(audio, config, clockState);
      safeSeek(audio, getTimelineTargetTime(objectId, entry, nowMs, clockState));
    }

    if (entry.desiredState === 'stopped') {
      if (entry.audio && !entry.audio.paused) safePause(entry.audio);
      return;
    }
    if (entry.desiredState === 'paused') {
      if (entry.audio && !entry.audio.paused) safePause(entry.audio);
      return;
    }

    // desiredState === 'playing'
    const audio = ensureAudio(entry);
    if (!audio) return;
    applyTransportPlaybackRate(audio, config, clockState);

    const transportPaused = Boolean(clockState?.isPaused) || clockState?.rate === 0;
    const sync = config.sync;
    let syncedToAnimation = false;
    if (sync?.mode === 'animation' && typeof getAnimationSample === 'function') {
      const sample = getAnimationSample(objectId, sync.animationClipName);
      if (sample && Number.isFinite(sample.time)) {
        syncedToAnimation = true;
        const driftThreshold = Number.isFinite(sync.driftThreshold) ? sync.driftThreshold : 0.05;
        const offset = (sync.offset || 0) + (config.offset || 0);
        const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null;
        let target = sample.time + offset;
        if (duration) {
          target = config.loop ? ((target % duration) + duration) % duration : Math.min(Math.max(0, target), duration);
        } else if (target < 0) {
          target = 0;
        }
        const looped = entry.lastSampleTime != null && sample.time < entry.lastSampleTime;
        entry.lastSampleTime = sample.time;
        const drift = Math.abs((audio.currentTime || 0) - target);
        if (drift > driftThreshold && (sync.resyncOnLoop !== false || !looped)) {
          safeSeek(audio, target);
        }
      }
    }

    if (transportPaused) {
      safePause(audio);
      if (!syncedToAnimation) {
        safeSeek(audio, getTimelineTargetTime(objectId, entry, nowMs, clockState));
      }
      return;
    }

    if (!syncedToAnimation) {
      const driftThreshold = 0.15;
      const target = getTimelineTargetTime(objectId, entry, nowMs, clockState);
      if (!Number.isFinite(target)) {
        tryPlay(entry, objectId, name);
        return;
      }
      const drift = Math.abs((audio.currentTime || 0) - target);
      if (drift > driftThreshold) {
        safeSeek(audio, target);
      }
    }

    tryPlay(entry, objectId, name);
  }

  function tick(nowMs = now(), clockState = null) {
    for (const [objectId, map] of objects) {
      for (const [name, entry] of map) {
        tickEntry(objectId, name, entry, nowMs, clockState);
      }
    }
  }

  // ── serialization / lifecycle ─────────────────────────

  function getObjectAudioSources(objectId) {
    const map = getEntryMap(objectId);
    if (!map) return {};
    const result = {};
    for (const [name, entry] of map) {
      result[name] = { ...entry.config, name };
    }
    return result;
  }

  function disposeObject(objectId) {
    const map = getEntryMap(objectId);
    if (!map) return;
    for (const entry of map.values()) disposeEntry(entry);
    objects.delete(objectId);
  }

  function dispose() {
    for (const objectId of Array.from(objects.keys())) disposeObject(objectId);
    for (const audio of oneShots) {
      safePause(audio);
      try { audio.src = ''; audio.load?.(); } catch { /* noop */ }
    }
    oneShots.clear();
  }

  return {
    setObjectAudioSources,
    getObjectAudioSources,
    play,
    pause,
    stop,
    seek,
    setVolume,
    setClip,
    playOneShot,
    syncToAnimation,
    unsync,
    tick,
    disposeObject,
    dispose,
  };
}
