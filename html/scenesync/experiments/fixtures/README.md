# 3DGS fixtures

`minimal-khr-gaussian-splatting.glb` は Issue #526 の技術検証用に生成した最小構成の `KHR_gaussian_splatting` GLB。

- GLB 2.0 / 1,832 bytes
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

描画確認:

`../3dgs-three-native-smoke.html` がこのGLBを `GLTFLoader.register()` + `GLTFGaussianSplatLoaderExtension` で直接読み込み、`GaussianSplatMesh` として描画する。
