# Agent Workflow

## 目的

Codex CLI と coding agents が `afjk.jp` を高速に継続開発するための標準フローを定義します。

## 前提

- workspace には `afjk.jp/` と `loom/` が並ぶ可能性がある
- 作業開始時に対象 repo を明示する
- この文書は `afjk.jp` 向けの運用を定義する

## 推奨起動

```bash
codex -C . --sandbox workspace-write --ask-for-approval never
```

## 標準フロー

1. 対象 repo を明示する
2. `git status` を確認する
3. `main` を基点に `codex/<task-name>` branch を作る
4. 実装・文書更新・必要なチェックを行う
5. branch を push する
6. 必要なら PR を作成する
7. 可能なら squash merge する
8. merge 後は remote branch を削除する

## Branch / Deploy ポリシー

- `main` に直接 push しない
- 作業 branch は `codex/<task-name>` を基本とする
- 必要に応じて `experiment/**` branch を使ってよい
- `codex/**` branch push で staging deploy が走る
- `experiment/**` branch push でも staging deploy が走る
- staging は実験環境であり、最後に deploy された branch で上書きされる
- production deploy は release workflow のみで行う

## Agent がやってよい範囲

- branch push
- PR 作成
- squash merge
- remote branch 削除

## 禁止事項

- `main` への直接 push
- `git push --force`
- `--admin` merge
- production deploy
- secrets / token / `.env` の表示
- repository settings の変更

## Scope 方針

- 原則として、1つの作業 branch は1つの目的に集中する
- 実験中は同じ branch / PR を継続更新してよい
- 関連する小さな改善は同じ experimental branch に含めてよい
- 明らかに別 track の作業は `follow-up task` に分ける
- product behavior と platform workflow の変更はなるべく混ぜない
- 大きくなりすぎたら分割する

## 人間の関与

- 人間は staging を好きなタイミングで確認する
- 問題があれば、追加指示、issue、revert で介入する
- issue 作成は推奨されるが、実験的な作業では branch / PR 先行でもよい
