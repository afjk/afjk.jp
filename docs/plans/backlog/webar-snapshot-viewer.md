# WebAR Snapshot Viewer

## purpose

editing と playback を分離し、room snapshot を各デバイスで再生できる viewer / export flow を整理する track です。

## included ideas

- editing and playback separation
- iPhone playback via USDZ / AR Quick Look
- Android via Scene Viewer
- Quest via WebXR
- `<model-viewer>` based viewer
- `/api/room/{roomId}/glb`
- `/api/room/{roomId}/usdz`
- QR flow
- snapshot playback only
- no realtime sync in first version
- Three.js `USDZExporter` feasibility

## out of scope

- first version での realtime sync
- full editor-in-AR
- multi-user AR session

## near-term implementation tasks

- snapshot export API candidates を整理する
- USDZ export feasibility を検討する
- QR flow の UX を定義する
- playback-only architecture を文書化する

## later tasks

- GLB snapshot viewer
- USDZ export path
- Android / Quest playback validation
- shareable snapshot flow

## dependencies

- Asset Pipeline / Carrier GLB
- Advanced Rendering for non-GLB fallback
- Enterprise / Security for signed snapshot URLs

## risks

- realtime editing を混ぜると scope が急激に増える
- USDZ export feasibility を確認せずに API を決めると手戻りしやすい

## parallelization notes

- API sketch、device playback matrix、QR UX は分離しやすい
- exporter feasibility が出る前に URL contract を固めすぎない

## suggested first PR

- snapshot playback architecture note and device matrix

## agent notes

- first version は playback only を守る
- `/api/room/{roomId}/glb` と `/api/room/{roomId}/usdz` は contract 候補として扱い、即実装前提にしない

