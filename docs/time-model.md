# Scene Sync Time Model

Scene Sync separates editing state synchronization from runtime time synchronization.

## Terms

`LocalNow` is each client's local monotonic preview time. Editor Shell uses this by default, and it is not synchronized with other clients.

`RoomNow` is the room-level reference time. It can be computed from server time or a room time offset:

```txt
RoomNow ~= LocalWallClock + roomTimeOffset
```

`ActiveTime` is the time exposed by the current Shell / Clock Mode:

```txt
ActiveTime = SourceNow * rate + Offset
SourceNow = LocalNow | RoomNow
```

`ObjectAge` is the runtime age of an object in its current state:

```txt
ObjectAge = ActiveTime - ObjectEpoch
```

Each object keeps two epoch baselines:

- `clock.epochTime` for Local Preview.
- `clock.sharedEpochTime` for Shared Playback and Room Time.

Local Preview may rebase `epochTime` independently on each client. Shared Playback and Room Time must use the shared epoch baseline distributed through scene state, scene deltas, and scene-clock baseline events.

`ObjectAge = 0` when an object is placed, edited, reloaded, has a component added or replaced, or is explicitly reset/rebased.

## Clock Mode

`local-preview` uses `LocalNow`. It is the Editor Shell default. Play, pause, seek, reset, rate, and ObjectAge are local-only.

`shared-playback` uses `RoomNow`. Controller operations are synchronized as events:

```txt
SharedTime = RoomNow * rate + sharedOffset
seek:  sharedOffset = targetTime - RoomNow * rate
pause: pausedTime = SharedTime
play:  sharedOffset = pausedTime - RoomNow * rate
```

Clients must not chase the controller's local clock every frame.

`room-time` uses `RoomNow` continuously. It is for clock-like, live, or installation-style worlds and does not assume pause or seek.

## Shell Policy

Editor Shell defaults to `local-preview`. It synchronizes object creation, deletion, transforms, hierarchy, assets, component settings, Loomlet attachment, physics settings, and animation settings. It does not synchronize play, pause, seek, current frames, ObjectAge progress, Loomlet runtime state, physics velocity, or intermediate simulation state.

Playback / Viewer Shell defaults to `shared-playback`. A controller changes play, pause, seek, reset, and rate; followers use `RoomNow * rate + sharedOffset`.

Room Time Shell defaults to `room-time`.

Game Shell should use game-owned shared simulation time and should not expose free-form player seek/pause unless the game UI supports it.

## Reloads

Reload is regeneration, not resume. Restored objects receive fresh local and shared epochs for the current active state. Physics runtime velocity and angular velocity are discarded, and the restored transform becomes the new initial transform.

## XR

XR is not a time mode. Entering or exiting XR must not change Clock Mode and must not reset ObjectAge. XR inherits the current Shell / Clock Mode.
