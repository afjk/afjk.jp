# Third-party licenses

このリポジトリが **配布物として同梱している** サードパーティコードの著作権表示と
ライセンス全文。`html/assets/vendor/` 以下にコミットされている成果物が対象。

`node_modules/` にしか存在しないビルド/テスト専用の依存（esbuild、Playwright、
`@gltf-transform/*` など）は配布していないため、ここには含めない。

再生成手順とバージョンの固定については各節を参照。

---

## `html/assets/vendor/splat-transform/`

Gaussian Splat の各種フォーマットを `KHR_gaussian_splatting` GLB へ正規化する
Worker bundle。`npm run build:gaussian-splat-worker` が `node_modules` から生成し、
バージョンは `package.json` / `package-lock.json` で exact pin している。

同梱物:

| ファイル | 内容 |
| --- | --- |
| `gaussian-splat-import.worker.js` | 下記3パッケージ + SceneSync の adapter を bundle したもの |
| `webp.wasm` | `@playcanvas/splat-transform` 同梱の WebP codec（SOG のデコードに必要） |

含まれるパッケージ:

| パッケージ | バージョン | ライセンス |
| --- | --- | --- |
| [`@playcanvas/splat-transform`](https://github.com/playcanvas/splat-transform) | 3.3.0 | MIT |
| [`playcanvas`](https://github.com/playcanvas/engine) | 2.21.4 | MIT |
| [`@adobe/spz`](https://www.npmjs.com/package/@adobe/spz) | 0.2.2 | MIT |

`@adobe/spz` は `@playcanvas/splat-transform` の配布物にあらかじめ bundle されて
いるため、`node_modules` 上は別パッケージだがバンドル内では同一ファイルに含まれる。

SuperSplat Editor / SuperSplat Viewer のコードは含んでいない。`@playcanvas/splat-transform`
が `html` 出力用に埋め込んでいる viewer bundle は、SceneSync が GLB 出力しか使わない
ため build 時に除去している（`scripts/build-gaussian-splat-worker.mjs`）。

### `@playcanvas/splat-transform` — MIT

```
Copyright (c) 2011-2026 PlayCanvas Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### `playcanvas` — MIT

```
Copyright (c) 2011-2026 PlayCanvas Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### `@adobe/spz` — MIT

```
MIT License

Copyright (c) 2024 Niantic Labs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## `html/assets/vendor/rapier/`, `html/assets/vendor/rapier-deterministic/`

Rapier 物理エンジンの WASM ビルド。`@dimforge/rapier3d-deterministic-compat@0.19.3`
（Apache-2.0）由来。詳細は `docs/scene-sync-physics.md`。

## `html/assets/vendor/loomlet/`

Loomlet Scene Sync ランタイム。`scripts/update-loomlet-runtime.mjs` で
Loomlet リポジトリから取り込む。

## `html/assets/hdri/`

Poly Haven の HDRI（CC0）。
