# SceneSync for Godot

Godot Engine 4.x addon for `afjk.jp/scenesync`.

## Install

Copy `godot/addons/scene_sync` into your Godot project's `addons/scene_sync`, then enable `SceneSync` from `Project Settings > Plugins`.

## Editor

Enable the plugin, open the dock on the right side, then set:

- `URL`: `wss://afjk.jp/presence`
- `Room`: shared room code
- `Name`: display name

Use `Connect` to join the room. The `Publish` section exposes the current publish target root and explicit publish actions for selected nodes.

Recommended first-time flow:

1. Click `Create SceneSyncRoot`.
2. Place 3D objects under `SceneSyncRoot`.
3. Click `Publish Children`.

Godot publishes `Node3D` nodes as Scene Sync objects. The managed objects are the direct `Node3D` children of the Target Root, and the dock lists those children as `READY` or `SKIP`. A publish target must contain a `MeshInstance3D` on itself or in its descendants. Set `sync_root` to make the publish boundary explicit; `Publish Children` scans the direct children of that root. If a node cannot be published, the dock shows the skipped reason, such as `selected node is not Node3D` or `no mesh found in this node or children`.

Use `Republish Meshes` to export the current sync targets as `.glb` and publish updated mesh data through the blob store.

## Runtime

Add a `SceneSyncManager` node to your scene and configure:

- `presence_url`
- `room`
- `nickname`
- `sync_root`
- `auto_connect`

`SceneSyncManager` polls the presence server, syncs transforms, requests scene state on join, and handles mesh download/upload through the blob store.

The addon uses Godot .NET for Loomlet behavior graph evaluation. Use a .NET-enabled Godot 4.x editor/export template so `SceneSyncLoomletRunner.cs` and the vendored `Loomlet.Runtime` core are compiled.

## Unity compatibility

The addon follows the current Unity SceneSync wire shape for scene objects:

- preserves `asset`, `assetId`, `metadata`, `origin`, `unityHierarchyPath`, `visible`, and `asset.visualBasis`
- applies a `visualBasis: "unity"` GLB visual-root correction without changing the synchronized object transform
- computes `assetId` as `sha256-...` for locally exported GLB, matching the Unity runtime cache key format
- caches uploaded/downloaded GLB bytes by `assetId` and `meshPath` during the current session
- recovers expired blob-store GLB assets through Unity-compatible `scene-asset-request` and `file` handoff messages
- rebinds incoming scene objects to an existing unique Godot sync target when possible
- accepts `scene-batch` messages with `ops`, falling back to `actions` only when `ops` is absent
- accepts `scene-delete` as a removal alias
- preserves `scene-env.envId` in subsequent scene-state replies
- preserves `scene-state.loomGraphs` and `scene-graph-set` / `scene-graph-clear` updates when relaying scene state
- evaluates Loomlet object and scene behavior graphs through the same C# `Loomlet.Runtime` core used by Unity, with a Godot `Node3D` adapter for Scene Sync sink nodes

## Spec

See [docs/scene-sync-spec.md](../../../docs/scene-sync-spec.md) for the wire protocol and cross-client behavior.
