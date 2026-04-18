# Step 9: メッシュ変更時の glB 再配信

## 目的

Unity でオブジェクトのジオメトリ（メッシュ形状）が変更された場合に、
glB を再エクスポートして piping-server 経由で全クライアントに配信する。

---

## 検知タイミング

メッシュ変更はリアルタイム検知が難しいため、以下の方式を採る。

### 方式: 手動トリガー

SceneSyncWindow に「Sync Meshes」ボタンを追加し、
押下時に全オブジェクトの glB を再エクスポートして配信する。

    if (GUILayout.Button("Sync Meshes"))
    {
        _ = SyncAllMeshes();
    }

将来的に自動検知（MeshFilter.sharedMesh のハッシュ比較）を追加可能。

---

## 処理フロー

    1. ユーザーが「Sync Meshes」ボタンを押す
    2. 全オブジェクトの glB を再エクスポート
    3. piping-server に PUT
    4. scene-mesh を broadcast（objectId + meshPath）
    5. 受信側が piping-server から GET して glB を差し替え

---

## piping-server の 1対1 制限への対応

piping-server は 1 PUT : 1 GET の制約がある。
受信者が複数いる場合、受信者ごとに別パスで PUT する。

    private async Task SyncAllMeshes()
    {
        var rootObjects = GetSyncTargetObjects();
        var peerCount = _client.Peers.Count;

        foreach (var go in rootObjects)
        {
            var glb = await ExportGameObjectAsGlb(go);
            if (glb == null) continue;

            var objectId = go.GetInstanceID().ToString();

            // 受信者ごとにパスを分けて PUT
            foreach (var peer in _client.Peers)
            {
                var meshPath = await UploadGlb(glb, "https://pipe.afjk.jp");
                // 個別 handoff で meshPath を通知
                var payload = $"{{\"kind\":\"scene-mesh\",\"objectId\":\"{objectId}\",\"meshPath\":\"{meshPath}\"}}";
                await _client.SendHandoff(peer.id, payload);
            }
        }
    }

---

## ブラウザ側の実装（scene.js に追加）

### scene-mesh 受信

handleHandoff 内に追加:

    case 'scene-mesh': {
      const obj = managedObjects.get(payload.objectId);
      const url = `${PIPING_BASE}/${payload.meshPath}`;
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
      });
      break;
    }

---

## 動作確認

### 1. Unity とブラウザを接続、初回同期済み
### 2. Unity でオブジェクトのメッシュを変更（例: Cube → Sphere に差し替え）
### 3. SceneSyncWindow の「Sync Meshes」ボタンを押す
### 4. ブラウザで新しいメッシュ形状が表示される

---

## 完了条件

- [ ] 「Sync Meshes」ボタンが SceneSyncWindow に追加されている
- [ ] ボタン押下で全オブジェクトの glB が再エクスポートされる
- [ ] 受信者ごとに別パスで piping-server に PUT される
- [ ] scene-mesh handoff で各受信者にパスが通知される
- [ ] ブラウザが glB を GET してメッシュを差し替える
- [ ] 差し替え時に位置・回転・スケールが引き継がれる
