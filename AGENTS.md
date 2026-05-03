# AGENTS ガイド

## リポジトリの目的
このリポジトリは、afjk.jp の基盤と関連ツールを管理します。主に Scene Sync、Loom 連携、FileTransfer、そして CI / staging / release / deployment / agent 運用を対象にします。

## 主要エリア
- **Scene Sync**: シーン状態同期、オブジェクト操作、AI からのシーン制御、Scene Dev Tool 関連。
- **Loom**: ロジックグラフ / ランタイム挙動、Scene Sync との連携境界。
- **FileTransfer**: ルームベースのファイル転送、fallback 経路、共有 UX。
- **Platform**: CI、release、staging、deployment、リポジトリ運用、agent workflow。

## スコープ管理
- **one task = one issue = one PR** を厳守してください。
- 無関係な変更を同じ PR に混ぜないでください。Do not mix unrelated changes.
- 推測ベースの先回りリファクタは避けてください。
- scope を黙って拡張しないでください。
- PR は小さく、レビューしやすく、必要なら revert しやすく保ってください。

## 追加タスクの扱い
- 実装中に新しい作業を見つけたら **follow-up task** として記録してください。
- 現在の **acceptance criteria** を満たすために必須な場合のみ、現在の PR に含めてください。
- それ以外は別 issue / 別 PR に分離してください。

## PR に必ず書くこと
- **related issue**
- **related plan**
- 概要（summary）
- 変更内容（what changed）
- 意図的に変更していないこと（out of scope を含む）
- **tests**（実行内容、または実行できない理由）
- **risks**
- follow-up tasks

## テスト方針
- 変更対象エリアに関連する tests / checks があれば実行してください。
- 実行できない場合は、理由を PR に明記してください。

## ドキュメント更新方針
- 挙動、公開利用方法、運用フローに変更がある場合は関連ドキュメントを更新してください。

## 安全ルール
- 無関係な領域への変更を避ける。
- 大量の formatting-only 変更を避ける。
- 必要性が明確でない依存追加を避ける。
- repository bootstrap タスクで application logic を変更しない。
- 常に「小さく、明確で、レビューしやすい差分」を優先する。
