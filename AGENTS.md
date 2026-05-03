# AGENTS.md

## 目的

`afjk.jp` を Codex CLI や coding agents で継続開発するときの共通運用を定義します。  
この workspace には `afjk.jp/` と `loom/` が並ぶ可能性があるため、毎回どちらを触るかを明示してください。

## 推奨起動

```bash
codex -C . --sandbox workspace-write --ask-for-approval never
```

## 基本方針

- 作業開始時に対象 repo を明示する
- `main` に直接 push しない
- 作業 branch は `codex/<task-name>` を使う
- `git push --force` は使わない
- `--admin` merge は使わない
- production deploy は行わない
- secrets / token / `.env` の中身を表示しない
- repository settings は変更しない

## Experimental 開発フロー

- Codex CLI や agent は、原則として `codex/**` branch で作業する
- `experiment/**` branch を使ってもよい
- `codex/**` と `experiment/**` への push で staging deploy が自動実行される
- staging は実験環境であり、最後に deploy された branch で上書きされる
- production deploy は release workflow のみで行う
- agent は可能なら次まで完了する
  - branch push
  - PR 作成
  - squash merge
  - remote branch 削除

## Scope の扱い

- 原則として、1つの作業 branch は1つの目的に集中する
- 実験中は同じ branch / PR を継続更新してよい
- 関連する小さな改善は同じ experimental branch に含めてよい
- 明らかに別 track の作業は `follow-up task` に分ける
- product behavior と platform workflow の変更はなるべく混ぜない
- 大きくなりすぎたら分割する

## 実務メモ

- staging 確認は人間が任意のタイミングで行う
- 問題があれば、追加指示、issue、revert で介入する
- issue 作成は有用だが常に必須ではない
