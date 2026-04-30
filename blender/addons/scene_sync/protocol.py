"""Wire-format helpers and coordinate conversion for Scene Sync.

Blender world space: Z-up, Y-forward, X-right (right-hand).
Wire / Three.js space: Y-up, Z-toward-viewer, X-right (right-hand).

Mapping:
    wire X  = blender X
    wire Y  = blender Z
    wire Z  = -blender Y

Scale axes are permuted the same way (no sign flip for magnitudes):
    wire sX = blender sX
    wire sY = blender sZ
    wire sZ = blender sY
"""

import uuid

try:
    from mathutils import Matrix, Quaternion, Vector  # available inside Blender

    _M = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0)))   # Z-up → Y-up
    _MI = _M.transposed()                               # inverse (M is orthogonal)
    _MATHUTILS = True
except ImportError:
    _MATHUTILS = False


# ---------------------------------------------------------------------------
# Coordinate conversion
# ---------------------------------------------------------------------------

def pos_to_wire(loc) -> list:
    """Blender Vector/sequence → wire [x, y, z] (Y-up)."""
    return [loc[0], loc[2], -loc[1]]


def pos_from_wire(arr: list):
    """Wire [x, y, z] → Blender Vector."""
    if _MATHUTILS:
        return Vector((arr[0], -arr[2], arr[1]))
    return (arr[0], -arr[2], arr[1])


def rot_to_wire(quat) -> list:
    """Blender Quaternion (w,x,y,z) → wire [x, y, z, w] (Y-up)."""
    if _MATHUTILS:
        mat = quat.to_matrix()
        converted = _M @ mat @ _MI
        q = converted.to_quaternion()
        return [q.x, q.y, q.z, q.w]
    # Fallback (identity) when mathutils unavailable
    return [quat[1], quat[2], quat[3], quat[0]]


def rot_from_wire(arr: list):
    """Wire [x, y, z, w] → Blender Quaternion."""
    if _MATHUTILS:
        q = Quaternion((arr[3], arr[0], arr[1], arr[2]))  # (w,x,y,z)
        mat = q.to_matrix()
        converted = _MI @ mat @ _M
        return converted.to_quaternion()
    return (arr[3], arr[0], arr[1], arr[2])


def scale_to_wire(scale) -> list:
    """Blender scale Vector → wire [sx, sy, sz] (axis permuted)."""
    return [scale[0], scale[2], scale[1]]


def scale_from_wire(arr: list):
    """Wire [sx, sy, sz] → Blender scale Vector."""
    if _MATHUTILS:
        return Vector((arr[0], arr[2], arr[1]))
    return (arr[0], arr[2], arr[1])


# ---------------------------------------------------------------------------
# Message builders
# ---------------------------------------------------------------------------

def make_scene_add(
    object_id: str,
    name: str,
    loc,
    rot,
    scale,
    mesh_path: str = "",
    asset: dict | None = None,
) -> dict:
    msg: dict = {
        "kind": "scene-add",
        "objectId": object_id,
        "name": name,
        "position": pos_to_wire(loc),
        "rotation": rot_to_wire(rot),
        "scale": scale_to_wire(scale),
    }
    if asset:
        msg["asset"] = asset
    elif mesh_path:
        msg["asset"] = {"type": "mesh", "meshPath": mesh_path}
    return msg


def make_scene_delta(object_id: str, loc, rot, scale) -> dict:
    return {
        "kind": "scene-delta",
        "objectId": object_id,
        "position": pos_to_wire(loc),
        "rotation": rot_to_wire(rot),
        "scale": scale_to_wire(scale),
    }


def make_scene_remove(object_id: str) -> dict:
    return {"kind": "scene-remove", "objectId": object_id}


def make_scene_request() -> dict:
    return {"kind": "scene-request"}


def make_scene_state(objects: dict) -> dict:
    return {"kind": "scene-state", "objects": objects}


def make_scene_mesh(object_id: str, mesh_path: str) -> dict:
    return {"kind": "scene-mesh", "objectId": object_id, "meshPath": mesh_path}


def make_scene_lock(object_id: str) -> dict:
    return {"kind": "scene-lock", "objectId": object_id}


def make_scene_unlock(object_id: str) -> dict:
    return {"kind": "scene-unlock", "objectId": object_id}


def extract_transform(payload: dict) -> dict:
    """Return {"loc": ..., "rot": ..., "scale": ...} from a wire payload."""
    result = {}
    pos = payload.get("position")
    if pos and len(pos) == 3:
        result["loc"] = pos_from_wire(pos)
    rot = payload.get("rotation")
    if rot and len(rot) == 4:
        result["rot"] = rot_from_wire(rot)
    scl = payload.get("scale")
    if scl and len(scl) == 3:
        result["scale"] = scale_from_wire(scl)
    return result


# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------

def generate_object_id() -> str:
    return uuid.uuid4().hex[:8]


def generate_mesh_path() -> str:
    return uuid.uuid4().hex[:8]


def hex_to_rgb(hex_color: str) -> tuple:
    """Parse '#rrggbb' → (r, g, b) floats in [0, 1]."""
    h = hex_color.lstrip("#")
    if len(h) != 6:
        return (0.5, 0.5, 0.5)
    return tuple(int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4))
