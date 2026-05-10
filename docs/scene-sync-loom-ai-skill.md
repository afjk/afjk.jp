# SceneSync Loom AI Skill

## Purpose

This skill explains how an AI agent should control SceneSync objects using **Behavior Graphs**.

For terminology, see `docs/scene-sync-command-vs-behavior-graph.md`.

- Do not add new SceneSync APIs for behaviors
- Use existing `scene-graph-set` and `scene-graph-clear` payloads for Behavior Graphs
- The AI should generate valid Scene Sync Behavior Graph JSON and broadcast it to the SceneSync room
- The goal is to avoid inventing ad-hoc payloads such as `scene-behavior`

**Critical rule:**

Do not invent `scene-behavior`, `setBehavior`, `animateObject`, or similar custom payloads.

Use only `scene-graph-set` and `scene-graph-clear` for Loom-powered object behavior.

---

## Scene Command vs Behavior Graph

Scene Sync has two different integration paths.

### Scene Command

A **Scene Command** is a one-shot operation that immediately changes scene state.

Typical payloads:

- `scene-add`
- `scene-remove`
- `scene-delta`
- `scene-batch`
- `scene-env`

Use Scene Commands for one-time edits such as adding an object, moving an object once, deleting an object, or changing the environment.

### Behavior Graph

A **Behavior Graph** is a persistent graph definition that is evaluated continuously by each client.

Typical payloads:

- `scene-graph-set`
- `scene-graph-clear`
- `scene-graph-patch`
- `scene-graph-input`

Use Behavior Graphs for ongoing behavior such as bouncing, spinning, pulsing scale, blinking visibility, or cycling color.

Do not broadcast per-frame `scene-delta` results from Loom animation. Send the Behavior Graph definition once and let clients evaluate it locally.

---

## Allowed Payloads

### Set Object Behavior Graph

```json
{
  "type": "scene-graph-set",
  "scope": { "object": "cube1" },
  "graph": {
    "nodes": [],
    "edges": []
  }
}
```

### Clear Object Behavior Graph

```json
{
  "type": "scene-graph-clear",
  "scope": { "object": "cube1" }
}
```

**Explanation:**

- `scope.object` is the target SceneSync object id.
- For Object Behavior Graphs, the target object is automatically injected into SceneSync sink nodes.
- Do not include `params.target` in `sceneSetPosition`, `sceneSetRotation`, `sceneSetScale`, `sceneSetColor`, or `sceneSetVisible` when using object scope.

---

## Allowed Node Types

SceneSync Behavior Graph execution supports a **whitelist** of Loom node types. Remote graph payloads can only use these types.

### Allowed node types:

- `clock` — local timing node
- `constant` — constant value
- `sine` — sine wave oscillator
- `add` — addition
- `multiply` — multiplication
- `serverClock` — synchronized server-driven clock
- `sceneSetPosition` — set object position
- `sceneSetRotation` — set object rotation
- `sceneSetScale` — set object scale
- `sceneSetColor` — set object color (RGB)
- `sceneSetVisible` — set object visibility

### Forbidden node types:

**DOM nodes (not allowed):**

- `setText` — DOM text manipulation
- `setStyle` — DOM style manipulation
- `setAttr` — DOM attribute manipulation
- `log` — console logging

**Input/Event nodes (not allowed):**

- `pointerClick` — pointer/click events
- `pointerPosition` — pointer position tracking
- `keyDown` — keyboard events
- `keyUp` — keyboard events
- `filter` — event filtering
- `sample` — sampling
- `merge` — merging streams

**Reason for restrictions:**

Remote room messages must be safe. DOM and input nodes could introduce security vulnerabilities or break client isolation. SceneSync Behavior Graph execution is intentionally restricted to transformation and visibility control only.

---

## Object Behavior Graph Rules

Always prefer Object Behavior Graphs for object-specific behavior.

### Rules:

- Use `scope: { "object": "<objectId>" }` for object-specific Behavior Graphs
- Do not set `params.target` on SceneSync sink nodes when using object scope
- The viewer automatically injects the object target from scope
- Object Behavior Graphs are exported into `loomGraphs.objects[objectId]`
- Late joiners restore these graphs from `scene-state`
- When the object is removed via `scene-remove`, the Object Behavior Graph is cleaned up

### Good example:

```json
{
  "type": "scene-graph-set",
  "scope": { "object": "cube1" },
  "graph": {
    "nodes": [
      {
        "id": "pos",
        "type": "sceneSetPosition",
        "params": {
          "x": 1,
          "y": 0.5,
          "z": 0
        }
      }
    ],
    "edges": []
  }
}
```

### Bad example:

```json
{
  "type": "scene-graph-set",
  "scope": { "object": "cube1" },
  "graph": {
    "nodes": [
      {
        "id": "pos",
        "type": "sceneSetPosition",
        "params": {
          "target": "cube1",
          "x": 1
        }
      }
    ],
    "edges": []
  }
}
```

**Why it's bad:** Explicitly setting `target` when using object scope is redundant and can cause confusion.

---

## Graph Construction Rules

- `nodes` must be an array of node definitions
- `edges` must be an array of edge connections
- Every node must have a unique `id` string
- Every edge must use `"nodeId.port"` format (e.g., `"clock.t"`, `"sine.out"`)
- Use `serverClock` for synchronized animation across all clients
- Use `clock` only for local-only timing (not recommended for shared behavior)
- Use small amplitudes first, usually `0.5` to `3.0`
- Always set fixed values for axes that are not animated
- For position animation:
  - Inspect the object's current position first
  - Use the current position as the baseline for fixed axes
  - Do not blindly use `x: 0`, `y: 0.5`, `z: 0` for objects that should stay near their current location
- For rotation animation:
  - values are Euler angles in radians
  - `sceneSetRotation` accepts `x`, `y`, and `z` (Euler angles, not quaternion)
  - Do not use quaternion `[x, y, z, w]` for `sceneSetRotation`
- Do not broadcast per-frame `scene-delta` results from Loom animation
- Send Behavior Graph definitions once, not animation results repeatedly

---

## Graph Replacement Behavior

SceneSync currently stores **one Object Behavior Graph per object**. When you send a new `scene-graph-set` with the same `scope.object`, it **replaces the previous graph** for that object.

- If you send a movement graph, then a color graph separately, the movement will be replaced and stop.
- **Solution:** Combine multiple effects into a single Behavior Graph instead of sending multiple separate `scene-graph-set` payloads.

---

## Recipes

### Move left and right

Object `cube1` oscillates along the X axis with a sine wave.

```json
{
  "type": "scene-graph-set",
  "scope": { "object": "cube1" },
  "graph": {
    "nodes": [
      { "id": "clock", "type": "serverClock" },
      {
        "id": "sine",
        "type": "sine",
        "params": {
          "freq": 0.2,
          "amplitude": 2,
          "offset": 0
        }
      },
      {
        "id": "pos",
        "type": "sceneSetPosition",
        "params": {
          "y": 0.5,
          "z": 0
        }
      }
    ],
    "edges": [
      { "from": "clock.t", "to": "sine.t" },
      { "from": "sine.out", "to": "pos.x" }
    ]
  }
}
```

### Rotate around Y axis

Object `cube1` continuously rotates around the Y axis.

```json
{
  "type": "scene-graph-set",
  "scope": { "object": "cube1" },
  "graph": {
    "nodes": [
      { "id": "clock", "type": "serverClock" },
      {
        "id": "angle",
        "type": "multiply",
        "params": {
          "b": 0.5
        }
      },
      {
        "id": "rot",
        "type": "sceneSetRotation",
        "params": {
          "x": 0,
          "z": 0
        }
      }
    ],
    "edges": [
      { "from": "clock.t", "to": "angle.a" },
      { "from": "angle.out", "to": "rot.y" }
    ]
  }
}
```

### Combined example: movement + color

Object `cube1` moves left-right while pulsing color from blue to cyan.

This demonstrates how to **combine multiple effects in a single Object Behavior Graph** to avoid replacement issues.

```json
{
  "type": "scene-graph-set",
  "scope": { "object": "cube1" },
  "graph": {
    "nodes": [
      { "id": "clock", "type": "serverClock" },
      {
        "id": "sine_pos",
        "type": "sine",
        "params": {
          "freq": 0.2,
          "amplitude": 2,
          "offset": 0
        }
      },
      {
        "id": "sine_color",
        "type": "sine",
        "params": {
          "freq": 0.5,
          "amplitude": 0.5,
          "offset": 0.5
        }
      },
      {
        "id": "pos",
        "type": "sceneSetPosition",
        "params": {
          "y": 0.5,
          "z": 0
        }
      },
      {
        "id": "color",
        "type": "sceneSetColor",
        "params": {
          "b": 1
        }
      }
    ],
    "edges": [
      { "from": "clock.t", "to": "sine_pos.t" },
      { "from": "sine_pos.out", "to": "pos.x" },
      { "from": "clock.t", "to": "sine_color.t" },
      { "from": "sine_color.out", "to": "color.g" }
    ]
  }
}
```

---

## Broadcast Examples

Use the existing REST broadcast endpoint to send Behavior Graph payloads.

### Send left-right movement

```bash
curl -X POST "http://localhost:8787/api/room/loom-test/broadcast?name=AI" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "scene-graph-set",
    "scope": { "object": "cube1" },
    "graph": {
      "nodes": [
        { "id": "clock", "type": "serverClock" },
        { "id": "sine", "type": "sine", "params": { "freq": 0.2, "amplitude": 2, "offset": 0 } },
        { "id": "pos", "type": "sceneSetPosition", "params": { "y": 0.5, "z": 0 } }
      ],
      "edges": [
        { "from": "clock.t", "to": "sine.t" },
        { "from": "sine.out", "to": "pos.x" }
      ]
    }
  }'
```

### Clear object behavior

```bash
curl -X POST "http://localhost:8787/api/room/loom-test/broadcast?name=AI" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "scene-graph-clear",
    "scope": { "object": "cube1" }
  }'
```

---

## Checklist Before Sending

Before sending a Behavior Graph payload to the REST broadcast endpoint, verify:

- The payload uses `type: "scene-graph-set"` or `type: "scene-graph-clear"`
- Do not use `kind: "scene-behavior"` or any custom behavior payload
- `scope.object` is a valid target object id that exists in the scene
- `graph.nodes` is an array
- `graph.edges` is an array
- Each node `id` is unique within the graph
- Every edge references an existing node and valid port name
- Only allowed node types from the whitelist are used
- Object scope sink nodes do not include `params.target`
- Non-animated axes have fixed values in sink node `params`
- Animation uses `serverClock` unless local-only timing is explicitly desired
- Amplitude values are reasonable
- Frequency values are appropriate for the effect
- Loom animation results are NOT sent as `scene-delta`

---

## Common Mistakes

### Mistake 1: Inventing a custom behavior payload

**Bad:**

```json
{
  "kind": "scene-behavior",
  "objectId": "cube1",
  "behavior": "rotate"
}
```

**Good:**

```json
{
  "type": "scene-graph-set",
  "scope": { "object": "cube1" },
  "graph": {
    "nodes": [
      { "id": "clock", "type": "serverClock" },
      { "id": "angle", "type": "multiply", "params": { "b": 0.5 } },
      { "id": "rot", "type": "sceneSetRotation", "params": { "x": 0, "z": 0 } }
    ],
    "edges": [
      { "from": "clock.t", "to": "angle.a" },
      { "from": "angle.out", "to": "rot.y" }
    ]
  }
}
```

**Lesson:** Always use `scene-graph-set` / `scene-graph-clear`, never invent new payload kinds.

### Mistake 2: Setting target manually in object scope

**Bad:**

```json
{
  "id": "pos",
  "type": "sceneSetPosition",
  "params": {
    "target": "cube1",
    "x": 1
  }
}
```

**Good:**

```json
{
  "id": "pos",
  "type": "sceneSetPosition",
  "params": {
    "x": 1,
    "y": 0.5,
    "z": 0
  }
}
```

**Lesson:** When using object scope, let the viewer inject the target automatically. Explicitly setting `target` is redundant and error-prone.

---

## Notes for MCP / GPT Actions

- An MCP server or GPT Action does not need a custom behavior payload
- It can use the existing SceneSync room broadcast tool or a dedicated Behavior Graph tool
- The tool should send a valid `scene-graph-set` or `scene-graph-clear` payload
- Include this skill text in the AI system/developer instructions or tool description
- The AI should not create new payload kinds unless the SceneSync protocol explicitly documents them
- Always refer to the latest `docs/scene-sync-spec.md` and `docs/scene-sync-command-vs-behavior-graph.md` for authoritative terminology

---

## References

- **Scene Sync terminology:** `docs/scene-sync-command-vs-behavior-graph.md`
- **SceneSync Core Protocol:** `docs/scene-sync-spec.md`
- **REST API Endpoint:** `POST /api/room/{roomId}/broadcast?name={nickname}`
- **Allowed node types and restrictions:** This document, section "Allowed Node Types"
