# SceneSync 3DGS / KHR_gaussian_splatting 技術検証

Issue: #526

検証日: 2026-08-16

## 結論

SceneSyncの3DGS対応は、**Three.js標準のGaussian Splatting実装を第一候補**とする。
交換形式は引き続き `GLB + KHR_gaussian_splatting` を採用する。

Three.js PR #33950 は2026-08-16時点ですでに `dev` へマージ済みで、以下がThree.js addonsとして追加されている。

- `GaussianSplat`
- `GLTFGaussianSplatLoaderExtension`
- `SPZLoader`
- `SPLATLoader`
- `KSPLATLoader`
- PLYからGaussian Splat geometryへの変換utility

そのため、以前Spikeで作成した **KHR accessor → Spark `SplatMesh` のSceneSync独自変換層は採用しない**。
Sparkは、将来Three.js標準実装では不足するLOD / streaming / 大規模scene対応が必要になった場合の代替候補として残す。

## Three.js側の状態

対象PR:

- https://github.com/mrdoob/three.js/pull/33950
- SceneSync runtime pin: `cbba126004263d0c32d3d6d05a4fe218d261fa47`

PRは `dev` にマージ済み。
2026-08-16時点の最新正式リリースはr185で、PR #33950はr185リリース後にマージされている。
したがって、Issue #527 では `dev` の可動参照ではなく上記commitを固定して採用する。
r186正式リリース後はnpm CDNの正式版へ置き換える。

Three.js標準実装では、KHR GLBは次のように読み込める。

```js
const loader = new GLTFLoader();
loader.register((parser) => new GLTFGaussianSplatLoaderExtension(parser));
const gltf = await loader.loadAsync('scene.glb');
scene.add(gltf.scene);
```

`GLTFGaussianSplatLoaderExtension` がKHR accessorを読み、`position / covariance / color` の `BufferGeometry` へ変換し、`GaussianSplat` を生成する。
SceneSync側でKHR accessorやSH0変換を独自実装する必要はない。

## Renderer

`GaussianSplat` はThree.jsの `WebGPURenderer` を使用する。
WebGPUだけでなく `WebGPURenderer({ forceWebGL: true })` によるWebGL backendもサポートされる。
従来の `WebGLRenderer` では利用しない。

SceneSync本番統合では、現在の `WebGLRenderer` ベースから `WebGPURenderer` へ移行可能かが主要な検証項目になる。

## Three.js標準実装の現在の制約

- 同一mesh内にGaussian primitiveと通常primitiveが混在するケースは未対応（例外になる）
- SH bandは**完全**（degree内の係数が全部揃う）かつ**連続**（degree 2があるならdegree 1もある）
  でなければ例外
- `colorSpace` は必須（未指定で例外）、`kernel` は `ellipse` のみ
- 高次SHは `coef * 128 + 128` で8bitに量子化される（[-1, 1] 超はクランプ）
- progressive loading / spatial streamingは未対応
- Gaussian Splat rendererはWebGPURenderer前提

通常MeshとGaussian Splatを同一GLBに入れる場合は、**別meshとして格納する**方針にする。

> **訂正（2026-08-21）**
>
> 当初この節に「SH0のみ描画し、SH1〜SH3は現在無視される」と書いていたが、**これは誤り**。
> `GaussianSplat.js` には `createSphericalHarmonicsComputeNode()` があり、
> `viewDirection` を用いて SH1〜3 による視点依存の色を実際に計算している
> （`sphericalHarmonics1Read` 等のstorage bufferを参照）。
>
> このため「SceneSync v1はSH0から開始して問題ない」という判断も取り下げる。
> 高次SHを落とすとview-dependentな見えが失われるため、
> Importの既定は**全band保持**とし、削減は明示的なオプション
> （`maxShDegree`）にしている。詳細は `docs/scene-sync-3dgs-import.md`。

## 実GLB fixture

`html/scenesync/experiments/fixtures/minimal-khr-gaussian-splatting.glb`

内容:

- GLB 2.0
- 8 splats
- 非圧縮
- primitive mode: `POINTS (0)`
- `POSITION`
- `KHR_gaussian_splatting:ROTATION`
- `KHR_gaussian_splatting:SCALE`
- `KHR_gaussian_splatting:OPACITY`
- `KHR_gaussian_splatting:SH_DEGREE_0_COEF_0`
- `kernel: ellipse`
- `colorSpace: srgb_rec709_display`
- `projection: perspective`
- `sortingMethod: cameraDistance`

高次SHや圧縮拡張は意図的に含めていない。
Three.js標準KHR loaderの最小入力として使う。

生成:

```bash
node scripts/generate-minimal-khr-gaussian-splatting.mjs
```

## Inspector

`html/assets/js/scenesync/loaders/khr-gaussian-splatting.js`

SceneSync独自のrenderer adapterではなく、fixture / import時の軽量検証用として残す。

確認する項目:

- GLB 2.0 JSON chunk
- `KHR_gaussian_splatting` 宣言
- primitive mode = `POINTS (0)`
- 必須attribute
- kernel / colorSpace / projection / sortingMethod

accessorデコードやSH0→RGB変換はThree.js標準loaderに任せるため削除した。

## Smokeページ

`html/scenesync/experiments/3dgs-three-native-smoke.html`

経路:

```text
minimal-khr-gaussian-splatting.glb
        ↓
Three.js GLTFLoader
        +
GLTFGaussianSplatLoaderExtension
        ↓
BufferGeometry
(position / covariance / color)
        ↓
GaussianSplat
        ↓
WebGPURenderer
(WebGPU / WebGL fallback)
```

SceneSyncではThree.js commit `cbba126004263d0c32d3d6d05a4fe218d261fa47` をjsDelivr GitHub CDN経由で固定している。
正式リリースに入った後はrelease versionへ置き換える。

既定はWebGL backend。WebGPU backendを明示する場合:

```text
3dgs-three-native-smoke.html?webgpu=1
```

## テスト

```bash
npm run test:3dgs-khr
```

Nodeテストでは、fixtureがThree.js `GLTFGaussianSplatLoaderExtension` の入力条件を満たすことを確認する。
描画そのものはbrowser smokeで確認する。

## Issue #527 本番統合

2026-08-24時点で次の3経路が同じruntime pinとloader extensionを使う。

- SceneSync Editor
- Static ZIP Export Viewer
- Single HTML Export Viewer

renderer classはすべて `WebGPURenderer`。既定backendはWebXR互換性を優先して
`forceWebGL: true` とし、`?webgpu=1` の場合だけWebGPU backendを選ぶ。
Three.js、addons、`three/webgpu`、`three/tsl`、Draco decoderは同じcommitに固定する。
Exportは従来どおり `cdnDependent: true` で、Three.jsを埋め込まない。

回帰確認:

```bash
npm run test:e2e:scene-sync-3dgs-renderer
npm run test:e2e:scene-sync-3dgs-renderer -- --webgpu
npm run test:e2e:scene-sync-3dgs-editor
npm run test:e2e:scene-sync-export-static-viewer
npm run test:e2e:scene-sync-export-single-html
```

## #527で確認した回帰項目

固定commitの `WebGPURenderer` への移行に合わせ、次をunit testとbrowser E2Eで確認した。

- 通常GLB / Draco GLB
- Image / Video object
- HDRI / PMREM
- TransformControls / picking
- WebXR
- Rapier PhysicsとのObject3D連携
- Export Viewer
- Static ZIP
- Single HTML Export
- 既存E2E smoke tests
- WebGPU backend / WebGL fallback双方

## 採用方針

1. **第一候補: Three.js標準Gaussian Splatting**
2. SparkはLOD / streaming / scene-scale対応が必要になった場合のfallback候補
3. SceneSync独自の3DGS renderer / accessor変換は原則作らない
4. SceneSyncの標準交換形式は `GLB + KHR_gaussian_splatting`

## #527後の残作業

- 実Insta360データを使ったstagingでの視覚比較
- Quest等の実機で `immersive-vr` / `immersive-ar` sessionを開始する確認
- Three.js r186正式リリース後、固定GitHub commitをnpm CDNの正式版へ置き換える
