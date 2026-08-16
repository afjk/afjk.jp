# SceneSync 3DGS / KHR_gaussian_splatting 技術検証

Issue: #526

検証日: 2026-08-16

## 結論

SceneSyncで3DGSを扱う交換形式として `GLB + KHR_gaussian_splatting` を採用する方針は妥当。
ただし、現時点ではThree.jsの `GLTFLoader` とSparkの間に直接の `KHR_gaussian_splatting` 連携はないため、SceneSync側にアダプタ層が必要。

本Issueでは、本番ローダーへ変更を入れる前段として次を追加した。

- `KHR_gaussian_splatting` を含むGLB/JSONを検出・検証するInspector
- InspectorのNode.jsテスト
- Spark 2.1.0 + Three.js r180で3DGSを描画する独立Smokeページ

## 現在のSceneSync

SceneSync本体とExport ViewerはThree.js r170をCDN import mapで使用している。
Export Viewerでは `GLTFLoader` を利用して通常GLBを読み込んでいる。

主な確認箇所:

- `html/scenesync/index.html`
- `html/assets/js/scenesync-export/export/build-export-package.js`
- `html/assets/js/scenesync-export/viewer/create-viewer-core.js`

## KHR_gaussian_splatting

Khronosの `KHR_gaussian_splatting` は2026-08-16時点でRelease Candidate。
3D Gaussian SplatをglTFのPOINTS primitiveとして表現し、位置・回転・スケール・Opacity・SH係数をattributeとして格納する。

SceneSyncでまず対応すべきbase ellipse kernelの必須条件:

- primitive `mode` は `POINTS (0)`
- `POSITION`
- `KHR_gaussian_splatting:ROTATION`
- `KHR_gaussian_splatting:SCALE`
- `KHR_gaussian_splatting:OPACITY`
- `KHR_gaussian_splatting:SH_DEGREE_0_COEF_0`
- extensionの `kernel` はbase specでは `ellipse`
- `colorSpace` はbase specでは `srgb_rec709_display` または `lin_rec709_display`
- `projection` のbase値は `perspective`
- `sortingMethod` のbase値は `cameraDistance`

仕様:
https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_gaussian_splatting

## Three.js

2026-08-16時点のThree.js `GLTFLoader` の公式対応extension一覧に `KHR_gaussian_splatting` は含まれていない。
ただし `GLTFLoader.register()` により外部pluginを追加できる。

したがって、将来のSceneSync実装は次のどちらかになる。

1. `GLTFLoader` pluginとしてKHR primitiveをSplat rendererへ置き換える
2. GLB JSON / accessorをSceneSync側で読み、KHR primitiveのみ別rendererへ渡す

既存の通常Meshとの混在GLBを考えると、1またはGLTFLoader parserを利用した2が望ましい。

Three.js docs:
https://threejs.org/docs/#examples/en/loaders/GLTFLoader

## Spark

SparkはThree.jsへ統合しやすく、通常MeshとSplatの混在、複数Splat、raycast、WebXR等に向く。

最新のSpark 2.1.0は `three >= 0.180.0` をpeer dependencyとして要求する。
SceneSyncは現在r170なので、最新Sparkを正式採用する場合はThree.js更新が必要。

Sparkが公式に直接ロード対象として挙げているのはPLY / SPZ / SPLAT / KSPLAT / SOG等であり、`KHR_gaussian_splatting` GLBは直接の入力形式として列挙されていない。
一方 `PackedSplats` / `SplatMesh({ packedSplats })` / `constructSplats` APIがあるため、glTF accessorからSpark用データへ変換するアダプタを実装できる。

Spark:
https://github.com/sparkjsdev/spark

## Three.js更新について

### 判断

最新Spark 2.1.0を使うなら、SceneSyncのThree.jsを少なくともr180へ上げる必要がある。

ただし本Issueでは本番Three.jsをまだ更新しない。
理由は、SceneSyncではGLB、画像、動画、Physics、Export Viewer、Single HTML Export、WebXRなど広い経路でThree.jsを利用しており、r170 -> r180更新は独立した回帰確認を伴うため。

まず独立Smokeページをr180で動かし、その後本番更新を行う方が安全。

### 更新時に確認する項目

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

## 実装案

次の段階では、GLTFLoaderでGLBをロードした後、`gltf.parser.json` のprimitive extensionとaccessor indexを使い、`parser.getDependency('accessor', index)` から以下を取得する。

- POSITION -> center
- SCALE -> splat scale
- ROTATION -> quaternion
- OPACITY -> opacity
- SH_DEGREE_0_COEF_0 -> base color
- SH1〜SH3 -> SparkのSHデータへ変換（段階対応でも可）

これをSparkの `PackedSplats` / `SplatMesh` に変換する。

初期MVPではSH0のみで描画し、その後SH1〜SH3を追加する方法も検討できる。ただし標準GLBとして入力を受ける以上、未対応SHを黙って破棄するのではなく、明示的に品質制限を通知する。

## 追加ファイル

- `html/assets/js/scenesync/loaders/khr-gaussian-splatting.js`
- `html/assets/js/scenesync/loaders/khr-gaussian-splatting.test.js`
- `html/scenesync/experiments/3dgs-spark-smoke.html`

テスト:

```bash
npm run test:3dgs-khr
```

SmokeページはSpark自体の3DGS描画確認用であり、現時点ではSPZを使用する。`KHR_gaussian_splatting` GLB -> Spark変換は次の実装ステップ。

## Issue #526の残作業

- 実在する `KHR_gaussian_splatting` サンプルGLBをfixtureとして追加する
- KHR accessor -> Spark `PackedSplats` の最小変換を実装する
- ブラウザ上でKHR GLBをGaussianとして描画する
- r180上で既存SceneSync経路の回帰確認を実施する

ここまで確認できたらIssue #527のSceneSync Web Editor統合へ進む。
