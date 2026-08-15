# Open in Scene Sync handoff protocol

Portable Single HTML exports include an **Open in Scene Sync** control. Other
web pages can use the same `postMessage` protocol without making a CORS fetch
to the source page.

1. In a user gesture, open `https://afjk.jp/scenesync/?handoff=1`. Add a
   sanitized `room` query parameter (`[a-z0-9-]`, at most 24 characters) when
   the import must join a particular room. Keep the returned `WindowProxy`.
2. Accept `{ "type": "scene-sync-ready", "version": 1 }` only when its
   `source` is that `WindowProxy` and its `origin` is the Scene Sync origin.
3. Reply to the opened window with the message below, using the Scene Sync
   origin as `targetOrigin`.
4. Accept an ACK only with the same source/origin checks. A successful ACK is
   `{ "type": "scene-sync-handoff-ack", "version": 1, "status": "ok" }`.

```js
{
  type: 'scene-sync-handoff',
  version: 1,
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

Only `mode: "add"` is supported. Scene Sync rejects invalid protocol versions,
room IDs, SceneDocuments, unsafe asset paths, malformed Base64, and payloads
over the Single HTML import limits. The target accepts external origins only
for a page explicitly opened in `handoff=1` mode and binds the exchange to its
`window.opener`. ACKs never include room or scene data.
