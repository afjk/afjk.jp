/**
 * URL から動画を読み込み <video> + VideoTexture を返す。CORS 必須。
 * @param {string} url
 * @param {object} opts { THREE, maxEdgeMeters = 2, timeoutMs = 15000 }
 * @returns {Promise<{video, texture, planeWidth, planeHeight, aspect}>}
 */
export async function loadVideoTextureFromUrl(url, opts) {
  const { THREE, maxEdgeMeters = 2, timeoutMs = 15000 } = opts;
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.src = url;
  video.muted = true;
  video.autoplay = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';

  await new Promise((resolve, reject) => {
    let settled = false;
    let timerId = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timerId !== null) clearTimeout(timerId);
      fn(arg);
    };
    const onLoaded = () => finish(resolve);
    const onError = () => finish(reject, new Error('動画の読み込みに失敗しました（CORS 設定が必要、または URL が無効です）'));
    video.addEventListener('loadedmetadata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
    timerId = setTimeout(() => finish(reject, new Error('動画の読み込みがタイムアウトしました')), timeoutMs);
  });

  const aspect = video.videoWidth / video.videoHeight || 16 / 9;
  const planeWidth = aspect >= 1 ? maxEdgeMeters : maxEdgeMeters * aspect;
  const planeHeight = aspect >= 1 ? maxEdgeMeters / aspect : maxEdgeMeters;

  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  // 再生開始
  video.play().catch(() => {
    /* autoplay 拒否時は muted なのでほぼ通る */
  });

  return { video, texture, planeWidth, planeHeight, aspect };
}

/**
 * 既に作成された video texture から PlaneMesh + Group を作る。
 */
export function createVideoPlaneGroup(textureBundle, THREE) {
  const { texture, planeWidth, planeHeight } = textureBundle;
  const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.01,
    depthWrite: true,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = planeHeight / 2;
  const group = new THREE.Group();
  group.add(mesh);
  return { group, mesh, material, texture };
}
