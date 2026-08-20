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

## `ring-gaussian-splats.{ply,spz,glb}`

Issue #531 のImport経路用。同一シーンを3形式で持つ。

- 16 splats / degree 1 SH
- `.ply`: INRIA形式（`binary_little_endian`、opacity logit / log scale / wxyz quaternion）
- `.spz`: Niantic SPZ v2（gzip + 量子化）
- `.glb`: 上記PLYを **SceneSync Importerに通して生成した** KHR GLB

PLYとSPZは同じ値を全く異なるエンコードで表現しているため、両者をImportして結果が
量子化誤差内で一致することが、2つのデコード経路の相互検証になる。

再生成:

```bash
node scripts/generate-gaussian-splat-import-fixtures.mjs
```

変換のみ:

```bash
node scripts/convert-gaussian-splat.mjs ring-gaussian-splats.ply out.glb
```

## 描画確認

`../3dgs-three-native-smoke.html` が `GLTFLoader.register()` + `GLTFGaussianSplatLoaderExtension` でGLBを読み込み、`GaussianSplatMesh` として描画する。

```text
3dgs-three-native-smoke.html                  # minimal（既定）
3dgs-three-native-smoke.html?fixture=ring     # degree 1 SH を含む変換結果
3dgs-three-native-smoke.html?forceWebGL=1     # WebGL fallback
```
