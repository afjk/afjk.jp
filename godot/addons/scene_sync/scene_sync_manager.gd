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
const OBJECT_ID_META := "scene_sync_object_id"
const RECEIVE_ROOT_NAME := "SceneSyncRoot"


func _ready() -> void:
    _client = SceneSyncPresenceClient.new()
    _blob_client = SceneSyncBlobClient.new()
    _blob_client.name = "SceneSyncBlobClient"
    add_child(_blob_client)

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


func _on_connected(new_id: String, new_room: String) -> void:
    _connected = true
    room = new_room
    connected.emit(new_id, new_room)


func _on_disconnected() -> void:
    _connected = false
    _scene_received = false
    _first_peers_received = false
    _locks.clear()
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
    var from_id := String(from_info.get("id", ""))
    var kind := String(payload.get("kind", ""))

    match kind:
        "scene-request":
            _handle_scene_request(from_id)
        "scene-state":
            _handle_scene_state(payload)
        "scene-delta":
            if from_id != _client.id:
                _handle_scene_delta(payload)
        "scene-add":
            if from_id != _client.id:
                _handle_scene_add(payload)
        "scene-remove":
            _handle_scene_remove(payload)
        "scene-mesh":
            if from_id != _client.id:
                _handle_scene_mesh(payload)
        "scene-lock":
            if from_id != _client.id:
                _handle_scene_lock(payload, from_info)
        "scene-unlock":
            _handle_scene_unlock(payload)


func _handle_scene_delta(payload: Dictionary) -> void:
    var object_id := String(payload.get("objectId", ""))
    var node: Node3D = _managed_objects.get(object_id)
    if node == null or not is_instance_valid(node):
        return
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
    _client.send_handoff(from_id, SceneSyncProtocol.make_scene_state(objects))


func _handle_scene_state(payload: Dictionary) -> void:
    _scene_received = true
    var objects = payload.get("objects", {})
    if not (objects is Dictionary):
        return

    for object_id in objects.keys():
        var info = objects[object_id]
        if info is Dictionary:
            _handle_scene_add((info as Dictionary).merged({"objectId": object_id}, true))


func _handle_scene_add(payload: Dictionary) -> void:
    var object_id := String(payload.get("objectId", ""))
    if object_id == "":
        return
    if _managed_objects.has(object_id) and is_instance_valid(_managed_objects[object_id]):
        _apply_transform_to_node(_managed_objects[object_id], SceneSyncProtocol.extract_transform(payload))
        return

    var asset = payload.get("asset", {})
    var mesh_path := String(payload.get("meshPath", ""))
    var node: Node3D = null

    if asset is Dictionary and String(asset.get("type", "")) == "primitive":
        node = _create_primitive(String(asset.get("primitive", "box")), String(asset.get("color", "#888888")))
    elif asset is Dictionary and String(asset.get("type", "")) == "mesh":
        mesh_path = String(asset.get("meshPath", mesh_path))

    if node == null and mesh_path != "":
        node = _create_loading_placeholder(String(payload.get("name", object_id)))
        _register_managed_object(object_id, node)
        _apply_transform_to_node(node, SceneSyncProtocol.extract_transform(payload))
        _mesh_paths[object_id] = mesh_path
        _load_mesh_for_object(object_id, payload, mesh_path)
        return

    if node == null:
        node = _create_primitive("box")

    _register_managed_object(object_id, node)
    _apply_transform_to_node(node, SceneSyncProtocol.extract_transform(payload))

    if asset is Dictionary and not asset.is_empty():
        node.set_meta("scene_sync_asset", asset.duplicate(true))
    if mesh_path != "":
        _mesh_paths[object_id] = mesh_path
    object_added.emit(object_id, node)


func _handle_scene_remove(payload: Dictionary) -> void:
    var object_id := String(payload.get("objectId", ""))
    var node: Node3D = _managed_objects.get(object_id)
    if node != null and is_instance_valid(node):
        if node == _selected_object:
            _selected_object = null
            _currently_locked_id = ""
        node.queue_free()
    _managed_objects.erase(object_id)
    _known_ids.erase(object_id)
    _mesh_paths.erase(object_id)
    _locks.erase(object_id)
    _last_snapshots.erase(object_id)
    object_removed.emit(object_id)


func _handle_scene_mesh(payload: Dictionary) -> void:
    var object_id := String(payload.get("objectId", ""))
    var mesh_path := String(payload.get("meshPath", ""))
    if object_id == "" or mesh_path == "":
        return

    var node: Node3D = _managed_objects.get(object_id)
    var transform_data := {}
    if node != null and is_instance_valid(node):
        transform_data = _snapshot_for_node(node)
    else:
        node = _create_loading_placeholder(object_id)
        _register_managed_object(object_id, node)
    _mesh_paths[object_id] = mesh_path
    _load_mesh_for_object(object_id, {
        "objectId": object_id,
        "name": String(payload.get("name", object_id)),
        "position": SceneSyncProtocol.pos_to_wire(transform_data.get("position", Vector3.ZERO)),
        "rotation": SceneSyncProtocol.rot_to_wire(transform_data.get("rotation", Quaternion.IDENTITY)),
        "scale": SceneSyncProtocol.scale_to_wire(transform_data.get("scale", Vector3.ONE)),
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
        var node: Node3D = _managed_objects.get(object_id)
        if node != null and is_instance_valid(node) and _is_node_within_sync_root(node):
            continue
        _client.broadcast(SceneSyncProtocol.make_scene_remove(String(object_id)))
        _managed_objects.erase(object_id)
        _mesh_paths.erase(object_id)
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

    if mesh_path == "" and asset.is_empty() and _node_has_mesh(node):
        var glb := SceneSyncGltfHelper.export_glb(node)
        if not glb.is_empty():
            mesh_path = SceneSyncBlobClient.generate_random_path()
            var upload_err := await _blob_client.upload_glb(glb, mesh_path)
            if upload_err == OK:
                _mesh_paths[object_id] = mesh_path
            else:
                mesh_path = ""

    var payload := SceneSyncProtocol.make_scene_add(
        object_id,
        node.name,
        snapshot["position"],
        snapshot["rotation"],
        snapshot["scale"],
        mesh_path,
        asset
    )
    return payload


func _sync_mesh_for_node(node: Node3D) -> void:
    var object_id := _get_or_assign_object_id(node)
    var glb := SceneSyncGltfHelper.export_glb(node)
    if glb.is_empty():
        return

    var mesh_path := SceneSyncBlobClient.generate_random_path()
    var upload_err := await _blob_client.upload_glb(glb, mesh_path)
    if upload_err != OK:
        return

    _mesh_paths[object_id] = mesh_path
    _client.broadcast(SceneSyncProtocol.make_scene_mesh(object_id, mesh_path))


func _load_mesh_for_object(object_id: String, payload: Dictionary, mesh_path: String) -> void:
    var data := await _blob_client.download_glb(mesh_path)
    var old_node: Node3D = _managed_objects.get(object_id)
    var replacement: Node3D = null

    if not data.is_empty():
        replacement = SceneSyncGltfHelper.import_glb(data)
    if replacement == null:
        replacement = _create_primitive("box", "#ff4444")

    var parent: Node3D = _get_or_create_sync_root()
    if parent == null:
        return

    parent.add_child(replacement)
    if Engine.is_editor_hint():
        replacement.owner = get_tree().edited_scene_root

    replacement.name = String(payload.get("name", object_id))
    replacement.set_meta(OBJECT_ID_META, object_id)
    _apply_transform_to_node(replacement, SceneSyncProtocol.extract_transform(payload))

    if old_node != null and is_instance_valid(old_node):
        if old_node == _selected_object:
            _selected_object = replacement
        old_node.queue_free()

    _managed_objects[object_id] = replacement
    _known_ids[object_id] = true
    object_added.emit(object_id, replacement)


func _register_managed_object(object_id: String, node: Node3D) -> void:
    var parent: Node3D = _get_or_create_sync_root()
    if parent == null:
        return
    if node.get_parent() != parent:
        parent.add_child(node)
    if Engine.is_editor_hint():
        node.owner = get_tree().edited_scene_root
    node.name = String(node.name if node.name != "" else object_id)
    node.set_meta(OBJECT_ID_META, object_id)
    _managed_objects[object_id] = node
    _known_ids[object_id] = true


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
    if Engine.is_editor_hint():
        mesh.owner = get_tree().edited_scene_root
    return wrapper


func _detect_asset(node: Node3D) -> Dictionary:
    if node.has_meta("scene_sync_asset"):
        var existing = node.get_meta("scene_sync_asset")
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
