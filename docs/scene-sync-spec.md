# afjk.jp/pipe — Scene Sync 技術仕様

Unity Editor / Unity Runtime とWebブラウザ間で3Dシーンをリアルタイム共有する機能。
既存の pipe のルーム機能・presence-server をそのまま活用する。

---

## 概要

| 項目 | 内容 |
|------|------|
| Webビューア | `html/scenesync/index.html` + `html/assets/js/scenesync/scene.js` |
| Unity側 | Editor 拡張（`SceneSyncWindow`）+ Runtime パッケージ（`SceneSyncManager`）|
| UPMパッケージ | `com.afjk.scene-sync`（upm.afjk.jp）、依存: `com.unity.cloud.gltfast@6.0.0` |
| 3D描画 | Three.js + GLTFLoader / GLTFExporter + TransformControls |
| 通信 | presence-server（handoff broadcast）+ presence-server blob store（glB保存）|
| 新規サーバー | なし（presence-server に `type: "broadcast"` と `/blob/` エンドポイントを追加）|

---

## アーキテクチャ

    Unity A ──┐                              ┌── Browser X
    Unity B ──┼── WSS ── presence-server ─── WSS ──┼── Browser Y
              │         (既存 room)          │
              └── HTTP POST/GET ─────────────┘
                    presence-server /blob/
                    (glB ファイル保存・取得)

全クライアントが同じルームに参加し、handoff broadcast でメッセージを交換する。  
glB メッシュデータは presence-server の blob store に一度アップロードし、全クライアントが GET で取得する（1対多対応）。

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

### `scene-add`（オブジェクト追加）

    {
      "kind": "scene-add",
      "objectId": "obj-002",
      "name": "Sphere",
      "position": [0, 0, 0],
      "rotation": [0, 0, 0, 1],
      "scale": [1, 1, 1],
      "meshPath": "def67890"
    }

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
    │       └── src/server.mjs          # broadcast + blob store 追加
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
