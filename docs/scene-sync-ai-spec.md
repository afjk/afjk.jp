# Scene Sync AI Tool Contract

This document defines the stable tool contract for Scene Sync AI integrations.
It is the source of truth for GPTs, MCP servers, Codex adapters, and thin API
clients that call the AI wrapper at `https://afjk.jp/presence/api/ai`.

## Scope

- Stable tool names exposed to AI runtimes
- Required and optional parameters
- Response expectations
- Error handling policy
- Scene snapshot before/after policy
- Concise request/response examples

Runtime implementation details such as the browser handoff internals stay in
the broader Scene Sync specs. This contract is intentionally small and stable.

## Stable Tool Surface

The wrapper exposes five stable top-level tools:

| Tool name | Purpose |
| --- | --- |
| `scene_sync_redeem` | Redeem a 6-digit pairing code and create an AI session |
| `scene_sync_get_scene` | Read the current scene snapshot for the linked room |
| `scene_sync_broadcast` | Apply a scene mutation such as object create/update/delete |
| `scene_sync_ai_command` | Run a browser-only command such as focus, screenshot, or GLB upload |
| `scene_sync_revoke` | Revoke the current AI session |

These names are stable across GPTs, Codex, MCP wrappers, and sample clients.
Do not rename them per provider.

## Scene Mutation Vocabulary

`scene_sync_broadcast` carries one mutation payload in `payload.kind`.

| `payload.kind` | Meaning | Required fields |
| --- | --- | --- |
| `scene-add` | Create an object | `kind`, `objectId` |
| `scene-delta` | Update an existing object | `kind`, `objectId` |
| `scene-remove` | Delete an existing object | `kind`, `objectId` |
| `scene-env` | Update scene environment | `kind`, `envId` |
| `scene-batch` | Apply multiple mutations atomically | `kind`, `ops` |

Notes:

- For primitive `scene-add`, include `payload.asset.type=primitive`,
  `payload.asset.primitive`, and `payload.asset.color`.
- `scene-delta` is partial update semantics. Only send fields you intend to
  change.
- `scene-remove` is id-based. Do not expect soft delete behavior.
- `scene-batch` is preferred when multiple changes should share one history
  unit or one verification cycle.

## Browser-Only Command Vocabulary

`scene_sync_ai_command` uses a stable `action` value.

| `action` | Purpose | Required params |
| --- | --- | --- |
| `getCameraPose` | Read the browser camera pose | none |
| `focusObject` | Focus the camera on an object | `params.objectId` |
| `undo` | Undo one history step | none |
| `redo` | Redo one history step | none |
| `getHistory` | Read recent browser history entries | none |
| `screenshot` | Capture a browser screenshot | none |
| `uploadGlbFromUrl` | Import a GLB from a URL | `params.url` |

Optional `uploadGlbFromUrl` params:

- `objectId`
- `name`
- `position`
- `rotation`
- `scale`

`uploadGlbFromUrl` is browser-only. It is not a direct file upload endpoint.

## Required and Optional Parameters

### `scene_sync_redeem`

Required:

- `code`

Optional:

- none

Response expectation:

- Returns `ok`, `sessionId`, `roomId`, `expiresAt`

### `scene_sync_get_scene`

Required:

- `roomId`
- `sessionId`

Optional:

- none

Response expectation:

- Returns the latest scene snapshot for the room
- Current stable fields are `envId` and `objects`

### `scene_sync_broadcast`

Required:

- `roomId`
- `sessionId`
- `payload`
- `payload.kind`

Optional top-level fields:

- none

Optional mutation fields depend on `payload.kind`:

- `scene-add`: `name`, `position`, `rotation`, `scale`, `asset`, `meshPath`
- `scene-delta`: `name`, `position`, `rotation`, `scale`, `asset`, `meshPath`
- `scene-remove`: none beyond `objectId`
- `scene-env`: none beyond `envId`
- `scene-batch`: `ops[*]` follow the same rules as individual mutation payloads

Response expectation:

- Returns transport success, room context, and user presence
- Current stable fields are `ok`, `room`, `peers`, `userPresent`

### `scene_sync_ai_command`

Required:

- `roomId`
- `sessionId`
- `action`

Optional:

- `params`
- `requestId`
- `targetPeerId`

Response expectation:

- Returns the same room context fields as `scene_sync_broadcast`
- Includes `targetPeerId`
- Includes browser result in `result`
- `result.kind` is expected to be `ai-result`
- `result.ok` indicates whether the browser completed the requested action

### `scene_sync_revoke`

Required:

- `sessionId`

Optional:

- none

Response expectation:

- Returns `{ "ok": true }` on successful revoke

## Response Policy

The contract distinguishes three layers of success:

1. HTTP success: the wrapper accepted and processed the request
2. Wrapper success: top-level `ok: true`
3. Browser action success: `result.ok: true` for `scene_sync_ai_command`

Implications:

- `scene_sync_broadcast` success means the wrapper accepted the mutation and
  broadcast it to the room. Confirm object state with a later snapshot if state
  matters.
- `scene_sync_ai_command` success requires checking both top-level `ok` and
  nested `result.ok`.
- `scene_sync_get_scene` is the authoritative state read for verification.

## Error Handling Policy

Agents should treat errors by class, not by provider-specific wording.

| Class | Typical status | Meaning | Agent action |
| --- | --- | --- | --- |
| `validation_error` | `400`, `422` | Required field missing or malformed payload | Fix arguments locally and retry |
| `unauthorized` | `401` | Session invalid, expired, or revoked | Re-link with `scene_sync_redeem` |
| `forbidden` | `403` | Session-room mismatch or disallowed target | Stop and confirm room/session |
| `not_found` | `404` | Room, code, object, or target peer missing | Refresh snapshot or relink |
| `conflict` | `409`, `410` | State moved, code already redeemed, or stale operation | Refresh snapshot, then retry if still desired |
| `internal_error` | `500+` | Wrapper or browser-side failure | Retry once if idempotent, otherwise stop |

Preferred error body:

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

Policy notes:

- The contract only requires a stable machine-readable `error.code`. Human
  `message` text may evolve.
- For `scene_sync_ai_command`, browser failures should surface inside
  `result.ok=false` even when the wrapper request itself returned HTTP `200`.
- Agents should not blindly retry `scene-add` or `uploadGlbFromUrl` without a
  follow-up snapshot, because duplicates are possible.

## Scene Snapshot Before/After Policy

When an action changes scene state, the standard flow is:

1. Call `scene_sync_get_scene` before the mutation when the current state is
   not already known in the same turn.
2. Send one mutation with `scene_sync_broadcast`, or one browser-only action
   with `scene_sync_ai_command`.
3. Call `scene_sync_get_scene` after the mutation when object existence,
   transform accuracy, or deduplication matters.

Use before/after snapshots by default for:

- object creation
- object update
- object deletion
- batch edits
- GLB upload

You may skip the before snapshot only when all of the following are true:

- the agent just created the object id itself
- no branching decision depends on prior state
- duplicate creation is acceptable

You may skip the after snapshot only when the caller explicitly accepts
best-effort execution without state confirmation.

## Concise Examples

### 1. Redeem

Request:

```json
{ "code": "123456" }
```

Response:

```json
{
  "ok": true,
  "sessionId": "v1.example",
  "roomId": "abc123",
  "expiresAt": 1760000000000
}
```

### 2. Create object

Request:

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

Response:

```json
{
  "ok": true,
  "room": "abc123",
  "peers": 3,
  "userPresent": true
}
```

### 3. Update object

Request:

```json
{
  "roomId": "abc123",
  "sessionId": "v1.example",
  "payload": {
    "kind": "scene-delta",
    "objectId": "ai-cube-1",
    "position": [1.25, 0.5, -0.75],
    "scale": [1.5, 1.5, 1.5]
  }
}
```

### 4. Delete object

Request:

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

### 5. Read snapshot

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
    "ai-cube-1": {
      "name": "Orange Cube",
      "position": [0, 0.5, 0],
      "scale": [1, 1, 1]
    }
  }
}
```

### 6. Upload GLB from URL

Request:

```json
{
  "roomId": "abc123",
  "sessionId": "v1.example",
  "action": "uploadGlbFromUrl",
  "params": {
    "url": "https://example.com/robot.glb",
    "objectId": "robot-1",
    "name": "Robot",
    "position": [0, 0, 0]
  }
}
```

Response:

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

## Integration Notes

### GPTs

- Expose the five stable tool names directly.
- Keep tool descriptions short and parameter-driven.
- Prefer prompting the model to fetch a snapshot before destructive changes.

### MCP

- Map each stable tool name to one MCP tool.
- Preserve the same argument names so adapters stay thin.
- Surface `error.code` as structured tool errors when possible.

### Codex

- Keep the function names exactly aligned with
  `docs/scene-sync-tools-codex.json`.
- When translating from tool calls to HTTP, avoid adding inferred defaults that
  are not present in this contract.
- After `scene-add`, `scene-remove`, `scene-delta`, and `uploadGlbFromUrl`,
  follow with `scene_sync_get_scene` when correctness matters more than speed.

## References

- OpenAPI wrapper spec: [`docs/scene-sync-ai-openapi.yaml`](./scene-sync-ai-openapi.yaml)
- Codex function definitions: [`docs/scene-sync-tools-codex.json`](./scene-sync-tools-codex.json)
- Examples: [`docs/scene-sync-ai-tool-examples.md`](./scene-sync-ai-tool-examples.md)
- Example client: [`examples/scene-sync-ai-client/README.md`](../examples/scene-sync-ai-client/README.md)
