"""Scene Sync — Blender addon.

Syncs the Blender scene with a browser / Unity / Godot via the
Scene Sync presence server REST + WebSocket protocol.
"""

bl_info = {
    "name": "Scene Sync",
    "author": "afjk",
    "version": (0, 1, 0),
    "blender": (4, 0, 0),
    "location": "View3D > Sidebar > Scene Sync",
    "description": "Real-time 3D scene sync with browser, Unity, and Godot",
    "category": "3D View",
    "doc_url": "https://github.com/afjk/afjk.jp",
}

import bpy
from bpy.props import StringProperty
from bpy.types import Operator, Panel, PropertyGroup

from . import blob_client, protocol, ws_client
from .glb_helper import export_object_as_glb, import_glb

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

POLL_INTERVAL = 0.05          # seconds between timer ticks
DELTA_THRESHOLD = 0.0001      # min change before sending scene-delta
OBJECT_ID_PROP = "scene_sync_id"
REMOTE_PROP = "scene_sync_remote"   # True on objects received from server

# ---------------------------------------------------------------------------
# Addon state (singleton, lives for the session)
# ---------------------------------------------------------------------------

class _State:
    def __init__(self) -> None:
        self.ws = ws_client.SceneSyncWSClient()
        self.blob_url = ""
        self.status = "未接続"
        self.my_id = ""
        self.current_room = ""
        self.peers: list = []

        # object_id → {"name": str, "snapshot": list[3 lists], "remote": bool, "mesh_path": str}
        self.managed: dict = {}
        # blender object name → object_id  (for quick lookup)
        self.name_to_id: dict = {}

        self.locks: dict = {}          # object_id → peer_id
        self.scene_received = False
        self.first_peers_seen = False

    def reset_scene(self) -> None:
        self.managed.clear()
        self.name_to_id.clear()
        self.locks.clear()
        self.scene_received = False
        self.first_peers_seen = False


_state = _State()


# ---------------------------------------------------------------------------
# Snapshot helpers
# ---------------------------------------------------------------------------

def _snap(loc, rot, scale) -> list:
    """Store transform as three plain lists for easy comparison."""
    return [list(loc), list(rot), list(scale)]


def _snaps_equal(a: list, b: list) -> bool:
    if not a or not b:
        return False
    for va, vb in zip(a, b):
        for x, y in zip(va, vb):
            if abs(x - y) > DELTA_THRESHOLD:
                return False
    return True


def _obj_snapshot(obj: bpy.types.Object) -> list:
    loc, rot, scale = obj.matrix_world.decompose()
    return _snap(
        protocol.pos_to_wire(loc),
        protocol.rot_to_wire(rot),
        protocol.scale_to_wire(scale),
    )


# ---------------------------------------------------------------------------
# WebSocket message handlers
# ---------------------------------------------------------------------------

def _handle_ws_messages() -> None:
    for msg in _state.ws.poll():
        internal = msg.get("_internal")
        if internal == "_connected":
            _state.status = f"接続中 — {_state.ws.room}"
            _force_redraw()
            continue
        if internal == "_disconnected":
            _state.status = "未接続"
            _state.peers = []
            _state.ws.my_id = ""
            _force_redraw()
            continue

        msg_type = msg.get("type", "")
        if msg_type == "welcome":
            _state.ws.my_id = str(msg.get("id", ""))
            _state.ws.room = str(msg.get("room", _state.ws.room))
            _state.status = f"接続中 — {_state.ws.room}"
            _force_redraw()

        elif msg_type == "peers":
            raw = msg.get("peers", [])
            _state.peers = [p for p in raw if isinstance(p, dict)]
            _state.ws.peers = _state.peers
            _update_peer_status()
            if not _state.first_peers_seen and _state.peers:
                _state.first_peers_seen = True
                if not _state.scene_received:
                    _request_scene()
            _force_redraw()

        elif msg_type == "handoff":
            payload = msg.get("payload", {})
            from_info = msg.get("from", {})
            _handle_payload(payload, from_info)


def _update_peer_status() -> None:
    n = len(_state.peers)
    _state.status = f"接続中 — {_state.ws.room} — {n}人"


def _request_scene() -> None:
    for peer in _state.peers:
        peer_id = str(peer.get("id", ""))
        if peer_id and peer_id != _state.ws.my_id:
            _state.ws.send_json({
                "type": "handoff",
                "targetId": peer_id,
                "payload": protocol.make_scene_request(),
            })
            return
    _state.scene_received = True


# ---------------------------------------------------------------------------
# Payload dispatch
# ---------------------------------------------------------------------------

def _handle_payload(payload: dict, from_info: dict) -> None:
    kind = str(payload.get("kind", ""))
    from_id = str(from_info.get("id", ""))

    if kind == "scene-request":
        _send_scene_state(from_id)

    elif kind == "scene-state":
        _state.scene_received = True
        objects = payload.get("objects", {})
        if isinstance(objects, dict):
            for oid, info in objects.items():
                if isinstance(info, dict):
                    _apply_scene_add({**info, "objectId": oid}, from_id="")

    elif kind == "scene-add":
        if from_id != _state.ws.my_id:
            _apply_scene_add(payload, from_id)

    elif kind == "scene-delta":
        if from_id != _state.ws.my_id:
            _apply_scene_delta(payload)

    elif kind == "scene-remove":
        _apply_scene_remove(payload, from_id)

    elif kind == "scene-mesh":
        if from_id != _state.ws.my_id:
            _apply_scene_mesh(payload)

    elif kind == "scene-lock":
        oid = str(payload.get("objectId", ""))
        if oid and from_id:
            _state.locks[oid] = from_id

    elif kind == "scene-unlock":
        oid = str(payload.get("objectId", ""))
        _state.locks.pop(oid, None)


# ---------------------------------------------------------------------------
# Incoming: apply remote changes to Blender scene
# ---------------------------------------------------------------------------

def _apply_scene_add(payload: dict, from_id: str) -> None:
    oid = str(payload.get("objectId", ""))
    if not oid:
        return

    # Already tracked → just update transform
    if oid in _state.managed:
        _apply_scene_delta(payload)
        return

    name = str(payload.get("name", oid))
    asset = payload.get("asset", {})
    mesh_path = str(payload.get("meshPath", ""))

    obj: bpy.types.Object | None = None

    if isinstance(asset, dict):
        atype = str(asset.get("type", ""))
        if atype == "primitive":
            obj = _create_primitive(
                str(asset.get("primitive", "box")),
                str(asset.get("color", "#888888")),
                name,
            )
        elif atype == "mesh":
            mesh_path = str(asset.get("meshPath", mesh_path))

    if obj is None and mesh_path:
        data = blob_client.download_glb(_state.blob_url, mesh_path)
        if data:
            obj = import_glb(data, name)
        if obj is None:
            obj = _create_primitive("box", "#88ccff", name)

    if obj is None:
        obj = _create_primitive("box", "#888888", name)

    obj[OBJECT_ID_PROP] = oid
    obj[REMOTE_PROP] = True

    tf = protocol.extract_transform(payload)
    _apply_transform(obj, tf)

    snap = _obj_snapshot(obj)
    _state.managed[oid] = {"name": obj.name, "snapshot": snap, "remote": True, "mesh_path": mesh_path}
    _state.name_to_id[obj.name] = oid


def _apply_scene_delta(payload: dict) -> None:
    oid = str(payload.get("objectId", ""))
    if oid not in _state.managed:
        return
    obj = _find_blender_obj(oid)
    if obj is None:
        return
    tf = protocol.extract_transform(payload)
    _apply_transform(obj, tf)
    _state.managed[oid]["snapshot"] = _obj_snapshot(obj)


def _apply_scene_remove(payload: dict, from_id: str) -> None:
    oid = str(payload.get("objectId", ""))
    if oid not in _state.managed:
        return
    info = _state.managed[oid]
    # Only remove objects that came from the same peer who is removing them,
    # or remote objects (never delete user's own local work without consent).
    if not info.get("remote") and from_id == _state.ws.my_id:
        return

    obj = _find_blender_obj(oid)
    if obj:
        bpy.data.objects.remove(obj, do_unlink=True)

    _state.name_to_id.pop(info.get("name", ""), None)
    del _state.managed[oid]
    _state.locks.pop(oid, None)


def _apply_scene_mesh(payload: dict) -> None:
    oid = str(payload.get("objectId", ""))
    mesh_path = str(payload.get("meshPath", ""))
    if not oid or not mesh_path:
        return
    data = blob_client.download_glb(_state.blob_url, mesh_path)
    if not data:
        return

    old = _find_blender_obj(oid)
    new = import_glb(data, str(payload.get("name", oid)))
    if new is None:
        return

    new[OBJECT_ID_PROP] = oid
    new[REMOTE_PROP] = True

    if old:
        # Copy transform then remove old
        new.matrix_world = old.matrix_world.copy()
        bpy.data.objects.remove(old, do_unlink=True)

    if oid in _state.managed:
        _state.name_to_id.pop(_state.managed[oid].get("name", ""), None)
        _state.managed[oid]["name"] = new.name
        _state.managed[oid]["mesh_path"] = mesh_path
    else:
        _state.managed[oid] = {"name": new.name, "snapshot": [], "remote": True, "mesh_path": mesh_path}

    _state.name_to_id[new.name] = oid
    _state.managed[oid]["snapshot"] = _obj_snapshot(new)


# ---------------------------------------------------------------------------
# Outgoing: broadcast local scene changes
# ---------------------------------------------------------------------------

def _send_scene_state(to_peer_id: str) -> None:
    objects: dict = {}
    for oid, info in list(_state.managed.items()):
        obj = _find_blender_obj(oid)
        if obj is None:
            continue
        loc, rot, scale = obj.matrix_world.decompose()
        entry = {
            "name": obj.name,
            "position": protocol.pos_to_wire(loc),
            "rotation": protocol.rot_to_wire(rot),
            "scale": protocol.scale_to_wire(scale),
        }
        mesh_path = info.get("mesh_path", "")
        if mesh_path:
            entry["asset"] = {"type": "mesh", "meshPath": mesh_path}
        objects[oid] = entry

    _state.ws.send_json({
        "type": "handoff",
        "targetId": to_peer_id,
        "payload": protocol.make_scene_state(objects),
    })


def _check_scene_changes() -> None:
    """Detect added / removed / moved local mesh objects and broadcast."""
    scene = bpy.context.scene
    current_oids: set = set()

    for obj in scene.objects:
        if obj.type != "MESH":
            continue
        if obj.get(REMOTE_PROP):
            continue  # skip objects received from remote

        oid = obj.get(OBJECT_ID_PROP, "")

        if not oid:
            # New local object
            oid = protocol.generate_object_id()
            obj[OBJECT_ID_PROP] = oid
            _send_object_add(obj, oid)
            current_oids.add(oid)
            continue

        current_oids.add(oid)

        if oid not in _state.managed:
            # Seen for first time (e.g. loaded from file with existing prop)
            _send_object_add(obj, oid)
            continue

        # Check for transform change
        snap = _obj_snapshot(obj)
        if not _snaps_equal(snap, _state.managed[oid]["snapshot"]):
            _state.managed[oid]["snapshot"] = snap
            loc, rot, scale = obj.matrix_world.decompose()
            _state.ws.send_json({
                "type": "broadcast",
                "payload": protocol.make_scene_delta(oid, loc, rot, scale),
            })

        # Sync name changes
        stored_name = _state.managed[oid].get("name", "")
        if stored_name != obj.name:
            _state.name_to_id.pop(stored_name, None)
            _state.name_to_id[obj.name] = oid
            _state.managed[oid]["name"] = obj.name

    # Detect removed local objects
    for oid in list(_state.managed.keys()):
        info = _state.managed[oid]
        if info.get("remote"):
            continue
        if oid not in current_oids:
            _state.ws.send_json({
                "type": "broadcast",
                "payload": protocol.make_scene_remove(oid),
            })
            _state.name_to_id.pop(info.get("name", ""), None)
            del _state.managed[oid]


def _send_object_add(obj: bpy.types.Object, oid: str) -> None:
    loc, rot, scale = obj.matrix_world.decompose()
    snap = _obj_snapshot(obj)
    mesh_path = ""

    glb = export_object_as_glb(obj)
    if glb:
        mesh_path = protocol.generate_mesh_path()
        ok = blob_client.upload_glb(_state.blob_url, mesh_path, glb)
        if not ok:
            mesh_path = ""

    asset = {"type": "mesh", "meshPath": mesh_path} if mesh_path else None
    _state.ws.send_json({
        "type": "broadcast",
        "payload": protocol.make_scene_add(oid, obj.name, loc, rot, scale, mesh_path, asset),
    })

    _state.managed[oid] = {"name": obj.name, "snapshot": snap, "remote": False, "mesh_path": mesh_path}
    _state.name_to_id[obj.name] = oid


# ---------------------------------------------------------------------------
# Blender scene utilities
# ---------------------------------------------------------------------------

def _find_blender_obj(oid: str) -> bpy.types.Object | None:
    for obj in bpy.data.objects:
        if obj.get(OBJECT_ID_PROP) == oid:
            return obj
    return None


def _create_primitive(primitive: str, color_hex: str, name: str) -> bpy.types.Object:
    dispatch = {
        "box":      lambda: bpy.ops.mesh.primitive_cube_add(size=1),
        "sphere":   lambda: bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5),
        "cylinder": lambda: bpy.ops.mesh.primitive_cylinder_add(radius=0.5, depth=1),
        "cone":     lambda: bpy.ops.mesh.primitive_cone_add(radius1=0.5, depth=1),
        "plane":    lambda: bpy.ops.mesh.primitive_plane_add(size=1),
        "torus":    lambda: bpy.ops.mesh.primitive_torus_add(),
    }
    dispatch.get(primitive, dispatch["box"])()
    obj = bpy.context.active_object
    obj.name = name

    mat = bpy.data.materials.new(f"SceneSync_{name}")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    principled = nodes.get("Principled BSDF")
    if principled:
        r, g, b = protocol.hex_to_rgb(color_hex)
        principled.inputs["Base Color"].default_value = (r, g, b, 1.0)
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    return obj


def _apply_transform(obj: bpy.types.Object, tf: dict) -> None:
    from mathutils import Quaternion, Vector

    loc_wire = tf.get("loc")
    rot_wire = tf.get("rot")
    scl_wire = tf.get("scale")

    if loc_wire is not None:
        obj.location = loc_wire
    if rot_wire is not None:
        if isinstance(rot_wire, (list, tuple)):
            obj.rotation_mode = "QUATERNION"
            obj.rotation_quaternion = rot_wire
        else:
            obj.rotation_mode = "QUATERNION"
            obj.rotation_quaternion = rot_wire
    if scl_wire is not None:
        obj.scale = scl_wire


# ---------------------------------------------------------------------------
# Timer
# ---------------------------------------------------------------------------

def _timer_callback() -> float:
    try:
        _handle_ws_messages()
        if _state.ws.connected:
            _check_scene_changes()
    except Exception as e:
        print(f"[SceneSync] Timer error: {e}")
    return POLL_INTERVAL


def _force_redraw() -> None:
    for area in bpy.context.screen.areas if bpy.context.screen else []:
        if area.type == "VIEW_3D":
            area.tag_redraw()


# ---------------------------------------------------------------------------
# Operators
# ---------------------------------------------------------------------------

class SCENE_SYNC_OT_connect(Operator):
    bl_idname = "scene_sync.connect"
    bl_label = "接続"
    bl_description = "Scene Sync サーバーに接続する"

    def execute(self, context):
        settings = context.scene.scene_sync
        url = settings.presence_url.strip()
        room = settings.room.strip()
        nickname = settings.nickname.strip() or "Blender"

        _state.blob_url = blob_client.presence_url_to_blob_url(url)
        _state.reset_scene()
        _state.status = "接続中…"
        _state.ws.connect(url, room, nickname)
        return {"FINISHED"}


class SCENE_SYNC_OT_disconnect(Operator):
    bl_idname = "scene_sync.disconnect"
    bl_label = "切断"
    bl_description = "Scene Sync サーバーから切断する"

    def execute(self, context):
        _state.ws.disconnect()
        _state.status = "未接続"
        _state.peers = []
        _force_redraw()
        return {"FINISHED"}


class SCENE_SYNC_OT_sync_meshes(Operator):
    bl_idname = "scene_sync.sync_meshes"
    bl_label = "メッシュを再送信"
    bl_description = "全ローカルメッシュの GLB を再エクスポートして blob にアップロードする"

    def execute(self, context):
        if not _state.ws.connected:
            self.report({"WARNING"}, "接続されていません")
            return {"CANCELLED"}

        count = 0
        for obj in context.scene.objects:
            if obj.type != "MESH" or obj.get(REMOTE_PROP):
                continue
            oid = obj.get(OBJECT_ID_PROP, "")
            if not oid:
                continue

            glb = export_object_as_glb(obj)
            if not glb:
                continue

            mesh_path = protocol.generate_mesh_path()
            ok = blob_client.upload_glb(_state.blob_url, mesh_path, glb)
            if ok:
                _state.ws.send_json({
                    "type": "broadcast",
                    "payload": protocol.make_scene_mesh(oid, mesh_path),
                })
                if oid in _state.managed:
                    _state.managed[oid]["mesh_path"] = mesh_path
                count += 1

        self.report({"INFO"}, f"{count} 個のメッシュを再送信しました")
        return {"FINISHED"}


# ---------------------------------------------------------------------------
# Properties
# ---------------------------------------------------------------------------

class SceneSyncSettings(PropertyGroup):
    presence_url: StringProperty(
        name="サーバー URL",
        default="wss://afjk.jp/presence",
        description="Scene Sync presence server の WebSocket URL",
    )  # type: ignore[assignment]

    room: StringProperty(
        name="ルーム",
        default="",
        description="参加するルーム ID",
    )  # type: ignore[assignment]

    nickname: StringProperty(
        name="ニックネーム",
        default="Blender",
        description="表示名",
    )  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Panel
# ---------------------------------------------------------------------------

class SCENE_SYNC_PT_panel(Panel):
    bl_label = "Scene Sync"
    bl_idname = "SCENE_SYNC_PT_panel"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Scene Sync"

    def draw(self, context):
        layout = self.layout
        settings = context.scene.scene_sync
        connected = _state.ws.connected

        # Connection settings
        col = layout.column(align=True)
        col.enabled = not connected
        col.prop(settings, "presence_url", text="URL")
        col.prop(settings, "room", text="ルーム")
        col.prop(settings, "nickname", text="名前")

        layout.separator()

        row = layout.row(align=True)
        if connected:
            row.operator("scene_sync.disconnect", icon="UNLINKED")
        else:
            row.operator("scene_sync.connect", icon="LINKED")

        # Status
        box = layout.box()
        box.label(text=_state.status, icon="INFO")

        if connected:
            layout.separator()
            layout.operator("scene_sync.sync_meshes", icon="EXPORT")

            # Peers
            if _state.peers:
                layout.separator()
                layout.label(text="参加者:", icon="COMMUNITY")
                for peer in _state.peers:
                    nick = str(peer.get("nickname", peer.get("id", "?")))
                    row = layout.row()
                    row.label(text=f"  {nick}")


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

_classes = (
    SceneSyncSettings,
    SCENE_SYNC_OT_connect,
    SCENE_SYNC_OT_disconnect,
    SCENE_SYNC_OT_sync_meshes,
    SCENE_SYNC_PT_panel,
)


def register():
    for cls in _classes:
        bpy.utils.register_class(cls)
    bpy.types.Scene.scene_sync = bpy.props.PointerProperty(type=SceneSyncSettings)
    bpy.app.timers.register(_timer_callback, first_interval=POLL_INTERVAL, persistent=True)


def unregister():
    if bpy.app.timers.is_registered(_timer_callback):
        bpy.app.timers.unregister(_timer_callback)
    del bpy.types.Scene.scene_sync
    for cls in reversed(_classes):
        bpy.utils.unregister_class(cls)
    _state.ws.disconnect()
