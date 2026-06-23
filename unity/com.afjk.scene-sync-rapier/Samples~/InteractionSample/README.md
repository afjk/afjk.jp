# Rapier Interaction Sample

A backwards-compatible Play Mode sample that demonstrates how to drive
Rapier-backed Scene Sync bodies through the generic `SceneSyncRapierBridge`
runtime API. New scenes can use `SceneSyncRapierInteractionController` directly
from the package Runtime assembly without importing this sample.

## What it contains

`SceneSyncRapierInteractionSample` derives from the runtime
`SceneSyncRapierInteractionController`, which bundles the following behavior:

- WASD / E / Q free-fly camera movement (hold Shift to move faster)
- Right-mouse-drag mouse look
- Left-mouse drag interaction that grabs a dynamic body and publishes
  scheduled `scene-physics-input` events through the bridge
- `autoAddPickColliders` — automatically attaches box colliders to
  `SceneSyncIdentity` objects so they can be picked by the raycaster
- `disableRemoteSnapshotCorrection` — opts the bridge into a snapshot-apply
  policy that does not fight local interaction while dragging

## Setup

1. Add a `SceneSyncRapierBridge` to your scene (or let the controller find one with
   `FindFirstObjectByType`).
2. Add `SceneSyncRapierInteractionController`, or import this sample and add the
   legacy `SceneSyncRapierInteractionSample` component to any GameObject, then
   enter Play Mode.

## Why this sample remains

Older scenes may already serialize `SceneSyncRapierInteractionSample`. The
sample now stays as a small compatibility wrapper while the maintained behavior
lives in `SceneSyncRapierInteractionController`.
