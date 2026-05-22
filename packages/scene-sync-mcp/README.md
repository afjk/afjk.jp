# Scene Sync MCP

An MCP server for controlling [afjk.jp](https://afjk.jp) Scene Sync from Claude Desktop, Claude Code, and Codex.

Scene Sync is a real-time 3D scene synchronization system. This MCP server lets AI models:
- Redeem pairing codes to link to a user's Scene Sync room
- Add and manipulate 3D objects (boxes, spheres, primitives, and image/video/text/GLB assets from URL)
- Inspect camera pose
- Access browser operation history (undo/redo)
- Focus the camera on objects
- Update the scene skybox from an image URL
- Take screenshots
- Switch animation clips on animated GLB objects
- Manage the link session

## Installation

Scene Sync MCP is published to npm as `@afjk/scene-sync-mcp`.

### Codex CLI

Recommended:

```bash
npx -y @afjk/scene-sync-mcp@latest setup codex
```

Check the resolved base URL and session file:

```bash
npx -y @afjk/scene-sync-mcp@latest doctor
```

For staging:

```bash
npx -y @afjk/scene-sync-mcp@latest setup codex --staging
```

### Claude Desktop

Update Claude Desktop config automatically:

```bash
npx -y @afjk/scene-sync-mcp@latest setup claude
```

This command updates `claude_desktop_config.json` and adds or replaces the `scene-sync` entry while preserving your other MCP servers and preferences.

To print the JSON instead of writing it:

```bash
npx -y @afjk/scene-sync-mcp@latest setup claude --print
```

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "scene-sync": {
      "command": "npx",
      "args": ["-y", "@afjk/scene-sync-mcp@latest"]
    }
  }
}
```

Then fully quit and restart Claude Desktop. For Claude Desktop config path, see https://modelcontextprotocol.io/clients/claude/

To use staging or customize the session file location:

```json
{
  "mcpServers": {
    "scene-sync": {
      "command": "npx",
      "args": ["-y", "@afjk/scene-sync-mcp@latest"],
      "env": {
        "SCENE_SYNC_BASE_URL": "https://afjk.jp/presence/api/ai",
        "SCENE_SYNC_SESSION_FILE": "/Users/YOUR_NAME/.scene-sync-mcp/session.json"
      }
    }
  }
}
```

### Setup Helpers

Single-command helpers:

```bash
npx -y @afjk/scene-sync-mcp@latest setup codex
```

Print Claude Desktop config without writing:

```bash
npx -y @afjk/scene-sync-mcp@latest setup claude --print
```

Show local diagnostics:

```bash
npx -y @afjk/scene-sync-mcp@latest doctor
```

The legacy `scene-sync-mcp-setup` binary still works, but the main `scene-sync-mcp` CLI is now the primary entrypoint.

If you prefer a local checkout instead of npm, use the package scripts:

```bash
npm install
npm run setup:codex
```

### Local Development

For development or contributing to the MCP server itself:

```bash
npm install
npm run start
```

To use the local checkout with Claude Desktop:

```json
{
  "mcpServers": {
    "scene-sync": {
      "command": "node",
      "args": ["/path/to/packages/scene-sync-mcp/src/cli.mjs", "serve"]
    }
  }
}
```

To register the local checkout with Codex:

```bash
cd packages/scene-sync-mcp
npm install
npm run setup:codex
```

## Quick Start

1. Open https://afjk.jp/scenesync/ in your browser
2. Click "AIにリンク" (Link with AI)
3. Copy the 6-digit code
4. Tell Claude: "Scene Sync に 123456 のコードでリンクして" (Link Scene Sync with code 123456)
5. Ask: "オレンジ色の箱を中央に置いて" (Put an orange box in the center)

## Tools

### scene_sync_redeem
Redeem a 6-digit pairing code. Call after the user clicks "AIにリンク" and provides the code.

Input:
```json
{
  "code": "123456"
}
```

### scene_sync_status
Check current link status and expiration time.

### scene_sync_get_scene
Get the current scene state (objects and environment). May take up to 5 seconds.

Input: `{}` (default) or `{ "selectedOnly": true }` to return only currently selected objects.

When `selectedOnly: true`, the browser is queried for the current selection instead of fetching the full scene snapshot.

### scene_sync_add_box
Add a box to the scene. High-level tool; use directly for requests like "add a red cube".

Input:
```json
{
  "objectId": "my-box-1",
  "name": "Red Box",
  "position": [0, 0.5, 0],
  "color": "#ff0000"
}
```

All fields except `position` default intelligently if omitted.

### scene_sync_add_sphere
Add a sphere to the scene (same input schema as add_box).

### scene_sync_add_primitive
Advanced: generic tool for adding any primitive (box, sphere, cylinder, plane). Prefer `scene_sync_add_box` or `scene_sync_add_sphere` for common cases.

### scene_sync_move_object
Move an existing object to a new absolute position.

Input:
```json
{
  "objectId": "my-box-1",
  "position": [1, 0.5, 0]
}
```

### scene_sync_rotate_object
Rotate an object using a quaternion [x, y, z, w].

### scene_sync_scale_object
Scale an object using [x, y, z] scale factors.

### scene_sync_set_color
Change the color of a primitive object.

**Important:** The `primitive` parameter is required. If the primitive type is unknown, call `scene_sync_get_scene` first and inspect the object's `asset.primitive` field.

Input:
```json
{
  "objectId": "my-box-1",
  "color": "#00ff00",
  "primitive": "box"
}
```

日本語: `primitive` は必須です。種類が不明な場合は、先に `scene_sync_get_scene` で対象 object の `asset.primitive` を確認してください。

### scene_sync_add_glb_from_url
Add a GLB/glTF model from a publicly fetchable URL.

Input:
```json
{
  "url": "https://example.com/model.glb",
  "objectId": "ai-model-1",
  "name": "Example Model",
  "position": [0, 0, 0],
  "rotation": [0, 0, 0, 1],
  "scale": [1, 1, 1]
}
```

Notes:
- The URL must be accessible from the browser.
- CORS headers may be required depending on the hosting site.
- Local file paths are not supported by this tool.
- For local files, drag & drop them into the Scene Sync browser UI instead.

### scene_sync_add_image_from_url
Add an image panel from a publicly fetchable URL.

Input:
```json
{
  "url": "https://example.com/image.jpg",
  "objectId": "ai-image-1",
  "name": "Reference Image",
  "position": [0, 1.5, -2],
  "rotation": [0, 0, 0, 1],
  "scale": [2, 2, 1]
}
```

Notes:
- The URL must be accessible from the browser.
- CORS headers may be required depending on the hosting site.

### scene_sync_add_video_from_url
Add a video panel from a publicly fetchable URL.

Input:
```json
{
  "url": "https://example.com/video.mp4",
  "objectId": "ai-video-1",
  "name": "Loop Video",
  "position": [0, 1.5, -2],
  "rotation": [0, 0, 0, 1],
  "scale": [2, 2, 1]
}
```

Notes:
- The URL must be accessible from the browser.
- CORS headers may be required depending on the hosting site.

### scene_sync_add_text_from_url
Fetch text from a publicly fetchable URL and add it as a text panel.

Input:
```json
{
  "url": "https://example.com/notes.txt",
  "objectId": "ai-text-1",
  "name": "Remote Notes",
  "position": [0, 1.5, -2],
  "rotation": [0, 0, 0, 1],
  "scale": [2, 2, 1]
}
```

Notes:
- The URL must be accessible from the browser.
- CORS headers may be required depending on the hosting site.
- The browser fetches and interprets the remote text content.

### scene_sync_set_skybox_from_image_url
Set the scene skybox from a publicly fetchable image URL.

Input:
```json
{
  "url": "https://example.com/panorama.jpg"
}
```

Notes:
- This replaces the current browser skybox/environment image.
- The URL must be accessible from the browser.
- CORS headers may be required depending on the hosting site.

### scene_sync_get_camera_pose
Get the current browser camera position and quaternion.

Input: `{}`

Returns camera position and quaternion.

### scene_sync_get_history
Get recent Scene Sync operation history.

Input:
```json
{
  "count": 10
}
```

Returns the last N history entries from the browser.

### scene_sync_replace_media

Replace the content of a media panel with an image or video URL. If `objectId` is omitted, the currently selected object is used.

Input:
```json
{
  "objectId": "media-panel-1",
  "url": "https://example.com/image.png",
  "mediaType": "image",
  "name": "Updated Image"
}
```

Or for video:
```json
{
  "url": "https://example.com/video.mp4",
  "mediaType": "video"
}
```

Fields: `url` (required), `mediaType` (required, "image" or "video"), `objectId` (optional), `name` (optional).

Notes:
- Image and video media panels can be interchanged.
- The URL must be accessible from the browser.
- CORS headers may be required.

### scene_sync_replace_text

Replace the text content of a text panel. If `objectId` is omitted, the currently selected object is used.

Input:
```json
{
  "objectId": "text-panel-1",
  "text": "Hello Scene Sync",
  "fontFamily": "system-sans",
  "fontSize": 32,
  "color": "#ffffff",
  "align": "center"
}
```

Fields: `text` (required), `objectId` (optional), `name` (optional), `fontFamily` (optional, "system-sans" / "serif" / "monospace" / "japanese-sans" / "japanese-serif"), `fontSize` (optional, pixels), `fontWeight` (optional), `fontStyle` (optional, "normal" / "italic"), `color` (optional), `backgroundColor` (optional), `align` (optional, "left" / "center" / "right").

Notes:
- Unspecified text styling fields inherit from the existing asset.
- If no existing styling exists, default values are used.

### scene_sync_set_animation_clip

Switch an animated GLB object to a specific animation clip by name or index.

First inspect selected object clips:

````json
{
  "tool": "scene_sync_get_selection",
  "arguments": {}
}
````

Then switch clip:

````json
{
  "tool": "scene_sync_set_animation_clip",
  "arguments": {
    "objectId": "minotauros-001",
    "clipName": "laugh",
    "mode": "loop"
  }
}
````

If a clip name is ambiguous, for example `attack`, the browser returns candidates such as `attack_1`, `attack_2`, etc. Choose a specific one.

Input:
```json
{
  "objectId": "minotauros-001",
  "clipName": "laugh",
  "mode": "loop"
}
```

Or by index:
```json
{
  "objectId": "minotauros-001",
  "clip": 7
}
```

Fields: `objectId` (required), `clipName` or `name` or `clip` (one required), `mode` (loop/once, default loop), `speed` (default 1), `enabled` (default true).

### scene_sync_get_selection

Returns the objects currently selected in the linked Scene Sync browser.

This is a generic current-selection API for external tools. Selection is browser-local/session-local state and is not persisted into the shared scene.

Input: `{}`

Use cases:

- align selected objects
- distribute selected objects
- randomize selected rotation or scale
- apply a Loomlet graph to selected objects
- run scoped edits from AI or CLI tools

### scene_sync_undo
Undo the last operation recorded in the Scene Sync history.

Input: `{}`

### scene_sync_redo
Redo the last undone operation.

Input: `{}`

Note: Undo/Redo operates on the browser-side Scene Sync history. Some operations may not be undoable if they were not recorded in the browser history.

### scene_sync_focus_object
Focus the browser camera on an object (requires objectId).

### scene_sync_screenshot
Request a screenshot from the browser (may take a few seconds).

### scene_sync_revoke
Revoke the current link. The user must redeem a new code to continue.

## Response Contract

- Success responses are JSON text with `ok: true` and tool-specific fields.
- Error responses are JSON text with `ok: false` and `error: { code, message, retryable }`.
- `validation_error` and `unauthorized` are non-retryable.
- Browser command failures can still appear inside a successful wrapper response
  as `result.ok: false`; check the nested result when verification matters.
- Browser command success responses pass through room context fields such as
  `room`, `peers`, `userPresent`, and `targetPeerId` when the backend returns
  them.

## Environment Variables

### SCENE_SYNC_BASE_URL
Default: `https://afjk.jp/presence/api/ai`

API endpoint base URL.

### SCENE_SYNC_SESSION_FILE
Default: `$HOME/.config/scene-sync-mcp/session.json`

Session is persisted to this JSON file by default.

Example (note: use full path, not `~`):
```bash
export SCENE_SYNC_SESSION_FILE=$HOME/.config/scene-sync-mcp/session.json
# or
export SCENE_SYNC_SESSION_FILE=/Users/yourname/.config/scene-sync-mcp/session.json
```

**Important:** Node.js does not automatically expand `~`. Use `$HOME` or full path instead.

Override it only when you need a custom location.

### SCENE_SYNC_DEFAULT_COLOR
Default: `#ff8800`

Default color for new objects if color is not specified.

### SCENE_SYNC_ENABLE_RAW_TOOLS
Default: `false`

If `true`, enables the `scene_sync_raw_broadcast` developer tool. Use only for advanced debugging.

```bash
export SCENE_SYNC_ENABLE_RAW_TOOLS=true
```

## Browser AI Command parity

Browser AI commands in `html/assets/js/scenesync/scene.js` should stay in sync with MCP tools.

| Browser AI Command | MCP Tool | Status |
|---|---|---|
| `getCameraPose` | `scene_sync_get_camera_pose` | supported |
| `focusObject` | `scene_sync_focus_object` | supported |
| `screenshot` | `scene_sync_screenshot` | supported |
| `uploadGlbFromUrl` | `scene_sync_add_glb_from_url` | supported |
| `addImageFromUrl` | `scene_sync_add_image_from_url` | supported |
| `addVideoFromUrl` | `scene_sync_add_video_from_url` | supported |
| `addTextFromUrl` | `scene_sync_add_text_from_url` | supported |
| `setSkyboxFromImageUrl` | `scene_sync_set_skybox_from_image_url` | supported |
| `getHistory` | `scene_sync_get_history` | supported |
| `undo` | `scene_sync_undo` | supported |
| `redo` | `scene_sync_redo` | supported |
| `getSelection` | `scene_sync_get_selection` | supported |
| `setAnimationClip` | `scene_sync_set_animation_clip` | supported |

When adding a new browser AI command:

- Add command handling in `handleAiCommand()`
- Add matching MCP tool in `packages/scene-sync-mcp/src/server.mjs`
- Add README documentation for the MCP tool
- Update this parity table
- Confirm tool responses do not expose `sessionId`
- Confirm errors are handled by `assertAiCommandOk()`

## Behavior Policy

- **For clear requests** (e.g., "add a red cube"), call `add_box`/`add_sphere` directly without checking the scene first.
- **Before modifying existing objects**, call `get_scene` first if the target is ambiguous.
- **Do not remove objects** without explicit user confirmation (removal tool not yet implemented).
- **Use `ai-` prefix** for object IDs created by AI to distinguish from user-created objects.
- **Prefer high-level tools** (`add_box`, `add_sphere`) over `add_primitive`.
- **focus_object requires objectId** — do not call without it.

## Coordinate System

- **Y-up**, meters
- **Floor is at y=0**
- Position y is the object center (so a 1m box on the floor has y=0.5)
- Position: [x, y, z]
- Rotation: [qx, qy, qz, qw] quaternion

## Security

- **sessionId** is stored only inside the local MCP server process.
- Session is persisted by default to `SCENE_SYNC_SESSION_FILE`.
- Destructive tools (remove, batch operations) are not enabled in this MVP.
- `scene_sync_raw_broadcast` is disabled by default.
- The server does not expose sessionId in tool responses.

## Troubleshooting

### "Not linked. Ask the user to press AIにリンク..."
The user has not yet redeemed a pairing code. Ask them to:
1. Open https://afjk.jp/scenesync/
2. Click "AIにリンク"
3. Copy the 6-digit code
4. Provide the code to call `scene_sync_redeem`

### "Link expired"
The pairing code has expired. Ask the user to repeat the link flow above.

These cases map to `error.code = unauthorized` when they are raised by a tool
that requires an active link.

### "userPresent=false"
The Scene Sync room is open in the browser, but the user may not be actively viewing it. Ask them to focus the browser window.

### Large get_scene responses
If `get_scene` returns many objects, the response is automatically summarized to show the first 50 object IDs.

## Development

```bash
# Install dependencies
npm install

# Run server
npm run start

# Or watch mode (if added to scripts)
npm run dev
```

For testing with Claude Desktop, modify your config to point to the local directory:

```json
{
  "mcpServers": {
    "scene-sync": {
      "command": "node",
      "args": ["/path/to/packages/scene-sync-mcp/src/cli.mjs", "serve"]
    }
  }
}
```

## Maintainer: Publishing to npm

To release a new version to npm:

### 1. Update the package version

```bash
cd packages/scene-sync-mcp
npm version patch --no-git-tag-version
# or: npm version minor --no-git-tag-version
```

### 2. Commit the version bump

```bash
cd ../..
git add packages/scene-sync-mcp/package.json packages/scene-sync-mcp/package-lock.json
git commit -m "Release scene-sync-mcp v0.x.x"
```

### 3. Create and push a release tag

```bash
git tag scene-sync-mcp-v0.x.x
git push origin main
git push origin scene-sync-mcp-v0.x.x
```

The GitHub Actions workflow `publish-scene-sync-mcp.yml` will automatically:
- Run syntax checks and tests
- Publish the package to npm using Trusted Publishing (OIDC)

The package will be available on npm at `@afjk/scene-sync-mcp` and can be used immediately with:

```bash
npx -y @afjk/scene-sync-mcp@latest setup codex
```

For Claude Desktop:

```bash
npx -y @afjk/scene-sync-mcp@latest setup claude
```

## Manual Test Checklist

1. ✅ Start Scene Sync in browser
2. ✅ Press "AIにリンク" and note the code
3. ✅ Register MCP in Codex: `npx -y @afjk/scene-sync-mcp@latest setup codex`
4. ✅ Or print Claude Desktop config: `npx -y @afjk/scene-sync-mcp@latest setup claude`
5. ✅ Tell Claude or Codex: "Scene Sync に [コード] でリンク"
6. ✅ Ask: "オレンジ色の箱を中央に置いて"
7. ✅ Confirm box appears in browser
8. ✅ Ask: "その箱にカメラをフォーカス"
9. ✅ Confirm camera focuses on box
10. ✅ Ask: "スクリーンショットを撮ってください"
11. ✅ Ask: "リンクを解除"
12. ✅ Verify `scene_sync_status` returns "Not linked"

## License

Part of afjk.jp. See repository for license details.
