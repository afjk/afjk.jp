# Rapier Interaction Sample

A Play Mode sample that demonstrates how to drive Rapier-backed Scene Sync bodies
through the generic `SceneSyncRapierBridge` runtime API. Everything in this sample
is *operation convenience* for trying the bridge out — none of it is part of the
library Runtime surface.

## What it contains

`SceneSyncRapierInteractionSample` bundles the following sample-only behavior:

- WASD / E / Q free-fly camera movement (hold Shift to move faster)
- Right-mouse-drag mouse look
- Left-mouse drag interaction that grabs a dynamic body and publishes
  scheduled `scene-physics-input` events through the bridge
- `autoAddPickColliders` — automatically attaches box colliders to
  `SceneSyncIdentity` objects so they can be picked by the raycaster
- `disableRemoteSnapshotCorrection` — opts the bridge into a snapshot-apply
  policy that does not fight local interaction while dragging

## Setup

1. Import this sample from the **Scene Sync Rapier** package via the Unity
   Package Manager (`Samples` tab → *Rapier Interaction Sample* → **Import**).
2. Add a `SceneSyncRapierBridge` to your scene (or let the sample find one with
   `FindFirstObjectByType`).
3. Add the `SceneSyncRapierInteractionSample` component to any GameObject and
   enter Play Mode.

## Why it lives in `Samples~`

The interaction sample knows about pointer input, camera rigs, and snapshot
correction policy that belongs to the *application*, not to the deterministic
physics bridge. Keeping it out of the `Runtime` assembly means the library only
ships the generic Rapier bridge, while this convenience layer stays opt-in.
