extends SceneTree

const CLOCK_SCRIPT := preload("res://addons/scene_sync/scene_sync_playback_clock.gd")

var _passed := 0
var _failed := 0
var _errors: Array[String] = []


func _init() -> void:
    _test_local_clock_and_invalid_times()
    _test_control_broadcasts_and_object_epochs()
    _test_follow_clock_and_revision_filtering()
    _test_remote_controller_takeover()
    _finish()


func _test_local_clock_and_invalid_times() -> void:
    var clock = CLOCK_SCRIPT.new()

    _assert_eq(clock.mode, CLOCK_SCRIPT.LOCAL, "Local is the default mode")
    _assert_approx(clock.get_playback_time(12.5, 1000.0), 12.5, "Local uses monotonic time")
    _assert_approx(clock.get_object_time("local-object", 12.5, 1000.0), 12.5, "Local object time has no epoch")

    clock.update(8.0, 100.0, [])
    _assert_approx(clock.get_playback_time(null, null), 8.0, "null time falls back to last update")
    _assert_approx(clock.get_playback_time(NAN, INF), 8.0, "NaN and INF time fall back safely")
    _assert_approx(clock.get_playback_time(-5.0, -10.0), 0.0, "negative time is clamped")

    clock.broadcast_interval = null
    _assert_approx(
        float(clock.broadcast_interval),
        CLOCK_SCRIPT.DEFAULT_BROADCAST_INTERVAL,
        "null interval falls back to default"
    )
    clock.broadcast_interval = NAN
    _assert_approx(
        float(clock.broadcast_interval),
        CLOCK_SCRIPT.DEFAULT_BROADCAST_INTERVAL,
        "NaN interval falls back to default"
    )
    clock.broadcast_interval = INF
    _assert_approx(
        float(clock.broadcast_interval),
        CLOCK_SCRIPT.DEFAULT_BROADCAST_INTERVAL,
        "INF interval falls back to default"
    )
    clock.broadcast_interval = "invalid"
    _assert_approx(
        float(clock.broadcast_interval),
        CLOCK_SCRIPT.DEFAULT_BROADCAST_INTERVAL,
        "wrong interval type falls back to default"
    )


func _test_control_broadcasts_and_object_epochs() -> void:
    var clock = CLOCK_SCRIPT.new()
    var broadcasts: Array[Dictionary] = []
    var states: Array[Dictionary] = []
    clock.broadcast_requested.connect(
        func(payload: Dictionary) -> void: broadcasts.append(payload.duplicate(true))
    )
    clock.state_changed.connect(
        func(state: Dictionary) -> void: states.append(state.duplicate(true))
    )

    clock.update(100.0, 1000.0, ["object-a"])
    clock.broadcast_interval = 0.001
    _assert_approx(
        float(clock.broadcast_interval),
        CLOCK_SCRIPT.MIN_BROADCAST_INTERVAL,
        "broadcast interval is clamped to 0.05 seconds"
    )

    clock.set_mode(
        CLOCK_SCRIPT.SHARED_PLAYBACK_CONTROL,
        "local-client",
        "Local User",
        ["object-a"]
    )
    _assert_eq(clock.mode, CLOCK_SCRIPT.SHARED_PLAYBACK_CONTROL, "Control mode is applied")
    _assert_eq(broadcasts.size(), 1, "Control start broadcasts immediately")
    var controller := broadcasts[0]
    _assert_eq(controller.get("kind"), "scene-clock", "controller payload kind")
    _assert_eq(controller.get("action"), "controller", "controller payload action")
    _assert_eq(controller.get("mode"), "shared-playback", "controller payload wire mode")
    _assert_eq(controller.get("controller", {}).get("id"), "local-client", "controller payload id")
    _assert_eq(controller.get("controller", {}).get("nickname"), "Local User", "controller nickname")
    _assert_approx(float(controller.get("time", -1.0)), 0.0, "Control starts at zero")
    _assert_approx(
        float(controller.get("objectClocks", {}).get("object-a", {}).get("sharedEpochTime", -1.0)),
        0.0,
        "controller payload creates object epoch"
    )

    clock.update(100.049, 1000.049, ["object-a"])
    _assert_eq(broadcasts.size(), 1, "Periodic broadcast waits for minimum interval")
    clock.update(100.051, 1000.051, ["object-a"])
    _assert_eq(broadcasts.size(), 2, "Periodic broadcast fires after minimum interval")
    var periodic := broadcasts[1]
    _assert_eq(periodic.get("action"), "mode", "Periodic payload action matches Unity")
    _assert_true(
        int(periodic.get("revision", 0)) > int(controller.get("revision", 0)),
        "Periodic revision increases"
    )
    _assert_approx(
        float(periodic.get("objectClocks", {}).get("object-a", {}).get("sharedEpochTime", -1.0)),
        0.0,
        "Periodic payload preserves object epoch"
    )

    _assert_approx(clock.get_playback_time(100.2, 1000.2), 0.2, "Control time uses its start epoch")
    _assert_approx(clock.get_object_time("object-a", 100.2, 1000.2), 0.2, "Existing object uses shared epoch")
    _assert_approx(clock.get_object_time("object-b", 100.2, 1000.2), 0.0, "New object starts at zero")
    _assert_approx(clock.get_object_time("object-b", 100.7, 1000.7), 0.5, "New object advances from its epoch")
    _assert_true(clock.forget_object("object-b"), "forget_object removes an epoch")
    _assert_approx(clock.get_object_time("object-b", 100.7, 1000.7), 0.0, "Forgotten object receives a new epoch")

    clock.set_mode(CLOCK_SCRIPT.SHARED_PLAYBACK_FOLLOW, "local-client", "Local User", [])
    _assert_eq(broadcasts.size(), 3, "Leaving Control broadcasts release")
    var release := broadcasts[2]
    _assert_eq(release.get("action"), "controller-release", "release payload action")
    _assert_eq(release.get("controller"), null, "release clears controller")
    _assert_true(
        int(release.get("revision", 0)) > int(periodic.get("revision", 0)),
        "Release revision increases"
    )
    _assert_true(not release.has("objectClocks"), "Release omits object clocks")
    _assert_true(not states.is_empty(), "Control changes emit state_changed")

    clock.clear()
    _assert_eq(clock.mode, CLOCK_SCRIPT.LOCAL, "clear returns to Local")
    _assert_true(clock.get_state().get("objectClocks", {}).is_empty(), "clear removes object epochs")


func _test_follow_clock_and_revision_filtering() -> void:
    var clock = CLOCK_SCRIPT.new()
    clock.set_mode(CLOCK_SCRIPT.SHARED_PLAYBACK_FOLLOW, "local-client", "Follower", [])

    var initial_payload := {
        "kind": "scene-clock",
        "mode": "shared-playback",
        "source": "room",
        "offset": 5.0,
        "paused": false,
        "rate": 2.0,
        "roomNow": 100.0,
        "sentAt": 100000.0,
        "revision": 10,
        "objectClocks": {
            "object-a": {"sharedEpochTime": 200.0},
            "object-b": {"clock": {"sharedEpoch": 201.0}},
        },
    }
    _assert_true(clock.ingest(initial_payload, "remote-client", "local-client"), "Follow accepts shared clock")
    _assert_approx(
        clock.get_playback_time(50.0, 101.5),
        208.0,
        "Follow applies roomNow, sentAt, rate, and offset"
    )
    _assert_approx(clock.get_object_time("object-a", 50.0, 101.5), 8.0, "Direct object epoch is applied")
    _assert_approx(clock.get_object_time("object-b", 50.0, 101.5), 7.0, "Nested legacy object epoch is applied")

    var stale_payload := initial_payload.duplicate(true)
    stale_payload["revision"] = 10
    stale_payload["offset"] = 999.0
    _assert_true(not clock.ingest(stale_payload, "remote-client", "local-client"), "Equal revision is rejected")
    stale_payload["revision"] = 9
    _assert_true(not clock.ingest(stale_payload, "remote-client", "local-client"), "Older revision is rejected")
    _assert_approx(clock.get_playback_time(50.0, 101.5), 208.0, "Stale clock does not change state")

    var paused_payload := {"mode": "shared-playback", "paused": true, "pausedTime": 7.5, "revision": 11}
    _assert_true(clock.ingest(paused_payload, "remote-client", "local-client"), "Paused clock is accepted")
    _assert_approx(clock.get_playback_time(999.0, 999.0), 7.5, "pausedTime freezes playback")

    var missing_paused_time := {"mode": "shared-playback", "paused": true, "revision": 12}
    _assert_true(clock.ingest(missing_paused_time, "remote-client", "local-client"), "Missing pausedTime is safe")
    _assert_approx(
        clock.get_playback_time(50.0, 101.5),
        208.0,
        "Missing pausedTime falls back to calculated clock"
    )

    var negative_rate := {"mode": "shared-playback", "paused": false, "rate": -4.0, "revision": 13}
    _assert_true(clock.ingest(negative_rate, "remote-client", "local-client"), "Negative rate payload is accepted safely")
    _assert_approx(clock.get_playback_time(50.0, 101.5), 106.5, "Negative rate falls back to one")

    var malformed := {
        "mode": "shared-playback",
        "offset": "invalid",
        "paused": null,
        "pausedTime": INF,
        "rate": null,
        "roomNow": NAN,
        "sentAt": INF,
        "revision": 14,
    }
    _assert_true(clock.ingest(malformed, null, "local-client"), "Malformed optional fields do not reject payload")
    _assert_approx(
        clock.get_playback_time(NAN, 101.5),
        106.5,
        "Malformed fields preserve finite clock values"
    )

    _assert_true(
        not clock.ingest({"mode": "local", "revision": 15}, "remote-client", "local-client"),
        "Non shared-playback mode is ignored"
    )
    _assert_true(not clock.ingest(null, null, null), "null payload is rejected safely")
    _assert_true(not clock.ingest("invalid", 12, []), "wrong payload and id types are rejected safely")


func _test_remote_controller_takeover() -> void:
    var clock = CLOCK_SCRIPT.new()
    var broadcasts: Array[Dictionary] = []
    clock.broadcast_requested.connect(
        func(payload: Dictionary) -> void: broadcasts.append(payload.duplicate(true))
    )
    clock.update(20.0, 500.0, [])
    clock.set_mode(CLOCK_SCRIPT.SHARED_PLAYBACK_CONTROL, "local-client", "Local", [])
    _assert_eq(broadcasts.size(), 1, "Takeover fixture starts with controller payload")

    var takeover := {
        "mode": "shared-playback",
        "controller": {"id": "remote-client", "nickname": "Remote"},
        "source": "room",
        "roomNow": 500.0,
        "sentAt": 500000.0,
        "offset": -500.0,
        "rate": 1.0,
        "revision": int(broadcasts[0].get("revision", 0)) + 1,
    }
    _assert_true(clock.ingest(takeover, "remote-client", "local-client"), "Remote controller takes ownership")
    _assert_eq(clock.mode, CLOCK_SCRIPT.SHARED_PLAYBACK_FOLLOW, "Remote takeover switches Control to Follow")
    _assert_eq(broadcasts.size(), 1, "Remote takeover does not emit local release")

    clock.set_mode(CLOCK_SCRIPT.SHARED_PLAYBACK_CONTROL, "local-client", "Local", [])
    var local_echo := takeover.duplicate(true)
    local_echo["revision"] = int(clock.get_state().get("revision", 0)) + 1
    _assert_true(not clock.ingest(local_echo, "local-client", "local-client"), "Local echo cannot take control")
    _assert_eq(clock.mode, CLOCK_SCRIPT.SHARED_PLAYBACK_CONTROL, "Local echo leaves Control active")

    var release_like := takeover.duplicate(true)
    release_like["revision"] = int(clock.get_state().get("revision", 0)) + 1
    release_like["controller"] = null
    _assert_true(not clock.ingest(release_like, "remote-client", "local-client"), "Null controller cannot take control")
    _assert_eq(clock.mode, CLOCK_SCRIPT.SHARED_PLAYBACK_CONTROL, "Null controller leaves Control active")


func _assert_approx(actual: float, expected: float, test_name: String) -> void:
    _assert_true(is_equal_approx(actual, expected), test_name)


func _assert_true(condition: bool, test_name: String) -> void:
    _assert_eq(condition, true, test_name)


func _assert_eq(actual: Variant, expected: Variant, test_name: String) -> void:
    if actual == expected:
        _passed += 1
        print("  OK: %s" % test_name)
        return

    _failed += 1
    var message := "%s: expected %s but got %s" % [test_name, str(expected), str(actual)]
    _errors.append(message)
    print("  FAIL: %s" % message)


func _finish() -> void:
    print("")
    print("========================================")
    print("  Playback Clock: PASSED=%d FAILED=%d" % [_passed, _failed])
    print("========================================")
    for error in _errors:
        print("  FAIL: %s" % error)
    quit(0 if _failed == 0 else 1)
