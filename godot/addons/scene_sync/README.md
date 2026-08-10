# SceneSync for Godot

Godot Engine 4.x addon for `afjk.jp/scenesync`.

## Install

Copy `godot/addons/scene_sync` into your Godot project's `addons/scene_sync`, then enable `SceneSync` from `Project Settings > Plugins`.

Deterministic physics additionally uses the vendored `godot/addons/godot-rapier3d` GDExtension. Copy that directory unchanged when physics execution is required. SceneSync continues to load and synchronize physics metadata safely when the extension is absent; only simulation is disabled.

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

The addon uses Godot .NET for Loomlet behavior graph evaluation. Use a .NET-enabled Godot 4.x editor/export template so `SceneSyncLoomletRunner.cs` and the vendored `Loomlet.Runtime` core are compiled.

## Wire assets

SceneSync can render wire assets without a pre-existing Godot scene node:

- GLB meshes from `asset.url`
- PNG, JPEG, and WebP images from `asset.url`
- UTF-8 text from `asset.url` or inline `asset.text`
- wire primitives, including fallback after an asset change

Remote assets are downloaded with bounded retries: at most four attempts, with 1, 2, and 4 second delays. GLB responses are limited to 50 MiB, image responses to 20 MiB, and text responses to 1 MiB. URLs must use HTTPS; desktop/editor builds additionally allow loopback HTTP for development. Redirects, credentials in URLs, and non-loopback HTTP are rejected. GLB structure, optional SHA-256 hashes, and image signatures are validated before rendering.

Remote URL failures do not enter the blob peer-recovery path. Existing `meshPath`/`assetId` carrier assets continue to use the blob cache and `scene-asset-request` recovery behavior.

URL meshes use the shared cache only when `assetId` is a lowercase `sha256-` value followed by exactly 64 hexadecimal characters. Friendly or malformed IDs are never used as URL cache keys. An explicit `source: "carrier"` always keeps the carrier path even if a stale `url` field is also present.

Subscribe to `SceneSyncManager.asset_load_diagnostic(object_id, detail)` for loading failures and retry status. `detail` contains safe fields such as `status`, `attempt`, `maxAttempts`, `assetType`, `reason`, `retryDelay`, and `willRetry`; it does not expose the URL or room credentials.

## Animation policy

The optional top-level `animation` object is preserved through add, delta, state, mesh replacement, cache/recovery, and locally built wire payloads. Supported fields are `clipName` (or `clip`), `mode` (`loop` or `once`), `speed`, `offset`, and `enabled`. With no policy, the first non-`RESET` clip is played automatically in a loop at normal speed. Explicit `animation: null` clears the stored policy and reapplies that default.

`clipName` remains the preferred selector. Numeric `clip` values use the source order of the GLB `animations` array; imported Godot animation-library name ordering does not change that index. Authored Godot animations without GLB source metadata retain deterministic name-order fallback behavior.

Use `SceneSyncManager.get_animation_policy(object_id)` to read a deep copy of the original wire policy. Managed nodes also expose it in the `scene_sync_animation` metadata key. The manager emits:

- `animation_policy_changed(object_id, node, policy)` when stored policy changes
- `animation_policy_applied(object_id, node, result)` after applying it to available `AnimationPlayer` nodes

Missing animation fields in ordinary deltas preserve the current policy. Policy application never changes the synchronized object's transform.

## Playback clock

`SceneSyncManager` supports Local, Shared Playback Follow, and Shared Playback Control modes through `playback_clock_mode`. Use `use_local_playback()`, `follow_shared_playback()`, `control_shared_playback()`, or `set_playback_clock_mode(mode)` at runtime, and inspect `get_playback_clock_state()`. Control mode publishes bounded `scene-clock` updates at `playback_clock_broadcast_interval` (minimum 0.05 seconds); Follow mode accepts newer remote revisions. `playback_clock_state_changed(state)` reports mode and clock changes.

In Follow and Control modes, remote-created managed `AnimationPlayer` clips are sampled from the shared object clock. Sampling applies `time * speed + offset`, modulo clip duration for loop mode and clamped for once mode, while freezing local animation advance. Authored/bound Godot animations are not sampled. Returning to Local resumes ordinary animation-policy playback for remote-created nodes, including when the exported mode property is changed directly.

## Deterministic Rapier physics

When scene physics has `enabled: true`, `SceneSyncManager` registers object physics dictionaries with `SceneSyncRapierWorld3D` and runs the same fixed-timestep Rapier 0.30 world used by the browser and Unity parity layer. Dynamic body position and rotation are applied to the corresponding Godot `Node3D`. Local playback follows monotonic time; shared Follow/Control modes derive the target physics tick from the shared playback clock.

The vendored GDExtension is pinned to tag `scenesync-v0.8.28-r0.30.0.3`, commit `b0578430c3b975bcf3bc0ee86df0450b51a57eb0`. Its release asset SHA-256 and platform matrix are recorded in `godot-rapier3d/SCENESYNC_BUILD.txt`. Included targets are macOS universal, Android arm64 (Quest), Linux x86_64, and Windows x86_64.

Use `get_rapier_status()` or `get_rapier_bridge()` to inspect availability, active state, fixed tick, and canonical state hash. Runtime signals are:

- `rapier_availability_changed(available)`
- `physics_runtime_state_changed(state)`
- `physics_hash_checked(report)`
- `physics_runtime_diagnostic(detail)`

The manager broadcasts canonical `scene-physics-hash` reports at `rapier_hash_broadcast_interval_ticks` and verifies compatible remote reports against profile `SceneSyncRapierParity-0.30`, hash contract `SceneSyncCanonicalPhysicsHashV1`, and Rapier core `0.30.0`. Catch-up work is bounded by `rapier_max_steps_per_update`. Set `rapier_physics_enabled` to disable execution while retaining metadata synchronization.

Scene physics metadata remains available through `get_scene_physics()` and `scene_physics_changed(physics)`. Object physics is deep-copied into the `scene_sync_physics` node metadata key and available through `get_object_physics(object_id)` and `object_physics_changed(object_id, node, physics)`.

Physics metadata round-trips through scene state, add, delta, mesh replacement, cache recovery, and locally built payloads. An omitted field preserves the current dictionary; explicit `physics: null` clears it.

Nodes created solely for received SceneSync objects carry `scene_sync_remote_object`. Disconnect and remote remove/delete messages remove only those remote-created nodes and clear their manager state. Existing authored Godot nodes that were rebound to a wire object are not marked: remove/delete only unpublishes them, and incoming carrier mesh updates preserve their root and subtree instead of replacing them.

## Unity compatibility

The addon follows the current Unity SceneSync wire shape for scene objects:

- preserves `asset`, `assetId`, `metadata`, `origin`, `unityHierarchyPath`, `visible`, and `asset.visualBasis`
- applies a `visualBasis: "unity"` GLB visual-root correction without changing the synchronized object transform
- computes `assetId` as `sha256-...` for locally exported GLB, matching the Unity runtime cache key format
- caches uploaded/downloaded GLB bytes by `assetId` and `meshPath` during the current session
- recovers expired blob-store GLB assets through Unity-compatible `scene-asset-request` and `file` handoff messages
- renders Unity-compatible URL mesh, image, and text assets with bounded validation and retry behavior
- preserves and applies the Unity animation policy across mesh replacement and recovery
- rebinds incoming scene objects to an existing unique Godot sync target when possible
- accepts `scene-batch` messages with `ops`, falling back to `actions` only when `ops` is absent
- accepts `scene-delete` as a removal alias
- preserves `scene-env.envId` in subsequent scene-state replies
- preserves `scene-state.loomGraphs` and `scene-graph-set` / `scene-graph-clear` updates when relaying scene state
- evaluates Loomlet object and scene behavior graphs through the same C# `Loomlet.Runtime` core used by Unity, with a Godot `Node3D` adapter for Scene Sync sink nodes

## Spec

See [docs/scene-sync-spec.md](../../../docs/scene-sync-spec.md) for the wire protocol and cross-client behavior.
