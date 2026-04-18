# Step 8: オブジェクト追加・削除の同期

## 目的

どのクライアントからオブジェクトを追加・削除しても、
全クライアントに伝播する。

---

## Unity 側: オブジェクト追加の検知と送信

### Hierarchy 変更の検知

EditorApplication.hierarchyChanged イベントを使用する。

    EditorApplication.hierarchyChanged += OnHierarchyChanged;

    private HashSet<string> _knownObjectIds = new HashSet<string>();

    private void OnHierarchyChanged()
    {
        if (!_connected) return;
        var currentIds = new HashSet<string>();
        var rootObjects = UnityEngine.SceneManagement.SceneManager
            .GetActiveScene().GetRootGameObjects();

        foreach (var go in rootObjects)
        {
            if (go.hideFlags != HideFlags.None) continue;
            var id = go.GetInstanceID().ToString();
            currentIds.Add(id);

            if (!_knownObjectIds.Contains(id))
            {
                // 新規オブジェクト
                _ = SendSceneAdd(go);
            }
        }

        // 削除されたオブジェクト
        foreach (var id in _knownObjectIds)
        {
            if (!currentIds.Contains(id))
            {
                _ = SendSceneRemove(id);
            }
        }

        _knownObjectIds = currentIds;
    }

### scene-add 送信

    private async Task SendSceneAdd(GameObject go)
    {
        var pos = go.transform.position;
        var rot = go.transform.rotation;
        var scl = go.transform.localScale;

        string meshPath = null;
        // メッシュがあれば glB エクスポート & アップロード（Step 5 と同じ）

        var payload = new {
            kind = "scene-add",
            objectId = go.GetInstanceID().ToString(),
            name = go.name,
            position = new[] { pos.x, pos.y, -pos.z },
            rotation = new[] { -rot.x, -rot.y, rot.z, rot.w },
            scale = new[] { scl.x, scl.y, scl.z },
            meshPath = meshPath
        };
        await _client.Broadcast(JsonUtility.ToJson(payload));
    }

### scene-remove 送信

    private async Task SendSceneRemove(string objectId)
    {
        var payload = $"{{\"kind\":\"scene-remove\",\"objectId\":\"{objectId}\"}}";
        await _client.Broadcast(payload);
    }

---

## ブラウザ側の実装（scene.js に追加）

### scene-add 受信

handleHandoff 内に追加:

    case 'scene-add': {
      addOrUpdateObject(payload.objectId, payload);
      break;
    }

addOrUpdateObject は Step 5 で実装済み。

### scene-remove 受信

    case 'scene-remove': {
      const obj = managedObjects.get(payload.objectId);
      if (obj) {
        if (transformCtrl.object === obj) transformCtrl.detach();
        scene.remove(obj);
        managedObjects.delete(payload.objectId);
      }
      break;
    }

### ブラウザからの削除（任意）

選択中のオブジェクトを Delete キーで削除:

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' && transformCtrl.object) {
        const obj = transformCtrl.object;
        const objectId = obj.userData.objectId;
        transformCtrl.detach();
        scene.remove(obj);
        managedObjects.delete(objectId);
        broadcast({ kind: 'scene-remove', objectId });
      }
    });

---

## Unity 受信側の処理

### scene-add 受信

新規 GameObject を生成するか、glB を piping-server から GET してインポートする。

### scene-remove 受信

objectId に対応する GameObject を Hierarchy から削除する。

---

## 動作確認

### 1. Unity とブラウザを同じルームに接続
### 2. Unity で新しい Cube を作成 → ブラウザに表示される
### 3. Unity でオブジェクトを削除 → ブラウザからも消える
### 4. ブラウザで Delete キー → Unity からも消える

---

## 完了条件

- [ ] Unity でオブジェクト追加 → 全クライアントに scene-add が配信される
- [ ] Unity でオブジェクト削除 → 全クライアントに scene-remove が配信される
- [ ] ブラウザが scene-add を受信してオブジェクトを生成できる
- [ ] ブラウザが scene-remove を受信してオブジェクトを削除できる
- [ ] ブラウザからの Delete キー削除が Unity に伝播する
