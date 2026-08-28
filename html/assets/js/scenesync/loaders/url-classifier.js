import { parseSuperSplatSceneUrl } from './supersplat-share.js';

export const URL_KIND = {
  AUDIO: 'audio',
  VIDEO: 'video',
  VIDEO_HLS: 'video-hls',
  IMAGE: 'image',
  GLB: 'glb',
  SUPERSPLAT: 'supersplat',
  TEXT: 'text',
  WEBPAGE: 'webpage',
  UNSUPPORTED: 'unsupported',
  INVALID: 'invalid',
};

const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'm4a', 'aac'];
const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'm4v'];
const HLS_EXTS = ['m3u8'];
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'];
const UNSUPPORTED_EXTS = ['svg', 'gltf'];
const GLB_EXTS = ['glb'];
const TEXT_EXTS = ['txt', 'md', 'markdown'];

function classifyTwitterImageUrl(u) {
  if (u.hostname !== 'pbs.twimg.com') return null;
  if (!u.pathname.startsWith('/media/')) return null;

  const format = (u.searchParams.get('format') || '').toLowerCase();
  const normalized = format === 'jpg' ? 'jpeg' : format;

  if (['jpeg', 'png', 'webp', 'gif'].includes(normalized)) {
    return {
      kind: URL_KIND.IMAGE,
      url: u.toString(),
      ext: normalized,
      host: u.host,
    };
  }

  return null;
}

export function normalizeGitHubBlobUrl(urlString) {
  try {
    const u = new URL(urlString);
    if (u.hostname !== 'github.com') return urlString;

    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 5) return urlString;
    if (parts[2] !== 'blob') return urlString;

    const owner = parts[0];
    const repo = parts[1];
    const ref = parts[3];
    const filePath = parts.slice(4).join('/');

    if (!owner || !repo || !ref || !filePath) return urlString;

    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
  } catch {
    return urlString;
  }
}

/**
 * URL 文字列を分類する純関数。
 * @param {string} urlString
 * @returns {{ kind: string, url: string|null, ext: string, host: string }}
 */
export function classifyUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    return { kind: URL_KIND.INVALID, url: null, ext: '', host: '' };
  }
  const trimmed = urlString.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return { kind: URL_KIND.INVALID, url: null, ext: '', host: '' };
  }

  const normalized = normalizeGitHubBlobUrl(trimmed);

  let u;
  try {
    u = new URL(normalized);
  } catch {
    return { kind: URL_KIND.INVALID, url: null, ext: '', host: '' };
  }

  const twitterImage = classifyTwitterImageUrl(u);
  if (twitterImage) return twitterImage;

  const superSplat = parseSuperSplatSceneUrl(normalized);
  if (superSplat) {
    return {
      kind: URL_KIND.SUPERSPLAT,
      url: superSplat.sceneUrl,
      ext: '',
      host: u.host,
      sceneId: superSplat.sceneId,
    };
  }

  const ext = (u.pathname.split('.').pop() || '').toLowerCase();
  const host = u.host;
  const url = normalized;
  if (AUDIO_EXTS.includes(ext)) return { kind: URL_KIND.AUDIO, url, ext, host };
  if (VIDEO_EXTS.includes(ext)) return { kind: URL_KIND.VIDEO, url, ext, host };
  if (HLS_EXTS.includes(ext)) return { kind: URL_KIND.VIDEO_HLS, url, ext, host };
  if (IMAGE_EXTS.includes(ext)) return { kind: URL_KIND.IMAGE, url, ext, host };
  if (UNSUPPORTED_EXTS.includes(ext)) return { kind: URL_KIND.UNSUPPORTED, url, ext, host };
  if (GLB_EXTS.includes(ext)) return { kind: URL_KIND.GLB, url, ext, host };
  if (TEXT_EXTS.includes(ext)) return { kind: URL_KIND.TEXT, url, ext, host };
  return { kind: URL_KIND.WEBPAGE, url, ext, host };
}

/**
 * text/uri-list 形式から URL 配列を抽出。# で始まる行はコメント。
 */
export function parseUriList(uriList) {
  if (!uriList) return [];
  return uriList.split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('#'));
}

/**
 * プレーンテキストから http(s) URL を 1 件抽出（最初に見つかったもの）。
 */
export function extractUrlFromText(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/\S+/);
  return m ? m[0] : null;
}
