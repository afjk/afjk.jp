import { loadVideoTextureFromUrl } from '../video-url-importer.js';
import {
  resolveMediaFormat,
  stereoMediaLabel,
  DEFAULT_VR180_EYE_HEIGHT,
} from '../stereo-media.js';

/**
 * URL から動画をロードし、scene-add を broadcast してローカルに配置。
 * @param {string} url - 分類済みの動画 URL（確定済み）
 * @param {object} ctx - { addOrUpdateObject, broadcastSceneAdd, showToast, generateObjectId, getSpawnTransform, THREE }
 * @returns {Promise<{ objectId, payload }>}
 */
export async function importVideoUrl(url, ctx) {
  try {
    const bundle = await loadVideoTextureFromUrl(url, { THREE: ctx.THREE });

    const objectId = ctx.generateObjectId('vid');
    const filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'video');
    const displayName = (ctx.nameOverride || `video: ${filename}`).slice(0, 60);
    const spawnTransform = ctx.getSpawnTransform();

    // 立体視 / VR180: UI からの明示指定（ctx.mediaFormat）優先、なければファイル名から自動判定
    const mediaFormat = resolveMediaFormat(ctx.mediaFormat, url);
    if (mediaFormat?.detected) {
      ctx.showToast?.({ message: `立体視形式を自動判定: ${stereoMediaLabel(mediaFormat)}` });
    }
    // VR180 ドームは中心が視点高さに来るように持ち上げる
    const position = mediaFormat?.projection === 'vr180'
      ? [
        spawnTransform.position[0],
        Math.max(spawnTransform.position[1], DEFAULT_VR180_EYE_HEIGHT),
        spawnTransform.position[2],
      ]
      : spawnTransform.position;

    const payload = {
      kind: 'scene-add',
      objectId,
      name: displayName,
      position,
      rotation: spawnTransform.rotation,
      scale: spawnTransform.scale,
      asset: {
        type: 'video',
        source: 'url',
        url,
        ...(mediaFormat
          ? { projection: mediaFormat.projection, stereoLayout: mediaFormat.stereoLayout }
          : {}),
      },
      metadata: {
        role: 'media-panel',
        accepts: ['image', 'video'],
        fit: 'contain',
      },
    };

    const addOptions = { prebuiltVideoBundle: bundle };

    if (typeof ctx.commitSceneAdd === 'function') {
      ctx.commitSceneAdd(payload, addOptions);
    } else {
      ctx.broadcastSceneAdd(payload);
      ctx.addOrUpdateObject(objectId, payload, addOptions);
    }

    return { objectId, payload };
  } catch (err) {
    ctx.showToast({
      type: 'error',
      message: `動画 URL の読み込みに失敗しました: ${err?.message || 'CORS等の問題'}`,
    });
    throw err;
  }
}
