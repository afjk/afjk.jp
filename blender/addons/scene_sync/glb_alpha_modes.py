"""GLB material alpha-mode normalization helpers."""

from __future__ import annotations

import json
import struct
import zlib
from collections import Counter


GLB_MAGIC = 0x46546C67
GLB_VERSION = 2
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942

BLEND_NAME_HINTS = (
    "glass",
    "lens",
    "wing",
    "cheek",
    "shadow",
    "fade",
    "trans",
    "alpha",
    "semi",
)


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def _decode_png_alpha(blob: bytes) -> dict:
    if not blob.startswith(b"\x89PNG\r\n\x1a\n"):
        return {"hasAlpha": True, "decoded": False}

    pos = 8
    ihdr = None
    idat = []
    trns = None

    while pos + 8 <= len(blob):
        length = int.from_bytes(blob[pos:pos + 4], "big")
        chunk_type = blob[pos + 4:pos + 8]
        pos += 8
        chunk = blob[pos:pos + length]
        pos += length + 4

        if chunk_type == b"IHDR":
            ihdr = chunk
        elif chunk_type == b"IDAT":
            idat.append(chunk)
        elif chunk_type == b"tRNS":
            trns = chunk
        elif chunk_type == b"IEND":
            break

    if ihdr is None:
        return {"hasAlpha": False, "decoded": False}

    width, height, bit_depth, color_type, _comp, _filter, interlace = struct.unpack(">IIBBBBB", ihdr)
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color_type)
    has_alpha = color_type in (4, 6) or trns is not None

    if not has_alpha:
        return {"hasAlpha": False, "decoded": True}
    if bit_depth != 8 or interlace != 0 or channels is None:
        return {"hasAlpha": True, "decoded": False}

    raw = zlib.decompress(b"".join(idat))
    stride = width * channels
    previous = bytearray(stride)
    histogram = Counter()

    for y in range(height):
        row_start = y * (stride + 1)
        filter_type = raw[row_start]
        scanline = bytearray(raw[row_start + 1:row_start + 1 + stride])

        for i in range(stride):
            left = scanline[i - channels] if i >= channels else 0
            up = previous[i]
            upper_left = previous[i - channels] if i >= channels else 0

            if filter_type == 1:
                scanline[i] = (scanline[i] + left) & 255
            elif filter_type == 2:
                scanline[i] = (scanline[i] + up) & 255
            elif filter_type == 3:
                scanline[i] = (scanline[i] + ((left + up) // 2)) & 255
            elif filter_type == 4:
                scanline[i] = (scanline[i] + _paeth(left, up, upper_left)) & 255

        if color_type == 6:
            for x in range(width):
                histogram[scanline[x * 4 + 3]] += 1
        elif color_type == 4:
            for x in range(width):
                histogram[scanline[x * 2 + 1]] += 1
        elif color_type == 3 and trns is not None:
            for x in range(width):
                index = scanline[x]
                histogram[trns[index] if index < len(trns) else 255] += 1

        previous = scanline

    total = max(width * height, 1)
    transparent = histogram[0]
    opaque = histogram[255]
    partial = total - transparent - opaque

    return {
        "hasAlpha": True,
        "decoded": True,
        "alphaMax": max(histogram) if histogram else None,
        "transparentPct": transparent * 100.0 / total,
        "partialPct": partial * 100.0 / total,
    }


def _parse_glb(data: bytes) -> tuple[dict, bytes]:
    if len(data) < 20:
        raise ValueError("GLB is too small")

    magic, version, _length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC or version != GLB_VERSION:
        raise ValueError("Only glTF 2.0 GLB is supported")

    json_data = None
    bin_data = None
    offset = 12
    while offset < len(data):
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk = data[offset:offset + chunk_length]
        offset += chunk_length
        if chunk_type == JSON_CHUNK:
            json_data = chunk
        elif chunk_type == BIN_CHUNK:
            bin_data = chunk

    if json_data is None or bin_data is None:
        raise ValueError("GLB must contain JSON and BIN chunks")

    return json.loads(json_data.decode("utf-8")), bin_data


def _pack_glb(gltf: dict, bin_data: bytes) -> bytes:
    json_data = json.dumps(gltf, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    json_data += b" " * ((4 - len(json_data) % 4) % 4)
    total_length = 12 + 8 + len(json_data) + 8 + len(bin_data)

    return b"".join([
        struct.pack("<III", GLB_MAGIC, GLB_VERSION, total_length),
        struct.pack("<II", len(json_data), JSON_CHUNK),
        json_data,
        struct.pack("<II", len(bin_data), BIN_CHUNK),
        bin_data,
    ])


def _image_blob(gltf: dict, bin_data: bytes, image_index: int) -> bytes | None:
    images = gltf.get("images", [])
    buffer_views = gltf.get("bufferViews", [])
    if image_index < 0 or image_index >= len(images):
        return None

    buffer_view_index = images[image_index].get("bufferView")
    if buffer_view_index is None:
        return None

    view = buffer_views[buffer_view_index]
    offset = view.get("byteOffset", 0)
    length = view.get("byteLength", 0)
    return bin_data[offset:offset + length]


def _base_image_index(gltf: dict, material: dict) -> int | None:
    texture_index = material.get("pbrMetallicRoughness", {}).get("baseColorTexture", {}).get("index")
    if texture_index is None:
        return None

    textures = gltf.get("textures", [])
    if texture_index < 0 or texture_index >= len(textures):
        return None

    return textures[texture_index].get("source")


def _base_alpha(material: dict) -> float:
    factor = material.get("pbrMetallicRoughness", {}).get("baseColorFactor", [1, 1, 1, 1])
    if isinstance(factor, list) and len(factor) >= 4:
        try:
            return float(factor[3])
        except Exception:
            return 1.0
    return 1.0


def _choose_alpha_mode(name: str, material: dict, alpha: dict | None) -> tuple[str, float | None]:
    if _base_alpha(material) < 0.999:
        return "BLEND", None

    if not alpha or not alpha.get("hasAlpha"):
        return "OPAQUE", None

    if not alpha.get("decoded"):
        return material.get("alphaMode", "OPAQUE"), material.get("alphaCutoff")

    transparent_pct = float(alpha.get("transparentPct") or 0.0)
    partial_pct = float(alpha.get("partialPct") or 0.0)
    alpha_max = alpha.get("alphaMax")
    wants_blend = any(hint in name.lower() for hint in BLEND_NAME_HINTS)

    if alpha_max is not None and alpha_max < 255:
        return "BLEND", None

    if transparent_pct > 0.01:
        if wants_blend:
            return "BLEND", None
        return "MASK", 0.10

    if partial_pct > 24.0 and wants_blend:
        return "BLEND", None

    # Partial-only alpha often contains non-visibility data or baked shading.
    return "OPAQUE", None


def normalize_glb_alpha_modes(data: bytes) -> tuple[bytes, dict]:
    """Return GLB bytes with material alpha modes adjusted for stable rendering."""
    gltf, bin_data = _parse_glb(data)
    image_alpha_cache = {}
    changed = []

    for index, material in enumerate(gltf.get("materials", [])):
        name = material.get("name") or f"material_{index}"
        image_index = _base_image_index(gltf, material)
        alpha = None

        if image_index is not None:
            if image_index not in image_alpha_cache:
                blob = _image_blob(gltf, bin_data, image_index)
                image_alpha_cache[image_index] = _decode_png_alpha(blob) if blob else None
            alpha = image_alpha_cache[image_index]

        before = material.get("alphaMode", "OPAQUE")
        mode, cutoff = _choose_alpha_mode(name, material, alpha)

        if mode == "OPAQUE":
            material.pop("alphaMode", None)
            material.pop("alphaCutoff", None)
        elif mode == "MASK":
            material["alphaMode"] = "MASK"
            material["alphaCutoff"] = cutoff if cutoff is not None else 0.10
        else:
            material["alphaMode"] = "BLEND"
            material.pop("alphaCutoff", None)

        after = material.get("alphaMode", "OPAQUE")
        if before != after:
            changed.append({"index": index, "name": name, "before": before, "after": after})

    if not changed:
        return data, {"changed": False, "materials": []}

    return _pack_glb(gltf, bin_data), {"changed": True, "materials": changed}
