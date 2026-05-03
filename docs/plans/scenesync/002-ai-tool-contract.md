# Scene Sync AI Tool Contract

## 概要

GPTs / MCP / Codex / other agents が Scene Sync を確実に操作できるように、AI 向けの操作契約、payload 方針、失敗時の扱いを整理するための初期 plan です。  
自然言語だけに依存しない stable な contract を目指します。

## 背景

- AI agent に Scene Sync を触らせる場合、曖昧な自然言語指示だけでは再現性が低い
- action 名、required params、response 期待値が不安定だと、agent ごとの差が大きくなる
- scene snapshot の before / after を含めた確認導線があると、失敗検知と retry 方針を作りやすい
- 今後の MCP / GPTs integration を考えると、早い段階で tool-like な contract を揃えておきたい

## 対象repo

- `afjk.jp`

## 対象area

- `scenesync`

## 目的

- stable action names を定義する
- required params と optional params の境界を明確にする
- response expectations と error handling をそろえる
- scene snapshot before / after を使った確認フローを標準化する
- future MCP / GPTs integration に流用できる形にする

## 想定するユーザー体験

- agent 実装者が、曖昧な prompt ではなく定義済み action を使って Scene Sync を操作する
- action ごとに必要な params と返り値の期待が明確で、失敗時の扱いも判断しやすい
- 人間が payload と response を見れば、agent の誤動作か backend 側の問題かを切り分けやすい

## 実装方針

- operation は tool-like な単位で定義し、stable action names を優先する
- action ごとに required params、optional params、成功時 response、失敗時 error shape を決める
- object create / update / delete、scene snapshot fetch など、主要操作から先に揃える
- response には、可能なら scene state 参照用の情報を含める
- agent が自然言語のみで直接 state を推測しないよう、snapshot fetch を標準導線に入れる
- example は concise に保ち、長い narrative ではなく最小の request / response を示す

## 現在の runtime alignment

- success response は `ok: true` を先頭に置き、tool-specific fields を続ける
- error response は `ok: false` と `error: { code, message, retryable }` を返す
- invalid payload は `validation_error`、`retryable: false`
- room/session が missing または expired の場合は `unauthorized`、`retryable: false`
- state drift は `conflict`、`retryable: true` に寄せる
- `scene_sync_ai_command` は wrapper success と browser result success を分ける
- browser 側の失敗は `result.ok: false` で返し、wrapper レベルの transport error と混ぜない
- snapshot は runtime が自動で前後取得しないため、必要なら caller が before/after を明示する

## 段階的な実装ステップ

1. 最小 operation セットを定義する
   - `create_object`
   - `update_object`
   - `delete_object`
   - `get_scene_snapshot`
2. action schema をそろえる
   - stable action names
   - required params
   - optional params
   - response shape
3. error handling 方針を決める
   - validation error
   - not found
   - conflict
   - transport / internal error
   - unauthorized / missing session
4. snapshot ベースの確認フローを定義する
   - before snapshot
   - mutation
   - after snapshot
5. future integration へ展開する
   - MCP tool 定義への写像
   - GPTs / Codex 向け prompt contract の最小例

## acceptance criteria

- [ ] 主要 action の stable name が定義されている
- [ ] 各 action に required params と response expectations がある
- [ ] error handling の分類が定義されている
- [ ] scene snapshot before / after を使う標準フローが書かれている
- [ ] concise な request / response 例が含まれている
- [ ] future MCP / GPTs integration への接続方針が書かれている

## out of scope

- この task 内での MCP server 実装
- 完全な protocol 仕様書の完成
- production 向け SLA や権限モデルの策定
- FileTransfer への横展開

## staging確認方法

- `codex/**` branch で contract に沿った最小実装または developer tool を staging に出す
- action 名と payload 形式が UI / log / response で一致するか確認する
- before / after snapshot の流れで object 操作が追えるか確認する
- validation error と conflict の見分けがつくか確認する

## リスク

- contract を早く固定しすぎると、実装側の学びを取り込みにくい
- action 粒度が粗すぎると agent 側の判断が増え、細かすぎると運用コストが増える
- response に情報を盛りすぎると、安定性より利便性優先の設計になりやすい

## follow-up tasks

- action schema のサンプル JSON 追加
- Scene Sync developer tool との整合確認
- MCP tool 定義ドラフト作成
- snapshot diff ルールの簡略化

## agent向け注意

- 自然言語のみで state を推測せず、必要なら snapshot を取りに行く前提で考える
- action 名は branch ごとに揺らさない
- 実装時は concise な example を先に通し、拡張は後から行う
- issue 作成は必須ではなく、experimental branch で先に検証してよい
