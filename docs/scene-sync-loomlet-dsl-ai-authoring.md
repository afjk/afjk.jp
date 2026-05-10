# Scene Sync × Loomlet DSL AI Authoring Notes

This document explains how AI agents should author Loomlet **Behavior Graphs** for Scene Sync.

Scene Sync executes graph payloads, but AI assistants should usually generate **Loomlet DSL (`.loom`) first** and let the Loomlet compiler produce Scene Sync graph JSON.

For terminology, see `docs/scene-sync-command-vs-behavior-graph.md`.

---

## Recommended flow

1. User asks for continuous behavior in natural language.
2. AI generates a small `.loom` program.
3. Loomlet compiles the `.loom` source to a Scene Sync **Behavior Graph**.
4. Scene Sync receives `scene-graph-set` or `scene-graph-clear`.
5. Scene Sync executes the graph client-side.

Do not invent new behavior payloads such as `scene-behavior`, `animateObject`, or `setBehavior`.

---

## Authoring rule

When an AI is asked to write continuous behavior, prefer this output:

```loom
import time
import math
import scene

t = time.serverClock()
y = math.sine(t, freq: 0.6, amplitude: 0.4, offset: 1.2)

scene.setPosition("sample-cube", x: 0, y: y, z: 0)
```

The compiler/runtime bridge should convert that source into the Behavior Graph payload Scene Sync understands.

---

## Scene Sync Behavior Graph protocol remains authoritative

Scene Sync still receives Behavior Graph messages in this form:

```json
{
  "type": "scene-graph-set",
  "scope": { "object": "sample-cube" },
  "graph": {
    "nodes": [],
    "edges": []
  }
}
```

or:

```json
{
  "type": "scene-graph-clear",
  "scope": { "object": "sample-cube" }
}
```

The DSL is an authoring layer, not a replacement for the Scene Sync protocol.

---

## Scene Command vs Behavior Graph

Scene Sync has two different integration paths:

- **Scene Command**: a one-shot operation that immediately changes scene state, usually through payloads such as `scene-delta`, `scene-add`, or `scene-remove`.
- **Behavior Graph**: a persistent graph definition that is evaluated continuously by each client, managed through `scene-graph-set` and `scene-graph-clear`.

Use Behavior Graphs for animation-like requests such as "bounce the cat", "spin the cube", or "pulse the color". Do not repeatedly broadcast per-frame Scene Commands for continuous animation.

---

## Scene Sync Behavior Graph Phase 1 node set

The Scene Sync client currently allows these Behavior Graph node types:

- `serverClock`
- `constant`
- `sine`
- `cosine`
- `add`
- `multiply`
- `sceneSetPosition`
- `sceneOffsetPosition`
- `sceneSetRotation`
- `sceneSetScale`
- `sceneSetColor`
- `sceneSetVisible`

Use `serverClock` for shared room animations. Avoid `clock` for AI-generated shared Scene Sync behaviors because local clocks can drift between clients.

Loomlet DSL authoring should map to those runtime nodes through the compiler/adapter.

---

## DSL scene sink mapping

Use these `.loom` sink calls for Scene Sync Behavior Graphs:

```loom
scene.setPosition("sample-cube", x: 0, y: 1, z: 0)
scene.offsetPosition("sample-cube", x: 0, y: 0.5, z: 0)
scene.setRotation("sample-cube", x: 0, y: 1.57, z: 0)
scene.setScale("sample-cube", x: 2, y: 2, z: 2)
scene.setColor("sample-cube", r: 0, g: 1, b: 1)
scene.setVisible("sample-cube", visible: true)
```

Important: `scene.setRotation` uses **Euler radians** in Scene Sync Behavior Graphs. Do not author quaternion `w` values for Scene Sync rotation.

---

## Object Behavior Graph

An **Object Behavior Graph** is a Behavior Graph attached to a single Scene Sync object using `scope: { "object": "<objectId>" }`.

Scene Sync stores one Object Behavior Graph per object. Sending a new graph to the same object replaces the old one.

Therefore, combine related effects into one `.loom` program:

```loom
import time
import math
import scene

t = time.serverClock()
x = math.sine(t, freq: 0.2, amplitude: 2, offset: 0)
g = math.sine(t, freq: 0.5, amplitude: 0.5, offset: 0.5)

scene.setPosition("sample-cube", x: x, y: 0.5, z: 0)
scene.setColor("sample-cube", r: 0, g: g, b: 1)
```

Do not send movement and color as two separate Object Behavior Graphs unless replacing the previous behavior is intended.

---

## Safety restrictions

Remote Scene Sync Behavior Graph execution is intentionally restricted.

Do not allow remote graphs to use:

- DOM mutation nodes
- pointer or keyboard input nodes
- console logging nodes
- arbitrary network/file nodes
- custom payload types

For public AI-facing tools, keep the graph node whitelist narrow and reject unknown node types.

---

## References

- Scene Sync terminology: `docs/scene-sync-command-vs-behavior-graph.md`
- Loomlet AI authoring guide: `afjk/loomlet/docs/AI_AUTHORING_GUIDE.md`
- Existing graph-level skill: `docs/scene-sync-loom-ai-skill.md`
- Scene Sync protocol spec: `docs/scene-sync-spec.md`
