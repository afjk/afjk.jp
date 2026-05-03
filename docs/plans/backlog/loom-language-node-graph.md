# Loom Language / Node Graph

## purpose

`.loom` コード、node graph、preview、inspector を同期させた Loom authoring 体験を整理し、後続の `loom/` 実装と `afjk.jp` 側 integration を切り分けやすくする track です。

## included ideas

- `.loom` code format
- code editor and node graph synchronized editing
- left code editor / right node graph / bottom preview layout
- IDE autocomplete
- error display
- Inspector
- JS runtime target
- Unity C# runtime target
- Scene Sync realtime distribution
- future collaborative editing

## out of scope

- この repo での Loom runtime 本体完成
- full collaborative editor の即時実装
- complete language spec

## near-term implementation tasks

- `.loom` document shape の初期定義
- code view と graph view の source-of-truth 方針整理
- error surface と preview ownership の整理
- Scene Sync distribution interface の接点メモ

## later tasks

- code editor prototype
- graph editor prototype
- synchronized editing
- runtime target adapters
- collaborative editing

## dependencies

- Loom integration responsibility
- AI Integration track の schema stability
- Refactoring / Packages track の protocol extraction

## risks

- code view と graph view の canonical source を曖昧にすると破綻しやすい
- `afjk.jp` と `loom/` の責務境界がぼやける

## parallelization notes

- language doc、layout doc、runtime target doc は並列化しやすい
- canonical source の設計が固まる前に editor 実装を並列化しすぎない

## suggested first PR

- `.loom` document shape と code / graph canonical source decision の初期 doc

## agent notes

- `afjk.jp` 側では integration / preview / inspection responsibility に寄せる
- `loom/` 側 implementation が必要な task は別 repo task として切り出す

