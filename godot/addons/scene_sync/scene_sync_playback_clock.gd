class_name SceneSyncPlaybackClock
extends RefCounted

signal broadcast_requested(payload: Dictionary)
signal state_changed(state: Dictionary)

enum PlaybackClockMode {
    LOCAL,
    SHARED_PLAYBACK_FOLLOW,
    SHARED_PLAYBACK_CONTROL,
    ROOM_TIME,
}

enum PlaybackFollowPolicy {
    MANUAL,
    AUTO_FOLLOW_OR_LOCAL,
    FOLLOWER_ONLY,
}

const LOCAL := PlaybackClockMode.LOCAL
const SHARED_PLAYBACK_FOLLOW := PlaybackClockMode.SHARED_PLAYBACK_FOLLOW
const SHARED_PLAYBACK_CONTROL := PlaybackClockMode.SHARED_PLAYBACK_CONTROL
const ROOM_TIME := PlaybackClockMode.ROOM_TIME
const MANUAL := PlaybackFollowPolicy.MANUAL
const AUTO_FOLLOW_OR_LOCAL := PlaybackFollowPolicy.AUTO_FOLLOW_OR_LOCAL
const FOLLOWER_ONLY := PlaybackFollowPolicy.FOLLOWER_ONLY
const SHARED_PLAYBACK_WIRE_MODE := "shared-playback"
const DEFAULT_BROADCAST_INTERVAL := 0.25
const MIN_BROADCAST_INTERVAL := 0.05

var mode: int = LOCAL
var follow_policy: int = MANUAL
var allow_control: bool = true
var broadcast_interval: Variant = DEFAULT_BROADCAST_INTERVAL:
    set(value):
        broadcast_interval = (
            maxf(MIN_BROADCAST_INTERVAL, float(value))
            if _is_finite_number(value)
            else DEFAULT_BROADCAST_INTERVAL
        )

var _clock := _inactive_clock()
var _revision := 0
var _last_broadcast_at := 0.0
var _has_last_broadcast := false
var _object_epoch_times: Dictionary = {}
var _local_client_id := ""
var _nickname := "Godot"
var _last_monotonic_time := 0.0
var _last_unix_time := 0.0
var _has_monotonic_sample := false
var _local_offset := 0.0
var _local_rate := 1.0
var _local_paused := false
var _local_paused_time := 0.0
var _fallback_uses_object_epochs := false
var _local_transport_controlled := false
var _room_anchor_time := 0.0
var _room_anchor_monotonic := 0.0
var _has_room_anchor := false
var _controller_id := ""
var _controller_nickname := ""
var _lease_deadline_monotonic := 0.0
var _has_lease_deadline := false


func set_room_time_anchor(server_time: Variant, monotonic_time: Variant) -> bool:
    if not _is_finite_number(server_time) or not _is_finite_number(monotonic_time):
        return false
    var normalized_server_time := float(server_time)
    if normalized_server_time > 100000000000.0:
        normalized_server_time /= 1000.0
    if normalized_server_time <= 0.0:
        return false
    _room_anchor_time = normalized_server_time
    _room_anchor_monotonic = maxf(0.0, float(monotonic_time))
    _has_room_anchor = true
    state_changed.emit(get_state().duplicate(true))
    return true


func get_room_time(monotonic_time: Variant, unix_time: Variant = null) -> float:
    var current_monotonic := _sanitize_time(monotonic_time, _last_monotonic_time)
    if _has_room_anchor:
        return _room_anchor_time + maxf(0.0, current_monotonic - _room_anchor_monotonic)
    return _sanitize_time(unix_time, _last_unix_time)


func set_follow_policy(raw_policy: Variant) -> Dictionary:
    follow_policy = _normalize_follow_policy(raw_policy)
    if follow_policy == FOLLOWER_ONLY and mode == SHARED_PLAYBACK_CONTROL:
        _leave_control_and_fallback("follower-only")
    _apply_automatic_mode()
    var result := get_state()
    state_changed.emit(result.duplicate(true))
    return result


func set_allow_control(value: Variant) -> Dictionary:
    allow_control = value if value is bool else true
    if not _can_control() and mode == SHARED_PLAYBACK_CONTROL:
        _leave_control_and_fallback("control-disabled")
    var result := get_state()
    state_changed.emit(result.duplicate(true))
    return result


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

    if next_mode == SHARED_PLAYBACK_CONTROL and not _can_control():
        next_mode = SHARED_PLAYBACK_FOLLOW if _has_valid_controller() else LOCAL

    var preserve_room_time_ages := (
        previous_mode != next_mode
        and (previous_mode == ROOM_TIME or next_mode == ROOM_TIME)
        and next_mode != SHARED_PLAYBACK_CONTROL
    )
    var preserved_object_ages := (
        _capture_object_ages(object_ids, _last_monotonic_time, _last_unix_time)
        if preserve_room_time_ages else {}
    )

    if previous_mode == SHARED_PLAYBACK_CONTROL and next_mode != SHARED_PLAYBACK_CONTROL:
        _broadcast_release(_last_monotonic_time, _last_unix_time)
        var released_time := _get_shared_clock_time(_last_monotonic_time)
        _controller_id = ""
        _controller_nickname = ""
        _clock["active"] = false
        _has_lease_deadline = false
        _rebase_local(released_time, _last_monotonic_time)

    if previous_mode != LOCAL and next_mode == LOCAL and previous_mode != SHARED_PLAYBACK_CONTROL:
        if previous_mode == ROOM_TIME:
            _reset_local_time_domain()
        else:
            _rebase_local_from_effective(_last_monotonic_time, _last_unix_time)

    mode = next_mode
    if mode == SHARED_PLAYBACK_CONTROL and previous_mode != SHARED_PLAYBACK_CONTROL:
        var initial_time := 0.0
        if previous_mode == SHARED_PLAYBACK_FOLLOW and _has_valid_controller():
            initial_time = _get_shared_clock_time(_last_monotonic_time)
        _start_control(initial_time, object_ids)

    if preserve_room_time_ages:
        _restore_object_ages(
            preserved_object_ages,
            _last_monotonic_time,
            _last_unix_time
        )

    var result := get_state()
    state_changed.emit(result.duplicate(true))
    return result


func ingest(
    raw_payload: Variant,
    from_id: Variant,
    local_client_id: Variant,
    received_monotonic_time: Variant = null,
    received_unix_time: Variant = null
) -> bool:
    var payload := _extract_payload(raw_payload)
    if payload.is_empty() and not (raw_payload is Dictionary):
        return false

    var wire_mode_value = payload.get("mode", SHARED_PLAYBACK_WIRE_MODE)
    if not (wire_mode_value is String):
        return false
    if (wire_mode_value as String).to_lower() != SHARED_PLAYBACK_WIRE_MODE:
        return false

    var clean_local_id := _clean_string(local_client_id)
    if clean_local_id == "":
        clean_local_id = _local_client_id
    else:
        _local_client_id = clean_local_id
    var receive_monotonic := _sanitize_time(received_monotonic_time, _last_monotonic_time)
    var receive_unix := _sanitize_time(received_unix_time, _last_unix_time)
    var clean_from_id := _clean_string(from_id)
    var is_local_source := clean_from_id != "" and clean_from_id == clean_local_id
    var controller_value_for_echo = payload.get("controller", null)
    var echo_controller_id := (
        _clean_string((controller_value_for_echo as Dictionary).get("id", ""))
        if controller_value_for_echo is Dictionary else ""
    )
    var is_local_echo := (
        is_local_source
        and echo_controller_id == clean_local_id
    )
    if (
        _has_room_anchor
        and _is_finite_number(payload.get("roomNow", null))
        and (payload.has("leaseExpiresAt") or payload.has("leaseDurationMs"))
    ):
        payload = payload.duplicate(true)
        var canonical_room_now := float(payload["roomNow"])
        var room_at_receipt := get_room_time(receive_monotonic, receive_unix)
        payload["roomNow"] = canonical_room_now + maxf(0.0, room_at_receipt - canonical_room_now)
    var remote_id := _get_remote_controller_id(payload, _clean_string(from_id), clean_local_id)
    var action := _clean_string(payload.get("action", "")).to_lower()
    var explicitly_inactive := payload.get("active", null) is bool and not bool(payload["active"])
    var release_payload := (
        explicitly_inactive
        or action in ["controller-release", "controller-expired", "controller-disconnected"]
        or (payload.has("controller") and payload.get("controller") == null)
    )

    if (
        release_payload and _controller_id != "" and clean_from_id != ""
        and clean_from_id != _controller_id and clean_from_id != "server"
    ):
        return false

    if payload.has("revision") and _is_finite_number(payload["revision"]):
        var incoming_revision := floori(float(payload["revision"]))
        if incoming_revision < _revision or (incoming_revision == _revision and not is_local_source):
            return false
        _revision = incoming_revision

    if mode == SHARED_PLAYBACK_CONTROL and not release_payload and not is_local_echo:
        if remote_id == "":
            return false
        mode = SHARED_PLAYBACK_FOLLOW
        _has_last_broadcast = false

    _clock = _parse_clock(payload, _clock, receive_monotonic)
    if action == "reset":
        _object_epoch_times.clear()
    _apply_object_clocks(payload)

    if release_payload:
        var final_time := _calculate_clock_time(_clock, receive_monotonic)
        _controller_id = ""
        _controller_nickname = ""
        _has_lease_deadline = false
        _clock["active"] = false
        _rebase_local(final_time, receive_monotonic)
        if mode == SHARED_PLAYBACK_CONTROL:
            mode = LOCAL
        _apply_automatic_mode()
    elif remote_id != "" or is_local_echo:
        if is_local_echo:
            remote_id = clean_local_id
        _controller_id = remote_id
        var controller_value = payload.get("controller", null)
        _controller_nickname = (
            _clean_string((controller_value as Dictionary).get("nickname", ""))
            if controller_value is Dictionary else ""
        )
        _clock["active"] = true
        _set_lease_deadline(payload, receive_monotonic)
        if follow_policy != MANUAL and mode != ROOM_TIME:
            mode = SHARED_PLAYBACK_FOLLOW
    elif payload.has("active"):
        _clock["active"] = false

    state_changed.emit(get_state().duplicate(true))
    return true


func reconcile_peers(peers: Variant, monotonic_time: Variant, unix_time: Variant) -> bool:
    if _controller_id == "" or not (peers is Array):
        return false
    if _controller_id == _local_client_id:
        return false
    var found := false
    for peer_value in peers:
        if peer_value is Dictionary and _clean_string((peer_value as Dictionary).get("id", "")) == _controller_id:
            found = true
            break
    if found:
        return false
    _fallback_from_shared(monotonic_time, unix_time, "controller-disconnected")
    return true


func update(monotonic_time: Variant, unix_time: Variant, object_ids: Variant) -> Dictionary:
    var has_current_monotonic := _is_finite_number(monotonic_time)
    var current_monotonic := _sanitize_time(monotonic_time, _last_monotonic_time)
    var current_unix := _sanitize_time(unix_time, _last_unix_time)
    _last_monotonic_time = current_monotonic
    _last_unix_time = current_unix
    _has_monotonic_sample = _has_monotonic_sample or has_current_monotonic

    if _has_valid_controller() and _has_lease_deadline and current_monotonic >= _lease_deadline_monotonic:
        _fallback_from_shared(current_monotonic, current_unix, "controller-lease-expired")

    if mode == SHARED_PLAYBACK_CONTROL:
        var interval := maxf(MIN_BROADCAST_INTERVAL, float(broadcast_interval))
        if not _has_last_broadcast or current_monotonic - _last_broadcast_at >= interval:
            if _broadcast_clock("mode", current_monotonic, current_unix, object_ids):
                state_changed.emit(get_state().duplicate(true))

    return get_state()


func get_playback_time(monotonic_time: Variant, unix_time: Variant) -> float:
    var current_monotonic := _sanitize_time(monotonic_time, _last_monotonic_time)
    var current_unix := _sanitize_time(unix_time, _last_unix_time)
    match get_effective_mode():
        SHARED_PLAYBACK_FOLLOW, SHARED_PLAYBACK_CONTROL:
            return _get_shared_clock_time(current_monotonic)
        ROOM_TIME:
            return get_room_time(current_monotonic, current_unix)
        _:
            return _get_local_time(current_monotonic)


func get_object_time(object_id: Variant, monotonic_time: Variant, unix_time: Variant) -> float:
    var active_time := get_playback_time(monotonic_time, unix_time)
    if not _uses_object_epochs():
        return active_time
    var clean_object_id := _clean_string(object_id)
    if clean_object_id == "":
        return active_time
    if _object_epoch_times.has(clean_object_id):
        var epoch_value = _object_epoch_times[clean_object_id]
        if _is_finite_number(epoch_value):
            return maxf(0.0, active_time - float(epoch_value))
    _object_epoch_times[clean_object_id] = active_time
    state_changed.emit(get_state().duplicate(true))
    return 0.0


func pause(monotonic_time: Variant, unix_time: Variant, object_ids: Variant = []) -> Dictionary:
    if mode == ROOM_TIME or mode == SHARED_PLAYBACK_FOLLOW:
        return get_state()
    var current_monotonic := _sanitize_time(monotonic_time, _last_monotonic_time)
    var current_unix := _sanitize_time(unix_time, _last_unix_time)
    var current_time := get_playback_time(current_monotonic, current_unix)
    if mode == SHARED_PLAYBACK_CONTROL:
        _clock["paused"] = true
        _clock["pausedTime"] = current_time
        _broadcast_clock("pause", current_monotonic, current_unix, object_ids)
    else:
        _local_paused = true
        _local_paused_time = current_time
        _local_transport_controlled = true
    return _emit_state()


func resume(monotonic_time: Variant, unix_time: Variant, object_ids: Variant = []) -> Dictionary:
    if mode == ROOM_TIME or mode == SHARED_PLAYBACK_FOLLOW:
        return get_state()
    var current_monotonic := _sanitize_time(monotonic_time, _last_monotonic_time)
    var current_unix := _sanitize_time(unix_time, _last_unix_time)
    if mode == SHARED_PLAYBACK_CONTROL:
        var paused_time := float(_clock.get("pausedTime", _get_shared_clock_time(current_monotonic)))
        var room_now := get_room_time(current_monotonic, current_unix)
        _clock["paused"] = false
        _clock["pausedTime"] = null
        _clock["offset"] = paused_time - room_now * float(_clock.get("rate", 1.0))
        _clock["roomNow"] = room_now
        _clock["receivedMonotonic"] = current_monotonic
        _broadcast_clock("play", current_monotonic, current_unix, object_ids)
    elif _local_paused:
        _local_paused = false
        _local_offset = _local_paused_time - current_monotonic * _local_rate
        _local_transport_controlled = true
    elif mode == LOCAL:
        _local_transport_controlled = true
    return _emit_state()


func seek(target_time: Variant, monotonic_time: Variant, unix_time: Variant, object_ids: Variant = []) -> Dictionary:
    if not _is_finite_number(target_time) or mode == ROOM_TIME or mode == SHARED_PLAYBACK_FOLLOW:
        return get_state()
    var target := maxf(0.0, float(target_time))
    var current_monotonic := _sanitize_time(monotonic_time, _last_monotonic_time)
    var current_unix := _sanitize_time(unix_time, _last_unix_time)
    if mode == SHARED_PLAYBACK_CONTROL:
        var room_now := get_room_time(current_monotonic, current_unix)
        _clock["offset"] = target - room_now * float(_clock.get("rate", 1.0))
        _clock["pausedTime"] = target if bool(_clock.get("paused", false)) else null
        _clock["roomNow"] = room_now
        _clock["receivedMonotonic"] = current_monotonic
        _broadcast_clock("seek", current_monotonic, current_unix, object_ids, target)
    else:
        _local_offset = target - current_monotonic * _local_rate
        if _local_paused:
            _local_paused_time = target
        _local_transport_controlled = true
    return _emit_state()


func reset(monotonic_time: Variant, unix_time: Variant, object_ids: Variant = []) -> Dictionary:
    if mode == ROOM_TIME or mode == SHARED_PLAYBACK_FOLLOW:
        return get_state()
    var current_monotonic := _sanitize_time(monotonic_time, _last_monotonic_time)
    var current_unix := _sanitize_time(unix_time, _last_unix_time)
    _object_epoch_times.clear()
    if mode == SHARED_PLAYBACK_CONTROL:
        var room_now := get_room_time(current_monotonic, current_unix)
        _clock["offset"] = -room_now * float(_clock.get("rate", 1.0))
        _clock["pausedTime"] = 0.0 if bool(_clock.get("paused", false)) else null
        _clock["roomNow"] = room_now
        _clock["receivedMonotonic"] = current_monotonic
        _broadcast_clock("reset", current_monotonic, current_unix, object_ids, 0.0)
    else:
        _local_offset = -current_monotonic * _local_rate
        if _local_paused:
            _local_paused_time = 0.0
        _local_transport_controlled = true
    return _emit_state()


func set_rate(rate: Variant, monotonic_time: Variant, unix_time: Variant, object_ids: Variant = []) -> Dictionary:
    if not _is_finite_number(rate) or float(rate) < 0.0 or mode == ROOM_TIME or mode == SHARED_PLAYBACK_FOLLOW:
        return get_state()
    var next_rate := float(rate)
    var current_monotonic := _sanitize_time(monotonic_time, _last_monotonic_time)
    var current_unix := _sanitize_time(unix_time, _last_unix_time)
    var current_time := get_playback_time(current_monotonic, current_unix)
    if mode == SHARED_PLAYBACK_CONTROL:
        var room_now := get_room_time(current_monotonic, current_unix)
        _clock["rate"] = next_rate
        _clock["offset"] = current_time - room_now * next_rate
        if bool(_clock.get("paused", false)):
            _clock["pausedTime"] = current_time
        _clock["roomNow"] = room_now
        _clock["receivedMonotonic"] = current_monotonic
        _broadcast_clock("rate", current_monotonic, current_unix, object_ids, current_time)
    else:
        _local_rate = next_rate
        _local_offset = current_time - current_monotonic * next_rate
        if _local_paused:
            _local_paused_time = current_time
        _local_transport_controlled = true
    return _emit_state()


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
    _last_broadcast_at = 0.0
    _has_last_broadcast = false
    _object_epoch_times.clear()
    _local_client_id = ""
    _nickname = "Godot"
    _last_monotonic_time = 0.0
    _last_unix_time = 0.0
    _has_monotonic_sample = false
    _local_offset = 0.0
    _local_rate = 1.0
    _local_paused = false
    _local_paused_time = 0.0
    _fallback_uses_object_epochs = false
    _local_transport_controlled = false
    _room_anchor_time = 0.0
    _room_anchor_monotonic = 0.0
    _has_room_anchor = false
    _controller_id = ""
    _controller_nickname = ""
    _lease_deadline_monotonic = 0.0
    _has_lease_deadline = false
    state_changed.emit(get_state())


func get_effective_mode() -> int:
    if mode == SHARED_PLAYBACK_CONTROL and _has_valid_controller():
        return SHARED_PLAYBACK_CONTROL
    if mode == SHARED_PLAYBACK_FOLLOW and _has_valid_controller():
        return SHARED_PLAYBACK_FOLLOW
    if mode == ROOM_TIME:
        return ROOM_TIME
    return LOCAL


func is_using_shared_time() -> bool:
    return get_effective_mode() != LOCAL


func get_state() -> Dictionary:
    var effective_mode := get_effective_mode()
    return {
        "mode": mode,
        "modeName": _mode_name(mode),
        "effectiveMode": effective_mode,
        "effectiveModeName": _mode_name(effective_mode),
        "followPolicy": follow_policy,
        "followPolicyName": _follow_policy_name(follow_policy),
        "allowControl": _can_control(),
        "configuredAllowControl": allow_control,
        "localTransportControlled": _local_transport_controlled,
        "active": _has_valid_controller(),
        "controller": (
            {"id": _controller_id, "nickname": _controller_nickname}
            if _controller_id != "" else null
        ),
        "source": String(_clock.get("source", "room")),
        "offset": float(_clock.get("offset", 0.0)),
        "paused": (
            bool(_clock.get("paused", false))
            if effective_mode in [SHARED_PLAYBACK_FOLLOW, SHARED_PLAYBACK_CONTROL]
            else (_local_paused if effective_mode == LOCAL else false)
        ),
        "pausedTime": _clock.get("pausedTime", null),
        "rate": (
            float(_clock.get("rate", 1.0))
            if effective_mode in [SHARED_PLAYBACK_FOLLOW, SHARED_PLAYBACK_CONTROL]
            else (_local_rate if effective_mode == LOCAL else 1.0)
        ),
        "roomNow": float(_clock.get("roomNow", 0.0)),
        "sentAt": float(_clock.get("sentAt", 0.0)),
        "leaseExpiresAt": _clock.get("leaseExpiresAt", null),
        "leaseDurationMs": _clock.get("leaseDurationMs", null),
        "revision": _revision,
        "objectClocks": _build_object_clock_payload([], 0.0, false),
    }


func _start_control(initial_time: float, object_ids: Variant) -> void:
    var room_now := get_room_time(_last_monotonic_time, _last_unix_time)
    _controller_id = _local_client_id
    _controller_nickname = _nickname
    _clock = {
        "active": true, "source": "room", "offset": initial_time - room_now,
        "paused": false, "pausedTime": null, "rate": 1.0,
        "roomNow": room_now, "sentAt": _unix_milliseconds(room_now),
        "receivedMonotonic": _last_monotonic_time,
        "leaseExpiresAt": null, "leaseDurationMs": null,
    }
    _has_last_broadcast = false
    _object_epoch_times.clear()
    _fallback_uses_object_epochs = false
    _broadcast_clock("controller", _last_monotonic_time, _last_unix_time, object_ids)


func _broadcast_clock(
    action: String,
    monotonic_time: float,
    unix_time: float,
    object_ids: Variant,
    target_time: Variant = null
) -> bool:
    if _local_client_id == "" or mode != SHARED_PLAYBACK_CONTROL or not _can_control():
        return false
    var active_time := _get_shared_clock_time(monotonic_time)
    var room_now := get_room_time(monotonic_time, unix_time)
    var rate := float(_clock.get("rate", 1.0))
    var offset := active_time - room_now * rate
    if bool(_clock.get("paused", false)):
        offset = float(_clock.get("offset", offset))
    var sent_at := _unix_milliseconds(room_now)
    _revision = maxi(1, _revision + 1)
    _last_broadcast_at = monotonic_time
    _has_last_broadcast = true
    _clock["active"] = true
    _clock["offset"] = offset
    _clock["roomNow"] = room_now
    _clock["sentAt"] = sent_at
    _clock["receivedMonotonic"] = monotonic_time
    var payload := {
        "kind": "scene-clock", "action": action, "mode": SHARED_PLAYBACK_WIRE_MODE,
        "active": true, "source": "room", "offset": offset,
        "paused": bool(_clock.get("paused", false)), "rate": rate,
        "controller": {"id": _local_client_id, "nickname": _nickname},
        "revision": _revision, "roomNow": room_now, "sentAt": sent_at,
        "time": active_time,
        "targetTime": active_time if not _is_finite_number(target_time) else float(target_time),
        "objectClocks": _build_object_clock_payload(object_ids, active_time, true),
    }
    if payload["paused"]:
        payload["pausedTime"] = float(_clock.get("pausedTime", active_time))
    broadcast_requested.emit(payload.duplicate(true))
    return true


func _broadcast_release(monotonic_time: float, unix_time: float) -> void:
    if _local_client_id == "" or _controller_id != _local_client_id:
        return
    var active_time := _get_shared_clock_time(monotonic_time)
    var room_now := get_room_time(monotonic_time, unix_time)
    var rate := float(_clock.get("rate", 1.0))
    var offset := active_time - room_now * rate
    var sent_at := _unix_milliseconds(room_now)
    _revision = maxi(1, _revision + 1)
    var payload := {
        "kind": "scene-clock", "action": "controller-release",
        "mode": SHARED_PLAYBACK_WIRE_MODE, "active": false, "source": "room",
        "offset": offset, "paused": bool(_clock.get("paused", false)),
        "rate": rate,
        "controller": null, "revision": _revision,
        "roomNow": room_now, "sentAt": sent_at,
        "time": active_time, "targetTime": active_time,
    }
    if bool(payload["paused"]) and _is_finite_number(_clock.get("pausedTime", null)):
        payload["pausedTime"] = float(_clock["pausedTime"])
    broadcast_requested.emit(payload.duplicate(true))


func _get_local_time(monotonic_time: float) -> float:
    if _local_paused:
        return maxf(0.0, _local_paused_time)
    var value := monotonic_time * _local_rate + _local_offset
    return maxf(0.0, value) if is_finite(value) else 0.0


func _get_shared_clock_time(monotonic_time: float) -> float:
    return _calculate_clock_time(_clock, monotonic_time)


func _calculate_clock_time(clock: Dictionary, monotonic_time: float) -> float:
    var paused_time_value = clock.get("pausedTime", null)
    if bool(clock.get("paused", false)) and _is_finite_number(paused_time_value):
        return maxf(0.0, float(paused_time_value))
    var room_now := float(clock.get("roomNow", 0.0))
    var received_monotonic := float(clock.get("receivedMonotonic", monotonic_time))
    var source_now := room_now + maxf(0.0, monotonic_time - received_monotonic)
    var value := source_now * float(clock.get("rate", 1.0)) + float(clock.get("offset", 0.0))
    return maxf(0.0, value) if is_finite(value) else 0.0


func _parse_clock(payload: Dictionary, previous: Dictionary, receive_monotonic: float) -> Dictionary:
    var source := String(previous.get("source", "room"))
    var source_value = payload.get("source", null)
    if source_value is String and not (source_value as String).strip_edges().is_empty():
        source = (source_value as String).strip_edges()
    var paused := bool(previous.get("paused", false))
    if payload.get("paused", null) is bool:
        paused = bool(payload["paused"])
    var paused_time: Variant = null
    if payload.has("pausedTime") and _is_finite_number(payload["pausedTime"]):
        paused_time = float(payload["pausedTime"])
    var rate := _read_finite(payload, "rate", float(previous.get("rate", 1.0)))
    if rate < 0.0:
        rate = 1.0
    var active := true
    if payload.get("active", null) is bool:
        active = bool(payload["active"])
    var previous_received_monotonic := float(previous.get("receivedMonotonic", receive_monotonic))
    var previous_room_at_receive := (
        float(previous.get("roomNow", 0.0))
        + maxf(0.0, receive_monotonic - previous_received_monotonic)
    )
    return {
        "active": active, "source": source,
        "offset": _read_finite(payload, "offset", float(previous.get("offset", 0.0))),
        "paused": paused, "pausedTime": paused_time, "rate": rate,
        "roomNow": _read_finite(payload, "roomNow", previous_room_at_receive),
        "sentAt": _read_finite(payload, "sentAt", float(previous.get("sentAt", 0.0))),
        "receivedMonotonic": receive_monotonic,
        "leaseExpiresAt": payload.get("leaseExpiresAt", null),
        "leaseDurationMs": payload.get("leaseDurationMs", null),
    }


func _set_lease_deadline(payload: Dictionary, receive_monotonic: float) -> void:
    var duration_seconds := 0.0
    var has_duration := false
    var lease_expires = payload.get("leaseExpiresAt", null)
    var sent_at = payload.get("sentAt", null)
    if _is_finite_number(lease_expires) and _has_room_anchor:
        duration_seconds = maxf(
            0.0,
            float(lease_expires) / 1000.0 - get_room_time(receive_monotonic, _last_unix_time)
        )
        has_duration = true
    elif _is_finite_number(lease_expires) and _is_finite_number(sent_at):
        duration_seconds = maxf(0.0, (float(lease_expires) - float(sent_at)) / 1000.0)
        has_duration = true
    elif _is_finite_number(payload.get("leaseDurationMs", null)):
        duration_seconds = maxf(0.0, float(payload["leaseDurationMs"]) / 1000.0)
        has_duration = true
    _lease_deadline_monotonic = receive_monotonic + duration_seconds
    _has_lease_deadline = has_duration


func _fallback_from_shared(monotonic_time: Variant, unix_time: Variant, _reason: String) -> void:
    var current_monotonic := _sanitize_time(monotonic_time, _last_monotonic_time)
    var was_using_shared := get_effective_mode() in [
        SHARED_PLAYBACK_FOLLOW,
        SHARED_PLAYBACK_CONTROL,
    ]
    var final_time := _get_shared_clock_time(current_monotonic) if was_using_shared else 0.0
    _controller_id = ""
    _controller_nickname = ""
    _clock["active"] = false
    _has_lease_deadline = false
    if was_using_shared:
        _rebase_local(final_time, current_monotonic)
    if mode == SHARED_PLAYBACK_CONTROL:
        mode = LOCAL
    _apply_automatic_mode()
    state_changed.emit(get_state().duplicate(true))


func handle_connection_lost(monotonic_time: Variant, unix_time: Variant) -> void:
    _revision = 0
    if _has_valid_controller() or mode == SHARED_PLAYBACK_CONTROL:
        _fallback_from_shared(monotonic_time, unix_time, "connection-lost")
    _has_room_anchor = false


func _leave_control_and_fallback(reason: String) -> void:
    _broadcast_release(_last_monotonic_time, _last_unix_time)
    _fallback_from_shared(_last_monotonic_time, _last_unix_time, reason)


func _rebase_local_from_effective(monotonic_time: float, unix_time: float) -> void:
    var active_time := get_playback_time(monotonic_time, unix_time)
    _rebase_local(active_time, monotonic_time, false)
    _object_epoch_times.clear()
    _fallback_uses_object_epochs = false


func _reset_local_time_domain() -> void:
    _local_offset = 0.0
    _local_rate = 1.0
    _local_paused = false
    _local_paused_time = 0.0
    _local_transport_controlled = false
    _fallback_uses_object_epochs = false


func _capture_object_ages(
    object_ids: Variant,
    monotonic_time: float,
    unix_time: float
) -> Dictionary:
    var ids := _normalize_object_ids(object_ids)
    for tracked_id in _normalize_object_ids(_object_epoch_times):
        if not ids.has(tracked_id):
            ids.append(tracked_id)
    var active_time := get_playback_time(monotonic_time, unix_time)
    var uses_epochs := _uses_object_epochs()
    var result: Dictionary = {}
    for object_id in ids:
        if uses_epochs:
            var epoch_value = _object_epoch_times.get(object_id, null)
            result[object_id] = (
                maxf(0.0, active_time - float(epoch_value))
                if _is_finite_number(epoch_value) else 0.0
            )
        else:
            result[object_id] = active_time
    return result


func _restore_object_ages(
    object_ages: Dictionary,
    monotonic_time: float,
    unix_time: float
) -> void:
    var active_time := get_playback_time(monotonic_time, unix_time)
    _object_epoch_times.clear()
    for object_id_value in object_ages.keys():
        var object_id := _clean_string(object_id_value)
        var age_value = object_ages[object_id_value]
        if object_id != "" and _is_finite_number(age_value):
            _object_epoch_times[object_id] = active_time - maxf(0.0, float(age_value))
    if get_effective_mode() == LOCAL and not _object_epoch_times.is_empty():
        # Room Time -> Local still needs manager-driven sampling so every
        # consumer observes the preserved object epochs instead of Unix-scale
        # ActiveTime leaking into ObjectAge/Rapier state.
        _fallback_uses_object_epochs = true
        _local_transport_controlled = true


func _rebase_local(
    active_time: float,
    monotonic_time: float,
    transport_controlled: bool = true
) -> void:
    # Local fallback deliberately resumes with the existing Local Preview contract:
    # monotonic time at 1x, rebased to the last displayed shared time.
    _local_rate = 1.0
    _local_paused = false
    _local_paused_time = active_time
    _local_offset = active_time - monotonic_time * _local_rate
    _fallback_uses_object_epochs = not _object_epoch_times.is_empty()
    _local_transport_controlled = transport_controlled


func _apply_automatic_mode() -> void:
    if follow_policy == MANUAL or mode == ROOM_TIME or mode == SHARED_PLAYBACK_CONTROL:
        return
    mode = SHARED_PLAYBACK_FOLLOW if _has_valid_controller() else LOCAL


func _can_control() -> bool:
    return allow_control and follow_policy != FOLLOWER_ONLY


func _has_valid_controller() -> bool:
    return bool(_clock.get("active", false)) and _controller_id != ""


func _uses_object_epochs() -> bool:
    return is_using_shared_time() or _fallback_uses_object_epochs or _local_transport_controlled


func _apply_object_clocks(payload: Dictionary) -> void:
    var clocks_value = payload.get("objectClocks", null)
    if not (clocks_value is Dictionary):
        return
    for object_id_value in (clocks_value as Dictionary).keys():
        var object_id := _clean_string(object_id_value)
        var entry_value = (clocks_value as Dictionary)[object_id_value]
        if object_id == "" or not (entry_value is Dictionary):
            continue
        var nested_value = (entry_value as Dictionary).get("clock", null)
        var clock_entry := nested_value as Dictionary if nested_value is Dictionary else entry_value as Dictionary
        var epoch_value = clock_entry.get("sharedEpochTime", clock_entry.get("sharedEpoch", null))
        if _is_finite_number(epoch_value):
            _object_epoch_times[object_id] = float(epoch_value)


func _build_object_clock_payload(object_ids: Variant, shared_epoch_time: float, update_epochs: bool) -> Dictionary:
    var ids := _normalize_object_ids(object_ids)
    if not update_epochs and ids.is_empty():
        ids = _normalize_object_ids(_object_epoch_times)
    var result: Dictionary = {}
    for object_id in ids:
        if update_epochs and not _object_epoch_times.has(object_id):
            _object_epoch_times[object_id] = shared_epoch_time
        var epoch_value = _object_epoch_times.get(object_id, shared_epoch_time)
        result[object_id] = {"sharedEpochTime": float(epoch_value) if _is_finite_number(epoch_value) else shared_epoch_time}
    return result


func _get_remote_controller_id(payload: Dictionary, from_id: String, local_client_id: String) -> String:
    if from_id != "" and from_id == local_client_id:
        return ""
    if payload.has("controller"):
        var controller_value = payload["controller"]
        if not (controller_value is Dictionary):
            return ""
        var controller_id := _clean_string((controller_value as Dictionary).get("id", null))
        return controller_id if controller_id != local_client_id else ""
    return from_id if from_id != local_client_id else ""


func _emit_state() -> Dictionary:
    var result := get_state()
    state_changed.emit(result.duplicate(true))
    return result


static func _extract_payload(raw_payload: Variant) -> Dictionary:
    if not (raw_payload is Dictionary):
        return {}
    var nested_value = (raw_payload as Dictionary).get("payload", null)
    return nested_value as Dictionary if nested_value is Dictionary else raw_payload as Dictionary


static func _normalize_mode(raw_mode: Variant) -> int:
    if raw_mode is int and int(raw_mode) >= LOCAL and int(raw_mode) <= ROOM_TIME:
        return int(raw_mode)
    if raw_mode is String:
        match (raw_mode as String).strip_edges().to_lower():
            "shared-playback-follow", "follow": return SHARED_PLAYBACK_FOLLOW
            "shared-playback-control", "control": return SHARED_PLAYBACK_CONTROL
            "room-time", "room": return ROOM_TIME
    return LOCAL


static func _normalize_follow_policy(raw_policy: Variant) -> int:
    if raw_policy is int and int(raw_policy) >= MANUAL and int(raw_policy) <= FOLLOWER_ONLY:
        return int(raw_policy)
    if raw_policy is String:
        match (raw_policy as String).strip_edges().to_lower():
            "auto-follow-or-local", "auto": return AUTO_FOLLOW_OR_LOCAL
            "follower-only", "follower": return FOLLOWER_ONLY
    return MANUAL


static func _mode_name(value: int) -> String:
    match value:
        SHARED_PLAYBACK_FOLLOW: return "shared-playback-follow"
        SHARED_PLAYBACK_CONTROL: return "shared-playback-control"
        ROOM_TIME: return "room-time"
        _: return "local"


static func _follow_policy_name(value: int) -> String:
    match value:
        AUTO_FOLLOW_OR_LOCAL: return "auto-follow-or-local"
        FOLLOWER_ONLY: return "follower-only"
        _: return "manual"


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
        if object_id != "": unique[object_id] = true
    var result: Array[String] = []
    for object_id in unique.keys(): result.append(String(object_id))
    result.sort()
    return result


static func _read_finite(payload: Dictionary, key: String, fallback: float) -> float:
    var value = payload.get(key, null)
    return float(value) if _is_finite_number(value) else fallback


static func _sanitize_time(value: Variant, fallback: float) -> float:
    if _is_finite_number(value): return maxf(0.0, float(value))
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
        "active": false, "source": "room", "offset": 0.0,
        "paused": false, "pausedTime": null, "rate": 1.0,
        "roomNow": 0.0, "sentAt": 0.0, "receivedMonotonic": 0.0,
        "leaseExpiresAt": null, "leaseDurationMs": null,
    }
