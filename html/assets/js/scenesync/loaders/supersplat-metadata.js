import { parseSuperSplatSceneUrl } from './supersplat-share.js';

const ATTRIBUTION_STATUSES = new Set(['complete', 'partial', 'unavailable']);
const MAX_TITLE_CHARS = 160;
const MAX_NAME_CHARS = 160;
const MAX_LICENSE_CODE_CHARS = 64;
const MAX_LICENSE_LABEL_CHARS = 80;
const MAX_ATTRIBUTION_TEXT_CHARS = 4096;
const MAX_URL_CHARS = 2048;
const MAX_CREATORS = 32;

function safeText(value, maxLength, { multiline = false } = {}) {
  if (typeof value !== 'string') return '';
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  const text = multiline ? normalized : normalized.replace(/\s+/g, ' ');
  return text.slice(0, maxLength);
}

function safeHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_URL_CHARS) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return url.href;
}

function normalizeParty(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = safeText(value.name, MAX_NAME_CHARS);
  if (!name) return null;

  const url = value.url == null ? null : safeHttpsUrl(value.url);
  if (value.url != null && !url) return null;
  return { name, url };
}

export function normalizeSuperSplatLicense(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const code = safeText(value.code, MAX_LICENSE_CODE_CHARS);
  const label = safeText(value.label, MAX_LICENSE_LABEL_CHARS);
  if (!code || !label) return null;

  const url = value.url == null ? null : safeHttpsUrl(value.url);
  if (value.url != null && !url) return null;
  return { code, label, url };
}

export function normalizeSuperSplatAttribution(value, expectedSourceUrl) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!ATTRIBUTION_STATUSES.has(value.status)) return null;

  const expectedSource = parseSuperSplatSceneUrl(expectedSourceUrl);
  const source = parseSuperSplatSceneUrl(value.sourceUrl);
  if (!expectedSource || !source || source.sceneId !== expectedSource.sceneId) return null;

  if (!Array.isArray(value.creators) || value.creators.length > MAX_CREATORS) return null;
  const creators = value.creators.map(normalizeParty);
  if (creators.some((party) => !party)) return null;

  const publisher = value.publisher == null ? null : normalizeParty(value.publisher);
  if (value.publisher != null && !publisher) return null;

  const text = value.text == null
    ? null
    : safeText(value.text, MAX_ATTRIBUTION_TEXT_CHARS, { multiline: true }) || null;
  if (value.text != null && !text) return null;
  if (value.status === 'complete' && (!text || creators.length === 0 || !publisher)) return null;

  return {
    status: value.status,
    text,
    sourceUrl: expectedSource.sceneUrl,
    creators,
    publisher,
  };
}

function optionalText(value, maxLength) {
  const text = safeText(value, maxLength);
  return text || null;
}

function optionalNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Normalize the subset of Scene Sync metadata that is safe to recover from a
 * standalone GLB. Unknown fields are deliberately discarded.
 */
export function normalizeSuperSplatSourceMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.provider !== 'supersplat') return null;

  const page = parseSuperSplatSceneUrl(value.pageUrl);
  if (!page || value.sceneId !== page.sceneId) return null;

  const license = normalizeSuperSplatLicense(value.license);
  if (!license) return null;

  const attribution = value.attribution == null
    ? null
    : normalizeSuperSplatAttribution(value.attribution, page.sceneUrl);
  if (value.attribution != null && !attribution) return null;

  const result = {
    provider: 'supersplat',
    sceneId: page.sceneId,
    pageUrl: page.sceneUrl,
    title: optionalText(value.title, MAX_TITLE_CHARS) || '',
    author: optionalText(value.author, MAX_NAME_CHARS) || '',
    license,
    attribution,
  };

  for (const [key, maxLength] of [
    ['sourceFormat', 32],
    ['sourceAssetFormat', 32],
    ['revision', 32],
  ]) {
    const text = optionalText(value[key], maxLength);
    if (text) result[key] = text;
  }

  for (const key of ['splatCount', 'shDegree']) {
    const number = optionalNonNegativeInteger(value[key]);
    if (number !== null) result[key] = number;
  }

  return result;
}

export function createSuperSplatSourceMetadata(resolution, conversion = null) {
  const raw = {
    provider: 'supersplat',
    sceneId: resolution?.sceneId,
    pageUrl: resolution?.pageUrl,
    title: resolution?.title,
    author: resolution?.author,
    license: resolution?.license,
    attribution: resolution?.attribution ?? null,
    sourceAssetFormat: resolution?.asset?.format,
    revision: resolution?.asset?.revision,
    sourceFormat: conversion?.sourceFormat,
    splatCount: conversion?.splatCount,
    shDegree: conversion?.shDegree,
  };
  const normalized = normalizeSuperSplatSourceMetadata(raw);
  if (!normalized) throw new Error('SuperSplatの権利メタデータが不正です。');
  return normalized;
}

/** Metadata written into the glTF asset object of a generated GLB. */
export function createSuperSplatGlbAssetMetadata(resolution) {
  const source = createSuperSplatSourceMetadata(resolution);
  return {
    copyright: source.attribution?.text || null,
    extras: {
      scenesync: {
        gaussianSplatSource: source,
      },
    },
  };
}

/** Recover Scene Sync's namespaced source metadata from parsed glTF JSON. */
export function readEmbeddedSuperSplatSourceMetadata(gltfJson) {
  return normalizeSuperSplatSourceMetadata(
    gltfJson?.asset?.extras?.scenesync?.gaussianSplatSource,
  );
}
