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

## Stereo / VR180 media

`image` / `video` asset は optional metadata で立体視表示を切り替えられる。

```json
{
  "type": "video",
  "source": "url",
  "url": "https://example.com/tour_vr180_sbs.mp4",
  "projection": "vr180",
  "stereoLayout": "sbs"
}
```

| Field | 値 | 意味 |
|---|---|---|
| `projection` | `flat`（既定） | 通常の plane 表示 |
| | `vr180` | 半球ドーム（equirect 180°、正面 -Z、内側から見る） |
| `stereoLayout` | `mono`（既定） | 単眼素材 |
| | `sbs` | 左右並び（左目が左半分） |
| | `tb` | 上下並び（左目が上半分） |

両方省略した場合は従来通りの表示（後方互換）。不正値は既定値に落とす。

### Rendering

- 左目メッシュは three.js layer 1、右目メッシュは layer 2 に置く。
  WebXR では three.js が左右のカメラに layer 1 / 2 を割り当てるため、
  HMD では左右の目に別画像が表示される。
- 非XR（デスクトップ / モバイル）はメインカメラが layer 1 を有効化しており、
  左目画像のみ表示される。
- テクスチャは両目で 1 枚を共有し、目ごとの切り出しはジオメトリの UV に
  焼き込む（GPU アップロードは 1 回。4K 動画でも転送が倍にならない）。
- `flat` + `sbs` / `tb` は片目分のアスペクト比で plane サイズを計算する
  （full SBS / full TB 前提。squashed half 形式は片目が横 / 縦に伸びる）。
- `vr180` は半径 3m の半球ドーム。object の scale で拡大できる。
- layer 0 には選択・raycast 用の不可視 hit proxy を重ねる。
  flat はフルサイズ plane、vr180 はドーム表面そのもの
  （ドームをクリックして選択・移動・削除できる）。
  vr180 ドームは drop の配置 raycast ターゲットからは除外する
  （skybox と同じ扱い。ドーム内から drop してもドーム表面に貼り付かない）。

### 登録 UI

- URL drop / clipboard / メディアURLダイアログ / AI import が対象。
  ファイル drop 画像（carrier GLB 化経路）は未対応。
- ファイル名 / URL の basename をトークン分割して自動判定する:
  - `vr180`, `180`, `180x180` → `projection: vr180`
  - `sbs`, `hsbs`, `fsbs`, `3dh`, `sidebyside`, `leftright` 等 → `stereoLayout: sbs`
  - `overunder`, `topbottom`, `htab`, `ftab`, `3dv` 等 → `stereoLayout: tb`
  - 曖昧な 2 文字トークン `lr` / `ou` / `tb` は誤爆しやすいため、
    `vr180` / `180` / `3d` / `stereo` のいずれかが同居する場合のみ有効
    （例: `scan_lr.png` は 2D、`scan_3d_lr.png` は SBS）
  - `1080p` や `IMG_0180` のような番号は誤検出しない（完全一致トークンのみ）
- 「メディアURLを追加」ダイアログ（desktop: settings chip 🎬 /
  mobile: 追加シート）では形式を明示選択できる。明示指定は自動判定より優先。
  明示的に 2D を選ぶと自動判定も抑止する。
- `vr180` は追加時に position.y を視点高さ（1.6m）まで持ち上げる。

### Content replacement

media-panel への drop / メディアURLダイアログ / AI `replaceMediaFromUrl` で
既存 object の内容を差し替える場合の立体視形式は次の優先順で決まる:

1. 明示指定（ダイアログの形式選択、AI params の `projection` / `stereoLayout`）
2. 新しい URL のファイル名からの自動判定
3. どちらも無ければ既存 asset の形式を維持（差し替えで 2D に落ちない）

明示的に 2D（flat / mono）を指定した場合のみ立体視形式を解除する。

実装: `html/assets/js/scenesync/loaders/stereo-media.js`
（テスト: `npm run test:stereo-media`）

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
