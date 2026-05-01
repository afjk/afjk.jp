"""HTTP helpers for the Scene Sync blob store."""

import urllib.error
import urllib.request


def upload_glb(blob_base_url: str, path: str, data: bytes) -> bool:
    """POST *data* to ``<blob_base_url>/<path>``. Returns True on HTTP 201."""
    url = f"{blob_base_url.rstrip('/')}/{path}"
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "model/gltf-binary"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status == 201
    except urllib.error.HTTPError as e:
        print(f"[SceneSync] Blob upload HTTP error {e.code}: {path}")
        return False
    except Exception as e:
        print(f"[SceneSync] Blob upload error: {e}")
        return False


def download_glb(blob_base_url: str, path: str) -> bytes | None:
    """GET ``<blob_base_url>/<path>``. Returns bytes or None on failure."""
    url = f"{blob_base_url.rstrip('/')}/{path}"
    try:
        with urllib.request.urlopen(url, timeout=30) as resp:
            return resp.read()
    except Exception as e:
        print(f"[SceneSync] Blob download error: {e}")
        return None


def presence_url_to_blob_url(presence_url: str) -> str:
    """Derive blob store URL from the presence server WebSocket URL."""
    url = presence_url.replace("wss://", "https://").replace("ws://", "http://")
    return url.rstrip("/") + "/blob"
