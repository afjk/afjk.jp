/**
 * GLB (binary glTF) をフェッチして GLTFLoader で読み込む。
 * @param {string} url
 * @param {object} opts - { THREE, GLTFLoader, timeoutMs = 30000 }
 * @returns {Promise<{ model: THREE.Group, sizeBytes: number, contentType: string }>}
 */
export async function loadGlbFromUrl(url, { THREE, GLTFLoader, timeoutMs = 30000 } = {}) {
  if (!THREE || !GLTFLoader) {
    throw new Error('THREE および GLTFLoader は必須です');
  }

  let res;
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    res = await fetch(url, {
      mode: 'cors',
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`GLB の読み込みがタイムアウトしました (${timeoutMs}ms)`);
    }
    throw new Error(`GLB ファイルのフェッチに失敗しました: ${err?.message || '不明なエラー'}`);
  } finally {
    clearTimeout(timerId);
  }

  if (!res.ok) {
    throw new Error(`GLB ファイルの取得に失敗しました (HTTP ${res.status})`);
  }

  const contentType = res.headers.get('content-type') || 'application/octet-stream';

  // Content-Length チェック（サイズ上限 50 MB）
  const contentLength = res.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > 50 * 1024 * 1024) {
    throw new Error('GLB ファイルが大きすぎます (上限 50 MB)');
  }

  let arrayBuffer;
  try {
    arrayBuffer = await res.arrayBuffer();
  } catch (err) {
    throw new Error(`GLB ファイルの読み込みに失敗しました: ${err?.message || '不明なエラー'}`);
  }

  // arrayBuffer 取得後の size チェック
  if (arrayBuffer.byteLength > 50 * 1024 * 1024) {
    throw new Error('GLB ファイルが大きすぎます (上限 50 MB)');
  }

  // GLTFLoader で parse
  let gltf;
  try {
    const loader = new GLTFLoader();
    gltf = await new Promise((resolve, reject) => {
      loader.parse(arrayBuffer, '', resolve, reject);
    });
  } catch (err) {
    throw new Error(`GLB ファイルの解析に失敗しました: ${err?.message || '不明なエラー'}`);
  }

  return {
    model: gltf.scene,
    sizeBytes: arrayBuffer.byteLength,
    contentType,
  };
}

/**
 * URL から GLB をロードし、scene-add を broadcast してローカルに配置。
 * @param {string} url - 分類済みの GLB URL（確定済み）
 * @param {object} ctx - { addOrUpdateObject, broadcastSceneAdd, showToast, generateObjectId, getSpawnTransform, THREE, GLTFLoader }
 * @returns {Promise<{ objectId, payload }>}
 */
export async function importGlbUrl(url, ctx) {
  try {
    const { model } = await loadGlbFromUrl(url, { THREE: ctx.THREE, GLTFLoader: ctx.GLTFLoader });

    const objectId = ctx.generateObjectId('glb');
    const filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'model.glb');
    const displayName = filename.slice(0, 60) || 'model.glb';
    const spawnTransform = ctx.getSpawnTransform();

    const payload = {
      kind: 'scene-add',
      objectId,
      name: displayName,
      position: spawnTransform.position,
      rotation: spawnTransform.rotation,
      scale: spawnTransform.scale,
      asset: { type: 'mesh', source: 'url', url },
    };

    ctx.broadcastSceneAdd(payload);

    // ローカルにも反映: prebuilt model を渡してロードを省略
    ctx.addOrUpdateObject(objectId, payload, { prebuiltGlbModel: model });

    return { objectId, payload };
  } catch (err) {
    ctx.showToast({
      type: 'error',
      message: `GLB URL の読み込みに失敗しました: ${err?.message || 'CORS等の問題'}`,
    });
    throw err;
  }
}
