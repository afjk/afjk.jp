# Scene Sync Physics Runtime

Scene Sync uses Rapier for browser-side rigid-body physics.

- Runtime adapter: `html/assets/js/scenesync/physics/rapier-world.js`
- Scene integration: `html/assets/js/scenesync/scene-physics.js`
- Browser package: `@dimforge/rapier3d-deterministic-compat@0.19.3`
- Target Rapier core for parity: `0.30.0`
- Pinned browser asset: `html/assets/vendor/rapier/0.19.3/rapier.mjs`
- Tests: `npm run test:physics`

The old fixed-point physics engine has been replaced. Scene compatibility with
the old physics implementation is not a goal; the Scene Sync time policy is.

## Time Model

Physics is evaluated from a physics world/session age, not raw host time,
raw room time, or the minimum `ObjectAge` across bodies. Rapier is one coupled
world, so the runtime keeps one world epoch for the whole session.

```txt
PhysicsWorldAge = ActiveTime - PhysicsWorldEpoch
targetTick = floor(PhysicsWorldAge / timestep)
```

Editor Shell uses Local Preview by default, so each client simulates its own
local physics preview. Shared Playback and Room Time use the shared active
clock baseline; animation and Loomlet still use shared object epochs for
`ObjectAge`.

Runtime rules:

- placed physics objects start immediately
- gravity changes apply immediately
- transform editing rebases the physics body and world epoch
- object add/remove and world setting changes rebuild the world from the
  current simulated pose, then reset the world epoch
- reload recreates physics from the restored transform
- reset restores the initial Rapier snapshot
- seek restores a snapshot and steps fixed ticks to the target

## Rapier World Adapter

The adapter exposes a small Scene Sync world API:

```js
import { initRapierPhysics, createWorld } from './html/assets/js/scenesync/physics/index.js';

await initRapierPhysics();

const world = createWorld({
  gravity: -9.81,
  ground: { y: 0, restitution: 0.2, friction: 0.5 },
  timestep: 1 / 60,
});

world.addBody({
  id: 'ball-1',
  shape: 'sphere',
  radius: 0.5,
  position: [0, 3, 0],
  rotation: [0, 0, 0, 1],
  velocity: [0, 0, 0],
  angularVelocity: [0, 0, 0],
  mass: 1,
  restitution: 0.6,
  friction: 0.5,
});

world.stepTo(120);
world.snapshot();
world.restore(snapshot);
world.canonicalStateHash();
world.free();
```

The serialized scene schema uses seconds for `worldOptions.timestep`. Legacy
fixed-point physics content is not a compatibility target and is not
special-cased by the Rapier runtime.

## Determinism And Parity

Scene Sync uses `@dimforge/rapier3d-deterministic-compat` (the Rapier
cross-platform deterministic build) so that identical initial state, identical
input sequences, and identical fixed-tick counts reproduce the same physics
result on every client.

Rapier determinism depends on the same Rapier core version, deterministic build
flavor, timestep, solver/integration settings, initial scene, object creation
order, and operation order. Scene Sync therefore creates bodies in stable scene
order and never feeds frame delta into the simulation.

Cross-host parity with Unity/Godot/Browser requires the full match set:

- Rapier core version: `0.30.0`
- deterministic build flavor
- fixed timestep and gravity
- solver/integration parameters that affect stepping
- stable object id ordering
- tick-level input event ordering
- canonical hash and snapshot schema

The browser runtime imports:

```js
import RAPIER from '@dimforge/rapier3d-deterministic-compat';
```

The runtime exposes `canonicalStateHash()` using
`SceneSyncCanonicalPhysicsHashV1`, an exact FNV-1a-64 hash over raw `f32` state
fields sorted by `stableIdHash(objectId)`, where `stableIdHash` is
`FNV-1a-64(UTF-8(objectId))`. The older `stateHash()` API remains a local
32-bit compatibility value over tick, timestep, and native Rapier snapshot
bytes.

### Cross-Host Parity Fixture

The Unity/Browser parity fixtures live under:

```text
fixtures/rapier/
```

They define the `SceneSyncRapierParity-0.30` profile, Rapier core `0.30.0`,
fixed timestep, gravity, stable object ids, body/collider material fields, and
sample ticks through tick 600. Browser-side fixture support is implemented by
`html/assets/js/scenesync/physics/rapier-parity-fixture.js` and covered by
`rapier-parity-fixture.test.js`.

The staged fixtures provide narrower parity coverage for regression isolation:

- `parity-freefall-001.json` removes contacts through tick 600 and exercises
  free rigid-body integration.
- `parity-contact-basic-001.json` uses a fixed floor plus one vertically falling
  dynamic box with zero friction, zero restitution, zero angular velocity, no
  damping, and explicit combine rules.
- `parity-basic-001.json` is the original floor + moving/rotating box case. It
  has been manually validated in Unity 6000 and matches the Browser hashes
  through tick 600. Keep the staged fixtures around to isolate future
  contact/material/solver regressions from initial-state setup issues.

The `bodies` array order is the fixture creation order. Hashes and dumps still
compare bodies/colliders by `stableIdHash(objectId)` so handle order does not
become part of the public parity result.

The Browser result schema is intended to match the Unity sample output:

```json
{
  "host": "browser",
  "profile": "SceneSyncRapierParity-0.30",
  "hashes": {
    "0": "..."
  },
  "dumps": {
    "0": {
      "bodies": [],
      "colliders": []
    }
  }
}
```

Use `hashes` for the parity comparison. Use `dumps` when a hash diverges; it
contains the canonical body and collider fields used by the hash.

Do not use non-deterministic local calculations to create physics inputs for
Shared Playback. Authoring inputs must be normalized through scene state, scene
deltas, or controller-published playback baselines.

Scene Sync treats deterministic replay as an optimization, not the only
correctness mechanism. Divergence due to network reordering, late join,
implementation drift, or version differences is expected. The future resync path
detects divergence via state hash comparison and recovers by restoring a
shared Rapier snapshot. Shared Playback must therefore be able to restore
snapshots or reset instead of relying on long fast-forwarding from arbitrary old
state.

### State Hash

`rapier-world.js` exposes three ways to hash physics state:

- `world.canonicalStateHash()` — exact `SceneSyncCanonicalPhysicsHashV1`
  FNV-1a-64 hash over raw `f32` state fields sorted by
  `stableIdHash(objectId)`. It includes gravity, timestep, the empty PID
  controller registry marker used by the Unity native profile, body type,
  gravity scale, damping, additional solver iterations, CCD/soft-CCD/can-sleep
  settings, pose, velocities, sleeping/enabled state, collider shape, density,
  friction/combine rule, restitution/combine rule, sensor, and enabled state.
  Use this for cross-host parity detection.
- `world.canonicalStateDump()` — object containing the canonical body and
  collider fields used for parity debugging. This is not a snapshot format.
- `world.stateHash()` — 32-bit local compatibility hash over engine/package,
  tick, timestep, and native Rapier snapshot bytes. It is useful for same-host
  replay/debug callers that expect a numeric hash; do not use it as the
  cross-host canonical parity signal.
- `world.networkStateHash()` — iterates bodies in Scene Sync objectId order
  (same as `getBodies()`) and hashes translation/rotation/linvel/angvel per
  body; returns an 8-char hex string. Stable across remove/recreate and
  snapshot restore as long as scene composition is the same. Kept as the older
  network-shareable divergence signal; prefer `canonicalStateHash()` for parity.
- `computeRapierWorldStateHash(rapierWorld)` — raw Rapier World debug helper
  ordered by rigid-body handle. Handles must match exactly across compared
  worlds. Do not use for network divergence detection; prefer
  `networkStateHash()` instead.

### Scene Physics Hash Messages

During Shared Playback, only the current Web Scene Clock controller broadcasts
low-frequency `scene-physics-hash` messages. The browser sends them after fixed
physics updates at tick `0` and every 30 ticks thereafter:

```json
{
  "kind": "scene-physics-hash",
  "source": "physics",
  "phase": "postPhysics",
  "profile": "SceneSyncRapierParity-0.30",
  "hashVersion": "SceneSyncCanonicalPhysicsHashV1",
  "rapierCoreVersion": "0.30.0",
  "tick": 120,
  "hash": "0123456789abcdef",
  "timestep": 0.016666666666666666,
  "activeTime": 2,
  "worldAge": 2,
  "worldEpochTime": 0,
  "sceneClockRevision": 8,
  "controller": { "id": "peer-id", "nickname": "Host" },
  "sentAt": 1782010000000
}
```

Followers should compare the hash only when the fixed tick and hash version
match their local world. A mismatch is a divergence signal for diagnostics and
future snapshot resync; it is not a request to stream or apply body transforms.

## Shared Playback

Shared Playback uses:

- shared `clock.sharedEpochTime` for animation and Loomlet `ObjectAge`
- a shared physics world epoch or controller-published physics baseline for
  Rapier playback
- shared Scene Clock revision for play/pause/seek/reset/rate
- Rapier snapshots for reset, seek, late join, and divergence recovery

Controller operations should publish shared object clock baselines. If physics
state must be shared at a specific playback point, the controller should publish
a Rapier snapshot with a revision and tick. Followers restore that snapshot and
step fixed ticks from there.

Do not stream every body transform as the normal shared playback mechanism.
Use snapshots for baselines/resync and local fixed-step simulation for playback.

Rapier native snapshots are useful for matching Rapier builds. A longer-term
Scene Sync canonical physics snapshot should remain a separate versioned schema
over body/collider/settings state so Browser, Unity, and Godot are not coupled
to one serialization format.

## Seek And Fast-Forward

The adapter caps per-update stepping with `maxStepsPerUpdate` and keeps periodic
checkpoints while the simulation advances. If a target tick cannot be reached
cheaply, callers should prefer:

1. restoring a matching or nearby snapshot
2. resetting to the initial pose
3. freezing physics and surfacing the state in UI

Long catch-up fast-forward is not part of the UX contract.

## Editor UX

Editor Shell remains shared editing, not shared playback.

- adding a physics component starts simulation immediately
- changing gravity rebuilds/rebases the local physics preview immediately
- grabbing or editing a transform may freeze that object locally
- edit completion zeros velocity and angular velocity, then captures a new
  initial transform, object epoch, and physics world epoch
- physics velocity, angular velocity, and intermediate simulation state are not
  synchronized in Local Preview

XR does not change physics time. Entering or exiting XR must not change Clock
Mode and must not reset ObjectAge.

## Unity Rapier Bridge

Unity support is implemented as an optional downstream package:

```text
unity/com.afjk.scene-sync-rapier
```

`com.afjk.scene-sync` stays free of a hard Rapier dependency. The base package
only exposes incoming raw scene messages and preserves scene/object `physics`
JSON through `SceneSyncPhysicsMetadata`, so Unity can round-trip `scene-state`
without dropping physics fields. `com.afjk.scene-sync-rapier` depends on both
`com.afjk.scene-sync` and `com.afjk.rapier` and maps those preserved physics
fields into a Rapier world.

While `com.afjk.rapier` is not yet published to `upm.afjk.jp`, sample projects
should add it directly by Git URL:

```json
{
  "dependencies": {
    "com.afjk.rapier": "https://github.com/afjk/rapier-unity.git?path=Packages/com.afjk.rapier#v0.3.0"
  }
}
```

The Unity bridge uses Scene Sync wire coordinates as the canonical physics
basis and converts poses only when applying them back to Unity `Transform`s.
This keeps Web/Unity parity hashes meaningful within the same physics profile.

The bridge also follows Shared Playback `scene-clock` messages. It derives the
target Rapier tick from the shared clock time and restores the initial Rapier
snapshot when a reset or seek-to-zero payload carries a `physicsBaseline`.

When object or scene metadata changes force a rebuild, Unity preserves dynamic
body pose, linear velocity, and angular velocity for unchanged Scene Sync object
ids. Reset baselines opt out of this and restore the initial snapshot unless
`physicsBaseline.preserveMotion` is explicitly true.

Unity collision events are exposed through `SceneSyncRapierBridge.CollisionEvent`
using the same v0 event shape as Web runtime events: `physics.collision.enter`
and `physics.collision.exit`, sorted `objectIdA` / `objectIdB`, `pairKey`,
physics `tick`, `source: "physics"`, and `phase: "postPhysics"`.

`SceneSyncRapierBridge.ComputeStateHashHex()` exposes Unity Rapier's current
`SceneSyncCanonicalPhysicsHashV1` as 16-character lowercase hex. The bridge also
keeps `LastStateHash` updated after rebuilds, resets, and physics steps without
requiring log output. Use it as the Unity-side value to compare with the Web
runtime's `world.canonicalStateHash()` when both hosts are on the same
`SceneSyncRapierParity-0.30` profile.

The bridge also consumes Web `scene-physics-hash` messages. The latest report is
available through `LastRemoteHashReport`, `LastRemoteHashMatched`, and the
`HashReportReceived` event. Reports compare tick, hash version, and canonical
hash, but they intentionally do not perform resync yet.

## Supported Shapes

The current Scene Sync UI maps to Rapier sphere and cuboid colliders:

```json
{
  "enabled": true,
  "bodyType": "dynamic",
  "shape": "sphere",
  "mass": 1,
  "restitution": 0.2,
  "friction": 0.5,
  "velocity": [0, 0, 0],
  "angularVelocity": [0, 0, 0]
}
```

Rapier supports more collider types, CCD, joints, ray casts, and character
controllers. Those should be exposed through Scene Sync schema/UI deliberately
instead of leaking raw Rapier descriptors into scene state.
