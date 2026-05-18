# Scene Sync API / Protocol Spec

Scene Sync の REST API、presence-server、handoff message の仕様をまとめる。

この文書は `docs/scene-sync-spec.md` から分冊した詳細仕様である。

---

## 設計原則

- presence-server は Scene Sync のために永続的なシーン状態を保持しない。
- HTTP API は既存の WebSocket handoff / broadcast の入口として扱う。
- AI ツール、MCP、GPTs、curl など、呼び出し元の種類に依存しない。
- ユーザーの AI API key は afjk.jp 側に置かない。
- room にいる実クライアントが scene-state の source of truth になる。

---

## REST API

### `POST /api/room/{roomId}/broadcast?name={nickname}`

任意の Scene Sync mutation を room 内の参加者に broadcast する。

代表的な payload:

- `scene-add`
- `scene-delta`
- `scene-remove`
- `scene-env`
- `scene-batch`
- `scene-graph-*`

レスポンス例:

```json
{
  "ok": true,
  "room": "1234",
  "peers": 2
}
```

`ok: true` は presence-server が handoff を room に送ったことを表す。各クライアントが実際に mutation を適用したことまでは保証しない。

### `GET /api/room/{roomId}/scene?name={nickname}`

room 内の既存クライアントに `scene-request` を送り、返ってきた `scene-state` を HTTP response として返す。

処理:

1. room 内に接続者がいない場合は空の scene を返す。
2. 接続者がいる場合は、1 peer に `scene-request` を送る。
3. 一定時間内に `scene-state` が返ればそれを返す。
4. timeout した場合は空の scene を返す。

### GPT wrapper API

GPTs から利用する場合は、`/presence/api/gpt` 配下の wrapper API を使う。

- `POST /link/redeem`
- `POST /link/revoke`
- `POST /room/{roomId}/scene`
- `POST /room/{roomId}/broadcast`
- `POST /room/{roomId}/ai-command`

GPT wrapper は Authorization header ではなく request body の `sessionId` で認証する。

`sessionId` は Scene Sync の「AIにリンク」で発行された 6 桁コードを redeem した結果であり、誰の操作を代替するかを表す。GPT / AI が行った操作も、その linked user の操作として扱えるため、Undo/Redo の ownership とも整合する。

OpenAPI 定義:

- `docs/scene-sync-gpt-openapi.yaml`

---

## presence-server handoff

### `type: "broadcast"`

送信側:

```json
{
  "type": "broadcast",
  "payload": {
    "kind": "scene-delta",
    "objectId": "obj-001",
    "position": [1, 0, 0]
  }
}
```

受信側:

```json
{
  "type": "handoff",
  "from": {
    "id": "...",
    "nickname": "...",
    "device": "..."
  },
  "payload": {
    "kind": "scene-delta",
    "objectId": "obj-001",
    "position": [1, 0, 0]
  }
}
```

---

## Scene mutation payloads

### `scene-state`

新規参加者、リロードしたブラウザ、HTTP scene API への応答として、現在のシーン状態を送る。

```json
{
  "kind": "scene-state",
  "objects": {
    "obj-001": {
      "name": "Cube",
      "position": [0, 0.5, 0],
      "rotation": [0, 0, 0, 1],
      "scale": [1, 1, 1],
      "asset": {
        "type": "primitive",
        "primitive": "box",
        "color": "#4488ff"
      }
    }
  }
}
```

`scene-state` は、単なる transform だけでなく、復元に必要な asset metadata も保持する。
特に Unity 由来 GLB では `asset.visualBasis` を落としてはいけない。詳細は [座標系と visualBasis](./scene-sync-coordinate-system.md) を参照。

### `scene-add`

```json
{
  "kind": "scene-add",
  "objectId": "obj-002",
  "name": "Sphere",
  "position": [0, 0, 0],
  "rotation": [0, 0, 0, 1],
  "scale": [1, 1, 1],
  "asset": { "type": "primitive", "primitive": "sphere" }
}
```

### `scene-delta`

```json
{
  "kind": "scene-delta",
  "objectId": "obj-001",
  "position": [1.5, 2, -3],
  "rotation": [0, 0.707, 0, 0.707],
  "scale": [1, 1, 1]
}
```

省略された field は変更しない。

### `scene-remove`

```json
{
  "kind": "scene-remove",
  "objectId": "obj-001"
}
```

Unity Editor 由来 object の削除挙動は Web と異なる。Unity Editor では GameObject を Destroy せず、unpublish / disconnect 状態に戻す。詳細は [Unity オーサリングモデル](./scene-sync-unity-authoring.md) を参照。

### `scene-mesh`

```json
{
  "kind": "scene-mesh",
  "objectId": "obj-001",
  "meshPath": "xyz98765"
}
```

### `scene-lock` / `scene-unlock`

```json
{
  "kind": "scene-lock",
  "objectId": "obj-001"
}
```

```json
{
  "kind": "scene-unlock",
  "objectId": "obj-001"
}
```

### `scene-request`

```json
{
  "kind": "scene-request"
}
```

受信した client は `scene-state` で応答する。

---

## `scene-batch`

複数の mutation を 1 つの操作としてまとめる。

```json
{
  "kind": "scene-batch",
  "ops": [
    { "kind": "scene-delta", "objectId": "a", "position": [0, 0, 0] },
    { "kind": "scene-delta", "objectId": "b", "position": [0, 1, 0] }
  ]
}
```

ルール:

- `ops` の各要素は通常の scene mutation と同じ処理に流す。
- batch 全体は Undo/Redo では 1 操作として扱う。
- `onBehalfOf` がある場合は child op にも引き継ぐ。
- `scene-batch` の成功 response は、各 client での適用成功を意味しない。動作確認では、再度 `scene-state` を取得して反映を確認する。

---

## Undo / Redo

- Undo/Redo はユーザーごとの履歴として扱う。
- AI / GPTs は redeem session によって linked user の操作を代替するため、その user の Undo 対象になる。
- server は Undo stack を保持しない。
- Undo/Redo の結果も通常の scene mutation として broadcast する。

逆操作:

- `scene-add` の Undo -> `scene-remove`
- `scene-remove` の Undo -> 元データを使った `scene-add`
- `scene-delta` の Undo -> 変更前 transform への `scene-delta`
- `scene-batch` の Undo -> child op の逆操作を逆順にまとめた `scene-batch`

---

## `scene-env`

HDRI / 環境光を room 全体で切り替える。

```json
{
  "kind": "scene-env",
  "envId": "outdoor_night"
}
```

代表的な `envId`:

- `studio`
- `outdoor_day`
- `outdoor_sunset`
- `outdoor_night`
- `indoor_warm`

`scene-state` にも `envId` を含め、途中参加者にも反映する。

---

## 関連ドキュメント

- [Scene Sync Spec Index](./scene-sync-spec.md)
- [Asset / cache / blob store](./scene-sync-assets-and-cache.md)
- [座標系と visualBasis](./scene-sync-coordinate-system.md)
- [Unity オーサリングモデル](./scene-sync-unity-authoring.md)
- [Loom graph protocol](./scene-sync-loom-protocol.md)
