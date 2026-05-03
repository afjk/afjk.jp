# AI Integration

## purpose

Scene Sync と Loom を AI から再現性高く扱うために、stable action schema、response shape、scene context injection、Dev Tool integration を整理する track です。

## included ideas

- AI tool contract
- stable action schema
- runtime response shape alignment
- GPTs / MCP / Codex integration
- current scene context injection
- AI instructions from Dev Tool
- ambiguous natural-language-only operation を避ける

## out of scope

- provider-specific prompt tuning の最適化
- auth / billing / production governance
- natural language parser の実装

## near-term implementation tasks

- docs と runtime response shape の差分洗い出し
- error.code / retryable / unauthorized の runtime normalization
- scene snapshot / before-after policy の固定
- current scene context injection point の整理
- Dev Tool から AI instruction を送る前提条件の明文化

## later tasks

- provider-neutral AI wrapper stabilization
- inspector からの AI instruction flow
- Loom graph / code context injection
- safer retry / conflict assistance

## dependencies

- Scene Sync Dev Tool / IDE
- Scene Sync runtime response
- Enterprise / Security track の permission model

## risks

- action schema と runtime shape がずれると agent 実装が壊れやすい
- scene context を渡しすぎると payload 膨張と privacy risk が増える

## parallelization notes

- docs / samples と runtime alignment は分けられるが、schema rename は同時に走らせない
- producer / consumer 両側を変える場合は one PR first の順序を守る

## suggested first PR

- runtime response shape alignment diff doc と minimal reconciliation plan
- MCP runtime の structured error normalization と sample client update

## agent notes

- action 名を branch ごとに揺らさない
- scene context は「何を inject するか」を先に固定してから UI を広げる
