# Advanced Rendering

## purpose

Gaussian Splat などの advanced rendering asset を Scene Sync に持ち込むための format、fallback、performance research を整理する track です。

## included ideas

- Gaussian Splat support
- `.ply`
- `.splat`
- `.ksplat`
- `.spz`
- carrier GLB + splat blob / URL
- runtime-specific renderer
- performance research
- import / capture workflow
- fallback strategy

## out of scope

- first-party renderer の即時完成
- all devices での parity
- enterprise controls

## near-term implementation tasks

- format matrix を作る
- carrier GLB fallback の形を整理する
- runtime-specific renderer ownership を切り分ける
- performance test axes を定義する

## later tasks

- Web runtime feasibility test
- import / capture workflow prototype
- splat snapshot export flow
- fallback rendering QA

## dependencies

- Asset Pipeline / Carrier GLB
- Advanced device test environment
- WebAR Snapshot Viewer for playback reuse

## risks

- splat native path に寄りすぎると sync / placement の互換性が落ちる
- performance budget を定義しないと viewer regressions が読めない

## parallelization notes

- format research、fallback design、performance test planning は並列化可能
- renderer implementation と protocol change は同じ PR に混ぜない

## suggested first PR

- supported format matrix and fallback note

## agent notes

- first implementation path は always fallback-aware にする
- placement / sync / playback を一度に解こうとしない

