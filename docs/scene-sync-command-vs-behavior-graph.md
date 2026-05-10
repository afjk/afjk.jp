# Scene Sync: Scene Command vs Behavior Graph

Scene Sync has two different ways to change or drive a scene.

This document defines the terminology used by Scene Sync, Loomlet, MCP tools, GPT actions, and AI authoring docs.

---

## Scene Command

A **Scene Command** is a one-shot operation that immediately changes the current Scene Sync scene state.

Use Scene Commands when the request is an instantaneous edit or operation.

Examples:

- Add an object
- Remove an object
- Move an object once
- Scale an object once
- Change the environment once
- Apply a batch of one-shot edits

Typical protocol payloads:

- `scene-add`
- `scene-remove`
- `scene-delta`
- `scene-batch`
- `scene-env`

In Loomlet integration, the immediate-effect path can convert Loomlet outputs such as `scene.setPosition`, `scene.setRotation`, or `scene.setScale` into Scene Commands such as `scene-delta`.

A Scene Command is not a persistent animation definition. Do not broadcast Scene Commands every frame for continuous animation unless intentionally using result synchronization as a fallback.

---

## Behavior Graph

A **Behavior Graph** is a persistent graph definition that is evaluated continuously by each Scene Sync client.

Use Behavior Graphs when the request describes ongoing behavior.

Examples:

- Bounce the cat
- Spin the cube continuously
- Pulse an object's scale
- Blink visibility
- Cycle material color

Typical protocol payloads:

- `scene-graph-set`
- `scene-graph-clear`
- `scene-graph-patch`
- `scene-graph-input`

A Behavior Graph shares the definition of behavior, not per-frame transform results. Each client evaluates the graph locally against the same graph and synchronized inputs such as `serverClock`.

---

## Scene Behavior Graph

A **Scene Behavior Graph** is a Behavior Graph scoped to the whole room or scene.

Protocol shape:

```json
{
  "type": "scene-graph-set",
  "scope": "scene",
  "graph": {
    "nodes": [],
    "edges": []
  }
}
```

Use Scene Behavior Graphs for room-level relationships or coordination between objects.

---

## Object Behavior Graph

An **Object Behavior Graph** is a Behavior Graph attached to one Scene Sync object.

Protocol shape:

```json
{
  "type": "scene-graph-set",
  "scope": { "object": "cat-123" },
  "graph": {
    "nodes": [],
    "edges": []
  }
}
```

For object-scoped graphs, Scene Sync clients inject `scope.object` as the target for Scene Sync sink nodes when `params.target` is omitted.

Prefer Object Behavior Graphs for object-specific behavior such as idle motion, bounce, spin, pulse, color cycle, or visibility blinking.

---

## Naming rules

Use these terms in documentation and tool descriptions:

- **Scene Command**: one-shot, immediate operation
- **Behavior Graph**: persistent, continuously evaluated behavior definition
- **Scene Behavior Graph**: Behavior Graph with `scope: "scene"`
- **Object Behavior Graph**: Behavior Graph with `scope: { "object": "<objectId>" }`

Avoid using `scene graph` as a user-facing concept name when referring to Behavior Graphs. `scene graph` is already a common 3D engine term, and Scene Sync also has protocol payloads named `scene-graph-*`.

Keep protocol names unchanged:

- `scene-delta` remains a protocol payload name for Scene Commands.
- `scene-graph-set` and `scene-graph-clear` remain protocol payload names for Behavior Graphs.
- Existing MCP tool names such as `scene_sync_set_object_graph` remain unchanged for compatibility.

---

## Quick comparison

| Concept | Lifespan | Transport | Evaluation | Example |
|---|---|---|---|---|
| Scene Command | One-shot | `scene-delta`, `scene-add`, `scene-remove`, `scene-batch` | Applied immediately | Move the cat to `[1, 0, 0]` |
| Behavior Graph | Persistent until replaced or cleared | `scene-graph-set`, `scene-graph-clear` | Evaluated continuously by each client | Make the cat bounce |
