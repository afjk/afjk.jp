"""Wire-format helpers and coordinate conversion for Scene Sync.

Scene Sync wire transforms use the Web / Three.js basis: right-handed,
Y-up, X-right. Blender world space is right-handed Z-up.
"""

from __future__ import annotations

import hashlib
import uuid

try:
    from mathutils import Matrix, Quaternion, Vector  # available inside Blender

    _M = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0)))  # Blender Z-up -> wire Y-up
    _MI = _M.transposed()
    _MATHUTILS = True
except ImportError:
    _MATHUTILS = False


def pos_to_wire(loc) -> list[float]:
    return [float(loc[0]), float(loc[2]), float(-loc[1])]


def pos_from_wire(arr: list):
    if _MATHUTILS:
        return Vector((arr[0], -arr[2], arr[1]))
    return (arr[0], -arr[2], arr[1])


def rot_to_wire(quat) -> list[float]:
    if _MATHUTILS:
        mat = quat.to_matrix()
        converted = _M @ mat @ _MI
        q = converted.to_quaternion()
        return [float(q.x), float(q.y), float(q.z), float(q.w)]
    return [float(quat[1]), float(quat[2]), float(quat[3]), float(quat[0])]


def rot_from_wire(arr: list):
    if _MATHUTILS:
        q = Quaternion((arr[3], arr[0], arr[1], arr[2]))
        mat = q.to_matrix()
        converted = _MI @ mat @ _M
        return converted.to_quaternion()
    return (arr[3], arr[0], arr[1], arr[2])


def scale_to_wire(scale) -> list[float]:
    return [float(scale[0]), float(scale[2]), float(scale[1])]


def scale_from_wire(arr: list):
    if _MATHUTILS:
        return Vector((arr[0], arr[2], arr[1]))
    return (arr[0], arr[2], arr[1])


def build_mesh_asset(
    mesh_path: str,
    asset_id: str | None = None,
    *,
    size: int | None = None,
    original_name: str | None = None,
    visual_basis: str | None = None,
) -> dict:
    asset = {
        "type": "mesh",
        "source": "carrier",
        "meshPath": mesh_path,
        "mime": "model/gltf-binary",
    }
    if asset_id:
        asset["assetId"] = asset_id
    if size is not None:
        asset["size"] = int(size)
    if original_name:
        asset["originalName"] = original_name
    if visual_basis:
        asset["visualBasis"] = visual_basis
    return asset


def make_scene_add(
    object_id: str,
    name: str,
    loc,
    rot,
    scale,
    *,
    mesh_path: str = "",
    asset_id: str | None = None,
    asset: dict | None = None,
    metadata: dict | None = None,
    animation: dict | None = None,
    visible: bool = True,
    origin: str = "blender",
) -> dict:
    msg: dict = {
        "kind": "scene-add",
        "objectId": object_id,
        "name": name,
        "origin": origin,
        "position": pos_to_wire(loc),
        "rotation": rot_to_wire(rot),
        "scale": scale_to_wire(scale),
        "visible": bool(visible),
    }
    if mesh_path:
        msg["meshPath"] = mesh_path
    if asset_id:
        msg["assetId"] = asset_id
    if asset:
        msg["asset"] = asset
    elif mesh_path:
        msg["asset"] = build_mesh_asset(mesh_path, asset_id)
    if metadata:
        msg["metadata"] = metadata
    if animation:
        msg["animation"] = animation
    return msg


def make_scene_delta(
    object_id: str,
    loc,
    rot,
    scale,
    *,
    name: str | None = None,
    visible: bool | None = None,
) -> dict:
    msg = {
        "kind": "scene-delta",
        "objectId": object_id,
        "position": pos_to_wire(loc),
        "rotation": rot_to_wire(rot),
        "scale": scale_to_wire(scale),
    }
    if name is not None:
        msg["name"] = name
    if visible is not None:
        msg["visible"] = bool(visible)
    return msg


def make_scene_remove(object_id: str) -> dict:
    return {"kind": "scene-remove", "objectId": object_id}


def make_scene_request() -> dict:
    return {"kind": "scene-request"}


def make_scene_state(objects: dict, env_id: str | None = None) -> dict:
    msg = {"kind": "scene-state", "objects": objects}
    if env_id:
        msg["envId"] = env_id
    return msg


def make_scene_mesh(
    object_id: str,
    mesh_path: str,
    *,
    name: str | None = None,
    asset_id: str | None = None,
    asset: dict | None = None,
) -> dict:
    msg = {"kind": "scene-mesh", "objectId": object_id, "meshPath": mesh_path}
    if name:
        msg["name"] = name
    if asset_id:
        msg["assetId"] = asset_id
    if asset:
        msg["asset"] = asset
    elif mesh_path:
        msg["asset"] = build_mesh_asset(mesh_path, asset_id)
    return msg


def make_scene_lock(object_id: str) -> dict:
    return {"kind": "scene-lock", "objectId": object_id}


def make_scene_unlock(object_id: str) -> dict:
    return {"kind": "scene-unlock", "objectId": object_id}


def extract_transform(payload: dict) -> dict:
    result = {}
    pos = payload.get("position")
    if isinstance(pos, list) and len(pos) == 3:
        result["loc"] = pos_from_wire(pos)
    rot = payload.get("rotation")
    if isinstance(rot, list) and len(rot) == 4:
        result["rot"] = rot_from_wire(rot)
    scl = payload.get("scale")
    if isinstance(scl, list) and len(scl) == 3:
        result["scale"] = scale_from_wire(scl)
    return result


def generate_object_id(prefix: str = "blender") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def generate_mesh_path() -> str:
    return uuid.uuid4().hex[:12]


def compute_asset_id(data: bytes | None) -> str | None:
    if not data:
        return None
    return "sha256-" + hashlib.sha256(data).hexdigest()


def hex_to_rgb(hex_color: str) -> tuple[float, float, float]:
    h = (hex_color or "").lstrip("#")
    if len(h) != 6:
        return (0.5, 0.5, 0.5)
    try:
        return tuple(int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4))
    except ValueError:
        return (0.5, 0.5, 0.5)
