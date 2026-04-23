extends Node

var _client: SceneSyncPresenceClient
var _timeout: float = 10.0
var _elapsed: float = 0.0
var _connected: bool = false
var _peers_received: bool = false
var _test_done: bool = false


func _ready() -> void:
    _client = SceneSyncPresenceClient.new()
    _client.connected.connect(_on_connected)
    _client.peers_updated.connect(_on_peers)

    var url = OS.get_environment("SCENESYNC_PRESENCE_URL")
    if url == "":
        url = "ws://localhost:8787"

    randomize()
    var room = "headless-test-%s" % randi()

    print("[Test] Connecting to %s room=%s" % [url, room])
    _client.connect_to_server(url, room, "HeadlessTest")


func _process(delta: float) -> void:
    _client.poll(delta)
    _elapsed += delta

    if _elapsed > _timeout and not _test_done:
        _finish(false, "Timeout: connected=%s peers=%s" % [_connected, _peers_received])


func _on_connected(id: String, room: String) -> void:
    print("[Test] Connected: id=%s room=%s" % [id, room])
    _connected = true
    _finish(true, "Connection successful")


func _on_peers(peers: Array) -> void:
    _peers_received = true
    print("[Test] Peers updated: count=%d" % peers.size())


func _finish(success: bool, message: String) -> void:
    if _test_done:
        return
    _test_done = true

    print("")
    print("========================================")
    if success:
        print("  RESULT: PASS - %s" % message)
    else:
        print("  RESULT: FAIL - %s" % message)
    print("========================================")

    _client.disconnect_from_server()
    get_tree().quit(0 if success else 1)
