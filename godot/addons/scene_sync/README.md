# SceneSync for Godot

Godot Engine 4.x addon for `afjk.jp/scenesync`.

## Install

Copy `godot/addons/scene_sync` into your Godot project's `addons/scene_sync`, then enable `SceneSync` from `Project Settings > Plugins`.

## Editor

Enable the plugin, open the dock on the right side, then set:

- `URL`: `wss://afjk.jp/presence`
- `Room`: shared room code
- `Name`: display name

Use `Connect` to join the room and `Sync Meshes` to export local meshes as `.glb` and publish them through the blob store.

## Runtime

Add a `SceneSyncManager` node to your scene and configure:

- `presence_url`
- `room`
- `nickname`
- `sync_root`
- `auto_connect`

`SceneSyncManager` polls the presence server, syncs transforms, requests scene state on join, and handles mesh download/upload through the blob store.

## Spec

See [docs/scene-sync-spec.md](../../../docs/scene-sync-spec.md) for the wire protocol and cross-client behavior.
