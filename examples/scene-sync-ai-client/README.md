# Scene Sync AI Client Example

Minimal provider-neutral client for the Scene Sync AI wrapper API.

This example sits between:

- AI tool definitions such as `docs/scene-sync-tools-claude.json`
- the HTTP API at `https://afjk.jp/presence/api/ai/*`

It provides client methods instead of raw `fetch()` calls:

- `redeem(code)`
- `getScene(roomId, sessionId)`
- `broadcast(roomId, sessionId, payload)`
- `aiCommand(roomId, sessionId, action, params)`
- `revoke(sessionId)`

These methods intentionally mirror the stable tool names documented in:

- `scene_sync_redeem`
- `scene_sync_get_scene`
- `scene_sync_broadcast`
- `scene_sync_ai_command`
- `scene_sync_revoke`

Transport errors are normalized on `SceneSyncApiError` with `status`, `code`,
`retryable`, and `details` so callers do not need to infer behavior from HTTP
status alone. Browser-side command failures can still come back as a successful
wrapper response with `result.ok: false`.

## Files

- `src/scene-sync-client.mjs`
  - thin HTTP client
- `src/validators.mjs`
  - required argument checks
- `src/claude-adapter.mjs`
  - Claude tool-call adapter
- `src/codex-adapter.mjs`
  - Codex / OpenAI function-call adapter
- `src/demo.mjs`
  - simple CLI for manual testing

## Requirements

- Node 18+

## Base URL

Default:

```bash
https://afjk.jp/presence/api/ai
```

Override:

```bash
export SCENE_SYNC_BASE_URL=https://staging.afjk.jp/presence/api/ai
```

## Demo usage

Redeem:

```bash
npm run demo -- redeem 123456
```

Read scene:

```bash
npm run demo -- scene <roomId> <sessionId>
```

Add a test cube:

```bash
npm run demo -- add-cube <roomId> <sessionId> demo-cube-1
```

Focus an object:

```bash
npm run demo -- focus <roomId> <sessionId> ai-cube-1
```

Add a cube, wait, then focus it:

```bash
npm run demo -- add-and-focus <roomId> <sessionId> demo-cube-1 500
```

`focusObject` can fail immediately after `scene-add` if the browser has not yet registered
the new object in `managedObjects`. `add-and-focus` adds a small wait to avoid that race.

Take a screenshot:

```bash
npm run demo -- screenshot <roomId> <sessionId>
```

Revoke:

```bash
npm run demo -- revoke <sessionId>
```

## Claude integration shape

```js
import { SceneSyncClient } from './src/scene-sync-client.mjs';
import { handleClaudeToolCall } from './src/claude-adapter.mjs';

const client = new SceneSyncClient();
const result = await handleClaudeToolCall(tool.name, tool.input, client);
```

## Codex / OpenAI integration shape

```js
import { SceneSyncClient } from './src/scene-sync-client.mjs';
import { handleCodexFunctionCall } from './src/codex-adapter.mjs';

const client = new SceneSyncClient();
const result = await handleCodexFunctionCall(toolCall, client);
```

## Validation included

- `focusObject` requires `params.objectId`
- `uploadGlbFromUrl` requires `params.url`
- primitive `scene-add` requires `payload.asset.primitive`
- primitive `scene-add` requires `payload.asset.color`

## Verification policy

- Use `getScene(roomId, sessionId)` before mutations when state matters.
- Use `getScene(roomId, sessionId)` after `scene-add`, `scene-delta`,
  `scene-remove`, and `uploadGlbFromUrl` when correctness matters more than
  speed.
- For `aiCommand`, check both top-level `ok` and nested `result.ok`.
- Treat `unauthorized` and `validation_error` as non-retryable.
- Treat `conflict` as retryable only after a fresh snapshot.

This client does not persist session state. Store `sessionId`, `roomId`, and `expiresAt` in the host application.
