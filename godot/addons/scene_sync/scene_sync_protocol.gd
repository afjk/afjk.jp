class_name SceneSyncProtocol
extends RefCounted


static func pos_to_wire(v: Vector3) -> Array:
    return [v.x, v.y, v.z]


static func pos_from_wire(arr: Array) -> Vector3:
    if arr.size() < 3:
        return Vector3.ZERO
    return Vector3(float(arr[0]), float(arr[1]), float(arr[2]))


static func rot_to_wire(q: Quaternion) -> Array:
    return [q.x, q.y, q.z, q.w]


static func rot_from_wire(arr: Array) -> Quaternion:
    if arr.size() < 4:
        return Quaternion.IDENTITY
    return Quaternion(float(arr[0]), float(arr[1]), float(arr[2]), float(arr[3]))


static func scale_to_wire(v: Vector3) -> Array:
    return [v.x, v.y, v.z]


static func scale_from_wire(arr: Array) -> Vector3:
    if arr.size() < 3:
        return Vector3.ONE
    return Vector3(float(arr[0]), float(arr[1]), float(arr[2]))


static func make_scene_delta(
    object_id: String,
    pos: Vector3,
    rot: Quaternion,
    scl: Vector3,
    obj_name: String = "",
    visible: Variant = null,
    asset: Dictionary = {},
    metadata: Dictionary = {},
    animation: Variant = null,
    physics: Variant = null,
    include_physics: bool = false,
    include_animation: bool = false
) -> Dictionary:
    var msg := {
        "kind": "scene-delta",
        "objectId": object_id,
        "position": pos_to_wire(pos),
        "rotation": rot_to_wire(rot),
        "scale": scale_to_wire(scl),
    }
    if obj_name != "":
        msg["name"] = obj_name
    if visible != null:
        msg["visible"] = bool(visible)
    if not asset.is_empty():
        msg["asset"] = asset.duplicate(true)
    if not metadata.is_empty():
        msg["metadata"] = metadata.duplicate(true)
    if animation is Dictionary:
        msg["animation"] = (animation as Dictionary).duplicate(true)
    elif include_animation:
        msg["animation"] = null
    if physics is Dictionary:
        msg["physics"] = (physics as Dictionary).duplicate(true)
    elif include_physics:
        msg["physics"] = null
    return msg


static func make_scene_add(
    object_id: String,
    obj_name: String,
    pos: Vector3,
    rot: Quaternion,
    scl: Vector3,
    mesh_path: String = "",
    asset: Dictionary = {},
    asset_id: String = "",
    metadata: Dictionary = {},
    origin: String = "",
    unity_hierarchy_path: String = "",
    visible: bool = true,
    animation: Variant = null,
    physics: Variant = null,
    include_physics: bool = false,
    include_animation: bool = false
) -> Dictionary:
    var msg := {
        "kind": "scene-add",
        "objectId": object_id,
        "name": obj_name,
        "position": pos_to_wire(pos),
        "rotation": rot_to_wire(rot),
        "scale": scale_to_wire(scl),
        "visible": visible,
    }
    if origin != "":
        msg["origin"] = origin
    if unity_hierarchy_path != "":
        msg["unityHierarchyPath"] = unity_hierarchy_path
    if mesh_path != "":
        msg["meshPath"] = mesh_path
    if asset_id != "":
        msg["assetId"] = asset_id
    if not asset.is_empty():
        msg["asset"] = asset.duplicate(true)
    if not metadata.is_empty():
        msg["metadata"] = metadata.duplicate(true)
    if animation is Dictionary:
        msg["animation"] = (animation as Dictionary).duplicate(true)
    elif include_animation:
        msg["animation"] = null
    if physics is Dictionary:
        msg["physics"] = (physics as Dictionary).duplicate(true)
    elif include_physics:
        msg["physics"] = null
    return msg


static func make_scene_remove(object_id: String) -> Dictionary:
    return {"kind": "scene-remove", "objectId": object_id}


static func make_scene_mesh(
    object_id: String,
    mesh_path: String,
    asset_id: String = "",
    asset: Dictionary = {},
    metadata: Dictionary = {},
    origin: String = "",
    unity_hierarchy_path: String = "",
    animation: Variant = null,
    physics: Variant = null,
    include_physics: bool = false,
    include_animation: bool = false
) -> Dictionary:
    var msg := {"kind": "scene-mesh", "objectId": object_id, "meshPath": mesh_path}
    if asset_id != "":
        msg["assetId"] = asset_id
    if origin != "":
        msg["origin"] = origin
    if unity_hierarchy_path != "":
        msg["unityHierarchyPath"] = unity_hierarchy_path
    if not asset.is_empty():
        msg["asset"] = asset.duplicate(true)
    if not metadata.is_empty():
        msg["metadata"] = metadata.duplicate(true)
    if animation is Dictionary:
        msg["animation"] = (animation as Dictionary).duplicate(true)
    elif include_animation:
        msg["animation"] = null
    if physics is Dictionary:
        msg["physics"] = (physics as Dictionary).duplicate(true)
    elif include_physics:
        msg["physics"] = null
    return msg


static func make_scene_lock(object_id: String) -> Dictionary:
    return {"kind": "scene-lock", "objectId": object_id}


static func make_scene_unlock(object_id: String) -> Dictionary:
    return {"kind": "scene-unlock", "objectId": object_id}


static func make_scene_request() -> Dictionary:
    return {"kind": "scene-request"}


static func make_scene_state(
    objects: Dictionary,
    loom_graphs: Dictionary = {},
    env_id: String = "",
    physics: Variant = null,
    include_physics: bool = false
) -> Dictionary:
    var msg := {"kind": "scene-state", "objects": objects}
    if env_id != "":
        msg["envId"] = env_id
    if not loom_graphs.is_empty():
        msg["loomGraphs"] = loom_graphs.duplicate(true)
    if physics is Dictionary:
        msg["physics"] = (physics as Dictionary).duplicate(true)
    elif include_physics:
        msg["physics"] = null
    return msg


static func make_scene_physics(physics: Variant, include_physics: bool = true) -> Dictionary:
    var msg := {"kind": "scene-physics"}
    if physics is Dictionary:
        msg["physics"] = (physics as Dictionary).duplicate(true)
    elif include_physics:
        msg["physics"] = null
    return msg


static func make_scene_env(env_id: String) -> Dictionary:
    return {"kind": "scene-env", "envId": env_id}


static func make_scene_batch(ops: Array) -> Dictionary:
    return {"kind": "scene-batch", "ops": ops}


static func make_scene_graph_set(graph: Dictionary, object_id: String = "") -> Dictionary:
    var msg := {
        "kind": "scene-graph-set",
        "scope": "scene",
        "graph": graph.duplicate(true),
    }
    if object_id != "":
        msg["scope"] = "object"
        msg["objectId"] = object_id
    return msg


static func make_scene_graph_clear(object_id: String = "") -> Dictionary:
    var msg := {
        "kind": "scene-graph-clear",
        "scope": "scene",
    }
    if object_id != "":
        msg["scope"] = "object"
        msg["objectId"] = object_id
    return msg


static func make_scene_asset_request(
    request_id: String,
    object_id: String,
    asset_id: String = "",
    mesh_path: String = "",
    expected_size: Variant = null
) -> Dictionary:
    var msg := {
        "kind": "scene-asset-request",
        "requestId": request_id,
        "objectId": object_id,
        "assetId": asset_id if asset_id != "" else null,
        "meshPath": mesh_path if mesh_path != "" else null,
        "expectedSize": expected_size,
    }
    return msg


static func make_file_handoff(path: String, filename: String, size: int, mime: String, url: String) -> Dictionary:
    return {
        "kind": "file",
        "path": path,
        "filename": filename,
        "size": size,
        "mime": mime,
        "url": url,
    }


static func extract_transform(payload: Dictionary) -> Dictionary:
    var result := {}
    if payload.has("position") and payload["position"] is Array:
        result["position"] = pos_from_wire(payload["position"])
    if payload.has("rotation") and payload["rotation"] is Array:
        result["rotation"] = rot_from_wire(payload["rotation"])
    if payload.has("scale") and payload["scale"] is Array:
        result["scale"] = scale_from_wire(payload["scale"])
    return result
