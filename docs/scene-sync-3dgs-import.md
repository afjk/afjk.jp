# SceneSync 3DGS Import（PLY / SPZ → KHR GLB）

Issue: #531

## 方針

SceneSync内部・交換用のGaussian Splat表現は **GLB + `KHR_gaussian_splatting`** に統一する。
一般的な3DGS配布形式（`.ply` / `.spz`）はImport時にこのGLBへ正規化し、
SceneDocument / asset cache / Export以降は通常のGLBと同じ経路で扱う。

```text
.ply ─┐
      ├─→ SplatCloud ─→ KHR_gaussian_splatting GLB ─→ SceneSync既存GLB経路
.spz ─┘
.glb（KHR）───────────→ 検証のみ、バイト列はそのまま
```

## 実装

`html/assets/js/scenesync/loaders/gaussian-splat/`

| ファイル | 役割 |
| --- | --- |
| `splat-cloud.js` | 中間表現 `SplatCloud` と SH / quaternion ユーティリティ |
| `ply-splat-reader.js` | INRIA形式 3DGS PLY のパーサ |
| `spz-splat-reader.js` | Niantic SPZ v1〜v3 のデコーダ |
| `khr-glb-writer.js` | `SplatCloud` → KHR GLB のシリアライザ |
| `import-gaussian-splat.js` | 形式判定を含むエントリポイント |

外部依存はゼロ。Node / ブラウザ双方でそのまま動作する。

```js
import { importGaussianSplatAsset } from './loaders/gaussian-splat/import-gaussian-splat.js';

const { glb, splatCount, shDegree, sourceFormat } =
  await importGaussianSplatAsset(arrayBuffer, { fileName: file.name });
```

CLI:

```bash
node scripts/convert-gaussian-splat.mjs capture.ply out.glb
node scripts/convert-gaussian-splat.mjs capture.spz --flip-up
```

## 中間表現 `SplatCloud`

すべての値を **KHR_gaussian_splatting の規約に揃えた状態** で保持する。
つまりReader側で活性化関数を適用済みにし、Writerは変換を持たない。

| フィールド | 内容 |
| --- | --- |
| `positions` | `count * 3` |
| `rotations` | `count * 4`、**xyzw**、正規化済み |
| `scales` | `count * 3`、**線形**（標準偏差） |
| `opacities` | `count`、**線形alpha 0..1** |
| `sh0` | `count * 3`、degree 0 SH **係数**（RGBではない） |
| `shRest` | `count * coefs * 3`、係数major / チャンネルminor |

## 形式ごとの変換

### PLY（INRIA 3DGS）

| PLYプロパティ | 変換 | KHR |
| --- | --- | --- |
| `x, y, z` | そのまま | `POSITION` |
| `scale_0..2` | `exp()` | `SCALE`（線形） |
| `opacity` | `sigmoid()` | `OPACITY`（線形alpha） |
| `rot_0..3` | **wxyz → xyzw** + 正規化 | `ROTATION` |
| `f_dc_0..2` | そのまま | `SH_DEGREE_0_COEF_0` |
| `f_rest_0..N` | チャンネルmajor → 係数major | `SH_DEGREE_{d}_COEF_{j}` |

`f_rest` のレイアウトが最も間違えやすい。degree 3（45係数）の場合、
インデックス `0..14` が R、`15..29` が G、`30..44` が B で、
各チャンネル内で degree 1 が slot `0..2`、degree 2 が `3..7`、degree 3 が `8..14` を占める。
つまり degree 1 の係数0は `f_rest_0 / f_rest_15 / f_rest_30` の3つになる。

対応formatは `binary_little_endian` / `binary_big_endian` / `ascii`。

### SPZ（Niantic）

gzipを解いた後、16バイトヘッダに続いて属性ごとのセクションが並ぶ。

| セクション | エンコード |
| --- | --- |
| positions | v1: half float / v2,v3: 24bit符号付き固定小数（`fractionalBits`） |
| alphas | `byte / 255`（線形） |
| colors | `sh0 * 0.15 + 0.5` を8bit量子化 → 逆算してSH係数へ戻す |
| scales | `(log(s) + 10) * 16` を8bit量子化 |
| rotations | v1,v2: xyz 3バイト（wは復元） / v3: smallest-three 32bitパック |
| sh | `(byte - 128) / 128`、係数major |

`flags` bit 0 が antialiased、bit 7 が LOD。
antialiased は GLB の extension に `antialiased: true` として引き継ぐ。

## 座標系の扱い

**既定では座標変換を行わない。**

PLYもSPZも「どちらが上か」をファイル内に記録しないため、自動で軸を入れ替えると
正しい向きのアセットを壊す。COLMAP由来のキャプチャはY-downであることが多いが、
これはファイルからは判別できない。

そのため補正は明示的なオプションとし、かつ **splatデータ自体は書き換えず、
glTF nodeのrotationとして書く**。データはバイト等価のまま保たれ、後から取り消せる。

```js
await importGaussianSplatAsset(bytes, { upAxisCorrection: 'flip-x-180' });
// → nodes[0].rotation = [1, 0, 0, 0]（X軸180度）
```

## 非対応variantの扱い

解釈が曖昧な入力は、黙って劣化させずに理由付きで失敗させる。

| variant | 挙動 |
| --- | --- |
| 通常の点群 / メッシュPLY | `UnsupportedPlyVariantError('not-gaussian-splat')`、不足プロパティを列挙 |
| SuperSplat / PlayCanvas圧縮PLY | `UnsupportedPlyVariantError('compressed-chunked')` |
| listプロパティを含むPLY | `UnsupportedPlyVariantError('list-properties')` |
| `f_rest` が不連続 | `UnsupportedPlyVariantError('sparse-f-rest')` |
| SPZ v4以降 | `UnsupportedSpzError('version')` |
| 破損・切り詰めファイル | 必要バイト数を含むエラー |
| KHR拡張を持たないGLB | 明示的に拒否 |

`KHR_gaussian_splatting_compression_spz_2` は未対応。
標準化が固まった段階で、SPZを解凍せずGLBへ埋め込む経路として再検討する。

## テスト

```bash
npm run test:3dgs-import   # PLY / SPZ / Writer / round-trip
npm run test:3dgs-khr      # KHR GLB inspector
```

主要な検証項目:

- 活性化関数（log scale、opacity logit、quaternion順序）が正しく適用されること
- `f_rest` のチャンネルmajor → 係数major変換
- SPZ v1 half float、v2 固定小数（負値の符号拡張含む）、v3 smallest-three
- 出力GLBが `inspectGaussianSplatGlb()` を通ること、ヘッダ長がファイル長と一致すること
- **同一シーンをPLYとSPZで表現した場合に、両者が量子化誤差内で一致すること**
  （2つの独立したデコード経路の相互検証）

fixture生成:

```bash
node scripts/generate-gaussian-splat-import-fixtures.mjs
```

`ring-gaussian-splats.{ply,spz,glb}`（16 splats / degree 1 SH）を生成する。
GLBはImporterを通して生成しているため、browser smokeでも実際の変換結果を確認できる。

## 残課題

- 実キャプチャ（数十万〜数百万splat）でのメモリ・処理時間の測定
- ブラウザ実描画での見た目の一致確認（Three.js正式リリース待ち、#526 / #527）
- D&D UIへの接続（#531のUI側、#527のSceneDocument統合後）
- 大容量アセットのasset cache / blob経路（#528）
