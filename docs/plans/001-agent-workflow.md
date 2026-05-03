# Agent-Driven Development Workflow

## 開発フロー
1. **plan**: `docs/plans/...` に簡潔な計画を追加/更新。
2. **issue**: 1 実装タスクにつき 1 issue を作成。
3. **branch**: issue 単位で専用 branch を作成。
4. **PR**: issue と plan に対応する 1 PR を作成。
5. **CI**: 必要な checks を実行し、失敗を解消。
6. **staging**: 必要に応じて staging へ反映。
7. **human verification**: 人間レビュアーが挙動を確認。
8. **follow-up**: スコープ外で見つかった作業を follow-up issue 化。

## 実装中に追加タスクを見つけた場合
- 発見した時点で follow-up issue を作成する。
- 現在 PR は current acceptance criteria に集中する。
- 追加作業を現在 PR に入れるのは、acceptance criteria 達成に必須な場合のみ。

## タスク分類
- **bug**: 期待挙動との差異がある不具合。
- **blocker**: 現在タスクの進行を止める問題。
- **follow-up**: 今の acceptance criteria には不要だが必要な改善。
- **new idea**: 将来検討する拡張案。
- **refactor**: 挙動変更を意図しない構造改善。

## 割り込みルール
- 現在 PR へ追加できるのは「現在の acceptance criteria に必須な作業」のみ。
- 非 blocking な改善は follow-up issue を作る。
- 進行不能にする課題は blocker issue を作る。
- release を止めるべき課題は release-blocker を付与する。

## 推奨ラベル
- `area:scenesync`
- `area:loom`
- `area:file-transfer`
- `area:platform`
- `area:docs`
- `type:bug`
- `type:blocker`
- `type:follow-up`
- `type:new-idea`
- `type:refactor`
- `priority:now`
- `priority:next`
- `priority:later`
- `agent:ready`
- `agent:needs-plan`
- `agent:blocked`
- `needs-human`
- `release-blocker`
