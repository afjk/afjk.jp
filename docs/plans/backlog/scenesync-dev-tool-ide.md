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

## near-term implementation tasks

- in-scene inspector follow-up
- state snapshot interface を明示化する
- selected object focus action を既存 viewer に足す
- read-only JSON view と copy flow を安定化する

## later tasks

- object block editing
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
- standalone payload tester は補助導線として残し、primary direction は in-scene inspector と明記する

