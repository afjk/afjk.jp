// ── scene.js ─────────────────────────────────────────────
// Three.js ビューア + presence-server 接続
// ─────────────────────────────────────────────────────────
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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

// ライト
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(5, 10, 7);
scene.add(dirLight);

// グリッド
scene.add(new THREE.GridHelper(20, 20, 0x444444, 0x333333));

// glB ローダー
const gltfLoader = new GLTFLoader();
const BLOB_BASE = location.hostname === 'localhost'
  ? 'http://localhost:8787/blob'
  : 'https://afjk.jp/presence/blob';

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

// ── レイキャスト選択 ─────────────────────────────────────

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

renderer.domElement.addEventListener('dblclick', (e) => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const targets = Array.from(managedObjects.values());
  const hits = raycaster.intersectObjects(targets, true);
  if (hits.length > 0) {
    let obj = hits[0].object;
    while (obj.parent && !obj.userData.objectId) obj = obj.parent;
    if (obj.userData.objectId) {
      // ロック確認
      if (locks.has(obj.userData.objectId)) {
        const lockInfo = locks.get(obj.userData.objectId);
        const who = lockInfo.nickname || lockInfo.from?.nickname || '他のユーザー';
        showToast(`${who} が編集中です`);
        return;
      }
      transformCtrl.attach(obj);
      broadcast({ kind: 'scene-lock', objectId: obj.userData.objectId });
      showToolbar();
      updateToolbarActive(transformCtrl.mode);
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
  }
});

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
      showToast('他のユーザーが編集中です');
      return;
    }

    removeLockOverlay(deleteId);

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

window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ── レンダリングループ ────────────────────────────────────

function animate() {
  requestAnimationFrame(animate);
  orbit.update();

  for (const [objectId, entry] of lockOverlays) {
    if (entry.target && entry.group) {
      updateLockOverlayPosition(entry.group, entry.target);
    }
  }

  renderer.render(scene, camera);
}
animate();

// ── Presence 接続 ────────────────────────────────────────

const statusEl = document.getElementById('status');
const dotEl = statusEl.querySelector('.dot');

function resolvePresenceUrl() {
  const params = new URLSearchParams(location.search);
  const override = params.get('presence');
  if (override) return override;
  const isLocal = location.hostname === 'localhost'
                 || location.hostname === '127.0.0.1';
  return isLocal ? 'ws://localhost:8787' : 'wss://afjk.jp/presence';
}

function resolveRoom() {
  return new URLSearchParams(location.search).get('room') || null;
}

const presenceState = {
  ws: null,
  id: null,
  room: null,
  peers: [],
};

function connectPresence() {
  const base = resolvePresenceUrl();
  const room = resolveRoom();
  const url = room ? `${base}/?room=${room}` : base;

  const ws = new WebSocket(url);
  presenceState.ws = ws;

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'hello',
      nickname: 'SceneViewer',
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
        broadcast({ kind: 'scene-request' });
        break;

      case 'peers':
        presenceState.peers = data.peers || [];
        updateStatus(true);
        // 切断したピアのロックを解除
        const peerIds = new Set(data.peers.map(p => p.id));
        for (const [objId, ownerId] of locks) {
          if (!peerIds.has(ownerId) && ownerId !== presenceState.id) {
            locks.delete(objId);
          }
        }
        break;

      case 'handoff':
        handleHandoff(data);
        break;
    }
  };

  ws.onclose = () => {
    updateStatus(false);
    setTimeout(() => {
      connectPresence();
      // 再接続後に scene-request を送信して状態を再同期
      if (presenceState.room) {
        broadcast({ kind: 'scene-request' });
      }
    }, 3000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

function updateStatus(connected) {
  if (connected) {
    const n = presenceState.peers.length;
    dotEl.className = 'dot on';
    statusEl.innerHTML = `<span class="dot on"></span>${presenceState.room || '—'} · ${n} peer${n !== 1 ? 's' : ''}`;
  } else {
    dotEl.className = 'dot off';
    statusEl.innerHTML = '<span class="dot off"></span>再接続中…';
  }
}

// ── Handoff 受信（Scene Sync 用） ────────────────────────

function handleHandoff(data) {
  const payload = data.payload;
  if (!payload || !payload.kind) return;

  switch (payload.kind) {
    case 'scene-state': {
      const objects = payload.objects || {};
      for (const [objectId, info] of Object.entries(objects)) {
        addOrUpdateObject(objectId, info);
      }
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
      const obj = managedObjects.get(payload.objectId);
      if (obj) {
        if (transformCtrl.object === obj) transformCtrl.detach();
        scene.remove(obj);
        managedObjects.delete(payload.objectId);
      }
      break;
    }
    case 'scene-mesh': {
      const obj = managedObjects.get(payload.objectId);
      const url = BLOB_BASE + '/' + payload.meshPath;
      gltfLoader.load(url, (gltf) => {
        const model = gltf.scene;
        model.userData.objectId = payload.objectId;
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
        // glB ロード失敗時のフォールバック
        console.warn('Failed to load mesh:', err);
        // 既存オブジェクトがあれば使用し続ける、なければ Box を生成
        if (!obj) {
          const geo = new THREE.BoxGeometry(1, 1, 1);
          const mat = new THREE.MeshStandardMaterial({ color: 0xff4444 }); // 赤色でエラーを示す
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
      break;
    }
    case 'scene-unlock': {
      locks.delete(payload.objectId);
      removeLockOverlay(payload.objectId);
      break;
    }
    default:
      break;
  }
}

// ── シーン同期ヘルパー ───────────────────────────────────

function addOrUpdateObject(objectId, info) {
  let obj = managedObjects.get(objectId);

  if (info.meshPath) {
    const url = BLOB_BASE + '/' + info.meshPath;
    gltfLoader.load(url, (gltf) => {
      if (obj) scene.remove(obj);
      const model = gltf.scene;
      model.userData.objectId = objectId;
      model.userData.name = info.name;
      applyTransform(model, info);
      scene.add(model);
      managedObjects.set(objectId, model);
    }, undefined, (err) => {
      // glB ロード失敗時のフォールバック
      console.warn('Failed to load mesh for', objectId, ':', err);
      if (!obj) {
        const geo = new THREE.BoxGeometry(1, 1, 1);
        const mat = new THREE.MeshStandardMaterial({ color: 0xff4444 }); // 赤色
        obj = new THREE.Mesh(geo, mat);
        obj.userData.objectId = objectId;
        obj.userData.name = info.name;
        applyTransform(obj, info);
        scene.add(obj);
        managedObjects.set(objectId, obj);
      }
    });
  } else {
    if (!obj) {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const mat = new THREE.MeshStandardMaterial({ color: 0x4488ff });
      obj = new THREE.Mesh(geo, mat);
      obj.userData.objectId = objectId;
      obj.userData.name = info.name;
      scene.add(obj);
      managedObjects.set(objectId, obj);
    }
    applyTransform(obj, info);
  }
}

function applyTransform(obj, info) {
  if (info.position) obj.position.fromArray(info.position);
  if (info.rotation) obj.quaternion.fromArray(info.rotation);
  if (info.scale) obj.scale.fromArray(info.scale);
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
  const arrayBuffer = await file.arrayBuffer();

  const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });
  const blobUrl = URL.createObjectURL(blob);

  gltfLoader.load(blobUrl, (gltf) => {
    const model = gltf.scene;
    model.userData.objectId = objectId;
    model.userData.name = file.name;

    // バウンディングボックスでモデルの中心を算出
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());

    // 子メッシュをオフセットして中心を原点に揃える
    model.children.forEach(child => {
      child.position.sub(center);
    });

    // カメラ前方 5m に配置
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    model.position.copy(camera.position).addScaledVector(dir, 5);
    model.position.y = 0;

    scene.add(model);
    managedObjects.set(objectId, model);

    URL.revokeObjectURL(blobUrl);

    uploadAndBroadcast(objectId, file.name, model, arrayBuffer);
  }, undefined, (err) => {
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
    // エラー時も meshPath: null で broadcast（フォールバック）
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

  // 全クライアントに broadcast（meshPath 付き）
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

// ── 起動 ─────────────────────────────────────────────────

connectPresence();
