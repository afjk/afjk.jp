# Scene Sync AI Tool Examples

Concise examples for the stable Scene Sync AI tool contract.

Base URL:

```text
https://afjk.jp/presence/api/ai
```

Related files:

- Codex / OpenAI function definitions: [`docs/scene-sync-tools-codex.json`](./scene-sync-tools-codex.json)
- Wrapper OpenAPI: [`docs/scene-sync-ai-openapi.yaml`](./scene-sync-ai-openapi.yaml)
- Contract summary: [`docs/scene-sync-ai-spec.md`](./scene-sync-ai-spec.md)
- Example client: [`examples/scene-sync-ai-client/README.md`](../examples/scene-sync-ai-client/README.md)

## Standard Agent Flow

1. Redeem a 6-digit code with `scene_sync_redeem`
2. Store `sessionId`, `roomId`, and `expiresAt`
3. Read a snapshot with `scene_sync_get_scene` before mutations when state matters
4. Mutate with `scene_sync_broadcast` or `scene_sync_ai_command`
5. Read a snapshot after create/update/delete or GLB upload when correctness matters
6. Revoke with `scene_sync_revoke` when done

## Stable Tools

| Tool | Required args |
| --- | --- |
| `scene_sync_redeem` | `code` |
| `scene_sync_get_scene` | `roomId`, `sessionId` |
| `scene_sync_broadcast` | `roomId`, `sessionId`, `payload` |
| `scene_sync_ai_command` | `roomId`, `sessionId`, `action` |
| `scene_sync_revoke` | `sessionId` |

## Minimal Tool Shapes

### `scene_sync_redeem`

```json
{
  "code": "123456"
}
```

### `scene_sync_get_scene`

```json
{
  "roomId": "abc123",
  "sessionId": "v1.example"
}
```

### `scene_sync_broadcast`

```json
{
  "roomId": "abc123",
  "sessionId": "v1.example",
  "payload": {
    "kind": "scene-add",
    "objectId": "ai-cube-1"
  }
}
```

### `scene_sync_ai_command`

```json
{
  "roomId": "abc123",
  "sessionId": "v1.example",
  "action": "focusObject",
  "params": {
    "objectId": "ai-cube-1"
  }
}
```

### `scene_sync_revoke`

```json
{
  "sessionId": "v1.example"
}
```

## Scene Mutation Examples

### Create object

```json
{
  "roomId": "abc123",
  "sessionId": "v1.example",
  "payload": {
    "kind": "scene-add",
    "objectId": "ai-cube-1",
    "name": "Orange Cube",
    "position": [0, 0.5, 0],
    "rotation": [0, 0, 0, 1],
    "scale": [1, 1, 1],
    "asset": {
      "type": "primitive",
      "primitive": "box",
      "color": "#ff8800"
    }
  }
}
```

### Update object

```json
{
  "roomId": "abc123",
  "sessionId": "v1.example",
  "payload": {
    "kind": "scene-delta",
    "objectId": "ai-cube-1",
    "position": [1.25, 0.5, -0.75],
    "rotation": [0, 0.3827, 0, 0.9239],
    "scale": [1.5, 1.5, 1.5]
  }
}
```

### Delete object

```json
{
  "roomId": "abc123",
  "sessionId": "v1.example",
  "payload": {
    "kind": "scene-remove",
    "objectId": "ai-cube-1"
  }
}
```

### Batch create + update

```json
{
  "roomId": "abc123",
  "sessionId": "v1.example",
  "payload": {
    "kind": "scene-batch",
    "ops": [
      {
        "kind": "scene-add",
        "objectId": "chair-1",
        "name": "Chair",
        "position": [0, 0, 0]
      },
      {
        "kind": "scene-delta",
        "objectId": "table-1",
        "position": [1, 0, 0]
      }
    ]
  }
}
```

## Browser-Only Command Examples

### Focus object

```json
{
  "roomId": "abc123",
  "sessionId": "v1.example",
  "action": "focusObject",
  "params": {
    "objectId": "ai-cube-1"
  }
}
```

### Read camera pose

```json
{
  "roomId": "abc123",
  "sessionId": "v1.example",
  "action": "getCameraPose",
  "params": {}
}
```

### Upload GLB from URL

```json
{
  "roomId": "abc123",
  "sessionId": "v1.example",
  "action": "uploadGlbFromUrl",
  "params": {
    "url": "https://example.com/robot.glb",
    "objectId": "robot-1",
    "name": "Robot",
    "position": [0, 0, 0],
    "rotation": [0, 0, 0, 1],
    "scale": [1, 1, 1]
  }
}
```

## Snapshot Examples

### Before mutation

Request:

```json
{
  "roomId": "abc123",
  "sessionId": "v1.example"
}
```

Response:

```json
{
  "envId": "studio",
  "objects": {
    "table-1": {
      "name": "Table",
      "position": [0, 0, 0]
    }
  }
}
```

### After mutation

Response:

```json
{
  "envId": "studio",
  "objects": {
    "table-1": {
      "name": "Table",
      "position": [1, 0, 0]
    },
    "chair-1": {
      "name": "Chair",
      "position": [0, 0, 0]
    }
  }
}
```

## Success Response Examples

### `scene_sync_broadcast`

```json
{
  "ok": true,
  "room": "abc123",
  "peers": 3,
  "userPresent": true
}
```

### `scene_sync_ai_command`

```json
{
  "ok": true,
  "room": "abc123",
  "peers": 3,
  "userPresent": true,
  "targetPeerId": "peer-123",
  "result": {
    "kind": "ai-result",
    "requestId": "req-123",
    "ok": true,
    "objectId": "robot-1"
  }
}
```

## Error Examples

### Validation error

```json
{
  "ok": false,
  "error": {
    "code": "validation_error",
    "message": "focusObject requires params.objectId",
    "retryable": false
  }
}
```

### Browser action failure inside a `200`

```json
{
  "ok": true,
  "room": "abc123",
  "peers": 3,
  "userPresent": true,
  "targetPeerId": "peer-123",
  "result": {
    "kind": "ai-result",
    "requestId": "req-123",
    "ok": false,
    "error": "object not found"
  }
}
```

## Integration Notes

- GPTs: expose the five stable tool names directly and tell the model to verify
  state with `scene_sync_get_scene` before destructive changes.
- MCP: keep one MCP tool per stable tool name and preserve argument names
  exactly.
- Codex: keep names aligned with [`docs/scene-sync-tools-codex.json`](./scene-sync-tools-codex.json)
  and treat `scene_sync_get_scene` as the source of truth for verification.

## curl Examples

Redeem:

```bash
curl -sS -X POST https://afjk.jp/presence/api/ai/link/redeem \
  -H 'Content-Type: application/json' \
  --data '{"code":"123456"}'
```

Create object:

```bash
curl -sS -X POST https://afjk.jp/presence/api/ai/room/abc123/broadcast \
  -H 'Content-Type: application/json' \
  --data '{
    "sessionId":"v1.example",
    "payload":{
      "kind":"scene-add",
      "objectId":"ai-cube-1",
      "asset":{"type":"primitive","primitive":"box","color":"#ff8800"}
    }
  }'
```

Upload GLB:

```bash
curl -sS -X POST https://afjk.jp/presence/api/ai/room/abc123/ai-command \
  -H 'Content-Type: application/json' \
  --data '{
    "sessionId":"v1.example",
    "action":"uploadGlbFromUrl",
    "params":{"url":"https://example.com/robot.glb","objectId":"robot-1"}
  }'
```
