# Step 3: Webビューア（Three.js）雛形

## 目的

Three.js による 3D ビューアページを作成し、presence-server のルームに接続する。
この Step ではシーン同期はまだ行わない。以下が動くことをゴールとする。

- Three.js のシーン（グリッド・ライト・サンプル Cube）が表示される
- presence-server に WebSocket 接続し、ルームに参加できる
- 右上にルーム接続状態（接続中 / ピア数）が表示される
- ダブルクリックでオブジェクト選択 → TransformControls で操作できる
- W / E / R キーでモード切り替え（移動 / 回転 / スケール）

---

## 作成ファイル

| ファイル | 内容 |
|---------|------|
| `html/pipe/scene.html` | ビューアページ HTML |
| `html/assets/js/pipe/scene.js` | シーン描画 + presence 接続ロジック |

---

## html/pipe/scene.html

以下の内容で作成する。

    <!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Scene Sync — afjk.jp</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { overflow: hidden; background: #222; }
        canvas { display: block; }
        #status {
          position: fixed;
          top: 12px;
          right: 12px;
          padding: 6px 14px;
          border-radius: 6px;
          font: 13px/1.4 monospace;
          color: #fff;
          background: rgba(0,0,0,0.55);
          backdrop-filter: blur(6px);
          z-index: 10;
          user-select: none;
        }
        #status .dot {
          display: inline-block;
          width: 8px; height: 8px;
          border-radius: 50%;
          margin-right: 6px;
          vertical-align: middle;
        }
        #status .dot.on  { background: #4f4; }
        #status .dot.off { background: #f44; }
        #mode {
          position: fixed;
          bottom: 12px;
          left: 50%;
          transform: translateX(-50%);
          padding: 6px 14px;
          border-radius: 6px;
          font: 13px/1.4 monospace;
          color: #aaa;
          background: rgba(0,0,0,0.45);
          z-index: 10;
          user-select: none;
        }
      </style>
    </head>
    <body>
      <div id="status"><span class="dot off"></span>接続中…</div>
      <div id="mode">W: 移動 &nbsp; E: 回転 &nbsp; R: スケール</div>
      <script type="importmap">
      {
        "imports": {
          "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
          "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"
        }
      }
      </script>
      <script type="module" src="/assets/js/pipe/scene.js"></script>
    </body>
    </html>

---

## html/assets/js/pipe/scene.js

以下の内容で作成する。

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

    // ── コントロール ─────────────────────────────────────────

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.1;

    const transformCtrl = new TransformControls(camera, renderer.domElement);
    scene.add(transformCtrl);

    transformCtrl.addEventListener('dragging-changed', (e) => {
      orbit.enabled = !e.value;
    });

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
          transformCtrl.attach(obj);
        }
      } else {
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
            break;

          case 'peers':
            presenceState.peers = data.peers || [];
            updateStatus(true);
            break;

          case 'handoff':
            handleHandoff(data);
            break;
        }
      };

      ws.onclose = () => {
        updateStatus(false);
        setTimeout(connectPresence, 3000);
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

    // ── Handoff 受信（Scene Sync 用、次 Step 以降で実装） ────

    function handleHandoff(data) {
      const payload = data.payload;
      if (!payload || !payload.kind) return;

      switch (payload.kind) {
        // 次の Step で scene-state, scene-delta 等を実装
        default:
          break;
      }
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

---

## 動作確認

### 1. ローカル起動

    docker compose -f docker-compose.yml -f docker-compose.local.yml up -d

### 2. ブラウザでアクセス

    http://localhost:8888/pipe/scene.html?room=test

### 3. 確認項目

- [ ] Three.js のシーンが表示される（グリッド + 青い Cube）
- [ ] OrbitControls でカメラ操作できる（マウスドラッグ / スクロール）
- [ ] Cube をダブルクリックすると TransformControls が表示される
- [ ] W / E / R キーで移動 / 回転 / スケールモードが切り替わる
- [ ] Escape キーで選択解除される
- [ ] 右上に接続状態バッジが表示される（緑ドット + ルーム名 + ピア数）
- [ ] ブラウザの開発者ツール Console にエラーがない
- [ ] 別タブで同じ URL を開くとピア数が増える

### 4. 本番確認（デプロイ後）

    https://afjk.jp/pipe/scene.html?room=test

---

## 完了条件

- [ ] `html/pipe/scene.html` が作成されている
- [ ] `html/assets/js/pipe/scene.js` が作成されている
- [ ] Three.js シーンが表示される
- [ ] presence-server に接続しルーム参加できる
- [ ] TransformControls でオブジェクト操作できる
- [ ] 接続状態バッジが正しく表示される
