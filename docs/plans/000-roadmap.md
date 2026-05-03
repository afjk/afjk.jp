# Roadmap

## 目的

`docs/plans/` は、experimental な開発を速く回すために、作業の置き場所と分割方針を揃えるためのディレクトリです。

## 現在の area

- `scenesync/`: Scene Sync 本体、SDK、runtime 連携、周辺体験
- `loom/`: Loom runtime や logic graph との接続点、連携方針
- `file-transfer/`: FileTransfer 体験、配送フロー、関連 UI / 運用
- `platform/`: CI/CD、deploy、branch workflow、docs、運用基盤

## 使い方

- 新しい作業は、まずどの area に属するかを決める
- area をまたぐ場合でも、主目的を1つ決める
- 明らかに別 track の作業は `follow-up task` に分ける
- experimental 段階では、同じ branch / PR を継続更新してよい
- ただし product behavior と platform workflow の変更は、できるだけ分ける

## 優先度の考え方

- staging で早く確認したい変更は、`codex/**` branch で先に回す
- production 反映が絡むものは、release workflow 前提で扱う
- 迷ったら、小さく出して staging で確認し、その後に分割や整理を行う

## 関連文書

- `docs/plans/001-agent-workflow.md`
- `docs/plans/scenesync/000-overview.md`
- `docs/plans/loom/000-overview.md`
- `docs/plans/file-transfer/000-overview.md`
- `docs/plans/platform/000-overview.md`
