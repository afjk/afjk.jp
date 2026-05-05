# Asset Pipeline / Carrier GLB

## purpose

Scene Sync に入る多様な asset を placement-compatible に扱うため、GLB / carrier GLB を compatibility layer に据えた asset pipeline を整理する track です。

## included ideas

- image upload
- image to texture plane GLB
- video poster plane GLB + video blob / URL
- webpage placeholder GLB + URL metadata
- text to CanvasTexture text plane GLB
- GLB placement
- asset library
- browser-side vs server-side conversion
- `prepareSceneSyncFile()` as a central entry point candidate
- `transfer.putAsset(file)` / `transfer.getAsset(assetId)` future direction

## out of scope

- 全 asset type の production-ready converter 実装
- asset moderation / DRM
- advanced renderer 本体

## near-term implementation tasks

- carrier GLB decision を architecture doc に固定する
- asset class ごとの metadata shape を一覧化する
- browser-side conversion と server-side conversion の責務を比較する
- `prepareSceneSyncFile()` の責務候補を整理する

## later tasks

- image-to-plane pipeline (✓ Phase 1 done: Web URL drop + TextureLoader plane with png/jpg/jpeg/webp/gif/avif/bmp; ✓ Wave 3: browser-side carrier GLB via Web UI)
- text-to-plane pipeline (✓ done: browser-side carrier GLB via Web UI, Wave 4)
- video asset pipeline (✓ Phase 1 done: Web URL drop + VideoTexture plane, mp4/webm/mov/m4v only; Phase 2 needed: playback sync; Phase 3-4: Unity/Godot; HLS/DASH deferred)
- GLB URL drop pipeline (✓ Phase 1 done: Web URL drop + GLTFLoader mesh, .glb only; .gltf deferred; Phase 2: Unity/Godot; audio asset pipeline parallel)
- webpage carrier pipeline
- asset library and reusable asset references
- transfer-core integration

## dependencies

- architecture/asset-carrier-glb-decision
- Refactoring / Packages track
- Enterprise / Security track for signed URLs

## risks

- asset type ごとに sync interface を増やすと Scene Sync protocol が崩れやすい
- conversion を server に寄せすぎると開発速度が落ちる
- carrier と runtime replacement の境界が曖昧だと debug が難しい

## parallelization notes

- asset type matrix、conversion location、transfer API doc は並列化できる
- `meshPath` / metadata contract を変える task は single-agent で扱う

## suggested first PR

- asset class matrix と `prepareSceneSyncFile()` responsibility note

## agent notes

- preferred direction は GLB / carrier GLB compatibility layer を崩さないこと
- special runtime data は metadata または referenced blobs へ逃がす

