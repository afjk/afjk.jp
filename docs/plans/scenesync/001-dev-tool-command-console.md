# Scene Sync Dev Tool Command Console

## 概要

Scene Sync の開発・検証をしやすくするために、web 上からシーン操作コマンドを入力、送信、確認できる developer tool を整備するための初期 plan です。  
この task では実装は行わず、experimental に staging で育てる前提の実装方針を整理します。

## 背景

- 現状の Scene Sync 検証は、個別の script や ad-hoc な手動操作に寄りやすい
- AI agent が送る payload を人間が目視確認しにくい
- シーンの object create / update / delete を素早く試せる UI があると、開発速度と切り戻し判断が上がる
- staging でそのまま触って確認できる developer-facing な画面があると、branch push 後の確認が簡単になる

## 対象repo

- `afjk.jp`

## 対象area

- `scenesync`

## 目的

- plain text command から Scene Sync 操作を試せるようにする
- 送信前に JSON payload preview を確認できるようにする
- command history と validation error を見える化する
- AI agent が生成した command / payload を staging 上で人間が検証しやすくする

## 想定するユーザー体験

- 開発者が staging の developer tool を開く
- plain text command か helper UI で操作内容を作る
- 生成される JSON payload preview を見て送信する
- response、validation error、scene snapshot の変化を同じ画面で確認する
- 同じ command を history から再実行して比較する

## 実装方針

- Scene Sync の既存 endpoint / command 送信経路を再利用し、別仕様を増やしすぎない
- 入力 UI はまず plain text command を中心にし、object create / update / delete helper を補助として載せる
- JSON payload preview は送信前に必ず見える位置に置く
- scene snapshot fetch を明示的な action として用意し、before / after 比較に使えるようにする
- focus / screenshot helper が既存機能で使えるなら UI に薄く載せる
- validation error と transport error は分けて表示する
- staging で確認しやすいように、1画面で入力、preview、response、history が見える構成を優先する

## 段階的な実装ステップ

1. 最小 UI を用意する
   - plain text command input
   - send action
   - response 表示
2. payload preview を追加する
   - command から生成される JSON を送信前に確認
   - basic validation error を表示
3. helper 群を追加する
   - object create / update / delete helper
   - scene snapshot fetch
4. 検証体験を強化する
   - command history
   - before / after の snapshot 比較
   - focus / screenshot helper の接続可否確認
5. AI agent 向け確認導線を整える
   - agent が生成した payload の貼り付け確認
   - command と payload のズレを見つけやすい表示

## acceptance criteria

- [ ] plain text command を入力して Scene Sync 操作を送信できる
- [ ] 送信前に JSON payload preview を確認できる
- [ ] validation error を UI 上で判別できる
- [ ] command history から再実行または再利用できる
- [ ] scene snapshot fetch を使って状態確認できる
- [ ] staging 上で人間が agent payload を確認しやすい画面になっている

## out of scope

- Scene Sync protocol 自体の大幅な再設計
- production 向けの権限制御や本格監査 UI
- FileTransfer 関連の developer tool
- この task 内での実装、deploy 動作変更、`loom/` repo 変更

## staging確認方法

- `codex/**` branch で UI を staging に出す
- command input から単純な object create / update / delete を試す
- payload preview と response が一致しているか確認する
- scene snapshot fetch を before / after で実行して差分確認する
- AI agent が生成した payload を貼り付け、validation error や表示の分かりやすさを確認する

## リスク

- command 入力形式を先に固めすぎると、後続の AI tool contract と齟齬が出る
- preview、response、snapshot を1画面に載せすぎると UI が散らかる
- helper を増やしすぎると、かえって protocol の理解が薄れる

## follow-up tasks

- command grammar の最小仕様整理
- snapshot diff の見せ方改善
- focus / screenshot helper の既存機能調査
- Scene Sync AI tool contract との用語統一

## agent向け注意

- この文書は実装着手用の plan であり、仕様を固定しすぎない
- staging で早く触れる最小構成から入る
- product behavior の変更と developer tool の変更を同じ branch に混ぜすぎない
- issue 作成は必須ではなく、branch / PR 先行で進めてよい
