# Loom Scene Sync Integration

## 概要

Loom と Scene Sync の接続方針を整理し、どちらの repo に何を置くか、同期、競合、責務分担を明確にするための初期 plan です。  
この task では `loom/` を変更せず、`afjk.jp` 側の計画文書だけを追加します。

## 背景

- Loom と Scene Sync を接続すると、object movement、animation、graph-driven changes の責務が曖昧になりやすい
- cross-repo で並列実装するには、`afjk.jp` 側責務と `loom/` 側責務の線引きが必要
- 同じ object に対して Scene Sync update と Loom 側 change が競合したときの source of truth を先に決めておきたい
- staging で実験しながら育てる前提でも、実装順序は早めに共有しておくほうが安全

## 対象repo

- `afjk.jp`

## 対象area

- `loom`
- `scenesync`

## 目的

- `afjk.jp` side responsibility を明確にする
- `loom/` side responsibility を明確にする
- ownership と source of truth の原則を決める
- cross-repo implementation order を整理する
- staging で確認すべき接続面を先に定義する

## 想定するユーザー体験

- 開発者が、どの変更を `afjk.jp` に入れるべきか、どの変更を `loom/` に入れるべきか迷いにくい
- graph-driven changes が Scene Sync に反映されるとき、どこで正規化し、どこで衝突を扱うかが分かる
- 人間が staging で Scene Sync と Loom の接続結果を確認し、追加指示を出しやすい

## 実装方針

- `afjk.jp` は Scene Sync 側の受け口、可視化、staging 検証導線を担当する
- `loom/` は graph / runtime / orchestration の責務を主に持つ
- object movement や animation の最終反映点は Scene Sync 側に寄せつつ、変更の生成源が Loom なのか user 操作なのかを追えるようにする
- source of truth は object 種別や更新種類ごとに分けるのではなく、まずは「どの mutation が最終適用権を持つか」をシンプルに決める
- conflict が起きたら、silent overwrite ではなく検出可能な形を優先する

## 段階的な実装ステップ

1. 責務分担を固定する
   - `afjk.jp` 側の API / viewer / developer tool responsibility
   - `loom/` 側の graph execution / scheduling responsibility
2. 最小 integration を定義する
   - Loom が Scene Sync mutation を発行する最小経路
   - object movement と simple property update のみ対象にする
3. ownership ルールを決める
   - user 操作起点
   - Loom 起点
   - conflict 時の優先順位
4. staging 検証ケースを作る
   - graph-driven changes が反映されること
   - Scene Sync 直接更新と競合したときの挙動確認
5. cross-repo 拡張に進む
   - animation
   - 複数 object 更新
   - richer event / diff handling

## acceptance criteria

- [ ] `afjk.jp` と `loom/` の責務分担が書かれている
- [ ] object movement / animation / graph-driven changes の扱い方針がある
- [ ] ownership / source of truth の原則が書かれている
- [ ] conflict 時の基本方針が書かれている
- [ ] cross-repo implementation order が書かれている
- [ ] staging での確認方法が書かれている

## out of scope

- この task 内での `loom/` repo 実装変更
- 完全な競合解決アルゴリズムの確定
- FileTransfer との接続計画
- production 運用フローの設計

## staging確認方法

- `afjk.jp` 側に最小 integration UI / log / developer tool を出す
- Loom 起点の mutation が Scene Sync に反映される流れを staging で確認する
- Scene Sync 側から同じ object を更新した場合の衝突検知を確認する
- before / after snapshot または log で source の違いが追えるか確認する

## リスク

- repo 境界が曖昧なまま進めると、並列実装時に責務重複が起きる
- conflict 方針を後回しにすると、animation や graph-driven update で挙動が不安定になる
- `afjk.jp` 側の staging 確認導線が弱いと、統合後の不具合切り分けが難しい

## follow-up tasks

- `loom/` 側に置く integration task の切り出し
- Scene Sync AI tool contract との接続点整理
- graph-driven changes の event schema 下書き
- conflict 表示方法の検討

## agent向け注意

- この task では `loom/` repo を変更しない
- cross-repo 作業に進むときは、どちらを先に変えるかを明示する
- Scene Sync 側の developer tool や snapshot 導線を先に作ると検証しやすい
- issue 作成は必須ではなく、branch / PR 先行でもよい
