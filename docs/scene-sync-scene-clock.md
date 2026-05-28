# Scene Sync Scene Clock

Host-controlled global time system for Loomlet behaviors.

## Overview

**Scene Clock** is a host-owned, local-only time control system that complements the existing per-object selection-based time model.

- **Host-owned**: only the local Scene Sync host can control time
- **Local-only**: time control operations (pause, seek, reset) are never broadcast to the room
- **Read-only for Loomlet**: behavior graphs can read time state but cannot modify it
- **Independent**: operates separately from per-object selection-based `t=0` freezing

## Time Models

Scene Sync uses **two independent time coordinates**:

### 1. Object Runtime Time (per-object, selection-aware)

Each object has its own `runtime time` based on selection state:

```text
selected/edited object:
  t = 0 (frozen for editing)

normal object:
  t = elapsed time since deselection (or Scene Clock time)
```

Controlled by: `getObjectRuntimeTime(objectId)` in scene.js

Used for: GLB animations, per-object Loomlet behavior evaluation

### 2. Scene Clock (global, host-controllable)

A global time coordinate independent of selection state:

```text
mode = 'server-follow':
  t = current server time (synchronized across clients)

mode = 'local':
  t = controllable local time (pause, seek, reset, rate)
```

Controlled by: Scene Clock API (reset, seek, pause, resume, follow server)

Used for: global behavior control, demo/authoring animations

## API Reference

### Querying Time

```js
getSceneClockTime(now = performance.now())
  → returns current scene time as number (seconds)

getSceneClockDelta(now = performance.now())
  → returns frame delta in seconds
  → 0 when paused

getSceneClockStateForLoomlet(now = performance.now())
  → returns {
      t: number,
      delta: number,
      isPaused: boolean,
      mode: 'server-follow' | 'local',
      rate: number,
      serverNow: number (always current server time),
    }
```

### Controlling Time

```js
resetSceneClock(now = performance.now())
  → sets t = 0 in local mode

seekSceneClock(t, now = performance.now())
  → jumps to time t (seconds)
  → switches to local mode if needed
  → does NOT broadcast or rewrite history

pauseSceneClock(now = performance.now())
  → freezes time.t
  → delta becomes 0
  → local-only

resumeSceneClock(now = performance.now())
  → resumes from paused time

setSceneClockMode(mode, now = performance.now())
  → switches mode: 'server-follow' | 'local'

followServerClock(now = performance.now())
  → alias for setSceneClockMode('server-follow')
```

## Loomlet Host Inputs

Behaviors can read time state via these read-only host inputs:

```js
inputs['time.t']         // object graph evaluation time
                         // selected object: always 0
                         // normal object: Scene Clock time
inputs['time.delta']     // frame delta for object evaluation
inputs['time.sceneT']    // Scene Clock global time (same as time.t for normal objects)
inputs['time.sceneDelta'] // Scene Clock global delta
inputs['time.isPaused']  // whether Scene Clock is paused
inputs['time.mode']      // 'server-follow' | 'local'
inputs['time.rate']      // playback rate multiplier (1.0 = normal)
inputs['time.serverNow'] // always current synchronized server time
```

Inputs are read-only. Behavior graphs cannot modify time controls.

### Note on Delta

- **local mode**: delta = frame-to-frame time delta with rate applied
- **server-follow mode**: delta = server time delta since last frame

## Example Loomlet Behavior

```json
{
  "nodes": [
    {
      "id": "time-input",
      "type": "hostInput",
      "params": { "key": "time.t" }
    },
    {
      "id": "sine-wave",
      "type": "math.sin",
      "params": { "input": "time-input" }
    },
    {
      "id": "scale-output",
      "type": "math.multiply",
      "params": { "a": "sine-wave", "b": 2 }
    },
    {
      "id": "set-scale",
      "type": "scene.setScale",
      "params": {
        "scale": ["scale-output", 1, 1],
        "target": "my-object"
      }
    }
  ]
}
```

This graph animates `my-object` with a sine wave using `time.t`.

When `my-object` is selected:
- `time.t = 0` → animation freezes at origin
- User can edit the object

When `my-object` is deselected:
- `time.t` advances with Scene Clock
- Animation runs normally

When user pauses Scene Clock:
- `time.t` freezes for all objects
- All time-dependent behaviors pause

## Local-Only Guarantees

The following operations **never broadcast** and **never rewrite history**:

- `pauseSceneClock()`
- `resumeSceneClock()`
- `seekSceneClock(t)`
- `resetSceneClock()`
- `setSceneClockMode(mode)`

Each client maintains its own local Scene Clock state. Pausing on one client does not affect other clients.

**Future work** (out of scope for MVP):
- Shared multiplayer time authority (consensus pause/seek)
- Broadcasting time state changes
- Time-based event sourcing and replay

## Design Rationale

### Why two time models?

1. **Selection-based `t=0`** is essential for editing:
   - User selects object → object "rewinds" to origin
   - User can adjust initial pose without animation running
   - Per-object behavior is intuitive for authors

2. **Global Scene Clock** is essential for control and synchronization:
   - Host needs to pause/rewind entire scene
   - Demo playback and authoring flows benefit from global time control
   - Future: distributed time authority for multi-client sync

### Why local-only in MVP?

- Simpler implementation
- No room history conflicts
- Supports demo/authoring use cases immediately
- Clear migration path to future multiplayer time systems
- Easier testing and debugging

### Why read-only for Loomlet?

- Time control belongs to Scene Sync host layer
- Prevents conflicts between Loomlet graphs and host controls
- Preserves deterministic behavior (given fixed host time, same graph produces same output)
- Simplifies replay/undo later

## Debug UI

Scene Clock debug panel (`#scene-clock-panel`) provides manual time control:

- **Time display**: current `t` in seconds
- **Mode badge**: 'server-follow' | 'local'
- **Status badge**: 'running' | 'paused'
- **Reset**: jump to t=0
- **Pause/Resume**: toggle pause
- **Follow Server**: return to server-follow mode
- **Seek input**: jump to arbitrary time
- **Rate input**: playback speed multiplier

To enable debug panel in developer console:

```js
document.getElementById('scene-clock-panel').removeAttribute('hidden')
```

## Related Docs

- [Scene Sync Runtime Time Model](./scene-sync-runtime-time-model.md) - per-object time and selection behavior
- [Scene Sync Spec](./scene-sync-spec.md) - overall Scene Sync architecture
- [Loomlet Graph Protocol](./scene-sync-loom-protocol.md) - Loomlet behavior graph format
