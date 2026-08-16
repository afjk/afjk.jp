# SceneSync 3DGS / KHR_gaussian_splatting 技術検証

Issue: #526

検証日: 2026-08-16

## 結論

SceneSyncで3DGSを扱う交換形式として `GLB + KHR_gaussian_splatting` を採用する方針は妥当。
ただし、2026-08-16時点ではThree.js `GLTFLoader` とSparkに `KHR_gaussian_splatting` GLBを直接渡す経路はないため、SceneSync側にKHR accessorからSplat rendererへ変換するアダプタ層が必要。

本IssueのSpikeでは、そのアダプタの最小形まで実装した。

- `KHR_gaussian_splatting` を含むGLB/JSONを検出・検証するInspector
- GLB BIN chunk / accessorの最小デコーダ
- SH0係数からdiffuse RGBを復元する処理
- 8 splatsの実バイナリ `KHR_gaussian_splatting` GLB fixture
- fixture生成スクリプト
- fixtureを直接デコードするNode.jsテスト
- KHR GLB → accessor decode → Spark `SplatMesh` を確認する独立Smokeページ

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

高次SHやSPZ圧縮拡張は意図的に含めていない。base extensionからrendererまでの経路だけを分離して検証するためのfixture。

生成:

```bash
node scripts/generate-minimal-khr-gaussian-splatting.mjs
```

## KHR_gaussian_splatting

Khronosの `KHR_gaussian_splatting` は2026-08-16時点でRelease Candidate。
3D Gaussian SplatをglTFのPOINTS primitiveとして表現し、位置・回転・スケール・Opacity・SH係数をattributeとして格納する。

base ellipse kernelの必須条件:

- primitive `mode` は `POINTS (0)`
- `POSITION`
- `KHR_gaussian_splatting:ROTATION`
- `KHR_gaussian_splatting:SCALE`
- `KHR_gaussian_splatting:OPACITY`
- `KHR_gaussian_splatting:SH_DEGREE_0_COEF_0`
- `kernel: ellipse`
- `colorSpace: srgb_rec709_display` または `lin_rec709_display`
- `projection` のbase値は `perspective`
- `sortingMethod` のbase値は `cameraDistance`

SH0のみの場合のdiffuse colorは仕様通り次で復元する。

```text
Color = SH0 * 0.2820947917738781 + 0.5
```

仕様:
https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_gaussian_splatting

## Three.js / Spark

SceneSync本体とExport Viewerは現在Three.js r170を使用している。
最新Spark 2.1.0は `three >= 0.180.0` を要求するため、正式採用する場合はThree.js更新が必要。

SparkはPLY / SPZ / SPLAT / KSPLAT / SOG等を直接ロードできるが、`KHR_gaussian_splatting` GLBは直接入力として扱わない。
一方 `PackedSplats` / `SplatMesh` / `constructSplats` があるため、SceneSync側でglTF accessorをデコードして渡せる。

今回のSmokeページでは次の経路を実装した。

```text
minimal-khr-gaussian-splatting.glb
        ↓
GLB JSON + BIN chunk parse
        ↓
KHR accessor decode
        ↓
POSITION / SCALE / ROTATION / OPACITY / SH0
        ↓
SH0 → RGB
        ↓
Spark SplatMesh.constructSplats
        ↓
SparkRenderer
```

## 現在のデコーダ範囲

`html/assets/js/scenesync/loaders/khr-gaussian-splatting.js`

現時点で以下を扱う。

- GLB 2.0 JSON/BIN chunk
- accessor / bufferView
- byteStride
- float / byte / short系component type
- normalized整数attribute
- base ellipse KHR primitive
- SH0 → diffuse RGB

Spikeなので以下はまだ未対応。

- sparse accessor
- 外部 `.bin` を参照する `.gltf`
- SH1〜SH3をSpark SHへ渡す処理
- KHR compression extensions
- GLTFLoader pluginとしての統合
- node hierarchy / global transformをKHR primitive単位で適用する本番統合

## テスト

```bash
npm run test:3dgs-khr
```

テストには実バイナリfixtureを読み込み、以下を確認するケースを追加した。

- KHR primitiveとしてvalid
- primitive数 = 1
- splat数 = 8
- position / rotation / opacity
- SH0から復元したRGB

このChatGPT実行環境ではGitHub raw/CDNへの外部ネットワーク接続が拒否されたため、NodeテストとブラウザSmokeの実行自体は未完了。GLBバイナリについてはローカル生成時にヘッダ、JSON/BIN chunk、5 accessor、8 splatsの値まで構造検証済み。

## Three.js更新時の回帰確認

r170 → r180を本番へ入れる場合は少なくとも次を確認する。

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

## Issue #526の残作業

- 実ブラウザで `3dgs-spark-smoke.html` を開き、8 splatsがGaussianとして描画されることを確認する
- r180上で既存SceneSync経路の回帰確認を実施する
- 本番統合方式を `GLTFLoader.register()` plugin / SceneSync独自adapterのどちらにするか最終決定する

KHR GLBからSparkへデータを渡す最小アダプタまでは実装済みなので、Smokeが通ればIssue #527のSceneSync Web Editor統合へ進める。
