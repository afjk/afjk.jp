# Scene Sync MCP Graph Tools

This document describes the experimental Scene Sync graph tools added for **Behavior Graphs**.

For terminology, see `docs/scene-sync-command-vs-behavior-graph.md`.

These tools accept **Scene Sync Behavior Graph JSON**, not Loomlet DSL. The intended flow is:

```text
Loomlet DSL or AI-authored behavior
  -> Scene Sync Behavior Graph JSON
  -> MCP graph tool
  -> Scene Sync scene-graph-set / scene-graph-clear broadcast
```

Scene Sync stays lightweight and does not need the Loomlet DSL parser.

## Scene Command vs Behavior Graph

Scene Sync has two different integration paths:

- **Scene Command**: a one-shot operation that immediately changes scene state, usually through payloads such as `scene-delta`, `scene-add`, or `scene-remove`.
- **Behavior Graph**: a persistent graph definition that is evaluated continuously by each client, managed through `scene-graph-set` and `scene-graph-clear`.

MCP graph tools are for Behavior Graphs. Do not use these tools to send one-shot Scene Commands.

## Tools

### scene_sync_set_object_graph

Set an **Object Behavior Graph** for one object.

```json
{
  "objectId": "cat-123",
  "graph": {
    "nodes": [
      { "id": "clock", "type": "serverClock" },
      { "id": "jump", "type": "sine", "params": { "freq": 1.2, "amplitude": 0.35, "offset": 0.35 } },
      { "id": "pos", "type": "sceneSetPosition", "params": { "x": 3, "z": -2 } }
    ],
    "edges": [
      { "from": "clock.t", "to": "jump.t" },
      { "from": "jump.out", "to": "pos.y" }
    ]
  }
}
```

### scene_sync_clear_object_graph

Clear one object's **Object Behavior Graph**.

```json
{
  "objectId": "cat-123"
}
```

### scene_sync_set_scene_graph

Set the room-level **Scene Behavior Graph**.

```json
{
  "graph": {
    "nodes": [],
    "edges": []
  }
}
```

### scene_sync_clear_scene_graph

Clear the room-level **Scene Behavior Graph**.

```json
{}
```

## Supported node types

- `serverClock`
- `sine`
- `cosine`
- `add`
- `sceneSetPosition`
- `sceneSetRotation`
- `sceneSetScale`
- `sceneSetColor`
- `sceneSetVisible`

## Dry run

All graph tools accept `dryRun: true`. In dry-run mode, the tool returns the payload without broadcasting it.

## Notes for AI clients

Before generating an Object Behavior Graph, inspect the current scene with `scene_sync_get_scene` and preserve the object's current base transform. For example, a bounce behavior should animate only the Y component and keep the current X/Z values, instead of moving the object to the origin.
