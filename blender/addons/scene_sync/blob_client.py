"""HTTP helpers for the Scene Sync blob store."""

from __future__ import annotations

import urllib.error
import urllib.request
from urllib.parse import urlsplit, urlunsplit


def upload_glb(blob_base_url: str, path: str, data: bytes) -> bool:
    """POST data to ``<blob_base_url>/<path>``."""
    if not data:
        print(f"[SceneSync] Blob upload skipped: empty data for {path}")
        return False

    url = f"{blob_base_url.rstrip('/')}/{path}"
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "model/gltf-binary"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return 200 <= resp.status < 300
    except urllib.error.HTTPError as e:
        print(f"[SceneSync] Blob upload HTTP error {e.code}: {path}")
        return False
    except Exception as e:
        print(f"[SceneSync] Blob upload error: {e}")
        return False


def download_glb(blob_base_url: str, path: str) -> bytes | None:
    """GET ``<blob_base_url>/<path>``."""
    if not path:
        return None

    url = f"{blob_base_url.rstrip('/')}/{path}"
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            return resp.read()
    except Exception as e:
        print(f"[SceneSync] Blob download error: {e}")
        return None


def presence_url_to_blob_url(presence_url: str) -> str:
    """Derive blob store URL from the presence server WebSocket URL."""
    parts = urlsplit(presence_url)
    scheme = "https" if parts.scheme in {"wss", "https"} else "http"
    path = parts.path.rstrip("/") + "/blob"
    return urlunsplit((scheme, parts.netloc, path, "", ""))
