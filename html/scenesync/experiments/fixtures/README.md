# 3DGS fixtures

## `minimal-khr-gaussian-splatting.glb`

Issue #526 の技術検証用に生成した最小構成の `KHR_gaussian_splatting` GLB。

- GLB 2.0 / 1,828 bytes
- 8 splats
- 非圧縮
- `POSITION`
- `KHR_gaussian_splatting:ROTATION`
- `KHR_gaussian_splatting:SCALE`
- `KHR_gaussian_splatting:OPACITY`
- `KHR_gaussian_splatting:SH_DEGREE_0_COEF_0`
- `kernel: ellipse`
- `colorSpace: srgb_rec709_display`

高次SHや圧縮拡張は含めず、Three.js標準の `GLTFGaussianSplatLoaderExtension` でbase extensionを直接ロードする確認に用途を限定する。

再生成:

```bash
node scripts/generate-minimal-khr-gaussian-splatting.mjs
```

## `ring-gaussian-splats.{ply,spz,sog,lcc2.zip,glb}`

Issue #531 のImport経路用。同一シーンを複数形式で持つ。

- 16 splats / degree 1 SH
- `.ply`: INRIA形式（`binary_little_endian`、opacity logit / log scale / wxyz quaternion）
- `.spz`: Niantic SPZ v2（gzip + 量子化）
- `.sog`: PlayCanvas SOG bundle（WebP + Morton順）
- `.lcc2.zip`: `meta.lcc2` + 1チャンク（`3dgs/chunk0.sog`）のLCC2 octreeをzipにしたもの
- `.glb`: 上記PLYを **SceneSync Importerに通して生成した** KHR GLB

`.ply` と `.spz` は `test-fixtures.mjs` のSceneSync自前encoderが書いている。
`@playcanvas/splat-transform` とは独立した実装なので、両方を読み戻して一致することが
デコード経路の相互検証になる。`.sog` と `.lcc2.zip` はsplat-transformでしか作れないため
そちらで生成している。

LCC2 fixtureは実機データではなく、`meta.lcc2` のスキーマに沿って
このリポジトリで組み立てた最小構成。実キャプチャはコミットしない。

再生成:

```bash
node scripts/generate-gaussian-splat-import-fixtures.mjs
```

変換のみ:

```bash
node scripts/convert-gaussian-splat.mjs ring-gaussian-splats.ply out.glb
node scripts/convert-gaussian-splat.mjs ring-gaussian-splats.lcc2.zip out.glb
```

## 描画確認

`../3dgs-three-native-smoke.html` が `GLTFLoader.register()` + `GLTFGaussianSplatLoaderExtension` でGLBを読み込み、`GaussianSplat` として描画する。

```text
3dgs-three-native-smoke.html                  # minimal（既定）
3dgs-three-native-smoke.html?fixture=ring     # degree 1 SH を含む変換結果
3dgs-three-native-smoke.html?webgpu=1         # WebGPU backend（既定はWebGL backend）
```

## WebXR stereo A/B比較

SceneSync本体のrendererを変更せず、同じ`KHR_gaussian_splatting` GLBをQuestで比較する。

- `../3dgs-three-webxr-stereo-smoke.html` は固定中のThree.js commitへ、XR ArrayCamera対応の
  `mediumpModelViewMatrix`と片眼サイズの`cameraViewport.zw`を実行時にだけ適用する。
- `../3dgs-playcanvas-webxr-smoke.html` はPlayCanvas 2.21.4の標準container loaderと
  XR対応の`GSPLAT_RENDERER_RASTER_CPU_SORT`を使う。

```text
3dgs-three-webxr-stereo-smoke.html?fixture=ring
3dgs-three-webxr-stereo-smoke.html?fixture=minimal
3dgs-three-webxr-stereo-smoke.html?fixture=ring&kernel=smooth
3dgs-playcanvas-webxr-smoke.html?fixture=ring
3dgs-playcanvas-webxr-smoke.html?fixture=minimal
```

Three.js版へはSceneSync生成の`.glb`を、PlayCanvas版へは`.glb`、元の`.sog`または`.ply`を
ドロップして差し替えられる。Questでは「VRを開始」後、次を両ページで確認する。

1. Gaussianと右側の青・橙・緑のboxの双方に左右眼parallaxがある。
2. `XR views`が2、eye separationがおよそ0.05〜0.08 mになる。
3. `stereo camera matrices`が`distinct`になる。

通常boxだけが立体でGaussianが平面に見える場合は、Three.jsのGaussian shader修正が不十分。
両方が立体なら候補パッチを上流PRへ進められる。PlayCanvasだけが立体ならrenderer移行の検討材料にする。

Three.js版の`kernel=smooth`はstereo修正とは独立した画質比較。固定commitの2σ cutoff
（境界alphaは約13.5%）を、PlayCanvas相当の約2.83σと境界alpha 0のnormalized Gaussianへ
実行時だけ差し替える。PlayCanvasの見た目の差がrenderer全体によるものか、fragment kernelだけで
再現できるかを切り分ける。

機械判定用diagnosticsは`window.__threeGaussianXrStereoSmoke`と
`window.__playCanvasGaussianXrSmoke`へ出す。

Desktopのload/render smoke:

```bash
npm run test:e2e:scene-sync-3dgs-three-xr-patch
npm run test:e2e:scene-sync-3dgs-playcanvas
```
