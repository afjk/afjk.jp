# Platform Area Overview

## 目的
repository workflow、CI、release、staging、deployment、agent operation support を担当する。

## この area に含めるもの
- CI workflow と自動化の安定化。
- release/staging/deployment プロセス改善。
- Issue/PR template と planning structure。
- agent workflow ドキュメントと運用ガードレール。

## この area に含めないもの
- Scene Sync の直接的な機能実装。
- Loom runtime の機能実装。
- platform 運用に不要な FileTransfer 機能実装。

## 今後追加しうる implementation plan 例
- CI matrix と flaky test 対策。
- staging verification checklist の自動化。
- agent-ready quality gate の整備。

## Notes for agents
- platform PR は process/tooling に集中し、product behavior を混在させない。
- product 側修正が見つかった場合は follow-up issue として分離する。
