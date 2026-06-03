/**
 * Scene Sync AudioSource component model.
 *
 * AudioSource は「オブジェクトに付く音声再生コンポーネント」（Unity の Audio Source 相当）。
 * 1つのオブジェクトは name をキーにした複数の AudioSource を持てる（audioSources map）。
 *
 * このモジュールは DOM / Three.js に依存しない純粋なデータモデルで、
 * ビューア（scene.js）・サーバ schema・テストから共通利用できる。
 */

export const DEFAULT_AUDIO_SOURCE_NAME = 'default';

export const AUDIO_SOURCE_DEFAULTS = Object.freeze({
  volume: 1,
  loop: false,
  playOnAwake: false,
  offset: 0,
  playbackRate: 1,
  spatial: true,
  state: 'stopped',
});

export const AUDIO_SOURCE_STATES = Object.freeze(['stopped', 'playing', 'paused']);

export function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
}

function clampVolume(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return AUDIO_SOURCE_DEFAULTS.volume;
  return Math.max(0, Math.min(1, value));
}

function positiveOrDefault(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteOrDefault(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function resolveName(input, options) {
  const fromInput = typeof input?.name === 'string' ? input.name.trim() : '';
  if (fromInput) return fromInput;
  const fromOptions = typeof options?.name === 'string' ? options.name.trim() : '';
  if (fromOptions) return fromOptions;
  return DEFAULT_AUDIO_SOURCE_NAME;
}

/**
 * Animation 同期補助設定を正規化する。
 * @param {object|null} sync
 * @returns {object|null}
 */
export function normalizeAudioSourceSync(sync) {
  if (!sync || typeof sync !== 'object') return null;
  const mode = sync.mode === 'animation' ? 'animation' : 'none';
  const result = {
    mode,
    offset: Number.isFinite(sync.offset) ? sync.offset : 0,
    resyncOnLoop: sync.resyncOnLoop !== false,
  };
  if (typeof sync.animationClipName === 'string' && sync.animationClipName.trim()) {
    result.animationClipName = sync.animationClipName.trim();
  }
  if (Number.isFinite(sync.driftThreshold) && sync.driftThreshold >= 0) {
    result.driftThreshold = sync.driftThreshold;
  }
  return result;
}

/**
 * 単一の AudioSource を正規化する。url が無ければ null。
 * @param {object} input
 * @param {{ name?: string }} [options]
 * @returns {object|null} normalized SceneSyncAudioSource
 */
export function normalizeAudioSource(input, options = {}) {
  if (!input || typeof input !== 'object') return null;
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!url) return null;

  const source = {
    type: 'audioSource',
    name: resolveName(input, options),
    url,
    volume: clampVolume(input.volume),
    loop: input.loop === true,
    playOnAwake: input.playOnAwake === true,
    offset: finiteOrDefault(input.offset, AUDIO_SOURCE_DEFAULTS.offset),
    playbackRate: positiveOrDefault(input.playbackRate, AUDIO_SOURCE_DEFAULTS.playbackRate),
    spatial: input.spatial !== false,
  };

  if (AUDIO_SOURCE_STATES.includes(input.state)) {
    source.state = input.state;
  }

  const sync = normalizeAudioSourceSync(input.sync);
  if (sync) source.sync = sync;

  return source;
}

/**
 * audioSources map 全体を正規化する（null 値は除外）。
 * @param {object} map
 * @returns {Record<string, object>}
 */
export function normalizeAudioSourcesMap(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
  const result = {};
  for (const [key, value] of Object.entries(map)) {
    if (value === null) continue;
    const source = normalizeAudioSource(value, { name: key });
    if (source) result[source.name] = source;
  }
  return result;
}

/**
 * 既存の audioSources に部分 map（patch）を適用する。
 * value が null のキーは削除を意味する。
 * @param {object} existing
 * @param {object} patch
 * @returns {Record<string, object>}
 */
export function mergeAudioSourcesPatch(existing, patch) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? { ...existing }
    : {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
      continue;
    }
    const source = normalizeAudioSource(value, { name: key });
    if (source) {
      base[source.name] = source;
    }
  }
  return base;
}

/**
 * audioSources map / patch のバリデーション（schema 用）。
 * @param {*} map
 * @param {{ maxStringLength?: number, maxUrlLength?: number }} [options]
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateAudioSourcesMap(map, options = {}) {
  const { maxStringLength = 128, maxUrlLength = 2048 } = options;
  if (map === null) return { ok: true };
  if (typeof map !== 'object' || Array.isArray(map)) {
    return { ok: false, reason: 'audioSources must be an object map or null' };
  }
  for (const [name, source] of Object.entries(map)) {
    if (typeof name !== 'string' || name.length === 0 || name.length > maxStringLength) {
      return { ok: false, reason: 'audioSources keys must be reasonable strings' };
    }
    if (source === null) continue;
    if (typeof source !== 'object' || Array.isArray(source)) {
      return { ok: false, reason: `audioSources.${name} must be an object or null` };
    }
    if (typeof source.url !== 'string' || source.url.length === 0 || source.url.length > maxUrlLength) {
      return { ok: false, reason: `audioSources.${name}.url must be a reasonable string` };
    }
    if (source.volume !== undefined && (typeof source.volume !== 'number' || !Number.isFinite(source.volume))) {
      return { ok: false, reason: `audioSources.${name}.volume must be a finite number` };
    }
    if (source.loop !== undefined && typeof source.loop !== 'boolean') {
      return { ok: false, reason: `audioSources.${name}.loop must be a boolean` };
    }
    if (source.playOnAwake !== undefined && typeof source.playOnAwake !== 'boolean') {
      return { ok: false, reason: `audioSources.${name}.playOnAwake must be a boolean` };
    }
    if (source.offset !== undefined && (typeof source.offset !== 'number' || !Number.isFinite(source.offset))) {
      return { ok: false, reason: `audioSources.${name}.offset must be a finite number` };
    }
    if (source.playbackRate !== undefined && (typeof source.playbackRate !== 'number' || !Number.isFinite(source.playbackRate))) {
      return { ok: false, reason: `audioSources.${name}.playbackRate must be a finite number` };
    }
    if (source.spatial !== undefined && typeof source.spatial !== 'boolean') {
      return { ok: false, reason: `audioSources.${name}.spatial must be a boolean` };
    }
  }
  return { ok: true };
}
