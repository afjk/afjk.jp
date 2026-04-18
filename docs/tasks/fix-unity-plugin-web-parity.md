```markdown
# fix-unity-plugin-web-parity.md

## 概要

Web 側（scene.js）の同期プロトコルが大幅に進化したため、Unity Editor Plugin
（SceneSyncWindow.cs / PresenceClient.cs）を最新の Web 側仕様に合わせる。

## Web 側の最新仕様（main ブランチ）

### 座標系
- Three.js は Y-up 右手系。Unity は Y-up 左手系。
- Web 側は **座標変換なし** で position / rotation / scale を送受信する。
- Unity 側が送信時に Z 反転・quaternion XY 反転し、受信時に逆変換する（現状通り）。

### 同期プロトコル（handoff payload の kind 一覧）
| kind | 方向 | 用途 |
|---|---|---|
| `scene-delta` | broadcast | 選択中オブジェクトの transform 差分 |
| `scene-add` | broadcast | 新規オブジェクト追加（meshPath 付き可） |
| `scene-remove` | broadcast | オブジェクト削除 |
| `scene-mesh` | broadcast | メッシュのみ更新 |
| `scene-lock` | broadcast | オブジェクト選択ロック |
| `scene-unlock` | broadcast | オブジェクト選択解除 |
| `scene-request` | **handoff（1対1）** | 後参加クライアントがシーン要求 |
| `scene-state` | **handoff（1対1）** | シーン全体の応答 |

### 重要な変更点
1. **scene-request / scene-state は handoff（1対1）で送受信**
   - Web 側は `peers` 受信後に peers[0] を `targetId` 指定で handoff する
   - 応答側も `from.id` を `targetId` にして handoff で返す
   - **broadcast ではない**
2. **meshPath は元ファイルの glB をそのまま保存し、userData.meshPath に記録**
   - respondToSceneRequest では再エクスポートせず `userData.meshPath` を再利用
   - blob の TTL（10分）内に scene-request が来ればそのまま使える
3. **受信側で中心合わせ（center offset）を実行**
   - `addOrUpdateObject` で `Box3.getCenter` → `child.position.sub(center)` する
   - 送信側（handleAddMeshFile）でも同じ中心合わせを行い、元ファイルをそのままアップロード
4. **scene-add の meshPath は blob store の相対パス**（例: "ql5ikf5b"）
   - URL は `BLOB_BASE + '/' + meshPath` で構築

## Unity 側の現状の問題点

### 問題 1: scene-request の応答が broadcast になっている
**現状**: `HandleSceneRequest` が `_client.Broadcast(payload)` で scene-state を送信。
**問題**: 全クライアントに scene-state が送られ、既存クライアントのシーンが上書きされる。
**修正**: scene-request の `from.id` を取得し `_client.SendHandoff(fromId, payload)` で返す。

### 問題 2: scene-request の from.id が取得できていない
**現状**: `OnHandoff` は `raw` JSON 文字列のみ受け取り、`from` 情報を解析していない。
`HandleSceneRequest` は引数なしで、誰に返すか分からない。
**修正**: `OnHandoff` で `from.id` を抽出し `HandleSceneRequest(fromId)` に渡す。

### 問題 3: Unity 側が後から参加した場合の scene-request 送信が未実装
**現状**: Unity は参加時にシーンリクエストを送らない。Web 側に既にオブジェクトがあっても
Unity には何も表示されない。
**修正**: `OnPeersUpdated` で初回 peers 受信時に `requestSceneFromPeer()` 相当を実装。

### 問題 4: scene-state 受信処理が未実装
**現状**: `OnHandoff` に `scene-state` のハンドラがない。
**修正**: `HandleSceneState(raw)` を実装し、objects 内の各エントリに対して
`HandleSceneAdd` 相当の処理を行う。

### 問題 5: meshPath の保存と再利用が未実装
**現状**: `HandleSceneRequest` で毎回 `ExportGameObjectAsGlb` → 再アップロード。
**問題**: エクスポートに時間がかかり、glB の内容が Unity のエクスポータ経由になるため
Web 側と形状が変わる可能性がある。また blob TTL 内なら無駄な再アップロード。
**修正**: `_managedObjects` と並行して `_meshPaths` Dictionary を管理し、
scene-add / scene-mesh 受信時に meshPath を保存。scene-request 応答時は
保存済み meshPath を優先的に使い、無い場合のみ再エクスポート。

### 問題 6: peers 受信時の lastSeen による parse エラーの可能性
**現状**: `PeersMessage` の `PeerInfo` に `lastSeen` フィールドがないが、
サーバが `lastSeen` を数値で返す場合 `JsonUtility.FromJson` がエラーになる可能性。
**修正**: `PeerInfo` に `public double lastSeen;` を追加するか、
parse エラーを catch して無視する。

### 問題 7: ReceiveLoop のフラグメント対応
**現状**: `ReceiveAsync` の 1 回の呼び出しで `result.EndOfMessage` を確認していない。
128KB を超えるメッセージや分割フレームで不完全な JSON をパースする可能性。
**修正**: `EndOfMessage` が false の場合はバッファに蓄積し、true になってから処理。

### 問題 8: scene-lock / scene-unlock に nickname が含まれない
**現状**: Unity は `scene-lock` に objectId のみを送信。
**問題**: Web 側のロック表示（🔒 + nickname）で「?」と表示される。
nickname は payload ではなく `from` オブジェクト（サーバが付与）に含まれるため、
実際にはサーバ側で `hello` で設定した nickname が `from.nickname` として付くはず。
**確認**: サーバの handoff 転送時に `from` オブジェクトに nickname を含めているか確認。
含まれていればこの問題はサーバ側の動作に依存し、Unity 側の修正は不要。

## 対象ファイル

- `unity/com.afjk.scene-sync/Editor/SceneSyncWindow.cs`
- `unity/com.afjk.scene-sync/Editor/PresenceClient.cs`

## 修正内容

### 修正 1: PresenceClient.cs – PeerInfo に lastSeen を追加

```csharp
[Serializable]
public class PeerInfo
{
    public string id;
    public string nickname;
    public string device;
    public double lastSeen; // サーバが付与する Unix timestamp
}
```

### 修正 2: PresenceClient.cs – ReceiveLoop でフラグメントに対応

```csharp
private async Task ReceiveLoop()
{
    var buffer = new MemoryStream();
    try
    {
        while (_ws.State == WebSocketState.Open && !_cts.Token.IsCancellationRequested)
        {
            var result = await _ws.ReceiveAsync(
                new ArraySegment<byte>(_recvBuf), _cts.Token);
            if (result.MessageType == WebSocketMessageType.Close) break;

            buffer.Write(_recvBuf, 0, result.Count);

            if (result.EndOfMessage)
            {
                var text = Encoding.UTF8.GetString(
                    buffer.GetBuffer(), 0, (int)buffer.Length);
                buffer.SetLength(0);
                HandleMessage(text);
            }
        }
    }
    catch (OperationCanceledException) { }
    catch (Exception ex)
    {
        Debug.LogWarning("[SceneSync] Receive error: " + ex.Message);
    }
    finally
    {
        OnDisconnected?.Invoke();
    }
}
```

### 修正 3: SceneSyncWindow.cs – meshPath 管理用 Dictionary を追加

フィールド宣言に追加:

```csharp
private Dictionary<string, string> _meshPaths = new Dictionary<string, string>();
// objectId → meshPath（blob store の相対パス）

private bool _sceneReceived = false;
private bool _firstPeersReceived = false;
```

### 修正 4: SceneSyncWindow.cs – OnHandoff で from.id を抽出し scene-state を処理

`OnHandoff` メソッドを以下に置き換え:

```csharp
private void OnHandoff(string raw)
{
    if (!raw.Contains("\"kind\"")) return;

    // from.id を抽出（handoff メッセージに含まれる）
    string fromId = null;
    var fromIdMatch = System.Text.RegularExpressions.Regex.Match(
        raw, "\"from\"\\s*:\\s*\\{[^}]*\"id\"\\s*:\\s*\"([^\"]+)\"");
    if (fromIdMatch.Success)
        fromId = fromIdMatch.Groups[1].Value;

    if (raw.Contains("\"kind\":\"scene-request\""))
    {
        if (fromId != null)
            _ = HandleSceneRequest(fromId);
        else
            Debug.LogWarning("[SceneSync] scene-request without from.id");
    }
    else if (raw.Contains("\"kind\":\"scene-state\""))
    {
        HandleSceneState(raw);
    }
    else if (raw.Contains("\"kind\":\"scene-delta\""))
    {
        HandleSceneDelta(raw);
    }
    else if (raw.Contains("\"kind\":\"scene-add\""))
    {
        HandleSceneAdd(raw);
    }
    else if (raw.Contains("\"kind\":\"scene-remove\""))
    {
        HandleSceneRemove(raw);
    }
    else if (raw.Contains("\"kind\":\"scene-mesh\""))
    {
        HandleSceneMesh(raw);
    }
    else if (raw.Contains("\"kind\":\"scene-lock\""))
    {
        HandleSceneLock(raw);
    }
    else if (raw.Contains("\"kind\":\"scene-unlock\""))
    {
        HandleSceneUnlock(raw);
    }
}
```

### 修正 5: SceneSyncWindow.cs – 初回 peers 受信時に scene-request を送信

`OnEnable` 内の `OnPeersUpdated` コールバックを変更:

```csharp
_client.OnPeersUpdated += (peers) =>
{
    _peers = peers;
    Repaint();

    // 初回 peers 受信時にシーンリクエストを送信
    if (!_firstPeersReceived && peers.Count > 0)
    {
        _firstPeersReceived = true;
        if (!_sceneReceived)
        {
            _ = RequestSceneFromPeer();
        }
    }
};
```

再接続時のリセットを `OnDisconnected` コールバックに追加:

```csharp
_client.OnDisconnected += () =>
{
    _connected = false;
    _sceneReceived = false;
    _firstPeersReceived = false;
    Repaint();
};
```

### 修正 6: SceneSyncWindow.cs – RequestSceneFromPeer を実装

```csharp
private async Task RequestSceneFromPeer()
{
    var peers = _peers;
    if (peers == null || peers.Count == 0)
    {
        _sceneReceived = true;
        return;
    }

    // 自分以外の最初のピアに handoff で送信
    foreach (var peer in peers)
    {
        if (peer.id == _client.Id) continue;

        Debug.Log("[SceneSync] Requesting scene from: " +
            (peer.nickname ?? peer.id));
        await _client.SendHandoff(peer.id,
            "{\"kind\":\"scene-request\"}");
        return;
    }

    // 自分しかいない
    _sceneReceived = true;
}
```

### 修正 7: SceneSyncWindow.cs – HandleSceneState を実装

```csharp
private void HandleSceneState(string raw)
{
    _sceneReceived = true;
    Debug.Log("[SceneSync] Received scene-state");

    // "objects":{...} の中身を簡易パース
    // 各オブジェクトエントリを scene-add と同様に処理
    var objectsMatch = System.Text.RegularExpressions.Regex.Match(
        raw, "\"objects\"\\s*:\\s*\\{(.+)\\}\\s*\\}\\s*$");
    if (!objectsMatch.Success) return;

    var objectsBody = objectsMatch.Groups[1].Value;

    // 各 "objectId":{...} を抽出
    var entryPattern = new System.Text.RegularExpressions.Regex(
        "\"([^\"]+)\"\\s*:\\s*\\{([^{}]+)\\}");
    var matches = entryPattern.Matches(objectsBody);

    foreach (System.Text.RegularExpressions.Match m in matches)
    {
        var objectId = m.Groups[1].Value;
        var body = m.Groups[2].Value;

        // scene-add 相当の JSON を構築して処理
        var fakeJson = "{\"kind\":\"scene-add\",\"objectId\":\"" + objectId + "\"," + body + "}";
        HandleSceneAdd(fakeJson);
    }
}
```

### 修正 8: SceneSyncWindow.cs – HandleSceneRequest を handoff で応答

`HandleSceneRequest` のシグネチャと実装を変更:

```csharp
private async Task HandleSceneRequest(string fromId)
{
    Debug.Log("[SceneSync] Responding to scene-request for: " + fromId);

    var rootObjects = UnityEngine.SceneManagement.SceneManager
        .GetActiveScene().GetRootGameObjects();

    var objectsJson = new System.Text.StringBuilder();
    objectsJson.Append("{");
    bool first = true;
    var pendingUploads = new List<(byte[] glb, string path)>();

    foreach (var go in rootObjects)
    {
        if (go.hideFlags != HideFlags.None) continue;

        var objectId = go.GetInstanceID().ToString();
        var pos = go.transform.position;
        var rot = go.transform.rotation;
        var scl = go.transform.localScale;

        // 保存済み meshPath を優先使用
        string path = null;
        if (_meshPaths.TryGetValue(objectId, out var savedPath))
        {
            path = savedPath;
        }
        else if (go.GetComponentInChildren<MeshFilter>() != null
            || go.GetComponentInChildren<SkinnedMeshRenderer>() != null)
        {
            var glb = await PresenceClient.ExportGameObjectAsGlb(go);
            if (glb != null)
            {
                path = PresenceClient.GenerateRandomPath();
                pendingUploads.Add((glb, path));
                _meshPaths[objectId] = path;
            }
        }

        if (!first) objectsJson.Append(",");
        first = false;
        var meshPathJson = path != null ? ",\"meshPath\":\"" + path + "\"" : "";
        objectsJson.Append("\"" + objectId + "\":{\"name\":\"" + go.name + "\"" +
            ",\"position\":[" + pos.x + "," + pos.y + "," + (-pos.z) + "]" +
            ",\"rotation\":[" + (-rot.x) + "," + (-rot.y) + "," + rot.z + "," + rot.w + "]" +
            ",\"scale\":[" + scl.x + "," + scl.y + "," + scl.z + "]" +
            meshPathJson + "}");
    }

    // Web 由来のオブジェクトも含める
    foreach (var kvp in _managedObjects)
    {
        if (int.TryParse(kvp.Key, out _)) continue; // Unity 由来はスキップ（上で処理済み）
        var go = kvp.Value;
        if (go == null) continue;

        var pos = go.transform.position;
        var rot = go.transform.rotation;
        var scl = go.transform.localScale;

        string path = null;
        _meshPaths.TryGetValue(kvp.Key, out path);

        if (!first) objectsJson.Append(",");
        first = false;
        var meshPathJson = path != null ? ",\"meshPath\":\"" + path + "\"" : "";
        objectsJson.Append("\"" + kvp.Key + "\":{\"name\":\"" + go.name + "\"" +
            ",\"position\":[" + pos.x + "," + pos.y + "," + (-pos.z) + "]" +
            ",\"rotation\":[" + (-rot.x) + "," + (-rot.y) + "," + rot.z + "," + rot.w + "]" +
            ",\"scale\":[" + scl.x + "," + scl.y + "," + scl.z + "]" +
            meshPathJson + "}");
    }

    objectsJson.Append("}");

    // handoff で 1対1 返信（broadcast ではない）
    var payload = "{\"kind\":\"scene-state\",\"objects\":" + objectsJson + "}";
    await _client.SendHandoff(fromId, payload);

    // アップロード
    foreach (var (glb, path) in pendingUploads)
        _ = PresenceClient.UploadGlb(glb, GetBlobUrl(), path);
}
```

### 修正 9: SceneSyncWindow.cs – HandleSceneAdd / SendSceneAdd で meshPath を保存

`HandleSceneAdd` の末尾、オブジェクト作成後に meshPath を保存:

DownloadAndCreateObject 呼び出しの前に追加:

```csharp
if (!string.IsNullOrEmpty(meshPath))
{
    _meshPaths[objectId] = meshPath;
}
```

`SendSceneAdd` 内、アップロード成功後に追加:

```csharp
if (glb != null && path != null)
{
    _meshPaths[go.GetInstanceID().ToString()] = path;
    _ = PresenceClient.UploadGlb(glb, GetBlobUrl(), path);
}
```

### 修正 10: SceneSyncWindow.cs – HandleSceneRemove で meshPath もクリーンアップ

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
        DestroyImmediate(go);
        _managedObjects.Remove(objectId);
        _knownObjectIds.Remove(objectId);
    }
    _meshPaths.Remove(objectId);
    _locks.Remove(objectId);
}
```

## 修正箇所まとめ

| # | 箇所 | 問題 | 修正 |
|---|---|---|---|
| 1 | `PeerInfo` | `lastSeen` 欠落で parse エラー | フィールド追加 |
| 2 | `ReceiveLoop` | フラグメント未対応 | `EndOfMessage` チェック + バッファ蓄積 |
| 3 | `SceneSyncWindow` フィールド | meshPath / 状態管理なし | `_meshPaths`, `_sceneReceived`, `_firstPeersReceived` 追加 |
| 4 | `OnHandoff` | `from.id` 未取得、`scene-state` 未対応 | from.id 抽出、scene-state ハンドラ追加 |
| 5 | `OnPeersUpdated` | 後参加時の scene-request 未送信 | 初回 peers で `RequestSceneFromPeer` 呼び出し |
| 6 | 新規 | `RequestSceneFromPeer` 未実装 | handoff で 1対1 送信 |
| 7 | 新規 | `HandleSceneState` 未実装 | objects パース → HandleSceneAdd 委譲 |
| 8 | `HandleSceneRequest` | broadcast で全員に送信 | `SendHandoff(fromId, ...)` で 1対1 返信 |
| 9 | `HandleSceneAdd` / `SendSceneAdd` | meshPath 未保存 | `_meshPaths` に記録 |
| 10 | `HandleSceneRemove` | meshPath / lock 未クリーンアップ | 辞書から削除 |

## 確認手順

### Web → Unity 同期
1. ブラウザで glB を追加する
2. Unity で同じルームに接続する
3. Unity にモデルが表示されることを確認する
4. ブラウザでモデルを移動し、Unity で追従することを確認する

### Unity → Web 同期
5. Unity でオブジェクトを追加する
6. ブラウザにオブジェクトが表示されることを確認する
7. Unity でオブジェクトを移動し、ブラウザで追従することを確認する

### 後参加同期
8. ブラウザで複数の glB を配置する
9. Unity で接続し、全オブジェクトが同期されることを確認する
10. 逆に Unity でオブジェクトを配置し、後からブラウザで参加して同期を確認する

### scene-request が handoff であることの確認
11. ブラウザ A, B, Unity の 3 クライアントで接続する
12. Unity をリロード（Disconnect → Connect）する
13. ブラウザ A, B のシーンが上書き・ちらつきしないことを確認する
14. Unity に正しくシーンが同期されることを確認する

### ロック同期
15. ブラウザでオブジェクトを選択する
16. Unity のコンソールにロック情報が出ることを確認する
17. Unity でオブジェクトを選択する
18. ブラウザでロック表示（🔒 + Unity の nickname）が出ることを確認する

## 完了条件

- [ ] `PeerInfo` に `lastSeen` フィールドが追加されている
- [ ] `ReceiveLoop` がフラグメントに対応している
- [ ] `_meshPaths` Dictionary が追加されている
- [ ] `OnHandoff` で `from.id` を抽出している
- [ ] `scene-state` ハンドラが実装されている
- [ ] 初回 peers 受信時に `RequestSceneFromPeer` が呼ばれる
- [ ] `RequestSceneFromPeer` が handoff で送信している
- [ ] `HandleSceneRequest` が handoff で応答している（broadcast ではない）
- [ ] meshPath が `_meshPaths` に保存・再利用されている
- [ ] `HandleSceneRemove` で meshPath と lock がクリーンアップされている
- [ ] Web → Unity のオブジェクト同期が正しく動作する
- [ ] Unity → Web のオブジェクト同期が正しく動作する
- [ ] 後参加のシーン同期が正しく動作する
- [ ] 3 クライアント以上で scene-request が他クライアントに影響しない
- [ ] ロック表示が双方向で正しく動作する
```
