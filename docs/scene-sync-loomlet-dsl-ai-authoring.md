# Scene Sync × Loomlet DSL AI Authoring Notes

This document explains how AI agents should author Loomlet behavior for Scene Sync.

Scene Sync executes graph payloads, but AI assistants should usually generate **Loomlet DSL (`.loom`) first** and let the Loomlet compiler produce Scene Sync graph JSON.

---

## Recommended flow

1. User asks for behavior in natural language.
2. AI generates a small `.loom` program.
3. Loomlet compiles the `.loom` source to a Scene Sync graph.
4. Scene Sync receives `scene-graph-set` or `scene-graph-clear`.
5. Scene Sync executes the graph client-side.

Do not invent new behavior payloads such as `scene-behavior`, `animateObject`, or `setBehavior`.

---

## Authoring rule

When an AI is asked to write behavior, prefer this output:

```loom
import time
import math
import scene

t = time.serverClock()
y = math.sine(t, freq: 0.6, amplitude: 0.4, offset: 1.2)

scene.setPosition("sample-cube", x: 0, y: y, z: 0)
```

The compiler/runtime bridge should convert that source into the graph payload Scene Sync understands.

---

## Scene Sync graph protocol remains authoritative

Scene Sync still receives graph messages in this form:

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

## Allowed Scene Sync runtime nodes

The Scene Sync client currently allows these graph node types:

- `clock`
- `constant`
- `sine`
- `add`
- `multiply`
- `serverClock`
- `sceneSetPosition`
- `sceneSetRotation`
- `sceneSetScale`
- `sceneSetColor`
- `sceneSetVisible`

Loomlet DSL authoring should map to those runtime nodes through the compiler/adapter.

---

## DSL scene sink mapping

Use these `.loom` sink calls for Scene Sync behavior:

```loom
scene.setPosition("sample-cube", x: 0, y: 1, z: 0)
scene.setRotation("sample-cube", x: 0, y: 1.57, z: 0)
scene.setScale("sample-cube", x: 2, y: 2, z: 2)
scene.setColor("sample-cube", r: 0, g: 1, b: 1)
scene.setVisible("sample-cube", visible: true)
```

Important: `scene.setRotation` uses **Euler radians** in Scene Sync. Do not author quaternion `w` values for Scene Sync rotation.

---

## Object scope behavior

Scene Sync stores one Loom graph per object. Sending a new graph to the same object replaces the old one.

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

Do not send movement and color as two separate object graphs unless replacing the previous behavior is intended.

---

## Safety restrictions

Remote Scene Sync graph execution is intentionally restricted.

Do not allow remote graphs to use:

- DOM mutation nodes
- pointer or keyboard input nodes
- console logging nodes
- arbitrary network/file nodes
- custom payload types

For public AI-facing tools, keep the graph node whitelist narrow and reject unknown node types.

---

## References

- Loomlet AI authoring guide: `afjk/loomlet/docs/AI_AUTHORING_GUIDE.md`
- Existing graph-level skill: `docs/scene-sync-loom-ai-skill.md`
- Scene Sync protocol spec: `docs/scene-sync-spec.md`
