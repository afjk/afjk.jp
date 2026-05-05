# Refactoring / Packages

## purpose

`afjk.jp` の app / protocol / transfer / presence 周りを、後続の Scene Sync / Loom / AI / asset development を並列化しやすい構成へ寄せるための track です。

## included ideas

- organize `pipe` internally as `file-transfer`
- treat `scenesync` as an independent app
- move toward `apps/` and `packages/`
- presence-client extraction
- scene-sync-protocol extraction
- `scene.js` split
- transfer-core
- Scene Sync asset transfer through transfer-core
- presence-server split
- URL / API compatibility

## out of scope

- repo split の即時実施
- user-facing product redesign
- nonessential dependency migration

## current implementation status

- ✓ `apps/presence-server` と `packages/scene-sync-mcp` への分離はすでに進んでおり、AI command / MCP まわりの server-side 責務はこの2点に集まりつつある
- ✓ MCP server は session store、client、validators、tool-results に分割されている
- ✓ `html/assets/js/scenesync/scene.js` は loader / component / link / history / ui / loom などの補助 module を持つ形まで分割が進んでいる
- partial: `scene.js` は依然として coordinator として大きく、AI command 実装も viewer 内に残っている
- pending: presence-client commonization、scene-sync-protocol extraction、transfer-core 化

## near-term implementation tasks

- priority order を固定する
- `presence-client` commonization boundary を定義する
- `scene-sync-protocol` extraction candidate を洗い出す
- browser AI command handler を `scene.js` から段階的に切り出す plan を作る
- MCP tool definition と browser AI action definition の ownership を揃える

## later tasks

- `transfer-core`
- Scene Sync asset transfer through transfer-core
- presence-server split
- apps / packages deeper reorg
- repo / service split if needed

## dependencies

- Scene Sync runtime knowledge
- FileTransfer area
- Asset Pipeline / Carrier GLB

## risks

- broad refactor を先にやりすぎると product iteration が止まる
- URL / API compatibility を壊すと周辺 tool も巻き込む

## parallelization notes

- extraction candidates doc と file inventory は並列化できる
- `scene.js` split と protocol extraction を同時実装する場合は ownership を細かく分ける

## suggested first PR

- `presence-client` commonization plan and file inventory

## agent notes

- suggested priority:
- 1. presence-client commonization
- 2. scene-sync-protocol extraction
- 3. scene.js split
- 4. transfer-core
- 5. Scene Sync asset transfer through transfer-core
- 6. presence-server split
- 7. repo / service split only if needed
