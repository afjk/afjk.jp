# afjk.jp — Claude Code ガイド

## Scene Sync

ブラウザ / Unity / Godot 間で 3D シーンをリアルタイム共有するシステム。

- ビューア: `html/scenesync/index.html` + `html/assets/js/scenesync/scene.js`
- サーバー: `apps/presence-server/src/server.mjs`
- テスト: `apps/presence-server/tests/api.test.mjs`
- 仕様: `docs/scene-sync-spec.md`

### REST API

```bash
# シーンにオブジェクトを追加
curl -s -X POST "http://localhost:8787/api/room/{room}/broadcast?name=Claude" \
  -H "Content-Type: application/json" \
  -d '{"kind":"scene-add","objectId":"box-1","asset":{"type":"primitive","primitive":"box","color":"#4488ff"},"position":[0,0.5,0],"rotation":[0,0,0,1],"scale":[1,1,1]}'

# 現在のシーン状態を取得
curl -s "http://localhost:8787/api/room/{room}/scene?name=Claude"
```

### broadcast メッセージ種別

#### scene-add
```json
{
  "kind": "scene-add",
  "objectId": "box-1",
  "name": "My Box",
  "position": [0, 0.5, 0],
  "rotation": [0, 0, 0, 1],
  "scale": [1, 1, 1],
  "asset": { "type": "primitive", "primitive": "box", "color": "#4488ff" }
}
```

asset.primitive の選択肢: `box`, `sphere`, `cylinder`, `cone`, `plane`, `torus`

#### scene-delta
```json
{
  "kind": "scene-delta",
  "objectId": "box-1",
  "position": [1, 0.5, 0],
  "rotation": [0, 0, 0, 1],
  "scale": [1, 1, 1]
}
```

#### scene-remove
```json
{ "kind": "scene-remove", "objectId": "box-1" }
```

#### scene-env（環境光の切り替え）
```json
{
  "kind": "scene-env",
  "envId": "studio | outdoor_day | outdoor_sunset | outdoor_night | indoor_warm"
}
```

broadcast すると全クライアントが HDRI 環境光を切り替える。
`scene-state` にも `envId` を含めるため、後から参加したクライアントにも反映される。

HDRI ファイルは Poly Haven（CC0）から取得し `html/assets/hdri/{envId}.hdr` に配置。

```bash
curl -s -X POST "http://localhost:8787/api/room/ai-test/broadcast?name=Claude" \
  -H "Content-Type: application/json" \
  -d '{"kind":"scene-env","envId":"outdoor_night"}'
```

### テスト実行

```bash
cd apps/presence-server && node --test tests/api.test.mjs
```

# Scene Sync AI 操作

## 概要
Scene Sync は3Dシーン共同編集ツール。REST API 経由でシーンを操作できる。
ユーザーの自然言語の指示をAPIリクエストに変換してシーンを構築する。

## 環境
- staging: https://staging.afjk.jp/presence/api
- 本番: https://afjk.jp/presence/api
- ローカル: http://localhost:8787/api

環境が未指定の場合はユーザーに確認する。

## ルーム
ルームIDが未指定の場合はユーザーに確認する。

## エンドポイント

シーン取得:
GET {BASE}/room/{roomId}/scene?name=Claude

シーン操作:
POST {BASE}/room/{roomId}/broadcast?name=Claude
Content-Type: application/json

## 操作コマンド

### オブジェクト追加 (scene-add)
```json
{
  "kind": "scene-add",
  "objectId": "(一意のID、例: booth-1, wall-left, stage-main)",
  "name": "(日本語の表示名)",
  "position": [x, y, z],
  "rotation": [0, 0, 0, 1],
  "scale": [sx, sy, sz],
  "asset": {
    "type": "primitive",
    "primitive": "box | sphere | cylinder | cone | plane | torus",
    "color": "#hex"
  }
}
```

### オブジェクト移動 (scene-delta)
```json
{
  "kind": "scene-delta",
  "objectId": "(対象ID)",
  "position": [x, y, z],
  "rotation": [qx, qy, qz, qw],
  "scale": [sx, sy, sz]
}
```

### オブジェクト削除 (scene-remove)
```json
{
  "kind": "scene-remove",
  "objectId": "(対象ID)"
}
```

### 環境光の切り替え (scene-env)
```json
{
  "kind": "scene-env",
  "envId": "studio | outdoor_day | outdoor_sunset | outdoor_night | indoor_warm"
}
```

## 座標系
- Y-up、メートル単位
- position の y はオブジェクトの中心
- 高さ1mのboxを床に置くなら y=0.5
- 床面は y=0

## 作業手順
1. まず GET scene で現在のシーン状態を取得する
2. 既存オブジェクトの把握をしてから操作を行う
3. ユーザーの指示に応じて scene-add / scene-delta / scene-remove を送信する
4. 大量のオブジェクトを追加する場合は curl を連続実行する

## 空間設計のガイドライン
- LBE（Location-Based Entertainment）の展示空間が主な用途
- 来場者の動線を考慮した配置にする
- 床を最初に配置し、次に壁、家具、装飾の順に構築する
- オブジェクト同士が重ならないようにする
- 人間のスケール感を意識する（ドアの高さ2m、テーブル0.75m、椅子0.45m等）
- 色はゾーニングが分かるように使い分ける
- 環境光はシーンの用途に合わせて選ぶ（屋内展示なら studio、屋外イベントなら outdoor_day 等）
