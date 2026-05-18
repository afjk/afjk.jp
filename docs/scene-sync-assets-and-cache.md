# Scene Sync Asset / Blob / Cache Spec

Scene Sync の GLB 転送、blob store、IndexedDB cache、期限切れ asset 復元の仕様をまとめる。

---

## Asset model

Scene Sync object は `asset` metadata によって表示内容を決める。

代表的な asset type:

- `primitive`
- `mesh`
- `image`
- `video`
- `audio`（将来）
- `assetbundle`（将来）

---

## `primitive`

```json
{
  "type": "primitive",
  "primitive": "box",
  "color": "#4488ff"
}
```

対応 primitive:

- `box`
- `sphere`
- `cylinder`
- `cone`
- `plane`
- `torus`

---

## `mesh`

GLB / glTF 系 asset を扱う。

### Carrier GLB

```json
{
  "type": "mesh",
  "source": "carrier",
  "meshPath": "abc12345",
  "assetId": "sha256-..."
}
```

`source` omitted の場合は後方互換のため `carrier` とみなす。

### URL GLB

```json
{
  "type": "mesh",
  "source": "url",
  "url": "https://example.com/model.glb"
}
```

Web client は drag-and-drop で `.glb` URL を受け付ける。

制限:

- `.glb` のみ。
- `.gltf` と外部 buffer / texture の組み合わせは未対応。
- CORS header が必要。
- size limit は server / client の設定に従う。

### `visualBasis`

Unity から publish された GLB では、asset metadata に `visualBasis: "unity"` を含める。

```json
{
  "type": "mesh",
  "source": "carrier",
  "meshPath": "abc12345",
  "assetId": "sha256-...",
  "visualBasis": "unity"
}
```

`visualBasis` は asset の見た目補正を決める重要な metadata なので、copy / paste、scene-state、snapshot、cache で保持する。

詳細は [座標系と visualBasis](./scene-sync-coordinate-system.md) を参照。

---

## `image`

### URL image

```json
{
  "type": "image",
  "source": "url",
  "url": "https://example.com/reference.jpg"
}
```

Web client は画像 URL の drag-and-drop を受け付け、textured plane として表示する。

対応形式:

- `png`
- `jpg`
- `jpeg`
- `webp`
- `gif`
- `avif`
- `bmp`

SVG は XSS risk のため非対応。

### File image

画像 file drop は、内部で自動縮小・最適化したうえで carrier GLB に変換し、blob store 経由で共有する。

目的:

- スマホで撮った画像をそのまま追加できるようにする。
- 大きすぎる画像を単純に拒否しない。
- 表示・アップロード・同期の負荷を下げる。

基本方針:

- UI では file 選択直後に loading / processing 表示を出す。
- 必要に応じて canvas / image bitmap で縮小する。
- texture plane / carrier GLB 化して既存の mesh flow に流す。

---

## `video`

```json
{
  "type": "video",
  "source": "url",
  "url": "https://example.com/video.mp4"
}
```

Web client は video URL を textured plane として表示する。

対応形式:

- `mp4`
- `webm`
- `mov`
- `m4v`

現状:

- muted / loop / autoplay を前提。
- play / pause / seek の同期は未実装。
- HLS / DASH は未対応。

---

## Text file

Web client は `.txt`, `.md`, `.markdown` を carrier GLB に変換して表示する。

- Canvas に rasterize。
- Textured plane として GLB 化。
- Protocol 上は通常の `mesh` と同じ扱い。

Markdown は Phase 1 subset:

- headings: `#`, `##`, `###`
- bullet: `-`, `*`
- horizontal rule: `---`
- inline bold marker は除去し、heading などで表現する。

---

## Blob Store

GLB などの binary asset は presence-server の blob store に一時保存する。

| Method | Path | 内容 |
|---|---|---|
| POST | `/blob/:id` | GLB をアップロード |
| GET | `/blob/:id` | GLB をダウンロード |
| DELETE | `/blob/:id` | GLB を削除 |

運用上の性質:

- 永続ストレージではない。
- TTL 付きの一時 blob store。
- Scene Sync の room state を server に保存する目的では使わない。
- debug / ops 用 backup は別扱い。

---

## IndexedDB asset cache

Web client は GLB asset を IndexedDB に保存する。

目的:

- 同じ GLB を再配置したときに再ロードを避ける。
- blob TTL 切れ後も、ローカルに同じ asset があれば復元する。
- 後から入った参加者が、他 peer へ asset request する前に local cache を試せるようにする。

Store:

```text
Database: scene-sync-assets
Store: assets
Key: assetId
```

Record:

```json
{
  "assetId": "sha256-...",
  "meshPath": "abc12345",
  "blob": "<Blob>",
  "size": 1024000,
  "mime": "model/gltf-binary",
  "createdAt": 1770000000000,
  "lastUsedAt": 1770000000000,
  "source": "carrier"
}
```

`assetId` は SHA-256 由来の安定 ID とする。

```text
assetId = "sha256-" + hex(SHA-256(arrayBuffer))
```

---

## Solo room restore

room に自分 1 人しかいない状態で browser reload すると、server から scene-state を得られない。

その場合は、直近の local scene snapshot が IndexedDB に残っていれば復元する。

方針:

- roomId ごとに snapshot を保存する。
- reload 後、scene が空で、かつ既存 peer から scene-state を得られない場合に復元する。
- 既に room に object がある場合は、local snapshot restore をしない。
- snapshot restore でも asset metadata を保持する。
- 特に `asset.visualBasis` を落とさない。

---

## Expired carrier GLB recovery

Blob Store の TTL が切れると、`meshPath` が 404 になる。

その場合は、既に asset を持っている peer から FileTransfer 経由で回収する。

```text
requester
  -> GLB fetch 404
  -> local cache lookup
  -> scene-asset-request
  -> responder cache lookup
  -> FileTransfer .glb send
  -> requester receive
  -> hash / size verify
  -> load GLB
  -> IndexedDB cache put
```

### `scene-asset-request`

```json
{
  "kind": "scene-asset-request",
  "requestId": "unique-request-id",
  "objectId": "obj-123",
  "assetId": "sha256-abc...",
  "meshPath": "blob-path",
  "expectedSize": 1024000
}
```

Responder は `assetId` を優先して cache lookup する。なければ `meshPath` fallback。

---

## Recovery constraints

Responder:

- active send は同時 1 件まで。複数 request は queue（最大 8）に積み、順番に処理。
- 同一 asset への応答には cooldown を設ける。
- 500MB 超過など、client / server limit を超えるものは無視する。
- requestId 重複は一定時間無視する。
- 復元対象の object が現在 scene に存在していなくても、asset cache に blob があれば応答する。

Receiver:

- file handoff に含まれた `recoveryRequestId` で pending recovery を特定する。
- matching しない場合は fallback として `fromPeerId` で探す。
- pending recovery がない file は無視する。
- `assetId` が指定されていれば hash 検証する。
- `expectedSize` があれば size 検証する。
- MIME が GLB として妥当でない場合は無視する。
- file fetch は retry を含む（最大 4 回、delay: 0ms, 500ms, 1500ms, 3000ms）。

---

## Recovery states

当データの復元フロー中、以下の visual states が表示される。

### `loading`

通常の GLB fetch 中。中立的な見た目 + animation。

### `recovering`

blob fetch が 404 になり、peer recovery を開始した状態。

- オレンジ色の placeholder cube。
- pulsing animation（処理中であることを表現）。
- text label や retry button はない。
- timeout or peer exhausted で failed になるまで継続。

### `failed`

local cache と peer recovery のどちらにも asset がない最終失敗状態。

- 赤色の placeholder cube。
- animation なし（停止状態を表現）。
- text label や retry button はない。
- metadata（position / rotation / scale など）は保持される。

---

## Recovery sources

Scene Sync では以下の source からのみ GLB 復元を行う。

1. **自分の browser local cache（IndexedDB）**
   - TTL 切れ後、ローカルに blob があれば復元。
   - 再度参加時にも自動的に lookup。

2. **active peer の cache**
   - 同じ room に現在参加中の peer が、その asset を IndexedDB に持っていれば request / receive。
   - responder が object を scene に持っていなくても、cache に blob があれば応答。

### 復元不可のケース

以下の場合、asset は復元不可。

- local cache にもなく、active peer にも cache がない。
- Wasabi backup など、long-term backup storage からは復元しない。
- production debug backup は operational investigation 用であり、user-facing restore path ではない。

---

## Debug / backup

Scene Sync はユーザー向けの永続ストレージ機能を提供しない。

ただし、不具合調査・運用保護のために、production では private な debug / ops 用 GLB backup を持つ場合がある。

方針:

- ユーザーに公開しない。
- 永続 scene storage として扱わない。
- retention を設定する。
- production では保存先と制限を明示設定する。
- 開発者モード / staging などでは backup 対象外にできる。

---

## 関連ドキュメント

- [Scene Sync Spec Index](./scene-sync-spec.md)
- [API / Protocol](./scene-sync-api-protocol.md)
- [座標系と visualBasis](./scene-sync-coordinate-system.md)
