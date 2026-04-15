# Codex Task: P2 Improvements for pipe file-sharing system

## Overview

Implement 5 improvements across two files:

- `html/assets/js/pipe/app.js` (client) — items 1, 2, 3
- `apps/presence-server/src/server.mjs` (server) — items 4, 5

All changes go in **one commit** on branch `genspark_ai_developer`.
Do **NOT** refactor, rename, or restructure anything outside the scope
described below.

---

## Item 1 — Torrent fallback: broadcast to all room peers when senderId is unknown

### Problem

In `receiveTorrent()`, the piping-server HTTP fallback timer is only set
when `senderId` is truthy (≈ line 1957):

```js
  if (senderId) {
    const _fallbackTimer = setTimeout(() => {
      if (torrent.done || torrent.destroyed || torrent.numPeers > 0) return;
      const basePath = Math.random().toString(36).slice(2, 10);
      presenceState.ws?.send(JSON.stringify({
        type: 'handoff', targetId: senderId,
        payload: { kind: 'torrent-piping-request', infoHash: torrent.infoHash, basePath },
      }));
      setStatus('recv-status', t('torrentFallback'), 'waiting');
    }, 30_000);
    torrent.on('wire',    () => clearTimeout(_fallbackTimer));
    torrent.on('done',    () => clearTimeout(_fallbackTimer));
    torrent.on('destroy', () => clearTimeout(_fallbackTimer));
  }
```

When the user clicks "Download" from the swarm list after the original
sender has reconnected (new peer ID), `senderId` may be `null` and the
fallback never triggers — the user waits forever.

### Required fix

Always set the fallback timer. When `senderId` is known, send the
request to that single peer. When `senderId` is null/undefined,
broadcast the `torrent-piping-request` to **all room peers** so that
whoever has the file can respond.

Replace the block (≈ lines 1957–1970) with:

```js
  // Piping-server fallback: if no peers connect within 30 s, request HTTP delivery
  {
    const _fallbackTimer = setTimeout(() => {
      if (torrent.done || torrent.destroyed || torrent.numPeers > 0) return;
      const basePath = Math.random().toString(36).slice(2, 10);
      const fallbackPayload = { kind: 'torrent-piping-request', infoHash: torrent.infoHash, basePath };
      if (senderId) {
        presenceState.ws?.send(JSON.stringify({
          type: 'handoff', targetId: senderId, payload: fallbackPayload,
        }));
      } else {
        // senderId unknown — broadcast to all room peers
        presenceState.peers.forEach((_, peerId) => {
          presenceState.ws?.send(JSON.stringify({
            type: 'handoff', targetId: peerId, payload: fallbackPayload,
          }));
        });
      }
      setStatus('recv-status', t('torrentFallback'), 'waiting');
    }, 30_000);
    torrent.on('wire',    () => clearTimeout(_fallbackTimer));
    torrent.on('done',    () => clearTimeout(_fallbackTimer));
    torrent.on('destroy', () => clearTimeout(_fallbackTimer));
  }
```

---

## Item 2 — Use `crypto.getRandomValues` for signaling path generation

### Problem

The `randPath` utility uses `Math.random()`, which is not
cryptographically secure. In rare cases (high concurrency, low entropy
environments) two clients can generate the same signaling path, causing
SDP cross-contamination and file misdelivery.

### Where (app.js ≈ line 638)

```js
const randPath = () => Math.random().toString(36).slice(2, 10);
```

### Required fix

Replace with a `crypto.getRandomValues`-based implementation:

```js
const randPath = () => {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
};
```

This produces a 12-character hex string (48 bits of entropy, vs ≈41 bits
from the original). The return value is still a plain string usable as a
URL path segment, so no callers need to change.

---

## Item 3 — SHA-256 checksum for WebRTC P2P file transfers

### Problem

WebRTC DataChannel (SCTP) provides transport-level reliability, but
application-layer bugs (buffer mismanagement, etc.) can cause silent
data corruption. There is no end-to-end integrity check.

### Required changes

#### 3a — Add a hash helper (insert near top of utilities, after `randPath`)

```js
async function hashBlob(blob) {
  const buf = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
```

#### 3b — Sender: include hash in `done` message

In `trySendWebRTCFiles()` (≈ line 3977), the current code is:

```js
      dc.send(JSON.stringify({ t: 'done' }));
      onFileDone(i);
```

Change to:

```js
      const fileHash = await hashBlob(file);
      dc.send(JSON.stringify({ t: 'done', sha256: fileHash }));
      onFileDone(i);
```

Also in `trySendWebRTC()` (the single-file variant), find the same
pattern (≈ there is a `dc.send(JSON.stringify({ t: 'done' }))` inside
`trySendWebRTC` as well). Apply the same change there. Search for all
occurrences of `{ t: 'done' }` sent via `dc.send` and add the hash.

**Note**: `trySendWebRTCFiles` has `file` available as `fileEntries[i].file`.
For `trySendWebRTC` (single-file), the body is the `body` parameter;
hash it with `hashBlob(body)`.

#### 3c — Receiver: verify hash on receipt

In `tryRecvWebRTC()` (≈ line 4023), the `done` handler is:

```js
          } else if (msg.t === 'done') {
            const elapsed = t0 ? (performance.now() - t0) / 1000 : 0;
            const speed   = elapsed > 0 ? recvd / elapsed : 0;
            const blob    = new Blob(chunks, { type: meta.mime });
            onDone(t('p2pRecvDone')(fmt(recvd), elapsed.toFixed(2), fmt(speed)), blob, meta.name);
            if (!isMulti) resolve();
```

Change to:

```js
          } else if (msg.t === 'done') {
            const elapsed = t0 ? (performance.now() - t0) / 1000 : 0;
            const speed   = elapsed > 0 ? recvd / elapsed : 0;
            const blob    = new Blob(chunks, { type: meta.mime });
            // Verify integrity if sender provided a hash
            if (msg.sha256) {
              hashBlob(blob).then(recvHash => {
                if (recvHash !== msg.sha256) {
                  console.warn('[p2p] checksum mismatch', { expected: msg.sha256, got: recvHash });
                }
              }).catch(() => {});
            }
            onDone(t('p2pRecvDone')(fmt(recvd), elapsed.toFixed(2), fmt(speed)), blob, meta.name);
            if (!isMulti) resolve();
```

The verification is **non-blocking** (`.then`) and **warn-only** for now.
It must NOT block the download or reject the file. This is intentional —
checksum failure logging enables diagnosis without breaking the user flow.

---

## Item 4 — WebSocket frame fragmentation support in presence-server

### Problem

In `apps/presence-server/src/server.mjs`, the `WsConnection.#handle()`
method ignores continuation frames (opcode `0x0`). Large messages
(>125 bytes per frame, e.g. SDP with many ICE candidates) may be
fragmented by the client. When this happens, the first frame (opcode
`0x1`, FIN=0) is processed as a complete message (truncated), and
subsequent continuation frames (opcode `0x0`) are silently dropped.

### Where (server.mjs ≈ lines 132–180)

The FIN bit is never checked:
```js
      const first = this.buffer[0];
      const opcode = first & 0x0f;
      // ... (FIN bit = first & 0x80 is never read)
```

And continuation frames are dropped:
```js
      if (opcode !== 0x1) continue; // text frames only
```

### Required fix

Add a fragment reassembly buffer to `WsConnection`. Track `_fragBufs`
(array of Buffers) and `_fragOpcode` (original opcode of the first
fragment). When FIN=0, accumulate payload into `_fragBufs`. When FIN=1
and opcode=0 (continuation), concatenate all fragments and process.

Replace the `#handle` method and add initialization in the constructor.

**Constructor change** — add after `this.alive = true;`:

```js
    this._fragBufs = [];
    this._fragOpcode = 0;
```

**Replace the `#handle` method** with:

```js
  #handle(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const isMasked = Boolean(this.buffer[1] & 0x80);
      let length = this.buffer[1] & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        length = Number(big);
        offset = 10;
      }

      const mask = isMasked ? this.buffer.slice(offset, offset + 4) : null;
      offset += isMasked ? 4 : 0;
      if (this.buffer.length < offset + length) return;

      let payload = this.buffer.slice(offset, offset + length);
      this.buffer = this.buffer.slice(offset + length);

      if (mask) payload = applyMask(payload, mask);

      // Control frames (close / ping / pong) — never fragmented
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) {
        this.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        continue;
      }
      if (opcode === 0xa) { this.alive = true; continue; }

      // Data frames — handle fragmentation
      if (opcode !== 0x0) {
        // First frame of a new message (text or binary)
        this._fragOpcode = opcode;
        this._fragBufs = [payload];
      } else {
        // Continuation frame
        this._fragBufs.push(payload);
      }

      if (fin) {
        const fullPayload = this._fragBufs.length === 1
          ? this._fragBufs[0]
          : Buffer.concat(this._fragBufs);
        this._fragBufs = [];
        // Only process text frames (opcode 0x1)
        if (this._fragOpcode === 0x1) {
          this.alive = true;
          const text = fullPayload.toString('utf8');
          this.onMessage && this.onMessage(text);
        }
      }
    }
  }
```

---

## Item 5 — Message size limit in presence-server

### Problem

The presence-server has no limit on incoming WebSocket message size. A
malicious or buggy client could send a multi-megabyte JSON payload and
exhaust server memory.

### Required fix

Add a `MAX_MESSAGE_SIZE` constant and check frame size in `#handle`.

#### 5a — Add constant after `WS_GUID` (server.mjs ≈ line 8)

```js
const MAX_MESSAGE_SIZE = 131072; // 128 KB max WebSocket message
```

#### 5b — Add size check in `#handle`

In the `#handle` method (after the `length` variable is fully resolved,
just before the mask line), add:

```js
      // Reject oversized messages
      if (length > MAX_MESSAGE_SIZE) {
        log('oversized frame', length, '- closing connection');
        this.close();
        return;
      }
```

This goes right **after** the 127-case block (after `offset = 10;` or
after `offset = 2;` for small frames), before `const mask = ...`.

Also, in the fragmentation reassembly (the `if (fin)` block added in
Item 4), add a total size check before processing:

```js
      if (fin) {
        const totalSize = this._fragBufs.reduce((sum, b) => sum + b.length, 0);
        if (totalSize > MAX_MESSAGE_SIZE) {
          log('oversized reassembled message', totalSize, '- closing connection');
          this._fragBufs = [];
          this.close();
          return;
        }
        const fullPayload = this._fragBufs.length === 1
          ? this._fragBufs[0]
          : Buffer.concat(this._fragBufs);
        // ... rest unchanged
```

---

## Verification checklist

- [ ] `receiveTorrent`: fallback timer is always set (no `if (senderId)`
      guard). When senderId is null, broadcasts to all peers.
- [ ] `randPath` uses `crypto.getRandomValues`, not `Math.random()`.
- [ ] `hashBlob` function exists and uses `crypto.subtle.digest('SHA-256', ...)`.
- [ ] `trySendWebRTCFiles` sends `{ t: 'done', sha256: ... }`.
- [ ] `tryRecvWebRTC` checks `msg.sha256` in the `done` handler (non-blocking,
      warn-only).
- [ ] `server.mjs`: `WsConnection` has `_fragBufs` / `_fragOpcode` fields.
- [ ] `server.mjs`: `#handle` reads FIN bit, accumulates fragments, and
      reassembles on FIN=1.
- [ ] `server.mjs`: `MAX_MESSAGE_SIZE` constant exists (128 KB).
- [ ] `server.mjs`: Both individual frame size and reassembled message size
      are checked against `MAX_MESSAGE_SIZE`.
- [ ] No other files have been modified.
- [ ] The code runs without syntax errors.

## Commit

```
feat(pipe): P2 improvements — fallback broadcast, secure randPath, checksum, WS fragments, message size limit

1. receiveTorrent: always set HTTP fallback timer; broadcast
   torrent-piping-request to all room peers when senderId is unknown.

2. randPath: replace Math.random() with crypto.getRandomValues for
   stronger entropy in signaling path generation.

3. P2P checksum: add SHA-256 hash to WebRTC 'done' messages; receiver
   verifies integrity (warn-only, non-blocking).

4. presence-server: support WebSocket frame fragmentation (FIN bit +
   continuation frame reassembly) for large SDP messages.

5. presence-server: add 128 KB max message size limit to prevent
   memory exhaustion from oversized frames.
```
