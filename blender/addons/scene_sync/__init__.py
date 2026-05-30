"""Scene Sync Blender addon."""

from __future__ import annotations

import time

import bpy
from bpy.props import BoolProperty, FloatProperty, StringProperty
from bpy.types import Operator, Panel, PropertyGroup

from . import blob_client, protocol, ws_client
from .glb_helper import export_object_as_glb, import_glb, object_has_animation

bl_info = {
    "name": "Scene Sync",
    "author": "afjk",
    "version": (0, 19, 6),
    "blender": (4, 0, 0),
    "location": "View3D > Sidebar > Scene Sync",
    "description": "Scene Sync authoring addon for Blender",
    "category": "3D View",
    "doc_url": "https://github.com/afjk/afjk.jp",
}

POLL_INTERVAL = 0.05
DELTA_THRESHOLD = 0.0001
OBJECT_ID_PROP = "scene_sync_id"
REMOTE_PROP = "scene_sync_remote"
MESH_PATH_PROP = "scene_sync_mesh_path"
ASSET_ID_PROP = "scene_sync_asset_id"
ORIGIN_PROP = "scene_sync_origin"


class _State:
    def __init__(self) -> None:
        self.ws = ws_client.SceneSyncWSClient()
        self.blob_url = ""
        self.status = "未接続"
        self.peers: list[dict] = []
        self.managed: dict[str, dict] = {}
        self.locks: dict[str, str] = {}
        self.scene_received = False
        self.first_peers_seen = False
        self.env_id: str | None = None
        self.currently_locked_object_id: str | None = None
        self.last_tick = 0.0

    def reset_connection_state(self) -> None:
        self.status = "未接続"
        self.peers = []
        self.locks.clear()
        self.scene_received = False
        self.first_peers_seen = False
        self.currently_locked_object_id = None

    def reset_tracking(self) -> None:
        self.managed.clear()
        self.locks.clear()
        self.scene_received = False
        self.first_peers_seen = False
        self.currently_locked_object_id = None


_state = _State()


def _settings():
    scene = getattr(bpy.context, "scene", None)
    return getattr(scene, "scene_sync", None)


def _snap(loc, rot, scale, visible: bool) -> list:
    return [list(loc), list(rot), list(scale), [1.0 if visible else 0.0]]


def _snaps_equal(a: list, b: list) -> bool:
    if not a or not b or len(a) != len(b):
        return False
    for va, vb in zip(a, b):
        if len(va) != len(vb):
            return False
        for x, y in zip(va, vb):
            if abs(float(x) - float(y)) > DELTA_THRESHOLD:
                return False
    return True


def _is_visible(obj: bpy.types.Object) -> bool:
    return not bool(obj.hide_viewport)


def _obj_snapshot(obj: bpy.types.Object) -> list:
    loc, rot, scale = obj.matrix_world.decompose()
    return _snap(
        protocol.pos_to_wire(loc),
        protocol.rot_to_wire(rot),
        protocol.scale_to_wire(scale),
        _is_visible(obj),
    )


def _has_mesh_visual(obj: bpy.types.Object) -> bool:
    if obj.type == "MESH":
        return True
    return any(child.type == "MESH" for child in obj.children_recursive)


def _is_local_authoring_object(obj: bpy.types.Object) -> bool:
    return bool(obj) and not bool(obj.get(REMOTE_PROP)) and _has_mesh_visual(obj)


def _resolve_sync_root(obj: bpy.types.Object | None) -> bpy.types.Object | None:
    current = obj
    while current is not None:
        if current.get(OBJECT_ID_PROP):
            return current
        current = current.parent
    return obj


def _find_blender_obj(object_id: str) -> bpy.types.Object | None:
    for obj in bpy.data.objects:
        if obj.get(OBJECT_ID_PROP) == object_id:
            return obj
    return None


def _selected_roots() -> list[bpy.types.Object]:
    result = []
    seen = set()
    for obj in bpy.context.selected_objects:
        root = _resolve_sync_root(obj)
        if root is None:
            continue
        if root.name in seen:
            continue
        seen.add(root.name)
        result.append(root)

    # If a parent and its children are selected together, publish only the
    # highest selected parent. One selected root maps to one Scene Sync object.
    selected_names = {obj.name for obj in result}
    filtered = []
    for obj in result:
        current = obj.parent
        has_selected_ancestor = False
        while current is not None:
            if current.name in selected_names:
                has_selected_ancestor = True
                break
            current = current.parent
        if not has_selected_ancestor:
            filtered.append(obj)

    return filtered


def _asset_from_payload(payload: dict) -> dict | None:
    asset = payload.get("asset")
    if isinstance(asset, dict):
        mesh_path = payload.get("meshPath")
        asset_id = payload.get("assetId")
        if mesh_path and not asset.get("meshPath"):
            asset = {**asset, "meshPath": mesh_path}
        if asset_id and not asset.get("assetId"):
            asset = {**asset, "assetId": asset_id}
        return asset
    mesh_path = payload.get("meshPath")
    if mesh_path:
        return protocol.build_mesh_asset(str(mesh_path), payload.get("assetId"))
    return None


def _metadata_from_payload(payload: dict) -> dict | None:
    metadata = payload.get("metadata")
    return metadata if isinstance(metadata, dict) else None


def _animation_from_payload(payload: dict) -> dict | None:
    animation = payload.get("animation")
    return animation if isinstance(animation, dict) else None


def _remember_object(
    object_id: str,
    obj: bpy.types.Object,
    *,
    remote: bool,
    mesh_path: str = "",
    asset_id: str | None = None,
    asset: dict | None = None,
    metadata: dict | None = None,
    animation: dict | None = None,
    origin: str | None = None,
) -> None:
    obj[OBJECT_ID_PROP] = object_id
    obj[REMOTE_PROP] = bool(remote)
    if mesh_path:
        obj[MESH_PATH_PROP] = mesh_path
    if asset_id:
        obj[ASSET_ID_PROP] = asset_id
    if origin:
        obj[ORIGIN_PROP] = origin

    _state.managed[object_id] = {
        "name": obj.name,
        "snapshot": _obj_snapshot(obj),
        "remote": bool(remote),
        "mesh_path": mesh_path,
        "asset_id": asset_id,
        "asset": asset,
        "metadata": metadata,
        "animation": animation,
        "origin": origin or ("remote" if remote else "blender"),
    }


def _clear_publish_asset_props(obj: bpy.types.Object | None) -> None:
    if obj is None:
        return
    for key in (MESH_PATH_PROP, ASSET_ID_PROP):
        if key in obj:
            del obj[key]


def _walk_object_hierarchy(root: bpy.types.Object) -> list[bpy.types.Object]:
    items = [root]
    for child in root.children:
        items.extend(_walk_object_hierarchy(child))
    return items


def _remove_object_hierarchy(root: bpy.types.Object | None) -> None:
    if root is None:
        return
    for obj in reversed(_walk_object_hierarchy(root)):
        if obj.name in bpy.data.objects:
            bpy.data.objects.remove(obj, do_unlink=True)


def _mark_remote(obj: bpy.types.Object) -> None:
    obj[REMOTE_PROP] = True
    for child in obj.children:
        _mark_remote(child)


def _clear_remote_objects() -> None:
    for object_id, info in list(_state.managed.items()):
        if not info.get("remote"):
            continue
        obj = _find_blender_obj(object_id)
        _remove_object_hierarchy(obj)
        _state.managed.pop(object_id, None)

    # Catch orphaned remote children left by older addon versions.
    for obj in sorted(list(bpy.data.objects), key=lambda item: len(item.children_recursive), reverse=True):
        if obj.get(REMOTE_PROP):
            _remove_object_hierarchy(obj)


def _handle_ws_messages() -> None:
    for msg in _state.ws.poll():
        internal = msg.get("_internal")
        if internal == "_connected":
            _state.status = f"接続中 - {_state.ws.room or 'room pending'}"
            _force_redraw()
            continue
        if internal == "_disconnected":
            _state.reset_connection_state()
            _force_redraw()
            continue

        msg_type = msg.get("type", "")
        if msg_type == "welcome":
            _state.ws.my_id = str(msg.get("id", ""))
            _state.ws.room = str(msg.get("room", _state.ws.room))
            _state.status = f"接続中 - {_state.ws.room}"
            _force_redraw()

        elif msg_type == "peers":
            raw = msg.get("peers", [])
            _state.peers = [p for p in raw if isinstance(p, dict)]
            _state.ws.peers = _state.peers
            _state.status = f"接続中 - {_state.ws.room} - {len(_state.peers)} peers"
            if not _state.first_peers_seen and _state.peers:
                _state.first_peers_seen = True
                if not _state.scene_received:
                    _request_scene()
            _force_redraw()

        elif msg_type == "handoff":
            payload = msg.get("payload", {})
            from_info = msg.get("from", {})
            if isinstance(payload, dict):
                _handle_payload(payload, from_info if isinstance(from_info, dict) else {})

        elif msg_type == "ping":
            _state.ws.send_json({"type": "pong"})


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


def _handle_payload(payload: dict, from_info: dict) -> None:
    from_id = str(from_info.get("id", ""))
    if from_id and from_id == _state.ws.my_id:
        return

    kind = str(payload.get("kind", ""))
    if kind == "scene-request":
        _send_scene_state(from_id)
    elif kind == "scene-state":
        _apply_scene_state(payload)
    elif kind == "scene-batch":
        for op in payload.get("ops") or payload.get("actions") or []:
            if isinstance(op, dict):
                _handle_payload(op, from_info)
    elif kind == "scene-add":
        _apply_scene_add(payload)
    elif kind == "scene-delta":
        _apply_scene_delta(payload)
    elif kind in {"scene-remove", "scene-delete"}:
        _apply_scene_remove(payload)
    elif kind == "scene-mesh":
        _apply_scene_mesh(payload)
    elif kind == "scene-env":
        env_id = payload.get("envId")
        if isinstance(env_id, str) and env_id:
            _state.env_id = env_id
    elif kind == "scene-lock":
        object_id = str(payload.get("objectId", ""))
        if object_id and from_id:
            _state.locks[object_id] = from_id
    elif kind == "scene-unlock":
        object_id = str(payload.get("objectId", ""))
        _state.locks.pop(object_id, None)


def _apply_scene_state(payload: dict) -> None:
    _state.scene_received = True
    env_id = payload.get("envId")
    if isinstance(env_id, str) and env_id:
        _state.env_id = env_id

    objects = payload.get("objects", {})
    if not isinstance(objects, dict):
        return
    for object_id, info in objects.items():
        if isinstance(info, dict):
            _apply_scene_add({**info, "objectId": object_id})


def _apply_scene_add(payload: dict) -> None:
    object_id = str(payload.get("objectId", ""))
    if not object_id:
        return

    existing = _find_blender_obj(object_id)
    if existing is not None:
        _apply_scene_delta(payload)
        return

    name = str(payload.get("name", object_id))
    asset = _asset_from_payload(payload)
    metadata = _metadata_from_payload(payload)
    animation = _animation_from_payload(payload)
    mesh_path = str(payload.get("meshPath") or (asset or {}).get("meshPath") or "")
    asset_id = payload.get("assetId") or (asset or {}).get("assetId")
    origin = str(payload.get("origin", "remote"))
    obj = _create_object_for_asset(name, asset, metadata, mesh_path)

    _mark_remote(obj)
    _apply_transform(obj, protocol.extract_transform(payload))
    if "visible" in payload:
        _set_visible(obj, bool(payload.get("visible")))

    _remember_object(
        object_id,
        obj,
        remote=True,
        mesh_path=mesh_path,
        asset_id=str(asset_id) if asset_id else None,
        asset=asset,
        metadata=metadata,
        animation=animation,
        origin=origin,
    )


def _apply_scene_delta(payload: dict) -> None:
    object_id = str(payload.get("objectId", ""))
    obj = _find_blender_obj(object_id)
    if obj is None:
        return

    name = payload.get("name")
    if isinstance(name, str) and name:
        obj.name = name

    if "visible" in payload:
        _set_visible(obj, bool(payload.get("visible")))

    _apply_transform(obj, protocol.extract_transform(payload))

    if object_id in _state.managed:
        info = _state.managed[object_id]
        info["name"] = obj.name
        info["snapshot"] = _obj_snapshot(obj)
        asset = _asset_from_payload(payload)
        metadata = _metadata_from_payload(payload)
        animation = _animation_from_payload(payload)
        if asset is not None:
            info["asset"] = asset
            mesh_path = asset.get("meshPath")
            asset_id = asset.get("assetId")
            if mesh_path:
                info["mesh_path"] = mesh_path
                obj[MESH_PATH_PROP] = mesh_path
            if asset_id:
                info["asset_id"] = asset_id
                obj[ASSET_ID_PROP] = asset_id
        if metadata is not None:
            info["metadata"] = metadata
        if animation is not None:
            info["animation"] = animation


def _apply_scene_remove(payload: dict) -> None:
    object_id = str(payload.get("objectId", ""))
    info = _state.managed.get(object_id)
    obj = _find_blender_obj(object_id)

    if info and not info.get("remote"):
        # Blender is an authoring tool, not a runtime. Remote removal unpublishes
        # the local source object but never deletes it from the .blend scene.
        _clear_publish_asset_props(obj)
        del _state.managed[object_id]
        _state.locks.pop(object_id, None)
        return

    _remove_object_hierarchy(obj)
    _state.managed.pop(object_id, None)
    _state.locks.pop(object_id, None)


def _apply_scene_mesh(payload: dict) -> None:
    object_id = str(payload.get("objectId", ""))
    asset = _asset_from_payload(payload)
    mesh_path = str(payload.get("meshPath") or (asset or {}).get("meshPath") or "")
    if not object_id or not mesh_path:
        return

    data = blob_client.download_glb(_state.blob_url, mesh_path)
    if not data:
        return

    old = _find_blender_obj(object_id)
    info = _state.managed.get(object_id, {})
    if info and not info.get("remote"):
        info["mesh_path"] = mesh_path
        info["asset"] = asset
        if old is not None:
            old[MESH_PATH_PROP] = mesh_path
        return

    name = str(payload.get("name") or (old.name if old else object_id))
    visual_basis = (asset or {}).get("visualBasis")
    new = import_glb(data, name, visual_basis)
    if new is None:
        return
    _mark_remote(new)
    if old is not None:
        new.matrix_world = old.matrix_world.copy()
        _remove_object_hierarchy(old)
    _remember_object(
        object_id,
        new,
        remote=True,
        mesh_path=mesh_path,
        asset_id=(asset or {}).get("assetId"),
        asset=asset,
        metadata=info.get("metadata"),
        animation=info.get("animation"),
        origin=info.get("origin", "remote"),
    )


def _create_object_for_asset(
    name: str,
    asset: dict | None,
    metadata: dict | None,
    mesh_path: str,
) -> bpy.types.Object:
    asset_type = (asset or {}).get("type")
    if asset_type == "primitive":
        return _create_primitive(
            str((asset or {}).get("primitive", "box")),
            str((asset or {}).get("color", "#888888")),
            name,
        )

    if asset_type == "text":
        return _create_text_placeholder(name, str((asset or {}).get("text", name)))

    if mesh_path:
        data = blob_client.download_glb(_state.blob_url, mesh_path)
        if data:
            imported = import_glb(data, name, (asset or {}).get("visualBasis"))
            if imported is not None:
                return imported

    label = asset_type or (metadata or {}).get("role") or "remote"
    return _create_primitive("box", "#88ccff", f"{name} ({label})")


def _send_scene_state(to_peer_id: str) -> None:
    if not to_peer_id:
        return

    objects = {}
    for object_id, info in list(_state.managed.items()):
        obj = _find_blender_obj(object_id)
        if obj is None:
            continue
        loc, rot, scale = obj.matrix_world.decompose()
        entry = {
            "name": obj.name,
            "origin": info.get("origin") or ("remote" if info.get("remote") else "blender"),
            "position": protocol.pos_to_wire(loc),
            "rotation": protocol.rot_to_wire(rot),
            "scale": protocol.scale_to_wire(scale),
            "visible": _is_visible(obj),
        }
        mesh_path = info.get("mesh_path") or obj.get(MESH_PATH_PROP)
        asset_id = info.get("asset_id") or obj.get(ASSET_ID_PROP)
        asset = info.get("asset")
        metadata = info.get("metadata")
        animation = info.get("animation")
        if mesh_path:
            entry["meshPath"] = mesh_path
        if asset_id:
            entry["assetId"] = asset_id
        if asset:
            entry["asset"] = asset
        elif mesh_path:
            entry["asset"] = protocol.build_mesh_asset(mesh_path, asset_id)
        if metadata:
            entry["metadata"] = metadata
        if animation:
            entry["animation"] = animation
        objects[object_id] = entry

    _state.ws.send_json({
        "type": "handoff",
        "targetId": to_peer_id,
        "payload": protocol.make_scene_state(objects, _state.env_id),
    })


def _check_scene_changes() -> None:
    if not _state.ws.connected:
        return

    current_ids = set()
    for object_id, info in list(_state.managed.items()):
        obj = _find_blender_obj(object_id)
        if obj is None:
            _state.ws.send_json({
                "type": "broadcast",
                "payload": protocol.make_scene_remove(object_id),
            })
            _state.managed.pop(object_id, None)
            continue

        current_ids.add(object_id)
        snap = _obj_snapshot(obj)
        if not _snaps_equal(snap, info.get("snapshot")):
            info["snapshot"] = snap
            loc, rot, scale = obj.matrix_world.decompose()
            _state.ws.send_json({
                "type": "broadcast",
                "payload": protocol.make_scene_delta(
                    object_id,
                    loc,
                    rot,
                    scale,
                    name=obj.name,
                    visible=_is_visible(obj),
                ),
            })

    _update_selection_lock(current_ids)


def _update_selection_lock(current_ids: set[str]) -> None:
    active = _resolve_sync_root(bpy.context.view_layer.objects.active)
    object_id = None
    if active is not None:
        maybe_id = str(active.get(OBJECT_ID_PROP, ""))
        if maybe_id in current_ids:
            object_id = maybe_id

    if object_id == _state.currently_locked_object_id:
        return

    if _state.currently_locked_object_id:
        _state.ws.send_json({
            "type": "broadcast",
            "payload": protocol.make_scene_unlock(_state.currently_locked_object_id),
        })

    _state.currently_locked_object_id = object_id
    if object_id:
        _state.ws.send_json({
            "type": "broadcast",
            "payload": protocol.make_scene_lock(object_id),
        })


def _publish_object(obj: bpy.types.Object, *, force_upload: bool = False) -> bool:
    if not _is_local_authoring_object(obj):
        return False

    object_id = str(obj.get(OBJECT_ID_PROP, "")) or protocol.generate_object_id()
    obj[OBJECT_ID_PROP] = object_id
    obj[ORIGIN_PROP] = "blender"

    settings = _settings()
    include_animations = bool(getattr(settings, "export_animations", True))
    has_animation = include_animations and object_has_animation(obj)

    loc, rot, scale = obj.matrix_world.decompose()
    glb = export_object_as_glb(obj, include_animations=include_animations)
    if not glb:
        return False

    max_mib = float(getattr(settings, "max_upload_mib", 50.0) or 50.0)
    if len(glb) > max_mib * 1024 * 1024:
        print(f"[SceneSync] GLB upload skipped: {obj.name} is larger than {max_mib:.1f} MiB")
        return False

    mesh_path = protocol.generate_mesh_path()
    asset_id = protocol.compute_asset_id(glb)
    if not blob_client.upload_glb(_state.blob_url, mesh_path, glb):
        return False

    asset = protocol.build_mesh_asset(
        mesh_path,
        asset_id,
        size=len(glb),
        original_name=obj.name,
    )
    if has_animation:
        asset["animation"] = True

    metadata = None
    animation = None
    if has_animation:
        metadata = {
            "animationExport": {
                "source": "blender",
                "enabled": True,
            }
        }
        animation = {
            "enabled": True,
            "clip": 0,
            "mode": "loop",
            "speed": 1,
        }

    payload = protocol.make_scene_add(
        object_id,
        obj.name,
        loc,
        rot,
        scale,
        mesh_path=mesh_path,
        asset_id=asset_id,
        asset=asset,
        metadata=metadata,
        animation=animation,
        visible=_is_visible(obj),
        origin="blender",
    )
    _state.ws.send_json({"type": "broadcast", "payload": payload})
    _remember_object(
        object_id,
        obj,
        remote=False,
        mesh_path=mesh_path,
        asset_id=asset_id,
        asset=asset,
        metadata=metadata,
        animation=animation,
        origin="blender",
    )
    return True


def _unpublish_object(obj: bpy.types.Object) -> bool:
    object_id = str(obj.get(OBJECT_ID_PROP, ""))
    if not object_id:
        return False
    if _state.ws.connected:
        _state.ws.send_json({
            "type": "broadcast",
            "payload": protocol.make_scene_remove(object_id),
        })
    _clear_publish_asset_props(obj)
    _state.managed.pop(object_id, None)
    _state.locks.pop(object_id, None)
    return True


def _set_visible(obj: bpy.types.Object, visible: bool) -> None:
    obj.hide_viewport = not visible
    obj.hide_render = not visible


def _create_primitive(primitive: str, color_hex: str, name: str) -> bpy.types.Object:
    dispatch = {
        "box": lambda: bpy.ops.mesh.primitive_cube_add(size=1),
        "cube": lambda: bpy.ops.mesh.primitive_cube_add(size=1),
        "sphere": lambda: bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5),
        "cylinder": lambda: bpy.ops.mesh.primitive_cylinder_add(radius=0.5, depth=1),
        "cone": lambda: bpy.ops.mesh.primitive_cone_add(radius1=0.5, depth=1),
        "plane": lambda: bpy.ops.mesh.primitive_plane_add(size=1),
        "torus": lambda: bpy.ops.mesh.primitive_torus_add(),
    }
    dispatch.get(primitive, dispatch["box"])()
    obj = bpy.context.active_object
    obj.name = name
    mat = bpy.data.materials.new(f"SceneSync_{name}")
    mat.use_nodes = True
    principled = mat.node_tree.nodes.get("Principled BSDF")
    if principled:
        r, g, b = protocol.hex_to_rgb(color_hex)
        principled.inputs["Base Color"].default_value = (r, g, b, 1.0)
    obj.data.materials.append(mat)
    return obj


def _create_text_placeholder(name: str, text: str) -> bpy.types.Object:
    bpy.ops.object.text_add()
    obj = bpy.context.active_object
    obj.name = name
    obj.data.body = text[:512]
    obj.data.align_x = "CENTER"
    obj.data.align_y = "CENTER"
    obj.data.size = 0.4
    return obj


def _apply_transform(obj: bpy.types.Object, tf: dict) -> None:
    from mathutils import Matrix

    if not tf:
        return

    cur_loc, cur_rot, cur_scl = obj.matrix_world.decompose()
    loc = tf.get("loc", cur_loc)
    rot = tf.get("rot", cur_rot)
    scale = tf.get("scale", cur_scl)
    obj.matrix_world = (
        Matrix.Translation(loc)
        @ rot.to_matrix().to_4x4()
        @ Matrix.Diagonal([scale.x, scale.y, scale.z, 1.0])
    )


def _timer_callback() -> float:
    try:
        _handle_ws_messages()
        now = time.monotonic()
        if _state.ws.connected and now - _state.last_tick >= POLL_INTERVAL:
            _state.last_tick = now
            _check_scene_changes()
    except Exception as e:
        print(f"[SceneSync] Timer error: {e}")
    return POLL_INTERVAL


def _force_redraw() -> None:
    screen = getattr(bpy.context, "screen", None)
    for area in screen.areas if screen else []:
        if area.type == "VIEW_3D":
            area.tag_redraw()


class SCENE_SYNC_OT_connect(Operator):
    bl_idname = "scene_sync.connect"
    bl_label = "接続"
    bl_description = "Scene Sync サーバーに接続する"

    def execute(self, context):
        settings = context.scene.scene_sync
        url = settings.presence_url.strip()
        room = settings.room.strip()
        nickname = settings.nickname.strip() or "Blender"

        _clear_remote_objects()
        _state.blob_url = settings.blob_url.strip() or blob_client.presence_url_to_blob_url(url)
        _state.reset_tracking()
        _state.status = "接続中..."
        _state.ws.connect(url, room, nickname, f"Blender {bpy.app.version_string}")
        return {"FINISHED"}


class SCENE_SYNC_OT_disconnect(Operator):
    bl_idname = "scene_sync.disconnect"
    bl_label = "切断"
    bl_description = "Scene Sync サーバーから切断する"

    def execute(self, context):
        _clear_remote_objects()
        _state.ws.disconnect()
        _state.reset_connection_state()
        _force_redraw()
        return {"FINISHED"}


class SCENE_SYNC_OT_publish_selected(Operator):
    bl_idname = "scene_sync.publish_selected"
    bl_label = "選択を Publish"
    bl_description = "選択中の Blender オブジェクトを Scene Sync に公開する"

    def execute(self, context):
        if not _state.ws.connected:
            self.report({"WARNING"}, "接続されていません")
            return {"CANCELLED"}

        count = sum(1 for obj in _selected_roots() if _publish_object(obj, force_upload=True))
        self.report({"INFO"}, f"{count} 個のオブジェクトを Publish しました")
        return {"FINISHED"}


class SCENE_SYNC_OT_publish_all_meshes(Operator):
    bl_idname = "scene_sync.publish_all_meshes"
    bl_label = "全メッシュを Publish"
    bl_description = "シーン内のローカルメッシュを Scene Sync に公開する"

    def execute(self, context):
        if not _state.ws.connected:
            self.report({"WARNING"}, "接続されていません")
            return {"CANCELLED"}

        count = 0
        for obj in context.scene.objects:
            if obj.parent is None and _publish_object(obj, force_upload=True):
                count += 1
        self.report({"INFO"}, f"{count} 個のオブジェクトを Publish しました")
        return {"FINISHED"}


class SCENE_SYNC_OT_unpublish_selected(Operator):
    bl_idname = "scene_sync.unpublish_selected"
    bl_label = "選択を Unpublish"
    bl_description = "選択中のオブジェクトを Scene Sync から削除する。Blender の原本は削除しない"

    def execute(self, context):
        count = sum(1 for obj in _selected_roots() if _unpublish_object(obj))
        self.report({"INFO"}, f"{count} 個のオブジェクトを Unpublish しました")
        return {"FINISHED"}


class SCENE_SYNC_OT_sync_meshes(Operator):
    bl_idname = "scene_sync.sync_meshes"
    bl_label = "公開済みメッシュを再送信"
    bl_description = "公開済みローカルメッシュを再エクスポートして blob にアップロードする"

    def execute(self, context):
        if not _state.ws.connected:
            self.report({"WARNING"}, "接続されていません")
            return {"CANCELLED"}

        count = 0
        for object_id, info in list(_state.managed.items()):
            if info.get("remote"):
                continue
            obj = _find_blender_obj(object_id)
            if obj is not None and _publish_object(obj, force_upload=True):
                count += 1
        self.report({"INFO"}, f"{count} 個のメッシュを再送信しました")
        return {"FINISHED"}


class SceneSyncSettings(PropertyGroup):
    presence_url: StringProperty(
        name="サーバー URL",
        default="wss://afjk.jp/presence",
        description="Scene Sync presence server の WebSocket URL",
    )  # type: ignore[assignment]

    blob_url: StringProperty(
        name="Blob URL",
        default="",
        description="空の場合はサーバー URL から /blob を自動推定します",
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

    max_upload_mib: FloatProperty(
        name="最大 GLB サイズ (MiB)",
        default=50.0,
        min=1.0,
        description="このサイズを超える GLB はアップロードしません",
    )  # type: ignore[assignment]

    export_animations: BoolProperty(
        name="Animation を GLB に含める",
        default=True,
        description="Action / NLA / Armature / shape key animation を GLB carrier に含めます",
    )  # type: ignore[assignment]


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

        col = layout.column(align=True)
        col.enabled = not connected
        col.prop(settings, "presence_url", text="URL")
        col.prop(settings, "blob_url", text="Blob")
        col.prop(settings, "room", text="ルーム")
        col.prop(settings, "nickname", text="名前")

        row = layout.row(align=True)
        if connected:
            row.operator("scene_sync.disconnect", icon="UNLINKED")
        else:
            row.operator("scene_sync.connect", icon="LINKED")

        box = layout.box()
        box.label(text=_state.status, icon="INFO")
        if connected:
            box.label(text=f"Room: {_state.ws.room or '-'}")
            box.label(text=f"Managed: {len(_state.managed)} / Peers: {len(_state.peers)}")

        layout.separator()
        layout.label(text="Authoring", icon="OUTLINER_OB_MESH")
        col = layout.column(align=True)
        col.enabled = connected
        col.operator("scene_sync.publish_selected", icon="EXPORT")
        col.operator("scene_sync.publish_all_meshes", icon="OUTLINER_COLLECTION")
        col.operator("scene_sync.sync_meshes", icon="FILE_REFRESH")
        col.operator("scene_sync.unpublish_selected", icon="TRASH")

        layout.separator()
        layout.prop(settings, "max_upload_mib")
        layout.prop(settings, "export_animations")

        if connected and _state.peers:
            layout.separator()
            layout.label(text="参加者:", icon="COMMUNITY")
            for peer in _state.peers:
                nick = str(peer.get("nickname") or peer.get("id") or "?")
                device = str(peer.get("device") or "")
                layout.label(text=f"{nick} {f'({device})' if device else ''}")


_classes = (
    SceneSyncSettings,
    SCENE_SYNC_OT_connect,
    SCENE_SYNC_OT_disconnect,
    SCENE_SYNC_OT_publish_selected,
    SCENE_SYNC_OT_publish_all_meshes,
    SCENE_SYNC_OT_unpublish_selected,
    SCENE_SYNC_OT_sync_meshes,
    SCENE_SYNC_PT_panel,
)


def register():
    for cls in _classes:
        bpy.utils.register_class(cls)
    bpy.types.Scene.scene_sync = bpy.props.PointerProperty(type=SceneSyncSettings)
    if not bpy.app.timers.is_registered(_timer_callback):
        bpy.app.timers.register(_timer_callback, first_interval=POLL_INTERVAL, persistent=True)


def unregister():
    if bpy.app.timers.is_registered(_timer_callback):
        bpy.app.timers.unregister(_timer_callback)
    if hasattr(bpy.types.Scene, "scene_sync"):
        del bpy.types.Scene.scene_sync
    for cls in reversed(_classes):
        bpy.utils.unregister_class(cls)
    _state.ws.disconnect()
