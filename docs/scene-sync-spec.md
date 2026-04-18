# afjk.jp/pipe — Scene Sync 技術仕様

Unity Editor とWebブラウザ間で3Dシーンをリアルタイム共有する機能。
既存の pipe のルーム機能・presence-server・piping-server をそのまま活用する。

---

## 概要

| 項目 | 内容 |
|------|------|
| Webビューア | `html/pipe/scene.html` + `html/assets/js/pipe/scene.js` |
| Unity側 | Editor拡張プラグイン（UPMパッケージ、別リポジトリ） |
| 3D描画 | Three.js + GLTFLoader + TransformControls |
| 通信 | presence-server（handoff broadcast）+ piping-server（glB転送） |
| 新規サーバー | なし（presence-server に `type: "broadcast"` を1件追加するのみ） |

---

## アーキテクチャ

    Unity A ──┐                              ┌── Browser X
    Unity B ──┼── WSS ── presence-server ─── WSS ──┼── Browser Y
              │         (既存 room)          │
              └── HTTP ── piping-server ─────┘
                         (glB転送)

全クライアントが同じルームに参加し、handoff broadcast でメッセージを交換する。

---

## presence-server 変更

`type: "broadcast"` を追加。同室の全クライアント（送信者除く）に payload を配信する。

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

`meshPath` がある場合、`https://pipe.afjk.jp/<meshPath>` から glB を取得する。

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

ジオメトリが変わった場合、glBを piping-server にアップロードした後に通知する。

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

### `scene-request`（状態リクエスト）

新規参加者がルーム内の既存メンバーにシーン状態を要求する。

    {
      "kind": "scene-request"
    }

受信したクライアントのうち1台が `scene-state` を broadcast で返す。

---

## glB 転送（piping-server 経由）

メッシュデータは piping-server の既存 HTTP 転送を使う。

    送信側: PUT https://pipe.afjk.jp/<random-path>  (Content-Type: model/gltf-binary)
    受信側: GET https://pipe.afjk.jp/<random-path>

piping-server は 1対1 転送のため、受信者N人に対してN回PUTする。
各受信者に専用の `meshPath` を handoff で通知する。

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

---

## ファイル配置

    afjk.jp/
    ├── html/
    │   ├── pipe/
    │   │   ├── index.html          # 既存 pipe UI
    │   │   └── scene.html          # 新規: 3Dビューア
    │   └── assets/js/pipe/
    │       ├── app.js              # 既存
    │       ├── stream.js           # 既存
    │       ├── swarm.js            # 既存
    │       └── scene.js            # 新規: シーン同期ロジック
    ├── apps/
    │   └── presence-server/
    │       └── src/server.mjs      # broadcast 追加
    └── docs/
        ├── pipe-spec.md            # 既存
        └── scene-sync-spec.md      # 新規: この文書

---

## UI 方針

`scene.html` は 1ページ完結のビューア。

- 画面全体が Three.js の 3D ビューポート
- 右上にルーム接続状態バッジ（接続中 / 人数）
- ダブルクリックでオブジェクト選択 → TransformControls で移動/回転/スケール
- キーボード W / E / R で移動/回転/スケール切り替え
- `?room=<code>` パラメータで pipe と同じルームに参加

URL 例: `https://afjk.jp/pipe/scene.html?room=abc123`

---

## 競合解決

Last-Writer-Wins を採用。同一オブジェクトの同時編集は後着が勝つ。
将来的に `scene-lock` / `scene-unlock` による排他制御を追加する。
