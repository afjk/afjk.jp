# FileTransfer Overview

## 目的

FileTransfer area は、ファイル配送の体験、導線、運用を整理し、Scene Sync 周辺で必要な転送体験を改善するための領域です。

## この area に含めるもの

- FileTransfer の UX / flow 設計
- 関連する docs や example の計画
- 転送導線に関わる web / server 側の小さな改善計画
- FileTransfer 運用メモ

## この area に含めないもの

- Scene Sync runtime の中心ロジック
- Loom runtime の設計
- deploy / CI / branch workflow の整備

## 今後追加しうる plan 例

- 転送状態表示の改善
- 大きいファイル向けの staging 検証フロー
- docs と FAQ の整理
- 転送失敗時の follow-up task 洗い出し

## Agents 向け注意

- product behavior を変えるのか、docs / 運用だけを変えるのかを最初に分ける
- Scene Sync 本体の同期仕様変更と混ぜすぎない
- 迷ったら small branch で staging まで出して確認する
