# Scene Sync MCP Graph Tools

This document describes the experimental Scene Sync graph tools added for persistent behavior graphs.

These tools accept **Scene Sync graph JSON**, not Loomlet DSL. The intended flow is:

```text
Loomlet DSL or AI-authored behavior
  -> Scene Sync graph JSON
  -> MCP graph tool
  -> Scene Sync scene-graph-set / scene-graph-clear broadcast
```

Scene Sync stays lightweight and does not need the Loomlet DSL parser.

## Tools

### scene_sync_set_object_graph

Set a persistent behavior graph for one object.

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

Clear one object's behavior graph.

```json
{
  "objectId": "cat-123"
}
```

### scene_sync_set_scene_graph

Set the room-level behavior graph.

```json
{
  "graph": {
    "nodes": [],
    "edges": []
  }
}
```

### scene_sync_clear_scene_graph

Clear the room-level behavior graph.

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

Before generating object behavior, inspect the current scene with `scene_sync_get_scene` and preserve the object's current base transform. For example, a bounce behavior should animate only the Y component and keep the current X/Z values, instead of moving the object to the origin.
