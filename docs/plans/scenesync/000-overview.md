# Scene Sync Area Overview

## 目的
Scene state synchronization、scene object operations、AI-accessible scene control を担当する。

## この area に含めるもの
- Scene state sync のプロトコルと整合性制御。
- Scene object の create/update/delete。
- agent からの scene 操作用インターフェース。
- Scene Dev Tool のうち同期責務に関わるもの。

## この area に含めないもの
- Loom ランタイム内部（明示的な連携境界を除く）。
- FileTransfer の transport / UX。
- Scene Sync 提供に不要な CI/release 運用変更。

## 今後追加しうる implementation plan 例
- Scene state conflict resolution。
- Scene object operation の監査ログ。
- AI-safe な scene command surface。

## Notes for agents
- Loom 連携は interface task として明示する。
- cross-area 影響は黙って混ぜず、必要なら follow-up task として記録する。
