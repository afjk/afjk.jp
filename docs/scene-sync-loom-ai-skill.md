# SceneSync Loom AI Skill

## Purpose

This skill explains how an AI agent should control SceneSync objects using Loom graphs.

- Do not add new SceneSync APIs for behaviors
- Use existing `scene-graph-set` and `scene-graph-clear` payloads
- The AI should generate valid Loom graph JSON and broadcast it to the SceneSync room
- The goal is to avoid inventing ad-hoc payloads such as `scene-behavior`

**Critical rule:**

Do not invent `scene-behavior`, `setBehavior`, `animateObject`, or similar custom payloads.

Use only `scene-graph-set` and `scene-graph-clear` for Loom-powered object behavior.

---

## Allowed Payloads

### Set object graph

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

### Clear object graph

```json
{
  "type": "scene-graph-clear",
  "scope": { "object": "cube1" }
}
```

**Explanation:**
- `scope.object` is the target SceneSync object id.
- For object scope graphs, the target object is automatically injected into SceneSync sink nodes.
- Do not include `params.target` in `sceneSetPosition`, `sceneSetRotation`, `sceneSetScale`, `sceneSetColor`, or `sceneSetVisible` when using object scope.

---

## Allowed Node Types

SceneSync graph execution supports a **whitelist** of Loom node types. Remote graph payloads can only use these types.

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

Remote room messages must be safe. DOM and input nodes could introduce security vulnerabilities or break client isolation. SceneSync graph execution is intentionally restricted to transformation and visibility control only.

---

## Object Scope Rules

Always prefer object scope for object-specific behavior.

### Rules:

- Use `scope: { "object": "<objectId>" }` for object-specific graphs
- Do not set `params.target` on SceneSync sink nodes when using object scope
- The viewer automatically injects the object target from scope
- Object scope graphs are exported into `loomGraphs.objects[objectId]`
- Late joiners restore these graphs from `scene-state`
- When the object is removed via `scene-remove`, the object graph is cleaned up

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
  - x and z default base should usually be `0`
  - y default base should usually be `0.5` (assuming object origin at center)
- For rotation animation:
  - values are in radians
  - quaternion output uses `[x, y, z, w]` format
- Do not broadcast per-frame `scene-delta` results from Loom animation
- Send graph definitions once, not animation results repeatedly

---

## Recipes

### 6.1 Move left and right

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

### 6.2 Float up and down

Object `cube1` oscillates along the Y axis.

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
          "freq": 0.3,
          "amplitude": 0.5,
          "offset": 1.2
        }
      },
      {
        "id": "pos",
        "type": "sceneSetPosition",
        "params": {
          "x": 0,
          "z": 0
        }
      }
    ],
    "edges": [
      { "from": "clock.t", "to": "sine.t" },
      { "from": "sine.out", "to": "pos.y" }
    ]
  }
}
```

### 6.3 Rotate around Y axis

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

### 6.4 Pulse scale

Object `cube1` pulses in and out by scaling uniformly.

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
          "freq": 0.5,
          "amplitude": 0.25,
          "offset": 1
        }
      },
      {
        "id": "scale",
        "type": "sceneSetScale",
        "params": {}
      }
    ],
    "edges": [
      { "from": "clock.t", "to": "sine.t" },
      { "from": "sine.out", "to": "scale.x" },
      { "from": "sine.out", "to": "scale.y" },
      { "from": "sine.out", "to": "scale.z" }
    ]
  }
}
```

### 6.5 Set static color

Object `cube1` is colored green with a static color sink (no animation).

```json
{
  "type": "scene-graph-set",
  "scope": { "object": "cube1" },
  "graph": {
    "nodes": [
      {
        "id": "color",
        "type": "sceneSetColor",
        "params": {
          "r": 0,
          "g": 1,
          "b": 0
        }
      }
    ],
    "edges": []
  }
}
```

### 6.6 Hide object

Object `cube1` is made invisible.

```json
{
  "type": "scene-graph-set",
  "scope": { "object": "cube1" },
  "graph": {
    "nodes": [
      {
        "id": "visible",
        "type": "sceneSetVisible",
        "params": {
          "visible": false
        }
      }
    ],
    "edges": []
  }
}
```

### 6.7 Clear object behavior

Remove all Loom graph behavior from object `cube1`.

```json
{
  "type": "scene-graph-clear",
  "scope": { "object": "cube1" }
}
```

---

## Broadcast Examples

Use the existing REST broadcast endpoint to send Loom graph payloads.

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

Before sending a Loom graph payload to the REST broadcast endpoint, verify:

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
- Amplitude values are reasonable (not too large, typically 0.5 to 3.0)
- Frequency values are appropriate for the effect (0.1 to 1.0 Hz for smooth effects)
- Loom animation results are NOT sent as `scene-delta` (the graph is executed client-side)

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

---

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

### Mistake 3: Using disallowed DOM or input nodes

**Bad:**

```json
{
  "id": "click",
  "type": "pointerClick"
}
```

**Good:**

Use only the SceneSync allowed node whitelist (see section "Allowed Node Types").

**Lesson:** Remote graph payloads are restricted to safe transformation and visibility nodes. DOM and input nodes are forbidden.

---

### Mistake 4: Missing fixed axes in sink nodes

**Bad:**

```json
{
  "id": "pos",
  "type": "sceneSetPosition",
  "params": {
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

**Lesson:** Always explicitly set values for non-animated axes to prevent unexpected behavior from the previous state.

---

## Notes for MCP / GPT Actions

- An MCP server or GPT Action does not need a dedicated behavior tool or API endpoint
- It can use the existing SceneSync room broadcast tool (REST POST `/api/room/{roomId}/broadcast`)
- The tool should send a valid `scene-graph-set` or `scene-graph-clear` payload
- Include this skill text in the AI system/developer instructions or tool description
- The AI should not create new payload kinds unless the SceneSync protocol explicitly documents them
- Always refer to the latest `docs/scene-sync-spec.md` for the authoritative protocol definition

---

## References

- **SceneSync Core Protocol:** `docs/scene-sync-spec.md`
- **Loom Graph Protocol:** See "Loom グラフプロトコル" section in `scene-sync-spec.md`
- **REST API Endpoint:** `POST /api/room/{roomId}/broadcast?name={nickname}`
- **Allowed node types and restrictions:** This document, section "Allowed Node Types"
