# Scene Sync Dev Tool / IDE

## purpose

Scene Sync 画面の中で scene state を見て、将来的には object / block / AI instruction を扱える developer tool / lightweight IDE に育てるための track です。

## included ideas

- in-scene Inspector panel
- realtime scene state text / JSON view
- selected object focus
- object block editing
- text editor with autocomplete
- node graph editor
- AI instruction input later

## out of scope

- full Loom runtime editor の完成
- natural language parser の完成
- multi-user conflict UI の完成

## current implementation status

- ✓ in-scene Scene Inspector panel は `html/scenesync/` に実装済み
- ✓ realtime scene state JSON view、summary、copy flow、selected object block view は実装済み
- ✓ scene 全体 JSON と selected object JSON の prototype edit / validate / format / apply flow は実装済み
- ✓ developer workflow は in-scene Scene Inspector に集約し、standalone payload tester は削除済み
- partial: `focusObject` action 自体は browser / MCP contract に存在するが、inspector からの直接導線はまだ薄い
- pending: autocomplete editor、node graph editor、AI instruction input

## near-term implementation tasks

- inspector から selected object focus / camera jump を直接叩ける導線を足す
- scene/object JSON edit の editable scope と ignored field policy をさらに明示化する
- scene snapshot を AI / external tool に渡す導線を整理する

## later tasks

- autocomplete 付き text editor
- inspector と node graph の接続
- AI instruction entry with scene context

## dependencies

- Scene Sync state access interface
- selected object / focus API
- AI Integration track の action schema

## risks

- UI を先に広げすぎると state interface が不安定なまま密結合になる
- node graph editor を早く混ぜると Loom track と責務が曖昧になる

## parallelization notes

- state interface 固定前は UI と state adapter を別 agent に分けすぎない
- state interface 固定後は panel UI、focus action、copy/export UX を分離しやすい

## suggested first PR

- Scene Inspector follow-up: summary 表示改善、selected object focus、state export helper の小整理

## agent notes

- `/scenesync/` route とその store / state access を複数 agent で同時に触らない
- developer UI は in-scene Scene Inspector を primary surface とする
