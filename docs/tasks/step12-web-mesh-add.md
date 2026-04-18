# Step 12: Web 側からメッシュ（glB）を追加

## 目的

ブラウザの scene.html からローカルの glB / glTF ファイルを追加し、
全クライアント（Unity / 他ブラウザ）に同期する。

---

## UI

scene.html に以下を追加する。最小限の UI でシンプルに保つ。

- 左下に「＋」ボタン（ファイル選択トリガー）
- ドラッグ＆ドロップでも追加可能
- 隠し input[type=file] を使用（accept=".glb,.gltf"）

### HTML 追加（scene.html の body 内、#mode の前）

    <button id="add-btn" title="glB / glTF を追加">＋</button>
    <input type="file" id="file-input" accept=".glb,.gltf" style="display:none">
    <div id="drop-overlay">ドロップして追加</div>

### CSS 追加（scene.html の style 内）

    #add-btn {
      position: fixed;
      bottom: 12px;
      right: 12px;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      border: none;
      background: rgba(68, 136, 255, 0.8);
      color: #fff;
      font-size: 24px;
      cursor: pointer;
      z-index: 10;
      backdrop-filter: blur(6px);
      user-select: none;
    }
    #add-btn:hover {
      background: rgba(68, 136, 255, 1);
    }
    #drop-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(68, 136, 255, 0.15);
      border: 3px dashed rgba(68, 136, 255, 0.6);
      z-index: 100;
      font: 24px/1 monospace;
      color: #fff;
      justify-content: center;
      align-items: center;
    }
    #drop-overlay.active {
      display: flex;
    }

---

## JS 実装（scene.js に追加）

### ファイル選択 & ドラッグ＆ドロップ

    // ── ファイル追加 UI ──────────────────────────────────────

    const addBtn = document.getElementById('add-btn');
    const fileInput = document.getElementById('file-input');
    const dropOverlay = document.getElementById('drop-overlay');

    addBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleAddMeshFile(file);
      fileInput.value = ''; // 同じファイルを再選択可能にする
    });

    // ドラッグ＆ドロップ
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

### メッシュ追加処理

    function generateObjectId() {
      return 'web-' + Math.random().toString(36).slice(2, 10);
    }

    function generateRandomPath() {
      return Math.random().toString(36).slice(2, 10);
    }

    async function handleAddMeshFile(file) {
      const objectId = generateObjectId();
      const arrayBuffer = await file.arrayBuffer();

      // 1. ローカルに即座に表示
      const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });
      const blobUrl = URL.createObjectURL(blob);

      gltfLoader.load(blobUrl, (gltf) => {
        const model = gltf.scene;
        model.userData.objectId = objectId;
        model.userData.name = file.name;

        // カメラの前方に配置
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        model.position.copy(camera.position).add(dir.multiplyScalar(3));
        model.position.y = 0; // 地面に置く

        scene.add(model);
        managedObjects.set(objectId, model);

        URL.revokeObjectURL(blobUrl);

        // 2. piping-server に PUT して全員に通知
        uploadAndBroadcast(objectId, file.name, model, arrayBuffer);
      }, undefined, (err) => {
        console.error('Failed to load glB:', err);
        URL.revokeObjectURL(blobUrl);
      });
    }

    async function uploadAndBroadcast(objectId, name, model, arrayBuffer) {
      // peers の数だけ PUT する（piping-server は 1:1）
      const peers = presenceState.peers;
      if (peers.length === 0) {
        // peers がいなくても scene-add は broadcast しておく（後から来る人用）
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

      // 各 peer に個別パスで PUT & handoff
      const ws = presenceState.ws;
      for (const peer of peers) {
        const meshPath = generateRandomPath();
        try {
          await fetch(PIPING_BASE + '/' + meshPath, {
            method: 'PUT',
            headers: { 'Content-Type': 'model/gltf-binary' },
            body: arrayBuffer,
          });
        } catch (err) {
          console.warn('PUT failed for peer', peer.id, err);
          continue;
        }

        // 個別 handoff で meshPath を通知
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'handoff',
            targetId: peer.id,
            payload: {
              kind: 'scene-add',
              objectId,
              name,
              position: model.position.toArray(),
              rotation: model.quaternion.toArray(),
              scale: model.scale.toArray(),
              meshPath,
            },
          }));
        }
      }
    }

---

## 受信側の処理

既に scene.js の handleHandoff 内に scene-add の処理が実装済み。
meshPath がある場合は piping-server から GET して glB をロード、
ない場合は Box フォールバック。変更不要。

Unity 側も同様。scene-add を受信して meshPath があれば glB を GET する。
現時点では Unity の glB インポートが未実装（ExportGameObjectAsGlb が TODO）のため、
Unity 側は Transform 情報のみ反映される。

---

## piping-server の PUT タイミングに関する注意

piping-server は PUT 側が先に接続し、GET 側が後から来るのを待つ動作。
受信側が scene-add handoff を受け取って GET する前に PUT が完了している必要がある。

PUT は fetch で即座に開始され、受信側は handoff メッセージ到着後に GET するため、
通常は PUT → handoff 到着 → GET の順序になり問題ない。

ただし大きいファイルの場合、PUT の完了前に GET が来る可能性がある。
piping-server はこのケースでもストリーミングで対応するため、問題ない。

---

## 動作確認

### 1. ブラウザで scene.html?room=test を開く
### 2. 「＋」ボタンをクリックして .glb ファイルを選択
### 3. ローカルにモデルが表示される
### 4. 別のブラウザ（同じルーム）にもモデルが表示される
### 5. ドラッグ＆ドロップでも追加できる
### 6. Unity（同じルーム）にも scene-add が届く

---

## 完了条件

- [ ] 「＋」ボタンが scene.html に追加されている
- [ ] クリックでファイル選択ダイアログが開く（.glb / .gltf のみ）
- [ ] ドラッグ＆ドロップで glB を追加できる
- [ ] ローカルに即座にモデルが表示される
- [ ] piping-server 経由で他クライアントに glB が配信される
- [ ] scene-add handoff で他クライアントにオブジェクト情報が通知される
- [ ] 受信側でモデルが表示される
