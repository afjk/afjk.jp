# Scene Sync Web UI / UX Spec

Scene Sync Web client の UI / UX 方針と、最近追加した制作支援機能をまとめる。

---

## 基本方針

Scene Sync Web は、軽量な共有 3D editor / DevTool として扱う。

重視すること:

- すぐ試せる。
- account / auth / project 作成なしで使える。
- drag-and-drop で直感的に asset を置ける。
- 共同編集・AI 操作・Unity オーサリング補助に使える。
- LBE / MR 制作で、現実との位置合わせや空間調整を素早く試せる。

---

## Mobile UI

スマホ画面では、操作ボタンを必要なものに絞る。

方針:

- pipe button は Scene Sync UI から削除する。
- paste button は押したら即 paste する。
- skybox 削除 button は、skybox が設定されている場合のみ表示する。
- file 選択は `画像を追加` ではなく `ファイルを追加` とする。
- file input は GLB / image / text など Scene Sync が扱える file を選択できるようにする。
- 画像追加時は、重い処理に入る前に loading / processing 表示を出す。

---

## Drag and Drop placement

### Hit placement

D&D で image / GLB / text などを追加する場合、raycast が mesh に hit したら hit point に配置する。

### Surface normal alignment

wall / floor などに配置するときは、hit mesh の normal を使って配置方向を決める。

方針:

- floor では上向きに置く。
- wall では壁面に沿って置く。
- 画像 plane は壁に貼ったときに面が見える向きにする。
- ただし、画像を skybox にしたい intent と floor hit が競合しないようにする。

### Z-fighting offset

hit surface と完全に同一面に置くと z-fighting が発生するため、surface normal 方向に少しだけ offset する。

目的:

- 壁に貼った画像がちらつかない。
- floor に敷いた map image がちらつかない。

### No-hit fallback

何も hit しなかった場合、遠くに生成せず、camera 前方の近い位置に置く。

目安:

```text
camera forward 1.5m
```

ただし、floor helper / default grid がある場合は、先に floor hit を試す。

---

## Default floor / grid

D&D や stamp mode では、床が広いほうが扱いやすい。

方針:

- default grid / floor は hit target にする。
- floor が不要な用途もあるため、将来的には有効 / 無効を切り替えられるとよい。
- floor 外れ時に目の前へ fallback する挙動は便利だが、意図せず大きい object が出ると邪魔になるため、床 hit の成功率を上げる。

---

## Skybox D&D intent

画像を skybox にしたい場合、ユーザーは見上げて D&D することが多い。

このとき、下方向の floor / grid に誤 hit しないようにする。

方針:

- camera / ray direction から skybox intent を判定する。
- skybox intent が強い場合は floor hit を避ける。
- skybox 変更は temporary preview を出してから確定する。

---

## Copy / Paste

### Keyboard shortcut

- `Ctrl+C` / `Cmd+C`: selected object を copy。
- `Ctrl+V` / `Cmd+V`: paste。
- paste は cursor / placement candidate の位置に行う。

### Object copy

コピーでは transform だけでなく、asset metadata も保持する。

保持すべき metadata:

- `asset.type`
- `asset.source`
- `asset.meshPath`
- `asset.assetId`
- `asset.url`
- `asset.visualBasis`
- animation metadata

特に Unity 起源 GLB では `asset.visualBasis` を落としてはいけない。詳細は [座標系と visualBasis](./scene-sync-coordinate-system.md) を参照。

---

## Stamp mode

コピーした object を連続配置するための mode。

想定 UX:

1. object を選択する。
2. `Ctrl+C` / `Cmd+C` で copy。
3. 半透明 preview mesh が cursor / ray hit 位置に表示される。
4. `Ctrl+V` / `Cmd+V` でその位置に配置。
5. mode は継続し、次の配置候補が表示される。
6. `Esc` で preview を消して終了。

用途:

- 草、木、岩、柵、家などを地形に連続配置する。
- 2D map image を床に敷き、その上に 3D object を stamp して空間化する。
- LBE / MR の仮配置を現地で素早く作る。

---

## Multi selection

制作ツールとして使う場合、複数 object の操作が重要になる。

代表用途:

- 複数削除
- 複数移動
- 複数回転
- 複数 scale
- 整列
- 均等配置
- ランダム回転 / scale
- AI / external tool による一括編集

Scene Sync の `scene-batch` は、このような複数操作を 1 操作として扱うために使う。

---

## AI / external tool operation

AI 専用に閉じず、外部ツールが Scene Sync の selection / scene を読み取り、mutation を送れるようにする。

方針:

- 選択中 object を取得できる。
- camera pose / screenshot を取得できる。
- focus / undo / redo / history を操作できる。
- scene mutation は通常の API と同じ payload で送る。
- AI は redeem session によって linked user の操作を代替する。
- AI 操作も linked user の Undo 対象になる。

---

## Smooth transform

複数 object を AI / external tool で配置変更するとき、一瞬で移動すると驚きや演出が弱い。

方針:

- scene-delta に smooth / duration / easing を指定できるとよい。
- 最初は position の smooth move から始める。
- 次に rotation / scale に広げる。
- 将来的には GLB animation / Loomlet graph による制御と統合する。

---

## Dev panel

Dev panel は mobile / desktop ともに中身がはみ出さないようにする。

方針:

- Selected Object JSON は横にはみ出さない。
- 長い JSON は scroll できる。
- panel 全体も viewport 内で扱える。
- debug 情報は制作中に重要なので、見やすさを維持する。

---

## 関連ドキュメント

- [Scene Sync Spec Index](./scene-sync-spec.md)
- [API / Protocol](./scene-sync-api-protocol.md)
- [Asset / cache / blob store](./scene-sync-assets-and-cache.md)
- [座標系と visualBasis](./scene-sync-coordinate-system.md)
