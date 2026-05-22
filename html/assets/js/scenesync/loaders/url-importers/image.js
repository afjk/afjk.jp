/**
 * Fetch API を使用して画像を Blob として CORS 付きで取得。
 * Skybox 生成用。
 * @param {string} url
 * @param {object} opts - { timeoutMs = 15000 }
 * @returns {Promise<Blob>}
 */
export async function fetchImageBlobForSkybox(url, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      mode: 'cors',
      credentials: 'omit',
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      throw new Error(`画像URLではありません: ${contentType || 'unknown content-type'}`);
    }

    const blob = await res.blob();

    if (!blob.type.startsWith('image/')) {
      throw new Error(`画像Blobではありません: ${blob.type || 'unknown blob type'}`);
    }

    return blob;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * URL からファイル名を抽出。
 * @param {string} url
 * @param {string} fallback
 * @returns {string}
 */
function filenameFromUrl(url, fallback = 'image') {
  try {
    const parsed = new URL(url);
    const last = decodeURIComponent(parsed.pathname.split('/').pop() || '');
    return last || fallback;
  } catch {
    return fallback;
  }
}

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
 * targetKind が 'sky' の場合は Skybox Sphere を生成。
 * @param {string} url - 分類済みの画像 URL（確定済み）
 * @param {object} ctx - { addOrUpdateObject, broadcastSceneAdd, showToast, generateObjectId, getSpawnTransform, THREE, targetKind, replaceSkyboxSphereFromBlob }
 * @returns {Promise<{ objectId, payload }>}
 */
export async function importImageUrl(url, ctx) {
  try {
    if (ctx.targetKind === 'sky') {
      const blob = await fetchImageBlobForSkybox(url);
      const filename = filenameFromUrl(url, 'skybox-image');
      return await ctx.replaceSkyboxSphereFromBlob(blob, filename);
    }

    const bundle = await loadImageTextureFromUrl(url, { THREE: ctx.THREE });
    const { texture, aspect } = bundle;
    const { width, height } = planeSizeFromAspect(aspect);

    const objectId = ctx.generateObjectId('img');
    const filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'image');
    const displayName = (ctx.nameOverride || filename).slice(0, 60) || 'image';
    const spawnTransform = ctx.getSpawnTransform();
    const existingMetadata = (ctx.metadata && typeof ctx.metadata === 'object')
      ? ctx.metadata
      : {};
    const placementRotation = Array.isArray(ctx.placementRotation) && ctx.placementRotation.length >= 4
      ? ctx.placementRotation
      : spawnTransform.rotation;

    const payload = {
      kind: 'scene-add',
      objectId,
      name: displayName,
      position: spawnTransform.position,
      rotation: placementRotation,
      scale: spawnTransform.scale,
      asset: { type: 'image', source: 'url', url },
      metadata: {
        ...existingMetadata,
        role: 'media-panel',
        accepts: ['image', 'video'],
        fit: 'contain',
        placement: {
          surfaceKind: ctx.surfaceKind || null,
          normal: ctx.normalArray || null,
          rawNormal: ctx.rawNormalArray || null,
          wallSurfaceOffset: ctx.wallSurfaceOffset ?? 0,
        },
      },
    };

    console.debug('[url-image-import] scene-add transform', {
      objectId,
      position: payload.position,
      rotation: payload.rotation,
      scale: payload.scale,
      surfaceKind: ctx.surfaceKind || null,
      normal: ctx.normalArray || null,
      wallSurfaceOffset: ctx.wallSurfaceOffset ?? 0,
    });

    ctx.broadcastSceneAdd(payload);

    // ローカルにも反映: prebuilt texture を渡してロードを省略
    ctx.addOrUpdateObject(objectId, payload, { prebuiltImageBundle: { texture, width, height, aspect } });

    return { objectId, payload };
  } catch (err) {
    const errorMsg = ctx.targetKind === 'sky'
      ? `画像URLをSkybox化できませんでした: ${err?.message || 'CORS等の問題'}`
      : `画像 URL の読み込みに失敗しました: ${err?.message || 'CORS等の問題'}`;

    ctx.showToast({
      type: 'error',
      message: errorMsg,
    });
    throw err;
  }
}
