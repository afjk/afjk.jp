class_name SceneSyncRapierBridge
extends Node

signal availability_changed(available: bool)
signal runtime_state_changed(state: Dictionary)
signal hash_report_requested(payload: Dictionary)
signal hash_checked(report: Dictionary)
signal diagnostic(detail: Dictionary)

const DEFAULT_WORLD_CLASS := &"SceneSyncRapierWorld3D"
const PROFILE := "SceneSyncRapierParity-0.30"
const HASH_VERSION := "SceneSyncCanonicalPhysicsHashV1"
const RAPIER_CORE_VERSION := "0.30.0"
const GROUND_STABLE_ID := "__scenesync_ground__"
const DEFAULT_TIMESTEP := 1.0 / 60.0
const DEFAULT_GRAVITY := Vector3(0.0, -9.81, 0.0)
const GROUND_HALF_EXTENT := 4096.0
const GROUND_THICKNESS := 0.1

@export var auto_run: bool = true
@export var world_class_name: StringName = DEFAULT_WORLD_CLASS
@export_range(1, 10000, 1) var max_steps_per_update: int = 600
@export_range(1, 10000, 1) var hash_broadcast_interval_ticks: int = 60

var _manager: Node = null
var _world: Object = null
var _available: bool = false
var _active: bool = false
var _dirty: bool = true
var _scene_physics: Dictionary = {}
var _nodes: Dictionary = {}
var _object_physics: Dictionary = {}
var _body_definitions: Dictionary = {}
var _world_epoch_time: float = 0.0
var _timestep: float = DEFAULT_TIMESTEP
var _last_clock_mode: int = -1
var _last_hash_tick: int = -1
var _last_hash: String = ""
var _last_hash_report: Dictionary = {}
var _last_diagnostic_reason: String = ""


func attach_manager(manager: Node) -> void:
    if _manager == manager:
        return
    _detach_manager()
    _manager = manager
    if _manager == null:
        return

    _connect_manager_signal(&"scene_physics_changed", _on_scene_physics_changed)
    _connect_manager_signal(&"object_physics_changed", _on_object_physics_changed)
    _connect_manager_signal(&"object_added", _on_object_added)
    _connect_manager_signal(&"object_removed", _on_object_removed)
    _connect_manager_signal(&"disconnected", _on_manager_disconnected)

    if _manager.has_method("get_scene_physics"):
        set_scene_physics(_manager.call("get_scene_physics"))
    refresh_availability()


func refresh_availability() -> bool:
    var next_available := ClassDB.class_exists(world_class_name)
    if next_available != _available:
        _available = next_available
        availability_changed.emit(_available)
    if not _available:
        _clear_world()
    return _available


func is_available() -> bool:
    return _available


func is_active() -> bool:
    return _active


func is_body_registered(object_id: String) -> bool:
    return _body_definitions.has(object_id)


func get_tick() -> int:
    if _world == null or not is_instance_valid(_world) or not _world.has_method("get_tick"):
        return 0
    return maxi(0, int(_world.call("get_tick")))


func get_canonical_state_hash() -> String:
    if _world == null or not is_instance_valid(_world) or not _world.has_method("get_canonical_state_hash"):
        return ""
    return _safe_string(_world.call("get_canonical_state_hash"))


func get_status() -> Dictionary:
    return {
        "available": _available,
        "active": _active,
        "profile": PROFILE,
        "hashVersion": HASH_VERSION,
        "rapierCoreVersion": RAPIER_CORE_VERSION,
        "tick": get_tick(),
        "timestep": _timestep,
        "worldEpochTime": _world_epoch_time,
        "bodyCount": _body_definitions.size() + (1 if _ground_definition() != null else 0),
        "hash": get_canonical_state_hash(),
        "lastRemoteHash": _last_hash_report.duplicate(true),
    }


func set_scene_physics(raw_physics: Variant) -> void:
    var next_physics := (raw_physics as Dictionary).duplicate(true) if raw_physics is Dictionary else {}
    if _scene_physics == next_physics:
        return
    _scene_physics = next_physics
    _dirty = true
    _last_hash_tick = -1
    if not _scene_enabled():
        _clear_world()


func upsert_object(
    object_id: String,
    node: Node3D,
    raw_physics: Variant,
    refresh_definition: bool = true
) -> bool:
    if object_id.is_empty() or node == null or not is_instance_valid(node):
        return false
    if (
        not (raw_physics is Dictionary)
        or (raw_physics as Dictionary).is_empty()
        or not _object_physics_enabled(raw_physics as Dictionary)
    ):
        remove_object(object_id)
        return false

    _nodes[object_id] = node
    if not refresh_definition and _body_definitions.has(object_id):
        return true

    var physics := (raw_physics as Dictionary).duplicate(true)
    var definition := _build_body_definition(object_id, node, physics)
    if definition.is_empty():
        remove_object(object_id)
        return false
    _object_physics[object_id] = physics
    _body_definitions[object_id] = definition
    _dirty = true
    _last_hash_tick = -1
    return true


func remove_object(object_id: String) -> bool:
    var existed := _body_definitions.has(object_id)
    _nodes.erase(object_id)
    _object_physics.erase(object_id)
    _body_definitions.erase(object_id)
    if _world != null and is_instance_valid(_world) and _world.has_method("remove_body"):
        _world.call("remove_body", object_id)
        _last_hash_tick = -1
    if _body_definitions.is_empty():
        _clear_world()
    return existed


func clear_runtime(clear_bindings: bool = true) -> void:
    _clear_world()
    _last_clock_mode = -1
    _last_hash_report.clear()
    if clear_bindings:
        _nodes.clear()
        _object_physics.clear()
        _body_definitions.clear()
        _scene_physics.clear()
        _dirty = true


func advance_to_time(
    playback_time: Variant,
    clock_mode: int = 0,
    clock_active: bool = true
) -> Dictionary:
    var active_time := _finite_float(playback_time, 0.0)
    active_time = maxf(0.0, active_time)
    if not auto_run:
        return _state_result(false, "auto-run-disabled", active_time, false)
    if not _scene_enabled():
        _clear_world()
        return _state_result(false, "scene-physics-disabled", active_time, false)
    if not clock_active:
        return _state_result(false, "clock-inactive", active_time, false)
    if not refresh_availability():
        _emit_diagnostic_once("rapier-addon-unavailable", {
            "className": String(world_class_name),
        })
        return _state_result(false, "rapier-addon-unavailable", active_time, false)
    if _body_definitions.is_empty():
        _clear_world()
        return _state_result(false, "no-bodies", active_time, false)

    if _dirty or _world == null or not is_instance_valid(_world):
        if not _rebuild_world(active_time):
            return _state_result(false, "world-rebuild-failed", active_time, false)

    var current_tick := get_tick()
    if _last_clock_mode != -1 and _last_clock_mode != clock_mode:
        _world_epoch_time = maxf(0.0, active_time - float(current_tick) * _timestep)
    _last_clock_mode = clock_mode

    var target_tick := maxi(0, floori(maxf(0.0, active_time - _world_epoch_time) / _timestep))
    if target_tick < current_tick:
        var previous_epoch := _world_epoch_time
        if not _rebuild_world(previous_epoch):
            return _state_result(false, "world-rewind-failed", active_time, false)
        current_tick = get_tick()

    var limited := false
    var step_target := target_tick
    var max_target := current_tick + maxi(1, max_steps_per_update)
    if step_target > max_target:
        step_target = max_target
        limited = true

    if step_target > current_tick:
        if not bool(_world.call("step_to", step_target)):
            var last_error := _world_last_error()
            _emit_diagnostic("step-failed", {"error": last_error, "targetTick": step_target})
            return _state_result(false, "step-failed", active_time, limited)

    _apply_world_transforms()
    _active = true
    _last_hash = get_canonical_state_hash()
    _maybe_request_hash_report(active_time)
    var state := _state_result(true, "", active_time, limited)
    runtime_state_changed.emit(state.duplicate(true))
    return state


func handle_sync_payload(payload: Dictionary, from_info: Dictionary = {}) -> Dictionary:
    var kind := _safe_string(payload.get("kind", ""))
    if kind == "scene-physics-hash":
        return verify_remote_hash(payload, from_info)
    var result := {
        "handled": false,
        "kind": kind,
        "reason": "unsupported-physics-sync-payload",
    }
    _emit_diagnostic_once("unsupported-%s" % kind, result)
    return result


func verify_remote_hash(payload: Dictionary, from_info: Dictionary = {}) -> Dictionary:
    var remote_tick := _non_negative_int(payload.get("tick", -1), -1)
    var local_tick := get_tick()
    var remote_hash := _safe_string(payload.get("hash", ""))
    var local_hash := get_canonical_state_hash()
    var profile_matched := _safe_string(payload.get("profile", PROFILE)) == PROFILE
    var hash_version_matched := _safe_string(payload.get("hashVersion", HASH_VERSION)) == HASH_VERSION
    var rapier_version_matched := _safe_string(payload.get("rapierCoreVersion", RAPIER_CORE_VERSION)) == RAPIER_CORE_VERSION
    var tick_matched := remote_tick >= 0 and remote_tick == local_tick
    var matched := (
        _active
        and remote_hash != ""
        and local_hash != ""
        and profile_matched
        and hash_version_matched
        and rapier_version_matched
        and tick_matched
        and remote_hash == local_hash
    )
    var report := {
        "handled": true,
        "kind": "scene-physics-hash",
        "fromId": _safe_string(from_info.get("id", "")),
        "remoteTick": remote_tick,
        "localTick": local_tick,
        "remoteHash": remote_hash,
        "localHash": local_hash,
        "profileMatched": profile_matched,
        "hashVersionMatched": hash_version_matched,
        "rapierCoreVersionMatched": rapier_version_matched,
        "tickMatched": tick_matched,
        "matched": matched,
    }
    _last_hash_report = report.duplicate(true)
    hash_checked.emit(report.duplicate(true))
    return report


func _rebuild_world(epoch_time: float) -> bool:
    _clear_world()
    var instance = ClassDB.instantiate(world_class_name)
    if instance == null or not (instance is Object):
        _emit_diagnostic("world-instantiation-failed", {"className": String(world_class_name)})
        return false
    _world = instance as Object
    _timestep = _scene_timestep()
    var gravity := _scene_gravity()
    if not bool(_world.call("configure", gravity, _timestep)):
        _emit_diagnostic("world-configure-failed", {"error": _world_last_error()})
        _world = null
        return false

    var ground = _ground_definition()
    if ground is Dictionary and not ground.is_empty():
        if not bool(_world.call("add_body", ground)):
            _emit_diagnostic("ground-registration-failed", {"error": _world_last_error()})
            _world = null
            return false

    var object_ids := _body_definitions.keys()
    object_ids.sort()
    for object_id_value in object_ids:
        var object_id := _safe_string(object_id_value)
        var definition_value = _body_definitions.get(object_id, {})
        if not (definition_value is Dictionary):
            continue
        if not bool(_world.call("add_body", (definition_value as Dictionary).duplicate(true))):
            _emit_diagnostic("body-registration-failed", {
                "objectId": object_id,
                "error": _world_last_error(),
            })
            _world = null
            return false

    _world_epoch_time = maxf(0.0, epoch_time)
    _dirty = false
    _active = true
    _last_hash_tick = -1
    _last_hash = get_canonical_state_hash()
    _last_diagnostic_reason = ""
    return true


func _build_body_definition(object_id: String, node: Node3D, physics: Dictionary) -> Dictionary:
    var initial_transform_value = physics.get("initialTransform", null)
    var initial_transform := initial_transform_value as Dictionary if initial_transform_value is Dictionary else {}
    var position := _read_vec3(initial_transform.get("position", node.position), node.position)
    var rotation := _read_quaternion(initial_transform.get("rotation", node.quaternion), node.quaternion)
    var scale := _read_vec3(initial_transform.get("scale", node.scale), node.scale)
    scale = Vector3(absf(scale.x), absf(scale.y), absf(scale.z))

    var body_type := _safe_string(physics.get("bodyType", "")).to_lower()
    var is_static := body_type == "static" or body_type == "fixed" or bool(physics.get("static", false))
    var shape := _safe_string(physics.get("shape", "")).to_lower()
    if shape != "sphere" and shape != "box":
        shape = _infer_shape(node)

    var half_extents := _read_positive_vec3(
        physics.get("halfExtents", null),
        Vector3(
            maxf(0.01, scale.x * 0.5),
            maxf(0.01, scale.y * 0.5),
            maxf(0.01, scale.z * 0.5)
        )
    )
    var radius := _positive_float(
        physics.get("radius", null),
        maxf(0.01, maxf(scale.x, maxf(scale.y, scale.z)) * 0.5)
    )
    var density := 0.0 if is_static else _body_density(physics, shape, half_extents, radius)

    return {
        "id": object_id,
        "type": "fixed" if is_static else "dynamic",
        "static": is_static,
        "shape": shape,
        "position": position,
        "rotation": rotation,
        "linearVelocity": Vector3.ZERO if is_static else _read_vec3(
            physics.get("linearVelocity", physics.get("velocity", null)),
            Vector3.ZERO
        ),
        "angularVelocity": Vector3.ZERO if is_static else _read_vec3(
            physics.get("angularVelocity", null),
            Vector3.ZERO
        ),
        "halfExtents": half_extents,
        "radius": radius,
        "density": density,
        "friction": clampf(_finite_float(physics.get("friction", null), 0.5), 0.0, 1.0),
        "frictionCombineRule": clampi(_non_negative_int(physics.get("frictionCombineRule", 0), 0), 0, 3),
        "restitution": clampf(_finite_float(physics.get("restitution", null), 0.2), 0.0, 1.0),
        "restitutionCombineRule": clampi(_non_negative_int(physics.get("restitutionCombineRule", 0), 0), 0, 3),
        "linearDamping": maxf(0.0, _finite_float(physics.get("linearDamping", null), 0.0)),
        "angularDamping": maxf(0.0, _finite_float(physics.get("angularDamping", null), 0.0)),
        "gravityScale": _finite_float(physics.get("gravityScale", null), 1.0),
        "additionalSolverIterations": _non_negative_int(physics.get("additionalSolverIterations", 0), 0),
        "canSleep": bool(physics.get("canSleep", true)),
        "ccd": bool(physics.get("ccd", physics.get("ccdEnabled", false))),
        "softCcdPrediction": maxf(0.0, _finite_float(physics.get("softCcdPrediction", null), 0.0)),
        "sensor": bool(physics.get("sensor", false)),
    }


func _body_density(physics: Dictionary, shape: String, half_extents: Vector3, radius: float) -> float:
    var density_value = physics.get("density", null)
    if _is_finite_number(density_value):
        return maxf(0.0, float(density_value))
    var mass := _positive_float(physics.get("mass", null), 1.0)
    var volume := 1.0
    if shape == "sphere":
        volume = (4.0 / 3.0) * PI * radius * radius * radius
    else:
        volume = 8.0 * half_extents.x * half_extents.y * half_extents.z
    return mass / maxf(volume, 0.000001)


func _ground_definition() -> Variant:
    if not _scene_enabled():
        return null
    var world_options := _scene_world_options()
    var ground_value = world_options.get("ground", null) if world_options.has("ground") else {}
    if ground_value == null or ground_value == false:
        return null
    var ground := ground_value as Dictionary if ground_value is Dictionary else {}
    var y := _finite_float(ground.get("y", null), 0.0)
    return {
        "id": GROUND_STABLE_ID,
        "type": "fixed",
        "static": true,
        "shape": "box",
        "position": Vector3(0.0, y - GROUND_THICKNESS * 0.5, 0.0),
        "rotation": Quaternion.IDENTITY,
        "halfExtents": Vector3(GROUND_HALF_EXTENT, GROUND_THICKNESS * 0.5, GROUND_HALF_EXTENT),
        "density": 1.0,
        "friction": clampf(_finite_float(ground.get("friction", null), 0.5), 0.0, 4.0),
        "restitution": clampf(_finite_float(ground.get("restitution", null), 0.2), 0.0, 1.0),
    }


func _apply_world_transforms() -> void:
    if _world == null or not is_instance_valid(_world):
        return
    var object_ids := _nodes.keys()
    object_ids.sort()
    for object_id_value in object_ids:
        var object_id := _safe_string(object_id_value)
        var node_value = _nodes.get(object_id, null)
        if not (node_value is Node3D) or not is_instance_valid(node_value):
            continue
        var state_value = _world.call("get_body_state", object_id)
        if not (state_value is Dictionary):
            continue
        var state := state_value as Dictionary
        if state.is_empty() or bool(state.get("fixed", false)):
            continue
        var node := node_value as Node3D
        node.position = _read_vec3(state.get("position", null), node.position)
        node.quaternion = _read_quaternion(state.get("rotation", null), node.quaternion)


func _maybe_request_hash_report(active_time: float) -> void:
    var tick := get_tick()
    var interval := maxi(1, hash_broadcast_interval_ticks)
    if tick == _last_hash_tick or (tick != 0 and tick % interval != 0):
        return
    _last_hash_tick = tick
    hash_report_requested.emit(_make_hash_payload(active_time))


func _make_hash_payload(active_time: float) -> Dictionary:
    return {
        "kind": "scene-physics-hash",
        "source": "physics",
        "phase": "postPhysics",
        "profile": PROFILE,
        "hashVersion": HASH_VERSION,
        "rapierCoreVersion": RAPIER_CORE_VERSION,
        "tick": get_tick(),
        "hash": get_canonical_state_hash(),
        "timestep": _timestep,
        "activeTime": active_time,
        "worldAge": maxf(0.0, active_time - _world_epoch_time),
        "worldEpochTime": _world_epoch_time,
        "bodyCount": _body_definitions.size() + (1 if _ground_definition() != null else 0),
    }


func _state_result(active: bool, reason: String, active_time: float, limited: bool) -> Dictionary:
    return {
        "active": active,
        "reason": reason,
        "available": _available,
        "tick": get_tick(),
        "timestep": _timestep,
        "targetTime": active_time,
        "worldEpochTime": _world_epoch_time,
        "hash": get_canonical_state_hash(),
        "limited": limited,
        "reached": not limited,
    }


func _scene_enabled() -> bool:
    return bool(_scene_physics.get("enabled", false))


func _scene_world_options() -> Dictionary:
    var value = _scene_physics.get("worldOptions", _scene_physics)
    return (value as Dictionary) if value is Dictionary else {}


func _scene_gravity() -> Vector3:
    var value = _scene_world_options().get("gravity", -9.81)
    if value is Vector3 or value is Array or value is PackedFloat32Array or value is PackedFloat64Array:
        return _read_vec3(value, DEFAULT_GRAVITY)
    return Vector3(0.0, _finite_float(value, -9.81), 0.0)


func _scene_timestep() -> float:
    return _positive_float(_scene_world_options().get("timestep", null), DEFAULT_TIMESTEP)


func _object_physics_enabled(physics: Dictionary) -> bool:
    return physics.get("enabled", true) != false


func _infer_shape(node: Node3D) -> String:
    if node != null and node.has_meta("scene_sync_asset"):
        var asset_value = node.get_meta("scene_sync_asset")
        if asset_value is Dictionary:
            var primitive := _safe_string((asset_value as Dictionary).get("primitive", "")).to_lower()
            if primitive == "sphere":
                return "sphere"
    return "box"


func _read_vec3(value: Variant, fallback: Vector3) -> Vector3:
    if value is Vector3:
        var vector := value as Vector3
        return vector if _vector_is_finite(vector) else fallback
    if value is Array and value.size() >= 3:
        return Vector3(
            _finite_float(value[0], fallback.x),
            _finite_float(value[1], fallback.y),
            _finite_float(value[2], fallback.z)
        )
    if value is PackedFloat32Array and value.size() >= 3:
        return Vector3(value[0], value[1], value[2])
    if value is PackedFloat64Array and value.size() >= 3:
        return Vector3(value[0], value[1], value[2])
    return fallback


func _read_positive_vec3(value: Variant, fallback: Vector3) -> Vector3:
    var result := _read_vec3(value, fallback)
    return Vector3(
        _positive_float(result.x, fallback.x),
        _positive_float(result.y, fallback.y),
        _positive_float(result.z, fallback.z)
    )


func _read_quaternion(value: Variant, fallback: Quaternion) -> Quaternion:
    var result := fallback
    if value is Quaternion:
        result = value as Quaternion
    elif value is Array and value.size() >= 4:
        result = Quaternion(
            _finite_float(value[0], fallback.x),
            _finite_float(value[1], fallback.y),
            _finite_float(value[2], fallback.z),
            _finite_float(value[3], fallback.w)
        )
    if not (
        is_finite(result.x)
        and is_finite(result.y)
        and is_finite(result.z)
        and is_finite(result.w)
    ) or result.length_squared() <= 0.0000001:
        return fallback
    return result.normalized()


func _vector_is_finite(value: Vector3) -> bool:
    return is_finite(value.x) and is_finite(value.y) and is_finite(value.z)


func _positive_float(value: Variant, fallback: float) -> float:
    var result := _finite_float(value, fallback)
    return result if result > 0.0 else fallback


func _finite_float(value: Variant, fallback: float) -> float:
    if value is int or value is float:
        var result := float(value)
        if is_finite(result):
            return result
    return fallback


func _non_negative_int(value: Variant, fallback: int) -> int:
    if value is int:
        var integer := int(value)
        return integer if integer >= 0 else fallback
    if value is float and is_finite(float(value)):
        var integer := floori(float(value))
        return integer if integer >= 0 else fallback
    return fallback


func _is_finite_number(value: Variant) -> bool:
    return (value is int) or (value is float and is_finite(float(value)))


func _safe_string(value: Variant, fallback: String = "") -> String:
    if value is String:
        return value
    if value is StringName:
        return String(value)
    return fallback


func _world_last_error() -> String:
    if _world != null and is_instance_valid(_world) and _world.has_method("get_last_error"):
        return _safe_string(_world.call("get_last_error"))
    return ""


func _clear_world() -> void:
    _world = null
    _active = false
    _last_hash = ""
    _last_hash_tick = -1


func _emit_diagnostic(reason: String, extra: Dictionary = {}) -> void:
    var detail := {"reason": reason}
    detail.merge(extra, true)
    diagnostic.emit(detail)


func _emit_diagnostic_once(reason: String, extra: Dictionary = {}) -> void:
    if reason == _last_diagnostic_reason:
        return
    _last_diagnostic_reason = reason
    _emit_diagnostic(reason, extra)


func _connect_manager_signal(signal_name: StringName, callback: Callable) -> void:
    if _manager != null and _manager.has_signal(signal_name) and not _manager.is_connected(signal_name, callback):
        _manager.connect(signal_name, callback)


func _detach_manager() -> void:
    if _manager == null or not is_instance_valid(_manager):
        _manager = null
        return
    var bindings := [
        [&"scene_physics_changed", Callable(self, "_on_scene_physics_changed")],
        [&"object_physics_changed", Callable(self, "_on_object_physics_changed")],
        [&"object_added", Callable(self, "_on_object_added")],
        [&"object_removed", Callable(self, "_on_object_removed")],
        [&"disconnected", Callable(self, "_on_manager_disconnected")],
    ]
    for binding in bindings:
        if _manager.has_signal(binding[0]) and _manager.is_connected(binding[0], binding[1]):
            _manager.disconnect(binding[0], binding[1])
    _manager = null


func _on_scene_physics_changed(physics: Dictionary) -> void:
    set_scene_physics(physics)


func _on_object_physics_changed(object_id: String, node: Node3D, physics: Dictionary) -> void:
    upsert_object(object_id, node, physics, true)


func _on_object_added(object_id: String, node: Node3D) -> void:
    if object_id.is_empty() or node == null:
        return
    if _body_definitions.has(object_id):
        _nodes[object_id] = node
        return
    if _manager != null and _manager.has_method("get_object_physics"):
        var physics_value = _manager.call("get_object_physics", object_id)
        if physics_value is Dictionary and not physics_value.is_empty():
            upsert_object(object_id, node, physics_value, true)


func _on_object_removed(object_id: String) -> void:
    remove_object(object_id)


func _on_manager_disconnected() -> void:
    clear_runtime(true)


func _exit_tree() -> void:
    _detach_manager()
    clear_runtime(true)
