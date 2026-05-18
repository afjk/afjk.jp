/**
 * URL から BGM をロードし、scene-bgm を broadcast してローカルに適用。
 * @param {string} url - 分類済みのオーディオ URL（確定済み）
 * @param {object} ctx - { applySceneBgm, broadcastSceneBgm, showToast }
 * @returns {Promise<{ payload }>}
 */
export async function importAudioUrl(url, ctx) {
  try {
    const filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'audio');

    const payload = {
      kind: 'scene-bgm',
      bgm: {
        version: 1,
        url,
        name: filename,
        loop: true,
        volume: 1,
        playback: {
          mode: 'local-loop',
        },
      },
    };

    ctx.broadcastSceneBgm(payload);
    ctx.applySceneBgm(payload.bgm);
    ctx.showToast({
      type: 'success',
      message: 'BGMを設定しました',
    });

    return { payload };
  } catch (err) {
    ctx.showToast({
      type: 'error',
      message: `BGM URL の設定に失敗しました: ${err?.message || 'Unknown error'}`,
    });
    throw err;
  }
}
