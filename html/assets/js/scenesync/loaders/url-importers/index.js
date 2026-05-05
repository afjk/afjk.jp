import { importVideoUrl } from './video.js';
import { importImageUrl } from './image.js';
import { importGlbUrl } from './glb.js';
import { importTextUrl } from './text.js';
import { classifyUrl, URL_KIND } from '../url-classifier.js';

/**
 * URL を分類し、対応する importer へ dispatch する。
 * @param {string} url
 * @param {object} ctx - importer context: { addOrUpdateObject, broadcastSceneAdd, showToast, generateObjectId, getSpawnTransform, THREE }
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

  if (classified.kind === URL_KIND.VIDEO || classified.kind === URL_KIND.VIDEO_HLS) {
    return await importVideoUrl(classified.url, ctx);
  }

  if (classified.kind === URL_KIND.IMAGE) {
    return await importImageUrl(classified.url, ctx);
  }

  if (classified.kind === URL_KIND.GLB) {
    return await importGlbUrl(classified.url, ctx);
  }

  if (classified.kind === URL_KIND.TEXT) {
    return await importTextUrl(classified.url, ctx);
  }

  if (classified.kind === URL_KIND.WEBPAGE) {
    ctx.showToast({
      type: 'error',
      message: 'この URL は対応していません（動画/画像の直接 URL のみ対応）',
    });
    return;
  }

  ctx.showToast({
    type: 'error',
    message: '未対応の URL です',
  });
}
