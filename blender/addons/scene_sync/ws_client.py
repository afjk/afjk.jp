"""Minimal WebSocket client running in a background thread."""

import base64
import json
import os
import queue
import socket
import ssl
import struct
import threading
from urllib.parse import urlparse


class SceneSyncWSClient:
    """
    WebSocket client for Scene Sync presence server.

    Runs in a background thread; all inter-thread communication goes
    through thread-safe queues.  Call poll() from the main thread to
    retrieve received messages.
    """

    def __init__(self):
        self._sock = None
        self._thread = None
        self._send_q: queue.Queue = queue.Queue()
        self._recv_q: queue.Queue = queue.Queue()
        self._running = False
        self.connected = False
        self.my_id = ""
        self.room = ""
        self.peers: list = []

    # ------------------------------------------------------------------
    # Public API (main thread)
    # ------------------------------------------------------------------

    def connect(self, url: str, room: str, nickname: str) -> None:
        self.disconnect()
        self._running = True
        self._thread = threading.Thread(
            target=self._run,
            args=(url, room, nickname),
            daemon=True,
        )
        self._thread.start()

    def disconnect(self) -> None:
        self._running = False
        if self._sock:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)
        self._thread = None
        self.connected = False
        self.my_id = ""
        self.peers = []

    def send_json(self, data: dict) -> None:
        """Queue a JSON message to be sent by the background thread."""
        self._send_q.put(json.dumps(data, ensure_ascii=False))

    def poll(self) -> list:
        """
        Drain the receive queue and return all pending messages.
        Internal events have the key ``_internal`` set to a string tag.
        """
        messages = []
        while True:
            try:
                messages.append(self._recv_q.get_nowait())
            except queue.Empty:
                break
        return messages

    # ------------------------------------------------------------------
    # Background thread
    # ------------------------------------------------------------------

    def _run(self, url: str, room: str, nickname: str) -> None:
        try:
            parsed = urlparse(url)
            host = parsed.hostname
            use_ssl = parsed.scheme in ("wss", "https")
            port = parsed.port or (443 if use_ssl else 80)
            path = (parsed.path or "/") + (f"?room={room}" if room else "")

            raw = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            raw.settimeout(15)
            raw.connect((host, port))

            if use_ssl:
                ctx = ssl.create_default_context()
                self._sock = ctx.wrap_socket(raw, server_hostname=host)
            else:
                self._sock = raw

            # HTTP upgrade handshake
            ws_key = base64.b64encode(os.urandom(16)).decode()
            self._sock.sendall(
                (
                    f"GET {path} HTTP/1.1\r\n"
                    f"Host: {host}\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    f"Sec-WebSocket-Key: {ws_key}\r\n"
                    "Sec-WebSocket-Version: 13\r\n"
                    "\r\n"
                ).encode()
            )

            hdr = b""
            while b"\r\n\r\n" not in hdr:
                chunk = self._sock.recv(1024)
                if not chunk:
                    raise ConnectionError("Server closed during handshake")
                hdr += chunk
            if b"101" not in hdr.split(b"\r\n")[0]:
                raise ConnectionError(f"Upgrade failed: {hdr.split(b'\\r\\n')[0]}")

            self._sock.settimeout(0.05)

            # hello
            try:
                import bpy  # noqa: PLC0415
                device = f"Blender {bpy.app.version_string}"
            except ImportError:
                device = "Blender"

            self._ws_send(json.dumps({"type": "hello", "nickname": nickname, "device": device}))
            self.connected = True
            self._recv_q.put({"_internal": "_connected"})

            buf = b""
            while self._running:
                # flush outgoing queue
                try:
                    while True:
                        self._ws_send(self._send_q.get_nowait())
                except queue.Empty:
                    pass

                # receive
                try:
                    chunk = self._sock.recv(65536)
                    if not chunk:
                        break
                    buf += chunk
                    while True:
                        text, buf = self._parse_frame(buf)
                        if text is None:
                            break
                        try:
                            self._recv_q.put(json.loads(text))
                        except json.JSONDecodeError:
                            pass
                except socket.timeout:
                    pass
                except (OSError, ssl.SSLError):
                    break

        except Exception as e:
            print(f"[SceneSync] WS error: {e}")
        finally:
            if self._sock:
                try:
                    self._sock.close()
                except Exception:
                    pass
                self._sock = None
            self.connected = False
            self._recv_q.put({"_internal": "_disconnected"})

    # ------------------------------------------------------------------
    # WebSocket frame helpers
    # ------------------------------------------------------------------

    def _ws_send(self, text: str) -> None:
        if self._sock is None:
            return
        payload = text.encode("utf-8")
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        n = len(payload)
        if n <= 125:
            hdr = bytes([0x81, 0x80 | n])
        elif n <= 65535:
            hdr = bytes([0x81, 0xFE]) + struct.pack(">H", n)
        else:
            hdr = bytes([0x81, 0xFF]) + struct.pack(">Q", n)
        try:
            self._sock.sendall(hdr + mask + masked)
        except Exception:
            pass

    def _parse_frame(self, buf: bytes):
        """Return (text_or_None, remaining_buf) for one frame."""
        if len(buf) < 2:
            return None, buf

        opcode = buf[0] & 0x0F
        masked = bool(buf[1] & 0x80)
        length = buf[1] & 0x7F
        off = 2

        if length == 126:
            if len(buf) < 4:
                return None, buf
            length = struct.unpack(">H", buf[2:4])[0]
            off = 4
        elif length == 127:
            if len(buf) < 10:
                return None, buf
            length = struct.unpack(">Q", buf[2:10])[0]
            off = 10

        mask_key = b""
        if masked:
            if len(buf) < off + 4:
                return None, buf
            mask_key = buf[off : off + 4]
            off += 4

        if len(buf) < off + length:
            return None, buf

        payload = buf[off : off + length]
        if masked:
            payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
        rest = buf[off + length :]

        if opcode == 0x9:  # ping → pong
            self._ws_pong(payload)
            return None, rest
        if opcode == 0x8:  # close
            self._running = False
            return None, rest
        if opcode in (0x1, 0x2):
            return payload.decode("utf-8", errors="replace"), rest

        return None, rest

    def _ws_pong(self, payload: bytes) -> None:
        if self._sock is None:
            return
        p = payload[:125]
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(p))
        try:
            self._sock.sendall(bytes([0x8A, 0x80 | len(p)]) + mask + masked)
        except Exception:
            pass
