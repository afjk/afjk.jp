# Open in Scene Sync handoff protocol

Portable Single HTML exports and published Static exports include an **Open in
Scene Sync** control. Static handoff fetches the export from Scene Sync, so the
publisher must allow cross-origin `GET` for the viewer page, `scene.json`, and
every referenced asset.

1. Generate cryptographically random `sessionId` and `requestId` values with at
   least 128 bits of entropy, encoded as 22–128 URL-safe characters
   (`A-Z`, `a-z`, `0-9`, `_`, `-`). The built-in exporter uses 32 lowercase
   hexadecimal characters. In a user gesture, open
   `https://afjk.jp/scenesync/?handoff=1&handoffSession=...&handoffRequest=...`.
   Add a sanitized `room` query parameter (`[a-z0-9-]`, at most 24 characters)
   when the import must join a particular room. Keep the returned `WindowProxy`.
2. Accept `{ "type": "scene-sync-ready", "version": 1, sessionId, requestId }`
   only when its IDs match, its `source` is that `WindowProxy`, and its `origin`
   is the Scene Sync origin.
3. Reply to the opened window with the message below, using the Scene Sync
   origin as `targetOrigin`.
4. Accept an ACK only with the same source/origin/ID checks. A successful ACK
   has type `scene-sync-handoff-ack`, version `1`, the matching `sessionId` and
   `requestId`, and status `ok`.

```js
{
  type: 'scene-sync-handoff',
  version: 1,
  sessionId,
  requestId,
  mode: 'add',
  roomId: 'optional-room',
  sceneDocument,
  embeddedAssets: {
    'assets/model.glb': {
      mime: 'model/gltf-binary',
      base64: '...'
    }
  }
}
```

Static hosts send this mutually exclusive, smaller payload instead. `sourceUrl`
must be an absolute `http:` or `https:` URL without URL credentials; it is
fetched with `credentials: "omit"`.

```js
{ type: 'scene-sync-handoff', version: 1, sessionId, requestId,
  mode: 'add', roomId: 'optional-room', sourceUrl: 'https://host.example/world/v3/' }
```

Only `mode: "add"` is supported. The `room` in the opened URL is authoritative;
an omitted message `roomId` uses it, while a different message `roomId` is
rejected. Add mode rejects duplicate incoming object IDs and IDs already in the
room. It adds objects and their per-object assets/physics only; it does not
change environment, BGM, global physics, or scene behaviors.

Scene Sync rejects replayed/cross-session messages, non-JSON structured-clone
values, invalid transforms, unsafe asset paths, malformed Base64, and payloads
over the Single HTML import limits. The target accepts external origins only
for a page explicitly opened with valid handoff IDs and binds the exchange to
its `window.opener`. ACKs contain the matching IDs and status, but never room or
scene data.

## Static export integration contract

Publish `index.html` with `<link rel="scene-sync-export" href="./scene.json">`
(or an equivalent absolute/relative `href`). `scene.json` follows the normal
Scene Sync Export scene-document format and its relative `asset.path` values
are resolved relative to that JSON file. Scene Sync downloads and validates all
referenced image, video, text, GLB, object-audio, and BGM files before applying
the import, then uploads them to its blob store; a completed import has no
runtime dependency on the publishing host.

Hosts need CORS for the page, marker JSON, and every asset. HTTP errors, CORS
failures, unsafe relative paths, duplicate materialized paths, more than 2,048
assets, an asset over 128 MiB, or more than 500 MiB total reject the import
without applying it. `Content-Length` is checked but actual streamed bytes are
authoritative. Absolute `asset.url` is also fetched only without credentials;
credential-bearing URLs are rejected rather than copied into a room.

Use immutable/versioned public URLs so a click has a stable meaning. Do not
depend on provider-specific APIs: any static host meeting the marker and CORS
requirements works. A URL handoff is add-only, has no confirmation dialog, and
does not apply scene-level settings.
