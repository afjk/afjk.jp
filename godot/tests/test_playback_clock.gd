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
    _test_room_time_and_wall_clock_skew()
    _test_transport_operations()
    _test_follow_policies_and_continuous_fallback()
    _test_lease_and_peer_expiry()
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
    clock.seek(5.0, 10.0, 100.0, ["local-object"])
    _assert_approx(clock.get_object_time("local-object", 10.0, 100.0), 0.0, "controlled Local creates an object epoch")
    clock.reset(10.0, 100.0, ["local-object"])
    _assert_approx(clock.get_object_time("local-object", 10.0, 100.0), 0.0, "Local reset rebases ObjectAge to zero")
    _assert_approx(clock.get_object_time("local-object", 11.0, 101.0), 1.0, "ObjectAge advances immediately after Local reset")


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
    _assert_true(not release.has("pausedTime"), "Running release omits nullable pausedTime")
    _assert_eq(clock.get_state().get("effectiveMode"), CLOCK_SCRIPT.LOCAL, "local release immediately uses fallback time")
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
    _assert_true(clock.ingest(initial_payload, "remote-client", "local-client", 50.0, 40.0), "Follow accepts shared clock")
    _assert_approx(
        clock.get_playback_time(51.5, 161.5),
        208.0,
        "Follow uses its local monotonic receive anchor despite +60s wall skew"
    )
    _assert_approx(clock.get_object_time("object-a", 51.5, 41.5), 8.0, "Direct object epoch is applied")
    _assert_approx(clock.get_object_time("object-b", 51.5, 161.5), 7.0, "Nested legacy object epoch is applied")

    var stale_payload := initial_payload.duplicate(true)
    stale_payload["revision"] = 10
    stale_payload["offset"] = 999.0
    _assert_true(not clock.ingest(stale_payload, "remote-client", "local-client"), "Equal revision is rejected")
    stale_payload["revision"] = 9
    _assert_true(not clock.ingest(stale_payload, "remote-client", "local-client"), "Older revision is rejected")
    _assert_approx(clock.get_playback_time(51.5, 101.5), 208.0, "Stale clock does not change state")

    var paused_payload := {"mode": "shared-playback", "paused": true, "pausedTime": 7.5, "revision": 11}
    _assert_true(clock.ingest(paused_payload, "remote-client", "local-client", 51.5, 999.0), "Paused clock is accepted")
    _assert_approx(clock.get_playback_time(999.0, 999.0), 7.5, "pausedTime freezes playback")

    var missing_paused_time := {"mode": "shared-playback", "paused": true, "revision": 12}
    _assert_true(clock.ingest(missing_paused_time, "remote-client", "local-client", 51.5, 999.0), "Missing pausedTime is safe")
    _assert_approx(
        clock.get_playback_time(51.5, 101.5),
        208.0,
        "Missing pausedTime falls back to calculated clock"
    )

    var negative_rate := {"mode": "shared-playback", "paused": false, "rate": -4.0, "revision": 13}
    _assert_true(clock.ingest(negative_rate, "remote-client", "local-client", 51.5, 999.0), "Negative rate payload is accepted safely")
    _assert_approx(clock.get_playback_time(51.5, 101.5), 106.5, "Negative rate falls back to one")

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
    _assert_true(clock.ingest(malformed, null, "local-client", 51.5, 999.0), "Malformed optional fields do not reject payload")
    _assert_approx(
        clock.get_playback_time(51.5, 101.5),
        106.5,
        "Malformed fields preserve finite clock values"
    )

    var reset_payload := {
        "mode": "shared-playback", "action": "reset", "paused": false,
        "roomNow": 100.0, "sentAt": 100000.0, "offset": -100.0,
        "rate": 1.0, "revision": 15,
    }
    _assert_true(clock.ingest(reset_payload, "remote-client", "local-client", 52.0, 999.0), "Remote reset is accepted")
    _assert_approx(clock.get_object_time("object-a", 52.0, 999.0), 0.0, "Remote reset clears the prior shared epoch")
    _assert_approx(clock.get_object_time("object-a", 53.0, 999.0), 1.0, "Remote ObjectAge advances immediately after reset")

    _assert_true(
        not clock.ingest({"mode": "local", "revision": 16}, "remote-client", "local-client"),
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
    _assert_true(not clock.ingest(release_like, "remote-client", "local-client", 20.0, 500.0), "Remote cannot release local control")
    _assert_eq(clock.mode, CLOCK_SCRIPT.SHARED_PLAYBACK_CONTROL, "Rejected release leaves Control active")
    release_like["revision"] = int(clock.get_state().get("revision", 0)) + 1
    _assert_true(clock.ingest(release_like, "local-client", "local-client", 20.0, 500.0), "Server echo can release local control")
    _assert_eq(clock.get_state().get("effectiveMode"), CLOCK_SCRIPT.LOCAL, "Server release exits Control")


func _test_room_time_and_wall_clock_skew() -> void:
    var clock = CLOCK_SCRIPT.new()
    _assert_true(clock.set_room_time_anchor(1700000000000.0, 10.0), "welcome serverTime anchors RoomNow")
    _assert_approx(clock.get_room_time(12.5, 999.0), 1700000002.5, "RoomNow advances from monotonic time")
    clock.set_mode(CLOCK_SCRIPT.ROOM_TIME, "local", "Room", [])
    _assert_eq(clock.get_state().get("modeName"), "room-time", "Room Time mode is exposed")
    _assert_approx(clock.get_playback_time(13.0, 1700000063.0), 1700000003.0, "Room Time ignores +60 second wall skew")

    var early = CLOCK_SCRIPT.new()
    var late = CLOCK_SCRIPT.new()
    early.set_mode(CLOCK_SCRIPT.SHARED_PLAYBACK_FOLLOW, "early", "Early", [])
    late.set_mode(CLOCK_SCRIPT.SHARED_PLAYBACK_FOLLOW, "late", "Late", [])
    var payload := {
        "mode": "shared-playback", "active": true,
        "controller": {"id": "controller"}, "roomNow": 1000.0,
        "sentAt": 1000000.0, "offset": -990.0, "rate": 1.0, "revision": 1,
    }
    early.ingest(payload, "controller", "early", 50.0, 940.0)
    late.ingest(payload, "controller", "late", 50.0, 1060.0)
    _assert_approx(early.get_playback_time(52.0, 942.0), 12.0, "-60 second client follows monotonic anchor")
    _assert_approx(late.get_playback_time(52.0, 1062.0), 12.0, "+60 second client follows monotonic anchor")

    var canonical = CLOCK_SCRIPT.new()
    canonical.set_room_time_anchor(1000.0, 10.0)
    canonical.set_mode(CLOCK_SCRIPT.SHARED_PLAYBACK_FOLLOW, "canonical", "Canonical", [])
    canonical.ingest({
        "mode": "shared-playback", "active": true,
        "controller": {"id": "controller"}, "roomNow": 1009.8,
        "sentAt": 1009800.0, "leaseExpiresAt": 1014800.0,
        "leaseDurationMs": 5000, "offset": -1000.0, "rate": 1.0, "revision": 1,
    }, "controller", "canonical", 20.0, 99999.0)
    _assert_approx(canonical.get_playback_time(20.0, 99999.0), 10.0, "canonical payload compensates 200ms transit from server anchor")

    var local_transition = CLOCK_SCRIPT.new()
    local_transition.update(10.0, 100.0, ["object"])
    local_transition.set_room_time_anchor(1000.0, 10.0)
    var local_age := local_transition.get_object_time("object", 10.0, 100.0)
    local_transition.set_mode(CLOCK_SCRIPT.ROOM_TIME, "local", "Local", ["object"])
    _assert_approx(local_transition.get_playback_time(10.0, 100.0), 1000.0, "Local to Room Time changes the ActiveTime domain")
    _assert_approx(local_transition.get_object_time("object", 10.0, 100.0), local_age, "Local to Room Time preserves ObjectAge")
    local_transition.update(11.0, 101.0, ["object"])
    _assert_approx(local_transition.get_object_time("object", 11.0, 101.0), local_age + 1.0, "Room Time ObjectAge advances from its rebased epoch")
    local_transition.set_mode(CLOCK_SCRIPT.LOCAL, "local", "Local", ["object"])
    _assert_approx(local_transition.get_playback_time(11.0, 101.0), 11.0, "Room Time to Local restores the monotonic ActiveTime domain")
    _assert_approx(local_transition.get_object_time("object", 11.0, 101.0), local_age + 1.0, "Room Time to Local preserves ObjectAge")
    _assert_true(bool(local_transition.get_state().get("localTransportControlled", false)), "Room Time to Local keeps consumers on the preserved object epoch")

    var shared_transition = CLOCK_SCRIPT.new()
    shared_transition.set_mode(CLOCK_SCRIPT.SHARED_PLAYBACK_FOLLOW, "follower", "Follower", ["object"])
    shared_transition.ingest({
        "mode": "shared-playback", "active": true,
        "controller": {"id": "controller"}, "roomNow": 200.0,
        "sentAt": 200000.0, "offset": -195.0, "rate": 1.0, "revision": 1,
        "objectClocks": {"object": {"sharedEpochTime": 4.0}},
    }, "controller", "follower", 20.0, 200.0)
    _assert_approx(shared_transition.get_object_time("object", 20.0, 200.0), 1.0, "Shared fixture starts with a one-second ObjectAge")
    shared_transition.set_room_time_anchor(1000.0, 20.0)
    shared_transition.set_mode(CLOCK_SCRIPT.ROOM_TIME, "follower", "Follower", ["object"])
    _assert_approx(shared_transition.get_playback_time(20.0, 200.0), 1000.0, "Shared to Room Time changes the ActiveTime domain")
    _assert_approx(shared_transition.get_object_time("object", 20.0, 200.0), 1.0, "Shared to Room Time preserves ObjectAge")
    shared_transition.update(21.0, 201.0, ["object"])
    shared_transition.set_mode(CLOCK_SCRIPT.SHARED_PLAYBACK_FOLLOW, "follower", "Follower", ["object"])
    _assert_approx(shared_transition.get_playback_time(21.0, 201.0), 6.0, "Room Time to Shared restores the shared ActiveTime domain")
    _assert_approx(shared_transition.get_object_time("object", 21.0, 201.0), 2.0, "Room Time to Shared preserves ObjectAge")

    var control_transition = CLOCK_SCRIPT.new()
    control_transition.update(10.0, 100.0, ["object"])
    control_transition.set_room_time_anchor(1000.0, 10.0)
    control_transition.set_mode(CLOCK_SCRIPT.ROOM_TIME, "controller", "Controller", ["object"])
    _assert_approx(control_transition.get_object_time("object", 10.0, 100.0), 10.0, "Room Time fixture preserves its prior Local ObjectAge")
    control_transition.set_mode(CLOCK_SCRIPT.SHARED_PLAYBACK_CONTROL, "controller", "Controller", ["object"])
    _assert_approx(control_transition.get_object_time("object", 10.0, 100.0), 0.0, "Room Time to Control starts a fresh controller object epoch")


func _test_transport_operations() -> void:
    var clock = CLOCK_SCRIPT.new()
    var broadcasts: Array[Dictionary] = []
    clock.broadcast_requested.connect(func(payload: Dictionary) -> void: broadcasts.append(payload.duplicate(true)))
    clock.update(100.0, 1000.0, ["object"])
    clock.set_mode(CLOCK_SCRIPT.SHARED_PLAYBACK_CONTROL, "controller", "Controller", ["object"])
    clock.seek(5.0, 100.0, 1000.0, ["object"])
    _assert_approx(clock.get_playback_time(100.0, 1060.0), 5.0, "seek sets shared active time")
    clock.pause(100.0, 1000.0, ["object"])
    _assert_approx(clock.get_playback_time(110.0, 1100.0), 5.0, "pause freezes shared active time")
    clock.set_rate(2.0, 110.0, 1100.0, ["object"])
    clock.resume(110.0, 1100.0, ["object"])
    _assert_approx(clock.get_playback_time(111.0, 1040.0), 7.0, "resume continues at the selected rate")
    clock.reset(111.0, 1101.0, ["object"])
    _assert_approx(clock.get_playback_time(111.0, 1101.0), 0.0, "reset returns shared active time to zero")
    var actions: Array[String] = []
    for payload in broadcasts:
        actions.append(String(payload.get("action", "")))
        _assert_true(bool(payload.get("active", false)), "transport operation keeps controller active")
    _assert_true(actions.has("seek") and actions.has("pause") and actions.has("rate") and actions.has("play") and actions.has("reset"), "all transport operations are broadcast")


func _test_follow_policies_and_continuous_fallback() -> void:
    var transitioning = CLOCK_SCRIPT.new()
    var transition_broadcasts: Array[Dictionary] = []
    transitioning.broadcast_requested.connect(
        func(payload: Dictionary) -> void: transition_broadcasts.append(payload.duplicate(true))
    )
    transitioning.update(5.0, 50.0, [])
    transitioning.set_mode(CLOCK_SCRIPT.SHARED_PLAYBACK_CONTROL, "desktop", "Desktop", [])
    transitioning.set_follow_policy(CLOCK_SCRIPT.FOLLOWER_ONLY)
    _assert_eq(transition_broadcasts.size(), 2, "Control to follower-only sends one release")
    _assert_eq(transition_broadcasts[1].get("action"), "controller-release", "capability change releases authority")
    _assert_eq(transitioning.get_state().get("effectiveMode"), CLOCK_SCRIPT.LOCAL, "capability change falls back immediately")

    var clock = CLOCK_SCRIPT.new()
    var broadcasts: Array[Dictionary] = []
    clock.broadcast_requested.connect(func(payload: Dictionary) -> void: broadcasts.append(payload.duplicate(true)))
    clock.update(10.0, 100.0, [])
    clock.set_follow_policy(CLOCK_SCRIPT.FOLLOWER_ONLY)
    clock.set_mode(CLOCK_SCRIPT.SHARED_PLAYBACK_CONTROL, "xr", "XR", [])
    _assert_eq(broadcasts.size(), 0, "follower-only never sends a controller payload")
    _assert_true(not bool(clock.get_state().get("allowControl", true)), "follower-only disables effective control capability")

    clock.ingest({
        "mode": "shared-playback", "active": true, "controller": {"id": "desktop"},
        "roomNow": 100.0, "sentAt": 100000.0, "offset": -195.0, "rate": 2.0, "revision": 1,
        "objectClocks": {"object": {"sharedEpochTime": 4.0}},
    }, "desktop", "xr", 10.0, 160.0)
    _assert_eq(clock.mode, CLOCK_SCRIPT.SHARED_PLAYBACK_FOLLOW, "controller appearance automatically follows")
    _assert_approx(clock.get_object_time("object", 11.0, 161.0), 3.0, "object age uses shared epoch")
    _assert_true(not clock.ingest({
        "mode": "shared-playback", "active": false, "controller": null,
        "action": "controller-release", "revision": 2,
    }, "other-peer", "xr", 11.0, 161.0), "non-controller cannot release followed clock")
    var before_release := clock.get_playback_time(11.0, 161.0)
    clock.ingest({
        "mode": "shared-playback", "active": false, "controller": null,
        "action": "controller-release", "roomNow": 101.0, "sentAt": 101000.0,
        "offset": -195.0, "rate": 2.0, "revision": 2,
    }, "desktop", "xr", 11.0, 161.0)
    _assert_eq(clock.mode, CLOCK_SCRIPT.LOCAL, "release automatically returns to Local")
    _assert_approx(clock.get_playback_time(11.0, 41.0), before_release, "Follow to Local keeps displayed time continuous")
    _assert_approx(clock.get_playback_time(12.0, 42.0), before_release + 1.0, "fallback continues on local monotonic time")
    _assert_eq(clock.get_state().get("rate"), 1.0, "fallback restores Local Preview rate")
    _assert_approx(clock.get_object_time("object", 12.0, 42.0), 4.0, "fallback preserves object age")


func _test_lease_and_peer_expiry() -> void:
    var lease_clock = CLOCK_SCRIPT.new()
    lease_clock.set_follow_policy(CLOCK_SCRIPT.AUTO_FOLLOW_OR_LOCAL)
    lease_clock.ingest({
        "mode": "shared-playback", "active": true, "controller": {"id": "desktop"},
        "roomNow": 100.0, "sentAt": 100000.0, "offset": -90.0, "rate": 1.0,
        "leaseDurationMs": 1000, "revision": 1,
    }, "desktop", "xr", 10.0, 160.0)
    var before_expiry := lease_clock.get_playback_time(11.0, 161.0)
    lease_clock.update(11.0, 41.0, [])
    _assert_eq(lease_clock.mode, CLOCK_SCRIPT.LOCAL, "lease timeout returns to Local")
    _assert_approx(lease_clock.get_playback_time(11.0, 41.0), before_expiry, "lease timeout is continuous")

    var peer_clock = CLOCK_SCRIPT.new()
    peer_clock.set_follow_policy(CLOCK_SCRIPT.AUTO_FOLLOW_OR_LOCAL)
    peer_clock.ingest({
        "mode": "shared-playback", "active": true, "controller": {"id": "desktop"},
        "roomNow": 200.0, "sentAt": 200000.0, "offset": -190.0, "rate": 1.0, "revision": 1,
    }, "desktop", "xr", 20.0, 260.0)
    _assert_true(peer_clock.reconcile_peers([], 21.0, 261.0), "missing controller peer invalidates stale replay")
    _assert_eq(peer_clock.mode, CLOCK_SCRIPT.LOCAL, "controller disconnect returns to Local")
    _assert_approx(peer_clock.get_playback_time(22.0, 9999.0), 12.0, "peer-loss fallback continues monotonically")
    peer_clock.handle_connection_lost(22.0, 9999.0)
    _assert_true(peer_clock.ingest({
        "mode": "shared-playback", "active": true, "controller": {"id": "new-controller"},
        "roomNow": 300.0, "sentAt": 300000.0, "offset": -290.0, "rate": 1.0, "revision": 1,
    }, "new-controller", "xr", 30.0, 360.0), "reconnect accepts a lower revision from a new room")


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
