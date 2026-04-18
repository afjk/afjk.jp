# Fix: Web → Unity 同期の不具合修正

## 概要

ブラウザから送信された scene-add / scene-delta がUnityに反映されない問題を修正する。

## 問題一覧

| # | 内容 | 重要度 |
|---|------|--------|
| 1 | `FindManagedObject` が Web 由来の objectId (`web-xxxxx`) を `int.Parse` してエラー | 高 |
| 2 | `HandleSceneAdd` が空実装で Web からのオブジェクト追加が無視される | 高 |
| 3 | `HandleSceneMesh` が空実装で Web からのメッシュ更新が無視される | 中 |

---

## 修正 1: FindManagedObject の int.Parse エラー

### 対象ファイル

`unity/com.afjk.scene-sync/Editor/SceneSyncWindow.cs`

### 変更前

```csharp
private GameObject FindManagedObject(string objectId)
{
    if (_managedObjects.TryGetValue(objectId, out var go))
        return go;

    var id = int.Parse(objectId);
    var rootObjects = UnityEngine.SceneManagement.SceneManager
        .GetActiveScene().GetRootGameObjects();

    foreach (var root in rootObjects)
    {
        if (root.GetInstanceID() == id)
        {
            _managedObjects[objectId] = root;
            return root;
        }
    }

    return null;
}
```

### 変更後

```csharp
private GameObject FindManagedObject(string objectId)
{
    if (_managedObjects.TryGetValue(objectId, out var go))
    {
        if (go != null) return go;
        _managedObjects.Remove(objectId);
    }

    // Unity 由来の objectId は数値（InstanceID）
    if (int.TryParse(objectId, out var id))
    {
        var rootObjects = UnityEngine.SceneManagement.SceneManager
            .GetActiveScene().GetRootGameObjects();

        foreach (var root in rootObjects)
        {
            if (root.GetInstanceID() == id)
            {
                _managedObjects[objectId] = root;
                return root;
            }
        }
    }

    // Web 由来の objectId ("web-xxxxx") は _managedObjects にのみ存在
    return null;
}
```

### ポイント

- `int.Parse` → `int.TryParse` に変更し、数値でない場合はスキップ
- 破棄済み GameObject の参照をクリーンアップ

---

## 修正 2: HandleSceneAdd の実装

### 変更前

```csharp
private void HandleSceneAdd(string raw)
{
    // ブラウザが受信した場合の処理
    // Unity 受信は簡略化（GameObject 生成は複雑なため省略）
}
```

### 変更後

```csharp
private void HandleSceneAdd(string raw)
{
    var objectIdMatch = System.Text.RegularExpressions.Regex.Match(
        raw, "\"objectId\":\"([^\"]+)\"");
    if (!objectIdMatch.Success) return;
    var objectId = objectIdMatch.Groups[1].Value;

    // 既に存在する場合はスキップ
    if (_managedObjects.ContainsKey(objectId)) return;

    var nameMatch = System.Text.RegularExpressions.Regex.Match(
        raw, "\"name\":\"([^\"]+)\"");
    var name = nameMatch.Success ? nameMatch.Groups[1].Value : objectId;

    float[] position = ExtractArray(raw, "\"position\":");
    float[] rotation = ExtractArray(raw, "\"rotation\":");
    float[] scale = ExtractArray(raw, "\"scale\":");

    var meshPathMatch = System.Text.RegularExpressions.Regex.Match(
        raw, "\"meshPath\":\"([^\"]+)\"");
    var meshPath = meshPathMatch.Success ? meshPathMatch.Groups[1].Value : null;

    // メッシュがある場合は glB をダウンロードしてインポート
    if (!string.IsNullOrEmpty(meshPath))
    {
        _ = DownloadAndCreateObject(objectId, name, meshPath, position, rotation, scale);
    }
    else
    {
        // メッシュなしの場合はプレースホルダーの Cube を作成
        var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
        go.name = name;
        ApplyTransform(go, position, rotation, scale);
        _managedObjects[objectId] = go;
        _knownObjectIds.Add(objectId);
    }
}

private void ApplyTransform(GameObject go, float[] position, float[] rotation, float[] scale)
{
    // Wire 形式（Three.js 座標系）→ Unity 座標系
    if (position != null && position.Length >= 3)
        go.transform.position = new Vector3(position[0], position[1], -position[2]);

    if (rotation != null && rotation.Length >= 4)
        go.transform.rotation = new Quaternion(-rotation[0], -rotation[1], rotation[2], rotation[3]);

    if (scale != null && scale.Length >= 3)
        go.transform.localScale = new Vector3(scale[0], scale[1], scale[2]);
}

private async System.Threading.Tasks.Task DownloadAndCreateObject(
    string objectId, string name, string meshPath,
    float[] position, float[] rotation, float[] scale)
{
    try
    {
        var url = GetBlobUrl() + "/" + meshPath;
        Debug.Log("[SceneSync] Downloading mesh: " + url);

        var http = new System.Net.Http.HttpClient();
        var response = await http.GetAsync(url);

        if (!response.IsSuccessStatusCode)
        {
            Debug.LogWarning("[SceneSync] Download failed: " + response.StatusCode);
            // フォールバック: Cube を作成
            var fallback = GameObject.CreatePrimitive(PrimitiveType.Cube);
            fallback.name = name;
            ApplyTransform(fallback, position, rotation, scale);
            _managedObjects[objectId] = fallback;
            _knownObjectIds.Add(objectId);
            return;
        }

        var glbBytes = await response.Content.ReadAsByteArrayAsync();
        var tempPath = System.IO.Path.Combine(
            Application.temporaryCachePath, meshPath + ".glb");
        System.IO.File.WriteAllBytes(tempPath, glbBytes);

        // glTFast でインポート
        var gltf = new GLTFast.GltfImport();
        var success = await gltf.Load("file://" + tempPath);

        if (success)
        {
            var go = new GameObject(name);
            await gltf.InstantiateMainSceneAsync(go.transform);
            ApplyTransform(go, position, rotation, scale);
            _managedObjects[objectId] = go;
            _knownObjectIds.Add(objectId);
            Debug.Log("[SceneSync] Imported mesh: " + name);
        }
        else
        {
            Debug.LogWarning("[SceneSync] glTF import failed for: " + name);
            var fallback = GameObject.CreatePrimitive(PrimitiveType.Cube);
            fallback.name = name;
            ApplyTransform(fallback, position, rotation, scale);
            _managedObjects[objectId] = fallback;
            _knownObjectIds.Add(objectId);
        }

        // 一時ファイル削除
        try { System.IO.File.Delete(tempPath); } catch { }
    }
    catch (Exception ex)
    {
        Debug.LogWarning("[SceneSync] DownloadAndCreate failed: " + ex.Message);
    }
}
```

---

## 修正 3: HandleSceneMesh の実装

### 変更前

```csharp
private void HandleSceneMesh(string raw)
{
    // ブラウザが受信した場合の処理
    // Unity 受信は不要（glB ロード機能がないため）
}
```

### 変更後

```csharp
private void HandleSceneMesh(string raw)
{
    var objectIdMatch = System.Text.RegularExpressions.Regex.Match(
        raw, "\"objectId\":\"([^\"]+)\"");
    if (!objectIdMatch.Success) return;
    var objectId = objectIdMatch.Groups[1].Value;

    var meshPathMatch = System.Text.RegularExpressions.Regex.Match(
        raw, "\"meshPath\":\"([^\"]+)\"");
    if (!meshPathMatch.Success) return;
    var meshPath = meshPathMatch.Groups[1].Value;

    var go = FindManagedObject(objectId);
    var name = go != null ? go.name : objectId;

    // 既存オブジェクトがあれば削除して再作成
    if (go != null)
    {
        var pos = go.transform.position;
        var rot = go.transform.rotation;
        var scl = go.transform.localScale;
        DestroyImmediate(go);
        _managedObjects.Remove(objectId);

        _ = DownloadAndCreateObject(objectId, name, meshPath,
            new float[] { pos.x, pos.y, -pos.z },
            new float[] { -rot.x, -rot.y, rot.z, rot.w },
            new float[] { scl.x, scl.y, scl.z });
    }
    else
    {
        _ = DownloadAndCreateObject(objectId, name, meshPath, null, null, null);
    }
}
```

---

## 追加の using

`PresenceClient.cs` の先頭に既にあるが、`SceneSyncWindow.cs` で `HttpClient` を使うため
以下が必要。ファイル先頭に追加:

```csharp
using System.Net.Http;
```

glTFast インポート用:

```csharp
using GLTFast;
```

---

## 確認方法

1. Unity で Connect する
2. ブラウザで scene.html を開き、同じルームに接続
3. ブラウザから glB ファイルを追加（＋ボタンまたはドラッグ＆ドロップ）
4. Unity の Console にエラーが出ないことを確認
5. Unity のシーンに glB モデルが表示されることを確認
6. ブラウザでモデルの Transform を変更し、Unity に反映されることを確認

## 完了条件

- [ ] `FindManagedObject` が Web 由来 objectId でエラーにならない
- [ ] ブラウザからの scene-add で Unity にオブジェクトが作成される
- [ ] meshPath がある場合は blob store から glB をダウンロード・インポート
- [ ] meshPath がない場合はフォールバック Cube を作成
- [ ] scene-mesh でメッシュの再ダウンロード・更新ができる
- [ ] 既存の Unity → ブラウザ同期に影響がないこと
