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


func _ready() -> void:
    _connect_button.pressed.connect(_on_connect_button_pressed)
    _sync_meshes_button.pressed.connect(_on_sync_meshes_pressed)
    _ensure_manager()
    _presence_url_edit.text = _manager.presence_url
    _room_edit.text = _manager.room
    _nickname_edit.text = _manager.nickname
    _refresh_status()


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
            return
    _manager.deselect_object()


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


func _rebuild_peers(peers: Array) -> void:
    for child in _peers_container.get_children():
        child.queue_free()

    for peer in peers:
        if not (peer is Dictionary):
            continue
        var label := Label.new()
        label.text = String(peer.get("nickname", peer.get("id", "peer")))
        _peers_container.add_child(label)
