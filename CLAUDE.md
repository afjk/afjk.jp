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
