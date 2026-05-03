# Loom Area Overview

## 目的
Loom の logic graph / runtime behavior と、Scene Sync との integration boundary を担当する。

## この area に含めるもの
- Loom runtime execution model。
- Logic graph evaluation flow。
- Scene Sync との契約済み integration point。
- runtime-authoring boundary のルール。

## この area に含めないもの
- integration contract 外の Scene Sync 内部実装。
- FileTransfer 機能。
- Loom 提供に不要な platform 運用変更。

## 今後追加しうる implementation plan 例
- Loom runtime lifecycle / scheduling 改善。
- Scene Sync integration contract の強化。
- runtime-authoring boundary の検証整備。

## Notes for agents
- Loom と Scene Sync は「関連あり・責務分離」で扱う。
- contract 変更は明示し、暗黙の scope 拡張を避ける。
