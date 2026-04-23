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


static func make_scene_delta(object_id: String, pos: Vector3, rot: Quaternion, scl: Vector3) -> Dictionary:
    return {
        "kind": "scene-delta",
        "objectId": object_id,
        "position": pos_to_wire(pos),
        "rotation": rot_to_wire(rot),
        "scale": scale_to_wire(scl),
    }


static func make_scene_add(
    object_id: String,
    obj_name: String,
    pos: Vector3,
    rot: Quaternion,
    scl: Vector3,
    mesh_path: String = "",
    asset: Dictionary = {}
) -> Dictionary:
    var msg := {
        "kind": "scene-add",
        "objectId": object_id,
        "name": obj_name,
        "position": pos_to_wire(pos),
        "rotation": rot_to_wire(rot),
        "scale": scale_to_wire(scl),
    }
    if mesh_path != "":
        msg["meshPath"] = mesh_path
    if not asset.is_empty():
        msg["asset"] = asset.duplicate(true)
    return msg


static func make_scene_remove(object_id: String) -> Dictionary:
    return {"kind": "scene-remove", "objectId": object_id}


static func make_scene_mesh(object_id: String, mesh_path: String) -> Dictionary:
    return {"kind": "scene-mesh", "objectId": object_id, "meshPath": mesh_path}


static func make_scene_lock(object_id: String) -> Dictionary:
    return {"kind": "scene-lock", "objectId": object_id}


static func make_scene_unlock(object_id: String) -> Dictionary:
    return {"kind": "scene-unlock", "objectId": object_id}


static func make_scene_request() -> Dictionary:
    return {"kind": "scene-request"}


static func make_scene_state(objects: Dictionary) -> Dictionary:
    return {"kind": "scene-state", "objects": objects}


static func extract_transform(payload: Dictionary) -> Dictionary:
    var result := {}
    if payload.has("position") and payload["position"] is Array:
        result["position"] = pos_from_wire(payload["position"])
    if payload.has("rotation") and payload["rotation"] is Array:
        result["rotation"] = rot_from_wire(payload["rotation"])
    if payload.has("scale") and payload["scale"] is Array:
        result["scale"] = scale_from_wire(payload["scale"])
    return result
