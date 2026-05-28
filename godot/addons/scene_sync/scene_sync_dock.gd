@tool
extends Control

var _editor_interface: EditorInterface
var _manager: SceneSyncManager

@onready var _presence_url_edit: LineEdit = %PresenceUrlEdit
@onready var _room_edit: LineEdit = %RoomEdit
@onready var _nickname_edit: LineEdit = %NicknameEdit
@onready var _connect_button: Button = %ConnectButton
@onready var _status_label: Label = %StatusLabel
@onready var _peers_container: VBoxContainer = %PeersContainer
@onready var _sync_meshes_button: Button = %SyncMeshesButton
@onready var _target_root_value: Label = %TargetRootValue
@onready var _publish_rules_label: Label = %PublishRulesLabel
@onready var _create_root_button: Button = %CreateRootButton
@onready var _use_selected_root_button: Button = %UseSelectedRootButton
@onready var _publish_selected_button: Button = %PublishSelectedButton
@onready var _publish_children_button: Button = %PublishChildrenButton
@onready var _publish_status_label: Label = %PublishStatusLabel


func _ready() -> void:
    _connect_button.pressed.connect(_on_connect_button_pressed)
    _sync_meshes_button.pressed.connect(_on_sync_meshes_pressed)
    _create_root_button.pressed.connect(_on_create_root_pressed)
    _use_selected_root_button.pressed.connect(_on_use_selected_root_pressed)
    _publish_selected_button.pressed.connect(_on_publish_selected_pressed)
    _publish_children_button.pressed.connect(_on_publish_children_pressed)
    _ensure_manager()
    _presence_url_edit.text = _manager.presence_url
    _room_edit.text = _manager.room
    _nickname_edit.text = _manager.nickname
    _refresh_status()
    _refresh_publish_status("Create or choose a Target Root to start publishing.")


func set_editor_interface(editor_interface: EditorInterface) -> void:
    _editor_interface = editor_interface


func on_editor_selection_changed() -> void:
    if _manager == null or _editor_interface == null:
        return

    var selection := _editor_interface.get_selection()
    if selection == null:
        return

    var selected_nodes := selection.get_selected_nodes()
    for node in selected_nodes:
        if node is Node3D:
            _manager.select_object(node)
            _refresh_publish_status(_candidate_message(node))
            return
    _manager.deselect_object()
    _refresh_publish_status(_candidate_message(null if selected_nodes.is_empty() else selected_nodes[0]))


func _on_connect_button_pressed() -> void:
    _ensure_manager()
    _manager.presence_url = _presence_url_edit.text.strip_edges()
    _manager.room = _room_edit.text.strip_edges()
    _manager.nickname = _nickname_edit.text.strip_edges()

    if _manager.is_connected_to_server():
        _manager.disconnect_from_server()
    else:
        _manager.connect_to_server()
    _refresh_status()


func _on_sync_meshes_pressed() -> void:
    _ensure_manager()
    _manager.sync_all_meshes()
    _refresh_publish_status("Republish Meshes requested.")


func _on_create_root_pressed() -> void:
    _ensure_manager()
    var scene_root := _get_edited_scene_root()
    var result := _manager.create_scene_sync_root(scene_root)
    if bool(result.get("ok", false)):
        var root = result.get("root")
        if _editor_interface != null and root is Node:
            var selection := _editor_interface.get_selection()
            if selection != null:
                selection.clear()
                selection.add_node(root)
        _refresh_publish_status("%s.\nMove 3D objects under this root, then click Publish Children." % String(result.get("message", "SceneSyncRoot ready")))
    else:
        _refresh_publish_status(_format_publish_result(result))


func _on_use_selected_root_pressed() -> void:
    _ensure_manager()
    var result := _manager.use_publish_root(_get_selected_node())
    if bool(result.get("ok", false)):
        _refresh_publish_status("%s.\nDirect Node3D children with meshes are now managed." % String(result.get("message", "Publish root updated")))
    else:
        _refresh_publish_status(_format_publish_result(result))


func _on_publish_selected_pressed() -> void:
    _ensure_manager()
    var result = await _manager.publish_node(_get_selected_node())
    _refresh_publish_status(_format_publish_result(result))


func _on_publish_children_pressed() -> void:
    _ensure_manager()
    var result = await _manager.publish_children_of_root()
    _refresh_publish_status(_format_publish_result(result))


func _ensure_manager() -> void:
    if _manager != null and is_instance_valid(_manager):
        return

    _manager = SceneSyncManager.new()
    _manager.name = "SceneSyncManager"
    _manager.auto_connect = false
    add_child(_manager)

    _manager.connected.connect(_on_manager_connected)
    _manager.disconnected.connect(_on_manager_disconnected)
    _manager.peers_updated.connect(_on_manager_peers_updated)


func _on_manager_connected(_id: String, _room: String) -> void:
    _refresh_status()


func _on_manager_disconnected() -> void:
    _refresh_status()
    _rebuild_peers([])


func _on_manager_peers_updated(peers: Array) -> void:
    _refresh_status()
    _rebuild_peers(peers)


func _refresh_status() -> void:
    if _manager == null:
        _status_label.text = "Disconnected"
        _connect_button.text = "Connect"
        return

    _status_label.text = _manager.get_status_text()
    _connect_button.text = "Disconnect" if _manager.is_connected_to_server() else "Connect"
    _refresh_target_root()


func _refresh_target_root() -> void:
    if _manager == null:
        _target_root_value.text = "No sync root selected"
        return
    var root_status := _manager.get_publish_root_status()
    if bool(root_status.get("ok", false)):
        var root = root_status.get("root")
        _target_root_value.text = _format_root_label(root)
        _publish_rules_label.text = "Managed objects: direct Node3D children of Target Root that contain a MeshInstance3D."
    else:
        _target_root_value.text = "No sync root selected"
        _publish_rules_label.text = "Click Create SceneSyncRoot, place 3D objects under it, then click Publish Children."


func _refresh_publish_status(message: String) -> void:
    _refresh_target_root()
    _publish_status_label.text = message


func _get_edited_scene_root() -> Node:
    if _editor_interface == null:
        return null
    return _editor_interface.get_edited_scene_root()


func _get_selected_node() -> Node:
    if _editor_interface == null:
        return null
    var selection := _editor_interface.get_selection()
    if selection == null:
        return null
    var selected_nodes := selection.get_selected_nodes()
    if selected_nodes.is_empty():
        return null
    return selected_nodes[0]


func _candidate_message(node: Node) -> String:
    _ensure_manager()
    var status := _manager.get_publish_candidate_status(node)
    if bool(status.get("publishable", false)):
        return "%s is ready to publish." % String(status.get("name", "Selected node"))
    return "Skipped\nReason: %s" % String(status.get("reason", "not publishable"))


func _format_root_label(root) -> String:
    if not (root is Node):
        return "No sync root selected"

    var scene_root := _get_edited_scene_root()
    if scene_root != null and root == scene_root:
        return "%s (scene root)" % root.name
    if scene_root != null and root is Node and root.is_inside_tree() and scene_root.is_inside_tree() and scene_root.is_ancestor_of(root):
        return String(scene_root.get_path_to(root))
    return root.name


func _format_publish_result(result: Dictionary) -> String:
    var lines: Array[String] = [
        "Published: %d" % int(result.get("published", 0)),
        "Skipped: %d" % int(result.get("skipped", 0)),
    ]
    var reasons = result.get("reasons", [])
    if reasons is Array:
        for entry in reasons:
            if entry is Dictionary:
                var name := String(entry.get("name", ""))
                var reason := String(entry.get("reason", "not publishable"))
                if name == "":
                    lines.append("- %s" % reason)
                else:
                    lines.append("- %s: %s" % [name, reason])
    return "\n".join(lines)


func _rebuild_peers(peers: Array) -> void:
    for child in _peers_container.get_children():
        child.queue_free()

    for peer in peers:
        if not (peer is Dictionary):
            continue
        var label := Label.new()
        label.text = String(peer.get("nickname", peer.get("id", "peer")))
        _peers_container.add_child(label)
