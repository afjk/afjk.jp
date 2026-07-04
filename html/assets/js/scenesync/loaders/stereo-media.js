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
  '3dh', 'leftright', 'sidebyside',
]);
const TB_TOKENS = new Set([
  'htab', 'ftab', 'overunder', 'topbottom', '3dv',
]);
// 2文字の曖昧トークンは誤爆しやすいので、別の立体視シグナル
// （vr180 / 3d / stereo）が同居する場合だけ有効にする。
const WEAK_SBS_TOKENS = new Set(['lr']);
const WEAK_TB_TOKENS = new Set(['tb', 'ou']);
const STEREO_CONTEXT_TOKENS = new Set(['3d', 'stereo']);

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
  const hasStereoContext = vr180 || has(STEREO_CONTEXT_TOKENS);
  let layout = null;
  if (has(SBS_TOKENS)) layout = 'sbs';
  else if (has(TB_TOKENS)) layout = 'tb';
  else if (hasStereoContext && has(WEAK_SBS_TOKENS)) layout = 'sbs';
  else if (hasStereoContext && has(WEAK_TB_TOKENS)) layout = 'tb';

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

/**
 * 目ごとのテクスチャ領域をジオメトリの UV に焼き込む。
 * texture.offset/repeat ではなく UV 側で切り出すことで、
 * 左右の目が 1 枚のテクスチャ（GPU アップロード 1 回）を共有できる。
 * 変換が恒等（mono）の場合は base geometry をそのまま共有する。
 */
function geometryForEye(baseGeometry, stereoLayout, eye) {
  const { offset, repeat } = eyeTextureTransform(stereoLayout, eye);
  if (offset[0] === 0 && offset[1] === 0 && repeat[0] === 1 && repeat[1] === 1) {
    return { geometry: baseGeometry, owned: false };
  }
  const geometry = baseGeometry.clone();
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(
      i,
      offset[0] + uv.getX(i) * repeat[0],
      offset[1] + uv.getY(i) * repeat[1]
    );
  }
  uv.needsUpdate = true;
  return { geometry, owned: true };
}

function createInvisibleHitProxyMaterial(THREE) {
  return new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    colorWrite: false,
  });
}

const EYES = [
  { eye: 'left', layer: LAYER_LEFT_EYE },
  { eye: 'right', layer: LAYER_RIGHT_EYE },
];

function addEyeMeshes({ THREE, group, baseGeometry, material, stereoLayout, namePrefix, positionY = 0, disposables }) {
  for (const { eye, layer } of EYES) {
    const { geometry, owned } = geometryForEye(baseGeometry, stereoLayout, eye);
    if (owned) disposables.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${namePrefix}-${eye}`;
    mesh.position.y = positionY;
    mesh.layers.set(layer);
    group.add(mesh);
  }
}

/**
 * 左右目用の plane を重ねた group を作る（flat + sbs/tb 用）。
 * layer 0 には raycast / 選択用の不可視 hit proxy を置く。
 * texture は呼び出し側が所有する（dispose は呼び出し側の責務）。
 * @param {object} params
 *   - THREE
 *   - texture: 素材全体のテクスチャ（両目で共有）
 *   - aspect: 素材全体の width / height
 *   - stereoLayout: 'sbs' | 'tb' | 'mono'
 *   - maxEdgeMeters
 * @returns {{ group, width, height, disposables: Array<{dispose: Function}> }}
 */
export function buildStereoPlaneGroup({
  THREE,
  texture,
  aspect,
  stereoLayout,
  maxEdgeMeters = 2,
}) {
  if (!THREE) throw new Error('THREE is required');

  const { width, height } = stereoPlaneSize(aspect, stereoLayout, maxEdgeMeters);
  const baseGeometry = new THREE.PlaneGeometry(width, height);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.01,
    depthWrite: true,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const proxyMaterial = createInvisibleHitProxyMaterial(THREE);
  const disposables = [baseGeometry, material, proxyMaterial];
  const group = new THREE.Group();

  addEyeMeshes({
    THREE,
    group,
    baseGeometry,
    material,
    stereoLayout,
    namePrefix: 'stereo-plane',
    positionY: height / 2,
    disposables,
  });

  const proxy = new THREE.Mesh(baseGeometry, proxyMaterial);
  proxy.name = 'stereo-hit-proxy';
  proxy.position.y = height / 2;
  group.add(proxy);

  return { group, width, height, disposables };
}

/**
 * VR180 半球ドームの group を作る。
 * 半球は -Z（正面）を向き、内側から見る前提。mono / sbs / tb に対応。
 * layer 0 には選択・raycast 用の不可視な半球 hit proxy を重ねる
 * （ドーム表面クリックで選択できる。配置 raycast からは scene.js 側で除外）。
 * texture は呼び出し側が所有する（dispose は呼び出し側の責務）。
 * @param {object} params
 *   - THREE
 *   - texture: 素材全体のテクスチャ（両目で共有）
 *   - stereoLayout
 *   - radius
 * @returns {{ group, radius, disposables: Array<{dispose: Function}> }}
 */
export function buildVr180DomeGroup({
  THREE,
  texture,
  stereoLayout,
  radius = DEFAULT_VR180_RADIUS,
}) {
  if (!THREE) throw new Error('THREE is required');

  // phiStart=PI, phiLength=PI + scale(-1,1,1) で
  // 半球正面が -Z、テクスチャ左端が視聴者の左（-X）になる。
  const baseGeometry = new THREE.SphereGeometry(radius, 64, 32, Math.PI, Math.PI);
  baseGeometry.scale(-1, 1, 1);

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.FrontSide,
    toneMapped: false,
  });
  const proxyMaterial = createInvisibleHitProxyMaterial(THREE);
  const disposables = [baseGeometry, material, proxyMaterial];
  const group = new THREE.Group();

  addEyeMeshes({
    THREE,
    group,
    baseGeometry,
    material,
    stereoLayout,
    namePrefix: 'vr180-dome',
    disposables,
  });

  const proxy = new THREE.Mesh(baseGeometry, proxyMaterial);
  proxy.name = 'vr180-hit-proxy';
  group.add(proxy);

  return { group, radius, disposables };
}

/**
 * URL import 共通の立体視処理:
 * 形式解決（明示指定 > ファイル名自動判定）、自動判定トースト、
 * VR180 の視点高さ持ち上げ、asset に spread する fields をまとめて返す。
 * @param {object} params
 *   - explicitFormat: UI からの明示指定（ctx.mediaFormat）
 *   - url
 *   - spawnPosition: [x, y, z]
 *   - showToast
 * @returns {{ mediaFormat, position, assetFields }}
 */
export function prepareStereoMediaImport({ explicitFormat, url, spawnPosition, showToast }) {
  const mediaFormat = resolveMediaFormat(explicitFormat, url);
  if (mediaFormat?.detected) {
    showToast?.({ message: `立体視形式を自動判定: ${stereoMediaLabel(mediaFormat)}` });
  }
  // VR180 ドームは中心が視点高さに来るように持ち上げる
  const position = mediaFormat?.projection === 'vr180'
    ? [
      spawnPosition[0],
      Math.max(spawnPosition[1], DEFAULT_VR180_EYE_HEIGHT),
      spawnPosition[2],
    ]
    : spawnPosition;

  return {
    mediaFormat,
    position,
    assetFields: mediaFormat
      ? { projection: mediaFormat.projection, stereoLayout: mediaFormat.stereoLayout }
      : {},
  };
}
