# Editor Runtime Behavior

Editor Shell is shared editing, not shared playback.

## Synchronized State

Editor Shell synchronizes object creation, deletion, transform, hierarchy, component add/remove, component settings, GLB/image/video/audio/text assets, Loomlet attach/replace, physics settings, and animation settings.

## Local Runtime Time

Editor Shell does not synchronize current playback time, play/pause, seek, ObjectAge progress, animation frames, Loomlet in-flight state, physics velocity, angular velocity, or intermediate physics simulation state.

Each client uses Local Preview time unless the Player UI switches to Shared Playback or Room Time.

## Immediate Runtime Reaction

Runtime components react immediately after placement or setting changes:

- GLB models with animations start sampling immediately.
- Loomlet graphs start evaluating immediately after attachment.
- Physics starts simulating immediately after a physics component is added.
- Gravity changes apply on the spot; users must not need to press Play after changing gravity.

## ObjectAge Start Conditions

ObjectAge starts at `0` when:

- an object is placed
- transform editing completes
- an object is restored after reload
- animation settings change
- Loomlet is attached, replaced, or cleared
- audio or physics components are added or replaced
- the user explicitly resets or rebases runtime time

Editor Shell rebases each client's local `clock.epochTime` independently. Shared Playback and Room Time use `clock.sharedEpochTime`, so scene-state, scene-delta, and scene-clock reset/mode events must carry shared epoch baselines for synchronized ObjectAge.

## Physics Rebase / Reset

When transform editing completes, dynamic physics is rebased:

```txt
velocity = [0, 0, 0]
angularVelocity = [0, 0, 0]
initialTransform = current transform
clock.epochTime = activeClock.now()
clock.sharedEpochTime = shared active baseline
```

Reloads also discard physics velocity and angular velocity. Physics uses the restored transform as its initial transform and restarts from ObjectAge `0`.

For shared-playback seek, prefer snapshot restore if available. If no snapshot exists, reset. Avoid long fast-forward catch-up.

## XR

XR changes view and input, not time. Entering XR must not change Clock Mode and must not reset ObjectAge.
