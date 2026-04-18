```markdown
# fix-unity-mesh-sync-bugs.md

## 概要

2つのバグを修正する:
1. Unity から送信した Mesh が Web で赤い Cube になる
2. Web で追加したモデルを Unity で選択すると赤い Cube に変わる

## 原因分析

### 問題 1: Unity からの Mesh が Web で赤い Cube

`SendSceneAdd` で `Broadcast(payload)` を先に実行し、`UploadGlb` を後から
fire-and-forget で実行している。Web 側は `scene-add` 受信直後に
`BLOB_BASE + '/' + meshPath` に GET するが、アップロードが未完了のため
404 が返り、フォールバックの赤い Cube になる。

該当コード（SceneSyncWindow.cs `SendSceneAdd`）:
```csharp
await _client.Broadcast(payload);   // ← Web が即座に meshPath を GET しに行く
if (glb != null && path != null)
    _ = PresenceClient.UploadGlb(glb, GetBlobUrl(), path);  // ← まだ完了していない
```

### 問題 2: Web 由来モデルが Unity 選択時に赤い Cube に変わる

`OnHierarchyChanged` は全ルートオブジェクトを `go.GetInstanceID().ToString()`
（数値の文字列）で走査し、`_knownObjectIds` に含まれないものを新規と判定して
`SendSceneAdd` を呼ぶ。

しかし Web 由来オブジェクトは `_knownObjectIds` に `"web-xxxxx"` で登録されている。
Unity が生成した GameObject の InstanceID は数値であり、`"web-xxxxx"` とは一致しない。
結果として同じオブジェクトが「新規」として再検出され、`SendSceneAdd` が発火する。

さらに `SendSceneAdd` が `ExportGameObjectAsGlb` + `Broadcast` + `UploadGlb` の
レースコンディションを再び引き起こし、Web 側で赤い Cube が表示される。

## 対象ファイル

- `unity/com.afjk.scene-sync/Editor/SceneSyncWindow.cs`

## 修正内容

### 修正 1: SendSceneAdd – アップロード完了後に Broadcast する

変更前:

```csharp
private async System.Threading.Tasks.Task SendSceneAdd(GameObject go)
{
    var pos = go.transform.position;
    var rot = go.transform.rotation;
    var scl = go.transform.localScale;

    byte[] glb = null;
    string path = null;
    if (go.GetComponentInChildren<MeshFilter>() != null
        || go.GetComponentInChildren<SkinnedMeshRenderer>() != null)
    {
        glb = await PresenceClient.ExportGameObjectAsGlb(go);
        if (glb != null)
            path = PresenceClient.GenerateRandomPath();
    }

    var meshPathJson = path != null ? ",\"meshPath\":\"" + path + "\"" : "";
    var payload = "{\"kind\":\"scene-add\",\"objectId\":\"" + go.GetInstanceID() + "\",\"name\":\"" + go.name + "\"" +
        ",\"position\":[" + pos.x + "," + pos.y + "," + (-pos.z) + "]" +
        ",\"rotation\":[" + (-rot.x) + "," + (-rot.y) + "," + rot.z + "," + rot.w + "]" +
        ",\"scale\":[" + scl.x + "," + scl.y + "," + scl.z + "]" +
        meshPathJson + "}";
    await _client.Broadcast(payload);

    if (glb != null && path != null)
    {
        _meshPaths[go.GetInstanceID().ToString()] = path;
        _ = PresenceClient.UploadGlb(glb, GetBlobUrl(), path);
    }
}
```

変更後:

```csharp
private async System.Threading.Tasks.Task SendSceneAdd(GameObject go)
{
    var pos = go.transform.position;
    var rot = go.transform.rotation;
    var scl = go.transform.localScale;

    byte[] glb = null;
    string path = null;
    if (go.GetComponentInChildren<MeshFilter>() != null
        || go.GetComponentInChildren<SkinnedMeshRenderer>() != null)
    {
        glb = await PresenceClient.ExportGameObjectAsGlb(go);
        if (glb != null)
            path = PresenceClient.GenerateRandomPath();
    }

    // アップロードを先に完了させてから Broadcast する
    if (glb != null && path != null)
    {
        _meshPaths[go.GetInstanceID().ToString()] = path;
        await PresenceClient.UploadGlb(glb, GetBlobUrl(), path);
    }

    var meshPathJson = path != null ? ",\"meshPath\":\"" + path + "\"" : "";
    var payload = "{\"kind\":\"scene-add\",\"objectId\":\"" + go.GetInstanceID() + "\",\"name\":\"" + go.name + "\"" +
        ",\"position\":[" + pos.x + "," + pos.y + "," + (-pos.z) + "]" +
        ",\"rotation\":[" + (-rot.x) + "," + (-rot.y) + "," + rot.z + "," + rot.w + "]" +
        ",\"scale\":[" + scl.x + "," + scl.y + "," + scl.z + "]" +
        meshPathJson + "}";
    await _client.Broadcast(payload);
}
```

### 修正 2: SyncAllMeshes – 同様にアップロード完了後に Broadcast する

変更前:

```csharp
var payload = "{\"kind\":\"scene-mesh\",\"objectId\":\"" + objectId + "\",\"meshPath\":\"" + path + "\"}";
await _client.Broadcast(payload);
_ = PresenceClient.UploadGlb(glb, GetBlobUrl(), path);
```

変更後:

```csharp
var payload = "{\"kind\":\"scene-mesh\",\"objectId\":\"" + objectId + "\",\"meshPath\":\"" + path + "\"}";
_meshPaths[objectId] = path;
await PresenceClient.UploadGlb(glb, GetBlobUrl(), path);
await _client.Broadcast(payload);
```

### 修正 3: HandleSceneRequest – 同様にアップロード完了後に SendHandoff する

変更前（HandleSceneRequest 末尾）:

```csharp
    // handoff で 1対1 返信（broadcast ではない）
    var payload = "{\"kind\":\"scene-state\",\"objects\":" + objectsJson + "}";
    await _client.SendHandoff(fromId, payload);

    // アップロード
    foreach (var (glb, path) in pendingUploads)
        _ = PresenceClient.UploadGlb(glb, GetBlobUrl(), path);
```

変更後:

```csharp
    // アップロードを先に完了させる
    foreach (var (glb, path) in pendingUploads)
        await PresenceClient.UploadGlb(glb, GetBlobUrl(), path);

    // handoff で 1対1 返信（broadcast ではない）
    var payload = "{\"kind\":\"scene-state\",\"objects\":" + objectsJson + "}";
    await _client.SendHandoff(fromId, payload);
```

### 修正 4: OnHierarchyChanged – Web 由来オブジェクトを新規と誤検出しない

Web 由来オブジェクトの Unity InstanceID を `_knownObjectIds` に登録する
逆引き Dictionary を追加する。

フィールド宣言に追加:

```csharp
// Unity InstanceID → 元の objectId（Web由来の "web-xxxxx" など）
private Dictionary<int, string> _instanceToObjectId = new Dictionary<int, string>();
```

`DownloadAndCreateObject` でオブジェクト生成後に登録:

```csharp
if (success)
{
    var go = new GameObject(name);
    await gltf.InstantiateMainSceneAsync(go.transform);
    ApplyTransform(go, position, rotation, scale);
    _managedObjects[objectId] = go;
    _knownObjectIds.Add(objectId);
    _instanceToObjectId[go.GetInstanceID()] = objectId;
    Debug.Log("[SceneSync] Imported mesh: " + name);
}
else
{
    // ... fallback Cube ...
    _managedObjects[objectId] = fallback;
    _knownObjectIds.Add(objectId);
    _instanceToObjectId[fallback.GetInstanceID()] = objectId;
}
```

meshPath なしの Cube 作成時（`HandleSceneAdd` 内）も同様:

```csharp
var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
go.name = name;
ApplyTransform(go, position, rotation, scale);
_managedObjects[objectId] = go;
_knownObjectIds.Add(objectId);
_instanceToObjectId[go.GetInstanceID()] = objectId;
```

`OnHierarchyChanged` を修正:

変更前:

```csharp
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
```

変更後:

```csharp
private void OnHierarchyChanged()
{
    if (!_connected) return;
    var currentIds = new HashSet<string>();
    var currentInstanceIds = new HashSet<int>();
    var rootObjects = UnityEngine.SceneManagement.SceneManager
        .GetActiveScene().GetRootGameObjects();

    foreach (var go in rootObjects)
    {
        if (go.hideFlags != HideFlags.None) continue;
        var instanceId = go.GetInstanceID();
        currentInstanceIds.Add(instanceId);

        // Web 由来オブジェクトかチェック
        if (_instanceToObjectId.TryGetValue(instanceId, out var originalId))
        {
            // Web 由来: 元の objectId で管理
            currentIds.Add(originalId);
        }
        else
        {
            // Unity 由来: InstanceID を objectId として管理
            var id = instanceId.ToString();
            currentIds.Add(id);

            if (!_knownObjectIds.Contains(id))
            {
                // 新規オブジェクト
                _ = SendSceneAdd(go);
            }
        }
    }

    // 削除されたオブジェクト
    foreach (var id in _knownObjectIds)
    {
        if (!currentIds.Contains(id))
        {
            _ = SendSceneRemove(id);
            _meshPaths.Remove(id);
            _locks.Remove(id);
        }
    }

    // _instanceToObjectId のクリーンアップ（削除された GameObject を除去）
    var staleInstances = new List<int>();
    foreach (var kvp in _instanceToObjectId)
    {
        if (!currentInstanceIds.Contains(kvp.Key))
            staleInstances.Add(kvp.Key);
    }
    foreach (var key in staleInstances)
        _instanceToObjectId.Remove(key);

    _knownObjectIds = currentIds;
}
```

### 修正 5: HandleSceneRemove で _instanceToObjectId もクリーンアップ

```csharp
private void HandleSceneRemove(string raw)
{
    var objectIdMatch = System.Text.RegularExpressions.Regex.Match(
        raw, "\"objectId\":\"([^\"]+)\"");
    if (!objectIdMatch.Success) return;
    var objectId = objectIdMatch.Groups[1].Value;

    var go = FindManagedObject(objectId);
    if (go != null)
    {
        _instanceToObjectId.Remove(go.GetInstanceID());
        DestroyImmediate(go);
        _managedObjects.Remove(objectId);
        _knownObjectIds.Remove(objectId);
    }
    _meshPaths.Remove(objectId);
    _locks.Remove(objectId);
}
```

### 修正 6: EditorUpdate の scene-lock/unlock で Web 由来 objectId を使う

現在 `EditorUpdate` は `selection.GetInstanceID().ToString()` でロックを送信するが、
Web 由来オブジェクトの場合は `"web-xxxxx"` を使う必要がある。

変更前:

```csharp
var selectionId = selection != null ? selection.GetInstanceID().ToString() : null;
```

変更後:

```csharp
string selectionId = null;
if (selection != null)
{
    if (_instanceToObjectId.TryGetValue(selection.GetInstanceID(), out var origId))
        selectionId = origId;
    else
        selectionId = selection.GetInstanceID().ToString();
}
```

同様に scene-delta 送信部分の `id` も修正:

変更前:

```csharp
var id = selection.GetInstanceID().ToString();
```

変更後:

```csharp
string id;
if (_instanceToObjectId.TryGetValue(selection.GetInstanceID(), out var origDeltaId))
    id = origDeltaId;
else
    id = selection.GetInstanceID().ToString();
```

## 修正箇所まとめ

| # | 箇所 | 問題 | 修正 |
|---|---|---|---|
| 1 | `SendSceneAdd` | Upload 前に Broadcast → 404 | Upload を await してから Broadcast |
| 2 | `SyncAllMeshes` | 同上 | Upload を await してから Broadcast |
| 3 | `HandleSceneRequest` | 同上 | Upload を await してから SendHandoff |
| 4 | `OnHierarchyChanged` | Web 由来を新規と誤検出 | `_instanceToObjectId` で逆引き |
| 5 | `HandleSceneRemove` | `_instanceToObjectId` 未クリーンアップ | 削除時に除去 |
| 6 | `EditorUpdate` | lock/delta で InstanceID を使用 | Web 由来は元の objectId を使用 |

## 確認手順

### 問題 1 の確認（Unity → Web のメッシュ同期）
1. Unity でオブジェクトをシーンに追加する（Cube, Sphere 等）
2. Web ブラウザで同じルームに接続する
3. Web でオブジェクトがメッシュ付きで表示される（赤い Cube ではない）ことを確認する

### 問題 2 の確認（Web 由来モデルの選択）
1. Web ブラウザで glB を追加する
2. Unity で同じルームに接続する
3. Unity にモデルが表示されることを確認する
4. Unity でそのモデルを Hierarchy からクリックして選択する
5. Web 側で赤い Cube にならず、元のモデルのままであることを確認する
6. Unity でモデルを移動し、Web で正しく追従することを確認する

### 追加確認
7. Unity でモデルを削除し、Web から消えることを確認する
8. Web でモデルを削除し、Unity から消えることを確認する
9. 3クライアント以上で接続し、全員のシーンが一致することを確認する

## 完了条件

- [ ] `SendSceneAdd` で Upload が Broadcast より前に完了する
- [ ] `SyncAllMeshes` で Upload が Broadcast より前に完了する
- [ ] `HandleSceneRequest` で Upload が SendHandoff より前に完了する
- [ ] `_instanceToObjectId` が追加されている
- [ ] `OnHierarchyChanged` で Web 由来オブジェクトを新規と誤検出しない
- [ ] `HandleSceneRemove` で `_instanceToObjectId` がクリーンアップされる
- [ ] `EditorUpdate` で Web 由来オブジェクトの objectId が正しく使われる
- [ ] Unity から追加したオブジェクトが Web でメッシュ付きで表示される
- [ ] Web から追加したオブジェクトを Unity で選択しても赤い Cube にならない
- [ ] Web 由来オブジェクトの移動が Web 側で正しく追従する
- [ ] 削除の双方向同期が正しく動作する
```
