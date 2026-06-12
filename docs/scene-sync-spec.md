# Scene Sync Spec Index

Scene Sync 仕様の入口です。詳細仕様は以下に分冊します。

- [API / Protocol](./scene-sync-api-protocol.md)
- [Asset / Blob / Cache](./scene-sync-assets-and-cache.md)
- [Safe Mode / Diagnostic Flags](./scene-sync-safe-mode-and-diagnostics.md)
- [座標系と visualBasis](./scene-sync-coordinate-system.md)
- [Web UI / UX](./scene-sync-web-ux.md)
- [Unity オーサリングモデル](./scene-sync-unity-authoring.md)
- [Avatar / Presence](./scene-sync-avatar-and-presence.md)
- [Animation](./scene-sync-animation.md)
- [Runtime Time Model](./scene-sync-runtime-time-model.md)
- [Deterministic Physics](./scene-sync-physics.md)
- [Loom / Behavior Graph Protocol](./scene-sync-loom-protocol.md)
- [Realtime Streaming Notes](./scene-sync-realtime-streaming.md)

## 重要ルール

- room にいる client が scene-state の source of truth です。
- GLB の向き補正は `origin` ではなく `asset.visualBasis` で判断します。
- Unity 由来 GLB は `asset.visualBasis: "unity"` を保持します。
- Unity Editor 由来 object は、Web から削除されても Unity Hierarchy 上の GameObject は残します。
- browser reload 時は、既存 scene が空の場合だけ IndexedDB snapshot restore を試します。
