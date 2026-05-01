# afjk.jp/pipe — Scene Sync 技術仕様

Unity Editor / Unity Runtime とWebブラウザ間で3Dシーンをリアルタイム共有する機能。
既存の pipe のルーム機能・presence-server をそのまま活用する。

---

## 概要

| 項目 | 内容 |
|------|------|
| Webビューア | `html/scenesync/index.html` + `html/assets/js/scenesync/scene.js` |
| Unity側 | Editor 拡張（`SceneSyncWindow`）+ Runtime パッケージ（`SceneSyncManager`）|
| Godot側 | Editor dock addon + Runtime ノード（`godot/addons/scene_sync/`） |
| UPMパッケージ | `com.afjk.scene-sync`（upm.afjk.jp）、依存: `com.unity.cloud.gltfast@6.0.0` |
| 3D描画 | Three.js + GLTFLoader / GLTFExporter + TransformControls |
| 通信 | presence-server（handoff broadcast）+ presence-server blob store（glB保存）|
| 新規サーバー | なし（presence-server に `type: "broadcast"` と `/blob/` エンドポイントを追加）|

---

## アーキテクチャ

    Unity A ──┐                                         ┌── Browser X
    Unity B ──┼── WSS ── presence-server ─── WSS ───────┼── Browser Y
    Godot A ──┤         (既存 room)                     │
    Godot B ──┘                                         │
                    └──────── HTTP POST/GET ────────────┘
                         presence-server /blob/
                         (glB ファイル保存・取得)

全クライアントが同じルームに参加し、handoff broadcast でメッセージを交換する。  
glB メッシュデータは presence-server の blob store に一度アップロードし、全クライアントが GET で取得する（1対多対応）。

---

## REST API

presence-server に HTTP エンドポイントを追加し、外部ツール（Claude Code、ChatGPT GPTs、MCP 等）から
Scene Sync のシーンを操作できるようにする。

### 設計原則

- サーバーはステートレス - presence-server は REST API のために状態を保持しない
- AIツール非依存 - curl が叩ければ何でも使える
- 既存プロトコルに乗せる - broadcast/handoff の仕組みをそのまま HTTP 経由で利用する
- ユーザーの API キーはサイトに入れない - AI 処理はすべてユーザー側の環境で完結する

### エンドポイント

#### `POST /api/room/{roomId}/broadcast?name={nickname}`

リクエスト body の JSON をルーム内の全 WebSocket 接続者に handoff メッセージとして配信する。

パラメータ:
- `roomId`（path, 必須）: ルーム ID
- `name`（query, 省略可）: 送信者のニックネーム。省略時は `"AI"`

リクエスト:
- `Content-Type: application/json`
- body: 任意の JSON オブジェクト（scene-add, scene-delta, scene-remove 等）

サーバーは body を以下の形式でラップして配信する:

    {
      "type": "handoff",
      "from": {
        "id": "api-{uuid}",
        "nickname": "{name}",
        "device": "REST API"
      },
      "payload": { ...body... }
    }

レスポンス:
- 成功: `200 { "ok": true, "room": "{roomId}", "peers": {人数} }`
- body 不正: `400 { "error": "invalid JSON body" }`
- ルームが存在しないまたは接続者 0 人でもエラーにしない（`peers: 0`）

#### `GET /api/room/{roomId}/scene?name={nickname}`

ルーム内の既存クライアントに `scene-request` を中継し、応答の `scene-state` を返す。

パラメータ:
- `roomId`（path, 必須）: ルーム ID
- `name`（query, 省略可）: リクエスト元のニックネーム。省略時は `"AI"`

処理:
1. ルーム内の接続者が 0 人の場合、即座に `{ "objects": {} }` を返す
2. 接続者がいる場合、1 人に `scene-request` を送信し応答を待つ
3. 5 秒以内に `scene-state` が返らなければ `{ "objects": {} }` を返す

レスポンス:
- `200 OK`: `scene-state` の payload をそのまま返す

#### `GET /api/presets`（IF 定義のみ、未実装）

プリセットアセットのカタログ一覧を返す。

レスポンス:

    [
      {
        "presetId": "pedestal-01",
        "name": "展示台",
        "category": "furniture",
        "description": "白い円形の展示用台座。直径1m、高さ0.9m",
        "tags": ["台座", "展示", "pedestal"],
        "defaultScale": [1, 1, 1],
        "meshPath": "preset/pedestal-01"
      }
    ]

---

## presence-server 変更

### `type: "broadcast"`

同室の全クライアント（送信者除く）に payload を配信する。

送信:

    {
      "type": "broadcast",
      "payload": { "kind": "...", ... }
    }

受信側は既存の handoff と同じ形式で届く:

    {
      "type": "handoff",
      "from": { "id": "...", "nickname": "...", "device": "..." },
      "payload": { "kind": "...", ... }
    }

### Blob Store（`/blob/:id`）

glB ファイルをサーバー側に一時保存する HTTP エンドポイント。

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/blob/:id` | glB をアップロード（存在する場合は 409）|
| GET | `/blob/:id` | glB をダウンロード |
| DELETE | `/blob/:id` | glB を削除 |

| 制限 | 値 |
|---|---|
| 最大ファイルサイズ | 50 MB |
| TTL | 10 分（自動削除）|
| メモリ保持閾値 | 1 MB 以下はメモリ保持、超過時はディスク（`/data/blobs/`）|

エンドポイント（本番）: `https://afjk.jp/presence/blob/<id>`  
エンドポイント（ローカル）: `http://localhost:8787/blob/<id>`

---

## Handoff Kind 一覧（Scene Sync 用）

### `scene-state`（初回同期）

新規参加者がルームに入った際、既存クライアントがシーン全体の状態を送る。

    {
      "kind": "scene-state",
      "objects": {
        "<objectId>": {
          "name": "Cube",
          "position": [1, 2, -3],
          "rotation": [0, 0, 0, 1],
          "scale": [1, 1, 1],
          "meshPath": "abc12345"
        }
      }
    }

`meshPath` がある場合、`<BLOB_BASE>/<meshPath>` から glB を取得する。  
この glB は authored orientation をそのまま使い、クライアントごとの一律ヨー補正は加えない。オブジェクト姿勢は `rotation` フィールドでのみ表現する。

### `scene-delta`（プロパティ差分）

Transform 等の変更をリアルタイムに送る。

    {
      "kind": "scene-delta",
      "objectId": "obj-001",
      "position": [1.5, 2, -3],
      "rotation": [0, 0.707, 0, 0.707],
      "scale": [1, 1, 1]
    }

変更のあったフィールドだけ含める（省略されたフィールドは変更なし）。

## クライアント実装

### Web

- `html/scenesync/index.html`
- `html/assets/js/scenesync/scene.js`

Three.js ベースのリファレンス実装。ワイヤーフォーマットはこのビューアの座標系を基準とする。

### Unity

- `unity/com.afjk.scene-sync/Editor/`
- `unity/com.afjk.scene-sync/Runtime/`

Editor 拡張と Runtime MonoBehaviour を提供する。Unity は左手系のため、ワイヤー送受信時に Z 反転を行う。

### Godot

- `godot/addons/scene_sync/plugin.gd`
- `godot/addons/scene_sync/scene_sync_dock.tscn`
- `godot/addons/scene_sync/scene_sync_manager.gd`
- `godot/addons/scene_sync/presence_client.gd`
- `godot/addons/scene_sync/scene_sync_protocol.gd`
- `godot/addons/scene_sync/blob_client.gd`
- `godot/addons/scene_sync/gltf_helper.gd`

Godot 4.x addon。Editor では Dock UI から接続し、Runtime では `SceneSyncManager` ノードを使う。
Godot は Three.js と同じ右手系 Y-up のため、Transform のワイヤー変換は原則不要。

#### ファイル構成

```text
godot/
  addons/scene_sync/
    plugin.cfg
    plugin.gd
    scene_sync_dock.tscn
    scene_sync_dock.gd
    scene_sync_manager.gd
    presence_client.gd
    scene_sync_protocol.gd
    blob_client.gd
    gltf_helper.gd
```

## インストール

### Unity

`unity/com.afjk.scene-sync/README.md` を参照。

### Godot

1. `godot/addons/scene_sync` を対象プロジェクトの `addons/scene_sync` にコピー
2. Godot 4.x でプロジェクトを開く
3. `Project Settings > Plugins` で `SceneSync` を有効化
4. 右側 Dock から `URL`, `Room`, `Name` を設定して接続

## Runtime 利用

### Godot

`SceneSyncManager` をシーンに追加し、以下を設定する。

- `presence_url`
- `blob_url`（省略時は `presence_url` から自動導出）
- `room`
- `nickname`
- `sync_root`
- `auto_connect`

接続後、初回 `peers` 受信時に `scene-request` を送り、既存クライアントから `scene-state` を取得する。

### `scene-add`（オブジェクト追加）

    {
      "kind": "scene-add",
      "objectId": "obj-002",
      "name": "Sphere",
      "position": [0, 0, 0],
      "rotation": [0, 0, 0, 1],
      "scale": [1, 1, 1],
      "asset": { "type": "...", ... }
    }

`asset` フィールドでオブジェクトの種類を指定する。  
`asset` がない場合は後方互換のため `meshPath` フィールドまたはデフォルト Box で処理する。

#### `asset.type` 一覧

`primitive`（実装済み）:

    { "type": "primitive", "primitive": "box", "color": "#4488ff" }

`primitive` の種類: `box`, `sphere`, `cylinder`, `cone`, `plane`, `torus`  
`color` 省略時のデフォルト: `"#888888"`

`preset`（IF 定義のみ、未実装）:

    { "type": "preset", "presetId": "pedestal-01" }

`mesh`（実装済み）:

    { "type": "mesh", "meshPath": "abc12345" }

`image`（IF 定義のみ、未実装）:

    { "type": "image", "url": "https://..." }

`video`（IF 定義のみ、未実装）:

    { "type": "video", "url": "https://..." }

`audio`（IF 定義のみ、未実装）:

    { "type": "audio", "url": "https://..." }

`assetbundle`（IF 定義のみ、未実装）:

    { "type": "assetbundle", "url": "https://...", "platform": "android" }

`asset` の優先順位:
1. `asset` フィールドがある場合 -> `asset.type` で分岐
2. `meshPath` がある場合 -> 既存の glB ロード処理（後方互換）
3. どちらもない場合 -> デフォルト Box 生成（後方互換）

### `scene-remove`（オブジェクト削除）

    {
      "kind": "scene-remove",
      "objectId": "obj-002"
    }

### `scene-mesh`（メッシュ更新通知）

ジオメトリが変わった場合、blob store にアップロードした後に通知する。

    {
      "kind": "scene-mesh",
      "objectId": "obj-001",
      "meshPath": "xyz98765"
    }

### `scene-lock` / `scene-unlock`（編集ロック）

    {
      "kind": "scene-lock",
      "objectId": "obj-001"
    }

    {
      "kind": "scene-unlock",
      "objectId": "obj-001"
    }

ロック中のオブジェクトは他クライアントが操作不可。`from.id` がロック保持者。  
Web ビューアではロック中オブジェクトにバウンディングボックス角線 + ロック保持者名のラベルを表示する。

### `scene-request`（状態リクエスト）

新規参加者がルーム内の既存メンバーにシーン状態を要求する。

    {
      "kind": "scene-request"
    }

受信したクライアントのうち1台が `scene-state` を broadcast で返す。

---

## glB 転送（blob store 経由）

メッシュデータは presence-server の blob store を使う。piping-server は使わない。

    送信側: POST <BLOB_BASE>/<random-path>  (Content-Type: model/gltf-binary)
    受信側: GET  <BLOB_BASE>/<random-path>

blob store は 1対多対応のため、受信者数に関係なく1回アップロードするだけでよい。  
Web ビューア（scene.js）では GLTFExporter で glB を生成してアップロードする。  
Unity 側（Editor / Runtime）は GLTFast でエクスポートしてアップロードする。  
既に `meshPath` が付いているオブジェクトは再エクスポートせず既存パスを再利用する。

---

## 座標系変換

Unity（左手系 Y-up）と Three.js（右手系 Y-up）の変換。  
ワイヤー上のフォーマットは Three.js 座標系を採用する。

| | Unity → ワイヤー | ワイヤー → Unity |
|---|---|---|
| Position | `(x, y, z)` → `(x, y, -z)` | `(x, y, -z)` |
| Rotation | `(x, y, z, w)` → `(-x, -y, z, w)` | `(-x, -y, z, w)` |

送信側が変換して送出する。Three.js 側は受信値をそのまま使う。  
Unity 側は送信時に変換、受信時に逆変換する。

glB ファイル自体の座標変換は glTFast が処理する（Unity の glTFast は右手系 → 左手系変換を内部で適用するため、送信側は Three.js の右手系 glB をそのまま PUT する）。

---

## ファイル配置

    afjk.jp/
    ├── html/
    │   ├── pipe/
    │   │   └── index.html              # 既存 pipe UI（Scene Sync は分離済み）
    │   ├── scenesync/
    │   │   └── index.html              # 3D ビューア（独立アプリ）
    │   └── assets/js/
    │       ├── pipe/
    │       │   ├── app.js              # 既存
    │       │   ├── stream.js           # 既存
    │       │   └── swarm.js            # 既存
    │       └── scenesync/
    │           └── scene.js            # シーン同期ロジック
    ├── apps/
    │   └── presence-server/
    │       ├── src/server.mjs          # broadcast + blob store + REST API
    │       └── tests/api.test.mjs      # REST API テスト（node --test）
    ├── unity/
    │   └── com.afjk.scene-sync/
    │       ├── Editor/
    │       │   ├── SceneSyncWindow.cs  # Editor 拡張ウィンドウ
    │       │   └── PresenceClient.cs   # Editor 用 WebSocket クライアント
    │       ├── Runtime/
    │       │   ├── SceneSyncManager.cs # Runtime MonoBehaviour
    │       │   └── PresenceClientRuntime.cs  # Runtime 用 WebSocket クライアント
    │       └── package.json
    └── docs/
        ├── pipe-spec.md                # 既存
        └── scene-sync-spec.md          # この文書

---

## UI 仕様（scenesync/index.html）

1ページ完結のビューア。

### 画面構成

- 画面全体が Three.js の 3D ビューポート
- 左上: 設定パネル（ニックネーム編集、ルーム作成 / コード入力で参加 / コピー / 退場 / 同じルームを pipe で開く）
- 右上: ルーム接続状態バッジ（接続中 / 人数）
- 右上下部: 参加者一覧パネル（`#peers-panel`）— 各ピアの名前・編集中オブジェクトを表示
- 右下: `＋` ボタン（glB / glTF ファイルをローカルから追加）
- モバイル: 画面下部にツールバー（回転 ↻ / スケール ⤡ / 削除 🗑）

### 操作方法

| 操作 | 内容 |
|---|---|
| ダブルクリック / ダブルタップ | オブジェクト選択 → TransformControls 表示 |
| W / ↻ ボタン | 移動モード |
| E / ↻ ボタン | 回転モード |
| R / ⤡ ボタン | スケールモード |
| Delete / 🗑 ボタン | 選択オブジェクトを削除 |
| 背景シングルクリック / タップ | 選択解除 |
| ドラッグ（オブジェクト外）| カメラ回転（OrbitControls）|

### ニックネーム解決

1. URL クエリパラメータ `?name=<name>`
2. `localStorage` の `pipe.deviceName`（pipe ページと共有）
3. `'User-' + ランダム4文字` にフォールバック

### URL 形式

    https://afjk.jp/scenesync/?room=<ルームコード>
    https://afjk.jp/scenesync/?room=<ルームコード>&name=<ニックネーム>

---

## Unity パッケージ（com.afjk.scene-sync）

### Editor 拡張（SceneSyncWindow）

`Window > Scene Sync` で開くエディタウィンドウ。Unity Editor 上でシーンを編集しながらリアルタイム同期する。

### Runtime（SceneSyncManager）

MonoBehaviour として GameObject にアタッチして使う。

| フィールド | 説明 |
|---|---|
| `_presenceUrl` | presence-server の WSS URL（デフォルト: `wss://afjk.jp/presence`）|
| `_blobUrl` | blob store のベース URL（空の場合は自動解決）|
| `_room` | ルームコード |
| `_nickname` | 表示名（デフォルト: `"Unity"`）|
| `_autoConnect` | 起動時に自動接続するか |
| `_syncRoot` | 同期対象 Transform のルート（省略時はシーン直下）|

### Unity パッケージインストール

`Packages/manifest.json` に以下を追加:

```json
{
  "scopedRegistries": [
    {
      "name": "afjk",
      "url": "https://upm.afjk.jp",
      "scopes": ["com.afjk"]
    }
  ],
  "dependencies": {
    "com.afjk.scene-sync": "0.1.0"
  }
}
```

---

## 競合解決

Last-Writer-Wins を採用。同一オブジェクトの同時編集は後着が勝つ。  
`scene-lock` / `scene-unlock` による排他制御を実装済み。ロック中は他クライアントが操作不可。

---

## scene-batch と Undo/Redo（未実装）

### `scene-batch`

複数の操作を 1 つのトランザクションとしてまとめる。

    {
      "kind": "scene-batch",
      "batchId": "batch-{uuid}",
      "actions": [
        { "kind": "scene-add", ... },
        { "kind": "scene-add", ... }
      ]
    }

### Undo/Redo

- Miro / Google Spreadsheet と同じユーザーごとの Undo
- 操作履歴は各クライアント側が自分の分だけ持つ
- サーバーは履歴を持たない
- Undo/Redo の実行結果は通常の `scene-add` / `scene-remove` / `scene-delta` として broadcast される

作業単位:
- 手動操作: 1 操作 = 1 Undo エントリ
- AI 操作（`scene-batch`）: `actions` 全体 = 1 Undo エントリ

逆操作の対応:
- `scene-add` の Undo -> `scene-remove`
- `scene-remove` の Undo -> `scene-add`（元データを保持）
- `scene-delta` の Undo -> 変更前の Transform で `scene-delta`

---

## scene-env（環境光の切り替え）

HDRI ベースの環境光（IBL）をプリセットから切り替える。

### メッセージ形式

```json
{
  "kind": "scene-env",
  "envId": "outdoor_night"
}
```

### envId 選択肢

| envId          | 用途           | ファイル                                |
|----------------|---------------|-----------------------------------------|
| studio         | スタジオ / 展示 | `/assets/hdri/studio.hdr`              |
| outdoor_day    | 屋外 昼        | `/assets/hdri/outdoor_day.hdr`         |
| outdoor_sunset | 屋外 夕方      | `/assets/hdri/outdoor_sunset.hdr`      |
| outdoor_night  | 屋外 夜        | `/assets/hdri/outdoor_night.hdr`       |
| indoor_warm    | 室内 暖色      | `/assets/hdri/indoor_warm.hdr`         |

### 動作

- broadcast すると全クライアントが環境光を切り替える
- `scene-state` にも `envId` を含め、後から参加したクライアントにも反映される
- ブラウザ UI の `#env-select` セレクタからも切り替え可能

### HDRI ファイル

Poly Haven（CC0 ライセンス）から取得。ファイル配置: `html/assets/hdri/{envId}.hdr`

### curl での確認

```bash
curl -s -X POST "http://localhost:8787/api/room/ai-test/broadcast?name=Claude" \
  -H "Content-Type: application/json" \
  -d '{"kind":"scene-env","envId":"outdoor_night"}'
```

---

## scene-avatar（ピアのアバター位置情報）

### 概要

各クライアントの**頭・左手・右手の位置と回転**を 10Hz 程度でブロードキャストし、他のピアのアバターを可視化するための揮発性メッセージです。サーバはリレーするのみで、永続化・ルーム履歴への記録は行いません。新規入室者には自動的に他ピアの位置情報は同期されず、各ピアが次回送信したタイミングで反映されます。

`scene-delta` 等のオブジェクト操作系メッセージとは独立しており、`scene-avatar` を実装していないクライアントは単に無視すれば既存機能に影響しません（後方互換）。

### メッセージスキーマ

```json
{
  "kind": "scene-avatar",
  "peerId": "abc123",
  "nickname": "alice",
  "t": 1714099200123,
  "mode": "vr",
  "head": {
    "p": [0.1, 1.65, -0.5],
    "q": [0.0, 0.0, 0.0, 1.0]
  },
  "left": {
    "p": [-0.2, 1.2, -0.3],
    "q": [0.0, 0.0, 0.0, 1.0],
    "active": true
  },
  "right": {
    "p": [0.2, 1.2, -0.3],
    "q": [0.0, 0.0, 0.0, 1.0],
    "active": true
  }
}
```

### フィールド定義

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `kind` | string | ✓ | 固定値 `"scene-avatar"` |
| `peerId` | string | ✓ | 送信元ピア ID（既存の peer 管理と一致） |
| `nickname` | string |  | 表示名。省略時は受信側が `peer-info` の値を使用 |
| `t` | number | ✓ | 送信時刻（Unix epoch ms）。受信側の補間・タイムアウト判定に使用 |
| `mode` | string |  | `"vr"` \| `"mr"` \| `"desktop"`。省略時は `"vr"` 扱い |
| `head` | Pose | ✓ | 頭（HMD またはデスクトップカメラ）の姿勢 |
| `left` | HandPose |  | 左手コントローラ。XR セッション外なら省略可 |
| `right` | HandPose |  | 右手コントローラ。XR セッション外なら省略可 |

**Pose 型**

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `p` | `[number, number, number]` | ✓ | ワールド座標 `[x, y, z]`（メートル） |
| `q` | `[number, number, number, number]` | ✓ | クォータニオン `[x, y, z, w]` |

**HandPose 型**

Pose に加えて：

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `active` | boolean | ✓ | コントローラが接続・トラッキング中なら `true`。`false` の場合 `p`/`q` は無視される |

### 座標系・回転表現の規約

すべてのクライアントは以下を**送信時に保証**します。受信側では変換不要です。

- **座標系**: 右手系・Y-up（Three.js / WebXR / glTF と同一）
- **単位**: メートル
- **基準フレーム**: シーンのワールド原点。WebXR の場合は `local-floor` reference space に床合わせオフセット（`applyFloorOffset`）を適用した後の座標
- **回転**: クォータニオン `[x, y, z, w]`（w は最後）
- **頭の前方ベクトル**: ローカル `-Z` 方向（Three.js / WebXR の慣例）
- **手の前方ベクトル**: コントローラのレイ方向 = ローカル `-Z`

### 送信レート

- **推奨**: 10Hz（100ms 間隔）
- **最小**: 5Hz（200ms 間隔）。これより遅いと受信側で動きがカクつく
- **最大**: 30Hz（33ms 間隔）。これを超える送信はサーバ側で drop してよい
- 値が前回送信から閾値（位置 0.5mm 未満かつ回転 0.5° 未満）以下の場合は送信をスキップしてよい（静止時の帯域節約）

### タイムアウトと退出

- 受信側は最後の `scene-avatar` 受信から **3000ms** が経過したピアのアバターを非表示にし、リソースを解放する
- 既存の `peer-leave` メッセージ受信時も即座にアバターを削除する
- ピアが XR セッションを抜けて `mode: "desktop"` に切り替わった場合は、そのまま新しい `mode` で送り続けてよい（受信側は表示形態を切り替える）

### 自己メッセージの扱い

サーバはエコーバックしてもよいが、**受信側は `peerId === 自分の peerId` のメッセージを必ず破棄する**こと。これは将来サーバの実装が変わっても安全に動作させるための規約。

### サーバ側の責務

- 同一ルームの他ピアにそのままリレーするのみ
- ルーム状態（`scene-state` 応答）には**含めない**
- レート制限：ピアあたり 30Hz を超えるメッセージは破棄してよい
- 不正な構造（必須フィールド欠落、配列長不一致）は破棄

### 後方互換性

- このメッセージを実装しないクライアントは `kind === "scene-avatar"` を無視する
- アバター可視化を実装しないクライアントでも、`scene-delta` 等の既存機能はそのまま動作する

---

## 実装ガイドライン

### WebXR クライアント（`scene.js`）

WebXR で本仕様を実装する場合の要点：

**頭の姿勢取得**は `renderer.xr.getCamera()` を使う。これは XR セッション中の合成カメラ（両眼の中央）で、`getWorldPosition` / `getWorldQuaternion` で `local-floor` 基準のワールド座標が得られる。床合わせオフセットを適用した reference space を使っていれば、そのまま spec の座標系要件を満たす。

**手の姿勢取得**は `renderer.xr.getController(0)` / `getController(1)` の `Object3D` から。`visible` プロパティと `connected` / `disconnected` イベントでトラッキング状態を判定し、`active` フラグに反映する。

**送信タイミング**は `renderer.setAnimationLoop((time, frame) => { ... })` 内で `time - lastSent >= 100` のスロットリング。`frame` が無い（非 XR）時はデスクトップカメラで送るか、送信を停止するかを `mode` で切り替える。

**ハンドトラッキング対応**（将来）：本 spec の `left`/`right` は当面コントローラ前提だが、Quest のハンドトラッキングに移行しても同じスキーマで送れる。手のひら中心と前方ベクトルが取れる関節（例：`wrist`）の姿勢を入れる、という規約を将来的に拡張版で追記する想定。

### Unity クライアント

Unity は**左手系・Y-up**なので、送受信時に変換が必要：

- **送信時**: `pos.x *= -1; quat.x *= -1; quat.w *= -1;`（X 軸反転）
- **受信時**: 同じ変換を逆方向に適用

`XR Origin` 配下の `Main Camera`（HMD）と `LeftHand Controller` / `RightHand Controller` の `transform` を使用。`XR Origin` のオフセットを含めたワールド座標で送ること。

### Godot 4 クライアント

Godot 4 は**右手系・Y-up**で Three.js / WebXR と一致するため、座標変換は不要。`XROrigin3D` 配下の `XRCamera3D`、`XRController3D` の `global_transform` から position と quaternion を直接取り出せる。

### デスクトップ（非 XR）クライアント

XR セッション外でもアバターを表示させたい場合は、メインカメラの位置を `head` として送り、`left` / `right` は省略または `active: false` にする。`mode: "desktop"` を必ず設定すること。受信側はモードに応じて手を描画しない、ラベルだけ大きく出すなどの差別化が可能。
