import { normalizeGlbForSceneSync } from '../glb-normalizer.js';

/**
 * GLB (binary glTF) をフェッチして GLTFLoader で読み込む。
 * KHR_materials_pbrSpecularGlossiness を含む場合は metalRough() で変換する。
 * @param {string} url
 * @param {object} opts - { THREE, GLTFLoader, timeoutMs = 30000 }
 * @returns {Promise<{ model: THREE.Group, sizeBytes: number, contentType: string, normalization: object }>}
 */
export async function loadGlbFromUrl(url, {
  THREE,
  GLTFLoader,
  timeoutMs = 30000,
  configureLoader = null,
  prepareRoot = null,
} = {}) {
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
  const validPrefixes = ['model/gltf-binary', 'application/octet-stream', 'model/gltf+json'];
  if (!validPrefixes.some((t) => contentType.startsWith(t))) {
    console.warn(`[glb-url] unexpected content-type: ${contentType} for ${url}`);
  }

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

  // KHR_materials_pbrSpecularGlossiness を検出したら metalRough() で変換
  let normalization = { changed: false, skipped: false, skipReason: null, warnings: [] };
  let parseBuffer = arrayBuffer;
  try {
    const n = await normalizeGlbForSceneSync(arrayBuffer);
    normalization = n;
    if (n.changed) {
      parseBuffer = n.arrayBuffer;
    }
  } catch (error) {
    console.warn('[glb-url] normalizeGlbForSceneSync threw unexpectedly', error);
    normalization = { changed: false, skipped: true, skipReason: 'unexpectedError', warnings: [error.message] };
  }

  // GLTFLoader で parse
  let gltf;
  try {
    const loader = new GLTFLoader();
    await configureLoader?.(loader);
    gltf = await new Promise((resolve, reject) => {
      loader.parse(parseBuffer, '', resolve, reject);
    });
  } catch (err) {
    throw new Error(`GLB ファイルの解析に失敗しました: ${err?.message || '不明なエラー'}`);
  }

  const animations = Array.isArray(gltf.animations) ? gltf.animations : [];
  const animationState = animations.length > 0
    ? { enabled: true, clip: 0, mode: 'loop', speed: 1 }
    : null;

  gltf.scene.userData.scenesync = {
    ...gltf.scene.userData?.scenesync,
    animations,
    animationState,
  };
  prepareRoot?.(gltf.scene, THREE);

  // 変換後の ArrayBuffer を保持（upload/broadcast 用）
  if (normalization.changed) {
    gltf.scene.userData.normalizedGlbArrayBuffer = normalization.arrayBuffer;
    gltf.scene.userData.normalization = normalization;
  } else {
    gltf.scene.userData.normalization = normalization;
  }

  return {
    model: gltf.scene,
    animations,
    sizeBytes: arrayBuffer.byteLength,
    contentType,
    normalization,
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
    const { model, animations, normalization } = await loadGlbFromUrl(url, {
      THREE: ctx.THREE,
      GLTFLoader: ctx.GLTFLoader,
      configureLoader: ctx.configureGLTFLoader,
      prepareRoot: ctx.prepareGlTFRoot,
    });

    const objectId = ctx.generateObjectId('glb');
    const filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'model.glb');
    const displayName = filename.slice(0, 60) || 'model.glb';
    const spawnTransform = ctx.getSpawnTransform();

    const animationState = animations.length > 0
      ? { enabled: true, clip: 0, mode: 'loop', speed: 1 }
      : null;

    model.userData = {
      ...model.userData,
      scenesync: {
        ...model.userData?.scenesync,
        animations,
        animationState,
      },
    };

    if (animationState) {
      model.userData.animationState = animationState;
    }

    if (animations.length > 0) {
      console.info('[glb-url] animations detected', {
        url,
        count: animations.length,
        names: animations.map((clip) => clip?.name || '(unnamed)'),
      });
    }

    // 変換後GLBがある場合はpresence blobへuploadしてから broadcast する。
    // これにより他クライアント・後参加者・reload・exportすべてが変換後GLBを参照できる。
    let asset = { type: 'mesh', source: 'url', url };
    let uploadSucceeded = false;

    if (normalization?.changed && ctx.uploadGlbAsset) {
      try {
        const { meshPath, assetId, size } = await ctx.uploadGlbAsset(
          normalization.arrayBuffer,
          displayName,
        );
        asset = {
          type: 'mesh',
          source: 'carrier',
          assetId: assetId || null,
          meshPath,
          size,
          mime: 'model/gltf-binary',
          originalName: displayName,
        };
        // ローカルモデルのuserDataにも記録（export / snapshot用）
        model.userData.meshPath = meshPath;
        model.userData.assetId = assetId;
        model.userData.asset = { ...asset };
        uploadSucceeded = true;
        console.info('[glb-url] Uploaded normalized GLB to presence blob', { meshPath, assetId });
      } catch (uploadError) {
        // upload失敗時は元URLで共有（表示は変換済み、共有は元URL）
        console.warn('[glb-url] Failed to upload normalized GLB, sharing original URL', uploadError);
        ctx.showToast('変換済みGLBのアップロードに失敗しました。元URLで共有されます');
      }
    }

    const payload = {
      kind: 'scene-add',
      objectId,
      name: displayName,
      position: spawnTransform.position,
      rotation: spawnTransform.rotation,
      scale: spawnTransform.scale,
      asset,
    };

    if (asset.meshPath) {
      payload.meshPath = asset.meshPath;
    }

    if (animations.length > 0) {
      payload.animation = { enabled: true, clip: 0, mode: 'loop', speed: 1 };
    }

    const addOptions = { prebuiltGlbModel: model };

    if (typeof ctx.commitSceneAdd === 'function') {
      ctx.commitSceneAdd(payload, addOptions);
    } else {
      ctx.broadcastSceneAdd(payload);
      ctx.addOrUpdateObject(objectId, payload, addOptions);
    }

    // 正規化の結果をトーストで通知
    // upload失敗時はすでにtoastを出しているので重複させない
    if (normalization?.changed && uploadSucceeded) {
      ctx.showToast('Sketchfab形式のマテリアルをScene Sync向けに変換しました');
    } else if (normalization?.skipped) {
      ctx.showToast('このモデルはScene Syncで正しく表示できない可能性があるマテリアルを使用しています');
    }

    return { objectId, payload };
  } catch (err) {
    ctx.showToast({
      type: 'error',
      message: `GLB URL の読み込みに失敗しました: ${err?.message || 'CORS等の問題'}`,
    });
    throw err;
  }
}
