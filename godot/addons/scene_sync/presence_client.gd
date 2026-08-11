class_name SceneSyncPresenceClient
extends RefCounted

signal connected(id: String, room: String)
signal disconnected()
signal peers_updated(peers: Array)
signal handoff_received(data: Dictionary)
signal server_time_received(server_time_msec: float, received_monotonic_time: float)

var id: String = ""
var room: String = ""
var nickname: String = ""
var peers: Array = []
var server_time_msec: float = 0.0
var server_time_received_monotonic: float = 0.0

var _ws: WebSocketPeer
var _state: int = WebSocketPeer.STATE_CLOSED
var _url: String = ""
var _presence_url_base: String = ""
var _reconnect_timer: float = 0.0
var _should_reconnect: bool = false
var _hello_sent: bool = false
var _welcome_emitted: bool = false


func connect_to_server(presence_url: String, room_code: String, nick: String) -> void:
    disconnect_from_server(false)

    nickname = nick
    room = room_code
    id = ""
    peers.clear()
    server_time_msec = 0.0
    server_time_received_monotonic = 0.0
    _should_reconnect = true
    _reconnect_timer = 0.0
    _hello_sent = false
    _welcome_emitted = false
    _presence_url_base = presence_url

    var encoded_room := room_code.uri_encode()
    _url = presence_url
    if room_code != "":
        _url += "/?room=%s" % encoded_room

    _ws = WebSocketPeer.new()
    var err := _ws.connect_to_url(_url)
    if err != OK:
        push_warning("[SceneSync] WebSocket connect failed: %s" % error_string(err))
        _ws = null
        _state = WebSocketPeer.STATE_CLOSED
        _reconnect_timer = 3.0
        return

    _state = _ws.get_ready_state()


func disconnect_from_server(emit_signal: bool = true) -> void:
    _should_reconnect = false
    _reconnect_timer = 0.0
    _hello_sent = false
    _welcome_emitted = false
    peers.clear()
    server_time_msec = 0.0
    server_time_received_monotonic = 0.0
    id = ""
    room = ""

    if _ws != null:
        _ws.close()
        _ws = null
    _state = WebSocketPeer.STATE_CLOSED

    if emit_signal:
        disconnected.emit()


func poll(delta: float) -> void:
    if _ws == null:
        _poll_reconnect(delta)
        return

    _ws.poll()
    var current_state := _ws.get_ready_state()

    if current_state == WebSocketPeer.STATE_OPEN and not _hello_sent:
        _hello_sent = true
        _send_hello()

    if current_state == WebSocketPeer.STATE_CLOSED and _state != WebSocketPeer.STATE_CLOSED:
        _handle_closed()
        return

    _state = current_state

    while _ws != null and _ws.get_available_packet_count() > 0:
        var packet := _ws.get_packet()
        if _ws.was_string_packet():
            _handle_message(packet.get_string_from_utf8())

    if _ws == null:
        _poll_reconnect(delta)


func broadcast(payload: Dictionary) -> void:
    _send_text(JSON.stringify({
        "type": "broadcast",
        "payload": payload,
    }))


func send_handoff(target_id: String, payload: Dictionary) -> void:
    _send_text(JSON.stringify({
        "type": "handoff",
        "targetId": target_id,
        "payload": payload,
    }))


func _poll_reconnect(delta: float) -> void:
    if not _should_reconnect or _presence_url_base == "":
        return
    if _reconnect_timer > 0.0:
        _reconnect_timer -= delta
        if _reconnect_timer <= 0.0:
            connect_to_server(_presence_url_base, room, nickname)


func _send_hello() -> void:
    var version_info := Engine.get_version_info()
    var version := "%s.%s" % [version_info.get("major", 4), version_info.get("minor", 0)]
    _send_text(JSON.stringify({
        "type": "hello",
        "nickname": nickname,
        "device": "Godot %s (%s)" % [version, OS.get_name()],
    }))


func _handle_message(text: String) -> void:
    var parsed = JSON.parse_string(text)
    if parsed == null or not (parsed is Dictionary):
        return

    var data: Dictionary = parsed
    match String(data.get("type", "")):
        "welcome":
            id = String(data.get("id", ""))
            room = String(data.get("room", room))
            var server_time_value = data.get("serverTime", null)
            if _is_finite_number(server_time_value) and float(server_time_value) > 0.0:
                server_time_msec = float(server_time_value)
                server_time_received_monotonic = float(Time.get_ticks_usec()) / 1000000.0
                server_time_received.emit(server_time_msec, server_time_received_monotonic)
            if not _welcome_emitted:
                _welcome_emitted = true
                connected.emit(id, room)
        "peers":
            var next_peers: Array = []
            var raw_peers = data.get("peers", [])
            if raw_peers is Array:
                for peer in raw_peers:
                    if peer is Dictionary:
                        next_peers.append(peer)
            peers = next_peers
            peers_updated.emit(peers)
        "handoff":
            handoff_received.emit(data)
        "ping":
            _send_text("{\"type\":\"pong\"}")


func _send_text(text: String) -> void:
    if _ws == null or _ws.get_ready_state() != WebSocketPeer.STATE_OPEN:
        return
    var err := _ws.send_text(text)
    if err != OK:
        push_warning("[SceneSync] WebSocket send failed: %s" % error_string(err))


func _handle_closed() -> void:
    if _ws != null:
        _ws.close()
        _ws = null
    _state = WebSocketPeer.STATE_CLOSED
    _hello_sent = false
    _welcome_emitted = false
    server_time_msec = 0.0
    server_time_received_monotonic = 0.0
    disconnected.emit()
    if _should_reconnect:
        _reconnect_timer = 3.0


static func _is_finite_number(value: Variant) -> bool:
    return (value is int or value is float) and is_finite(float(value))
