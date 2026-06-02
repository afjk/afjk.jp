/**
 * URL から音声をロードする。
 * - オブジェクト上に D&D/ペーストされた場合: そのオブジェクトに AudioSource component を追加/更新する。
 * - 空間/床/背景的な場所の場合: 従来通り scene-bgm として broadcast / 適用する。
 * @param {string} url - 分類済みのオーディオ URL（確定済み）
 * @param {object} ctx - { addOrUpdateAudioSource, resolveObjectAudioTarget, applySceneBgm, broadcastSceneBgm, showToast }
 * @returns {Promise<{ objectId?, payload }>}
 */
export async function importAudioUrl(url, ctx) {
  function requireFn(name) {
    if (typeof ctx?.[name] !== 'function') {
      throw new Error(`audio importer requires ctx.${name}`);
    }
    return ctx[name];
  }

  try {
    const objectId = typeof ctx?.resolveObjectAudioTarget === 'function'
      ? ctx.resolveObjectAudioTarget()
      : null;

    if (objectId) {
      const addOrUpdateAudioSource = requireFn('addOrUpdateAudioSource');
      const showToast = requireFn('showToast');
      // D&D/ペースト初期値: default という名前で playOnAwake/loop を有効化。
      const payload = addOrUpdateAudioSource(objectId, {
        name: 'default',
        url,
        playOnAwake: true,
        loop: true,
      });
      showToast({
        type: 'success',
        message: 'オブジェクトに音声を設定しました',
      });
      return { objectId, payload };
    }

    const broadcastSceneBgm = requireFn('broadcastSceneBgm');
    const applySceneBgm = requireFn('applySceneBgm');
    const showToast = requireFn('showToast');

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

    broadcastSceneBgm(payload);
    applySceneBgm(payload.bgm);
    showToast({
      type: 'success',
      message: 'BGMを設定しました',
    });

    return { payload };
  } catch (err) {
    const showToast = typeof ctx?.showToast === 'function' ? ctx.showToast : console.error;
    showToast({
      type: 'error',
      message: `音声URLの設定に失敗しました: ${err?.message || 'Unknown error'}`,
    });
    throw err;
  }
}
