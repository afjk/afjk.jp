# Scene Sync 座標系と visualBasis

Scene Sync の座標系変換、Unity / Web 間の GLB 表示補正、`visualBasis` の扱いをまとめる。

この文書は、Unity 起源 object、Web 起源 object、そのコピー、ブラウザ reload / scene-state 復元で向きがずれないようにするための基準である。

---

## 基本方針

Scene Sync では、transform の座標系変換と、GLB の見た目補正を分けて考える。

1. **Transform coordinate conversion**
   - position / rotation / scale を wire format に変換する処理。
   - Unity は左手系、Web / Three.js は右手系なので変換が必要。

2. **Visual basis correction**
   - GLB の中身が、どの runtime で正しい向きに見える前提で作られたかを補正する処理。
   - `asset.visualBasis` で明示する。

この2つを混ぜると、コピー、reload、scene-state 復元、Unity 再受信時に 180 度ずれが発生しやすい。

---

## Wire coordinate system

Scene Sync の wire format は Web / Three.js / WebXR 側を基準にする。

- 右手系
- Y-up
- `position`, `rotation`, `scale` は wire 上ではこの基準で送る

### Unity

Unity は左手系・Y-up のため、送受信時に変換する。

実装上の詳細はコード側に従うが、重要なのは以下。

- Unity の Transform をそのまま wire に出してはいけない。
- wire から受け取った Transform をそのまま Unity Transform に入れてはいけない。
- ただし、この変換は object の見た目の前向き補正とは別問題である。

### Web / Three.js

Web / Three.js は wire format と同じ基準として扱う。

- Web から送る transform は原則そのまま wire format。
- Web が受け取る transform も原則そのまま Three.js object に適用する。

---

## `asset.visualBasis`

`asset.visualBasis` は、GLB の見た目がどの runtime の基準で作られているかを表す metadata である。

現在の値:

```text
undefined / omitted:
  Web basis として扱う。従来の Web 由来 GLB / primitive / image / text など。

"unity":
  Unity Editor から export / publish された GLB。
  Web 側で表示するときに Unity basis correction が必要。
```

将来的には Godot / Unreal / Blender などの追加もあり得る。

```text
"godot"
"unreal"
"blender"
```

ただし、追加する場合も `origin` ではなく `visualBasis` で判断する。

---

## `origin` と `visualBasis` の違い

`origin` と `visualBasis` は別概念である。

| field | 意味 | 例 |
|---|---|---|
| `origin` | その object が現在どこ由来の Scene Sync object として扱われるか | `Unity`, `Remote` |
| `visualBasis` | GLB の見た目補正をどの基準で行うか | `unity`, omitted |

重要なルール:

- 表示補正は `origin` で決めない。
- 表示補正は `visualBasis` で決める。
- Web でコピーされた Unity 起源 GLB は、`origin` が Remote になっても `visualBasis: "unity"` を保持する。
- Unity Editor で制作された原本保護は `origin` / `temporary` の責務。
- GLB の向き補正は `visualBasis` の責務。

---

## Unity basis correction

Unity から export された GLB は、そのまま Web / Three.js に読み込むと前向きが 180 度ずれるケースがある。

そのため Web 側では、`asset.visualBasis === "unity"` の GLB に限って、表示用 root に Unity basis correction を適用する。

ルール:

```text
Web client:
  if asset.visualBasis === "unity":
    GLB visual root に Unity basis correction を適用する
  else:
    GLB visual root には補正しない
```

この補正は、object の wire transform そのものを書き換えるものではない。

---

## コピー時のルール

コピー / ペーストでは、見た目に関わる asset metadata を保持する。

保持すべきもの:

- `asset.type`
- `asset.source`
- `asset.url`
- `asset.meshPath`
- `asset.assetId`
- `asset.visualBasis`
- GLB animation metadata
- その他、復元に必要な asset metadata

特に `asset.visualBasis` を落としてはいけない。

### Unity 起源 GLB を Web でコピーした場合

```text
Unity publish
  -> asset.visualBasis = "unity"
  -> Web 表示時に Unity basis correction

Web copy / paste
  -> 新しい objectId
  -> origin は Web / Remote 扱いでよい
  -> asset.visualBasis = "unity" を保持
  -> Web 表示時に同じ Unity basis correction
  -> Unity 受信時も visualBasis を見て整合した表示にする
```

`origin` が変わっても `visualBasis` は変えてはいけない。

---

## reload / scene-state 復元時のルール

ブラウザ reload や新規参加者への scene-state 応答でも、`visualBasis` を保持する。

必要な箇所:

- Web の local snapshot / IndexedDB snapshot
- Web の `scene-state` 生成
- Unity Editor の `scene-state` 生成
- Unity Runtime の `scene-state` 生成がある場合
- copy / paste payload
- asset cache record

### よくない例

```json
{
  "kind": "scene-state",
  "objects": {
    "micro-orc": {
      "asset": {
        "type": "mesh",
        "meshPath": "abc123"
      }
    }
  }
}
```

Unity 起源 GLB なのに `visualBasis` が落ちているため、復元後に Web 側で補正されず 180 度ずれる。

### よい例

```json
{
  "kind": "scene-state",
  "objects": {
    "micro-orc": {
      "asset": {
        "type": "mesh",
        "meshPath": "abc123",
        "visualBasis": "unity"
      }
    }
  }
}
```

---

## Unity client 側の扱い

Unity 側では、Web から受信した mesh object を表示する際にも `asset.visualBasis` を見る。

基本方針:

- `visualBasis` が omitted の Web basis GLB は、Unity 側で既存の Web basis import 補正を使う。
- `visualBasis: "unity"` の GLB は、Unity 起源の見た目として扱う。
- Unity Editor 原本 object かどうかの判断は `origin` / `temporary` / managed object 側で行う。
- GLB import root の 180 度補正を `origin` だけで決めない。

---

## テストケース

以下を最低限の回帰テストケースとする。

### Case 1: Unity 起源 -> Web 表示

1. Unity Editor から micro_orc / micro_knight を publish。
2. Web で表示。
3. Unity と Web で前向きが一致する。

期待:

- `asset.visualBasis === "unity"`
- Web で Unity basis correction が適用される。

### Case 2: Web 起源 -> Unity 表示

1. Web から GLB を追加。
2. Unity で受信。
3. Web と Unity で前向きが一致する。

期待:

- `asset.visualBasis` は omitted または Web basis。
- Unity 側で Web basis import として扱う。

### Case 3: Unity 起源 -> Web copy -> Web 表示

1. Unity 起源 object を Web でコピー / ペースト。
2. Web 上で元 object と copy の向きが一致する。

期待:

- copy 後も `asset.visualBasis === "unity"`。
- `origin` が変わっても補正は変わらない。

### Case 4: Unity 起源 -> Web copy -> Unity 表示

1. Unity 起源 object を Web でコピー / ペースト。
2. Unity で copy object を受信。
3. Unity 上で元 object と copy object の向きが一致する。

期待:

- copy object の `origin` は Remote でもよい。
- copy object の `visualBasis` は `unity` のまま。

### Case 5: Unity 起源 -> Web reload

1. Unity 起源 object を Web で表示。
2. Web を reload。
3. scene-state / snapshot から復元。
4. reload 前後で向きが変わらない。
5. 不要な internal object が増えない。

期待:

- scene-state に `visualBasis: "unity"` が含まれる。
- internal hierarchy / SceneSyncManager は scene-state に含めない。

### Case 6: Unity 起源 -> Web copy -> Web reload

1. Unity 起源 object を Web でコピー。
2. Web を reload。
3. 元 object と copy object の向きが reload 前後で一致する。

期待:

- copy object の snapshot / scene-state にも `visualBasis: "unity"` が残る。

---

## 実装上の注意

- `visualBasis` は asset metadata なので、transform の rotation に焼き込まない。
- copy / paste 時に asset object を浅く作り直す場合、`visualBasis` を落としやすいので注意する。
- IndexedDB snapshot / asset cache / scene-state 生成で asset object を再構築する場合も同様。
- `origin === Unity` なら補正、という実装に戻さない。
- `origin === Remote` なら補正しない、という実装にも戻さない。
- 補正判断は `asset.visualBasis` を single source of truth にする。

---

## 関連ドキュメント

- [Scene Sync Spec Index](./scene-sync-spec.md)
- [Unity オーサリングモデル](./scene-sync-unity-authoring.md)
- [Asset / cache / blob store](./scene-sync-assets-and-cache.md)
