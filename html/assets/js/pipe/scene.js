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
const PIPING_BASE = location.hostname === 'localhost'
  ? 'http://localhost:8080'
  : 'https://pipe.afjk.jp';

// ── コントロール ─────────────────────────────────────────

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.1;

const transformCtrl = new TransformControls(camera, renderer.domElement);
scene.add(transformCtrl);

let isDragging = false;
let dragIntervalId = null;

transformCtrl.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !e.value;
  isDragging = e.value;

  if (isDragging) {
    dragIntervalId = setInterval(() => {
      sendSelectedDelta();
    }, 50); // 20fps スロットリング
  } else {
    clearInterval(dragIntervalId);
    dragIntervalId = null;
    sendSelectedDelta(); // 最終値を確実に送信
  }
});

function sendSelectedDelta() {
  const obj = transformCtrl.object;
  if (!obj || !obj.userData.objectId) return;

  broadcast({
    kind: 'scene-delta',
    objectId: obj.userData.objectId,
    position: obj.position.toArray(),
    rotation: obj.quaternion.toArray(),
    scale: obj.scale.toArray(),
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
      if (locks.has(obj.userData.objectId)
          && locks.get(obj.userData.objectId) !== presenceState.id) {
        // 他者がロック中 → 選択不可
        return;
      }
      transformCtrl.attach(obj);
      broadcast({ kind: 'scene-lock', objectId: obj.userData.objectId });
    }
  } else {
    if (transformCtrl.object) {
      broadcast({
        kind: 'scene-unlock',
        objectId: transformCtrl.object.userData.objectId
      });
    }
    transformCtrl.detach();
  }
});

// ── キーボードショートカット ──────────────────────────────

window.addEventListener('keydown', (e) => {
  switch (e.key.toLowerCase()) {
    case 'w': transformCtrl.setMode('translate'); break;
    case 'e': transformCtrl.setMode('rotate'); break;
    case 'r': transformCtrl.setMode('scale'); break;
    case 'escape': transformCtrl.detach(); break;
    case 'delete':
      if (transformCtrl.object) {
        const obj = transformCtrl.object;
        const objectId = obj.userData.objectId;
        transformCtrl.detach();
        scene.remove(obj);
        managedObjects.delete(objectId);
        broadcast({ kind: 'scene-remove', objectId });
      }
      break;
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
      const url = PIPING_BASE + '/' + payload.meshPath;
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
      locks.set(payload.objectId, data.from.id);
      break;
    }
    case 'scene-unlock': {
      locks.delete(payload.objectId);
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
    const url = PIPING_BASE + '/' + info.meshPath;
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

// ── 起動 ─────────────────────────────────────────────────

connectPresence();
