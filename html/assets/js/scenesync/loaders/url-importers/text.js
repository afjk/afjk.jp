const DEFAULT_TEXT_LAYOUT = {
  version: 1,
  width: 2.4,
  height: 1.6,
  padding: 0.12,
  lineHeight: 1.35,
  mode: 'scroll',
};

const DEFAULT_TEXT_SCROLL = {
  y: 0,
};

function getTextUrlFormat(url) {
  try {
    const u = new URL(url);
    const ext = (u.pathname.split('.').pop() || '').toLowerCase();
    return ext === 'md' || ext === 'markdown' ? 'markdown' : 'plain';
  } catch {
    return /\.(md|markdown)(?:$|[?#])/i.test(String(url))
      ? 'markdown'
      : 'plain';
  }
}

/**
 * URL からテキストアセットを scene-add として追加。
 * テキスト内容はフェッチせず URL 参照のまま保持する。
 * ローカルの loadTextObject が描画時にフェッチする。
 * @param {string} url - 分類済みのテキスト URL（確定済み）
 * @param {object} ctx - { addOrUpdateObject, broadcastSceneAdd, showToast, generateObjectId, getSpawnTransform }
 * @returns {Promise<{ objectId, payload }>}
 */
export async function importTextUrl(url, ctx) {
  try {
    const objectId = ctx.generateObjectId('txt');
    const filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'text');
    const displayName = (ctx.nameOverride || `text: ${filename}`).slice(0, 60);
    const spawnTransform = ctx.getSpawnTransform();
    const existingMetadata = (ctx.metadata && typeof ctx.metadata === 'object')
      ? ctx.metadata
      : {};

    const payload = {
      kind: 'scene-add',
      objectId,
      name: displayName,
      position: spawnTransform.position,
      rotation: spawnTransform.rotation,
      scale: spawnTransform.scale,
      asset: {
        type: 'text',
        source: 'url',
        url,
        format: getTextUrlFormat(url),
        fontFamily: 'system-sans',
        fontSize: 32,
        fontWeight: 'normal',
        fontStyle: 'normal',
        color: '#ffffff',
        backgroundColor: 'rgba(0,0,0,0.65)',
        align: 'left',
        layout: { ...DEFAULT_TEXT_LAYOUT, autoFit: true },
        scroll: { ...DEFAULT_TEXT_SCROLL },
      },
      metadata: {
        ...existingMetadata,
        role: 'text-panel',
        accepts: ['text'],
        placement: {
          surfaceKind: ctx.surfaceKind || null,
          normal: ctx.normalArray || null,
        },
      },
    };

    if (typeof ctx.commitSceneAdd === 'function') {
      ctx.commitSceneAdd(payload);
    } else {
      ctx.broadcastSceneAdd(payload);
      ctx.addOrUpdateObject(objectId, payload);
    }

    return { objectId, payload };
  } catch (err) {
    ctx.showToast({
      type: 'error',
      message: `テキスト URL の追加に失敗しました: ${err?.message || 'エラー'}`,
    });
    throw err;
  }
}
