# Codex Task: P1 Bug Fixes for pipe file-sharing system

## Overview

Fix 4 bugs in `html/assets/js/pipe/app.js`.
All changes go in **one commit** on branch `genspark_ai_developer`.
Do **NOT** touch any other files. Do **NOT** refactor, rename, or restructure
anything outside the scope described below.

---

## Bug 1 — `pruneSwarmEntries` does not clean stale peer IDs from seeders sets

### Problem

When a peer disconnects, `pruneSwarmEntries()` is called (triggered by
the `peers` broadcast). It correctly **deletes entries** that have no
active seeder, but it does **not remove departed peer IDs** from the
`seeders` Set of entries that still have other active seeders.

Result: the seeders set accumulates stale IDs over time. The UI shows
seeders that are no longer online. If a user clicks "Download" and the
only real seeder has left but its ID is still in the set, the download
hangs silently.

### Where (app.js ≈ line 1532–1546)

Current code:

```js
function pruneSwarmEntries() {
  const activeIds = new Set(presenceState.peers.keys());
  if (presenceState.id) activeIds.add(presenceState.id);
  let changed = false;
  swarmState.entries.forEach((entry, key) => {
    if (entry.catalogOnly) return;
    const seeders = entry.seeders || new Set();
    const hasActiveSeeder = Array.from(seeders).some(id => activeIds.has(id));
    if (!hasActiveSeeder) {
      swarmState.entries.delete(key);
      changed = true;
    }
  });
  if (changed) renderSwarmList();
}
```

### Required fix

Before the `hasActiveSeeder` check, iterate over `seeders` and delete
any ID that is not in `activeIds`. This ensures stale IDs are cleaned
even when other active seeders remain.

Replace the entire function body with:

```js
function pruneSwarmEntries() {
  const activeIds = new Set(presenceState.peers.keys());
  if (presenceState.id) activeIds.add(presenceState.id);
  let changed = false;
  swarmState.entries.forEach((entry, key) => {
    if (entry.catalogOnly) return;
    const seeders = entry.seeders || new Set();
    // Remove departed peer IDs from the seeders set
    seeders.forEach(id => {
      if (!activeIds.has(id)) { seeders.delete(id); changed = true; }
    });
    if (!seeders.size) {
      swarmState.entries.delete(key);
      changed = true;
    }
  });
  if (changed) renderSwarmList();
}
```

---

## Bug 2 — `_wtPendingSignals` grows without bound (no TTL, no size cap)

### Problem

Signals are pushed to `_wtPendingSignals` in `handleWtSignal()` (lines
≈1746, 1753) and only drained when `receiveTorrent()` is called. If
signals arrive for a torrent that is never added (e.g. user ignores the
notification), they accumulate forever — a memory leak. Additionally,
old SDP offers contain ICE candidates with short TTLs; dispatching a
30+ second old signal will always fail the WebRTC connection.

### Where

Declaration (≈ line 1663):
```js
const _wtPendingSignals = [];        // { fromId, signal, infoHash }
```

Push sites (≈ lines 1746, 1753):
```js
    _wtPendingSignals.push({ fromId, signal, infoHash });
```

### Required fix

1. **Add a timestamp** to each pushed signal.
2. **Add a helper** that prunes signals older than 30 seconds and caps
   the array at 50 entries.
3. Call the helper before each push and at the start of the flush loop
   in `receiveTorrent`.

#### Step A — Change the declaration comment (line ≈1663)

```js
const _wtPendingSignals = [];        // { fromId, signal, infoHash, ts }
```

#### Step B — Add helper right after the declaration (after line ≈1668)

Insert:

```js
const WT_SIGNAL_TTL_MS = 30000;  // discard pending signals older than 30s
const WT_SIGNAL_MAX    = 50;     // keep at most 50 pending signals

function _pruneWtPendingSignals() {
  const now = Date.now();
  // Remove expired
  for (let i = _wtPendingSignals.length - 1; i >= 0; i--) {
    if (now - _wtPendingSignals[i].ts > WT_SIGNAL_TTL_MS) {
      _wtPendingSignals.splice(i, 1);
    }
  }
  // Cap size (drop oldest first)
  while (_wtPendingSignals.length > WT_SIGNAL_MAX) {
    _wtPendingSignals.shift();
  }
}
```

#### Step C — Update both push sites (≈ lines 1746 and 1753)

Change:
```js
    _wtPendingSignals.push({ fromId, signal, infoHash });
```

To (both occurrences):
```js
    _pruneWtPendingSignals();
    _wtPendingSignals.push({ fromId, signal, infoHash, ts: Date.now() });
```

#### Step D — Prune before flush in `receiveTorrent` (≈ line 2004)

The existing code is:
```js
  if (_wtPendingSignals.length) {
    logSwarm('flushing pending signals', { count: _wtPendingSignals.length, targetHash });
```

Change to:
```js
  _pruneWtPendingSignals();
  if (_wtPendingSignals.length) {
    logSwarm('flushing pending signals', { count: _wtPendingSignals.length, targetHash });
```

---

## Bug 3 — `seedFilesAsTorrent` destroys ALL active torrents

### Problem

When the user clicks "Share to Room", `seedFilesAsTorrent()` runs:

```js
  client.torrents.slice().forEach(t => { try { t.destroy(); } catch {} });
```

This destroys **every** torrent, including ones currently being
**received**. If a user is downloading a torrent and simultaneously
shares a new file, the in-progress download is silently killed.

### Where (app.js ≈ line 1812)

```js
  // Remove any previous torrent for same files before re-seeding
  client.torrents.slice().forEach(t => { try { t.destroy(); } catch {} });
```

### Required fix

Only destroy torrents that **we seeded** (their infoHash is tracked in
`_torrentSeedFiles`). Replace the line with:

```js
  // Remove only previously-seeded torrents (preserve torrents we are receiving)
  client.torrents.slice().forEach(t => {
    if (_torrentSeedFiles.has(t.infoHash)) { try { t.destroy(); } catch {} }
  });
  _torrentSeedFiles.clear();
```

Note: `_torrentSeedFiles.clear()` already exists later in `stopSeeding()`
(≈ line 1871). Adding it here is safe because we are about to re-seed,
and the new infoHash will be added in the callback on line ≈1820.

---

## Bug 4 — Debug `console.trace` calls left in production code

### Problem

Three `console.trace('[dbg]...')` calls remain in `triggerTorrentDownloads()`.
`console.trace` prints a full stack trace to the console on every torrent
file download, hurting performance and cluttering user-facing devtools.

### Where (app.js ≈ lines 2031, 2037, 2040)

```js
function triggerTorrentDownloads(torrent) {
  console.trace('[dbg]call triggerTorrentDownloads') 
  
  if (!torrent?.files) return;
  torrent.files.forEach(file => {
    if (!file) return;
    if (typeof file.blob === 'function') {
      console.trace('[dbg]call triggerTorrentDownloads file.blob') 
      file.blob().then(blob => triggerDownload(blob, file.name)).catch(() => {});
    } else if (typeof file.getBlob === 'function') {
      console.trace('[dbg]call triggerTorrentDownloads file.getBlob') 
      file.getBlob((err, blob) => { if (!err) triggerDownload(blob, file.name); });
    }
  });
}
```

### Required fix

Delete all three `console.trace(...)` lines and the blank line after the
first one. The result should be:

```js
function triggerTorrentDownloads(torrent) {
  if (!torrent?.files) return;
  torrent.files.forEach(file => {
    if (!file) return;
    if (typeof file.blob === 'function') {
      file.blob().then(blob => triggerDownload(blob, file.name)).catch(() => {});
    } else if (typeof file.getBlob === 'function') {
      file.getBlob((err, blob) => { if (!err) triggerDownload(blob, file.name); });
    }
  });
}
```

---

## Verification checklist

After making all 4 changes, verify:

- [ ] `pruneSwarmEntries()` iterates seeders and deletes IDs not in
      `activeIds` before checking whether to remove the entry.
- [ ] `_pruneWtPendingSignals` function exists and is called before each
      `.push()` on `_wtPendingSignals` and before the flush loop in
      `receiveTorrent`.
- [ ] Every push to `_wtPendingSignals` includes a `ts: Date.now()` field.
- [ ] In `seedFilesAsTorrent()`, the torrent destruction loop only destroys
      torrents whose `infoHash` is in `_torrentSeedFiles`, followed by
      `_torrentSeedFiles.clear()`.
- [ ] `triggerTorrentDownloads()` contains zero `console.trace` calls.
- [ ] No other lines have been modified.
- [ ] The code runs without syntax errors.

## Commit

```
fix(pipe): P1 fixes — prune stale seeders, pending signal TTL, safe torrent destroy, remove debug traces

1. pruneSwarmEntries: remove departed peer IDs from each entry's seeders
   set, not just delete entries with zero active seeders.

2. _wtPendingSignals: add timestamp to queued signals, prune entries
   older than 30s and cap at 50 before each push and before flush.

3. seedFilesAsTorrent: only destroy previously-seeded torrents (tracked
   in _torrentSeedFiles) instead of all active torrents, preventing
   in-progress downloads from being killed.

4. triggerTorrentDownloads: remove 3 leftover console.trace debug calls.
```
