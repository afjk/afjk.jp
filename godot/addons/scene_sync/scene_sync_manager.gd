@tool
class_name SceneSyncManager
extends Node

signal connected(id: String, room: String)
signal disconnected()
signal peers_updated(peers: Array)
signal object_added(object_id: String, node: Node3D)
signal object_removed(object_id: String)
signal asset_load_diagnostic(object_id: String, detail: Dictionary)
signal animation_policy_changed(object_id: String, node: Node3D, policy: Dictionary)
signal animation_policy_applied(object_id: String, node: Node3D, result: Dictionary)
signal playback_clock_state_changed(state: Dictionary)
signal scene_physics_changed(physics: Dictionary)
signal object_physics_changed(object_id: String, node: Node3D, physics: Dictionary)
signal rapier_availability_changed(available: bool)
signal physics_runtime_state_changed(state: Dictionary)
signal physics_hash_checked(report: Dictionary)
signal physics_runtime_diagnostic(detail: Dictionary)

@export var presence_url: String = "wss://afjk.jp/presence"
@export var blob_url: String = ""
@export var room: String = ""
@export var nickname: String = "Godot"
@export var auto_connect: bool = true
@export var sync_root: Node3D = null
@export var hierarchy_poll_interval: float = 0.5
@export_enum("Local", "Shared Playback Follow", "Shared Playback Control", "Room Time") var playback_clock_mode: int = 0
@export_enum("Manual", "Auto Follow or Local", "Follower Only") var playback_follow_policy: int = 0
@export var allow_playback_control: bool = true
@export var playback_clock_broadcast_interval: float = 0.25
@export var rapier_physics_enabled: bool = true
@export_range(1, 10000, 1) var rapier_max_steps_per_update: int = 600
@export_range(1, 10000, 1) var rapier_hash_broadcast_interval_ticks: int = 60

var _client: SceneSyncPresenceClient
var _blob_client: SceneSyncBlobClient
var _remote_asset_loader: SceneSyncRemoteAssetLoader
var _playback_clock: SceneSyncPlaybackClock
var _rapier_bridge: Node
var _managed_objects: Dictionary = {}
var _known_ids: Dictionary = {}
var _mesh_paths: Dictionary = {}
var _asset_ids: Dictionary = {}
var _metadata: Dictionary = {}
var _animation_policies: Dictionary = {}
var _object_physics: Dictionary = {}
var _scene_physics: Dictionary = {}
var _scene_physics_present: bool = false
var _remote_asset_contexts: Dictionary = {}
var _carrier_load_signatures: Dictionary = {}
var _origins: Dictionary = {}
var _unity_hierarchy_paths: Dictionary = {}
var _mesh_data_by_asset_id: Dictionary = {}
var _mesh_data_by_path: Dictionary = {}
var _pending_recoveries: Dictionary = {}
var _responder_cooldowns: Dictionary = {}
var _active_outgoing_transfer_id: String = ""
var _loom_graphs: Dictionary = {}
var _loom_runner: Node = null
var _env_id: String = ""
var _locks: Dictionary = {}
var _last_snapshots: Dictionary = {}
var _selected_object: Node3D = null
var _currently_locked_id: String = ""
var _scene_received: bool = false
var _first_peers_received: bool = false
var _send_timer: float = 0.0
var _hierarchy_timer: float = 0.0
var _connected: bool = false
var _last_playback_effective_mode: int = SceneSyncPlaybackClock.LOCAL
var _last_effective_playback_time: float = 0.0
var _has_effective_playback_sample: bool = false

const SEND_INTERVAL: float = 0.05
const RECOVERY_TIMEOUT_SECONDS: float = 30.0
const PEER_RETRY_INTERVAL_SECONDS: float = 4.0
const RECOVERY_RESPONDER_COOLDOWN_SECONDS: float = 30.0
const MAX_GLB_SIZE: int = 50 * 1024 * 1024
const OBJECT_ID_META := "scene_sync_object_id"
const ASSET_META := "scene_sync_asset"
const METADATA_META := "scene_sync_metadata"
const ASSET_ID_META := "scene_sync_asset_id"
const ANIMATION_META := "scene_sync_animation"
const PHYSICS_META := "scene_sync_physics"
const REMOTE_OBJECT_META := "scene_sync_remote_object"
const ORIGIN_META := "scene_sync_origin"
const UNITY_HIERARCHY_PATH_META := "scene_sync_unity_hierarchy_path"
const RECEIVE_ROOT_NAME := "SceneSyncRoot"
const LOOM_RUNNER_SCRIPT_PATH := "res://addons/scene_sync/SceneSyncLoomletRunner.cs"
const RAPIER_BRIDGE_SCRIPT := preload("res://addons/scene_sync/scene_sync_rapier_bridge.gd")


func _ready() -> void:
    _client = SceneSyncPresenceClient.new()
    _blob_client = SceneSyncBlobClient.new()
    _blob_client.name = "SceneSyncBlobClient"
    add_child(_blob_client)
    _remote_asset_loader = SceneSyncRemoteAssetLoader.new()
    _remote_asset_loader.name = "SceneSyncRemoteAssetLoader"
    add_child(_remote_asset_loader)
    _remote_asset_loader.asset_loaded.connect(_on_remote_asset_loaded)
    _remote_asset_loader.asset_failed.connect(_on_remote_asset_failed)
    _remote_asset_loader.diagnostic.connect(_on_remote_asset_diagnostic)
    _ensure_playback_clock()
    _ensure_rapier_bridge()
    _ensure_loom_runner()

    _client.connected.connect(_on_connected)
    _client.disconnected.connect(_on_disconnected)
    _client.peers_updated.connect(_on_peers_updated)
    _client.handoff_received.connect(_on_handoff_received)
    _client.server_time_received.connect(_on_server_time_received)

    set_process(true)
    if auto_connect and (not Engine.is_editor_hint() or _can_operate_in_editor()):
        connect_to_server()


func _exit_tree() -> void:
    if _client != null:
        _client.disconnect_from_server(false)


func _process(delta: float) -> void:
    if _client != null:
        _client.poll(delta)

    _update_playback_clock()
    _update_rapier_bridge()

    if not _connected:
        return

    _send_timer += delta
    if _send_timer >= SEND_INTERVAL:
        _send_timer = 0.0
        _send_transform_delta()

    _hierarchy_timer += delta
    if _hierarchy_timer >= hierarchy_poll_interval:
        _hierarchy_timer = 0.0
        _detect_hierarchy_changes()


func connect_to_server() -> void:
    if _client == null:
        return
    _blob_client.blob_base_url = _get_blob_base_url()
    _client.connect_to_server(presence_url, room, nickname)


func disconnect_from_server() -> void:
    if _client != null:
        _client.disconnect_from_server()


func is_connected_to_server() -> bool:
    return _connected


func get_peers() -> Array:
    return _client.peers if _client != null else []


func get_status_text() -> String:
    if not _connected:
        return "Disconnected"
    return "Connected - %s - %d peers" % [_client.room, _client.peers.size()]


func get_animation_policy(object_id: String) -> Dictionary:
    var node := _get_managed_node(object_id)
    if node != null and node.has_meta(ANIMATION_META):
        var metadata_value = node.get_meta(ANIMATION_META)
        if metadata_value is Dictionary:
            return (metadata_value as Dictionary).duplicate(true)
    var value = _animation_policies.get(object_id, {})
    if value is Dictionary:
        return (value as Dictionary).duplicate(true)
    return {}


func get_scene_physics() -> Dictionary:
    return _scene_physics.duplicate(true)


func get_object_physics(object_id: String) -> Dictionary:
    var node := _get_managed_node(object_id)
    if node != null and node.has_meta(PHYSICS_META):
        var metadata_value = node.get_meta(PHYSICS_META)
        if metadata_value is Dictionary:
            return (metadata_value as Dictionary).duplicate(true)
    var value = _object_physics.get(object_id, {})
    return (value as Dictionary).duplicate(true) if value is Dictionary else {}


func get_playback_clock_state() -> Dictionary:
    return _ensure_playback_clock().get_state()


func get_rapier_bridge() -> Node:
    return _ensure_rapier_bridge()


func get_rapier_status() -> Dictionary:
    return _ensure_rapier_bridge().get_status()


func get_current_playback_time() -> float:
    var monotonic_time := float(Time.get_ticks_usec()) / 1000000.0
    var unix_time := Time.get_unix_time_from_system()
    return _ensure_playback_clock().get_playback_time(monotonic_time, unix_time)


func set_playback_clock_mode(mode: Variant) -> Dictionary:
    var clock := _ensure_playback_clock()
    var previous_mode := playback_clock_mode
    var local_id := _client.id if _client != null else ""
    var state := clock.set_mode(mode, local_id, nickname, _managed_objects.keys())
    playback_clock_mode = int(state.get("mode", SceneSyncPlaybackClock.LOCAL))
    if (
        previous_mode != playback_clock_mode
        and playback_clock_mode == SceneSyncPlaybackClock.LOCAL
        and not bool(state.get("localTransportControlled", false))
    ):
        _resume_remote_animation_policies()
    return state


func use_local_playback() -> Dictionary:
    return set_playback_clock_mode(SceneSyncPlaybackClock.LOCAL)


func follow_shared_playback() -> Dictionary:
    return set_playback_clock_mode(SceneSyncPlaybackClock.SHARED_PLAYBACK_FOLLOW)


func control_shared_playback() -> Dictionary:
    return set_playback_clock_mode(SceneSyncPlaybackClock.SHARED_PLAYBACK_CONTROL)


func use_room_time() -> Dictionary:
    return set_playback_clock_mode(SceneSyncPlaybackClock.ROOM_TIME)


func set_playback_follow_policy(policy: Variant) -> Dictionary:
    var state := _ensure_playback_clock().set_follow_policy(policy)
    playback_follow_policy = int(state.get("followPolicy", SceneSyncPlaybackClock.MANUAL))
    return state


func set_playback_control_allowed(allowed: bool) -> Dictionary:
    allow_playback_control = allowed
    return _ensure_playback_clock().set_allow_control(allowed)


func pause_playback_clock() -> Dictionary:
    var times := _playback_time_samples()
    return _ensure_playback_clock().pause(times[0], times[1], _managed_objects.keys())


func resume_playback_clock() -> Dictionary:
    var times := _playback_time_samples()
    return _ensure_playback_clock().resume(times[0], times[1], _managed_objects.keys())


func seek_playback_clock(target_time: float) -> Dictionary:
    var times := _playback_time_samples()
    return _ensure_playback_clock().seek(target_time, times[0], times[1], _managed_objects.keys())


func reset_playback_clock() -> Dictionary:
    var times := _playback_time_samples()
    return _ensure_playback_clock().reset(times[0], times[1], _managed_objects.keys())


func set_playback_rate(rate: float) -> Dictionary:
    var times := _playback_time_samples()
    return _ensure_playback_clock().set_rate(rate, times[0], times[1], _managed_objects.keys())


func release_playback_control() -> Dictionary:
    return follow_shared_playback()


func _has_animation_policy(object_id: String) -> bool:
    var node := _get_managed_node(object_id)
    if node != null and node.has_meta(ANIMATION_META):
        return node.get_meta(ANIMATION_META) is Dictionary
    return _animation_policies.has(object_id)


func _has_object_physics(object_id: String) -> bool:
    var node := _get_managed_node(object_id)
    if node != null and node.has_meta(PHYSICS_META):
        return node.get_meta(PHYSICS_META) is Dictionary
    return _object_physics.has(object_id)


func select_object(node: Node3D) -> void:
    if node == null:
        deselect_object()
        return
    if not _is_sync_target(node):
        return

    var object_id := _get_or_assign_object_id(node)
    var lock_owner := _safe_string(_locks.get(object_id, ""))
    if lock_owner != "" and lock_owner != _client.id:
        push_warning("[SceneSync] Object is locked by another peer: %s" % object_id)
        return

    if _currently_locked_id != "" and _currently_locked_id != object_id:
        _client.broadcast(SceneSyncProtocol.make_scene_unlock(_currently_locked_id))
    _selected_object = node
    _currently_locked_id = object_id
    _client.broadcast(SceneSyncProtocol.make_scene_lock(object_id))


func deselect_object() -> void:
    if _currently_locked_id != "":
        _client.broadcast(SceneSyncProtocol.make_scene_unlock(_currently_locked_id))
    _selected_object = null
    _currently_locked_id = ""


func sync_all_meshes() -> void:
    if not _connected:
        return
    for node in _get_all_sync_targets():
        if not _node_has_mesh(node):
            continue
        _sync_mesh_for_node(node)


func _on_connected(new_id: String, new_room: String) -> void:
    _connected = true
    room = new_room
    if _playback_clock != null:
        var configured_mode := playback_clock_mode
        var reconnect_times := _playback_time_samples()
        _playback_clock.handle_connection_lost(reconnect_times[0], reconnect_times[1])
        _playback_clock.broadcast_interval = playback_clock_broadcast_interval
        _playback_clock.set_follow_policy(playback_follow_policy)
        _playback_clock.set_allow_control(allow_playback_control)
        if _client.server_time_msec > 0.0:
            _playback_clock.set_room_time_anchor(
                _client.server_time_msec,
                _client.server_time_received_monotonic
            )
        if (
            configured_mode == SceneSyncPlaybackClock.SHARED_PLAYBACK_CONTROL
            and not bool(_playback_clock.get_state().get("active", false))
        ):
            _playback_clock.set_mode(
                SceneSyncPlaybackClock.LOCAL,
                new_id,
                nickname,
                _managed_objects.keys()
            )
        _playback_clock.set_mode(configured_mode, new_id, nickname, _managed_objects.keys())
    connected.emit(new_id, new_room)


func _on_disconnected() -> void:
    _connected = false
    if _playback_clock != null:
        var disconnect_times := _playback_time_samples()
        _playback_clock.handle_connection_lost(disconnect_times[0], disconnect_times[1])
        playback_clock_mode = _playback_clock.mode
    _scene_received = false
    _first_peers_received = false
    _locks.clear()
    _clear_all_loom_graphs()
    _loom_graphs.clear()
    _mesh_data_by_asset_id.clear()
    _mesh_data_by_path.clear()
    if _remote_asset_loader != null:
        _remote_asset_loader.cancel_all()
    _remote_asset_contexts.clear()
    _carrier_load_signatures.clear()
    for node_value in _managed_objects.values():
        if node_value is Node3D and is_instance_valid(node_value):
            var managed_node := node_value as Node3D
            if bool(managed_node.get_meta(REMOTE_OBJECT_META, false)):
                SceneSyncAnimationPolicy.stop(managed_node)
                managed_node.queue_free()
    if _loom_runner != null and is_instance_valid(_loom_runner):
        _call_loom_runner("ClearTimeOverrides")
    _last_playback_effective_mode = SceneSyncPlaybackClock.LOCAL
    _last_effective_playback_time = 0.0
    _has_effective_playback_sample = false
    _managed_objects.clear()
    _known_ids.clear()
    _mesh_paths.clear()
    _asset_ids.clear()
    _metadata.clear()
    _animation_policies.clear()
    _object_physics.clear()
    _scene_physics.clear()
    _scene_physics_present = false
    if has_meta(PHYSICS_META):
        remove_meta(PHYSICS_META)
    _origins.clear()
    _unity_hierarchy_paths.clear()
    _last_snapshots.clear()
    _pending_recoveries.clear()
    _responder_cooldowns.clear()
    _active_outgoing_transfer_id = ""
    _env_id = ""
    _selected_object = null
    _currently_locked_id = ""
    disconnected.emit()


func _on_server_time_received(server_time_msec: float, received_monotonic_time: float) -> void:
    _ensure_playback_clock().set_room_time_anchor(server_time_msec, received_monotonic_time)


func _on_peers_updated(peers: Array) -> void:
    var live_peer_ids := {}
    for peer in peers:
        if peer is Dictionary:
            live_peer_ids[_safe_string(peer.get("id", ""))] = true

    for object_id in _locks.keys():
        var owner_id := _safe_string(_locks[object_id])
        if owner_id != "" and owner_id != _client.id and not live_peer_ids.has(owner_id):
            _locks.erase(object_id)

    if _playback_clock != null:
        var times := _playback_time_samples()
        _playback_clock.reconcile_peers(peers, times[0], times[1])

    if not _first_peers_received and peers.size() > 0:
        _first_peers_received = true
        if not _scene_received:
            _request_scene_from_peer()

    peers_updated.emit(peers)


func _request_scene_from_peer() -> void:
    var peers := _client.peers
    for peer in peers:
        if not (peer is Dictionary):
            continue
        var peer_id := _safe_string(peer.get("id", ""))
        if peer_id == "" or peer_id == _client.id:
            continue
        _client.send_handoff(peer_id, SceneSyncProtocol.make_scene_request())
        return
    _scene_received = true


func _on_handoff_received(data: Dictionary) -> void:
    var payload = data.get("payload", {})
    if not (payload is Dictionary):
        return

    var from_info: Dictionary = data.get("from", {})
    _dispatch_scene_payload(payload, from_info)


func _dispatch_scene_payload(payload: Dictionary, from_info: Dictionary) -> void:
    var from_id := _safe_string(from_info.get("id", ""))
    var kind := _safe_string(payload.get("kind", ""))
    if kind == "":
        kind = _safe_string(payload.get("type", ""))

    match kind:
        "scene-graph-set":
            _handle_scene_graph_set(payload)
        "scene-graph-clear":
            _handle_scene_graph_clear(payload)
        "scene-asset-request":
            _handle_scene_asset_request(payload, from_id)
        "file":
            _handle_file_handoff(payload, from_id)
        "scene-request":
            _handle_scene_request(from_id)
        "scene-state":
            _handle_scene_state(payload)
        "scene-env":
            _handle_scene_env(payload)
        "scene-physics":
            if _client == null or from_id != _client.id:
                _apply_scene_physics_payload(payload, true)
        "scene-physics-hash", "scene-physics-snapshot", "scene-physics-snapshot-request", "scene-physics-input", "scene-physics-input-log", "scene-physics-input-log-clear":
            var local_id := _client.id if _client != null else ""
            if from_id != local_id:
                _ensure_rapier_bridge().handle_sync_payload(payload, from_info)
        "scene-clock":
            var local_id := _client.id if _client != null else ""
            if _playback_clock != null and (
                from_id != local_id
                or _playback_clock.mode == SceneSyncPlaybackClock.SHARED_PLAYBACK_CONTROL
            ):
                var times := _playback_time_samples()
                if _playback_clock.ingest(payload, from_id, local_id, times[0], times[1]):
                    playback_clock_mode = _playback_clock.mode
        "scene-delta":
            if from_id != _client.id:
                _handle_scene_delta(payload)
        "scene-add":
            if from_id != _client.id:
                _handle_scene_add(payload)
        "scene-remove":
            _handle_scene_remove(payload)
        "scene-delete":
            _handle_scene_remove(payload)
        "scene-mesh":
            if from_id != _client.id:
                _handle_scene_mesh(payload)
        "scene-lock":
            if from_id != _client.id:
                _handle_scene_lock(payload, from_info)
        "scene-unlock":
            _handle_scene_unlock(payload)
        "scene-batch":
            _handle_scene_batch(payload, from_info)


func _handle_scene_batch(payload: Dictionary, from_info: Dictionary) -> void:
    var ops = payload.get("ops", null)
    if not (ops is Array):
        ops = payload.get("actions", [])
    if not (ops is Array):
        return

    for op in ops:
        if op is Dictionary:
            var child := (op as Dictionary).duplicate(true)
            if payload.has("onBehalfOf") and not child.has("onBehalfOf"):
                child["onBehalfOf"] = payload["onBehalfOf"]
            _dispatch_scene_payload(child, from_info)


func _handle_scene_graph_set(payload: Dictionary) -> void:
    var graph = payload.get("graph", {})
    if not (graph is Dictionary):
        return

    var object_id := _graph_object_scope(payload)
    if object_id != "":
        var objects = _loom_graphs.get("objects", {})
        if not (objects is Dictionary):
            objects = {}
        objects[object_id] = (graph as Dictionary).duplicate(true)
        _loom_graphs["objects"] = objects
        _bind_loom_graph_for_object(object_id)
        return

    var scene_graph := graph as Dictionary
    _loom_graphs["scene"] = scene_graph.duplicate(true)
    _set_loom_scene_graph(scene_graph)


func _handle_scene_graph_clear(payload: Dictionary) -> void:
    var object_id := _graph_object_scope(payload)
    if object_id != "":
        var objects = _loom_graphs.get("objects", {})
        if objects is Dictionary:
            objects.erase(object_id)
            if objects.is_empty():
                _loom_graphs.erase("objects")
            else:
                _loom_graphs["objects"] = objects
        _clear_loom_object_graph(object_id)
        return

    _loom_graphs.erase("scene")
    _clear_loom_scene_graph()


func _handle_scene_env(payload: Dictionary) -> void:
    var env_id := _safe_string(payload.get("envId", ""))
    if env_id != "":
        _env_id = env_id


func _handle_scene_delta(payload: Dictionary) -> void:
    var object_id := _safe_string(payload.get("objectId", ""))
    var node_value = _managed_objects.get(object_id)
    if node_value == null or not is_instance_valid(node_value):
        return
    var node := node_value as Node3D
    if node == null:
        return
    var should_apply_transform := true
    if _selected_object != null and is_instance_valid(_selected_object):
        should_apply_transform = _get_object_id(_selected_object) != object_id
    if should_apply_transform:
        _apply_transform_to_node(node, SceneSyncProtocol.extract_transform(payload))
    _apply_payload_metadata(node, object_id, payload, true)
    _route_wire_asset(object_id, node, payload)
    if not should_apply_transform:
        return
    _last_snapshots[object_id] = _snapshot_for_node(node)


func _handle_scene_request(from_id: String) -> void:
    if from_id == "":
        return

    var objects := {}
    for node in _get_all_sync_targets():
        var object_id := _get_or_assign_object_id(node)
        var entry := await _build_object_payload(node, object_id)
        objects[object_id] = entry
    _client.send_handoff(from_id, SceneSyncProtocol.make_scene_state(
        objects,
        _loom_graphs,
        _env_id,
        get_scene_physics() if _scene_physics_present else null,
        _scene_physics_present
    ))


func _handle_scene_state(payload: Dictionary) -> void:
    _scene_received = true
    _handle_scene_env(payload)
    _apply_scene_physics_payload(payload, true)
    var loom_graphs = payload.get("loomGraphs", {})
    if loom_graphs is Dictionary:
        _loom_graphs = (loom_graphs as Dictionary).duplicate(true)
        _apply_loom_graph_state()

    var objects = payload.get("objects", {})
    if not (objects is Dictionary):
        return

    for object_id in objects.keys():
        var info = objects[object_id]
        if info is Dictionary:
            _handle_scene_add((info as Dictionary).merged({"objectId": object_id}, true))
    _apply_loom_graph_state()


func _handle_scene_add(payload: Dictionary) -> void:
    var object_id := _safe_string(payload.get("objectId", ""))
    if object_id == "":
        return
    if _managed_objects.has(object_id) and is_instance_valid(_managed_objects[object_id]):
        var existing := _managed_objects[object_id] as Node3D
        if existing != null:
            _apply_transform_to_node(existing, SceneSyncProtocol.extract_transform(payload))
            _apply_payload_metadata(existing, object_id, payload, true)
            _route_wire_asset(object_id, existing, payload)
        return

    var asset := _asset_from_payload(payload)
    var metadata := _metadata_from_payload(payload)
    var mesh_path := _mesh_path_from_payload(payload)
    var node := _resolve_existing_sync_target_for_payload(object_id, payload)
    if node != null:
        _bind_existing_managed_object(object_id, node)
        _apply_transform_to_node(node, SceneSyncProtocol.extract_transform(payload))
        _apply_payload_metadata(node, object_id, payload, true)
        _route_wire_asset(object_id, node, payload)
        if mesh_path != "":
            _mesh_paths[object_id] = mesh_path
        object_added.emit(object_id, node)
        return

    var asset_type := _safe_string(asset.get("type", "")).to_lower()
    if asset_type == "primitive":
        node = _create_primitive(
            _safe_string(asset.get("primitive", "box"), "box"),
            _safe_string(asset.get("color", "#888888"), "#888888")
        )
        _mark_remote_object(node)
    elif asset_type == "mesh":
        mesh_path = _safe_string(asset.get("meshPath", mesh_path), mesh_path)

    if node == null and _asset_needs_placeholder(asset):
        node = _create_loading_placeholder(_safe_string(payload.get("name", object_id), object_id))
        _mark_remote_object(node)
        _register_managed_object(object_id, node)
        _apply_transform_to_node(node, SceneSyncProtocol.extract_transform(payload))
        _apply_payload_metadata(node, object_id, payload, true)
        _route_wire_asset(object_id, node, payload)
        object_added.emit(object_id, node)
        return

    if node == null and mesh_path != "":
        node = _create_loading_placeholder(_safe_string(payload.get("name", object_id), object_id))
        _mark_remote_object(node)
        _register_managed_object(object_id, node)
        _apply_transform_to_node(node, SceneSyncProtocol.extract_transform(payload))
        _apply_payload_metadata(node, object_id, payload, true)
        _mesh_paths[object_id] = mesh_path
        _load_mesh_for_object(object_id, payload, mesh_path)
        return

    if node == null:
        node = _create_primitive("box")
        _mark_remote_object(node)

    _register_managed_object(object_id, node)
    _apply_transform_to_node(node, SceneSyncProtocol.extract_transform(payload))
    _apply_payload_metadata(node, object_id, payload, true)
    _route_wire_asset(object_id, node, payload)

    if not asset.is_empty():
        node.set_meta(ASSET_META, asset.duplicate(true))
    if not metadata.is_empty():
        node.set_meta(METADATA_META, metadata.duplicate(true))
    if mesh_path != "":
        _mesh_paths[object_id] = mesh_path
    object_added.emit(object_id, node)


func _handle_scene_remove(payload: Dictionary) -> void:
    var object_id := _safe_string(payload.get("objectId", ""))
    if _playback_clock != null:
        _playback_clock.forget_object(object_id)
    _cancel_carrier_load(object_id)
    if _remote_asset_loader != null:
        _remote_asset_loader.cancel_object(object_id)
    _remote_asset_contexts.erase(object_id)
    var node_value = _managed_objects.get(object_id)
    if node_value != null and is_instance_valid(node_value):
        var node := node_value as Node3D
        if node != null:
            if node == _selected_object:
                _selected_object = null
                _currently_locked_id = ""
            if bool(node.get_meta(REMOTE_OBJECT_META, false)):
                SceneSyncAnimationPolicy.stop(node)
                node.queue_free()
            elif _safe_string(node.get_meta(OBJECT_ID_META, "")) == object_id:
                node.remove_meta(OBJECT_ID_META)
    _managed_objects.erase(object_id)
    _known_ids.erase(object_id)
    _unbind_loom_object(object_id)
    _mesh_paths.erase(object_id)
    _asset_ids.erase(object_id)
    _metadata.erase(object_id)
    _animation_policies.erase(object_id)
    _object_physics.erase(object_id)
    _origins.erase(object_id)
    _unity_hierarchy_paths.erase(object_id)
    _locks.erase(object_id)
    _last_snapshots.erase(object_id)
    object_removed.emit(object_id)


func _handle_scene_mesh(payload: Dictionary) -> void:
    var object_id := _safe_string(payload.get("objectId", ""))
    var mesh_path := _mesh_path_from_payload(payload)
    if object_id == "" or mesh_path == "":
        return

    var node_value = _managed_objects.get(object_id)
    var node: Node3D = null
    var transform_data := {}
    if node_value != null and is_instance_valid(node_value):
        node = node_value as Node3D
        if node != null:
            transform_data = _snapshot_for_node(node)
    else:
        node = _resolve_existing_sync_target_for_payload(object_id, payload)
        if node != null:
            _bind_existing_managed_object(object_id, node)
            transform_data = _snapshot_for_node(node)
        else:
            node = _create_loading_placeholder(object_id)
            _mark_remote_object(node)
            _register_managed_object(object_id, node)
    _apply_payload_metadata(node, object_id, payload, true)
    _mesh_paths[object_id] = mesh_path
    var replacement_payload := {
        "objectId": object_id,
        "name": _safe_string(payload.get("name", object_id), object_id),
        "position": SceneSyncProtocol.pos_to_wire(transform_data.get("position", Vector3.ZERO)),
        "rotation": SceneSyncProtocol.rot_to_wire(transform_data.get("rotation", Quaternion.IDENTITY)),
        "scale": SceneSyncProtocol.scale_to_wire(transform_data.get("scale", Vector3.ONE)),
        "asset": _asset_from_payload(payload),
        "metadata": _metadata_from_payload(payload),
        "assetId": _safe_string(payload.get("assetId", "")),
        "origin": _safe_string(payload.get("origin", "")),
        "unityHierarchyPath": _safe_string(payload.get("unityHierarchyPath", "")),
    }
    if payload.has("animation"):
        replacement_payload["animation"] = payload.get("animation", null)
    elif _has_animation_policy(object_id):
        replacement_payload["animation"] = get_animation_policy(object_id)
    if payload.has("physics"):
        replacement_payload["physics"] = payload.get("physics", null)
    elif _has_object_physics(object_id):
        replacement_payload["physics"] = get_object_physics(object_id)
    _load_mesh_for_object(object_id, replacement_payload, mesh_path)


func _handle_scene_lock(payload: Dictionary, from_info: Dictionary) -> void:
    var object_id := _safe_string(payload.get("objectId", ""))
    var from_id := _safe_string(from_info.get("id", ""))
    if object_id == "" or from_id == "":
        return
    _locks[object_id] = from_id
    if _selected_object != null and _get_object_id(_selected_object) == object_id and from_id != _client.id:
        deselect_object()


func _handle_scene_unlock(payload: Dictionary) -> void:
    var object_id := _safe_string(payload.get("objectId", ""))
    if object_id != "":
        _locks.erase(object_id)


func _send_transform_delta() -> void:
    if _selected_object == null or not is_instance_valid(_selected_object):
        return
    var object_id := _get_or_assign_object_id(_selected_object)
    if _rapier_bridge != null and _rapier_bridge.is_active() and _rapier_bridge.is_body_registered(object_id):
        return
    var snapshot := _snapshot_for_node(_selected_object)
    if _snapshots_equal(_last_snapshots.get(object_id, {}), snapshot):
        return

    _last_snapshots[object_id] = snapshot
    _client.broadcast(SceneSyncProtocol.make_scene_delta(
        object_id,
        snapshot["position"],
        snapshot["rotation"],
        snapshot["scale"]
    ))


func _detect_hierarchy_changes() -> void:
    var current_ids := {}
    for node in _get_all_sync_targets():
        if not _node_has_mesh(node):
            continue
        var object_id := _get_object_id(node)
        if object_id == "":
            object_id = _get_or_assign_object_id(node)
            current_ids[object_id] = true
            _send_scene_add(node, object_id)
            continue
        current_ids[object_id] = true
        _managed_objects[object_id] = node
        _known_ids[object_id] = true

    for object_id in _known_ids.keys():
        if current_ids.has(object_id):
            continue
        var node_value = _managed_objects.get(object_id)
        if node_value != null and is_instance_valid(node_value):
            var node := node_value as Node3D
            if node != null and _is_node_within_sync_root(node):
                continue
        _client.broadcast(SceneSyncProtocol.make_scene_remove(_safe_string(object_id)))
        _managed_objects.erase(object_id)
        _unbind_loom_object(_safe_string(object_id))
        if _remote_asset_loader != null:
            _remote_asset_loader.cancel_object(_safe_string(object_id))
        _remote_asset_contexts.erase(object_id)
        _cancel_carrier_load(_safe_string(object_id))
        _mesh_paths.erase(object_id)
        _asset_ids.erase(object_id)
        _metadata.erase(object_id)
        _animation_policies.erase(object_id)
        _object_physics.erase(object_id)
        if _playback_clock != null:
            _playback_clock.forget_object(_safe_string(object_id))
        _origins.erase(object_id)
        _unity_hierarchy_paths.erase(object_id)
        _locks.erase(object_id)
        _last_snapshots.erase(object_id)
        _known_ids.erase(object_id)


func _send_scene_add(node: Node3D, object_id: String) -> void:
    var payload := await _build_object_payload(node, object_id)
    _client.broadcast(payload)


func _build_object_payload(node: Node3D, object_id: String) -> Dictionary:
    var snapshot := _snapshot_for_node(node)
    var asset := _detect_asset(node)
    var mesh_path := _safe_string(_mesh_paths.get(object_id, ""))
    var asset_id := _get_asset_id(node, object_id)
    var metadata := _get_metadata(node, object_id)
    var origin := _get_origin(node, object_id)
    var unity_hierarchy_path := _get_unity_hierarchy_path(node, object_id)
    var animation: Variant = get_animation_policy(object_id) if _has_animation_policy(object_id) else null
    var has_physics := _has_object_physics(object_id)
    var physics: Variant = get_object_physics(object_id) if has_physics else null

    if mesh_path == "" and asset.is_empty() and _node_has_mesh(node):
        var glb := SceneSyncGltfHelper.export_glb(node)
        if not glb.is_empty():
            if asset_id == "":
                asset_id = SceneSyncBlobClient.compute_asset_id(glb)
            if asset_id != "":
                _asset_ids[object_id] = asset_id
                node.set_meta(ASSET_ID_META, asset_id)
            mesh_path = SceneSyncBlobClient.generate_random_path()
            var upload_err := await _blob_client.upload_glb(glb, mesh_path)
            if upload_err == OK:
                _mesh_paths[object_id] = mesh_path
                _cache_mesh_data(mesh_path, asset_id, glb)
            else:
                mesh_path = ""

    if mesh_path != "":
        if asset.is_empty():
            asset = {
                "type": "mesh",
                "source": "carrier",
                "meshPath": mesh_path,
            }
        elif _safe_string(asset.get("type", "")) == "mesh" and not asset.has("meshPath"):
            asset["meshPath"] = mesh_path
        if asset_id != "" and not asset.has("assetId"):
            asset["assetId"] = asset_id

    var payload := SceneSyncProtocol.make_scene_add(
        object_id,
        node.name,
        snapshot["position"],
        snapshot["rotation"],
        snapshot["scale"],
        mesh_path,
        asset,
        asset_id,
        metadata,
        origin,
        unity_hierarchy_path,
        node.visible,
        animation,
        physics,
        has_physics
    )
    return payload


func _sync_mesh_for_node(node: Node3D) -> void:
    var object_id := _get_or_assign_object_id(node)
    var glb := SceneSyncGltfHelper.export_glb(node)
    if glb.is_empty():
        return

    var mesh_path := SceneSyncBlobClient.generate_random_path()
    var asset_id := _get_asset_id(node, object_id)
    if asset_id == "":
        asset_id = SceneSyncBlobClient.compute_asset_id(glb)
    if asset_id != "":
        _asset_ids[object_id] = asset_id
        node.set_meta(ASSET_ID_META, asset_id)
    var upload_err := await _blob_client.upload_glb(glb, mesh_path)
    if upload_err != OK:
        return

    _mesh_paths[object_id] = mesh_path
    var asset := _detect_asset(node)
    if asset.is_empty():
        asset = {
            "type": "mesh",
            "source": "carrier",
            "meshPath": mesh_path,
        }
    elif _safe_string(asset.get("type", "")) == "mesh" and not asset.has("meshPath"):
        asset["meshPath"] = mesh_path
    if asset_id != "" and not asset.has("assetId"):
        asset["assetId"] = asset_id
    _cache_mesh_data(mesh_path, asset_id, glb)
    _client.broadcast(SceneSyncProtocol.make_scene_mesh(
        object_id,
        mesh_path,
        asset_id,
        asset,
        _get_metadata(node, object_id),
        _get_origin(node, object_id),
        _get_unity_hierarchy_path(node, object_id),
        get_animation_policy(object_id) if _has_animation_policy(object_id) else null,
        get_object_physics(object_id) if _has_object_physics(object_id) else null,
        _has_object_physics(object_id)
    ))


func _load_mesh_for_object(object_id: String, payload: Dictionary, mesh_path: String) -> void:
    var expected_node := _get_managed_node(object_id)
    if expected_node == null:
        return
    var load_signature := "%s:%d:%d" % [mesh_path, expected_node.get_instance_id(), Time.get_ticks_usec()]
    _carrier_load_signatures[object_id] = load_signature
    var asset_id := _asset_id_from_payload(payload)
    var data := _get_cached_mesh_data(mesh_path, asset_id)
    if data.is_empty():
        data = await _blob_client.download_glb(mesh_path)
        if not data.is_empty():
            _cache_mesh_data(mesh_path, asset_id, data)
    if _safe_string(_carrier_load_signatures.get(object_id, "")) != load_signature:
        return
    var current_node := _get_managed_node(object_id)
    if current_node == null or current_node.get_instance_id() != expected_node.get_instance_id():
        return
    if _safe_string(_mesh_paths.get(object_id, "")) != mesh_path:
        return
    _carrier_load_signatures.erase(object_id)
    if data.is_empty():
        _handle_missing_glb(object_id, mesh_path, null, asset_id)
    _replace_object_with_mesh_data(object_id, payload, data)


func _load_mesh_bytes_for_object(object_id: String, data: PackedByteArray, asset_id: String = "") -> void:
    var node := _get_managed_node(object_id)
    if node == null:
        push_warning("[SceneSync] Cannot load recovered GLB; object not found: %s" % object_id)
        return

    var snapshot := _snapshot_for_node(node)
    var asset := _get_asset(node, object_id)
    var mesh_path := _safe_string(_mesh_paths.get(object_id, ""))
    if mesh_path != "":
        asset["meshPath"] = mesh_path
    if asset_id != "":
        asset["assetId"] = asset_id

    var payload := {
        "objectId": object_id,
        "name": node.name,
        "position": SceneSyncProtocol.pos_to_wire(snapshot.get("position", Vector3.ZERO)),
        "rotation": SceneSyncProtocol.rot_to_wire(snapshot.get("rotation", Quaternion.IDENTITY)),
        "scale": SceneSyncProtocol.scale_to_wire(snapshot.get("scale", Vector3.ONE)),
        "asset": asset,
        "metadata": _get_metadata(node, object_id),
        "origin": _get_origin(node, object_id),
        "unityHierarchyPath": _get_unity_hierarchy_path(node, object_id),
    }
    if _has_animation_policy(object_id):
        payload["animation"] = get_animation_policy(object_id)
    if _has_object_physics(object_id):
        payload["physics"] = get_object_physics(object_id)
    if mesh_path != "":
        payload["meshPath"] = mesh_path
    if asset_id != "":
        payload["assetId"] = asset_id

    _replace_object_with_mesh_data(object_id, payload, data)


func _replace_object_with_mesh_data(object_id: String, payload: Dictionary, data: PackedByteArray) -> void:
    var old_node := _get_managed_node(object_id)
    var retained_animation: Variant = get_animation_policy(object_id) if _has_animation_policy(object_id) else null
    var retained_physics: Variant = get_object_physics(object_id) if _has_object_physics(object_id) else null
    var old_was_remote := old_node != null and bool(old_node.get_meta(REMOTE_OBJECT_META, false))
    if old_node != null and not old_was_remote:
        old_node.set_meta(OBJECT_ID_META, object_id)
        _managed_objects[object_id] = old_node
        _known_ids[object_id] = true
        _bind_loom_object_target(object_id, old_node)
        object_added.emit(object_id, old_node)
        return
    var replacement: Node3D = null

    if not data.is_empty():
        replacement = _wrap_imported_mesh_for_visual_basis(
            SceneSyncGltfHelper.import_glb(data),
            _visual_basis_from_payload(payload)
        )
    if replacement == null:
        replacement = _create_primitive("box", "#ff4444")

    var parent: Node3D = _get_or_create_sync_root()
    if parent == null:
        return

    parent.add_child(replacement)
    if Engine.is_editor_hint():
        _assign_editor_owner_recursive(replacement)

    replacement.name = _safe_string(payload.get("name", object_id), object_id)
    replacement.set_meta(OBJECT_ID_META, object_id)
    _apply_transform_to_node(replacement, SceneSyncProtocol.extract_transform(payload))
    _apply_payload_metadata(replacement, object_id, payload, true)

    if old_node != null and is_instance_valid(old_node):
        if old_node == _selected_object:
            _selected_object = replacement
        old_node.queue_free()

    _managed_objects[object_id] = replacement
    _known_ids[object_id] = true
    if old_was_remote:
        _mark_remote_object(replacement)
    if not payload.has("animation") and retained_animation is Dictionary and not replacement.has_meta(ANIMATION_META):
        var retained_policy := (retained_animation as Dictionary).duplicate(true)
        _animation_policies[object_id] = retained_policy
        replacement.set_meta(ANIMATION_META, retained_policy.duplicate(true))
    if not payload.has("physics") and retained_physics is Dictionary and not replacement.has_meta(PHYSICS_META):
        var retained_object_physics := (retained_physics as Dictionary).duplicate(true)
        _object_physics[object_id] = retained_object_physics
        replacement.set_meta(PHYSICS_META, retained_object_physics.duplicate(true))
    _bind_loom_object_target(object_id, replacement)
    _apply_animation_policy(object_id, replacement)
    object_added.emit(object_id, replacement)


func _register_managed_object(object_id: String, node: Node3D) -> void:
    var parent: Node3D = _get_or_create_sync_root()
    if parent == null:
        return
    if node.get_parent() != parent:
        parent.add_child(node)
    if Engine.is_editor_hint():
        _assign_editor_owner_recursive(node)
    node.name = node.name if node.name != "" else object_id
    node.set_meta(OBJECT_ID_META, object_id)
    _managed_objects[object_id] = node
    _known_ids[object_id] = true
    _bind_loom_object_target(object_id, node)


func _bind_existing_managed_object(object_id: String, node: Node3D) -> void:
    node.set_meta(OBJECT_ID_META, object_id)
    _managed_objects[object_id] = node
    _known_ids[object_id] = true
    _bind_loom_object_target(object_id, node)


func _create_primitive(primitive_type: String, color: String = "#888888") -> MeshInstance3D:
    var mesh_instance := MeshInstance3D.new()
    var mesh: Mesh
    match primitive_type:
        "box":
            mesh = BoxMesh.new()
        "sphere":
            mesh = SphereMesh.new()
        "cylinder":
            mesh = CylinderMesh.new()
        "cone":
            var cone := CylinderMesh.new()
            cone.top_radius = 0.0
            mesh = cone
        "plane":
            mesh = PlaneMesh.new()
        "torus":
            mesh = TorusMesh.new()
        _:
            mesh = BoxMesh.new()
    mesh_instance.mesh = mesh

    var mat := StandardMaterial3D.new()
    mat.albedo_color = Color.from_string(color, Color(0.53, 0.53, 0.53))
    mesh_instance.material_override = mat
    return mesh_instance


func _create_loading_placeholder(display_name: String) -> Node3D:
    var wrapper := Node3D.new()
    wrapper.name = display_name
    var mesh := _create_primitive("box", "#88ccff")
    wrapper.add_child(mesh)
    return wrapper


func _detect_asset(node: Node3D) -> Dictionary:
    if node.has_meta(ASSET_META):
        var existing = node.get_meta(ASSET_META)
        if existing is Dictionary:
            return existing.duplicate(true)

    if node is MeshInstance3D:
        var mesh_instance: MeshInstance3D = node
        var primitive_type := _primitive_type_for_mesh(mesh_instance.mesh)
        if primitive_type != "":
            var color := "#888888"
            if mesh_instance.material_override is BaseMaterial3D:
                color = (mesh_instance.material_override as BaseMaterial3D).albedo_color.to_html()
            return {
                "type": "primitive",
                "primitive": primitive_type,
                "color": color,
            }
    return {}


func _asset_from_payload(payload: Dictionary) -> Dictionary:
    var asset = payload.get("asset", {})
    if asset is Dictionary:
        var result := (asset as Dictionary).duplicate(true)
        var mesh_path := _safe_string(payload.get("meshPath", ""))
        if mesh_path != "" and not result.has("meshPath"):
            result["meshPath"] = mesh_path
        var asset_id := _safe_string(payload.get("assetId", ""))
        if asset_id != "" and not result.has("assetId"):
            result["assetId"] = asset_id
        return result
    return {}


func _metadata_from_payload(payload: Dictionary) -> Dictionary:
    var metadata = payload.get("metadata", {})
    if metadata is Dictionary:
        return (metadata as Dictionary).duplicate(true)
    return {}


func _mesh_path_from_payload(payload: Dictionary) -> String:
    var mesh_path := _safe_string(payload.get("meshPath", ""))
    if mesh_path != "":
        return mesh_path
    var asset := _asset_from_payload(payload)
    if asset.is_empty():
        return ""
    return _safe_string(asset.get("meshPath", ""))


func _asset_id_from_payload(payload: Dictionary) -> String:
    var asset_id := _safe_string(payload.get("assetId", ""))
    if asset_id != "":
        return asset_id
    var asset := _asset_from_payload(payload)
    if asset.is_empty():
        return ""
    return _safe_string(asset.get("assetId", ""))


func _visual_basis_from_payload(payload: Dictionary) -> String:
    var asset := _asset_from_payload(payload)
    if asset.is_empty():
        return ""
    return _safe_string(asset.get("visualBasis", ""))


func _asset_needs_placeholder(asset: Dictionary) -> bool:
    var asset_type := _safe_string(asset.get("type", "")).to_lower()
    if asset_type == "text":
        return true
    if asset_type == "mesh" or asset_type == "image":
        return _has_remote_asset_url(asset)
    return false


func _has_remote_asset_url(asset: Dictionary) -> bool:
    var url := _safe_string(asset.get("url", ""))
    if url == "":
        return false
    var source := _safe_string(asset.get("source", "")).to_lower()
    if source == "carrier":
        return false
    return source == "url" or source == ""


func _asset_signature(asset: Dictionary) -> String:
    if asset.is_empty():
        return ""
    return JSON.stringify(asset).sha256_text()


func _route_wire_asset(object_id: String, node: Node3D, payload: Dictionary) -> void:
    if object_id == "" or node == null or not is_instance_valid(node):
        return
    var asset := _asset_from_payload(payload)
    if asset.is_empty():
        return

    var asset_type := _safe_string(asset.get("type", "")).to_lower()
    if asset_type == "primitive":
        _cancel_carrier_load(object_id)
        _cancel_remote_asset_load(object_id)
        var primitive_result := SceneSyncWireAssetVisual.apply_primitive(node, asset)
        if not bool(primitive_result.get("ok", false)):
            _emit_visual_failure(object_id, "primitive", primitive_result, 0)
        return

    if asset_type == "text" and not _has_remote_asset_url(asset):
        _cancel_carrier_load(object_id)
        _cancel_remote_asset_load(object_id)
        var text_result := SceneSyncWireAssetVisual.apply_text(node, asset, asset.get("text", null))
        if not bool(text_result.get("ok", false)):
            _emit_visual_failure(object_id, "text", text_result, 0)
        return

    if asset_type in ["mesh", "image", "text"] and _has_remote_asset_url(asset):
        _cancel_carrier_load(object_id)
        _start_remote_asset_load(object_id, node, asset)
        return
    _cancel_remote_asset_load(object_id)
    if not (asset_type == "mesh" and _mesh_path_from_payload(payload) != ""):
        _cancel_carrier_load(object_id)


func _start_remote_asset_load(object_id: String, node: Node3D, asset: Dictionary) -> void:
    if _remote_asset_loader == null:
        return
    var signature := _asset_signature(asset)
    if signature == "":
        return
    var previous_value = _remote_asset_contexts.get(object_id, {})
    if previous_value is Dictionary:
        var previous := previous_value as Dictionary
        if (
            _safe_string(previous.get("signature", "")) == signature
            and int(previous.get("nodeId", 0)) == node.get_instance_id()
        ):
            return

    _remote_asset_contexts[object_id] = {
        "signature": signature,
        "nodeId": node.get_instance_id(),
        "asset": asset.duplicate(true),
    }

    var asset_id := _safe_string(asset.get("assetId", ""))
    if _safe_string(asset.get("type", "")).to_lower() == "mesh" and _is_sha256_asset_id(asset_id):
        var cached := _get_cached_mesh_data("", asset_id)
        if not cached.is_empty():
            _apply_remote_asset_bytes(object_id, signature, "mesh", cached)
            return
    _remote_asset_loader.request_asset(object_id, signature, asset)


func _cancel_remote_asset_load(object_id: String) -> void:
    if _remote_asset_loader != null:
        _remote_asset_loader.cancel_object(object_id)
    _remote_asset_contexts.erase(object_id)


func _cancel_carrier_load(object_id: String) -> void:
    _carrier_load_signatures.erase(object_id)
    for request_id in _pending_recoveries.keys():
        var recovery_value = _pending_recoveries.get(request_id, {})
        if recovery_value is Dictionary:
            if _safe_string((recovery_value as Dictionary).get("objectId", "")) == object_id:
                _pending_recoveries.erase(request_id)


func _on_remote_asset_loaded(
    object_id: String,
    signature: String,
    asset_type: String,
    data: PackedByteArray
) -> void:
    _apply_remote_asset_bytes(object_id, signature, asset_type, data)


func _apply_remote_asset_bytes(
    object_id: String,
    signature: String,
    asset_type: String,
    data: PackedByteArray
) -> void:
    var context := _current_remote_asset_context(object_id, signature)
    if context.is_empty():
        return
    var node := _get_managed_node(object_id)
    if node == null or node.get_instance_id() != int(context.get("nodeId", 0)):
        return
    var asset_value = context.get("asset", {})
    if not (asset_value is Dictionary):
        return
    var asset := asset_value as Dictionary

    var result := {}
    match asset_type:
        "mesh":
            result = SceneSyncWireAssetVisual.apply_glb_bytes(node, data, asset)
        "image":
            result = SceneSyncWireAssetVisual.apply_image_bytes(node, data)
        "text":
            result = SceneSyncWireAssetVisual.apply_text(node, asset, data.get_string_from_utf8())
        _:
            result = {"ok": false, "reason": "unsupported-asset-type"}

    if not bool(result.get("ok", false)):
        _emit_visual_failure(object_id, asset_type, result, data.size())
        _remote_asset_contexts.erase(object_id)
        return

    if asset_type == "mesh":
        var asset_id := _safe_string(asset.get("assetId", ""))
        if _is_sha256_asset_id(asset_id):
            _cache_mesh_data("", asset_id, data)
        _apply_animation_policy(object_id, node)
    _remote_asset_contexts.erase(object_id)
    object_added.emit(object_id, node)


func _on_remote_asset_failed(
    object_id: String,
    signature: String,
    _asset_type: String,
    _detail: Dictionary
) -> void:
    if not _current_remote_asset_context(object_id, signature).is_empty():
        _remote_asset_contexts.erase(object_id)


func _on_remote_asset_diagnostic(object_id: String, detail: Dictionary) -> void:
    if not _remote_asset_contexts.has(object_id):
        return
    asset_load_diagnostic.emit(object_id, detail.duplicate(true))


func _current_remote_asset_context(object_id: String, signature: String) -> Dictionary:
    var context_value = _remote_asset_contexts.get(object_id, {})
    if not (context_value is Dictionary):
        return {}
    var context := context_value as Dictionary
    if _safe_string(context.get("signature", "")) != signature:
        return {}
    var node := _get_managed_node(object_id)
    if node == null or node.get_instance_id() != int(context.get("nodeId", 0)):
        return {}
    return context


func _emit_visual_failure(object_id: String, asset_type: String, result: Dictionary, bytes: int) -> void:
    asset_load_diagnostic.emit(object_id, {
        "assetType": asset_type,
        "reason": _safe_string(result.get("reason", "visual-apply-failed"), "visual-apply-failed"),
        "requestResult": -1,
        "status": 0,
        "bytes": maxi(bytes, 0),
        "attempt": 1,
        "maxAttempts": 1,
        "retryDelay": 0.0,
        "willRetry": false,
    })


func _cache_mesh_data(mesh_path: String, asset_id: String, data: PackedByteArray) -> void:
    if data.is_empty():
        return
    if mesh_path != "":
        _mesh_data_by_path[mesh_path] = data
    if asset_id != "":
        _mesh_data_by_asset_id[asset_id] = data


func _get_cached_mesh_data(mesh_path: String, asset_id: String) -> PackedByteArray:
    if asset_id != "" and _mesh_data_by_asset_id.has(asset_id):
        var by_asset: PackedByteArray = _mesh_data_by_asset_id[asset_id]
        return by_asset
    if mesh_path != "" and _mesh_data_by_path.has(mesh_path):
        var by_path: PackedByteArray = _mesh_data_by_path[mesh_path]
        return by_path
    return PackedByteArray()


func _handle_scene_asset_request(payload: Dictionary, requester_peer_id: String) -> void:
    if requester_peer_id == "":
        return
    var request_id := _safe_string(payload.get("requestId", ""))
    var object_id := _safe_string(payload.get("objectId", ""))
    if request_id == "" or object_id == "":
        return
    if _get_managed_node(object_id) == null:
        return

    var asset_id := _safe_string(payload.get("assetId", ""))
    var mesh_path := _safe_string(payload.get("meshPath", ""))
    var cache_key := asset_id if asset_id != "" else mesh_path
    if cache_key == "":
        return

    var cooldown_key := "%s-%s" % [cache_key, requester_peer_id]
    var now := Time.get_ticks_msec() / 1000.0
    if _responder_cooldowns.has(cooldown_key):
        var last_time := float(_responder_cooldowns[cooldown_key])
        if now - last_time < RECOVERY_RESPONDER_COOLDOWN_SECONDS:
            return

    if _active_outgoing_transfer_id != "":
        return

    var data := _get_cached_mesh_data(mesh_path, asset_id)
    if data.is_empty() or data.size() > MAX_GLB_SIZE:
        return

    _responder_cooldowns[cooldown_key] = now
    _active_outgoing_transfer_id = request_id
    var filename := "%s.glb" % (asset_id if asset_id != "" else object_id)
    await _send_glb_to_peer(requester_peer_id, filename, data)
    if _active_outgoing_transfer_id == request_id:
        _active_outgoing_transfer_id = ""


func _handle_missing_glb(object_id: String, mesh_path: String, expected_size: Variant, asset_id: String) -> void:
    var request_id := _generate_recovery_request_id()
    var recovery := {
        "requestId": request_id,
        "objectId": object_id,
        "assetId": asset_id,
        "meshPath": mesh_path,
        "expectedSize": expected_size,
        "requestedAt": Time.get_ticks_msec() / 1000.0,
        "requestedPeerIds": {},
    }
    _pending_recoveries[request_id] = recovery

    var peers := _get_other_peers()
    if peers.is_empty():
        _remove_recovery_after_timeout(request_id)
        return

    _retry_recovery_peers(request_id, peers)
    _remove_recovery_after_timeout(request_id)


func _retry_recovery_peers(request_id: String, peers: Array) -> void:
    for peer in peers:
        if not _pending_recoveries.has(request_id):
            return
        if not (peer is Dictionary):
            continue
        var peer_id := _safe_string((peer as Dictionary).get("id", ""))
        if peer_id == "" or peer_id == _client.id:
            continue

        var recovery: Dictionary = _pending_recoveries[request_id]
        var requested_peer_ids: Dictionary = recovery.get("requestedPeerIds", {})
        requested_peer_ids[peer_id] = true
        recovery["requestedPeerIds"] = requested_peer_ids
        _pending_recoveries[request_id] = recovery

        _client.send_handoff(peer_id, SceneSyncProtocol.make_scene_asset_request(
            request_id,
            _safe_string(recovery.get("objectId", "")),
            _safe_string(recovery.get("assetId", "")),
            _safe_string(recovery.get("meshPath", "")),
            recovery.get("expectedSize", null)
        ))

        if get_tree() == null:
            return
        await get_tree().create_timer(PEER_RETRY_INTERVAL_SECONDS).timeout

    if _pending_recoveries.has(request_id):
        _pending_recoveries.erase(request_id)


func _remove_recovery_after_timeout(request_id: String) -> void:
    if get_tree() == null:
        return
    await get_tree().create_timer(RECOVERY_TIMEOUT_SECONDS).timeout
    _pending_recoveries.erase(request_id)


func _handle_file_handoff(payload: Dictionary, from_peer_id: String) -> void:
    var path := _safe_string(payload.get("path", ""))
    var filename := _safe_string(payload.get("filename", ""))
    var size := _safe_int(payload.get("size", 0), 0)
    var mime := _safe_string(payload.get("mime", ""))
    if not _can_accept_file_handoff(from_peer_id, filename, size, mime):
        return

    var url := "%s/%s" % [_get_piping_server_base().trim_suffix("/"), path.uri_encode()]
    var data := await _download_bytes_from_url(url)
    _handle_received_file(from_peer_id, filename, data, mime)


func _can_accept_file_handoff(from_peer_id: String, filename: String, size: int, mime: String) -> bool:
    if from_peer_id == "" or filename == "" or size <= 0 or mime == "":
        return false
    if size > MAX_GLB_SIZE:
        return false
    if mime != "model/gltf-binary" and not filename.to_lower().ends_with(".glb"):
        return false

    for recovery_value in _pending_recoveries.values():
        if not (recovery_value is Dictionary):
            continue
        var recovery: Dictionary = recovery_value
        var requested_peer_ids: Dictionary = recovery.get("requestedPeerIds", {})
        if not requested_peer_ids.has(from_peer_id):
            continue
        var expected = recovery.get("expectedSize", null)
        if expected != null and int(expected) != size:
            continue
        return true
    return false


func _handle_received_file(from_peer_id: String, filename: String, data: PackedByteArray, mime: String) -> void:
    if data.is_empty() or data.size() > MAX_GLB_SIZE:
        return
    if mime != "model/gltf-binary" and not filename.to_lower().ends_with(".glb"):
        return

    var matched_request_id := ""
    var matched_recovery := {}
    for request_id in _pending_recoveries.keys():
        var recovery_value = _pending_recoveries[request_id]
        if not (recovery_value is Dictionary):
            continue
        var recovery: Dictionary = recovery_value
        var requested_peer_ids: Dictionary = recovery.get("requestedPeerIds", {})
        if not requested_peer_ids.has(from_peer_id):
            continue
        var expected = recovery.get("expectedSize", null)
        if expected != null and int(expected) != data.size():
            continue
        matched_request_id = _safe_string(request_id)
        matched_recovery = recovery
        break

    if matched_request_id == "":
        return

    var expected_asset_id := _safe_string(matched_recovery.get("assetId", ""))
    var computed_asset_id := ""
    if expected_asset_id != "":
        computed_asset_id = SceneSyncBlobClient.compute_asset_id(data)
        if computed_asset_id == "" or computed_asset_id != expected_asset_id:
            return

    _pending_recoveries.erase(matched_request_id)
    var mesh_path := _safe_string(matched_recovery.get("meshPath", ""))
    _cache_mesh_data(mesh_path, computed_asset_id if computed_asset_id != "" else expected_asset_id, data)
    _load_mesh_bytes_for_object(
        _safe_string(matched_recovery.get("objectId", "")),
        data,
        computed_asset_id if computed_asset_id != "" else expected_asset_id
    )


func _send_glb_to_peer(target_peer_id: String, filename: String, data: PackedByteArray) -> void:
    if target_peer_id == "" or data.is_empty():
        return
    var path := SceneSyncBlobClient.generate_random_path()
    var display_url := "%s/#%s" % [_get_piping_display_url().trim_suffix("/"), path]
    _client.send_handoff(target_peer_id, SceneSyncProtocol.make_file_handoff(
        path,
        filename,
        data.size(),
        "model/gltf-binary",
        display_url
    ))

    var upload_url := "%s/%s" % [_get_piping_server_base().trim_suffix("/"), path.uri_encode()]
    await _upload_bytes_to_url(upload_url, data, "model/gltf-binary")


func _upload_bytes_to_url(url: String, data: PackedByteArray, mime: String) -> Error:
    var request := HTTPRequest.new()
    add_child(request)
    var headers := PackedStringArray(["Content-Type: %s" % mime])
    var err := request.request_raw(url, headers, HTTPClient.METHOD_POST, data)
    if err != OK:
        request.queue_free()
        return err
    var result: Array = await request.request_completed
    request.queue_free()
    var response_code := int(result[1])
    return OK if response_code >= 200 and response_code < 300 else ERR_CANT_CONNECT


func _download_bytes_from_url(url: String) -> PackedByteArray:
    var request := HTTPRequest.new()
    add_child(request)
    var err := request.request(url)
    if err != OK:
        request.queue_free()
        return PackedByteArray()
    var result: Array = await request.request_completed
    request.queue_free()
    var response_code := int(result[1])
    if response_code < 200 or response_code >= 300:
        return PackedByteArray()
    return result[3]


func _get_other_peers() -> Array:
    var result: Array = []
    if _client == null:
        return result
    for peer in _client.peers:
        if peer is Dictionary and _safe_string((peer as Dictionary).get("id", "")) != _client.id:
            result.append(peer)
    return result


func _get_piping_server_base() -> String:
    var raw := presence_url.replace("wss://", "").replace("ws://", "")
    var host := raw.split("/", false, 1)[0]
    if host == "" or host.begins_with("localhost") or host.begins_with("127.0.0.1"):
        return "http://localhost:8080"
    return "https://pipe.afjk.jp"


func _get_piping_display_url() -> String:
    var scheme := "https://"
    var raw := presence_url
    if raw.begins_with("ws://"):
        scheme = "http://"
    raw = raw.replace("wss://", "").replace("ws://", "")
    var host := raw.split("/", false, 1)[0]
    if host == "" or host.begins_with("localhost") or host.begins_with("127.0.0.1"):
        return "http://localhost"
    return "%s%s/pipe" % [scheme, host]


func _generate_recovery_request_id() -> String:
    var rng := RandomNumberGenerator.new()
    rng.randomize()
    return "%d-%06d" % [Time.get_ticks_usec(), rng.randi_range(0, 999999)]


func _safe_string(value: Variant, fallback: String = "") -> String:
    if value is String:
        return value
    if value is StringName:
        return String(value)
    return fallback


func _safe_int(value: Variant, fallback: int = 0) -> int:
    if value is int:
        return value
    if value is float and is_finite(float(value)):
        return int(value)
    return fallback


func _is_sha256_asset_id(value: Variant) -> bool:
    var asset_id := _safe_string(value)
    if asset_id.length() != 71 or not asset_id.begins_with("sha256-"):
        return false
    for character in asset_id.substr(7):
        if character not in "0123456789abcdef":
            return false
    return true


func _mark_remote_object(node: Node3D) -> void:
    if node != null:
        node.set_meta(REMOTE_OBJECT_META, true)


func _ensure_playback_clock() -> SceneSyncPlaybackClock:
    if _playback_clock != null:
        return _playback_clock
    _playback_clock = SceneSyncPlaybackClock.new()
    _playback_clock.broadcast_interval = playback_clock_broadcast_interval
    _playback_clock.follow_policy = playback_follow_policy
    _playback_clock.allow_control = allow_playback_control
    _playback_clock.broadcast_requested.connect(_on_playback_clock_broadcast_requested)
    _playback_clock.state_changed.connect(_on_playback_clock_state_changed)
    _playback_clock.set_mode(playback_clock_mode, "", nickname, _managed_objects.keys())
    return _playback_clock


func _playback_time_samples() -> Array[float]:
    return [
        float(Time.get_ticks_usec()) / 1000000.0,
        Time.get_unix_time_from_system(),
    ]


func _ensure_rapier_bridge() -> Node:
    if _rapier_bridge != null and is_instance_valid(_rapier_bridge):
        return _rapier_bridge
    _rapier_bridge = RAPIER_BRIDGE_SCRIPT.new()
    _rapier_bridge.name = "SceneSyncRapierBridge"
    _rapier_bridge.auto_run = rapier_physics_enabled
    _rapier_bridge.max_steps_per_update = rapier_max_steps_per_update
    _rapier_bridge.hash_broadcast_interval_ticks = rapier_hash_broadcast_interval_ticks
    add_child(_rapier_bridge)
    _rapier_bridge.availability_changed.connect(_on_rapier_availability_changed)
    _rapier_bridge.runtime_state_changed.connect(_on_rapier_runtime_state_changed)
    _rapier_bridge.hash_report_requested.connect(_on_rapier_hash_report_requested)
    _rapier_bridge.hash_checked.connect(_on_rapier_hash_checked)
    _rapier_bridge.diagnostic.connect(_on_rapier_diagnostic)
    _rapier_bridge.attach_manager(self)
    return _rapier_bridge


func _apply_scene_physics_payload(payload: Dictionary, preserve_missing: bool = true) -> void:
    if payload.has("physics"):
        var physics_value = payload.get("physics", null)
        if physics_value is Dictionary:
            _scene_physics = (physics_value as Dictionary).duplicate(true)
            _scene_physics_present = true
            set_meta(PHYSICS_META, _scene_physics.duplicate(true))
        else:
            _scene_physics.clear()
            _scene_physics_present = false
            if has_meta(PHYSICS_META):
                remove_meta(PHYSICS_META)
        scene_physics_changed.emit(_scene_physics.duplicate(true))
    elif not preserve_missing:
        _scene_physics.clear()
        _scene_physics_present = false
        if has_meta(PHYSICS_META):
            remove_meta(PHYSICS_META)
        scene_physics_changed.emit({})


func _update_playback_clock() -> void:
    if _playback_clock == null:
        return
    _playback_clock.broadcast_interval = playback_clock_broadcast_interval
    if playback_follow_policy != _playback_clock.follow_policy:
        _playback_clock.set_follow_policy(playback_follow_policy)
    if allow_playback_control != _playback_clock.allow_control:
        _playback_clock.set_allow_control(allow_playback_control)
    if playback_clock_mode != _playback_clock.mode:
        var local_id := _client.id if _client != null else ""
        _playback_clock.set_mode(playback_clock_mode, local_id, nickname, _managed_objects.keys())
    var monotonic_time := float(Time.get_ticks_usec()) / 1000000.0
    var unix_time := Time.get_unix_time_from_system()
    _playback_clock.update(monotonic_time, unix_time, _managed_objects.keys())
    playback_clock_mode = _playback_clock.mode
    playback_follow_policy = _playback_clock.follow_policy
    allow_playback_control = _playback_clock.allow_control
    var state := _playback_clock.get_state()
    var effective_mode := int(state.get("effectiveMode", SceneSyncPlaybackClock.LOCAL))
    var transport_controlled := bool(state.get("localTransportControlled", false))
    var active_time := _playback_clock.get_playback_time(monotonic_time, unix_time)
    var effective_delta := 0.0
    if _has_effective_playback_sample:
        effective_delta = maxf(0.0, active_time - _last_effective_playback_time)
    _last_effective_playback_time = active_time
    _has_effective_playback_sample = true

    if (
        _last_playback_effective_mode != SceneSyncPlaybackClock.LOCAL
        and effective_mode == SceneSyncPlaybackClock.LOCAL
        and not transport_controlled
    ):
        _resume_remote_animation_policies()
    _last_playback_effective_mode = effective_mode

    if effective_mode == SceneSyncPlaybackClock.LOCAL and not transport_controlled:
        if _loom_runner != null and is_instance_valid(_loom_runner):
            _call_loom_runner("ClearTimeOverrides")
        return
    var loom_runner_available := _loom_runner != null and is_instance_valid(_loom_runner)
    if loom_runner_available:
        _call_loom_runner("SetSharedTimeOverride", [
            active_time,
            effective_delta,
            bool(state.get("paused", false)),
            String(state.get("effectiveModeName", "shared-playback-follow")),
            float(state.get("rate", 1.0)),
        ])
    for object_id_value in _managed_objects.keys():
        var object_id := _safe_string(object_id_value)
        var node := _get_managed_node(object_id)
        if node == null:
            continue
        var object_time := _playback_clock.get_object_time(object_id, monotonic_time, unix_time)
        if loom_runner_available:
            _call_loom_runner("SetObjectTimeOverride", [object_id, object_time])
        if not bool(node.get_meta(REMOTE_OBJECT_META, false)):
            continue
        var policy: Variant = get_animation_policy(object_id) if _has_animation_policy(object_id) else null
        SceneSyncAnimationPolicy.sample(node, policy, object_time)


func _update_rapier_bridge() -> void:
    if _rapier_bridge == null:
        return
    _rapier_bridge.auto_run = rapier_physics_enabled
    _rapier_bridge.max_steps_per_update = rapier_max_steps_per_update
    _rapier_bridge.hash_broadcast_interval_ticks = rapier_hash_broadcast_interval_ticks
    var clock_state := _playback_clock.get_state() if _playback_clock != null else {}
    var effective_mode := int(clock_state.get("effectiveMode", SceneSyncPlaybackClock.LOCAL))
    var playback_time := (
        _last_effective_playback_time
        if _has_effective_playback_sample else get_current_playback_time()
    )
    _rapier_bridge.advance_to_time(
        playback_time,
        effective_mode,
        true
    )


func _resume_remote_animation_policies() -> void:
    for object_id_value in _managed_objects.keys():
        var object_id := _safe_string(object_id_value)
        var node := _get_managed_node(object_id)
        if node != null and bool(node.get_meta(REMOTE_OBJECT_META, false)):
            _apply_animation_policy(object_id, node)


func _on_playback_clock_broadcast_requested(payload: Dictionary) -> void:
    if _connected and _client != null:
        _client.broadcast(payload.duplicate(true))


func _on_playback_clock_state_changed(state: Dictionary) -> void:
    playback_clock_mode = int(state.get("mode", SceneSyncPlaybackClock.LOCAL))
    playback_clock_state_changed.emit(state.duplicate(true))


func _on_rapier_availability_changed(available: bool) -> void:
    rapier_availability_changed.emit(available)


func _on_rapier_runtime_state_changed(state: Dictionary) -> void:
    physics_runtime_state_changed.emit(state.duplicate(true))


func _on_rapier_hash_report_requested(payload: Dictionary) -> void:
    if _connected and _client != null:
        _client.broadcast(payload.duplicate(true))


func _on_rapier_hash_checked(report: Dictionary) -> void:
    physics_hash_checked.emit(report.duplicate(true))


func _on_rapier_diagnostic(detail: Dictionary) -> void:
    physics_runtime_diagnostic.emit(detail.duplicate(true))


func _wrap_imported_mesh_for_visual_basis(imported: Node3D, visual_basis: String) -> Node3D:
    if imported == null:
        return null
    if visual_basis != "unity":
        return imported

    var wrapper := Node3D.new()
    imported.name = "ImportedGlbRoot"
    imported.rotation = Vector3(0.0, PI, 0.0)
    wrapper.add_child(imported)
    return wrapper


func _apply_payload_metadata(node: Node3D, object_id: String, payload: Dictionary, preserve_missing: bool = true) -> void:
    if node == null:
        return

    var name := _safe_string(payload.get("name", ""))
    if name != "":
        node.name = name

    if payload.has("visible") and payload["visible"] is bool:
        node.visible = payload["visible"]

    var mesh_path := _mesh_path_from_payload(payload)
    if mesh_path != "":
        _mesh_paths[object_id] = mesh_path

    var asset_id := _safe_string(payload.get("assetId", ""))
    var asset := _asset_from_payload(payload)
    if asset_id == "" and not asset.is_empty():
        asset_id = _safe_string(asset.get("assetId", ""))
    if asset_id != "":
        _asset_ids[object_id] = asset_id
        node.set_meta(ASSET_ID_META, asset_id)
    elif not preserve_missing:
        _asset_ids.erase(object_id)
        if node.has_meta(ASSET_ID_META):
            node.remove_meta(ASSET_ID_META)

    if not asset.is_empty():
        _apply_asset_visual_delta(node, asset)
        _merge_asset_metadata(node, object_id, asset)
    elif not preserve_missing:
        if node.has_meta(ASSET_META):
            node.remove_meta(ASSET_META)

    var metadata := _metadata_from_payload(payload)
    if not metadata.is_empty():
        _metadata[object_id] = metadata.duplicate(true)
        node.set_meta(METADATA_META, metadata.duplicate(true))
        _store_metadata_loom_graph(object_id, metadata)
    elif not preserve_missing:
        _metadata.erase(object_id)
        if node.has_meta(METADATA_META):
            node.remove_meta(METADATA_META)

    var animation_changed := false
    if payload.has("animation"):
        animation_changed = true
        var animation_value = payload.get("animation", null)
        if animation_value is Dictionary:
            var animation := (animation_value as Dictionary).duplicate(true)
            if preserve_missing and _has_animation_policy(object_id):
                animation = _merge_animation_policy(get_animation_policy(object_id), animation)
            _animation_policies[object_id] = animation
            node.set_meta(ANIMATION_META, animation.duplicate(true))
            animation_policy_changed.emit(object_id, node, animation.duplicate(true))
        else:
            _animation_policies.erase(object_id)
            if node.has_meta(ANIMATION_META):
                node.remove_meta(ANIMATION_META)
            animation_policy_changed.emit(object_id, node, {})
    elif not preserve_missing:
        animation_changed = true
        _animation_policies.erase(object_id)
        if node.has_meta(ANIMATION_META):
            node.remove_meta(ANIMATION_META)

    if animation_changed and _get_managed_node(object_id) == node:
        _apply_animation_policy(object_id, node)

    if payload.has("physics"):
        var physics_value = payload.get("physics", null)
        if physics_value is Dictionary:
            var physics := (physics_value as Dictionary).duplicate(true)
            _object_physics[object_id] = physics
            node.set_meta(PHYSICS_META, physics.duplicate(true))
            object_physics_changed.emit(object_id, node, physics.duplicate(true))
        else:
            _object_physics.erase(object_id)
            if node.has_meta(PHYSICS_META):
                node.remove_meta(PHYSICS_META)
            object_physics_changed.emit(object_id, node, {})
    elif not preserve_missing:
        _object_physics.erase(object_id)
        if node.has_meta(PHYSICS_META):
            node.remove_meta(PHYSICS_META)

    var origin := _safe_string(payload.get("origin", ""))
    if origin != "":
        _origins[object_id] = origin
        node.set_meta(ORIGIN_META, origin)

    var hierarchy_path := _safe_string(payload.get("unityHierarchyPath", ""))
    if hierarchy_path != "":
        _unity_hierarchy_paths[object_id] = hierarchy_path
        node.set_meta(UNITY_HIERARCHY_PATH_META, hierarchy_path)


func _apply_animation_policy(object_id: String, node: Node3D) -> Dictionary:
    if node == null or not is_instance_valid(node):
        return {"applied": false, "reason": "invalid-root"}
    var raw_policy: Variant = get_animation_policy(object_id) if _has_animation_policy(object_id) else null
    var result := {}
    if (
        _playback_clock != null
        and (
            _playback_clock.is_using_shared_time()
            or bool(_playback_clock.get_state().get("localTransportControlled", false))
        )
    ):
        var monotonic_time := float(Time.get_ticks_usec()) / 1000000.0
        var unix_time := Time.get_unix_time_from_system()
        result = SceneSyncAnimationPolicy.sample(
            node,
            raw_policy,
            _playback_clock.get_object_time(object_id, monotonic_time, unix_time)
        )
    else:
        result = SceneSyncAnimationPolicy.apply(node, raw_policy)
    animation_policy_applied.emit(object_id, node, result.duplicate(true))
    return result


func _merge_animation_policy(existing: Dictionary, incoming: Dictionary) -> Dictionary:
    var result := existing.duplicate(true)
    if incoming.has("clip") and not incoming.has("clipName"):
        result.erase("clipName")
    for key in incoming.keys():
        result[key] = incoming[key]
    return result


func _graph_object_scope(payload: Dictionary) -> String:
    var scope = payload.get("scope", "")
    if scope is Dictionary:
        return _safe_string((scope as Dictionary).get("object", ""))
    if _safe_string(scope) == "object":
        return _safe_string(payload.get("objectId", ""))
    return ""


func _store_metadata_loom_graph(object_id: String, metadata: Dictionary) -> void:
    var graph = metadata.get("loomGraph", {})
    if not (graph is Dictionary):
        graph = metadata.get("behaviorGraph", {})
    if not (graph is Dictionary):
        return

    var objects = _loom_graphs.get("objects", {})
    if not (objects is Dictionary):
        objects = {}
    objects[object_id] = (graph as Dictionary).duplicate(true)
    _loom_graphs["objects"] = objects
    _bind_loom_graph_for_object(object_id)


func _ensure_loom_runner() -> Node:
    if _loom_runner != null and is_instance_valid(_loom_runner):
        return _loom_runner

    if ClassDB.class_exists("SceneSyncLoomletRunner"):
        _loom_runner = ClassDB.instantiate("SceneSyncLoomletRunner") as Node
    else:
        var runner_script = load(LOOM_RUNNER_SCRIPT_PATH)
        if runner_script == null:
            push_warning("[SceneSync] Loomlet runner script is unavailable: %s" % LOOM_RUNNER_SCRIPT_PATH)
            return null
        if not (runner_script is Script):
            push_warning("[SceneSync] Loomlet runner resource is not a Script: %s" % LOOM_RUNNER_SCRIPT_PATH)
            return null
        if not (runner_script as Script).can_instantiate():
            push_warning("[SceneSync] Loomlet runner assembly is not available yet.")
            return null
        _loom_runner = _instantiate_loom_runner_script(runner_script)

    if _loom_runner == null:
        push_warning("[SceneSync] Failed to instantiate Loomlet runner.")
        return null

    _loom_runner.name = "SceneSyncLoomletRunner"
    add_child(_loom_runner)
    return _loom_runner


func _instantiate_loom_runner_script(runner_script: Variant) -> Node:
    if not (runner_script is Script):
        return null
    var script := runner_script as Script
    if not script.can_instantiate():
        return null
    return script.new() as Node


func _call_loom_runner(method_name: String, args: Array = []) -> void:
    var runner := _ensure_loom_runner()
    if runner == null:
        return
    if runner.has_method(method_name):
        runner.callv(method_name, args)
        return
    var snake_name := method_name.to_snake_case()
    if runner.has_method(snake_name):
        runner.callv(snake_name, args)


func _set_loom_scene_graph(graph: Dictionary) -> void:
    if graph.is_empty():
        return
    _call_loom_runner("SetSceneGraph", [JSON.stringify(graph)])


func _clear_loom_scene_graph() -> void:
    _call_loom_runner("ClearSceneGraph")


func _bind_loom_object_target(object_id: String, node: Node3D) -> void:
    if object_id == "" or node == null:
        return
    _call_loom_runner("BindObject", [object_id, node])
    _bind_loom_graph_for_object(object_id)


func _bind_loom_graph_for_object(object_id: String) -> void:
    if object_id == "":
        return
    var node := _get_managed_node(object_id)
    if node == null:
        return
    var objects = _loom_graphs.get("objects", {})
    if not (objects is Dictionary):
        return
    var object_graphs := objects as Dictionary
    if not object_graphs.has(object_id):
        return
    var graph = object_graphs[object_id]
    if graph is Dictionary:
        _call_loom_runner("SetObjectGraph", [object_id, node, JSON.stringify(graph)])


func _clear_loom_object_graph(object_id: String) -> void:
    _call_loom_runner("ClearObjectGraph", [object_id])


func _unbind_loom_object(object_id: String) -> void:
    _call_loom_runner("UnbindObject", [object_id])


func _clear_all_loom_graphs() -> void:
    _clear_loom_scene_graph()
    var objects = _loom_graphs.get("objects", {})
    if objects is Dictionary:
        for object_id in (objects as Dictionary).keys():
            _clear_loom_object_graph(_safe_string(object_id))


func _apply_loom_graph_state() -> void:
    var scene_graph = _loom_graphs.get("scene", {})
    if scene_graph is Dictionary:
        var typed_scene_graph := scene_graph as Dictionary
        _set_loom_scene_graph(typed_scene_graph)

    var objects = _loom_graphs.get("objects", {})
    if objects is Dictionary:
        for object_id in (objects as Dictionary).keys():
            _bind_loom_graph_for_object(_safe_string(object_id))


func _merge_asset_metadata(node: Node3D, _object_id: String, asset: Dictionary) -> void:
    var merged := {}
    if node.has_meta(ASSET_META):
        var existing = node.get_meta(ASSET_META)
        if existing is Dictionary:
            merged = (existing as Dictionary).duplicate(true)
    for key in asset.keys():
        merged[key] = asset[key]
    node.set_meta(ASSET_META, merged.duplicate(true))


func _apply_asset_visual_delta(node: Node3D, asset: Dictionary) -> void:
    if _safe_string(asset.get("type", "")) != "primitive":
        return

    var primitive := _safe_string(asset.get("primitive", ""))
    var color := _safe_string(asset.get("color", ""))
    var mesh_instance := _find_mesh_instance(node)
    if mesh_instance == null:
        return
    if primitive != "":
        var next_mesh := _mesh_for_primitive(primitive)
        if next_mesh != null:
            mesh_instance.mesh = next_mesh
    if color != "":
        _apply_color(mesh_instance, color)


func _find_mesh_instance(node: Node) -> MeshInstance3D:
    if node is MeshInstance3D:
        return node as MeshInstance3D
    for child in node.get_children():
        var found := _find_mesh_instance(child)
        if found != null:
            return found
    return null


func _mesh_for_primitive(primitive_type: String) -> Mesh:
    match primitive_type:
        "box":
            return BoxMesh.new()
        "sphere":
            return SphereMesh.new()
        "cylinder":
            return CylinderMesh.new()
        "cone":
            var cone := CylinderMesh.new()
            cone.top_radius = 0.0
            return cone
        "plane":
            return PlaneMesh.new()
        "torus":
            return TorusMesh.new()
        _:
            return null


func _apply_color(mesh_instance: MeshInstance3D, color: String) -> void:
    var mat: StandardMaterial3D
    if mesh_instance.material_override is StandardMaterial3D:
        mat = (mesh_instance.material_override as StandardMaterial3D).duplicate() as StandardMaterial3D
    else:
        mat = StandardMaterial3D.new()
    mat.albedo_color = Color.from_string(color, Color(0.53, 0.53, 0.53))
    mesh_instance.material_override = mat


func _get_asset_id(node: Node3D, object_id: String) -> String:
    if node != null and node.has_meta(ASSET_ID_META):
        return _safe_string(node.get_meta(ASSET_ID_META))
    return _safe_string(_asset_ids.get(object_id, ""))


func _get_asset(node: Node3D, object_id: String) -> Dictionary:
    if node != null and node.has_meta(ASSET_META):
        var value = node.get_meta(ASSET_META)
        if value is Dictionary:
            return (value as Dictionary).duplicate(true)
    return _asset_from_known_object(object_id)


func _asset_from_known_object(object_id: String) -> Dictionary:
    var node := _get_managed_node(object_id)
    if node != null and node.has_meta(ASSET_META):
        var value = node.get_meta(ASSET_META)
        if value is Dictionary:
            return (value as Dictionary).duplicate(true)
    return {}


func _get_metadata(node: Node3D, object_id: String) -> Dictionary:
    if node != null and node.has_meta(METADATA_META):
        var value = node.get_meta(METADATA_META)
        if value is Dictionary:
            return (value as Dictionary).duplicate(true)
    var stored = _metadata.get(object_id, {})
    if stored is Dictionary:
        return (stored as Dictionary).duplicate(true)
    return {}


func _get_origin(node: Node3D, object_id: String) -> String:
    if node != null and node.has_meta(ORIGIN_META):
        return _safe_string(node.get_meta(ORIGIN_META))
    return _safe_string(_origins.get(object_id, ""))


func _get_unity_hierarchy_path(node: Node3D, object_id: String) -> String:
    if node != null and node.has_meta(UNITY_HIERARCHY_PATH_META):
        return _safe_string(node.get_meta(UNITY_HIERARCHY_PATH_META))
    return _safe_string(_unity_hierarchy_paths.get(object_id, ""))


func _get_managed_node(object_id: String) -> Node3D:
    var node_value = _managed_objects.get(object_id)
    if node_value != null and is_instance_valid(node_value):
        return node_value as Node3D
    return null


func _resolve_existing_sync_target_for_payload(object_id: String, payload: Dictionary) -> Node3D:
    var hierarchy_path := _safe_string(payload.get("unityHierarchyPath", ""))
    var node_name := _safe_string(payload.get("name", ""))
    var name_matches: Array[Node3D] = []

    for node in _get_all_sync_targets():
        if not (node is Node3D) or not is_instance_valid(node):
            continue
        var node_object_id := _get_object_id(node)
        if object_id != "" and node_object_id == object_id:
            return node
        if bool(node.get_meta(REMOTE_OBJECT_META, false)):
            continue
        if hierarchy_path != "" and node.has_meta(UNITY_HIERARCHY_PATH_META):
            if _safe_string(node.get_meta(UNITY_HIERARCHY_PATH_META)) == hierarchy_path:
                return node
        if node_name != "" and node.name == node_name:
            name_matches.append(node)

    if name_matches.size() == 1:
        return name_matches[0]
    return null


func _primitive_type_for_mesh(mesh: Mesh) -> String:
    if mesh is BoxMesh:
        return "box"
    if mesh is SphereMesh:
        return "sphere"
    if mesh is CylinderMesh:
        return "cone" if (mesh as CylinderMesh).top_radius == 0.0 else "cylinder"
    if mesh is PlaneMesh:
        return "plane"
    if mesh is TorusMesh:
        return "torus"
    return ""


func _snapshot_for_node(node: Node3D) -> Dictionary:
    var transform := node.global_transform if node.is_inside_tree() else node.transform
    return {
        "position": transform.origin,
        "rotation": transform.basis.get_rotation_quaternion(),
        "scale": transform.basis.get_scale(),
    }


func _apply_transform_to_node(node: Node3D, transform_data: Dictionary) -> void:
    var current := node.global_transform if node.is_inside_tree() else node.transform
    var pos: Vector3 = transform_data.get("position", current.origin)
    var rot: Quaternion = transform_data.get("rotation", current.basis.get_rotation_quaternion())
    var scl: Vector3 = transform_data.get("scale", current.basis.get_scale())
    current.origin = pos
    # SceneSync wire transforms use local TRS order (R * S). Basis.scaled()
    # applies a global scale (S * R), which shears rotated non-uniform scales.
    current.basis = Basis(rot).scaled_local(scl)
    if node.is_inside_tree():
        node.global_transform = current
    else:
        node.transform = current


func _snapshots_equal(a: Dictionary, b: Dictionary) -> bool:
    if a.is_empty() or b.is_empty():
        return false
    return a["position"].is_equal_approx(b["position"]) \
        and a["rotation"].is_equal_approx(b["rotation"]) \
        and a["scale"].is_equal_approx(b["scale"])


func _get_all_sync_targets() -> Array:
    var root := _get_or_create_sync_root()
    var nodes: Array = []
    if root == null:
        return nodes

    for child in root.get_children():
        if child is Node3D and child != self:
            nodes.append(child)
    return nodes


func _get_sync_root() -> Node3D:
    if sync_root != null and is_instance_valid(sync_root):
        return sync_root
    var host_root := _get_host_scene_root()
    if host_root is Node3D:
        return host_root
    if host_root != null:
        var existing := host_root.get_node_or_null(RECEIVE_ROOT_NAME)
        if existing is Node3D:
            return existing
    return null


func _get_or_create_sync_root() -> Node3D:
    var root := _get_sync_root()
    if root != null:
        return root

    var host_root := _get_host_scene_root()
    if host_root == null:
        return null

    var receive_root := Node3D.new()
    receive_root.name = RECEIVE_ROOT_NAME
    host_root.add_child(receive_root)

    if Engine.is_editor_hint():
        receive_root.owner = get_tree().edited_scene_root
    elif get_tree().current_scene != null:
        receive_root.owner = get_tree().current_scene

    return receive_root


func _is_sync_target(node: Node3D) -> bool:
    return node != null and node != self and _is_node_within_sync_root(node)


func _is_node_within_sync_root(node: Node3D) -> bool:
    var root: Node3D = _get_sync_root()
    return root != null and node.get_parent() == root


func _node_has_mesh(node: Node3D) -> bool:
    if node is MeshInstance3D and (node as MeshInstance3D).mesh != null:
        return true
    for child in node.get_children():
        if child is Node3D and _node_has_mesh(child):
            return true
    return false


func _get_object_id(node: Node) -> String:
    if node != null and node.has_meta(OBJECT_ID_META):
        return _safe_string(node.get_meta(OBJECT_ID_META))
    return ""


func _get_or_assign_object_id(node: Node3D) -> String:
    var object_id := _get_object_id(node)
    if object_id != "":
        return object_id
    object_id = str(node.get_instance_id())
    node.set_meta(OBJECT_ID_META, object_id)
    _managed_objects[object_id] = node
    _known_ids[object_id] = true
    return object_id


func _get_blob_base_url() -> String:
    if blob_url != "":
        return blob_url

    var url := presence_url.replace("wss://", "https://").replace("ws://", "http://")
    url = url.trim_suffix("/")
    return "%s/blob" % url


func _can_operate_in_editor() -> bool:
    return get_tree() != null and get_tree().edited_scene_root != null


func _get_host_scene_root() -> Node:
    if get_tree() == null:
        return null
    if Engine.is_editor_hint():
        return get_tree().edited_scene_root
    return get_tree().current_scene


func _assign_editor_owner_recursive(node: Node) -> void:
    if not Engine.is_editor_hint():
        return
    var edited_root := get_tree().edited_scene_root
    if edited_root == null:
        return
    node.owner = edited_root
    for child in node.get_children():
        _assign_editor_owner_recursive(child)
