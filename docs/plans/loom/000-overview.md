# Loom Overview

## 目的

Loom area は、Loom runtime や logic graph との接続を整理し、`afjk.jp` 側で必要な連携計画をまとめるための領域です。

## この area に含めるもの

- `afjk.jp` と Loom の接続方針
- Loom 関連 docs の受け皿
- cross-repo の作業整理
- Loom を前提にした demo / integration の計画

## この area に含めないもの

- `loom/` repo 自体の実装変更
- `afjk.jp` 単独で閉じる Scene Sync 固有改善
- deploy / release / CI の platform workflow

## 今後追加しうる plan 例

- Loom と Scene Sync の integration メモ
- logic graph を使う example の作業整理
- `loom/` 側に切り出すべき follow-up task の洗い出し

## Agents 向け注意

- この area の文書を更新しても、`loom/` repo を勝手に変更しない
- 実装対象が `afjk.jp` なのか `loom/` なのかを必ず明示する
- cross-repo 作業は、依存関係と順序を短く書いておく
