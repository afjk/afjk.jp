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
| `gaussian-splat-file-import.js` | D&D用のFileラッパーとエラーメッセージ |
| `gaussian-splat-worker-import.js` | Worker実行とinline fallback |
| `gaussian-splat-import.worker.js` | Worker本体 |

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
node scripts/convert-gaussian-splat.mjs capture.ply --max-sh-degree 1
```

## D&D Import

`.ply` / `.spz` をSceneSync Editorにドロップすると、変換後のGLBが
**通常のGLBと同じ経路**（upload / broadcast / asset cache / SceneDocument）に流れる。
3DGS専用の同期経路やasset種別は追加していない。

```text
drop capture.ply
  → DragDropManager.handleFile()
  → convertGaussianSplatFileToGlb()      # capture.ply → capture.glb
  → DragDropManager._loadFile()          # 既存のGLB経路
  → glbLoader.loadFromFile() → upload → broadcast
```

実装:

- `gaussian-splat-file-import.js` — File → 変換後GLB File、サイズ上限、日本語エラーメッセージ
- `drag-drop-manager.js` — `isGaussianSplatFile()` 分岐を `isGlbFile()` の前に追加

three.js に依存しないモジュールに変換ロジックを置いているため、
`drag-drop-manager.js`（three依存でNodeからimport不可）と切り離してテストできる。

オブジェクト名にはドロップした元ファイル名（`capture.ply`）を表示し、
uploadされるのは変換後の `capture.glb`。元ファイル情報は `userData.importedFrom` に残す。

### 現在の表示（Three.js r170）

**SceneSync本番のThree.jsはr170で、Gaussian Splattingを描画できない。**

ただし変換後のGLBは r170 の `GLTFLoader` でも**正常にパースできる**ことを確認済み。

| 項目 | r170での結果 |
| --- | --- |
| パース | 成功（エラーなし） |
| 生成されるオブジェクト | `THREE.Points` + `PointsMaterial` |
| KHR attribute | `khr_gaussian_splatting:*` として保持される（小文字化） |
| 見た目 | 1px の白い点群（`size: 1`, `sizeAttenuation: false`） |
| 位置・スケール | 正しい |

つまり現状は「**正しい位置に白い点群として表示される**」状態になる。
Gaussian Splatとしての見た目にはならないが、キャプチャの形状は確認でき、
Transform / 同期 / Export は通常のGLBとして機能する。

Three.js が Gaussian Splatting を含む正式版になり `WebGPURenderer` へ移行すれば（#527）、
**同じGLBが再Import不要でそのままGaussian Splatとして描画される。**

なお `normalizeGlbForSceneSync()` は spec/gloss 拡張が無い場合に
glTF-Transform のパーサへ渡す前に早期returnするため、
`KHR_gaussian_splatting` GLBが未知拡張として弾かれることはない。

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

### Editorでの向き調整はギズモで行う

**Import時の補正にUIは用意しない。** 上下が逆で取り込まれた場合は、
配置後のオブジェクトを既存のTransformControlsで回転させて対応する。

理由:

- 向きの調整は3DGSに限った話ではなく、SceneSyncには既に回転の手段がある
- 配置後の回転は既存のtransform同期にそのまま乗るため、プロトコル変更が要らない
- 再変換・再アップロードが発生しない

`upAxisCorrection` はライブラリ側のオプションとして残す。
バッチ変換で向きを揃えたい場合はCLIから指定できる。

```bash
node scripts/convert-gaussian-splat.mjs capture.ply --flip-up
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

## Three.js標準ローダーとの突き合わせ

SceneSyncが書くGLBは、KHR仕様のSceneSync側の解釈に基づいている。
その解釈が正しいかは、**実際にそれを読む実装に食わせる**以外に確かめようがない。

```bash
node scripts/verify-against-threejs-gaussian-splat.mjs
```

Three.js `dev`（GS実装入り、commit `04d9e4e`）に対して実行した結果:

| case | 入力 | SH degree | 結果 |
| --- | --- | ---: | --- |
| ply-degree-3 | PLY binary LE | 3 | OK |
| ply-degree-0 | PLY binary LE | 0 | OK |
| ply-ascii | PLY ascii | 1 | OK |
| spz-degree-1 | SPZ v2 | 1 | OK |
| spz-degree-3 | SPZ v3（smallest-three） | 3 | OK |
| reduced-to-2 | PLY degree 3 → `maxShDegree: 2` | 2 | OK |
| reduced-to-1 | PLY degree 3 → `maxShDegree: 1` | 1 | OK |
| reduced-to-0 | PLY degree 3 → `maxShDegree: 0` | 0 | OK |

いずれも `GLTFGaussianSplatLoaderExtension` が `GaussianSplat` を生成し、
`splatGeometry` から読み戻したposition / color / alphaが**元のPLY / SPZの入力値と一致**した。
degree 1〜3では `sphericalHarmonics1/2/3` が揃って生成されている。

検証したのはローダーまで。実際のGPU描画（`WebGPURenderer`）は別途必要。

### 一致していた規約

Three.js側の実装（`GaussianSplatUtils.js` / `GLTFGaussianSplatLoaderExtension.js`）と
SceneSync側で、以下がすべて一致していた。

| 規約 | Three.js dev | SceneSync |
| --- | --- | --- |
| `SH_C0` | `0.2820947917738781` | 同値 |
| SH0 → 色 | `coef * SH_C0 + 0.5` | 同式 |
| `OPACITY` | `a * 255`（**線形alpha**） | PLYのlogitにsigmoid適用済み |
| `SCALE` | `Matrix4.compose()` にそのまま渡す（**線形**） | PLYのlogにexp適用済み |
| `ROTATION` | `Quaternion.set(qx,qy,qz,qw)`（**xyzw**） | PLYのwxyzから並べ替え済み |
| degree dの係数数 | `degree * 2 + 1` → 3 / 5 / 7 | `SH_COEFS_PER_DEGREE` と同じ |

Three.js側の要求で、満たしていないと例外になるもの（すべて満たしている）:

- `colorSpace` は**必須**（未指定で例外）
- `kernel` は `ellipse` のみ
- 同一mesh内でGaussianと非Gaussianのprimitive混在は不可
- SH bandは**完全**（degree内の係数が全部揃っている）でなければ例外
- SH bandは**連続**（degree 2があるならdegree 1もある）でなければ例外

なお高次SHは `coef * 128 + 128` で `Uint8ClampedArray` に量子化される。
つまりThree.js側でSH1〜3は8bitに落ちるため、
[-1, 1] を超える係数はクランプされる。これはThree.jsの仕様。

## 性能とメモリ

計測:

```bash
node --expose-gc --max-old-space-size=6144 scripts/benchmark-gaussian-splat-import.mjs
```

Node 22 / 単一スレッドでの実測値（decode + GLB write、gzip解凍は除く）:

| splats | SH | format | source | GLB | decode | write | total | RSS |
| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 200,000 | 0 | ply | 13.0 MB | 10.7 MB | 103 ms | 104 ms | 207 ms | 251 MB |
| 200,000 | 3 | ply | 47.3 MB | 45.0 MB | 274 ms | 476 ms | 750 ms | 624 MB |
| 500,000 | 3 | ply | 118.3 MB | 112.5 MB | 830 ms | 1311 ms | 2140 ms | 1313 MB |
| 1,000,000 | 0 | ply | 64.9 MB | 53.4 MB | 248 ms | 73 ms | 321 ms | 1120 MB |
| 1,000,000 | 3 | ply | 236.5 MB | 225.1 MB | 1118 ms | 2444 ms | 3562 ms | 2556 MB |
| 1,000,000 | 3 | spz | 61.0 MB | 225.1 MB | 1023 ms | 863 ms | 1886 ms | 2661 MB |

読み取れること:

- **SH degree 3がコストを支配する。** degree 0とdegree 3で、同じsplat数でもデータ量が約4倍、
  処理時間が10倍以上になる。degree 3は1 splatあたり45係数 × 3チャンネル = 180 bytes。
- 1M splats / degree 3 で **3.5秒・2.5GB** に達する。メインスレッドで実行すればEditorは確実に固まり、
  ブラウザタブのメモリ上限にも近づく。→ Worker化の根拠。
- SPZの方がsourceは小さい（量子化済み）が、展開後のGLBサイズはPLYと同じ。
  メモリのピークはsourceではなく**展開後のcloud + GLB**で決まる。

### Worker実行

変換はWorkerで実行し、source ArrayBufferとGLBの双方をtransferする（コピーしない）。

```text
main thread                    worker
  file.arrayBuffer()
  ── postMessage(transfer) ──→  importGaussianSplatAsset()
  ←── postMessage(transfer) ──  glb
  new File([glb])
```

Workerが使えない場合（module worker非対応、CSPの `worker-src` でブロック）は
メインスレッドでの変換にfallbackする。fallback時はsourceがtransferで
detachされているため、`rereadSource()` でFileから読み直す。
事前にコピーを取らないのは、めったに起きないfallbackのために
毎回sourceのメモリを2倍にしないため。

実ブラウザでの確認:

```bash
npm run test:e2e:scene-sync-3dgs-worker
```

`html/scenesync/experiments/3dgs-worker-smoke.html` をChromiumで開き、以下を確認する。
このページはthree.jsに依存しないため、CDN importmapなしで動く。

| check | 確認内容 |
| --- | --- |
| Worker constructible | `new Worker(url, { type: 'module' })` がCSP下で構築できる |
| PLY converts in the Worker | Worker経路のみで変換が完了する（fallbackでは通らない呼び方をしている） |
| source is transferred | 呼び出し後にsource ArrayBufferが**detachされている**（コピーではなくtransfer） |
| gzip SPZ inflates | Worker内で `DecompressionStream` が動く |
| SH degree 3 survives | 高次SHがpostMessage境界を越える |
| full File drop path | `File` → 変換 → GLB `File` |
| bad file reports variant | `UnsupportedPlyVariantError` と `variant` がWorker境界を越えて復元される |

Node側のテストはWorker clientをstubで、worker moduleを `self` shimで検証しているが、
実際のmodule Worker構築・transfer・structuredCloneはこのsmokeでしか確認できない。

事前インストール済みChromiumを使う場合:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome npm run test:e2e:scene-sync-3dgs-worker
```

変換失敗の切り分け:

- **ファイル側の問題**（`UnsupportedPlyVariantError` など）→ inline retryしない。同じ結果になるため
- **Worker側の問題**（module読み込み失敗、CSP）→ inline retryし、以降そのセッションではWorkerを使わない

### SH degreeの削減（`maxShDegree`）

サイズを決めているのはsplat数ではなく**SH degree**なので、高次bandを落とすのが
一番効くサイズ対策になる。

```js
await importGaussianSplatAsset(bytes, { maxShDegree: 1 });
```

```bash
node scripts/convert-gaussian-splat.mjs capture.ply --max-sh-degree 0
```

500,000 splats / degree 3 のPLY（118.3 MB）を変換した場合:

| `maxShDegree` | GLB | 対degree 3 |
| ---: | ---: | ---: |
| 3（既定） | 112.5 MB | — |
| 2 | 72.5 MB | 0.64x |
| 1 | 43.9 MB | 0.39x |
| 0 | 26.7 MB | **0.24x** |

**既定は削減しない（`3`）。** 高次SHはview-dependentな見え（見る角度による色の変化）を
作っている実データであり、落とすと絵が変わる。ロスがある操作なので明示的に選ばせる。

読み取り時点でbandを捨てるため、cloudのメモリも同時に減る。
ただしsource（PLY 118MB）は保持されるので、RSS全体は比例しては下がらない。

削減してもThree.js側の
「SH bandは完全かつ連続」という要求は満たす（常にdegree 1..nを残すため）。
`scripts/verify-against-threejs-gaussian-splat.mjs` に
degree 2 / 1 / 0 へ削減したケースを含めて検証済み。

### GLB writeの最適化

`buildSplatAttributes()` はSH係数を実体化せず `write(target, offset)` を返す。
出力バイナリを1回だけ確保して各attributeを直接書き込むため、
係数ごとの一時配列（1M splats / degree 3で12MB × 15）と、
連結時の全体コピーが不要になる。

1M splats / degree 3 のwriteで 3450ms → 2444ms、RSS 2742MB → 2556MB。

## 残課題

- GPU描画での確認（`WebGPURenderer`、Three.js正式リリース待ち、#526 / #527）。
  ローダーまでは `scripts/verify-against-threejs-gaussian-splat.mjs` で検証済み
- 大容量アセットのasset cache / blob経路（#528）
- 本番デプロイ環境のCSPでの確認。smokeはローカルの静的サーバー（CSPヘッダなし）で
  実行しているため、本番/stagingが `worker-src` を絞っている場合はinline fallbackに落ちる
