# Backlog Tracks Index

## 目的

今後増えていく Scene Sync / Loom / AI / asset / rendering / refactoring 系の開発アイデアを、coding agents と subagents が並列で扱いやすい track 単位に整理するための index です。

## Product Positioning

- 短い表現: クリエイティブツールのためのリアルタイム空間データブリッジ
- 外向き説明: Web / Unity / Blender / TouchDesigner をつなぐリアルタイム3Dシーン同期ツール
- 内部アーキテクチャ視点: Adapter / Codec / Transport を差し替えられるリアルタイム空間データプラットフォーム
- 表の顔: すぐ使える3Dシーン同期ツール
- 裏の顔: 対応先を増やしやすいリアルタイム空間データプラットフォーム

詳細は [product-positioning.md](./product-positioning.md) を参照。

## Track 一覧

- [Scene Sync Dev Tool / IDE](./scenesync-dev-tool-ide.md)
- [Loom Language / Node Graph](./loom-language-node-graph.md)
- [AI Integration](./ai-integration.md)
- [Asset Pipeline / Carrier GLB](./asset-pipeline-carrier-glb.md)
- [Shader / Generative Runtime](./shader-generative-runtime.md)
- [Advanced Rendering](./advanced-rendering.md)
- [WebAR Snapshot Viewer](./webar-snapshot-viewer.md)
- [Refactoring / Packages](./refactoring-packages.md)
- [Enterprise / Security](./enterprise-security.md)

## Near-Term Waves

### Wave 1

- In-scene Scene Sync Inspector panel follow-up
- AI contract / runtime response alignment
- Loom conflict / ownership refinement

### Wave 2

- Asset pipeline / carrier GLB design follow-up
- WebAR USDZ export feasibility
- Scene Sync protocol extraction plan

### Wave 3

- Shader runtime Web MVP
- image-to-plane / image-to-GLB pipeline
- Loom code editor / graph prototype

## Parallelization Rules

- 並列化してよいのは、別 repo、別 track、または明確に別 file set を触る task
- 同じ route / component / store / protocol consumer を複数 agent が同時に触る task は避ける
- schema producer / consumer を両側で変える task は、片側 PR を先に landing させる
- 並列実装時は git worktree を使い、各 agent に branch ownership を持たせる
- parent agent が PR を確認し、安全なものだけ one-by-one で squash merge する

## Agent Notes

- backlog doc の更新と runtime 実装を同じ branch に混ぜすぎない
- first PR を小さくし、track 境界を壊さない
- cross-track task は、どの track を primary とみなすかを最初に明示する
