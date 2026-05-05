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

## current implementation status

- ✓ `scene_sync_get_scene` / `scene_sync_broadcast` / `scene_sync_ai_command` / `scene_sync_revoke` を中心にした stable contract は docs、OpenAPI、tool JSON に反映済み
- ✓ `scene_sync_ai_command` は browser-only action の wrapper として運用され、`focusObject`、camera pose、history、undo / redo、screenshot、GLB URL import を扱える
- ✓ success / error shape は `ok` と `error: { code, message, retryable }` を軸に docs と MCP runtime へ反映済み
- ✓ MCP server は `packages/scene-sync-mcp` として実装済みで、redeem / status / get_scene / object mutation / focus / screenshot / revoke まで揃っている
- ✓ example client と adapter でも `validation_error` / `unauthorized` / `conflict` の normalization が入っている
- partial: scene context は snapshot fetch と in-scene inspector snapshot export までで、inspector から AI instruction を直接送る flow は未実装
- partial: provider-neutral 化の下地はあるが、browser AI command と MCP tool の増加に対する drift prevention はまだ docs 運用寄り

## near-term implementation tasks

- browser AI command と MCP tool の対応表を backlog / spec 上で一箇所に固定する
- scene snapshot / before-after policy を dev tool と MCP examples の両方で同じ導線に揃える
- current scene context injection point を inspector 基準で整理する
- Dev Tool から AI instruction を送る前提条件と payload boundary を明文化する
- AI command 側の action 追加時に MCP / docs / examples を同時更新する運用ルールを固定する

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
