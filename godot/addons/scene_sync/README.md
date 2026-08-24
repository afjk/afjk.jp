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

The Editor dock synchronizes scene data and physics metadata, but Godot exposes runtime GDExtension classes as placeholders while the editor is active. Rapier simulation therefore starts only when the scene is run with **Play**. Disconnect the Editor dock before Play if the runtime `SceneSyncManager` uses the same room, so the editor and game do not appear as two peers.

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

`SceneSyncManager` supports Local, Shared Playback Follow, Shared Playback Control, and Room Time modes through `playback_clock_mode`. Use `use_local_playback()`, `follow_shared_playback()`, `control_shared_playback()`, `use_room_time()`, or `set_playback_clock_mode(mode)` at runtime, and inspect `get_playback_clock_state()`.

`welcome.serverTime` is captured as a RoomNow anchor. Received shared clocks are anchored to the local monotonic clock at receipt; a follower never extrapolates with the difference between its wall clock and the sender's `sentAt`. `serverTime` and `sentAt` are Unix milliseconds, while `roomNow`, `offset`, `pausedTime`, `time`, and `targetTime` are seconds. Canonical payloads may also carry `active`, `controller`, `leaseExpiresAt` (Unix milliseconds), and `leaseDurationMs`. Legacy payloads without those fields remain supported.

Control mode supports `pause_playback_clock()`, `resume_playback_clock()`, `seek_playback_clock(time)`, `reset_playback_clock()`, and `set_playback_rate(rate)`. These publish the compatible `pause`, `play`, `seek`, `reset`, and `rate` operations. `release_playback_control()` publishes a release and immediately rebases to local monotonic 1x time; it does not wait for the server echo. Room Time continuously exposes RoomNow and does not accept transport operations.

Control capability and follow behavior are separate. Set `allow_playback_control` to disable controller acquisition, and choose `playback_follow_policy` from Manual, Auto Follow or Local, and Follower Only. Follower Only always has effective `allowControl: false` and never emits a controller acquisition. Auto Follow or Local and Follower Only follow only while an authoritative controller is active; release, peer disappearance, disconnect, or lease expiry rebases the last displayed Shared Time and ObjectAge to local monotonic 1x time without a reset.

Control mode publishes bounded `scene-clock` updates at `playback_clock_broadcast_interval` (minimum 0.05 seconds); Follow mode accepts newer remote revisions. `playback_clock_state_changed(state)` reports configured and effective mode, policy, controller, lease, pause, and rate state.

In Follow, Control, and Room Time modes, remote-created managed `AnimationPlayer` clips, Loomlet `scene.clock`, and Rapier all consume the same per-frame effective ActiveTime and ObjectAge sample. Sampling applies `time * speed + offset`, modulo clip duration for loop mode and clamped for once mode, while freezing local animation advance. Local transport operations and automatic Follow-to-Local fallback also use that shared manager sample. Untouched Local mode retains the existing ordinary animation and Loomlet delta behavior. Authored/bound Godot animations are not sampled.

## Deterministic Rapier physics

When scene physics has `enabled: true`, `SceneSyncManager` registers object physics dictionaries with `SceneSyncRapierWorld3D` and runs the same fixed-timestep Rapier 0.30 world used by the browser and Unity parity layer. Dynamic body position and rotation are applied to the corresponding Godot `Node3D`. Local playback follows monotonic time; shared Follow/Control modes derive the target physics tick from the shared playback clock.

Received transforms are applied before physics registration. When `physics.initialTransform` is omitted, the body starts from that received `Node3D` position and rotation; an explicit `initialTransform` remains authoritative. Explicit `halfExtents` and `radius` are collider dimensions and are not multiplied by visual scale.

Rapier execution is runtime-only in Godot: use **Play** or an exported build. Editor mode still receives, preserves, edits, and republishes physics metadata, and `get_rapier_status()` reports `rapier-runtime-requires-play` without invoking the placeholder extension instance.

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

## Gaussian Splats (KHR_gaussian_splatting GLB)

SceneSync exchanges 3D Gaussian Splats as GLB files carrying the `KHR_gaussian_splatting`
extension. The addon does not parse `.sog` / `.spz` / `.lcc2` and friends; SceneSync Web
normalizes those formats and the addon consumes the resulting GLB.

`SceneSyncGltfHelper.import_glb()` detects the extension and routes such GLBs away from
`GLTFDocument`, which cannot interpret them.

### Editor placement

Use `Project > Tools > Scene Sync: Gaussian Splat GLB を読み込む...` to add a
`SceneSyncGaussianSplatNode3D` to the edited scene (undoable), or add the node from the
`Add Node` dialog and set `glb_path`. The node is a `@tool` node, so it renders in the 3D
viewport as soon as the scene is opened — running the project is not required. Transform and
visibility behave like any other `Node3D`; the visual child is rebuilt from `glb_path`
instead of being saved into the `.tscn`.

When the GLB lives inside `res://`, set its import type to **Keep File (exported as is)**.
Godot's own glTF importer cannot interpret `KHR_gaussian_splatting`.

### Renderer backend

Actual splat rendering is delegated to a pluggable backend:

```gdscript
SceneSyncGaussianSplatBackend.register_backend(MySplatBackend.new())
```

A backend is any object exposing `get_backend_name()`, `can_render(info)` and
`create_splat_node(data, info)`. When no backend is registered the addon falls back to a
dependency-free point-cloud preview built from `POSITION` and `COLOR_0` (or SH0 + opacity).
**The preview is for placement and scale, not final rendering quality.**

See [docs/scene-sync-3dgs-engine-integration.md](../../../docs/scene-sync-3dgs-engine-integration.md).

## Spec

See [docs/scene-sync-spec.md](../../../docs/scene-sync-spec.md) for the wire protocol and cross-client behavior.
