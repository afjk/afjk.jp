# Codex Task: P3 Enhancements for pipe file-sharing system

## Overview

Implement 4 enhancements in `html/assets/js/pipe/app.js`.
All changes go in **one commit** on branch `genspark_ai_developer`.
Do **NOT** touch any other files.

These are larger feature enhancements. Each item is self-contained and
should not break existing functionality. Preserve all existing behavior
unless the item explicitly says otherwise.

---

## Item 1 — Swarm entry TTL (auto-expiration)

### Problem

Swarm entries (`swarmState.entries`) persist indefinitely in memory.
Entries from long-disconnected peers or with `catalogOnly: true` from
stale IndexedDB data accumulate over time, cluttering the swarm list.

### Required changes

#### 1a — Add constants (near existing swarm constants, after ≈ line 412)

Insert after the `swarmState` declaration:

```js
const SWARM_ENTRY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SWARM_PRUNE_INTERVAL_MS = 5 * 60 * 1000;   // run every 5 minutes
```

#### 1b — Add TTL-based pruning function

Insert right after `pruneSwarmEntries()` (which handles peer-based
pruning):

```js
function pruneExpiredSwarmEntries() {
  const now = Date.now();
  let changed = false;
  swarmState.entries.forEach((entry, key) => {
    // Never expire entries we are actively seeding
    if (entry.seeders?.has(presenceState.id)) return;
    const age = now - (entry.createdAt || 0);
    if (age > SWARM_ENTRY_TTL_MS) {
      swarmState.entries.delete(key);
      changed = true;
    }
  });
  if (changed) renderSwarmList();
}
```

#### 1c — Start the interval timer

Insert near the bottom of the file, just before the
`Object.assign(window, { ... })` block (≈ line 4158):

```js
setInterval(pruneExpiredSwarmEntries, SWARM_PRUNE_INTERVAL_MS);
```

---

## Item 2 — Transfer resume support for WebRTC P2P

### Problem

When a WebRTC connection drops mid-transfer, the entire file must be
re-sent from the beginning. For large files on unstable connections
this is painful.

### Design

Add an optional `resumeOffset` field to the P2P `meta` message. The
receiver can reply with a `resume` message indicating how many bytes it
has already received for that file. The sender skips ahead to that
offset.

This is fully **backward-compatible**: a receiver that does not
understand `resume` will never send it, and the sender will start from
offset 0 (current behavior). A sender that does not include
`resumeOffset` in `meta` will be handled normally by old receivers.

### Required changes

#### 2a — Sender: handle resume in `trySendWebRTCFiles` (≈ line 3938–3978)

Current per-file loop body starts with:

```js
    for (let i = 0; i < fileEntries.length; i++) {
      const { file } = fileEntries[i];
      const mime  = file.type || 'application/octet-stream';
      const total = file.size;

      dc.send(JSON.stringify({ t: 'meta', name: file.name, mime, size: total, index: i, count: fileEntries.length }));

      let fileSent = 0;
```

Replace with:

```js
    for (let i = 0; i < fileEntries.length; i++) {
      const { file } = fileEntries[i];
      const mime  = file.type || 'application/octet-stream';
      const total = file.size;

      dc.send(JSON.stringify({ t: 'meta', name: file.name, mime, size: total, index: i, count: fileEntries.length, resumable: true }));

      // Wait briefly for a resume message from the receiver
      let resumeOffset = 0;
      try {
        resumeOffset = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(0), 500);
          const handler = (e) => {
            if (typeof e.data === 'string') {
              try {
                const msg = JSON.parse(e.data);
                if (msg.t === 'resume' && msg.index === i) {
                  clearTimeout(timer);
                  dc.removeEventListener('message', handler);
                  resolve(msg.offset || 0);
                }
              } catch {}
            }
          };
          dc.addEventListener('message', handler);
        });
      } catch { resumeOffset = 0; }

      let fileSent = resumeOffset;
```

Then, in the stream reader loop that follows, skip bytes up to
`resumeOffset`. After the existing `const reader = file.stream().getReader();`
block (≈ line 3966), replace:

```js
      const reader = file.stream().getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          await feed(value);
        }
      } finally {
        reader.releaseLock?.();
      }
```

With:

```js
      const reader = file.stream().getReader();
      let skipped = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (skipped < resumeOffset) {
            const remaining = resumeOffset - skipped;
            skipped += value.byteLength;
            if (value.byteLength <= remaining) continue; // skip entire chunk
            // Partial skip: send only the tail of this chunk
            await feed(value.subarray(remaining));
          } else {
            await feed(value);
          }
        }
      } finally {
        reader.releaseLock?.();
      }
```

#### 2b — Receiver: send resume message in `tryRecvWebRTC` (≈ line 4018)

In the `meta` handler, after resetting state, check if we have partial
data from a previous attempt. If so, send a `resume` message.

Current:
```js
          if (msg.t === 'meta') {
            meta   = msg;
            chunks = []; recvd = 0; t0 = null;
            isMulti = (msg.count > 1);
            onStatus(t('p2pReceiving')(meta.name));
```

Replace with:
```js
          if (msg.t === 'meta') {
            // If we have leftover chunks from a previous attempt for
            // the same file name + index, keep them for resume
            if (meta && meta.name === msg.name && meta.index === msg.index && recvd > 0 && msg.resumable) {
              // Send resume offset to sender
              dc.send(JSON.stringify({ t: 'resume', index: msg.index, offset: recvd }));
            } else {
              chunks = []; recvd = 0;
            }
            meta = msg;
            t0 = null;
            isMulti = (msg.count > 1);
            onStatus(t('p2pReceiving')(meta.name));
```

---

## Item 3 — Multi-source download via `swarm-who-seeds` query

### Problem

When downloading from the swarm list, the current code connects to
known seeders sequentially via `requestSwarmPeerConnection`. If the
entry's `seeders` set is stale or incomplete, peers that received and
re-seeded the torrent are missed.

### Design

Add a `swarm-who-seeds` handoff message: the downloader broadcasts it
to all room peers with the `infoHash`. Any peer that has that infoHash
(in `localSeedInfoHashes` or `localCatalog`) responds with
`swarm-i-seed`. The downloader then sends `swarm-join` to all
responders in parallel.

### Required changes

#### 3a — Add handler for `swarm-who-seeds` in `handleIncomingHandoff` 

Insert after the existing `swarm-seeder` handler block (after ≈ line
2124):

```js
  if (payload.kind === 'swarm-who-seeds') {
    const queryHash = payload.infoHash;
    if (!queryHash) return;
    const isSeed = localSeedInfoHashes.has(queryHash) || localCatalog.has(queryHash);
    if (isSeed && msg.from?.id) {
      sendSwarmMessage(msg.from.id, { kind: 'swarm-i-seed', infoHash: queryHash });
    }
    return;
  }
```

#### 3b — Add handler for `swarm-i-seed` in `handleIncomingHandoff`

Insert right after the block added in 3a:

```js
  if (payload.kind === 'swarm-i-seed') {
    const hash = payload.infoHash;
    const seederId = msg.from?.id;
    if (!hash || !seederId) return;
    // Update swarm entry seeders
    const entry = findSwarmEntryByInfoHash(hash);
    if (entry) {
      entry.seeders = entry.seeders || new Set();
      entry.seeders.add(seederId);
      entry.catalogOnly = false;
      renderSwarmList();
    }
    // If we have a pending torrent for this hash, connect to this seeder
    const torrent = findTorrentByInfoHash(hash);
    if (torrent && !torrent.destroyed) {
      const peer = presenceState.peers.get(seederId) || { id: seederId };
      _wtConnectRoomPeers(torrent, [peer]);
    }
    return;
  }
```

#### 3c — Broadcast `swarm-who-seeds` at download time

In `requestSwarmPeerConnection` (≈ line 1421), after the existing
`swarm-join` broadcast, add a `swarm-who-seeds` broadcast:

Current function:
```js
function requestSwarmPeerConnection(entry) {
  const infoHash = entry?.infoHash || extractInfoHash(entry?.magnetURI);
  if (!infoHash) {
    logSwarm('requestSwarmPeerConnection skipped — missing infoHash');
    return;
  }
  const targets = new Set();
  if (entry.senderId && entry.senderId !== presenceState.id) targets.add(entry.senderId);
  presenceState.peers.forEach((_, peerId) => {
    if (peerId && peerId !== presenceState.id) targets.add(peerId);
  });
  if (!targets.size) {
    logSwarm('requestSwarmPeerConnection no peers to notify');
    return;
  }
  logSwarm('requestSwarmPeerConnection broadcast', { infoHash, targets: Array.from(targets) });
  targets.forEach(peerId => {
    sendSwarmMessage(peerId, { kind: 'swarm-join', magnetURI: entry.magnetURI, infoHash });
  });
}
```

Replace with:
```js
function requestSwarmPeerConnection(entry) {
  const infoHash = entry?.infoHash || extractInfoHash(entry?.magnetURI);
  if (!infoHash) {
    logSwarm('requestSwarmPeerConnection skipped — missing infoHash');
    return;
  }
  const targets = new Set();
  if (entry.senderId && entry.senderId !== presenceState.id) targets.add(entry.senderId);
  presenceState.peers.forEach((_, peerId) => {
    if (peerId && peerId !== presenceState.id) targets.add(peerId);
  });
  if (!targets.size) {
    logSwarm('requestSwarmPeerConnection no peers to notify');
    return;
  }
  logSwarm('requestSwarmPeerConnection broadcast', { infoHash, targets: Array.from(targets) });
  targets.forEach(peerId => {
    sendSwarmMessage(peerId, { kind: 'swarm-join', magnetURI: entry.magnetURI, infoHash });
  });
  // Also discover additional seeders we may not know about
  presenceState.peers.forEach((_, peerId) => {
    if (peerId !== presenceState.id) {
      sendSwarmMessage(peerId, { kind: 'swarm-who-seeds', infoHash });
    }
  });
}
```

---

## Item 4 — Module split preparation: extract section markers and shared state

### Problem

`app.js` is 4181 lines in a single file, making it hard to maintain.
A full module split is too large for a single task, but we can prepare
by extracting the largest self-contained section into its own module.

### Scope

Extract the **WebTorrent / Swarm** logic into a new file
`html/assets/js/pipe/swarm.js`. This covers:

- `// ── Swarm catalog storage` (lines ≈423–519)
- `// ── WebTorrent (swarm)` (lines ≈1199–1215)
- `// ── Swarm (room torrent list)` (lines ≈1226–1640)
- `// ── Presence-based direct peer signaling` (lines ≈1659–2044)

### Required changes

#### 4a — Create `html/assets/js/pipe/swarm.js`

Create a new file. Move the following into it:

1. The swarm IDB constants and functions:
   `SWARM_IDB_NAME`, `SWARM_IDB_STORE`, `SWARM_IDB_VERSION`,
   `_swarmDb`, `_swarmCatalogLoaded`, `_swarmCatalogAnnouncedForId`,
   `openSwarmDb`, `swarmIDBPut`, `swarmIDBGetAll`, `swarmIDBGet`,
   `swarmIDBDelete`, `loadLocalSwarmCatalog`, `announceCatalogEntriesOnce`

2. The swarm list and entry management functions:
   `requestSwarmSyncFromPeers`, `sendSwarmMessage`,
   `broadcastSwarmPublish`, `sendSwarmSync`, `normalizeSwarmEntry`,
   `addSwarmEntry`, `removeSwarmEntry`, `persistLocalArchive`,
   `seedStoredEntry`, `collectFilesFromTorrent`, `removeLocalArchive`,
   `requestSwarmPeerConnection`, `swarmEntryLabel`, `renderSwarmList`,
   `pruneSwarmEntries`, `pruneExpiredSwarmEntries` (if Item 1 is done),
   `updateEntrySeeder`, `announceSeeder`,
   `registerLocalSeederInfoHash`, `unregisterLocalSeederInfoHash`,
   `unregisterAllLocalSeeders`, `updateLocalSwarmOwner`,
   `publishLocalSwarmEntry`, `findSwarmEntryByInfoHash`,
   `findTorrentByInfoHash`, `getWtClient`

3. The WebTorrent peer signaling:
   `_wtPendingPeers`, `_wtPendingSignals`, `_torrentSeedFiles`,
   `_wtApprovedDownloads`, `_wtCompletedTorrents`, `_wtPendingFallbacks`,
   `torrentApprovalKey`, `approveTorrentDownloadKey`,
   `_wtConnectRoomPeers`, `_wtHandleOffer`, `handleWtSignal`,
   `hideMagnetInfo`, `showMagnetInfo`, `updateMagnetStats`,
   `seedFilesAsTorrent`, `stopSeeding`, `receiveTorrent`,
   `triggerTorrentDownloads`, `startFallbackDownload`

4. Shared state it needs from app.js — import via function parameters
   or a shared context object. At the top of `swarm.js`:

```js
// Shared dependencies injected from app.js
let _ctx = null;

export function initSwarmModule(ctx) {
  _ctx = ctx;
}
```

Where `ctx` is an object providing:
`{ presenceState, swarmState, localSeedInfoHashes, localCatalog,
  deviceName, t, fmt, logSwarm, setStatus, switchTab, setRecvSender,
  escHtml, extractInfoHash, base32ToHex, randPath, fetchIceServers,
  loadWebTorrent, loadSimplePeer, PIPE, reportTransfer, renderSwarmList }`

**Note**: `renderSwarmList` references DOM elements. It stays in
`swarm.js` as an export but also needs the `t()` function.

5. At the bottom of `swarm.js`, export all functions that `app.js`
   needs to call:

```js
export {
  loadLocalSwarmCatalog,
  announceCatalogEntriesOnce,
  requestSwarmSyncFromPeers,
  pruneSwarmEntries,
  addSwarmEntry,
  renderSwarmList,
  publishLocalSwarmEntry,
  updateLocalSwarmOwner,
  seedFilesAsTorrent,
  stopSeeding,
  receiveTorrent,
  handleWtSignal,
  startFallbackDownload,
  unregisterAllLocalSeeders,
  // ... any other functions called from app.js
};
```

#### 4b — Update `app.js`

At the top of `app.js`, add:

```js
import { initSwarmModule, loadLocalSwarmCatalog, announceCatalogEntriesOnce,
  requestSwarmSyncFromPeers, pruneSwarmEntries, addSwarmEntry,
  renderSwarmList, publishLocalSwarmEntry, updateLocalSwarmOwner,
  seedFilesAsTorrent, stopSeeding, receiveTorrent, handleWtSignal,
  startFallbackDownload, unregisterAllLocalSeeders
} from './swarm.js';
```

Remove the moved code blocks from `app.js`.

In the initialization section (near `initPresenceWithDb` or
`languageManager.init()`), call:

```js
initSwarmModule({
  presenceState, swarmState, localSeedInfoHashes, localCatalog,
  deviceName, t, fmt, logSwarm, setStatus, switchTab, setRecvSender,
  escHtml, extractInfoHash, base32ToHex, randPath, fetchIceServers,
  loadWebTorrent, loadSimplePeer, PIPE, reportTransfer,
});
```

#### Important constraints for Item 4

- **Both files must work together without errors.**
- **The `swarm.js` module must use ES module syntax** (`export` /
  `import`).
- `app.js` is already loaded as `type="module"` in `index.html`,
  so `import` statements will work.
- If a circular dependency appears (e.g. `swarm.js` needs a function
  from `app.js` that also needs `swarm.js`), resolve it by passing
  the function via the `ctx` object in `initSwarmModule`.
- Do **not** break the `Object.assign(window, { ... })` block at the
  bottom of `app.js`. Functions that are referenced from HTML `onclick`
  handlers must remain on `window`.

---

## Verification checklist

- [ ] `SWARM_ENTRY_TTL_MS` (24h) and `SWARM_PRUNE_INTERVAL_MS` (5min)
      constants exist.
- [ ] `pruneExpiredSwarmEntries` function exists and is called by
      `setInterval`.
- [ ] Entries the local user is actively seeding are never expired.
- [ ] In `trySendWebRTCFiles`, the `meta` message includes
      `resumable: true`.
- [ ] Sender listens for a `resume` message (500ms timeout) and skips
      bytes accordingly.
- [ ] Receiver sends `{ t: 'resume', index, offset }` when it has
      partial data and `msg.resumable` is true.
- [ ] `swarm-who-seeds` handler exists in `handleIncomingHandoff`.
- [ ] `swarm-i-seed` handler exists and connects the new seeder to
      an in-progress torrent.
- [ ] `requestSwarmPeerConnection` broadcasts `swarm-who-seeds` to all
      room peers.
- [ ] `html/assets/js/pipe/swarm.js` exists as an ES module.
- [ ] `app.js` imports from `./swarm.js` and calls `initSwarmModule`.
- [ ] All functions referenced from HTML `onclick` handlers remain on
      `window` via `Object.assign(window, { ... })`.
- [ ] No syntax errors in either file.
- [ ] The page loads and operates correctly (presence, send, receive,
      swarm list all functional).

## Commit

```
feat(pipe): P3 enhancements — swarm TTL, transfer resume, multi-source discovery, module split

1. Swarm entry TTL: auto-expire swarm entries older than 24 hours
   (except entries actively seeded by the local user). Pruning runs
   every 5 minutes.

2. Transfer resume: add resumable flag to WebRTC meta messages. Receiver
   replies with resume offset for partial data. Sender skips ahead.
   Fully backward-compatible with older clients.

3. Multi-source download: add swarm-who-seeds / swarm-i-seed handoff
   messages so the downloader discovers all available seeders in the
   room, not just the ones listed in the entry's seeders set.

4. Module split: extract WebTorrent/Swarm logic (~1000 lines) into
   html/assets/js/pipe/swarm.js. Shared state is injected via
   initSwarmModule(ctx). All HTML onclick handlers remain on window.
```
