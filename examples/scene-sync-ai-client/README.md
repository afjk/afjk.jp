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

This client does not persist session state. Store `sessionId`, `roomId`, and `expiresAt` in the host application.
