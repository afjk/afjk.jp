# Codex Task: P0 Bug Fixes for pipe file-sharing system

## Overview

Fix 3 critical bugs in `html/assets/js/pipe/app.js`.
All changes go in **one commit** on branch `genspark_ai_developer`.
Do **NOT** touch any other files. Do **NOT** refactor, rename, or restructure.
Apply the same changes to `afjk.jp/html/assets/js/pipe/app.js` (it is an identical copy).

---

## Bug 1 — WebSocket reconnection gives up after 3 retries

### Problem

In `connectPresence()`, the `close` event handler stops retrying after
`presenceState.retries > 3` and shows "unavailable". Network hiccups
(sleep/wake, Wi-Fi switch) kill the WebSocket, and after 4 failures the
app never reconnects — breaking all presence-based features permanently.

### Where (app.js ≈ line 800–816)

```js
  ws.addEventListener('close', () => {
    if (presenceState.ws !== ws) return;
    presenceState.ws = null;
    presenceState.id = null;
    presenceState.retries += 1;
    if (presenceState.reconnectTimer) clearTimeout(presenceState.reconnectTimer);
    if (presenceState.retries <= 3) {
      presenceStatusEl.textContent = t('presenceReconnecting');
      const delay = Math.min(3000 * Math.pow(2, presenceState.retries - 1), 30000);
      presenceState.reconnectTimer = setTimeout(connectPresence, delay);
    } else {
      presenceStatusEl.textContent = t('presenceUnavailable');
    }
  });
  ws.addEventListener('error', () => {});
}
```

### Required fix

1. **Remove the `retries <= 3` cap.** Always schedule a reconnect.
   Use exponential backoff capped at 60 seconds:
   `Math.min(3000 * Math.pow(1.5, presenceState.retries - 1), 60000)`.
2. **Add `visibilitychange` and `online` event listeners** (register once,
   outside `connectPresence`). When the page becomes visible again or
   the browser goes online, if `presenceState.ws` is null (disconnected),
   reset `presenceState.retries` to 0 and call `connectPresence()`.

### Expected result after fix (≈ line 800–816 replacement)

```js
  ws.addEventListener('close', () => {
    if (presenceState.ws !== ws) return;
    presenceState.ws = null;
    presenceState.id = null;
    presenceState.retries += 1;
    if (presenceState.reconnectTimer) clearTimeout(presenceState.reconnectTimer);
    presenceStatusEl.textContent = t('presenceReconnecting');
    const delay = Math.min(3000 * Math.pow(1.5, presenceState.retries - 1), 60000);
    presenceState.reconnectTimer = setTimeout(connectPresence, delay);
  });
  ws.addEventListener('error', () => {});
}
```

And add the following **once**, right after the closing `}` of
`connectPresence()` (i.e. after the function definition, NOT inside it):

```js
// Reconnect presence when the tab becomes visible or the browser comes back online
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !presenceState.ws) {
    presenceState.retries = 0;
    connectPresence();
  }
});
window.addEventListener('online', () => {
  if (!presenceState.ws) {
    presenceState.retries = 0;
    connectPresence();
  }
});
```

---

## Bug 2 — `fileNames` sent as comma-separated string but expected as array

### Problem

In `seedFilesAsTorrent()`, the torrent handoff payload sends `fileNames`
as a **comma-joined string**:

```js
const fileNames = files.map(f => f.name).join(', ');
```

But `normalizeSwarmEntry()` expects `fileNames` to be an **array**:

```js
const fileNames = Array.isArray(rawEntry.fileNames) ? rawEntry.fileNames.slice(0, 5) : [];
```

Result: the swarm list on receivers shows no file names (empty array).

Note: `publishLocalSwarmEntry()` (≈ line 1615) already sends an array
correctly — this bug is only in the handoff payload inside the
`client.seed()` callback.

### Where (app.js ≈ line 1826)

```js
      const fileNames = files.map(f => f.name).join(', ');
```

### Required fix

Change to an array (no `.join()`):

```js
      const fileNames = files.map(f => f.name);
```

That is the only change for this bug. Everything downstream already
handles arrays.

---

## Bug 3 — `catalogOnly` merge uses `||` instead of `&&`

### Problem

In `addSwarmEntry()`, when merging with an existing entry:

```js
existing.catalogOnly = Boolean(existing.catalogOnly || entry.catalogOnly);
```

The `||` means once an entry is `catalogOnly: true` it **stays true**
even when an active seeder notifies with `catalogOnly: false`.
This prevents the "Download" button from working correctly — it still
shows "Catalog only" even though a live seeder is available.

The correct logic: an entry should only be `catalogOnly` when **both**
the existing and the incoming entry are catalog-only.

### Where (app.js ≈ line 1279)

```js
    existing.catalogOnly = Boolean(existing.catalogOnly || entry.catalogOnly);
```

### Required fix

Change `||` to `&&`:

```js
    existing.catalogOnly = Boolean(existing.catalogOnly && entry.catalogOnly);
```

---

## Verification checklist

After making all 3 changes, verify:

- [ ] `connectPresence()` no longer has a `retries <= 3` condition;
      the close handler always schedules a reconnect.
- [ ] `visibilitychange` and `online` listeners exist exactly once,
      outside `connectPresence()`, after its function definition.
- [ ] In `seedFilesAsTorrent()`, the `fileNames` variable assigned inside
      the `client.seed()` callback is an array (`files.map(f => f.name)`),
      NOT a string with `.join(', ')`.
- [ ] In `addSwarmEntry()`, the `catalogOnly` merge line uses `&&`, not `||`.
- [ ] Both `html/assets/js/pipe/app.js` and
      `afjk.jp/html/assets/js/pipe/app.js` contain identical changes.
- [ ] No other lines have been modified.
- [ ] The code runs without syntax errors (no missing semicolons, brackets, etc.).

## Commit

```
fix(pipe): critical P0 fixes — WS reconnect, fileNames type, catalogOnly merge

1. WebSocket reconnection: remove 3-retry cap; always retry with
   exponential backoff (max 60s). Add visibilitychange/online listeners
   for immediate reconnect on tab focus or network recovery.

2. seedFilesAsTorrent: send fileNames as array instead of comma-joined
   string so normalizeSwarmEntry() can parse it correctly and display
   file names in the swarm list.

3. addSwarmEntry: change catalogOnly merge from || to && so that an
   active seeder notification (catalogOnly:false) correctly clears the
   catalog-only flag on existing entries.
```
