/**
 * Stereo / VR180 media helpers.
 *
 * image / video asset は以下の optional metadata で立体視表示を切り替える。
 *
 * - asset.projection:   'flat'（既定） | 'vr180'
 * - asset.stereoLayout: 'mono'（既定） | 'sbs'（左右） | 'tb'（上下・左目が上）
 *
 * 描画は three.js の layer 規約に合わせる:
 * - 左目メッシュ → layer 1（WebXR 左目カメラ / デスクトップカメラで表示）
 * - 右目メッシュ → layer 2（WebXR 右目カメラで表示）
 * デスクトップ表示用にメインカメラは layer 1 を有効化しておくこと。
 */

export const STEREO_PROJECTIONS = ['flat', 'vr180'];
export const STEREO_LAYOUTS = ['mono', 'sbs', 'tb'];

export const LAYER_LEFT_EYE = 1;
export const LAYER_RIGHT_EYE = 2;

export const DEFAULT_VR180_RADIUS = 3;
export const DEFAULT_VR180_EYE_HEIGHT = 1.6;

/**
 * asset の projection / stereoLayout を検証して正規化する。
 * @param {object|null} asset
 * @returns {{ projection: string, stereoLayout: string, isDefault: boolean }}
 */
export function normalizeStereoMedia(asset) {
  const projection = STEREO_PROJECTIONS.includes(asset?.projection)
    ? asset.projection
    : 'flat';
  const stereoLayout = STEREO_LAYOUTS.includes(asset?.stereoLayout)
    ? asset.stereoLayout
    : 'mono';
  return {
    projection,
    stereoLayout,
    isDefault: projection === 'flat' && stereoLayout === 'mono',
  };
}

const VR180_TOKENS = new Set(['vr180', '180', '180x180']);
const SBS_TOKENS = new Set([
  'sbs', 'hsbs', 'fsbs', 'halfsbs', 'fullsbs',
  'lr', '3dh', 'leftright', 'sidebyside',
]);
const TB_TOKENS = new Set([
  'tb', 'htab', 'ftab', 'ou', 'overunder', 'topbottom', '3dv',
]);

function basenameFromUrlOrName(input) {
  if (!input || typeof input !== 'string') return '';
  let path = input;
  try {
    path = new URL(input).pathname;
  } catch {
    /* URL でなければファイル名として扱う */
  }
  const last = path.split('/').pop() || '';
  // 拡張子は判定対象外
  return last.replace(/\.[a-z0-9]+$/i, '');
}

/**
 * ファイル名 / URL から立体視形式を推定する。
 * トークン（英数字以外で分割）ベースの保守的な判定。
 * 判定できない場合は null。
 * @param {string} urlOrName
 * @returns {{ projection: string, stereoLayout: string } | null}
 */
export function detectStereoMediaFromName(urlOrName) {
  const base = basenameFromUrlOrName(urlOrName).toLowerCase();
  if (!base) return null;

  const tokens = base.split(/[^a-z0-9]+/).filter(Boolean);
  const has = (set) => tokens.some((t) => set.has(t));

  const vr180 = has(VR180_TOKENS);
  let layout = null;
  if (has(SBS_TOKENS)) layout = 'sbs';
  else if (has(TB_TOKENS)) layout = 'tb';

  // VR180 でレイアウト不明のまま '3d' が付く場合は SBS 慣行に合わせる
  if (vr180 && !layout && tokens.includes('3d')) layout = 'sbs';

  if (!vr180 && !layout) return null;

  return {
    projection: vr180 ? 'vr180' : 'flat',
    stereoLayout: layout || 'mono',
  };
}

/**
 * UI 上の明示指定があればそれを優先し、なければファイル名から自動判定する。
 * @param {{ projection?: string, stereoLayout?: string } | null} explicit
 * @param {string} urlOrName
 * @returns {{ projection: string, stereoLayout: string, detected: boolean } | null}
 */
export function resolveMediaFormat(explicit, urlOrName) {
  if (explicit && (explicit.projection || explicit.stereoLayout)) {
    const normalized = normalizeStereoMedia(explicit);
    if (!normalized.isDefault) {
      return { projection: normalized.projection, stereoLayout: normalized.stereoLayout, detected: false };
    }
    // 明示的に 2D/mono 指定された場合は自動判定もしない
    return null;
  }
  const detected = detectStereoMediaFromName(urlOrName);
  return detected ? { ...detected, detected: true } : null;
}

/**
 * トースト等に出す日本語ラベル。
 */
export function stereoMediaLabel(format) {
  const { projection, stereoLayout } = normalizeStereoMedia(format);
  const layoutLabel = stereoLayout === 'sbs'
    ? '3D 左右(SBS)'
    : stereoLayout === 'tb'
      ? '3D 上下(TB)'
      : '2D';
  if (projection === 'vr180') {
    return stereoLayout === 'mono' ? 'VR180 (2D)' : `VR180 ${layoutLabel}`;
  }
  return layoutLabel;
}

/**
 * 各目が使うテクスチャ領域（offset / repeat）。
 * tb は VR 慣行に合わせて左目=上段。
 * @param {string} stereoLayout
 * @param {'left'|'right'} eye
 * @returns {{ offset: [number, number], repeat: [number, number] }}
 */
export function eyeTextureTransform(stereoLayout, eye) {
  if (stereoLayout === 'sbs') {
    return {
      offset: [eye === 'right' ? 0.5 : 0, 0],
      repeat: [0.5, 1],
    };
  }
  if (stereoLayout === 'tb') {
    return {
      offset: [0, eye === 'right' ? 0 : 0.5],
      repeat: [1, 0.5],
    };
  }
  return { offset: [0, 0], repeat: [1, 1] };
}

/**
 * 素材全体のアスペクト比から、片目分のアスペクト比を求める。
 * @param {number} aspect - width / height（素材全体）
 * @param {string} stereoLayout
 * @returns {number}
 */
export function perEyeAspect(aspect, stereoLayout) {
  const safe = (aspect && aspect > 0) ? aspect : 1;
  if (stereoLayout === 'sbs') return safe / 2;
  if (stereoLayout === 'tb') return safe * 2;
  return safe;
}

/**
 * 片目分のアスペクト比から plane サイズを計算（long edge = maxEdgeMeters）。
 * url-importers/image.js の planeSizeFromAspect と同じ規則。
 */
export function stereoPlaneSize(aspect, stereoLayout, maxEdgeMeters = 2) {
  const minEdge = 0.1;
  const eyeAspect = perEyeAspect(aspect, stereoLayout);
  let width;
  let height;
  if (eyeAspect >= 1) {
    width = Math.max(maxEdgeMeters, minEdge);
    height = Math.max(maxEdgeMeters / eyeAspect, minEdge);
  } else {
    height = Math.max(maxEdgeMeters, minEdge);
    width = Math.max(maxEdgeMeters * eyeAspect, minEdge);
  }
  return { width, height };
}

function applyEyeTransformToTexture(texture, stereoLayout, eye) {
  const { offset, repeat } = eyeTextureTransform(stereoLayout, eye);
  texture.offset.set(offset[0], offset[1]);
  texture.repeat.set(repeat[0], repeat[1]);
  return texture;
}

function createInvisibleHitProxyMaterial(THREE) {
  return new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    colorWrite: false,
  });
}

/**
 * 左右目用の plane を重ねた group を作る（flat + sbs/tb 用）。
 * layer 0 には raycast / 選択用の不可視 hit proxy を置く。
 * @param {object} params
 *   - THREE
 *   - createEyeTexture: () => THREE.Texture（呼ぶたびに新しいテクスチャを返す）
 *   - aspect: 素材全体の width / height
 *   - stereoLayout: 'sbs' | 'tb' | 'mono'
 *   - maxEdgeMeters
 * @returns {{ group, width, height, disposables: Array<{dispose: Function}> }}
 */
export function buildStereoPlaneGroup({
  THREE,
  createEyeTexture,
  aspect,
  stereoLayout,
  maxEdgeMeters = 2,
}) {
  if (!THREE) throw new Error('THREE is required');

  const { width, height } = stereoPlaneSize(aspect, stereoLayout, maxEdgeMeters);
  const geometry = new THREE.PlaneGeometry(width, height);
  const disposables = [geometry];
  const group = new THREE.Group();

  const eyes = [
    { eye: 'left', layer: LAYER_LEFT_EYE },
    { eye: 'right', layer: LAYER_RIGHT_EYE },
  ];

  for (const { eye, layer } of eyes) {
    const texture = applyEyeTransformToTexture(createEyeTexture(), stereoLayout, eye);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.01,
      depthWrite: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `stereo-plane-${eye}`;
    mesh.position.y = height / 2;
    mesh.layers.set(layer);
    group.add(mesh);
    disposables.push(texture, material);
  }

  const proxyMaterial = createInvisibleHitProxyMaterial(THREE);
  const proxy = new THREE.Mesh(geometry, proxyMaterial);
  proxy.name = 'stereo-hit-proxy';
  proxy.position.y = height / 2;
  group.add(proxy);
  disposables.push(proxyMaterial);

  return { group, width, height, disposables };
}

/**
 * VR180 半球ドームの group を作る。
 * 半球は -Z（正面）を向き、内側から見る前提。mono / sbs / tb に対応。
 * 中心に選択・移動用の小さな不可視 hit proxy 球を置く。
 * @param {object} params
 *   - THREE
 *   - createEyeTexture: () => THREE.Texture
 *   - stereoLayout
 *   - radius
 * @returns {{ group, radius, disposables: Array<{dispose: Function}> }}
 */
export function buildVr180DomeGroup({
  THREE,
  createEyeTexture,
  stereoLayout,
  radius = DEFAULT_VR180_RADIUS,
}) {
  if (!THREE) throw new Error('THREE is required');

  // phiStart=PI, phiLength=PI + scale(-1,1,1) で
  // 半球正面が -Z、テクスチャ左端が視聴者の左（-X）になる。
  const geometry = new THREE.SphereGeometry(radius, 64, 32, Math.PI, Math.PI);
  geometry.scale(-1, 1, 1);

  const disposables = [geometry];
  const group = new THREE.Group();

  const eyes = [
    { eye: 'left', layer: LAYER_LEFT_EYE },
    { eye: 'right', layer: LAYER_RIGHT_EYE },
  ];

  for (const { eye, layer } of eyes) {
    const texture = applyEyeTransformToTexture(createEyeTexture(), stereoLayout, eye);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.FrontSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `vr180-dome-${eye}`;
    mesh.layers.set(layer);
    group.add(mesh);
    disposables.push(texture, material);
  }

  const proxyGeometry = new THREE.SphereGeometry(0.15, 12, 8);
  const proxyMaterial = createInvisibleHitProxyMaterial(THREE);
  const proxy = new THREE.Mesh(proxyGeometry, proxyMaterial);
  proxy.name = 'vr180-hit-proxy';
  group.add(proxy);
  disposables.push(proxyGeometry, proxyMaterial);

  return { group, radius, disposables };
}
