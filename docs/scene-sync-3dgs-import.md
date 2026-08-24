# SceneSync 3DGS Import（各種splat形式 → KHR GLB）

Issue: #531

## 方針

SceneSync内部・交換用のGaussian Splat表現は **GLB + `KHR_gaussian_splatting`** に統一する。
各種3DGS配布形式はImport時にこのGLBへ正規化し、SceneDocument / asset cache / Export以降は
通常のGLBと同じ経路で扱う。

**フォーマットの読み書きはSceneSyncの責務から外し、[`@playcanvas/splat-transform`](https://github.com/playcanvas/splat-transform)（MIT）に委譲する。**
SceneSync側に3DGSのparser / encoderは持たない。

```text
.ply / .spz / .sog / .lcc2 / .lcc / .splat / .ksplat / .zip
        ↓
@playcanvas/splat-transform      ← フォーマット変換はすべてここ
        ↓
KHR_gaussian_splatting GLB       ← SceneSyncの交換形式
        ↓
inspectGaussianSplatGlb()        ← 通す前に検証
        ↓
SceneSync既存GLB経路（upload / broadcast / asset cache / SceneDocument / Export）
```

`.glb`（KHR拡張付き）が渡された場合は検証のみ行い、バイト列はそのまま通す。
splat-transformにGLB readerは無いので、再変換しない。

## 対応形式

| 拡張子 | 形式 | 備考 |
| --- | --- | --- |
| `.ply` | INRIA 3DGS PLY | `binary_little_endian` のみ（後述）。SuperSplat圧縮PLYも可 |
| `.spz` | Niantic SPZ | gzip framed / raw どちらも |
| `.sog` | PlayCanvas SOG bundle | Insta360 Appの出力を含む |
| `.lcc2` / `.lcc` | XGrids LCC | 単体ではmanifestのみなので実質zip必須（後述） |
| `.splat` | antimatter15 splat | |
| `.ksplat` | Kevin Kwok compressed splat | |
| `.zip` | 上記を含むアーカイブ | LCC2のようなディレクトリ構成をそのままドロップするため |

複数LODを持つ形式（LCC / LCC2）は **LOD 0（最も精細）のみ** を読み込む。

### zipアーカイブについて

LCC2は `meta.lcc2` + 多数の `.sog` / `.spz` チャンクという**ディレクトリ構成**なので、
単体ファイルのD&Dでは成立しない。フォルダごとzipで固めてドロップする形にしている。

zip内のエントリからフォーマットを判定する（浅い階層優先）:

`meta.lcc2` → `meta.lcc` → `lod-meta.json` → `meta.json` → 単体の `.ply` / `.spz` / `.sog` / `.splat` / `.ksplat`

`DragDropManager` はzipをまずScene Sync Export importerに渡す。そのため
`tryOpenSceneSyncExportFile()` は、**中に `scene.json` が無いzip**（=Scene Sync Export
ではないzip）については `{ handled: false }` を返して次のImporterへ譲る。
これが無いとcapture zipは「このZIPはScene Sync Exportではありません」で終わってしまい、
Gaussian Splat判定まで到達しない。

`scene.json` はあるが壊れているzip（`invalid-scene-json` / `invalid-scene-document`）は
Scene Sync Exportのつもりの入力なので、従来どおりExport importerが引き受けて報告する。

### PLYのエンコーディング

splat-transformのPLY readerは、ヘッダの宣言に関係なくレコードを
little-endian binaryとして読む。`ascii` / `binary_big_endian` を渡すと
**エラーにならずゼロ値のsplatになる**。

3DGSの学習結果は例外なく `binary_little_endian` なので実害は無いが、
黙って空のシーンを取り込むと利用者には原因が分からない。そのため
`assertSupportedPlyEncoding()` でヘッダを見て事前に弾く。

## 実装

`html/assets/js/scenesync/loaders/gaussian-splat/`

| ファイル | 役割 |
| --- | --- |
| `splat-transform-adapter.js` | **splat-transformを呼ぶ唯一の場所**。入力 → KHR GLB |
| `splat-format-detect.js` | 拡張子 / magic からの形式判定、エラーのserialize（依存ゼロ） |
| `glb-root-transform.js` | GLBのJSON chunk書き換え（up-axis補正のnode rotation） |
| `gaussian-splat-file-import.js` | D&D用のFileラッパー、サイズ上限、日本語エラーメッセージ |
| `gaussian-splat-worker-import.js` | Worker実行とinline fallback |
| `gaussian-splat-import.worker.js` | Worker entry兼bundleの公開API |
| `khr-glb-reader.mjs` | テスト用のGLB accessor読み出し |

`../khr-gaussian-splatting.js` はKHR拡張の**検証専用**で、変換ロジックは持たない。

```js
import { convertGaussianSplatToGlb } from './loaders/gaussian-splat/splat-transform-adapter.js';

const { glb, splatCount, shDegree, sourceShDegree, sourceFormat } =
  await convertGaussianSplatToGlb(arrayBuffer, {
    fileName,        // 形式判定とエラー文言に使う
    maxShDegree,     // 省略時は削減しない
    upAxisCorrection // 'none'（既定）| 'flip-x-180'
  });
```

将来splat-transformのAPIが変わっても、直すのはこのadapterだけで済む。

CLI:

```bash
node scripts/convert-gaussian-splat.mjs capture.ply out.glb
node scripts/convert-gaussian-splat.mjs room.sog
node scripts/convert-gaussian-splat.mjs site.lcc2.zip --flip-up
node scripts/convert-gaussian-splat.mjs capture.ply --max-sh-degree 1
```

## ブラウザへの配り方（vendor bundle）

SceneSyncは静的配信なので、ブラウザで `import '@playcanvas/splat-transform'` は解決できない。
CDNに逃げず、**build時にbundleして `html/assets/vendor/` にコミットする**
（Rapier / Loomletと同じ方式）。

```bash
npm run build:gaussian-splat-worker
```

```text
html/assets/vendor/splat-transform/3.3.0/
  gaussian-splat-import.worker.js   2.35 MB（minified）
  webp.wasm                         344 KB（SOGのデコードに必要）
```

| 決めごと | 理由 |
| --- | --- |
| `@playcanvas/splat-transform` は **exact version pin**（`3.3.0`、`^` 無し） | v3でChunkSource APIに大きな変更があった。意図しない更新でImportが壊れないようにする |
| `playcanvas` も exact pin | peer依存だがbundleに1.4MB入るので、内容を`package.json`+lockで決定させる |
| bundleはコミットする | 静的配信で再現性を持たせるため。生成元は`package-lock.json`で固定される |
| CDNは使わない | runtime依存を増やさない。buildが検証もする |
| `node_modules` は公開しない | vendor配下の成果物だけを配る |

bundleはEditorのモジュールグラフには**入らない**。Workerとして起動するか、
Workerが作れない時に `import()` で動的に読むかのどちらかなので、
splatをドロップしないセッションはダウンロードしない。

### buildが何をしているか

`scripts/build-gaussian-splat-worker.mjs`（esbuild）:

1. Node builtin（`module` / `fs` / `worker_threads` …）を空モジュールへ解決する。
   ブラウザでは通らない `ENVIRONMENT_IS_NODE` 分岐のためだけに参照されている
2. splat-transformが `html` 出力用に埋め込んでいる **SuperSplat viewer（3.03 MB、PlayCanvas engineの文字列）を除去**する。
   SceneSyncはGLBしか書かないため丸ごと不要。5.38 MB → 2.35 MB
3. Emscriptenの `ENVIRONMENT_IS_NODE` を `false` に固定する（ブラウザ向けbundleなので事実に一致する）
4. `webp.wasm` をbundleの隣にコピーし、Worker entryが `WebPCodec.wasmUrl` をそこへ向ける
5. **できたbundleでfixtureを4形式変換し、`inspectGaussianSplatGlb()` を通ることを確認してから**完了する

1〜3は「該当箇所が見つからなければbuildを失敗させる」形にしてあるので、
splat-transformの更新で前提が崩れたら黙って通ることはない。

同梱物のライセンス表記は `THIRD_PARTY_LICENSES.md`。

## D&D Import

対応形式をSceneSync Editorにドロップすると、変換後のGLBが
**通常のGLBと同じ経路**（upload / broadcast / asset cache / SceneDocument）に流れる。
3DGS専用の同期経路やasset種別は追加していない。

```text
drop room.sog
  → DragDropManager.handleFile()
  → convertGaussianSplatFileToGlb()      # room.sog → room.glb
  → DragDropManager._loadFile()          # 既存のGLB経路
  → glbLoader.loadFromFile() → upload → broadcast
```

オブジェクト名にはドロップした元ファイル名（`room.sog`）を表示し、
uploadされるのは変換後の `room.glb`。元ファイル情報は `userData.importedFrom` に残す。

```js
{ fileName: 'room.sog', fileSize: 51234567, convertedTo: 'room.glb', sourceFormat: 'sog' }
```

### 現在の表示（Three.js r170）

**SceneSync本番のThree.jsはr170で、Gaussian Splattingを描画できない。**

ただし変換後のGLBは r170 の `GLTFLoader` でも正常にパースでき、
`THREE.Points` として**正しい位置に白い点群**で表示される。
Transform / 同期 / Export は通常のGLBとして機能する。

Three.js が Gaussian Splatting を含む正式版になり `WebGPURenderer` へ移行すれば（#527）、
**同じGLBが再Import不要でそのままGaussian Splatとして描画される。**

なお `normalizeGlbForSceneSync()` は spec/gloss 拡張が無い場合に
glTF-Transform のパーサへ渡す前に早期returnするため、
`KHR_gaussian_splatting` GLBが未知拡張として弾かれることはない。

## 座標系の扱い

3DGSのPLYはY-down、glTFはY-upなので、splat-transformはGLB出力時に
**x と y を反転する標準的な変換を焼き込む**。つまり素直に書き出したキャプチャは
既定で正しい向きで入ってくる。

```text
PLY (1, 2, 3)  →  GLB POSITION (-1, -2, 3)
```

それでも上下が逆になるキャプチャ（撮影時の姿勢による）はあり得るため、
明示オプションとして `upAxisCorrection` を残している。
**splatデータ自体は書き換えず、glTF nodeのrotationとして書く**ので、
データはバイト等価のまま保たれ、後から取り消せる。

```js
await convertGaussianSplatToGlb(bytes, { upAxisCorrection: 'flip-x-180' });
// → scene rootに rotation [1, 0, 0, 0]（X軸180度）のnodeを1枚かぶせる
```

### Editorでの向き調整はギズモで行う

**Import時の補正にUIは用意しない。** 上下が逆で取り込まれた場合は、
配置後のオブジェクトを既存のTransformControlsで回転させて対応する。

- 向きの調整は3DGSに限った話ではなく、SceneSyncには既に回転の手段がある
- 配置後の回転は既存のtransform同期にそのまま乗るため、プロトコル変更が要らない
- 再変換・再アップロードが発生しない

`upAxisCorrection` はライブラリ側のオプションとして残す。
バッチ変換で向きを揃えたい場合はCLIから指定できる。

```bash
node scripts/convert-gaussian-splat.mjs capture.ply --flip-up
```

## 非対応入力の扱い

解釈が曖昧な入力は、黙って劣化させずに理由付きで失敗させる。
すべて `UnsupportedSplatInputError` の `variant` で区別する。

| variant | 条件 |
| --- | --- |
| `unknown-format` | magicも拡張子も対応形式に一致しない |
| `not-gaussian-splat` | 読めるがposition / geometric / colorのlayerが揃っていない（通常の点群など） |
| `unsupported-ply-encoding` | PLYが `ascii` / `binary_big_endian` |
| `incomplete-lcc` | `meta.lcc2` / `meta.lcc` 単体（チャンクが無い） |
| `no-splat-in-archive` | zipに認識できるsplatが無い（Scene Sync Exportでもない） |
| `empty` | splat数が0 |
| `invalid-glb` | KHR拡張が無い、必須attributeが欠けているGLB |
| `aborted` | AbortSignalによる中止 |

`maxShDegree` に `0..3` 以外を渡した場合は `RangeError`。範囲外の値は
「削減しない」と区別が付かず、サイズが減らない理由が分からなくなるため、入口で弾く。

破損・切り詰めファイルはsplat-transform側がsize不一致で例外にするので、そのまま伝える。

`KHR_gaussian_splatting_compression_spz_2` は未対応。
標準化が固まった段階で、SPZを解凍せずGLBへ埋め込む経路として再検討する。

## テスト

```bash
npm run test:3dgs-import   # adapter / detect / worker / vendor bundle
npm run test:3dgs-khr      # KHR GLB inspector
```

contract testを中心にしている。SceneSyncが保証するのは**出てきたGLBの中身**であって、
splat-transformの内部ではないため。

| テスト | 内容 |
| --- | --- |
| `splat-transform-adapter.test.js` | 4形式 → GLB、値の一致、SH削減、up-axis、エラーvariant |
| `splat-format-detect.test.js` | magic / 拡張子判定、PLYエンコーディング、エラーのpostMessage往復 |
| `glb-root-transform.test.js` | GLB split / pack / node wrap、BIN chunkがバイト等価であること |
| `gaussian-splat-import.worker.test.js` | Workerメッセージ契約、transfer、エラーのserialize |
| `gaussian-splat-worker-import.test.js` | Worker probe、fallback判断、abort |
| `gaussian-splat-file-import.test.js` | File → GLB File、命名、サイズ上限、エラー文言 |
| `components/drag-drop-gaussian-splat.test.js` | **`DragDropManager.handleFile()` を通したD&D経路**。zipがExport importerとGaussian Splat importerのどちらに渡るか |
| `vendored-bundle.test.js` | **コミット済みbundle**が4形式を変換でき、外部参照を持たないこと |

主要な検証項目:

- PLY → GLB で position / scale（線形）/ opacity（線形alpha）/ SH係数が期待値になること
- **同一シーンをPLYとSPZで表現した場合に、両者が量子化誤差内で一致すること**。
  PLYはfloat32のlogit/log、SPZは量子化バイト列という完全に独立した経路
- **同一シーンのSOGがPLYと一致すること**。SOGはMorton順に並び替えるため、
  位置で最近傍対応を取ってから比較する
- LCC2（zip）が変換できること。LCC2は `Transform.fromEulers(90, 0, 180)` を持つので
  値の比較ではなくsplat数と検証通過を見る
- 出力GLBが `inspectGaussianSplatGlb()` を通ること

fixture生成:

```bash
node scripts/generate-gaussian-splat-import-fixtures.mjs
```

`ring-gaussian-splats.{ply,spz,sog,lcc2.zip,glb}`（16 splats / degree 1 SH）を生成する。
PLYとSPZは `test-fixtures.mjs` の**SceneSync自前のencoder**が書く。splat-transformとは
独立した実装なので、読み戻しが実装間のクロスチェックになる。SOGとLCC2はsplat-transform
でしか作れないため、そちらで生成する。実キャプチャはコミットしない。

## Three.js標準ローダーとの突き合わせ

出力GLBが正しいかは、**実際にそれを読む実装に食わせる**以外に確かめようがない。
splat-transformが書き、three.jsが読むので、SceneSyncは入力と期待値を出すだけになる。

```bash
git clone --depth 1 https://github.com/mrdoob/three.js /tmp/three.js
ln -s /tmp/three.js node_modules/three
npm run verify:3dgs-threejs
```

Three.js `dev`（r186dev、GS実装入り）に対して実行した結果:

| case | 入力 | SH degree | 結果 |
| --- | --- | ---: | --- |
| ply-degree-3 | PLY binary LE | 3 | OK |
| ply-degree-0 | PLY binary LE | 0 | OK |
| spz-degree-1 | SPZ v2 | 1 | OK |
| spz-degree-3 | SPZ v3（smallest-three） | 3 | OK |
| reduced-to-2 | PLY degree 3 → `maxShDegree: 2` | 2 | OK |
| reduced-to-1 | PLY degree 3 → `maxShDegree: 1` | 1 | OK |
| reduced-to-0 | PLY degree 3 → `maxShDegree: 0` | 0 | OK |
| sog | SOG bundle | 1 | OK |
| lcc2 | LCC2 zip | 1 | OK |

いずれも `GLTFGaussianSplatLoaderExtension` が `GaussianSplat` を生成し、
PLY / SPZ由来のものは `splatGeometry` から読み戻したposition / color / alphaが
**元の入力値と一致**した。degree 1〜3では `sphericalHarmonics1/2/3` が揃って生成されている。

検証したのはローダーまで。実際のGPU描画（`WebGPURenderer`）は別途必要。

### Three.js側の要求（すべて満たしている）

- `colorSpace` は**必須**（未指定で例外）
- `kernel` は `ellipse` のみ
- 同一mesh内でGaussianと非Gaussianのprimitive混在は不可
- SH bandは**完全**（degree内の係数が全部揃っている）でなければ例外
- SH bandは**連続**（degree 2があるならdegree 1もある）でなければ例外

なお高次SHはThree.js側で `coef * 128 + 128` として `Uint8ClampedArray` に量子化される。
[-1, 1] を超える係数はクランプされる。これはThree.jsの仕様。

## 性能とメモリ

```bash
npm run bench:3dgs-import
```

Node 22 / 単一スレッドでの実測値。`RSS growth` は変換前後のpeak RSS差分
（`/proc/self/clear_refs` でリセットした `VmHWM`）で、fixture生成分は含まない。

| splats | SH | format | source | GLB | time | RSS growth |
| ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 200,000 | 0 | ply | 13.0 MB | 11.4 MB | 238 ms | 79.4 MB |
| 200,000 | 0 | spz | 3.6 MB | 11.4 MB | 219 ms | 72.7 MB |
| 200,000 | 3 | ply | 47.3 MB | 45.8 MB | 1324 ms | 281.5 MB |
| 200,000 | 3 | spz | 12.2 MB | 45.8 MB | 563 ms | 254.9 MB |
| 500,000 | 0 | ply | 32.4 MB | 28.6 MB | 510 ms | 142.8 MB |
| 500,000 | 0 | spz | 9.1 MB | 28.6 MB | 417 ms | 96.0 MB |
| 500,000 | 3 | ply | 118.3 MB | 114.4 MB | 4399 ms | 706.3 MB |
| 500,000 | 3 | spz | 30.5 MB | 114.4 MB | 1764 ms | 740.2 MB |
| 1,000,000 | 0 | ply | 64.9 MB | 57.2 MB | 1524 ms | 293.5 MB |
| 1,000,000 | 0 | spz | 18.1 MB | 57.2 MB | 752 ms | 320.4 MB |
| 1,000,000 | 3 | ply | 236.5 MB | 228.9 MB | 8240 ms | 1507.4 MB |
| 1,000,000 | 3 | spz | 61.0 MB | 228.9 MB | 6748 ms | 1590.7 MB |

読み取れること:

- **SH degree 3がコストを支配する。** 同じsplat数でもdegree 0と3でデータ量が約4倍。
  degree 3は1 splatあたり45係数 × 3チャンネル = 180 bytes
- 1M splats / degree 3 で **約8秒・1.5GB**。メインスレッドで実行すればEditorは固まる。
  → Worker化の根拠
- 旧実装（SceneSync自前の `SplatCloud` に全展開）では同条件で **RSS 約2.5GB** だった。
  中間表現の膨張が無くなった分だけ減っている

**「constant memory」ではない。** splat-transformのreaderはchunk単位で読むが、
GLB writerはまだstreaming版が無く、`writeSource` が全体を1つのDataTableに
materializeしてから書く。したがってピークは概ね

```text
source bytes + DataTable（≒GLBサイズ）+ 出力バッファ
```

で決まり、GLBサイズの4〜6倍になる。重要なのは、**中間表現で数倍に膨らむ経路が無くなった**
ことであって、メモリが一定になったことではない。

splat-transformにchunk-nativeなGLB writerが入れば、DataTable分がそのまま落ちる。

### Worker実行

変換はWorkerで実行し、source ArrayBufferとGLBの双方をtransferする（コピーしない）。

```text
main thread                          worker（vendor bundle）
  file.arrayBuffer()
  ── postMessage(transfer) ────────→  convertGaussianSplatToGlb()
  ←── postMessage(transfer) ────────  glb
  new File([glb])
  worker.terminate()
```

Workerが使えない場合（module worker非対応、CSPの `worker-src` でブロック）は
同じbundleを `import()` して**メインスレッドで**変換する。
fallback時はsourceがtransferでdetachされているため、`rereadSource()` でFileから読み直す。
事前にコピーを取らないのは、めったに起きないfallbackのために
毎回sourceのメモリを2倍にしないため。

中止（AbortSignal）は `worker.terminate()` で行う。splat-transformに協調的な
キャンセルは無いため、chunk pool・decoder state・出力バッファをまとめて捨てられる
これが最も確実な止め方になる。変換完了時も毎回terminateする。

GLBは `MemoryFileSystem` の可変長スラブ上のviewとして返ってくるので、
そのままtransferするとGLBの数倍のバッファを渡してしまう。
postMessage前にexactサイズへコピーし直してから渡す。

実ブラウザでの確認:

```bash
npm run test:e2e:scene-sync-3dgs-worker
```

`html/scenesync/experiments/3dgs-worker-smoke.html` をChromiumで開く。
three.jsに依存しないため、CDN importmapなしで動く。

| check | 確認内容 |
| --- | --- |
| Worker constructible | `new Worker(url, { type: 'module' })` がCSP下で構築できる |
| PLY converts in the Worker | Worker経路のみで変換が完了する（fallbackでは通らない呼び方をしている） |
| source is transferred | 呼び出し後にsource ArrayBufferが**detachされている** |
| gzip SPZ inflates | Worker内で `DecompressionStream` が動く |
| SOG decodes | **`webp.wasm` がvendorディレクトリからfetchできる** |
| zipped LCC2 decodes | zip mount → manifest解決 → chunk decode がブラウザで通る |
| SH degree 3 survives | 高次SHがpostMessage境界を越える |
| full File drop path | `File` → 変換 → GLB `File` |
| bad file reports variant | `UnsupportedSplatInputError` と `variant` がWorker境界を越えて復元される |

事前インストール済みChromiumを使う場合:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome npm run test:e2e:scene-sync-3dgs-worker
```

変換失敗の切り分け:

判定基準は**エラーの型ではなく、Workerが返事をしたかどうか**。

| 失敗 | inline retry | Worker無効化 |
| --- | --- | --- |
| Workerが `{ok:false}` を返した（変換エラー全般） | しない | しない |
| AbortSignalによる中止 | しない | しない |
| `new Worker()` が例外（CSPなど） | する | する |
| Workerの `error` イベント（module読み込み失敗など） | する | する |

splat-transformは破損zipやtruncated SPZに**普通の `Error`** を投げる。これを
「Worker側の問題」と誤認すると、同じファイルをmain threadでもう一度変換したうえ、
そのセッションの以降の巨大SOGまで全部main threadに落ちてEditorが固まる。
Workerから正常に返ってきた失敗は、型に関係なく変換の結論として扱う。

### SH degreeの削減（`maxShDegree`）

サイズを決めているのはsplat数ではなく**SH degree**なので、高次bandを落とすのが
一番効くサイズ対策になる。SceneSyncが係数を切り詰めるのではなく、
splat-transformの `filterBands` アクションを使う。

```js
await convertGaussianSplatToGlb(bytes, { maxShDegree: 1 });
```

```bash
node scripts/convert-gaussian-splat.mjs capture.ply --max-sh-degree 0
```

500,000 splats / degree 3 のPLY（118.3 MB）を変換した場合:

| `maxShDegree` | GLB | 対degree 3 |
| ---: | ---: | ---: |
| 3（既定） | 114.4 MB | — |
| 2 | 74.4 MB | 0.65x |
| 1 | 45.8 MB | 0.40x |
| 0 | 28.6 MB | **0.25x** |

**既定は削減しない（`3`）。** 高次SHはview-dependentな見え（見る角度による色の変化）を
作っている実データであり、落とすと絵が変わる。ロスがある操作なので明示的に選ばせる。

削減してもThree.js側の「SH bandは完全かつ連続」という要求は満たす
（常にdegree 1..nを残すため）。degree 2 / 1 / 0 へ削減したケースを
`npm run verify:3dgs-threejs` に含めて検証済み。

## 将来の拡張余地

adapterを1枚挟んだので、splat-transformのprocess actionを増やすだけで
以下が足せる。**このPRでは一切行わない**（既定でGaussian数を減らさない方針のため）。

- `decimate` — splat数の削減
- `filterByValue` — opacityの低いsplatを落とす
- `filterBox` / `filterSphere` — 空間クリップ
- `mortonOrder` — 描画時のsort locality改善
- `filterFloaters` / `filterCluster` — GPUが要るのでブラウザWorkerでは要検討

## 残課題

- GPU描画での確認（`WebGPURenderer`、Three.js正式リリース待ち、#526 / #527）。
  ローダーまでは `npm run verify:3dgs-threejs` で検証済み
- 大容量アセットのasset cache / blob経路（#528）
- 本番デプロイ環境のCSPでの確認。smokeはローカルの静的サーバー（CSPヘッダなし）で
  実行しているため、本番/stagingが `worker-src` を絞っている場合はinline fallbackに落ちる
- ASCII / big-endian PLY。splat-transform側の対応待ち。SceneSyncでは実装しない
- unbundled SOG（`meta.json` + 複数WebP）とstreamed SOG（`lod-meta.json`）を
  zipではなく複数ファイルのD&Dで受けるUI
- SOG Export / VR配信用SOG生成（別Issue）
