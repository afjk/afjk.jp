# Step 5: 初回同期（glB 配信）

## 目的

Unity のシーンを glB にエクスポートし、piping-server 経由で
ブラウザおよび他の Unity Editor に配信する。
ルーム参加時に `scene-request` → `scene-state` + glB 転送で初回同期する。

---

## 前提

- Step 3 の Web ビューア、Step 4 の Unity プラグインが動作していること
- Unity プロジェクトに `com.unity.cloud.gltfast` パッケージ（6.x）が導入されていること

---

## 処理フロー

    1. 新規クライアント（Browser or Unity）がルームに参加
    2. 新規クライアントが broadcast で scene-request を送信
    3. 既存クライアント（Unity）が scene-request を受信
    4. 既存クライアントが:
       a. シーンの全オブジェクト情報を JSON で scene-state として broadcast
       b. 各 meshPath 付きオブジェクトの glB を piping-server に PUT
    5. 新規クライアントが scene-state を受信し、オブジェクト一覧を構築
    6. meshPath がある場合は piping-server から GET して glB をロード

---

## Unity 側の実装（PresenceClient.cs / SceneSyncWindow.cs に追加）

### glB エクスポート

    using GLTFast.Export;
    using System.IO;

    public static async Task<byte[]> ExportGameObjectAsGlb(GameObject go)
    {
        var export = new GameObjectExport();
        export.AddScene(new[] { go });
        using var stream = new MemoryStream();
        bool success = await export.SaveToStreamAndDispose(stream);
        return success ? stream.ToArray() : null;
    }

### piping-server へ PUT

    using System.Net.Http;

    private static readonly HttpClient _http = new HttpClient();

    public static async Task<string> UploadGlb(byte[] glb, string pipingBaseUrl)
    {
        var path = GenerateRandomPath();
        var url = $"{pipingBaseUrl}/{path}";
        var content = new ByteArrayContent(glb);
        content.Headers.ContentType =
            new System.Net.Http.Headers.MediaTypeHeaderValue("model/gltf-binary");
        await _http.PutAsync(url, content);
        return path;
    }

    private static string GenerateRandomPath()
    {
        var bytes = new byte[6];
        new System.Random().NextBytes(bytes);
        return Convert.ToBase64String(bytes)
            .Replace("+", "").Replace("/", "").Replace("=", "")
            .Substring(0, 8).ToLower();
    }

### scene-request 受信時の処理

    private async void HandleSceneRequest()
    {
        var objects = new Dictionary<string, object>();
        var rootObjects = UnityEngine.SceneManagement.SceneManager
            .GetActiveScene().GetRootGameObjects();

        foreach (var go in rootObjects)
        {
            if (go.hideFlags != HideFlags.None) continue;

            var pos = go.transform.position;
            var rot = go.transform.rotation;
            var scl = go.transform.localScale;

            string meshPath = null;
            if (go.GetComponentInChildren<MeshFilter>() != null
                || go.GetComponentInChildren<SkinnedMeshRenderer>() != null)
            {
                var glb = await ExportGameObjectAsGlb(go);
                if (glb != null)
                {
                    meshPath = await UploadGlb(glb, "https://pipe.afjk.jp");
                }
            }

            objects[go.GetInstanceID().ToString()] = new
            {
                name = go.name,
                position = new[] { pos.x, pos.y, -pos.z },
                rotation = new[] { -rot.x, -rot.y, rot.z, rot.w },
                scale = new[] { scl.x, scl.y, scl.z },
                meshPath = meshPath
            };
        }

        var payload = JsonUtility.ToJson(new { kind = "scene-state", objects });
        await _client.Broadcast(payload);
    }

---

## ブラウザ側の実装（scene.js に追加）

### ルーム参加時に scene-request を送信

connectPresence の welcome 受信後に追加:

    case 'welcome':
      presenceState.id = data.id;
      presenceState.room = data.room;
      updateStatus(true);
      broadcast({ kind: 'scene-request' });
      break;

### scene-state 受信処理

handleHandoff 内に追加:

    case 'scene-state': {
      const objects = payload.objects || {};
      for (const [objectId, info] of Object.entries(objects)) {
        addOrUpdateObject(objectId, info);
      }
      break;
    }

### addOrUpdateObject 関数

    const gltfLoader = new GLTFLoader();
    const PIPING_BASE = location.hostname === 'localhost'
      ? 'http://localhost:8080'
      : 'https://pipe.afjk.jp';

    function addOrUpdateObject(objectId, info) {
      let obj = managedObjects.get(objectId);

      if (info.meshPath) {
        const url = `${PIPING_BASE}/${info.meshPath}`;
        gltfLoader.load(url, (gltf) => {
          if (obj) scene.remove(obj);
          const model = gltf.scene;
          model.userData.objectId = objectId;
          model.userData.name = info.name;
          applyTransform(model, info);
          scene.add(model);
          managedObjects.set(objectId, model);
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

---

## piping-server の注意事項

piping-server は送信側 PUT と受信側 GET が 1対1 で対応する。
複数受信者がいる場合は受信者ごとに別パスで PUT する。

scene-request を受信した Unity 側は、peers 一覧から受信者数を把握し、
受信者数分の PUT を行う。ただし初期実装では簡略化のため、
scene-state の broadcast を受けた各クライアントが個別に GET する方式とする。
（同時 GET で1台しか受け取れない問題は Step 9 以降で対応）

初期実装の簡易対応:
- Unity が 1回 PUT する
- scene-state に meshPath を含める
- 最初に GET したクライアントだけが glB を受け取れる
- 受け取れなかったクライアントは meshPath なしのフォールバック（Box 表示）

---

## 動作確認

### 1. Unity で適当なシーンを作成（Cube, Sphere 等を配置）
### 2. Unity の Scene Sync ウィンドウからルームに接続
### 3. ブラウザで scene.html?room=同じルーム を開く
### 4. ブラウザに Unity のオブジェクトが表示される

---

## 完了条件

- [ ] Unity が scene-request を受信して scene-state を broadcast できる
- [ ] Unity が glB を piping-server に PUT できる
- [ ] ブラウザが scene-state を受信してオブジェクト一覧を構築できる
- [ ] ブラウザが piping-server から glB を GET して Three.js で表示できる
- [ ] meshPath なしオブジェクトはフォールバックの Box で表示される
