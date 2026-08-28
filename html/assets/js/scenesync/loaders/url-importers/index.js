import { importAudioUrl } from './audio.js';
import { importVideoUrl } from './video.js';
import { importImageUrl } from './image.js';
import { importGlbUrl } from './glb.js';
import { importTextUrl } from './text.js';
import { importSuperSplatUrl } from './supersplat.js';
import { classifyUrl, URL_KIND } from '../url-classifier.js';

/**
 * URL を分類し、対応する importer へ dispatch する。
 * @param {string} url
 * @param {object} ctx - importer context with scene-object and scene-level functions:
 *   - addOrUpdateObject: function for importing 3D objects
 *   - broadcastSceneAdd: function for broadcasting scene-object changes
 *   - applySceneBgm: function for applying BGM locally
 *   - broadcastSceneBgm: function for broadcasting BGM changes
 *   - showToast: function for displaying notifications
 *   - generateObjectId: function for generating unique object IDs
 *   - getSpawnTransform: function returning { position, rotation, scale }
 *   - THREE: Three.js library reference
 *   - GLTFLoader: Three.js GLTFLoader class (for GLB imports)
 *   - targetKind, placementRotation, placementQuaternion, surfaceKind, etc.
 * @returns {Promise<{ objectId, payload }>}
 */
export async function dispatchUrlImport(url, ctx) {
  const classified = classifyUrl(url);

  if (classified.kind === URL_KIND.UNSUPPORTED) {
    ctx.showToast({
      type: 'error',
      message: 'SVG 画像は対応していません（XSS リスク）',
    });
    return;
  }

  if (classified.kind === URL_KIND.INVALID) {
    ctx.showToast({
      type: 'error',
      message: 'URL が無効です。http(s) で始まる URL を使用してください',
    });
    return;
  }

  if (classified.kind === URL_KIND.AUDIO) {
    return await importAudioUrl(classified.url, ctx);
  }

  if (classified.kind === URL_KIND.VIDEO || classified.kind === URL_KIND.VIDEO_HLS) {
    return await importVideoUrl(classified.url, ctx);
  }

  if (classified.kind === URL_KIND.IMAGE) {
    return await importImageUrl(classified.url, ctx);
  }

  if (classified.kind === URL_KIND.GLB) {
    return await importGlbUrl(classified.url, ctx);
  }

  if (classified.kind === URL_KIND.SUPERSPLAT) {
    return await importSuperSplatUrl(classified.url, ctx);
  }

  if (classified.kind === URL_KIND.TEXT) {
    return await importTextUrl(classified.url, ctx);
  }

  if (classified.kind === URL_KIND.WEBPAGE) {
    ctx.showToast({
      type: 'error',
      message: 'この URL は対応していません（動画/画像/GLBの直接URL、またはSuperSplat公開シーンに対応）',
    });
    return;
  }

  ctx.showToast({
    type: 'error',
    message: '未対応の URL です',
  });
}
