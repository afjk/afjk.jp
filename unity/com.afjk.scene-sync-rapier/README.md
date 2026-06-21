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
