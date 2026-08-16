# Open in Scene Sync handoff protocol

Portable Single HTML exports and published Static exports include an **Open in
Scene Sync** control. Static handoff always tries the browser's direct,
credential-free CORS fetch first. Publishers should therefore allow
cross-origin `GET` for the viewer page, `scene.json`, and every referenced
asset. When the browser receives an opaque fetch `TypeError` (the normal CORS
or network failure shape), Scene Sync can use its same-origin server-pull
fallback. HTTP errors, malformed documents, unsafe paths, and size-limit
failures do not use that fallback.

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

The source keeps a URL-handoff ACK window of at least 13 minutes. The target
uses a 10 minute import deadline after room setup; timeout aborts pending
publisher fetches and Scene Sync blob/GLB uploads, and no later mutation is
accepted.

Scene Sync rejects replayed/cross-session messages, non-JSON structured-clone
values, invalid transforms, unsafe asset paths, malformed Base64, and payloads
over the Single HTML import limits. The target accepts external origins only
for a page explicitly opened with valid handoff IDs and binds the exchange to
its `window.opener`. ACKs contain the matching IDs and status, but never room or
scene data.

## Viewer control layout

An exported page is mostly there to be *looked at*: opening it in Scene Sync is
the secondary path taken to keep editing the scene or to view it in a headset.
The control is therefore a collapsed pill, not a standing panel.

`mountSingleHtmlHandoff` / `mountUrlHandoff` append a
`.scene-sync-handoff-dock` to `#viewer-controls` when the viewer has that
button stack, falling back to `#viewer-ui`. The dock holds
`#scene-sync-handoff-toggle` and the `#scene-sync-handoff` form, which starts
with the `hidden` attribute set and expands as a popover anchored under the
toggle. It closes on the toggle, on `Escape`, and on a pointer press outside
the dock — but never while a handoff is waiting on READY or ACK, so in-flight
status stays on screen.

Docking into `#viewer-controls` is what keeps the control off the
bottom-centered player transport, which spans nearly the full width on phones.
`order: 1` keeps the dock below Enter VR / BGM even though it mounts first.
Styling lives in `html/assets/js/scenesync/handoff/source.css`, which Static
ZIP `index.html` links and Single HTML inlines; it is self-contained and does
not depend on `viewer.css`.

## Static export integration contract

Publish `index.html` with `<link rel="scene-sync-export" href="./scene.json">`
(or an equivalent absolute/relative `href`). `scene.json` follows the normal
Scene Sync Export scene-document format and its relative `asset.path` values
are resolved relative to that JSON file. Scene Sync downloads and validates all
referenced image, video, text, GLB, and object-audio files before applying the
handoff import, then uploads them to its blob store; a completed import has no
runtime dependency on the publishing host. URL handoff deliberately skips BGM
and all other scene-level settings.

The fallback is not a general web proxy. It only accepts an HTTPS static page
marker, a `scene.json`, a directory, or `current.json`, validates the Scene
Sync schema before staging, and returns only the canonical scene document with
local blob references. Source URLs have no credentials and use default HTTPS
port 443; every DNS answer and redirect is checked for public global-unicast
addresses, redirects/assets stay on the original origin, and ZIP/Single HTML
URLs are rejected. Server-pulled assets are streamed to disk—not Base64 or a
browser `postMessage` upload—and passive MIME types only are accepted (HTML and
SVG are rejected). Blob responses use `nosniff` and a sandbox CSP.

The browser still uses `credentials: "omit"`. Handoff entry HTML, `scene.json`,
and `current.json` are limited to 10 MiB (advertised and streamed bytes), with
at most 2,048 assets, 128 MiB per asset, and 500 MiB per import. The server also
enforces a global staged/live-byte quota, disk-free-space check, request/idle
and ten-minute job deadlines, and short-lived one-use inspect/materialize job
tokens bound to the requester. `Content-Length` is checked but actual streamed
bytes are authoritative. HTTP failures, unsafe relative paths, duplicate
materialized paths, or a quota failure reject the import without applying it.
Absolute same-origin `asset.url` values are accepted without credentials;
credential-bearing or cross-origin asset URLs are rejected rather than copied
into a room.

URL handoff accepts only a static page marker, `scene.json`, a directory, or a
`current.json` resolver. It deliberately rejects direct ZIP and Single HTML
URLs: use drag-and-drop/manual import for ZIP and the embedded payload handoff
for Single HTML. Use immutable/versioned public URLs so a click has a stable meaning. Do not
depend on provider-specific APIs: any static host meeting the marker plus the
direct CORS contract—or, for its fallback path, the HTTPS/default-port,
same-origin, public-DNS, and passive-MIME rules above—works. A URL handoff is add-only, has no confirmation dialog, and
does not apply scene-level settings.

## Opener-free token fallback

The normal `window.open` + `postMessage` handoff remains the default. When a
wrapper/sandbox cannot return a usable opener, the user may explicitly choose
**Open using token transfer**. A 256-bit token and its session/request binding
are carried only in the target URL fragment, which the target immediately
stores for one read and removes from the address bar. The upload/claim API
keeps the token in JSON bodies only. Embedded Single HTML payloads allow at
most 32 MiB decoded assets and 8 MiB SceneDocument JSON; raw ZIP and raw Single
HTML URLs are not token payload kinds. Static exports transfer their published
HTTP(S) page URL and retain the existing strict static/server-pull loader.

### Compact inline fallback for CSP-constrained Single HTML

Some artifact hosts block cross-origin `connect-src`, so an explicit token
click uses a fragment-only inline handoff when an embedded payload is compact
enough. It never applies to Static URL handoff and never replaces the normal
opener fast path. Its fragment has exactly one field:

```
#sceneSyncHandoffInline=v1.<canonical-base64url-utf8-json>
```

The decoded envelope has exactly `kind`, `version`, `sessionId`, `requestId`,
`roomId`, and `payload`; `kind` is `scene-sync-inline-handoff`, version is 1,
and its payload is embedded-only. The envelope room must exactly match the
non-secret `room` query parameter (including both being absent). The target
stashes the bounded raw envelope, removes the fragment before module/network
work, then consumes it once per tab and applies the same strict add-only
validation and rollback path as a claimed token payload.

The fragment uses canonical Base64URL (no padding), fatal UTF-8, and strict
limits: sources conservatively create envelopes no larger than 128 KiB, while
the target rejects anything above 512 KiB encoded / 384 KiB decoded. Scene JSON
is at most 128 KiB, with at most 32 passive embedded assets, 64 KiB each and
128 KiB decoded total. Inline
handoff is intentionally tab-local rather than globally one-use: it cannot
contact a server, so it is read once from sessionStorage/global fallback and
is never mixed with a token fragment or opener transfer. Invalid, duplicate,
mixed, malformed, and oversized inline-looking fragments are scrubbed without
being applied. Larger Single HTML exports continue to use the token upload;
if that upload is CSP-blocked, the source directs the user to download/open it
in a regular tab.

## Server-pull deployment settings

The control plane is same-origin and sends no CORS headers. Keep the presence
port private behind the TLS reverse proxy. Configure the explicit (no wildcard)
browser origins in `SCENE_SYNC_SERVER_PULL_ALLOWED_ORIGINS`; set
`SCENE_SYNC_TRUST_REVERSE_PROXY=true` only when the reverse proxy supplies a
trusted client address. `SCENE_SYNC_SERVER_PULL_MAX_LIVE_BYTES` caps all live
and staged server-pull blobs (the compose default is 500 MiB), while
`SCENE_SYNC_SERVER_PULLS_PER_ACTOR_PER_MINUTE` bounds expensive inspections
(default 3). The compose
service binds port 8787 to `127.0.0.1` specifically so that the import-job API
is not publicly exposed.
