# Scene Sync AI Tool Contract

This document defines the stable tool contract for Scene Sync AI integrations.
It is the source of truth for GPTs, MCP servers, Codex adapters, and thin API
clients that call the AI wrapper at `https://afjk.jp/presence/api/ai`.

> For the public Scene Sync Operator GPT, the user-facing profile must explain the pairing flow. Users should not need to know the API contract before using the GPT. See the GPTs section for recommended profile description, conversation starters, and instructions.

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
| `scene_sync_ai_command` | Run a browser-only command such as focus, screenshot, GLB import, image/video/text URL import, or skybox update |
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
| `addImageFromUrl` | Add an image panel from a URL | `params.url` |
| `addVideoFromUrl` | Add a video panel from a URL | `params.url` |
| `addTextFromUrl` | Fetch text from a URL and add it as a text panel | `params.url` |
| `setSkyboxFromImageUrl` | Replace the scene skybox from an image URL | `params.url` |

Optional `uploadGlbFromUrl` params:

- `objectId`
- `name`
- `position`
- `rotation`
- `scale`

`uploadGlbFromUrl` is browser-only. It is not a direct file upload endpoint.

Optional params for `addImageFromUrl`, `addVideoFromUrl`, and `addTextFromUrl`:

- `objectId`
- `name`
- `position`
- `rotation`
- `scale`

Optional stereo / VR180 params for `addImageFromUrl` and `addVideoFromUrl`:

- `projection`: `flat`（既定） | `vr180`
- `stereoLayout`: `mono`（既定） | `sbs` | `tb`

省略時はファイル名の `vr180` / `sbs` / `tb` 等のトークンから自動判定する。
詳細は [Asset / Blob / Cache](./scene-sync-assets-and-cache.md) の
「Stereo / VR180 media」を参照。

`setSkyboxFromImageUrl` currently only requires `params.url`.

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
- Agents should not blindly retry `scene-add`, `uploadGlbFromUrl`,
  `addImageFromUrl`, `addVideoFromUrl`, `addTextFromUrl`, or
  `setSkyboxFromImageUrl` without a
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
- The GPT profile must clearly explain that users need to link a Scene Sync room before asking for scene operations.
- Use the profile description, conversation starters, and instructions to guide first-time users.

#### Recommended GPT profile description

Use a user-facing description like:

```text
Scene Sync のルームにリンクして、3Dシーン内のオブジェクト追加・移動・色変更・配置確認を会話で操作できます。まず Scene Sync 画面の「AIにリンク」から6桁コードを発行し、このGPTに入力してください。
```

Short English alternative:

```text
Control a Scene Sync 3D room by chat. First open Scene Sync, click "AIにリンク", then send the 6-digit pairing code here.
```

#### Recommended conversation starters

Use starters that teach the user what to do:

```text
リンク方法を教えて
```

```text
Scene Sync の6桁コードを入力します
```

```text
今のシーンに何がありますか？
```

```text
サンプルキューブを動かして
```

Avoid starters that assume the GPT is already linked unless they clearly imply a linked state.

#### Recommended GPT instructions

Include this behavior in the GPT instructions:

```text
When the user starts a new conversation and has not provided a pairing code or sessionId yet, briefly guide them to link Scene Sync first.

Explain the flow:
1. Open Scene Sync.
2. Click "AIにリンク".
3. Copy the 6-digit code.
4. Send the code in this chat.

If the user sends a 6-digit code, redeem it immediately using scene_sync_redeem.
After a successful link, say that the room is ready and suggest 2-3 example commands.

Do not say that the scene is controllable until the link is actually redeemed.
If an API response has peers: 0 or userPresent: false, explain that the AI session exists but the browser may not be connected to the same room.
```

Japanese version:

```text
新しい会話で、まだ pairing code または sessionId がない場合は、最初に Scene Sync とのリンク方法を短く案内する。

案内する手順:
1. Scene Sync を開く
2. 「AIにリンク」を押す
3. 表示された6桁コードをコピーする
4. このチャットにコードを送る

ユーザーが6桁コードを送った場合は、すぐに scene_sync_redeem を実行する。
リンク成功後は、操作準備ができたことを伝え、使えるコマンド例を2〜3個だけ提示する。

実際にリンクが成功するまでは「操作できます」と断言しない。
APIレスポンスで peers: 0 または userPresent: false の場合は、「AIセッションは作成されたが、ブラウザが同じルームに接続されていない可能性がある」と説明する。
```

#### First response template

When the GPT has no active session yet, it should start with a short guide like:

```text
Scene Sync Operator へようこそ。

まず Scene Sync とリンクしてください。

1. Scene Sync の画面を開く
2. 左上の「AIにリンク」を押す
3. 表示された6桁コードをこのチャットに送る

リンク後は、たとえば次のように操作できます。

- 「今のシーンに何がありますか？」
- 「青い箱を追加して右に置いて」
- 「サンプルキューブを赤くして少し大きくして」
- 「選択中のオブジェクトを回転させて」

6桁コードを送ってください。
```

#### Linked-state response template

After `scene_sync_redeem` succeeds, respond like:

```text
リンクしました。

Room ID: `{roomId}`
セッション有効期限: `{expiresAt}`

Scene Sync の操作準備ができています。たとえば次のように頼めます。

- 「今のシーンに何がありますか？」
- 「青い箱を追加して右に置いて」
- 「サンプルキューブを赤くして少し大きくして」
```

Only use this wording after redeem succeeds.

If the later operation response has `peers: 0` or `userPresent: false`, do not say the browser is connected. Explain the possible room/browser mismatch instead.

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
