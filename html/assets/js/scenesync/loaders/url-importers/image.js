/**
 * Image タグを使用して CORS 付きで画像をロード。
 * @param {string} url
 * @param {object} opts - { timeoutMs = 15000 }
 * @returns {Promise<{ texture, width, height, aspect }>}
 */
export async function loadImageTextureFromUrl(url, { timeoutMs = 15000, THREE } = {}) {
  const img = document.createElement('img');
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';

  await new Promise((resolve, reject) => {
    let settled = false;
    let timerId = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timerId !== null) clearTimeout(timerId);
      fn(arg);
    };

    const onLoad = () => finish(resolve);
    const onError = () => finish(
      reject,
      new Error('画像の読み込みに失敗しました（CORS設定が必要、または URL が無効です）')
    );
    img.addEventListener('load', onLoad, { once: true });
    img.addEventListener('error', onError, { once: true });
    timerId = setTimeout(
      () => finish(reject, new Error('画像の読み込みがタイムアウトしました')),
      timeoutMs
    );

    img.src = url;
  });

  const aspect = img.naturalWidth / img.naturalHeight || 1;
  const texture = new THREE.Texture(img);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  texture.anisotropy = 8;

  return { texture, width: img.naturalWidth, height: img.naturalHeight, aspect };
}

/**
 * アスペクト比から plane サイズを計算（long edge = maxEdgeMeters）。
 * @param {number} aspect - width / height (デフォルト 1 if 0 or invalid)
 * @param {number} maxEdgeMeters - 長辺の長さ（デフォルト 2 m）
 * @returns {object} { width, height }
 */
export function planeSizeFromAspect(aspect, maxEdgeMeters = 2) {
  const minEdge = 0.1;
  const safeAspect = (aspect && aspect > 0) ? aspect : 1;
  let width, height;

  if (safeAspect >= 1) {
    width = Math.max(maxEdgeMeters, minEdge);
    height = Math.max(maxEdgeMeters / safeAspect, minEdge);
  } else {
    height = Math.max(maxEdgeMeters, minEdge);
    width = Math.max(maxEdgeMeters * safeAspect, minEdge);
  }

  return { width, height };
}

/**
 * URL から画像をロードし、scene-add を broadcast してローカルに配置。
 * @param {string} url - 分類済みの画像 URL（確定済み）
 * @param {object} ctx - { addOrUpdateObject, broadcastSceneAdd, showToast, generateObjectId, getSpawnTransform, THREE }
 * @returns {Promise<{ objectId, payload }>}
 */
export async function importImageUrl(url, ctx) {
  try {
    const bundle = await loadImageTextureFromUrl(url, { THREE: ctx.THREE });
    const { texture, aspect } = bundle;
    const { width, height } = planeSizeFromAspect(aspect);

    const objectId = ctx.generateObjectId('img');
    const filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'image');
    const displayName = filename.slice(0, 60) || 'image';
    const spawnTransform = ctx.getSpawnTransform();

    const payload = {
      kind: 'scene-add',
      objectId,
      name: displayName,
      position: spawnTransform.position,
      rotation: spawnTransform.rotation,
      scale: spawnTransform.scale,
      asset: { type: 'image', source: 'url', url },
    };

    ctx.broadcastSceneAdd(payload);

    // ローカルにも反映: prebuilt texture を渡してロードを省略
    ctx.addOrUpdateObject(objectId, payload, { prebuiltImageBundle: { texture, width, height, aspect } });

    return { objectId, payload };
  } catch (err) {
    ctx.showToast({
      type: 'error',
      message: `画像 URL の読み込みに失敗しました: ${err?.message || 'CORS等の問題'}`,
    });
    throw err;
  }
}
