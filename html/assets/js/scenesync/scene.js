// ── scene.js ─────────────────────────────────────────────
// Three.js ビューア + presence-server 接続
// ─────────────────────────────────────────────────────────
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

// ── Three.js 基本セットアップ ────────────────────────────

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x222222);

const camera = new THREE.PerspectiveCamera(
  60, innerWidth / innerHeight, 0.1, 1000
);
camera.position.set(5, 5, 5);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

renderer.xr.enabled = true;
try {
  renderer.xr.setReferenceSpaceType('local-floor');
} catch (e) {
  console.warn('[XR] setReferenceSpaceType failed:', e);
}

const pmremGenerator = new THREE.PMREMGenerator(renderer);

// ライト（IBL 補助として残す）
scene.add(new THREE.AmbientLight(0xffffff, 0.3));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.5);
dirLight.position.set(5, 10, 7);
scene.add(dirLight);

// グリッド（HDRI 背景でも視認できるよう明るめに）
scene.add(new THREE.GridHelper(20, 20, 0x888888, 0x666666));

// ── IBL 環境光 ───────────────────────────────────────────

let currentEnvId = 'outdoor_day';
const envSelect = document.getElementById('env-select');

function loadEnvironment(envId) {
  const url = '/assets/hdri/' + envId + '.hdr';
  new RGBELoader().load(url, (texture) => {
    const envMap = pmremGenerator.fromEquirectangular(texture).texture;
    scene.environment = envMap;
    scene.background = envMap;
    texture.dispose();
    currentEnvId = envId;
    updateEnvSelector();
  });
}

function updateEnvSelector() {
  if (envSelect) envSelect.value = currentEnvId;
}

envSelect?.addEventListener('change', (e) => {
  const envId = e.target.value;
  loadEnvironment(envId);
  broadcast({ kind: 'scene-env', envId });
});

// glB ローダー
const gltfLoader = new GLTFLoader();
const BLOB_BASE = location.hostname === 'localhost'
  ? 'http://localhost:8787/blob'
  : 'https://afjk.jp/presence/blob';

// ── WebXR ボタンセットアップ ────────────────────────────────
const xrButtonContainer = document.getElementById('xr-button-container');
const xrAddBtn = document.getElementById('add-btn');

if ('xr' in navigator && xrButtonContainer) {
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
    if (!ok) return;
    const btn = VRButton.createButton(renderer);
    // VRButton は body へ自動 append するので、コンテナへ移動
    btn.style.position = 'static';
    btn.style.transform = 'none';
    btn.style.left = 'auto';
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
    xrButtonContainer.appendChild(btn);
    xrAddBtn?.classList.add('xr-available');
  }).catch(() => {});

  navigator.xr.isSessionSupported('immersive-ar').then((ok) => {
    if (!ok) return;
    const btn = ARButton.createButton(renderer, {
      optionalFeatures: ['local-floor', 'hit-test', 'dom-overlay'],
      domOverlay: { root: document.body },
    });
    btn.style.position = 'static';
    btn.style.transform = 'none';
    btn.style.left = 'auto';
    btn.style.right = 'auto';
    btn.style.bottom = 'auto';
    xrButtonContainer.appendChild(btn);
    xrAddBtn?.classList.add('xr-available');
  }).catch(() => {});
}

// ── XR コントローラー ──────────────────────────────────────
const xrState = {
  active: false,
  mode: null,            // 'immersive-vr' | 'immersive-ar' | null
  grab: {
    active: false,
    controller: null,
    object: null,
    lastSent: 0,
    // 掴み開始時の状態を保持して Y軸回転のみ追従させる
    initialObjectQuat: new THREE.Quaternion(),  // 掴み開始時のオブジェクト初期姿勢
    initialControllerYaw: 0,                    // 掴み開始時のコントローラーY軸回転
    grabOffsetLocal: new THREE.Vector3(),       // コントローラーローカル空間での位置オフセット
    yawOnly: true,                              // true: Y軸回転のみ, false: 6DoF自由回転
  },
  controllers: [],
};

// クォータニオンから Y軸回転（ヨー）成分のみを抽出する
function extractYaw(quat) {
  const x = quat.x, y = quat.y, z = quat.z, w = quat.w;
  return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + x * x));
}

const controllerModelFactory = new XRControllerModelFactory();

for (let i = 0; i < 2; i++) {
  const ctrl = renderer.xr.getController(i);
  ctrl.userData.xrIndex = i;
  ctrl.addEventListener('selectstart', () => onXrSelectStart(ctrl));
  ctrl.addEventListener('selectend',   () => onXrSelectEnd(ctrl));
  scene.add(ctrl);

  // レイ表示
  const rayGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -5),
  ]);
  const rayMat = new THREE.LineBasicMaterial({
    color: 0x88ccff,
    transparent: true,
    opacity: 0.7,
  });
  const ray = new THREE.Line(rayGeo, rayMat);
  ray.name = 'xr-ray';
  ray.raycast = () => {};
  ctrl.add(ray);

  // コントローラーモデル（grip）
  const grip = renderer.xr.getControllerGrip(i);
  grip.add(controllerModelFactory.createControllerModel(grip));
  scene.add(grip);

  xrState.controllers.push(ctrl);
}

const xrTmpMatrix = new THREE.Matrix4();
const xrRaycaster = new THREE.Raycaster();

function onXrSelectStart(ctrl) {
  // コントローラーから前方へレイキャスト
  xrTmpMatrix.identity().extractRotation(ctrl.matrixWorld);
  xrRaycaster.ray.origin.setFromMatrixPosition(ctrl.matrixWorld);
  xrRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(xrTmpMatrix);

  const targets = Array.from(managedObjects.values());
  const hits = xrRaycaster.intersectObjects(targets, true);
  if (hits.length === 0) return;

  let obj = hits[0].object;
  while (obj.parent && !obj.userData.objectId) obj = obj.parent;
  if (!obj.userData?.objectId) return;
  if (obj.userData._isLockOverlay) return;

  // 他人のロックを尊重
  if (locks.has(obj.userData.objectId)) {
    const lockInfo = locks.get(obj.userData.objectId);
    const ownerId = lockInfo?.id || lockInfo;
    if (ownerId && ownerId !== presenceState.id) return;
  }

  // scene-lock を発火
  broadcast({ kind: 'scene-lock', objectId: obj.userData.objectId });

  // 掴み開始時のオブジェクト姿勢を保存（Y軸回転以外を維持するため）
  xrState.grab.initialObjectQuat.copy(obj.quaternion);

  // 掴み開始時のコントローラーY軸回転（ヨー）を保存
  const ctrlWorldQuat = new THREE.Quaternion();
  ctrl.getWorldQuaternion(ctrlWorldQuat);
  xrState.grab.initialControllerYaw = extractYaw(ctrlWorldQuat);

  // コントローラーローカル空間でのオブジェクト位置オフセットを記録
  // （ctrl.attach は使わず、毎フレーム手動で位置を計算する方式）
  const objWorldPos = new THREE.Vector3();
  obj.getWorldPosition(objWorldPos);
  xrState.grab.grabOffsetLocal.copy(objWorldPos);
  ctrl.worldToLocal(xrState.grab.grabOffsetLocal);

  xrState.grab.active = true;
  xrState.grab.controller = ctrl;
  xrState.grab.object = obj;
  xrState.grab.lastSent = 0;
}

function onXrSelectEnd(ctrl) {
  if (!xrState.grab.active) return;
  if (xrState.grab.controller !== ctrl) return;

  const obj = xrState.grab.object;

  // ctrl.attach していないので scene.attach は不要
  // （位置・回転は updateXrGrab で既に適用済み）

  // 最終 delta を送信して unlock
  broadcastXrDelta(obj);
  broadcast({ kind: 'scene-unlock', objectId: obj.userData.objectId });

  xrState.grab.active = false;
  xrState.grab.controller = null;
  xrState.grab.object = null;
}

function broadcastXrDelta(obj) {
  if (!obj?.userData?.objectId) return;
  const wp = new THREE.Vector3();
  const wq = new THREE.Quaternion();
  const ws = new THREE.Vector3();
  obj.getWorldPosition(wp);
  obj.getWorldQuaternion(wq);
  obj.getWorldScale(ws);

  const pos = wp.toArray();
  if (!isFinite(pos[0]) || !isFinite(pos[1]) || !isFinite(pos[2])) return;

  broadcast({
    kind: 'scene-delta',
    objectId: obj.userData.objectId,
    position: pos,
    rotation: [wq.x, wq.y, wq.z, wq.w],
    scale: ws.toArray(),
  });
}

const _grabTmpVec = new THREE.Vector3();
const _grabTmpQuat = new THREE.Quaternion();
const _grabTmpEuler = new THREE.Euler();

function updateXrGrab() {
  if (!xrState.grab.active) return;

  const ctrl = xrState.grab.controller;
  const obj = xrState.grab.object;
  if (!ctrl || !obj) return;

  // 1. 位置: コントローラーローカル空間に保存したオフセットを
  //         現在のコントローラー姿勢でワールドに変換
  _grabTmpVec.copy(xrState.grab.grabOffsetLocal);
  ctrl.localToWorld(_grabTmpVec);
  obj.position.copy(_grabTmpVec);

  // 2. 回転: yawOnly モードなら Y軸回転のみ追従、
  //         そうでなければコントローラー姿勢を完全コピー
  if (xrState.grab.yawOnly) {
    // コントローラーの現在のヨーと、掴み開始時のヨーの差分を計算
    const ctrlWorldQuat = _grabTmpQuat;
    ctrl.getWorldQuaternion(ctrlWorldQuat);
    const currentYaw = extractYaw(ctrlWorldQuat);
    const deltaYaw = currentYaw - xrState.grab.initialControllerYaw;

    // 初期オブジェクト姿勢に Y軸回転 deltaYaw を加える
    _grabTmpEuler.set(0, deltaYaw, 0, 'YXZ');
    const yawQuat = new THREE.Quaternion().setFromEuler(_grabTmpEuler);
    obj.quaternion.copy(yawQuat).multiply(xrState.grab.initialObjectQuat);
  } else {
    // 6DoF モード: コントローラー姿勢を完全コピー
    ctrl.getWorldQuaternion(obj.quaternion);
  }

  // 50ms 間隔で delta を broadcast
  const now = performance.now();
  if (now - xrState.grab.lastSent < 50) return;
  xrState.grab.lastSent = now;
  broadcastXrDelta(obj);
}

// ── XR セッション開始/終了 ─────────────────────────────
let xrSavedBackground = null;

renderer.xr.addEventListener('sessionstart', () => {
  xrState.active = true;
  const session = renderer.xr.getSession();
  // セッションモード判定（mode プロパティが無い実装もあるので blendMode で AR を推定）
  const blendMode = session.environmentBlendMode || 'opaque';
  xrState.mode = (blendMode === 'opaque') ? 'immersive-vr' : 'immersive-ar';

  // TransformControls を退避
  if (transformCtrl.object) {
    const oid = transformCtrl.object.userData?.objectId;
    if (oid) broadcast({ kind: 'scene-unlock', objectId: oid });
    transformCtrl.detach();
  }
  const helper = transformCtrl.getHelper();
  if (helper) helper.visible = false;
  hideToolbar();

  // OrbitControls を無効化
  orbit.enabled = false;

  // AR の場合は背景を透過
  if (xrState.mode === 'immersive-ar') {
    xrSavedBackground = scene.background;
    scene.background = null;
  }
});

renderer.xr.addEventListener('sessionend', () => {
  xrState.active = false;

  // 掴み中だった場合は強制リリース
  if (xrState.grab.active && xrState.grab.object) {
    const obj = xrState.grab.object;
    // ctrl.attach していないので scene.attach は不要
    broadcastXrDelta(obj);
    if (obj.userData?.objectId) {
      broadcast({ kind: 'scene-unlock', objectId: obj.userData.objectId });
    }
    xrState.grab.active = false;
    xrState.grab.controller = null;
    xrState.grab.object = null;
  }

  // UI 復元
  const helper = transformCtrl.getHelper();
  if (helper) helper.visible = true;
  orbit.enabled = true;

  // 背景復元
  if (xrState.mode === 'immersive-ar') {
    if (xrSavedBackground !== null) {
      scene.background = xrSavedBackground;
      xrSavedBackground = null;
    } else if (currentEnvId) {
      loadEnvironment(currentEnvId);
    }
  }

  xrState.mode = null;
});

// ── コントロール ─────────────────────────────────────────

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.1;

const transformCtrl = new TransformControls(camera, renderer.domElement);
// Three.js 0.170+ では getHelper() で Object3D を取得して scene に追加
scene.add(transformCtrl.getHelper());

let isDragging = false;
let dragIntervalId = null;

transformCtrl.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !e.value;
  isDragging = e.value;

  if (isDragging) {
    dragIntervalId = setInterval(() => {
      sendSelectedDelta();
    }, 50);
  } else {
    clearInterval(dragIntervalId);
    dragIntervalId = null;
    sendSelectedDelta();
  }
});

function sendSelectedDelta() {
  const obj = transformCtrl.object;
  if (!obj || !obj.userData.objectId) return;

  const pos = obj.position.toArray();
  const rot = obj.quaternion.toArray();
  const scl = obj.scale.toArray();

  if (!isFinite(pos[0]) || !isFinite(pos[1]) || !isFinite(pos[2])) return;

  broadcast({
    kind: 'scene-delta',
    objectId: obj.userData.objectId,
    position: pos,
    rotation: rot,
    scale: scl,
  });
}

// ── サンプルオブジェクト ──────────────────────────────────

const sampleGeo = new THREE.BoxGeometry(1, 1, 1);
const sampleMat = new THREE.MeshStandardMaterial({ color: 0x4488ff });
const sampleCube = new THREE.Mesh(sampleGeo, sampleMat);
sampleCube.position.set(0, 0.5, 0);
sampleCube.userData.objectId = 'sample-cube';
scene.add(sampleCube);

// ── オブジェクト管理 ─────────────────────────────────────

// objectId → THREE.Object3D
const managedObjects = new Map();
managedObjects.set('sample-cube', sampleCube);

// objectId → lockOwnerId
const locks = new Map();

// objectId → wireframe mesh
const lockOverlays = new Map();

// ── トースト通知 ────────────────────────────────────────

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

// ── ロック表示 ──────────────────────────────────────────

function createCornerLines(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const min = box.min;
  const max = box.max;
  const size = box.getSize(new THREE.Vector3());
  const len = Math.max(size.x, size.y, size.z) * 0.2;

  const corners = [
    [min.x, min.y, min.z],
    [max.x, min.y, min.z],
    [min.x, max.y, min.z],
    [max.x, max.y, min.z],
    [min.x, min.y, max.z],
    [max.x, min.y, max.z],
    [min.x, max.y, max.z],
    [max.x, max.y, max.z],
  ];

  const dirs = [
    [[1,0,0],[0,1,0],[0,0,1]],
    [[-1,0,0],[0,1,0],[0,0,1]],
    [[1,0,0],[0,-1,0],[0,0,1]],
    [[-1,0,0],[0,-1,0],[0,0,1]],
    [[1,0,0],[0,1,0],[0,0,-1]],
    [[-1,0,0],[0,1,0],[0,0,-1]],
    [[1,0,0],[0,-1,0],[0,0,-1]],
    [[-1,0,0],[0,-1,0],[0,0,-1]],
  ];

  const points = [];
  for (let i = 0; i < 8; i++) {
    const [cx, cy, cz] = corners[i];
    for (const [dx, dy, dz] of dirs[i]) {
      points.push(cx, cy, cz);
      points.push(cx + dx * len, cy + dy * len, cz + dz * len);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0xff8800,
    linewidth: 2,
    transparent: true,
    opacity: 0.8,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.raycast = () => {};
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function createLockLabel(text) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 256;
  canvas.height = 64;

  ctx.clearRect(0, 0, 256, 64);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  roundRect(ctx, 4, 4, 248, 56, 12);
  ctx.fill();

  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ff8800';
  ctx.fillText(text, 128, 32);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2, 0.5, 1);
  sprite.raycast = () => {};
  return sprite;
}

function updateLockOverlayPosition(group, obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  const oldLines = group.children.find(c => c.isLineSegments);
  if (oldLines) {
    group.remove(oldLines);
    oldLines.geometry.dispose();
    oldLines.material.dispose();
  }
  const newLines = createCornerLines(obj);
  group.add(newLines);

  const label = group.children.find(c => c.isSprite);
  if (label) {
    label.position.set(center.x, box.max.y + size.y * 0.3 + 0.5, center.z);
  }
}

function addLockOverlay(objectId, fromInfo) {
  removeLockOverlay(objectId);

  const obj = managedObjects.get(objectId);
  if (!obj) return;

  const group = new THREE.Group();
  group.userData._isLockOverlay = true;
  group.raycast = () => {};

  const cornerLines = createCornerLines(obj);
  group.add(cornerLines);

  const nickname = fromInfo?.nickname || fromInfo?.from?.nickname || '?';
  const label = createLockLabel('🔒 ' + nickname);
  group.add(label);

  updateLockOverlayPosition(group, obj);

  scene.add(group);
  lockOverlays.set(objectId, { group, target: obj });
}

function removeLockOverlay(objectId) {
  const entry = lockOverlays.get(objectId);
  if (!entry) return;

  const { group } = entry;
  scene.remove(group);
  group.traverse(child => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (child.material.map) child.material.map.dispose();
      child.material.dispose();
    }
  });

  lockOverlays.delete(objectId);
}

// ── ロード中オーバーレイ ─────────────────────────────────

// objectId → { group, placeholder }
const loadingOverlays = new Map();

function createLoadingLabel(text) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 512;
  canvas.height = 128;

  ctx.clearRect(0, 0, 512, 128);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
  roundRect(ctx, 4, 4, 504, 120, 16);
  ctx.fill();

  ctx.font = 'bold 30px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#88ccff';
  ctx.fillText('読み込み中…', 256, 38);

  ctx.font = '24px sans-serif';
  ctx.fillStyle = '#ffffff';
  const maxWidth = 480;
  let label = text;
  if (ctx.measureText(label).width > maxWidth) {
    while (label.length > 1 && ctx.measureText(label + '…').width > maxWidth) {
      label = label.slice(0, -1);
    }
    label = label + '…';
  }
  ctx.fillText(label, 256, 86);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(3, 0.75, 1);
  sprite.raycast = () => {};
  return sprite;
}

function createObjectNameLabel(text) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 512;
  canvas.height = 128;

  ctx.clearRect(0, 0, 512, 128);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  roundRect(ctx, 4, 4, 504, 120, 16);
  ctx.fill();

  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';

  const maxWidth = 470;
  let label = text || '';
  if (ctx.measureText(label).width > maxWidth) {
    while (label.length > 1 && ctx.measureText(label + '…').width > maxWidth) {
      label = label.slice(0, -1);
    }
    label = label + '…';
  }
  ctx.fillText(label, 256, 64);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2.4, 0.6, 1);
  sprite.raycast = () => {};
  return sprite;
}

function createLoadingPlaceholder() {
  const group = new THREE.Group();

  const geo = new THREE.BoxGeometry(1, 1, 1);
  const edges = new THREE.EdgesGeometry(geo);
  const mat = new THREE.LineBasicMaterial({
    color: 0x88ccff,
    transparent: true,
    opacity: 0.8,
  });
  const box = new THREE.LineSegments(edges, mat);
  box.raycast = () => {};
  group.add(box);
  geo.dispose();

  return group;
}

function addLoadingOverlay(objectId, name, info) {
  removeLoadingOverlay(objectId);

  const group = new THREE.Group();
  group.userData._isLoadingOverlay = true;
  group.raycast = () => {};

  const placeholder = createLoadingPlaceholder();
  group.add(placeholder);

  const label = createLoadingLabel(name || objectId);
  label.position.set(0, 1.1, 0);
  group.add(label);

  if (info?.position) group.position.fromArray(info.position);

  scene.add(group);
  loadingOverlays.set(objectId, { group, placeholder });
}

function removeLoadingOverlay(objectId) {
  const entry = loadingOverlays.get(objectId);
  if (!entry) return;

  const { group } = entry;
  scene.remove(group);
  group.traverse(child => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (child.material.map) child.material.map.dispose();
      child.material.dispose();
    }
  });

  loadingOverlays.delete(objectId);
}

// ── レイキャスト選択 ─────────────────────────────────────

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function selectManagedObject(obj) {
  if (!obj || !obj.userData.objectId) return;

  if (transformCtrl.object && transformCtrl.object !== obj) {
    broadcast({
      kind: 'scene-unlock',
      objectId: transformCtrl.object.userData.objectId,
    });
  }

  transformCtrl.attach(obj);
  broadcast({ kind: 'scene-lock', objectId: obj.userData.objectId });
  showToolbar();
  updateToolbarActive(transformCtrl.mode);
  updatePeersList();
}

function selectObjectAt(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const targets = Array.from(managedObjects.values());
  const hits = raycaster.intersectObjects(targets, true);
  if (hits.length > 0) {
    let obj = hits[0].object;
    while (obj.parent && !obj.userData.objectId) obj = obj.parent;
    // ロックオーバーレイは除外
    if (obj.userData._isLockOverlay) return;
    if (obj.userData.objectId) {
      // ロック確認
      if (locks.has(obj.userData.objectId)) {
        const lockInfo = locks.get(obj.userData.objectId);
        const who = lockInfo.nickname || lockInfo.from?.nickname || '他のユーザー';
        showToast(`${who} が編集中です`);
        return;
      }
      selectManagedObject(obj);
    }
  } else {
    if (transformCtrl.object) {
      broadcast({
        kind: 'scene-unlock',
        objectId: transformCtrl.object.userData.objectId
      });
    }
    transformCtrl.detach();
    hideToolbar();
    updatePeersList();
  }
}

renderer.domElement.addEventListener('dblclick', (e) => {
  selectObjectAt(e.clientX, e.clientY);
});

// ── タッチ操作（iOS Safari 対応） ───────────────────────

let lastTapTime = 0;
let lastTapX = 0;
let lastTapY = 0;
const DOUBLE_TAP_DELAY = 300;
const DOUBLE_TAP_DISTANCE = 30;
let touchMoved = false;
let singleTapTimer = null;

renderer.domElement.addEventListener('touchstart', (e) => {
  touchMoved = false;
}, { passive: true });

renderer.domElement.addEventListener('touchmove', (e) => {
  touchMoved = true;
}, { passive: true });

function handleDoubleTap(clientX, clientY) {
  selectObjectAt(clientX, clientY);
}

renderer.domElement.addEventListener('touchend', (e) => {
  if (e.touches.length > 0) return;
  const touch = e.changedTouches[0];
  if (!touch) return;

  const now = Date.now();
  const dx = touch.clientX - lastTapX;
  const dy = touch.clientY - lastTapY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  clearTimeout(singleTapTimer);

  if (now - lastTapTime < DOUBLE_TAP_DELAY && dist < DOUBLE_TAP_DISTANCE) {
    // ダブルタップ
    e.preventDefault();
    handleDoubleTap(touch.clientX, touch.clientY);
    lastTapTime = 0;
  } else {
    lastTapTime = now;
    lastTapX = touch.clientX;
    lastTapY = touch.clientY;

    // シングルタップ
    const tapX = touch.clientX;
    const tapY = touch.clientY;
    singleTapTimer = setTimeout(() => {
      if (!touchMoved && transformCtrl.object) {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((tapX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((tapY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const targets = Array.from(managedObjects.values());
        const hits = raycaster.intersectObjects(targets, true);
        if (hits.length === 0) {
          broadcast({
            kind: 'scene-unlock',
            objectId: transformCtrl.object.userData.objectId,
          });
          transformCtrl.detach();
          hideToolbar();
        }
      }
    }, DOUBLE_TAP_DELAY + 50);
  }
}, { passive: false });

// ── 削除ロジック（共通） ──────────────────────────────────

function deleteSelectedObject() {
  const attached = transformCtrl.object;
  if (!attached) return;

  let deleteId = null;
  for (const [id, obj] of managedObjects) {
    if (obj === attached) {
      deleteId = id;
      break;
    }
  }

  transformCtrl.detach();
  hideToolbar();

  if (deleteId) {
    if (locks.has(deleteId)) {
      const lockInfo = locks.get(deleteId);
      const lockOwnerId = lockInfo?.id;
      if (lockOwnerId && lockOwnerId !== presenceState.id) {
        showToast('他のユーザーが編集中です');
        return;
      }
      // 自分のロックなら unlock をブロードキャストして解除
      broadcast({ kind: 'scene-unlock', objectId: deleteId });
    }

    removeLockOverlay(deleteId);
    locks.delete(deleteId);

    scene.remove(attached);
    attached.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });
    managedObjects.delete(deleteId);
    broadcast({ kind: 'scene-remove', objectId: deleteId });
  }
}

// ── モバイルツールバー ──────────────────────────────────

const toolbar = document.getElementById('mobile-toolbar');
const btnMove = document.getElementById('btn-move');
const btnRotate = document.getElementById('btn-rotate');
const btnScale = document.getElementById('btn-scale');
const btnDelete = document.getElementById('btn-delete');
const btnDeselect = document.getElementById('btn-deselect');

function showToolbar() {
  if (toolbar) toolbar.style.display = 'flex';
}

function hideToolbar() {
  if (toolbar) toolbar.style.display = 'none';
}

function updateToolbarActive(mode) {
  [btnMove, btnRotate, btnScale].forEach(b => b?.classList.remove('active'));
  if (mode === 'translate') btnMove?.classList.add('active');
  if (mode === 'rotate') btnRotate?.classList.add('active');
  if (mode === 'scale') btnScale?.classList.add('active');
}

btnMove?.addEventListener('click', () => {
  transformCtrl.setMode('translate');
  updateToolbarActive('translate');
});

btnRotate?.addEventListener('click', () => {
  transformCtrl.setMode('rotate');
  updateToolbarActive('rotate');
});

btnScale?.addEventListener('click', () => {
  transformCtrl.setMode('scale');
  updateToolbarActive('scale');
});

btnDeselect?.addEventListener('click', () => {
  if (transformCtrl.object) {
    broadcast({
      kind: 'scene-unlock',
      objectId: transformCtrl.object.userData.objectId,
    });
  }
  transformCtrl.detach();
  hideToolbar();
});

btnDelete?.addEventListener('click', () => {
  deleteSelectedObject();
});

// ── キーボードショートカット ──────────────────────────────

window.addEventListener('keydown', (e) => {
  // テキスト入力中は無視
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  switch (e.key.toLowerCase()) {
    case 'w': transformCtrl.setMode('translate'); break;
    case 'e': transformCtrl.setMode('rotate'); break;
    case 'r': transformCtrl.setMode('scale'); break;
    case 'escape':
      if (transformCtrl.object) {
        broadcast({
          kind: 'scene-unlock',
          objectId: transformCtrl.object.userData.objectId,
        });
      }
      transformCtrl.detach();
      hideToolbar();
      break;
    case 'delete':
    case 'backspace': {
      e.preventDefault();
      deleteSelectedObject();
      break;
    }
  }
});

// ── リサイズ ─────────────────────────────────────────────

function onResize() {
  if (xrState.active) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

window.addEventListener('resize', onResize);
// iOS Safari はキーボード閉鎖時に window.resize が発火しないため
// visualViewport.resize でも監視して canvas サイズを確実に復元する
window.visualViewport?.addEventListener('resize', onResize);

// ── レンダリングループ ────────────────────────────────────

renderer.setAnimationLoop(() => {
  if (!xrState.active) {
    orbit.update();
  }

  for (const [objectId, entry] of lockOverlays) {
    if (entry.target && entry.group) {
      updateLockOverlayPosition(entry.group, entry.target);
    }
  }

  for (const [objectId, entry] of loadingOverlays) {
    if (entry.placeholder) {
      entry.placeholder.rotation.y += 0.02;
    }
  }

  if (xrState.active) {
    updateXrGrab();
  }

  renderer.render(scene, camera);
});

// ── Presence 接続 ────────────────────────────────────────

const statusEl = document.getElementById('status');
const dotEl = statusEl.querySelector('.dot');
const nicknameLabel = document.getElementById('nickname-label');
const nicknameChip = document.getElementById('nickname-chip');
const roomSectionEl = document.getElementById('room-section');

function resolvePresenceUrl() {
  const params = new URLSearchParams(location.search);
  const override = params.get('presence');
  if (override) return override;
  const isLocal = location.hostname === 'localhost'
                 || location.hostname === '127.0.0.1';
  return isLocal ? 'ws://localhost:8787' : 'wss://afjk.jp/presence';
}

function sanitizeRoomCode(s) {
  if (!s) return null;
  const cleaned = String(s).trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
  return cleaned || null;
}

function randomRoomCode() {
  return Math.random().toString(36).slice(2, 8);
}

function loadInitialNickname() {
  const nameParam = new URLSearchParams(location.search).get('name');
  if (nameParam) return nameParam.slice(0, 40);
  const stored = localStorage.getItem('pipe.deviceName');
  if (stored) return stored;
  return 'User-' + Math.random().toString(36).slice(2, 6);
}

// ── 参加者一覧 ──────────────────────────────────────────

const peersListEl = document.getElementById('peers-list');

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderPeerItem(name, isSelf, editingObjectId) {
  const dotClass = isSelf ? 'peer-dot self' : 'peer-dot';
  const editLabel = editingObjectId ? '✏️' : '';
  const selfLabel = isSelf ? ' (自分)' : '';
  return `<div class="peer-item">`
    + `<span class="${dotClass}"></span>`
    + `<span class="peer-name">${escapeHtml(name)}${selfLabel}</span>`
    + `${editLabel ? `<span class="peer-editing">${editLabel}</span>` : ''}`
    + `</div>`;
}

function updatePeersList() {
  if (!peersListEl) return;

  const editingMap = new Map();
  for (const [objectId, owner] of locks) {
    const ownerId = owner.id || owner;
    editingMap.set(ownerId, objectId);
  }

  let html = '';

  const selfEditing = transformCtrl.object
    ? transformCtrl.object.userData.objectId || ''
    : '';
  html += renderPeerItem(presenceState.nickname || '自分', true, selfEditing);

  for (const peer of presenceState.peers) {
    if (peer.id === presenceState.id) continue;
    const editing = editingMap.get(peer.id) || '';
    html += renderPeerItem(peer.nickname || peer.device || '?', false, editing);
  }

  peersListEl.innerHTML = html;
}

const presenceState = {
  ws: null,
  id: null,
  room: null,
  nickname: loadInitialNickname(),
  peers: [],
};

let activeRoomCode = sanitizeRoomCode(new URLSearchParams(location.search).get('room'));
let sceneReceived = false;
let sceneRequestTimer = null;
let sceneRequestAttempt = 0;
let reconnectTimer = null;

// ── ニックネーム編集 ───────────────────────────────────

function updateNicknameLabel() {
  if (nicknameLabel) nicknameLabel.textContent = presenceState.nickname;
}

function editNickname() {
  const next = prompt('表示名を入力してください', presenceState.nickname) || '';
  const cleaned = next.trim().slice(0, 40);
  if (!cleaned || cleaned === presenceState.nickname) return;
  presenceState.nickname = cleaned;
  localStorage.setItem('pipe.deviceName', cleaned);
  updateNicknameLabel();
  updatePeersList();
  // 接続中なら hello を再送して即時反映
  const ws = presenceState.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'hello',
      nickname: cleaned,
      device: navigator.userAgent.slice(0, 60),
    }));
  }
}

// ── ルーム制御 ────────────────────────────────────────

function roomShareUrl(code) {
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('room', code);
  return u.toString();
}

function pipeUrlForRoom(code) {
  const u = new URL('/pipe/', location.href);
  if (code) u.searchParams.set('room', code);
  return u.toString();
}

function resetSceneState() {
  for (const [objectId, obj] of [...managedObjects]) {
    if (objectId === 'sample-cube') continue;
    removeLoadingOverlay(objectId);
    removeLockOverlay(objectId);
    locks.delete(objectId);
    if (transformCtrl.object === obj) transformCtrl.detach();
    scene.remove(obj);
    obj.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        else child.material.dispose();
      }
    });
    managedObjects.delete(objectId);
  }
  hideToolbar();
  presenceState.peers = [];
  sceneReceived = false;
  sceneRequestAttempt = 0;
  clearTimeout(sceneRequestTimer);
  updatePeersList();
}

function reconnectPresence() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (presenceState.ws) {
    const old = presenceState.ws;
    presenceState.ws = null; // intentional close — onclose will skip reconnect
    try { old.close(); } catch {}
  }
  resetSceneState();
  connectPresence();
  renderRoomSection();
}

function applyRoomCode(code) {
  const cleaned = sanitizeRoomCode(code);
  if (!cleaned) return;
  activeRoomCode = cleaned;
  const u = new URL(location.href);
  u.searchParams.set('room', cleaned);
  history.replaceState(null, '', u.toString());
  reconnectPresence();
}

function generateRoom() {
  applyRoomCode(randomRoomCode());
}

function joinRoom(code) {
  applyRoomCode(code);
}

function clearRoom() {
  activeRoomCode = null;
  const u = new URL(location.href);
  u.searchParams.delete('room');
  history.replaceState(null, '', u.toString());
  reconnectPresence();
}

function copyRoomUrl() {
  if (!activeRoomCode) return;
  navigator.clipboard.writeText(roomShareUrl(activeRoomCode))
    .then(() => showToast('URL をコピーしました'))
    .catch(() => showToast('コピーに失敗しました'));
}

function renderRoomSection() {
  if (!roomSectionEl) return;
  roomSectionEl.innerHTML = '';

  if (activeRoomCode) {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.innerHTML = `🏠 <span id="room-code">${escapeHtml(activeRoomCode)}</span>`;
    chip.title = 'ルームコード';
    roomSectionEl.appendChild(chip);

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'chip';
    copyBtn.textContent = 'URL コピー';
    copyBtn.title = 'ルーム URL をコピー';
    copyBtn.addEventListener('click', copyRoomUrl);
    roomSectionEl.appendChild(copyBtn);

    const pipeLink = document.createElement('a');
    pipeLink.className = 'chip';
    pipeLink.href = pipeUrlForRoom(activeRoomCode);
    pipeLink.textContent = '📥 pipe';
    pipeLink.title = '同じルームを pipe で開く';
    roomSectionEl.appendChild(pipeLink);

    const leaveBtn = document.createElement('button');
    leaveBtn.type = 'button';
    leaveBtn.className = 'chip danger';
    leaveBtn.textContent = '退場';
    leaveBtn.addEventListener('click', clearRoom);
    roomSectionEl.appendChild(leaveBtn);
  } else {
    const noRoomChip = document.createElement('div');
    noRoomChip.className = 'chip';
    noRoomChip.innerHTML = '🏠 <span style="opacity:0.6">未設定</span>';
    roomSectionEl.appendChild(noRoomChip);

    const genBtn = document.createElement('button');
    genBtn.type = 'button';
    genBtn.className = 'chip primary';
    genBtn.textContent = '作成';
    genBtn.title = '新しいルームを作成';
    genBtn.addEventListener('click', generateRoom);
    roomSectionEl.appendChild(genBtn);

    const pipeLink = document.createElement('a');
    pipeLink.className = 'chip';
    pipeLink.href = pipeUrlForRoom(null);
    pipeLink.textContent = '📥 pipe';
    pipeLink.title = 'pipe を開く';
    roomSectionEl.appendChild(pipeLink);

    const joinGroup = document.createElement('div');
    joinGroup.className = 'join-group';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'room-input';
    input.placeholder = 'コードを入力';
    input.maxLength = 24;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinRoom(input.value);
    });
    joinGroup.appendChild(input);

    const joinBtn = document.createElement('button');
    joinBtn.type = 'button';
    joinBtn.className = 'chip';
    joinBtn.textContent = '参加';
    joinBtn.addEventListener('click', () => joinRoom(input.value));
    joinGroup.appendChild(joinBtn);

    roomSectionEl.appendChild(joinGroup);
  }
}

function connectPresence() {
  const base = resolvePresenceUrl();
  const url = activeRoomCode
    ? `${base}/?room=${encodeURIComponent(activeRoomCode)}`
    : base;

  const ws = new WebSocket(url);
  presenceState.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'hello',
      nickname: presenceState.nickname,
      device: navigator.userAgent.slice(0, 60),
    }));
  };

  ws.onmessage = (e) => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }

    switch (data.type) {
      case 'welcome':
        presenceState.id = data.id;
        presenceState.room = data.room;
        updateStatus(true);
        updatePeersList();
        break;

      case 'peers': {
        const isFirstPeers = presenceState.peers.length === 0
          && (data.peers || []).length > 0;
        presenceState.peers = data.peers || [];
        updateStatus(true);
        // 切断したピアのロックを解除
        const peerIds = new Set(data.peers.map(p => p.id));
        for (const [objId, ownerInfo] of locks) {
          const ownerId = ownerInfo?.id || ownerInfo;
          if (!peerIds.has(ownerId) && ownerId !== presenceState.id) {
            locks.delete(objId);
            removeLockOverlay(objId);
          }
        }
        updatePeersList();
        // 初回 peers 受信時にシーンリクエスト
        if (isFirstPeers && !sceneReceived) {
          requestSceneFromPeer();
        }
        break;
      }

      case 'handoff':
        handleHandoff(data);
        break;
    }
  };

  ws.onclose = () => {
    // 意図的な切断（ルーム切替）では presenceState.ws が先に null になる
    if (presenceState.ws !== ws) return;
    presenceState.ws = null;
    updateStatus(false);
    updatePeersList();
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (presenceState.ws) return;
      sceneReceived = false;
      sceneRequestAttempt = 0;
      clearTimeout(sceneRequestTimer);
      connectPresence();
    }, 3000);
  };

  ws.onerror = () => {
    try { ws.close(); } catch {}
  };
}

function updateStatus(connected) {
  if (connected) {
    const n = presenceState.peers.length;
    dotEl.className = 'dot on';
    statusEl.innerHTML = `<span class="dot on"></span>${escapeHtml(presenceState.nickname)} · ${escapeHtml(presenceState.room || '—')} · ${n} peer${n !== 1 ? 's' : ''}`;
  } else {
    dotEl.className = 'dot off';
    statusEl.innerHTML = '<span class="dot off"></span>再接続中…';
  }
}

// ── シーンリクエスト（後から参加したクライアント用） ───────

function requestSceneFromPeer() {
  const peers = presenceState.peers.filter(p => p.id !== presenceState.id);
  if (peers.length === 0) {
    sceneReceived = true;
    return;
  }

  if (sceneRequestAttempt >= peers.length) {
    console.warn('[SceneSync] All peers failed to respond');
    sceneReceived = true;
    return;
  }

  const target = peers[sceneRequestAttempt];
  console.log('[SceneSync] Requesting scene from:', target.nickname || target.id);

  const ws = presenceState.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'handoff',
      targetId: target.id,
      payload: { kind: 'scene-request' },
    }));
  }

  clearTimeout(sceneRequestTimer);
  sceneRequestTimer = setTimeout(() => {
    if (!sceneReceived) {
      sceneRequestAttempt++;
      requestSceneFromPeer();
    }
  }, 5000);
}

// ── シーン応答（後から参加したクライアント用） ─────────────

const gltfExporter = new GLTFExporter();

function exportObjectAsGlb(obj) {
  return new Promise((resolve, reject) => {
    const overlayChildren = [];
    obj.traverse(child => {
      if (child.userData._isLockOverlay) {
        overlayChildren.push(child);
      }
    });
    overlayChildren.forEach(c => { c.visible = false; });

    gltfExporter.parse(
      obj,
      (result) => {
        overlayChildren.forEach(c => { c.visible = true; });
        resolve(result);
      },
      (err) => {
        overlayChildren.forEach(c => { c.visible = true; });
        reject(err);
      },
      { binary: true }
    );
  });
}

async function respondToSceneRequest(from) {
  console.log('[SceneSync] Responding to scene-request from:',
    from?.nickname || from?.id);

  const objects = {};

  for (const [objectId, obj] of managedObjects) {
    const entry = {
      name: obj.userData.name || obj.name || objectId,
      position: obj.position.toArray(),
      rotation: obj.quaternion.toArray(),
      scale: obj.scale.toArray(),
    };

    // 保存済み meshPath を再利用（再エクスポート不要）
    if (obj.userData.meshPath) {
      entry.meshPath = obj.userData.meshPath;
    }
    if (obj.userData.asset) {
      entry.asset = structuredClone(obj.userData.asset);
    }

    objects[objectId] = entry;
  }

  const ws = presenceState.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'handoff',
      targetId: from.id,
      payload: { kind: 'scene-state', envId: currentEnvId, objects },
    }));
  }
}

// ── Handoff 受信（Scene Sync 用） ────────────────────────

function handleHandoff(data) {
  const payload = data.payload;
  if (!payload || !payload.kind) return;

  switch (payload.kind) {
    case 'scene-state': {
      sceneReceived = true;
      clearTimeout(sceneRequestTimer);
      if (payload.envId) {
        loadEnvironment(payload.envId);
      }
      const objects = payload.objects || {};
      for (const [objectId, info] of Object.entries(objects)) {
        addOrUpdateObject(objectId, info);
      }
      break;
    }
    case 'scene-request': {
      respondToSceneRequest(data.from);
      break;
    }
    case 'scene-delta': {
      if (data.from.id === presenceState.id) break; // 自分の echo は無視
      const obj = managedObjects.get(payload.objectId);
      if (!obj) break;
      if (payload.position) obj.position.fromArray(payload.position);
      if (payload.rotation) obj.quaternion.fromArray(payload.rotation);
      if (payload.scale) obj.scale.fromArray(payload.scale);
      break;
    }
    case 'scene-add': {
      addOrUpdateObject(payload.objectId, payload);
      break;
    }
    case 'scene-remove': {
      const objectId = payload.objectId;
      removeLockOverlay(objectId);
      locks.delete(objectId);
      const obj = managedObjects.get(objectId);
      if (obj) {
        if (transformCtrl.object === obj) { transformCtrl.detach(); hideToolbar(); }
        scene.remove(obj);
        managedObjects.delete(objectId);
      }
      break;
    }
    case 'scene-mesh': {
      const obj = managedObjects.get(payload.objectId);
      const url = BLOB_BASE + '/' + payload.meshPath;
      const loadingName = obj?.userData?.name || payload.meshPath;
      const loadingInfo = obj ? {
        position: obj.position.toArray(),
        rotation: obj.quaternion.toArray(),
        scale: obj.scale.toArray(),
      } : null;
      addLoadingOverlay(payload.objectId, loadingName, loadingInfo);
      gltfLoader.load(url, (gltf) => {
        removeLoadingOverlay(payload.objectId);
        const model = new THREE.Group();
        model.userData.objectId = payload.objectId;
        model.userData.meshPath = payload.meshPath;
        attachImportedGlb(model, gltf);

        if (obj) {
          // 位置・回転・スケールを引き継ぐ
          model.position.copy(obj.position);
          model.quaternion.copy(obj.quaternion);
          model.scale.copy(obj.scale);
          if (transformCtrl.object === obj) transformCtrl.detach();
          scene.remove(obj);
        }
        scene.add(model);
        managedObjects.set(payload.objectId, model);
      }, undefined, (err) => {
        removeLoadingOverlay(payload.objectId);
        // glB ロード失敗時のフォールバック
        console.warn('Failed to load mesh:', err);
        // 既存オブジェクトがあれば使用し続ける、なければ Box を生成
        if (!obj) {
          const geo = new THREE.BoxGeometry(1, 1, 1);
          const mat = new THREE.MeshStandardMaterial({ color: 0xff4444 });
          const fallback = new THREE.Mesh(geo, mat);
          fallback.userData.objectId = payload.objectId;
          scene.add(fallback);
          managedObjects.set(payload.objectId, fallback);
        }
      });
      break;
    }
    case 'scene-lock': {
      locks.set(payload.objectId, data.from);
      addLockOverlay(payload.objectId, data.from);
      updatePeersList();
      break;
    }
    case 'scene-unlock': {
      locks.delete(payload.objectId);
      removeLockOverlay(payload.objectId);
      updatePeersList();
      break;
    }
    case 'scene-env': {
      if (payload.envId) {
        loadEnvironment(payload.envId);
      }
      break;
    }
    default:
      break;
  }
}

// ── シーン同期ヘルパー ───────────────────────────────────

function addOrUpdateObject(objectId, info) {
  const existing = managedObjects.get(objectId);
  const asset = info.asset;

  if (asset) {
    switch (asset.type) {
      case 'primitive':
        replaceManagedObject(objectId, buildPrimitiveObject(objectId, info, asset), info);
        return;
      case 'mesh':
        if (asset.meshPath) {
          loadMeshObject(objectId, info, asset.meshPath, existing);
          return;
        }
        break;
      default:
        console.warn(`unsupported asset type: ${asset.type}`);
        replaceManagedObject(objectId, buildUnsupportedAssetObject(objectId, info), info);
        return;
    }
  }

  if (info.meshPath) {
    loadMeshObject(objectId, info, info.meshPath, existing);
    return;
  }

  if (!existing) {
    replaceManagedObject(objectId, buildDefaultBoxObject(objectId, info), info);
    return;
  }

  existing.userData.name = info.name;
  applyTransform(existing, info);
}

function loadMeshObject(objectId, info, meshPath, existing) {
  addLoadingOverlay(objectId, info.name || objectId, info);
  const url = BLOB_BASE + '/' + meshPath;
  gltfLoader.load(url, (gltf) => {
    removeLoadingOverlay(objectId);

    const model = new THREE.Group();
    model.userData.objectId = objectId;
    model.userData.name = info.name;
    model.userData.meshPath = meshPath;
    if (info.asset) model.userData.asset = structuredClone(info.asset);
    attachImportedGlb(model, gltf);

    replaceManagedObject(objectId, model, info);
  }, undefined, (err) => {
    removeLoadingOverlay(objectId);
    console.warn('Failed to load mesh for', objectId, ':', err);
    if (!existing) {
      replaceManagedObject(objectId, buildDefaultBoxObject(objectId, info, 0xff4444), info);
    }
  });
}

function replaceManagedObject(objectId, nextObject, info) {
  const current = managedObjects.get(objectId);
  if (current) {
    if (transformCtrl.object === current) transformCtrl.detach();
    scene.remove(current);
  }

  nextObject.userData.objectId = objectId;
  nextObject.userData.name = info.name;
  applyTransform(nextObject, info);
  scene.add(nextObject);
  managedObjects.set(objectId, nextObject);
}

function buildDefaultBoxObject(objectId, info, color = 0x4488ff) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({ color });
  const object = new THREE.Mesh(geometry, material);
  object.userData.objectId = objectId;
  object.userData.name = info.name;
  return object;
}

function buildPrimitiveObject(objectId, info, asset) {
  let geometry;
  switch (asset?.primitive) {
    case 'sphere':
      geometry = new THREE.SphereGeometry(0.5, 32, 32);
      break;
    case 'cylinder':
      geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 32);
      break;
    case 'cone':
      geometry = new THREE.ConeGeometry(0.5, 1, 32);
      break;
    case 'plane':
      geometry = new THREE.PlaneGeometry(1, 1);
      break;
    case 'torus':
      geometry = new THREE.TorusGeometry(0.4, 0.15, 16, 48);
      break;
    case 'box':
    default:
      geometry = new THREE.BoxGeometry(1, 1, 1);
      break;
  }

  const material = new THREE.MeshStandardMaterial({
    color: asset?.color || '#888888',
  });
  const object = new THREE.Mesh(geometry, material);
  object.userData.objectId = objectId;
  object.userData.name = info.name;
  object.userData.asset = structuredClone(asset);
  return object;
}

function buildUnsupportedAssetObject(objectId, info) {
  const group = new THREE.Group();
  const mesh = buildDefaultBoxObject(objectId, info, 0x888888);
  group.add(mesh);

  const label = createObjectNameLabel(info.name || objectId);
  label.position.set(0, 1.1, 0);
  group.add(label);

  group.userData.objectId = objectId;
  group.userData.name = info.name;
  if (info.asset) group.userData.asset = structuredClone(info.asset);
  return group;
}

function applyTransform(obj, info) {
  if (info.position) obj.position.fromArray(info.position);
  if (info.rotation) obj.quaternion.fromArray(info.rotation);
  if (info.scale) obj.scale.fromArray(info.scale);
}

function attachImportedGlb(wrapper, gltf) {
  // glB 経路だけ handedness 補正と wire の Z 反転が重なり、
  // 見た目が Y 軸 180° ずれるため、読み込み基底に補正を入れる。
  gltf.scene.rotateY(Math.PI);
  wrapper.add(gltf.scene);
}

// ── broadcast 送信ヘルパー（次 Step 以降で使用） ─────────

function broadcast(payload) {
  const ws = presenceState.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'broadcast', payload }));
}

// ── 公開 API（scene.js 内から利用） ──────────────────────

export { scene, camera, renderer, managedObjects, broadcast, presenceState };

// ── ファイル追加 UI ──────────────────────────────────────

const addBtn = document.getElementById('add-btn');
const fileInput = document.getElementById('file-input');
const dropOverlay = document.getElementById('drop-overlay');

addBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleAddMeshFile(file);
  fileInput.value = '';
});

let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  dropOverlay.classList.add('active');
});

document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dropOverlay.classList.remove('active');
  }
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove('active');
  const file = e.dataTransfer.files[0];
  if (file && (file.name.endsWith('.glb') || file.name.endsWith('.gltf'))) {
    handleAddMeshFile(file);
  }
});

function generateObjectId() {
  return 'web-' + Math.random().toString(36).slice(2, 10);
}

function generateRandomPath() {
  return Math.random().toString(36).slice(2, 10);
}

async function handleAddMeshFile(file) {
  const objectId = generateObjectId();

  // カメラ前方 5m を配置予定位置として先にローディング表示
  const placeDir = new THREE.Vector3();
  camera.getWorldDirection(placeDir);
  const placePos = new THREE.Vector3()
    .copy(camera.position)
    .addScaledVector(placeDir, 5);
  placePos.y = 0;
  addLoadingOverlay(objectId, file.name, { position: placePos.toArray() });

  const arrayBuffer = await file.arrayBuffer();

  const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });
  const blobUrl = URL.createObjectURL(blob);

  gltfLoader.load(blobUrl, async (gltf) => {
    removeLoadingOverlay(objectId);
    const model = new THREE.Group();
    model.userData.objectId = objectId;
    model.userData.name = file.name;
    attachImportedGlb(model, gltf);

    // center offset は行わない（glB の原点をそのまま使用）
    // Unity 側との座標整合性を保つため

    model.position.copy(placePos);

    scene.add(model);
    managedObjects.set(objectId, model);
    selectManagedObject(model);

    URL.revokeObjectURL(blobUrl);

    // 元ファイルをそのままアップロード（受信側で中心合わせを行う）
    uploadAndBroadcast(
      objectId,
      file.name,
      model,
      arrayBuffer
    );
  }, undefined, (err) => {
    removeLoadingOverlay(objectId);
    console.error('Failed to load glB:', err);
    URL.revokeObjectURL(blobUrl);
  });
}

async function uploadAndBroadcast(objectId, name, model, arrayBuffer) {
  // blob store に POST（1回だけ）
  const meshPath = generateRandomPath();
  try {
    await fetch(BLOB_BASE + '/' + meshPath, {
      method: 'POST',
      headers: { 'Content-Type': 'model/gltf-binary' },
      body: arrayBuffer,
    });
  } catch (err) {
    console.warn('POST failed:', err);
    broadcast({
      kind: 'scene-add',
      objectId,
      name,
      position: model.position.toArray(),
      rotation: model.quaternion.toArray(),
      scale: model.scale.toArray(),
      meshPath: null,
    });
    return;
  }

  // meshPath をオブジェクトに保存（respondToSceneRequest で再利用）
  model.userData.meshPath = meshPath;

  broadcast({
    kind: 'scene-add',
    objectId,
    name,
    position: model.position.toArray(),
    rotation: model.quaternion.toArray(),
    scale: model.scale.toArray(),
    meshPath,
  });
}

// ── 3面ビュー撮影 ────────────────────────────────────────

async function captureThreeViews() {
  const W = 800;
  const H = 600;

  // 現在の状態を保存
  const savedPosition = camera.position.clone();
  const savedQuaternion = camera.quaternion.clone();
  const savedAspect = camera.aspect;
  const savedWidth = renderer.domElement.width;
  const savedHeight = renderer.domElement.height;
  const orbitWasEnabled = orbit.enabled;

  // OrbitControls を無効化
  orbit.enabled = false;

  // TransformControls のギズモを非表示
  const tcHelper = transformCtrl.getHelper();
  const tcWasVisible = tcHelper.visible;
  tcHelper.visible = false;

  // レンダラーサイズを一時変更
  renderer.setSize(W, H, false);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();

  // シーン全体のバウンディングボックスを計算
  const bounds = new THREE.Box3();
  for (const obj of managedObjects.values()) {
    bounds.expandByObject(obj);
  }

  let center = new THREE.Vector3(0, 0, 0);
  let distance = 25;

  if (!bounds.isEmpty()) {
    bounds.getCenter(center);
    const size = bounds.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    distance = Math.max(maxDim * 1.5, 5);
  }

  const views = [
    { label: 'Front', pos: new THREE.Vector3(center.x, center.y + distance * 0.2, center.z + distance) },
    { label: 'Top',   pos: new THREE.Vector3(center.x, center.y + distance, center.z + 0.001) },
    { label: 'Side',  pos: new THREE.Vector3(center.x + distance, center.y + distance * 0.2, center.z) },
  ];

  const dataURLs = [];

  for (const view of views) {
    camera.position.copy(view.pos);
    camera.lookAt(center);
    renderer.render(scene, camera);
    dataURLs.push(renderer.domElement.toDataURL('image/png'));
  }

  // カメラ・レンダラーを元に戻す
  camera.position.copy(savedPosition);
  camera.quaternion.copy(savedQuaternion);
  camera.aspect = savedAspect;
  camera.updateProjectionMatrix();
  renderer.setSize(savedWidth / devicePixelRatio, savedHeight / devicePixelRatio, false);
  renderer.setSize(innerWidth, innerHeight);
  orbit.enabled = orbitWasEnabled;
  tcHelper.visible = tcWasVisible;

  // 3枚の画像を読み込んで横並びの Canvas に描画
  const images = await Promise.all(dataURLs.map(url => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  })));

  const totalW = W * 3;
  const labelH = 36;
  const totalH = H + labelH;

  const compositeCanvas = document.createElement('canvas');
  compositeCanvas.width = totalW;
  compositeCanvas.height = totalH;
  const ctx = compositeCanvas.getContext('2d');

  ctx.fillStyle = '#222222';
  ctx.fillRect(0, 0, totalW, totalH);

  for (let i = 0; i < 3; i++) {
    ctx.drawImage(images[i], W * i, 0, W, H);

    // ラベル描画
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(W * i, H, W, labelH);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(views[i].label, W * i + W / 2, H + labelH / 2);
  }

  // クリップボードにコピー
  try {
    const blob = await new Promise(resolve => compositeCanvas.toBlob(resolve, 'image/png'));
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob }),
    ]);
    showToast('3面ビューをコピーしました');
  } catch {
    // フォールバック: ダウンロード
    const a = document.createElement('a');
    a.href = compositeCanvas.toDataURL('image/png');
    a.download = 'three-views.png';
    a.click();
    showToast('3面ビューをダウンロードしました');
  }
}

document.getElementById('screenshot-btn')?.addEventListener('click', captureThreeViews);

// ── 起動 ─────────────────────────────────────────────────

nicknameChip?.addEventListener('click', editNickname);
updateNicknameLabel();
renderRoomSection();
connectPresence();
loadEnvironment('outdoor_day');
