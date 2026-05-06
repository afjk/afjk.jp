import { loadVideoTextureFromUrl } from '../video-url-importer.js';

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

    const payload = {
      kind: 'scene-add',
      objectId,
      name: displayName,
      position: spawnTransform.position,
      rotation: spawnTransform.rotation,
      scale: spawnTransform.scale,
      asset: { type: 'video', source: 'url', url },
    };

    ctx.broadcastSceneAdd(payload);

    // ローカルにも反映: prebuilt bundle を渡してロードを省略
    ctx.addOrUpdateObject(objectId, payload, { prebuiltVideoBundle: bundle });

    return { objectId, payload };
  } catch (err) {
    ctx.showToast({
      type: 'error',
      message: `動画 URL の読み込みに失敗しました: ${err?.message || 'CORS等の問題'}`,
    });
    throw err;
  }
}
