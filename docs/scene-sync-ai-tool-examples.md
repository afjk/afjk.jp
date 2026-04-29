# Scene Sync AI Tool Examples

Provider-neutral examples for calling the Scene Sync AI wrapper API at `https://afjk.jp/presence/api/ai`.

Actual tool definition files in this repo:

- Claude tool definitions: [`docs/scene-sync-tools-claude.json`](./scene-sync-tools-claude.json)
- Codex / OpenAI function definitions: [`docs/scene-sync-tools-codex.json`](./scene-sync-tools-codex.json)
- Minimal API client example: [`examples/scene-sync-ai-client/`](../examples/scene-sync-ai-client/README.md)

## Common flow

1. Ask the user for the 6-digit code from `AIにリンク`
2. Call `POST /api/ai/link/redeem`
3. Store `sessionId`, `roomId`, and `expiresAt`
4. Use `sessionId` in every subsequent request body
5. Revoke with `POST /api/ai/link/revoke` when done

## Claude / function-calling style

Tool schema:

```json
{
  "name": "scene_sync_broadcast",
  "description": "Apply a Scene Sync mutation through the AI wrapper API",
  "input_schema": {
    "type": "object",
    "required": ["roomId", "sessionId", "payload"],
    "properties": {
      "roomId": { "type": "string" },
      "sessionId": { "type": "string" },
      "payload": {
        "type": "object",
        "required": ["kind"],
        "properties": {
          "kind": { "type": "string" }
        },
        "additionalProperties": true
      }
    }
  }
}
```

HTTP request:

```http
POST /presence/api/ai/room/{roomId}/broadcast
Content-Type: application/json

{
  "sessionId": "v1....",
  "payload": {
    "kind": "scene-add",
    "objectId": "ai-cube-1",
    "name": "Orange Cube",
    "position": [0, 0.5, 0],
    "rotation": [0, 0, 0, 1],
    "scale": [1, 1, 1],
    "asset": { "type": "primitive", "primitive": "box", "color": "#ff8800" }
  }
}
```

## Codex / tool wrapper style

See [`docs/scene-sync-tools-codex.json`](./scene-sync-tools-codex.json) for a concrete function-definition file.

Suggested tools:

- `scene_sync_redeem(code)`
- `scene_sync_scene(roomId, sessionId)`
- `scene_sync_broadcast(roomId, sessionId, payload)`
- `scene_sync_ai_command(roomId, sessionId, action, params)`
- `scene_sync_revoke(sessionId)`

Example `focusObject` call:

```json
{
  "roomId": "abc123",
  "sessionId": "v1....",
  "action": "focusObject",
  "params": {
    "objectId": "ai-cube-1"
  }
}
```

## GitHub Copilot / extension wrapper style

Wrap the REST API in a tiny service layer and expose high-level methods:

```ts
await sceneSync.redeem(code);
await sceneSync.getScene(roomId, sessionId);
await sceneSync.broadcast(roomId, sessionId, payload);
await sceneSync.aiCommand(roomId, sessionId, action, params);
await sceneSync.revoke(sessionId);
```

## Grok / generic tool-calling style

If the platform supports JSON-schema tools, mirror the same arguments:

- `roomId`
- `sessionId`
- `payload` for scene mutations
- `action` and `params` for browser-only commands

## Required parameter reminders

- `scene-add` primitive:
  - `payload.asset.type`
  - `payload.asset.primitive`
  - `payload.asset.color`
- `focusObject`:
  - `params.objectId`
- `uploadGlbFromUrl`:
  - `params.url`

## curl examples

Redeem:

```bash
curl -sS -X POST https://afjk.jp/presence/api/ai/link/redeem \
  -H 'Content-Type: application/json' \
  --data '{"code":"123456"}'
```

Read scene:

```bash
curl -sS -X POST https://afjk.jp/presence/api/ai/room/abc123/scene \
  -H 'Content-Type: application/json' \
  --data '{"sessionId":"v1...."}'
```

Focus object:

```bash
curl -sS -X POST https://afjk.jp/presence/api/ai/room/abc123/ai-command \
  -H 'Content-Type: application/json' \
  --data '{
    "sessionId":"v1....",
    "action":"focusObject",
    "params":{"objectId":"ai-cube-1"}
  }'
```
