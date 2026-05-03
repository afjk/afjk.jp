# afjk.jp ロードマップ

## 1) Primary Track: Scene Sync + Loom
- **目的**: コア体験に必要なシーン同期とランタイム連携を安定提供する。
- **タスク例**: Scene object 同期の信頼性向上、agent 向け Scene Sync API、Loom 連携ポイント整備、authoring/runtime 境界修正。
- **優先度**: **Now (最優先)**
- **この track に混ぜないもの**: FileTransfer 機能、直接必要でない CI / deployment の広範な変更。

## 2) Adjacent Track: FileTransfer
- **目的**: ルームベースのファイル共有を、fallback を含めて信頼性高く提供する。
- **タスク例**: 転送セッション制御、WebRTC/piping fallback、進捗表示・再試行・エラー UX。
- **優先度**: **Next (並行だが分離)**
- **この track に混ぜないもの**: Scene Sync + Loom のランタイム機能、無関係な platform リファクタ。

## 3) Platform Track: Release / CI / Staging / Agent Workflow
- **目的**: 人間と agent の両方が安全に継続開発できる運用基盤を整える。
- **タスク例**: CI 安定化、staging デプロイ検証、release チェックリスト、Issue/PR template、agent 運用ドキュメント。
- **優先度**: **Now (開発基盤として重要)**
- **この track に混ぜないもの**: workflow 支援と無関係な product 機能実装。

## 4) Future Track: Rich Editor UI / Node Graph Editor / Advanced AI Tooling
- **目的**: コア安定後に、より高度な編集体験と AI ツール支援を拡張する。
- **タスク例**: リッチ editor UI、node graph editor UX、高度な AI 支援ツール。
- **優先度**: **Later**
- **この track に混ぜないもの**: 直近 release を妨げる primary/adjacent/platform の課題。
