class_name SceneSyncPlaybackClock
extends RefCounted

signal broadcast_requested(payload: Dictionary)
signal state_changed(state: Dictionary)

enum PlaybackClockMode {
    LOCAL,
    SHARED_PLAYBACK_FOLLOW,
    SHARED_PLAYBACK_CONTROL,
}

const LOCAL := PlaybackClockMode.LOCAL
const SHARED_PLAYBACK_FOLLOW := PlaybackClockMode.SHARED_PLAYBACK_FOLLOW
const SHARED_PLAYBACK_CONTROL := PlaybackClockMode.SHARED_PLAYBACK_CONTROL
const SHARED_PLAYBACK_WIRE_MODE := "shared-playback"
const DEFAULT_BROADCAST_INTERVAL := 0.25
const MIN_BROADCAST_INTERVAL := 0.05

var mode: int = LOCAL
var broadcast_interval: Variant = DEFAULT_BROADCAST_INTERVAL:
    set(value):
        broadcast_interval = (
            maxf(MIN_BROADCAST_INTERVAL, float(value))
            if _is_finite_number(value)
            else DEFAULT_BROADCAST_INTERVAL
        )

var _clock := _inactive_clock()
var _revision := 0
var _control_started_at := 0.0
var _has_control_start := false
var _last_broadcast_at := 0.0
var _has_last_broadcast := false
var _object_epoch_times: Dictionary = {}
var _local_client_id := ""
var _nickname := "Godot"
var _last_monotonic_time := 0.0
var _last_unix_time := 0.0
var _has_monotonic_sample := false


func set_mode(
    raw_mode: Variant,
    local_client_id: Variant,
    nickname: Variant,
    object_ids: Variant
) -> Dictionary:
    var next_mode := _normalize_mode(raw_mode)
    var previous_mode := mode
    _local_client_id = _clean_string(local_client_id)
    var clean_nickname := _clean_string(nickname)
    _nickname = clean_nickname if clean_nickname != "" else "Godot"

    if previous_mode == SHARED_PLAYBACK_CONTROL and next_mode != SHARED_PLAYBACK_CONTROL:
        _broadcast_release(_last_monotonic_time, _last_unix_time)

    mode = next_mode
    if mode == SHARED_PLAYBACK_CONTROL and previous_mode != SHARED_PLAYBACK_CONTROL:
        _control_started_at = _last_monotonic_time
        _has_control_start = _has_monotonic_sample
        _has_last_broadcast = false
        _object_epoch_times.clear()
        _broadcast_clock("controller", _last_monotonic_time, _last_unix_time, object_ids)

    var result := get_state()
    state_changed.emit(result.duplicate(true))
    return result


func ingest(raw_payload: Variant, from_id: Variant, local_client_id: Variant) -> bool:
    var payload := _extract_payload(raw_payload)
    if payload.is_empty() and not (raw_payload is Dictionary):
        return false

    var wire_mode_value = payload.get("mode", SHARED_PLAYBACK_WIRE_MODE)
    if not (wire_mode_value is String):
        return false
    if (wire_mode_value as String).to_lower() != SHARED_PLAYBACK_WIRE_MODE:
        return false

    if payload.has("revision") and _is_finite_number(payload["revision"]):
        var incoming_revision := floori(float(payload["revision"]))
        if incoming_revision <= _revision:
            return false
        _revision = incoming_revision

    var clean_local_id := _clean_string(local_client_id)
    if clean_local_id == "":
        clean_local_id = _local_client_id
    else:
        _local_client_id = clean_local_id

    if mode == SHARED_PLAYBACK_CONTROL:
        var remote_controller_id := _get_remote_controller_id(
            payload,
            _clean_string(from_id),
            clean_local_id
        )
        if remote_controller_id == "":
            return false
        mode = SHARED_PLAYBACK_FOLLOW
        _has_control_start = false
        _has_last_broadcast = false

    _clock = _parse_clock(payload, _clock)
    _apply_object_clocks(payload)
    state_changed.emit(get_state().duplicate(true))
    return true


func update(monotonic_time: Variant, unix_time: Variant, object_ids: Variant) -> Dictionary:
    var has_current_monotonic := _is_finite_number(monotonic_time)
    var current_monotonic := _sanitize_time(monotonic_time, _last_monotonic_time)
    var current_unix := _sanitize_time(unix_time, _last_unix_time)
    _last_monotonic_time = current_monotonic
    _last_unix_time = current_unix
    _has_monotonic_sample = _has_monotonic_sample or has_current_monotonic

    if mode == SHARED_PLAYBACK_CONTROL:
        if not _has_control_start and has_current_monotonic:
            _control_started_at = current_monotonic
            _has_control_start = true
        var interval := maxf(MIN_BROADCAST_INTERVAL, float(broadcast_interval))
        if not _has_last_broadcast or current_monotonic - _last_broadcast_at >= interval:
            if _broadcast_clock("mode", current_monotonic, current_unix, object_ids):
                state_changed.emit(get_state().duplicate(true))

    return get_state()


func get_playback_time(monotonic_time: Variant, unix_time: Variant) -> float:
    var current_monotonic := _sanitize_time(monotonic_time, _last_monotonic_time)
    var current_unix := _sanitize_time(unix_time, _last_unix_time)

    if mode == SHARED_PLAYBACK_CONTROL:
        if not _has_control_start:
            _control_started_at = current_monotonic
            _has_control_start = true
        return maxf(0.0, current_monotonic - _control_started_at)

    if mode == SHARED_PLAYBACK_FOLLOW and bool(_clock.get("active", false)):
        return _get_shared_clock_time(current_monotonic, current_unix)

    return maxf(0.0, current_monotonic)


func get_object_time(
    object_id: Variant,
    monotonic_time: Variant,
    unix_time: Variant
) -> float:
    var shared_time := get_playback_time(monotonic_time, unix_time)
    if not _uses_object_epochs():
        return shared_time

    var clean_object_id := _clean_string(object_id)
    if clean_object_id == "":
        return shared_time

    if _object_epoch_times.has(clean_object_id):
        var epoch_value = _object_epoch_times[clean_object_id]
        if _is_finite_number(epoch_value):
            return maxf(0.0, shared_time - float(epoch_value))

    _object_epoch_times[clean_object_id] = shared_time
    state_changed.emit(get_state().duplicate(true))
    return 0.0


func forget_object(object_id: Variant) -> bool:
    var clean_object_id := _clean_string(object_id)
    if clean_object_id == "" or not _object_epoch_times.has(clean_object_id):
        return false
    var erased := _object_epoch_times.erase(clean_object_id)
    if erased:
        state_changed.emit(get_state().duplicate(true))
    return erased


func clear() -> void:
    mode = LOCAL
    _clock = _inactive_clock()
    _revision = 0
    _control_started_at = 0.0
    _has_control_start = false
    _last_broadcast_at = 0.0
    _has_last_broadcast = false
    _object_epoch_times.clear()
    _local_client_id = ""
    _nickname = "Godot"
    _last_monotonic_time = 0.0
    _last_unix_time = 0.0
    _has_monotonic_sample = false
    state_changed.emit(get_state())


func get_state() -> Dictionary:
    return {
        "mode": mode,
        "modeName": _mode_name(mode),
        "active": bool(_clock.get("active", false)),
        "source": String(_clock.get("source", "room")),
        "offset": float(_clock.get("offset", 0.0)),
        "paused": bool(_clock.get("paused", false)),
        "pausedTime": _clock.get("pausedTime", null),
        "rate": float(_clock.get("rate", 1.0)),
        "roomNow": float(_clock.get("roomNow", 0.0)),
        "sentAt": float(_clock.get("sentAt", 0.0)),
        "revision": _revision,
        "objectClocks": _build_object_clock_payload([], 0.0, false),
    }


func _broadcast_clock(
    action: String,
    monotonic_time: float,
    unix_time: float,
    object_ids: Variant
) -> bool:
    if _local_client_id == "":
        return false

    var active_time := 0.0
    if mode != SHARED_PLAYBACK_CONTROL or _has_control_start:
        active_time = get_playback_time(monotonic_time, unix_time)
    var room_now := unix_time
    var offset := active_time - room_now
    var sent_at := _unix_milliseconds(room_now)
    _revision = maxi(1, _revision + 1)
    _last_broadcast_at = monotonic_time
    _has_last_broadcast = true
    _clock = {
        "active": true,
        "source": "room",
        "offset": offset,
        "paused": false,
        "pausedTime": null,
        "rate": 1.0,
        "roomNow": room_now,
        "sentAt": sent_at,
    }

    var payload := {
        "kind": "scene-clock",
        "action": action,
        "mode": SHARED_PLAYBACK_WIRE_MODE,
        "source": "room",
        "offset": offset,
        "paused": false,
        "rate": 1.0,
        "controller": {
            "id": _local_client_id,
            "nickname": _nickname,
        },
        "revision": _revision,
        "roomNow": room_now,
        "sentAt": sent_at,
        "time": active_time,
        "targetTime": active_time,
        "objectClocks": _build_object_clock_payload(object_ids, active_time, true),
    }
    broadcast_requested.emit(payload.duplicate(true))
    return true


func _broadcast_release(monotonic_time: float, unix_time: float) -> void:
    if _local_client_id == "":
        return

    var active_time := get_playback_time(monotonic_time, unix_time)
    var offset := active_time - unix_time
    var sent_at := _unix_milliseconds(unix_time)
    _revision = maxi(1, _revision + 1)
    _last_broadcast_at = monotonic_time
    _has_last_broadcast = true
    _clock = {
        "active": true,
        "source": "room",
        "offset": offset,
        "paused": false,
        "pausedTime": null,
        "rate": 1.0,
        "roomNow": unix_time,
        "sentAt": sent_at,
    }

    var payload := {
        "kind": "scene-clock",
        "action": "controller-release",
        "mode": SHARED_PLAYBACK_WIRE_MODE,
        "source": "room",
        "offset": offset,
        "paused": false,
        "rate": 1.0,
        "controller": null,
        "revision": _revision,
        "roomNow": unix_time,
        "sentAt": sent_at,
    }
    broadcast_requested.emit(payload.duplicate(true))


func _get_shared_clock_time(monotonic_time: float, unix_time: float) -> float:
    var paused_time_value = _clock.get("pausedTime", null)
    if bool(_clock.get("paused", false)) and _is_finite_number(paused_time_value):
        return maxf(0.0, float(paused_time_value))

    var source_now := monotonic_time
    if String(_clock.get("source", "room")).to_lower() == "room":
        source_now = _get_room_now(unix_time)
    var time := source_now * float(_clock.get("rate", 1.0)) + float(_clock.get("offset", 0.0))
    return maxf(0.0, time) if is_finite(time) else 0.0


func _get_room_now(unix_time: float) -> float:
    var room_now := float(_clock.get("roomNow", 0.0))
    var sent_at := float(_clock.get("sentAt", 0.0))
    if not is_finite(room_now) or room_now <= 0.0:
        return 0.0
    if not is_finite(sent_at) or sent_at <= 0.0:
        return room_now
    return room_now + maxf(0.0, unix_time - sent_at / 1000.0)


func _parse_clock(payload: Dictionary, previous: Dictionary) -> Dictionary:
    var source := String(previous.get("source", "room"))
    var source_value = payload.get("source", null)
    if source_value is String and not (source_value as String).strip_edges().is_empty():
        source = (source_value as String).strip_edges()

    var offset := _read_finite(payload, "offset", float(previous.get("offset", 0.0)))
    var paused := bool(previous.get("paused", false))
    if payload.get("paused", null) is bool:
        paused = bool(payload["paused"])

    var paused_time: Variant = null
    if payload.has("pausedTime") and _is_finite_number(payload["pausedTime"]):
        paused_time = float(payload["pausedTime"])

    var previous_rate := float(previous.get("rate", 1.0))
    var rate := _read_finite(payload, "rate", previous_rate)
    if payload.has("rate") and _is_finite_number(payload["rate"]) and rate < 0.0:
        rate = 1.0

    return {
        "active": true,
        "source": source,
        "offset": offset,
        "paused": paused,
        "pausedTime": paused_time,
        "rate": rate,
        "roomNow": _read_finite(payload, "roomNow", float(previous.get("roomNow", 0.0))),
        "sentAt": _read_finite(payload, "sentAt", float(previous.get("sentAt", 0.0))),
    }


func _apply_object_clocks(payload: Dictionary) -> void:
    var clocks_value = payload.get("objectClocks", null)
    if not (clocks_value is Dictionary):
        return

    var clocks := clocks_value as Dictionary
    for object_id_value in clocks.keys():
        var object_id := _clean_string(object_id_value)
        if object_id == "":
            continue
        var entry_value = clocks[object_id_value]
        if not (entry_value is Dictionary):
            continue
        var entry := entry_value as Dictionary
        var nested_value = entry.get("clock", null)
        var clock_entry := nested_value as Dictionary if nested_value is Dictionary else entry
        var epoch_value = clock_entry.get("sharedEpochTime", null)
        if not _is_finite_number(epoch_value):
            epoch_value = clock_entry.get("sharedEpoch", null)
        if _is_finite_number(epoch_value):
            _object_epoch_times[object_id] = float(epoch_value)


func _build_object_clock_payload(
    object_ids: Variant,
    shared_epoch_time: float,
    update_epochs: bool
) -> Dictionary:
    var ids := _normalize_object_ids(object_ids)
    if not update_epochs and ids.is_empty():
        ids = _normalize_object_ids(_object_epoch_times)

    var result: Dictionary = {}
    for object_id in ids:
        if update_epochs and not _object_epoch_times.has(object_id):
            _object_epoch_times[object_id] = shared_epoch_time
        var epoch_value = _object_epoch_times.get(object_id, shared_epoch_time)
        var epoch := float(epoch_value) if _is_finite_number(epoch_value) else shared_epoch_time
        result[object_id] = {"sharedEpochTime": epoch}
    return result


func _get_remote_controller_id(
    payload: Dictionary,
    from_id: String,
    local_client_id: String
) -> String:
    if from_id != "" and from_id == local_client_id:
        return ""

    if payload.has("controller"):
        var controller_value = payload["controller"]
        if not (controller_value is Dictionary):
            return ""
        var controller_id := _clean_string((controller_value as Dictionary).get("id", null))
        if controller_id == "" or controller_id == local_client_id:
            return ""
        return controller_id

    if from_id == "" or from_id == local_client_id:
        return ""
    return from_id


func _uses_object_epochs() -> bool:
    return (
        mode == SHARED_PLAYBACK_CONTROL
        or (mode == SHARED_PLAYBACK_FOLLOW and bool(_clock.get("active", false)))
    )


static func _extract_payload(raw_payload: Variant) -> Dictionary:
    if not (raw_payload is Dictionary):
        return {}
    var payload := raw_payload as Dictionary
    var nested_value = payload.get("payload", null)
    if nested_value is Dictionary:
        return nested_value as Dictionary
    return payload


static func _normalize_mode(raw_mode: Variant) -> int:
    if raw_mode is int:
        var numeric_mode := int(raw_mode)
        if numeric_mode >= LOCAL and numeric_mode <= SHARED_PLAYBACK_CONTROL:
            return numeric_mode
    elif raw_mode is String:
        match (raw_mode as String).strip_edges().to_lower():
            "shared-playback-follow", "follow":
                return SHARED_PLAYBACK_FOLLOW
            "shared-playback-control", "control":
                return SHARED_PLAYBACK_CONTROL
    return LOCAL


static func _mode_name(value: int) -> String:
    match value:
        SHARED_PLAYBACK_FOLLOW:
            return "shared-playback-follow"
        SHARED_PLAYBACK_CONTROL:
            return "shared-playback-control"
        _:
            return "local"


static func _normalize_object_ids(raw_ids: Variant) -> Array[String]:
    var values: Array = []
    if raw_ids is Dictionary:
        values = (raw_ids as Dictionary).keys()
    elif raw_ids is Array:
        values = raw_ids
    elif raw_ids is PackedStringArray:
        values = Array(raw_ids)

    var unique: Dictionary = {}
    for value in values:
        var object_id := _clean_string(value)
        if object_id != "":
            unique[object_id] = true
    var result: Array[String] = []
    for object_id in unique.keys():
        result.append(String(object_id))
    result.sort()
    return result


static func _read_finite(payload: Dictionary, key: String, fallback: float) -> float:
    var value = payload.get(key, null)
    return float(value) if _is_finite_number(value) else fallback


static func _sanitize_time(value: Variant, fallback: float) -> float:
    if _is_finite_number(value):
        return maxf(0.0, float(value))
    return maxf(0.0, fallback) if is_finite(fallback) else 0.0


static func _unix_milliseconds(unix_time: float) -> float:
    var milliseconds := unix_time * 1000.0
    return round(milliseconds) if is_finite(milliseconds) else 0.0


static func _clean_string(value: Variant) -> String:
    return (value as String).strip_edges() if value is String else ""


static func _is_finite_number(value: Variant) -> bool:
    return (value is int or value is float) and is_finite(float(value))


static func _inactive_clock() -> Dictionary:
    return {
        "active": false,
        "source": "room",
        "offset": 0.0,
        "paused": false,
        "pausedTime": null,
        "rate": 1.0,
        "roomNow": 0.0,
        "sentAt": 0.0,
    }
