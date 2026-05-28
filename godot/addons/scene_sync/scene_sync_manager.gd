@tool
class_name SceneSyncManager
extends Node

signal connected(id: String, room: String)
signal disconnected()
signal peers_updated(peers: Array)
signal object_added(object_id: String, node: Node3D)
signal object_removed(object_id: String)

@export var presence_url: String = "wss://afjk.jp/presence"
@export var blob_url: String = ""
@export var room: String = ""
@export var nickname: String = "Godot"
@export var auto_connect: bool = true
@export var sync_root: Node3D = null
@export var hierarchy_poll_interval: float = 0.5

var _client: SceneSyncPresenceClient
var _blob_client: SceneSyncBlobClient
var _managed_objects: Dictionary = {}
var _known_ids: Dictionary = {}
var _mesh_paths: Dictionary = {}
var _asset_ids: Dictionary = {}
var _metadata: Dictionary = {}
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

const SEND_INTERVAL: float = 0.05
const RECOVERY_TIMEOUT_SECONDS: float = 30.0
const PEER_RETRY_INTERVAL_SECONDS: float = 4.0
const RECOVERY_RESPONDER_COOLDOWN_SECONDS: float = 30.0
const MAX_GLB_SIZE: int = 50 * 1024 * 1024
const OBJECT_ID_META := "scene_sync_object_id"
const ASSET_META := "scene_sync_asset"
const METADATA_META := "scene_sync_metadata"
const ASSET_ID_META := "scene_sync_asset_id"
const ORIGIN_META := "scene_sync_origin"
const UNITY_HIERARCHY_PATH_META := "scene_sync_unity_hierarchy_path"
const RECEIVE_ROOT_NAME := "SceneSyncRoot"
const LOOM_RUNNER_SCRIPT_PATH := "res://addons/scene_sync/SceneSyncLoomletRunner.cs"


func _ready() -> void:
    _client = SceneSyncPresenceClient.new()
    _blob_client = SceneSyncBlobClient.new()
    _blob_client.name = "SceneSyncBlobClient"
    add_child(_blob_client)
    _ensure_loom_runner()

    _client.connected.connect(_on_connected)
    _client.disconnected.connect(_on_disconnected)
    _client.peers_updated.connect(_on_peers_updated)
    _client.handoff_received.connect(_on_handoff_received)

    set_process(true)
    if auto_connect and (not Engine.is_editor_hint() or _can_operate_in_editor()):
        connect_to_server()


func _exit_tree() -> void:
    if _client != null:
        _client.disconnect_from_server(false)


func _process(delta: float) -> void:
    if _client != null:
        _client.poll(delta)

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


func select_object(node: Node3D) -> void:
    if node == null:
        deselect_object()
        return
    if not _is_sync_target(node):
        return

    var object_id := _get_or_assign_object_id(node)
    var lock_owner := String(_locks.get(object_id, ""))
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


func get_publish_root_status() -> Dictionary:
    if sync_root != null and is_instance_valid(sync_root):
        var root_path := sync_root.name
        return {
            "ok": true,
            "root": sync_root,
            "path": root_path,
            "message": root_path,
        }
    return {
        "ok": false,
        "root": null,
        "path": "",
        "message": "No sync root selected",
        "reason": "No sync root selected",
    }


func create_scene_sync_root(host_root: Node = null) -> Dictionary:
    if host_root == null:
        host_root = _get_host_scene_root()
    if host_root == null:
        return _publish_result(0, [{
            "name": RECEIVE_ROOT_NAME,
            "reason": "no edited scene root",
        }])

    var existing := host_root.get_node_or_null(RECEIVE_ROOT_NAME)
    if existing != null:
        if existing is Node3D:
            sync_root = existing
            _assign_owner_for_publish_root(existing, host_root)
            return {
                "ok": true,
                "root": existing,
                "created": false,
                "message": "Using existing SceneSyncRoot",
            }
        return _publish_result(0, [{
            "name": RECEIVE_ROOT_NAME,
            "reason": "existing SceneSyncRoot is not Node3D",
        }])

    var next_root := Node3D.new()
    next_root.name = RECEIVE_ROOT_NAME
    host_root.add_child(next_root)
    _assign_owner_for_publish_root(next_root, host_root)
    sync_root = next_root
    return {
        "ok": true,
        "root": next_root,
        "created": true,
        "message": "Created SceneSyncRoot",
    }


func use_publish_root(node: Node) -> Dictionary:
    if node == null:
        return _publish_result(0, [{"name": "", "reason": "No node selected"}])
    if not (node is Node3D):
        return _publish_result(0, [{"name": node.name, "reason": "selected node is not Node3D"}])
    sync_root = node
    return {
        "ok": true,
        "root": node,
        "message": "Using %s as publish root" % node.name,
    }


func get_publish_candidate_status(node: Node) -> Dictionary:
    if node == null:
        return _publish_candidate(false, "", "No node selected")
    if not (node is Node3D):
        return _publish_candidate(false, node.name, "selected node is not Node3D")
    var root_status := get_publish_root_status()
    if not bool(root_status.get("ok", false)):
        return _publish_candidate(false, node.name, "No sync root selected. Click Create SceneSyncRoot first.")
    var root = root_status.get("root")
    if root != null and node.get_parent() != root:
        return _publish_candidate(false, node.name, "selected node is not a direct child of Target Root. Move it under %s or use it as root." % root.name)
    if not _node_has_mesh(node as Node3D):
        return _publish_candidate(false, node.name, "no mesh found in this node or children. Add a MeshInstance3D under this node.")
    return _publish_candidate(true, node.name, "")


func get_publish_children_status() -> Dictionary:
    var root_status := get_publish_root_status()
    if not bool(root_status.get("ok", false)):
        return _publish_result(0, [{
            "name": RECEIVE_ROOT_NAME,
            "reason": "No sync root selected",
        }])

    var publishable := 0
    var skipped: Array = []
    var root := root_status.get("root") as Node3D
    for child in root.get_children():
        var candidate := get_publish_candidate_status(child)
        if bool(candidate.get("publishable", false)):
            publishable += 1
        else:
            skipped.append(candidate)

    if root.get_child_count() == 0:
        skipped.append({
            "name": root.name,
            "reason": "sync root has no children",
        })
    return _publish_result(publishable, skipped)


func publish_node(node: Node) -> Dictionary:
    var candidate := get_publish_candidate_status(node)
    if not bool(candidate.get("publishable", false)):
        return _publish_result(0, [candidate])
    if not _connected:
        return _publish_result(0, [{
            "name": String(candidate.get("name", "")),
            "reason": "not connected",
        }])

    var node_3d := node as Node3D
    var object_id := _get_or_assign_object_id(node_3d)
    await _send_scene_add(node_3d, object_id)
    _managed_objects[object_id] = node_3d
    _known_ids[object_id] = true
    return _publish_result(1, [])


func publish_children_of_root() -> Dictionary:
    var root_status := get_publish_root_status()
    if not bool(root_status.get("ok", false)):
        return _publish_result(0, [{
            "name": RECEIVE_ROOT_NAME,
            "reason": "No sync root selected",
        }])

    var published := 0
    var skipped: Array = []
    var root := root_status.get("root") as Node3D
    for child in root.get_children():
        var candidate := get_publish_candidate_status(child)
        if not bool(candidate.get("publishable", false)):
            skipped.append(candidate)
            continue
        if not _connected:
            skipped.append({
                "name": child.name,
                "reason": "not connected",
            })
            continue
        var child_3d := child as Node3D
        var object_id := _get_or_assign_object_id(child_3d)
        await _send_scene_add(child_3d, object_id)
        _managed_objects[object_id] = child_3d
        _known_ids[object_id] = true
        published += 1

    if root.get_child_count() == 0:
        skipped.append({
            "name": root.name,
            "reason": "sync root has no children",
        })
    return _publish_result(published, skipped)


func _on_connected(new_id: String, new_room: String) -> void:
    _connected = true
    room = new_room
    connected.emit(new_id, new_room)


func _on_disconnected() -> void:
    _connected = false
    _scene_received = false
    _first_peers_received = false
    _locks.clear()
    _clear_all_loom_graphs()
    _loom_graphs.clear()
    _mesh_data_by_asset_id.clear()
    _mesh_data_by_path.clear()
    _pending_recoveries.clear()
    _responder_cooldowns.clear()
    _active_outgoing_transfer_id = ""
    _env_id = ""
    _currently_locked_id = ""
    disconnected.emit()


func _on_peers_updated(peers: Array) -> void:
    var live_peer_ids := {}
    for peer in peers:
        if peer is Dictionary:
            live_peer_ids[String(peer.get("id", ""))] = true

    for object_id in _locks.keys():
        var owner_id := String(_locks[object_id])
        if owner_id != "" and owner_id != _client.id and not live_peer_ids.has(owner_id):
            _locks.erase(object_id)

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
        var peer_id := String(peer.get("id", ""))
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
    var from_id := String(from_info.get("id", ""))
    var kind := String(payload.get("kind", ""))
    if kind == "":
        kind = String(payload.get("type", ""))

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
    var env_id := String(payload.get("envId", ""))
    if env_id != "":
        _env_id = env_id


func _handle_scene_delta(payload: Dictionary) -> void:
    var object_id := String(payload.get("objectId", ""))
    var node_value = _managed_objects.get(object_id)
    if node_value == null or not is_instance_valid(node_value):
        return
    var node := node_value as Node3D
    if node == null:
        return
    _apply_payload_metadata(node, object_id, payload, true)
    if _selected_object != null and is_instance_valid(_selected_object):
        if _get_object_id(_selected_object) == object_id:
            return

    var transform_data := SceneSyncProtocol.extract_transform(payload)
    _apply_transform_to_node(node, transform_data)
    _last_snapshots[object_id] = _snapshot_for_node(node)


func _handle_scene_request(from_id: String) -> void:
    if from_id == "":
        return

    var objects := {}
    for node in _get_all_sync_targets():
        var object_id := _get_or_assign_object_id(node)
        var entry := await _build_object_payload(node, object_id)
        objects[object_id] = entry
    _client.send_handoff(from_id, SceneSyncProtocol.make_scene_state(objects, _loom_graphs, _env_id))


func _handle_scene_state(payload: Dictionary) -> void:
    _scene_received = true
    _handle_scene_env(payload)
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
    var object_id := String(payload.get("objectId", ""))
    if object_id == "":
        return
    if _managed_objects.has(object_id) and is_instance_valid(_managed_objects[object_id]):
        var existing := _managed_objects[object_id] as Node3D
        if existing != null:
            _apply_payload_metadata(existing, object_id, payload, true)
            _apply_transform_to_node(existing, SceneSyncProtocol.extract_transform(payload))
        return

    var asset := _asset_from_payload(payload)
    var metadata := _metadata_from_payload(payload)
    var mesh_path := _mesh_path_from_payload(payload)
    var node := _resolve_existing_sync_target_for_payload(object_id, payload)
    if node != null:
        _bind_existing_managed_object(object_id, node)
        _apply_payload_metadata(node, object_id, payload, true)
        _apply_transform_to_node(node, SceneSyncProtocol.extract_transform(payload))
        if mesh_path != "":
            _mesh_paths[object_id] = mesh_path
        object_added.emit(object_id, node)
        return

    if String(asset.get("type", "")) == "primitive":
        node = _create_primitive(String(asset.get("primitive", "box")), String(asset.get("color", "#888888")))
    elif String(asset.get("type", "")) == "mesh":
        mesh_path = String(asset.get("meshPath", mesh_path))

    if node == null and mesh_path != "":
        node = _create_loading_placeholder(String(payload.get("name", object_id)))
        _register_managed_object(object_id, node)
        _apply_payload_metadata(node, object_id, payload, true)
        _apply_transform_to_node(node, SceneSyncProtocol.extract_transform(payload))
        _mesh_paths[object_id] = mesh_path
        _load_mesh_for_object(object_id, payload, mesh_path)
        return

    if node == null:
        node = _create_primitive("box")

    _register_managed_object(object_id, node)
    _apply_payload_metadata(node, object_id, payload, true)
    _apply_transform_to_node(node, SceneSyncProtocol.extract_transform(payload))

    if not asset.is_empty():
        node.set_meta(ASSET_META, asset.duplicate(true))
    if not metadata.is_empty():
        node.set_meta(METADATA_META, metadata.duplicate(true))
    if mesh_path != "":
        _mesh_paths[object_id] = mesh_path
    object_added.emit(object_id, node)


func _handle_scene_remove(payload: Dictionary) -> void:
    var object_id := String(payload.get("objectId", ""))
    var node_value = _managed_objects.get(object_id)
    if node_value != null and is_instance_valid(node_value):
        var node := node_value as Node3D
        if node != null:
            if node == _selected_object:
                _selected_object = null
                _currently_locked_id = ""
            node.queue_free()
    _managed_objects.erase(object_id)
    _known_ids.erase(object_id)
    _unbind_loom_object(object_id)
    _mesh_paths.erase(object_id)
    _asset_ids.erase(object_id)
    _metadata.erase(object_id)
    _origins.erase(object_id)
    _unity_hierarchy_paths.erase(object_id)
    _locks.erase(object_id)
    _last_snapshots.erase(object_id)
    object_removed.emit(object_id)


func _handle_scene_mesh(payload: Dictionary) -> void:
    var object_id := String(payload.get("objectId", ""))
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
            _register_managed_object(object_id, node)
    _apply_payload_metadata(node, object_id, payload, true)
    _mesh_paths[object_id] = mesh_path
    _load_mesh_for_object(object_id, {
        "objectId": object_id,
        "name": String(payload.get("name", object_id)),
        "position": SceneSyncProtocol.pos_to_wire(transform_data.get("position", Vector3.ZERO)),
        "rotation": SceneSyncProtocol.rot_to_wire(transform_data.get("rotation", Quaternion.IDENTITY)),
        "scale": SceneSyncProtocol.scale_to_wire(transform_data.get("scale", Vector3.ONE)),
        "asset": _asset_from_payload(payload),
        "metadata": _metadata_from_payload(payload),
        "assetId": String(payload.get("assetId", "")),
        "origin": String(payload.get("origin", "")),
        "unityHierarchyPath": String(payload.get("unityHierarchyPath", "")),
    }, mesh_path)


func _handle_scene_lock(payload: Dictionary, from_info: Dictionary) -> void:
    var object_id := String(payload.get("objectId", ""))
    var from_id := String(from_info.get("id", ""))
    if object_id == "" or from_id == "":
        return
    _locks[object_id] = from_id
    if _selected_object != null and _get_object_id(_selected_object) == object_id and from_id != _client.id:
        deselect_object()


func _handle_scene_unlock(payload: Dictionary) -> void:
    var object_id := String(payload.get("objectId", ""))
    if object_id != "":
        _locks.erase(object_id)


func _send_transform_delta() -> void:
    if _selected_object == null or not is_instance_valid(_selected_object):
        return
    var object_id := _get_or_assign_object_id(_selected_object)
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
        _client.broadcast(SceneSyncProtocol.make_scene_remove(String(object_id)))
        _managed_objects.erase(object_id)
        _unbind_loom_object(String(object_id))
        _mesh_paths.erase(object_id)
        _asset_ids.erase(object_id)
        _metadata.erase(object_id)
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
    var mesh_path := String(_mesh_paths.get(object_id, ""))
    var asset_id := _get_asset_id(node, object_id)
    var metadata := _get_metadata(node, object_id)
    var origin := _get_origin(node, object_id)
    var unity_hierarchy_path := _get_unity_hierarchy_path(node, object_id)

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
        elif String(asset.get("type", "")) == "mesh" and not asset.has("meshPath"):
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
        node.visible
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
    elif String(asset.get("type", "")) == "mesh" and not asset.has("meshPath"):
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
        _get_unity_hierarchy_path(node, object_id)
    ))


func _load_mesh_for_object(object_id: String, payload: Dictionary, mesh_path: String) -> void:
    var asset_id := _asset_id_from_payload(payload)
    var data := _get_cached_mesh_data(mesh_path, asset_id)
    if data.is_empty():
        data = await _blob_client.download_glb(mesh_path)
        if not data.is_empty():
            _cache_mesh_data(mesh_path, asset_id, data)
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
    var mesh_path := String(_mesh_paths.get(object_id, ""))
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
    if mesh_path != "":
        payload["meshPath"] = mesh_path
    if asset_id != "":
        payload["assetId"] = asset_id

    _replace_object_with_mesh_data(object_id, payload, data)


func _replace_object_with_mesh_data(object_id: String, payload: Dictionary, data: PackedByteArray) -> void:
    var old_node := _get_managed_node(object_id)
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

    replacement.name = String(payload.get("name", object_id))
    replacement.set_meta(OBJECT_ID_META, object_id)
    _apply_payload_metadata(replacement, object_id, payload, true)
    _apply_transform_to_node(replacement, SceneSyncProtocol.extract_transform(payload))

    if old_node != null and is_instance_valid(old_node):
        if old_node == _selected_object:
            _selected_object = replacement
        old_node.queue_free()

    _managed_objects[object_id] = replacement
    _known_ids[object_id] = true
    _bind_loom_object_target(object_id, replacement)
    object_added.emit(object_id, replacement)


func _register_managed_object(object_id: String, node: Node3D) -> void:
    var parent: Node3D = _get_or_create_sync_root()
    if parent == null:
        return
    if node.get_parent() != parent:
        parent.add_child(node)
    if Engine.is_editor_hint():
        _assign_editor_owner_recursive(node)
    node.name = String(node.name if node.name != "" else object_id)
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
        var mesh_path := String(payload.get("meshPath", ""))
        if mesh_path != "" and not result.has("meshPath"):
            result["meshPath"] = mesh_path
        var asset_id := String(payload.get("assetId", ""))
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
    var mesh_path := String(payload.get("meshPath", ""))
    if mesh_path != "":
        return mesh_path
    var asset := _asset_from_payload(payload)
    if asset.is_empty():
        return ""
    return String(asset.get("meshPath", ""))


func _asset_id_from_payload(payload: Dictionary) -> String:
    var asset_id := String(payload.get("assetId", ""))
    if asset_id != "":
        return asset_id
    var asset := _asset_from_payload(payload)
    if asset.is_empty():
        return ""
    return String(asset.get("assetId", ""))


func _visual_basis_from_payload(payload: Dictionary) -> String:
    var asset := _asset_from_payload(payload)
    if asset.is_empty():
        return ""
    return String(asset.get("visualBasis", ""))


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
    var request_id := String(payload.get("requestId", ""))
    var object_id := String(payload.get("objectId", ""))
    if request_id == "" or object_id == "":
        return
    if _get_managed_node(object_id) == null:
        return

    var asset_id := _nullable_string(payload.get("assetId", ""))
    var mesh_path := _nullable_string(payload.get("meshPath", ""))
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
        var peer_id := String((peer as Dictionary).get("id", ""))
        if peer_id == "" or peer_id == _client.id:
            continue

        var recovery: Dictionary = _pending_recoveries[request_id]
        var requested_peer_ids: Dictionary = recovery.get("requestedPeerIds", {})
        requested_peer_ids[peer_id] = true
        recovery["requestedPeerIds"] = requested_peer_ids
        _pending_recoveries[request_id] = recovery

        _client.send_handoff(peer_id, SceneSyncProtocol.make_scene_asset_request(
            request_id,
            String(recovery.get("objectId", "")),
            String(recovery.get("assetId", "")),
            String(recovery.get("meshPath", "")),
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
    var path := String(payload.get("path", ""))
    var filename := String(payload.get("filename", ""))
    var size := int(payload.get("size", 0))
    var mime := String(payload.get("mime", ""))
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
        matched_request_id = String(request_id)
        matched_recovery = recovery
        break

    if matched_request_id == "":
        return

    var expected_asset_id := String(matched_recovery.get("assetId", ""))
    var computed_asset_id := ""
    if expected_asset_id != "":
        computed_asset_id = SceneSyncBlobClient.compute_asset_id(data)
        if computed_asset_id == "" or computed_asset_id != expected_asset_id:
            return

    _pending_recoveries.erase(matched_request_id)
    var mesh_path := String(matched_recovery.get("meshPath", ""))
    _cache_mesh_data(mesh_path, computed_asset_id if computed_asset_id != "" else expected_asset_id, data)
    _load_mesh_bytes_for_object(
        String(matched_recovery.get("objectId", "")),
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
        if peer is Dictionary and String((peer as Dictionary).get("id", "")) != _client.id:
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


func _nullable_string(value: Variant) -> String:
    if value == null:
        return ""
    return String(value)


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

    var name := String(payload.get("name", ""))
    if name != "":
        node.name = name

    if payload.has("visible"):
        node.visible = bool(payload["visible"])

    var mesh_path := _mesh_path_from_payload(payload)
    if mesh_path != "":
        _mesh_paths[object_id] = mesh_path

    var asset_id := String(payload.get("assetId", ""))
    var asset := _asset_from_payload(payload)
    if asset_id == "" and not asset.is_empty():
        asset_id = String(asset.get("assetId", ""))
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

    var origin := String(payload.get("origin", ""))
    if origin != "":
        _origins[object_id] = origin
        node.set_meta(ORIGIN_META, origin)

    var hierarchy_path := String(payload.get("unityHierarchyPath", ""))
    if hierarchy_path != "":
        _unity_hierarchy_paths[object_id] = hierarchy_path
        node.set_meta(UNITY_HIERARCHY_PATH_META, hierarchy_path)


func _graph_object_scope(payload: Dictionary) -> String:
    var scope = payload.get("scope", "")
    if scope is Dictionary:
        return String((scope as Dictionary).get("object", ""))
    if String(scope) == "object":
        return String(payload.get("objectId", ""))
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
        _loom_runner = runner_script.new()

    if _loom_runner == null:
        push_warning("[SceneSync] Failed to instantiate Loomlet runner.")
        return null

    _loom_runner.name = "SceneSyncLoomletRunner"
    add_child(_loom_runner)
    return _loom_runner


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
            _clear_loom_object_graph(String(object_id))


func _apply_loom_graph_state() -> void:
    var scene_graph = _loom_graphs.get("scene", {})
    if scene_graph is Dictionary:
        var typed_scene_graph := scene_graph as Dictionary
        _set_loom_scene_graph(typed_scene_graph)

    var objects = _loom_graphs.get("objects", {})
    if objects is Dictionary:
        for object_id in (objects as Dictionary).keys():
            _bind_loom_graph_for_object(String(object_id))


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
    if String(asset.get("type", "")) != "primitive":
        return

    var primitive := String(asset.get("primitive", ""))
    var color := String(asset.get("color", ""))
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
        return String(node.get_meta(ASSET_ID_META))
    return String(_asset_ids.get(object_id, ""))


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
        return String(node.get_meta(ORIGIN_META))
    return String(_origins.get(object_id, ""))


func _get_unity_hierarchy_path(node: Node3D, object_id: String) -> String:
    if node != null and node.has_meta(UNITY_HIERARCHY_PATH_META):
        return String(node.get_meta(UNITY_HIERARCHY_PATH_META))
    return String(_unity_hierarchy_paths.get(object_id, ""))


func _get_managed_node(object_id: String) -> Node3D:
    var node_value = _managed_objects.get(object_id)
    if node_value != null and is_instance_valid(node_value):
        return node_value as Node3D
    return null


func _resolve_existing_sync_target_for_payload(object_id: String, payload: Dictionary) -> Node3D:
    var hierarchy_path := String(payload.get("unityHierarchyPath", ""))
    var node_name := String(payload.get("name", ""))
    var name_matches: Array[Node3D] = []

    for node in _get_all_sync_targets():
        if not (node is Node3D) or not is_instance_valid(node):
            continue
        var node_object_id := _get_object_id(node)
        if object_id != "" and node_object_id == object_id:
            return node
        if hierarchy_path != "" and node.has_meta(UNITY_HIERARCHY_PATH_META):
            if String(node.get_meta(UNITY_HIERARCHY_PATH_META)) == hierarchy_path:
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
    current.basis = Basis(rot).scaled(scl)
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


func _publish_candidate(publishable: bool, node_name: String, reason: String) -> Dictionary:
    return {
        "publishable": publishable,
        "name": node_name,
        "reason": reason,
    }


func _publish_result(published: int, skipped: Array) -> Dictionary:
    return {
        "published": published,
        "skipped": skipped.size(),
        "reasons": skipped,
        "ok": published > 0 and skipped.is_empty(),
    }


func _assign_owner_for_publish_root(node: Node, host_root: Node) -> void:
    if node == null:
        return
    if Engine.is_editor_hint():
        var edited_root := get_tree().edited_scene_root if get_tree() != null else null
        node.owner = edited_root
        return
    if host_root != null:
        node.owner = host_root.owner


func _get_object_id(node: Node) -> String:
    if node != null and node.has_meta(OBJECT_ID_META):
        return String(node.get_meta(OBJECT_ID_META))
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
