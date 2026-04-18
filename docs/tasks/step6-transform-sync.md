# Step 6: Transform 差分リアルタイム同期

## 目的

Unity Editor でオブジェクトの Transform（位置・回転・スケール）を変更すると、
ブラウザおよび他の Unity Editor にリアルタイムに反映される。
この Step では Unity → 全員 の片方向同期を実装する。

---

## 処理フロー

    1. Unity Editor でオブジェクトの Transform が変更される
    2. Unity プラグインが変更を検知する
    3. 座標変換（Unity → ワイヤーフォーマット）を行う
    4. scene-delta を broadcast で送信する
    5. ブラウザ / 他 Unity が受信して反映する

---

## Unity 側の実装

### Transform 変更検知

EditorApplication.update で前フレームの Transform と比較する。
スロットリングとして最低 50ms（20fps）間隔で送信する。

    private Dictionary<string, TransformSnapshot> _lastSnapshots = new();
    private double _lastSendTime;
    private const double SEND_INTERVAL = 0.05; // 50ms

    private void EditorUpdate()
    {
        if (!_connected) return;
        if (EditorApplication.timeSinceStartup - _lastSendTime < SEND_INTERVAL) return;
        _lastSendTime = EditorApplication.timeSinceStartup;

        var selection = Selection.activeGameObject;
        if (selection == null) return;

        var id = selection.GetInstanceID().ToString();
        var t = selection.transform;
        var current = new TransformSnapshot(t.position, t.rotation, t.localScale);

        if (_lastSnapshots.TryGetValue(id, out var last) && last.Equals(current))
            return;

        _lastSnapshots[id] = current;

        var pos = t.position;
        var rot = t.rotation;
        var scl = t.localScale;

        var payload = $"{{" +
            $"\"kind\":\"scene-delta\"," +
            $"\"objectId\":\"{id}\"," +
            $"\"position\":[{pos.x},{pos.y},{-pos.z}]," +
            $"\"rotation\":[{-rot.x},{-rot.y},{rot.z},{rot.w}]," +
            $"\"scale\":[{scl.x},{scl.y},{scl.z}]" +
            $"}}";
        _ = _client.Broadcast(payload);
    }

    private struct TransformSnapshot
    {
        public Vector3 position;
        public Quaternion rotation;
        public Vector3 scale;

        public TransformSnapshot(Vector3 p, Quaternion r, Vector3 s)
        {
            position = p; rotation = r; scale = s;
        }

        public bool Equals(TransformSnapshot other)
        {
            return position == other.position
                && rotation == other.rotation
                && scale == other.scale;
        }
    }

---

## ブラウザ側の実装（scene.js に追加）

### scene-delta 受信処理

handleHandoff 内に追加:

    case 'scene-delta': {
      const obj = managedObjects.get(payload.objectId);
      if (!obj) break;
      if (payload.position) obj.position.fromArray(payload.position);
      if (payload.rotation) obj.quaternion.fromArray(payload.rotation);
      if (payload.scale) obj.scale.fromArray(payload.scale);
      break;
    }

---

## 他 Unity での受信側処理

OnHandoffReceived イベントで scene-delta を受信し、該当 GameObject の Transform を更新する。

    private void HandleSceneDelta(string objectId, float[] position, float[] rotation, float[] scale)
    {
        // objectId から GameObject を検索
        // ワイヤーフォーマット → Unity 座標系に逆変換
        // position: (x, y, -z)
        // rotation: (-x, -y, z, w)
        // Transform を更新（Undo.RecordObject で元に戻せるように）
    }

---

## 動作確認

### 1. Unity と ブラウザ を同じルームに接続
### 2. Unity で初回同期（Step 5）を行いブラウザにオブジェクトが表示される
### 3. Unity でオブジェクトを選択して移動する
### 4. ブラウザ側でオブジェクトがリアルタイムに追従する

---

## 完了条件

- [ ] Unity でオブジェクトを移動すると scene-delta が broadcast される
- [ ] ブラウザが scene-delta を受信してオブジェクト位置を更新する
- [ ] 50ms 間隔のスロットリングが動作する
- [ ] 変更がない場合は送信されない
- [ ] 座標変換（Unity → Three.js）が正しい
