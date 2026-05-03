# FileTransfer Area Overview

## 目的
ルームベースの file exchange、transport fallback、sharing UX を担当する。

## この area に含めるもの
- file transfer のセッション制御。
- transport strategy（WebRTC/piping fallback）。
- 進捗表示・再試行・エラー処理など sharing UX。
- 転送信頼性と観測性。

## この area に含めないもの
- Scene Sync + Loom の primary runtime 機能。
- FileTransfer 提供に不要な platform/release 変更。

## 今後追加しうる implementation plan 例
- room-based transfer protocol の堅牢化。
- fallback retry strategy の整備。
- staging 向け file sharing UX 検証チェックリスト。

## Notes for agents
- FileTransfer は adjacent track（primary track とは分離）。
- cross-track 依存は issue / PR に明示する。
