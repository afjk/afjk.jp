# Scene Sync Rapier

Optional Unity bridge that runs Scene Sync browser physics with
`com.afjk.rapier`.

This package intentionally sits downstream of both packages:

- `com.afjk.scene-sync` owns network, objects, and wire metadata.
- `com.afjk.rapier` owns Rapier world APIs and native plugins.
- `com.afjk.scene-sync-rapier` maps Scene Sync `physics` JSON into Rapier bodies.

## Install For Local Testing

Add all three packages to the Unity project manifest while Rapier is not yet in
`upm.afjk.jp`:

```json
{
  "dependencies": {
    "com.afjk.scene-sync": "file:/Users/afjk/github/SceneSyncWork/afjk.jp/unity/com.afjk.scene-sync",
    "com.afjk.scene-sync-rapier": "file:/Users/afjk/github/SceneSyncWork/afjk.jp/unity/com.afjk.scene-sync-rapier",
    "com.afjk.rapier": "https://github.com/afjk/rapier-unity.git?path=Packages/com.afjk.rapier#v0.3.0"
  }
}
```

For monorepo development you can replace the Rapier Git URL with a local
`file:` path.

## Usage

1. Add `SceneSyncRapierBridge` to the same GameObject as `SceneSyncManager`.
2. Connect to a room that has Scene Sync `physics` enabled in the Web client.
3. When scene objects contain object-level `physics`, Unity creates a Rapier
   world and applies dynamic body poses back to the corresponding GameObjects.

The bridge uses Scene Sync wire coordinates as the physics basis, then converts
body poses back to Unity coordinates when applying transforms.

When the Web client publishes Shared Playback `scene-clock` messages, the bridge
uses the shared clock time to step Rapier to the matching fixed tick. Reset and
seek-to-zero payloads with `physicsBaseline` restore the initial Rapier snapshot
before stepping again.

When scene metadata changes cause a Rapier world rebuild, the bridge preserves
dynamic body pose, linear velocity, and angular velocity for matching Scene Sync
object ids. Reset baselines still restore the initial snapshot unless
`physicsBaseline.preserveMotion` is explicitly true.

`SceneSyncRapierBridge.CollisionEvent` raises Web-compatible
`physics.collision.enter` and `physics.collision.exit` events after fixed physics
steps. Events include sorted `objectIdA` / `objectIdB`, `pairKey`, physics
`tick`, `time`, `source: "physics"`, and `phase: "postPhysics"`.

`SceneSyncRapierBridge.ComputeStateHashHex()` returns the current
`SceneSyncCanonicalPhysicsHashV1` value as 16-character lowercase hex.
`LastStateHash` is updated after rebuilds, resets, and physics steps without
requiring `logStateHash`; enable `logStateHash` only when console output is
useful. Compare this value with the browser runtime's `world.canonicalStateHash()`
only when both hosts use the same Scene Sync Rapier parity profile.

During Shared Playback, the Web clock controller and the Unity bridge
periodically broadcast `scene-physics-hash` messages with
`SceneSyncCanonicalPhysicsHashV1`, Rapier core version, physics profile, fixed
`tick`, and canonical hash. The bridge stores the latest remote report in
`LastRemoteHashReport`, exposes `LastRemoteHashMatched`, and raises
`HashReportReceived` after comparing the remote hash with the local world at the
same tick. Hash messages are diagnostic and drive snapshot requests; they do not
stream body transforms.

The bridge also accepts `scene-physics-snapshot` messages using
`SceneSyncPhysicsSnapshotV1`. When `autoApplyRemoteSnapshots` is enabled and all
dynamic body ids exist locally, the bridge applies the remote body pose, linear
velocity, angular velocity, fixed tick, and world epoch. Snapshot results are
available through `LastRemoteSnapshotReport`, `LastRemoteSnapshotApplied`, and
`SnapshotReceived`.

When `requestSnapshotOnHashMismatch` is enabled, same-tick hash mismatches
publish a `scene-physics-snapshot-request` through `SceneSyncMessageBus`. A
`SceneSyncManager` in the scene routes that request through the active presence
connection, allowing the Web Shared Playback controller to hand back a targeted
snapshot.

## Interaction Controller

`SceneSyncRapierInteractionController` is a Play Mode helper for rooms that
already use `SceneSyncRapierBridge`. Add it to the same GameObject as the bridge
or run **Window > Scene Sync > Create Scene Sync Setup** to create and wire the
manager, Rapier bridge, and interaction controller together. Assign the bridge
and camera manually if auto-discovery is not enough.

- `WASD` moves the camera horizontally relative to view direction.
- `E` / `Q` moves up and down.
- Right mouse drag rotates the camera.
- Left mouse drag grabs a dynamic Rapier body under the cursor and publishes
  `scene-physics-input` events.
- Left mouse release publishes the final body state with throw velocity.

The controller does not publish Scene Sync transform deltas while dragging. It sends
scheduled Rapier body-state inputs, and Unity/Web apply those inputs at the same
physics tick before stepping. For picking, the controller uses Unity raycasts; when
a dynamic Scene Sync object has no Collider, it can add a lightweight BoxCollider
from renderer bounds for Play Mode interaction.

Each drag is published as a timeline interaction with a stable
`interactionId`, monotonic `sequence`, a generic `controlMode` (`hold` while the
body is being dragged, `release` on throw/cancel), `eventRevision`, and
`applyTick`. The controller also sends a human-readable `phase` string
(`grab-start` / `grab-move` / `grab-release`) for debugging, but the runtime
core decides hold/release purely from `controlMode` and never inspects the phase
name. The Rapier bridge keeps these events as the primary synchronization
source; snapshots are checkpoints for late join/recovery and are ignored when
their timeline revision or event watermark is older than the local event
history. When a local drag starts after a rewind and future inputs already
exist, or when a newer `timelineRevision` arrives from the room, future inputs
after the fork tick are discarded so the new interaction can fork the playback
history.

While `disableRemoteSnapshotCorrection` is set, the controller switches the bridge to
the `IgnoreWhileLocalInteractionActive` snapshot apply policy and toggles
`SceneSyncRapierBridge.LocalInteractionActive` for the duration of a drag, rather
than permanently turning snapshot correction off. Shared Playback Player UI still
drives the shared clock and snapshot correction resumes as soon as the local
interaction ends, so periodic `scene-physics-snapshot` messages do not overwrite
local drag/release authority mid-interaction.

The package also includes a small `Rapier Interaction Sample` in the Package
Manager **Samples** tab for older scenes that reference
`SceneSyncRapierInteractionSample`. New setups should use
`SceneSyncRapierInteractionController` directly.

## PlayerUI Parity Sample

`SceneSyncRapierParitySampleBootstrap` builds a small floor + falling box scene
matching `fixtures/rapier/parity-basic-001.json`, connects a `SceneSyncManager`
to a room, and shows tick/hash diagnostics in the Unity Game View.

From the repo root:

```bash
npm run sample:scene-sync-rapier
```

The command starts a local presence server, configures the sibling
`SceneSyncClient` project through uloop, enters Unity Play Mode, and prints a
PlayerUI URL. Open that URL to see the Web side in the same room. The loader peer
keeps the sample `scene-state` available and logs `scene-physics-hash` messages
from Unity and PlayerUI.

For an automated Unity-vs-Web Rapier hash check without launching a browser:

```bash
npm run test:e2e:scene-sync-rapier-playerui-sample
```

To also launch the real PlayerUI shell in Chromium and verify Unity and PlayerUI
both publish the same tick 60 physics hash:

```bash
npm run test:e2e:scene-sync-rapier-playerui-browser
```

Install the local Chromium binary first when needed:

```bash
npm run test:e2e:install-browsers
```
