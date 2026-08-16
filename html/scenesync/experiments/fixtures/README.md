# 3DGS fixtures

`minimal-khr-gaussian-splatting.glb` は Issue #526 の技術検証用に生成した最小構成の `KHR_gaussian_splatting` GLB。

- 8 splats
- 非圧縮 GLB 2.0
- `POSITION`
- `KHR_gaussian_splatting:ROTATION`
- `KHR_gaussian_splatting:SCALE`
- `KHR_gaussian_splatting:OPACITY`
- `KHR_gaussian_splatting:SH_DEGREE_0_COEF_0`
- `kernel: ellipse`
- `colorSpace: srgb_rec709_display`

高次SHや圧縮拡張は含めず、KHR base extensionからSparkへの変換確認に用途を限定する。
