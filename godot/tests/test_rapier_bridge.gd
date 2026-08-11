extends SceneTree

const BRIDGE_SCRIPT := preload("res://addons/scene_sync/scene_sync_rapier_bridge.gd")
const TIMESTEP := 1.0 / 60.0
const FREEFALL_HASHES := {
    0: "1a8cf55faa0e4e4e",
    1: "8f9f11fbf1f52663",
    2: "a882f0aedd1ea2e3",
    10: "b05d71580dd8b483",
    60: "14f6c93758a3967a",
    120: "165dfa5582a4ba24",
}

var _passed := 0
var _failed := 0
var _errors: Array[String] = []


func _init() -> void:
    call_deferred("_run")


func _run() -> void:
    _test_addon_contract()
    _test_freefall_hashes_and_transform()
    _test_shared_tick_hash_verification_and_lifecycle()
    _test_room_time_mode_rebase()
    _test_missing_addon_fallback()
    _finish()


func _test_addon_contract() -> void:
    _assert_true(
        ClassDB.class_exists(&"SceneSyncRapierWorld3D"),
        "SceneSyncRapierWorld3D is registered"
    )
    if not ClassDB.class_exists(&"SceneSyncRapierWorld3D"):
        return
    var world: RefCounted = ClassDB.instantiate(&"SceneSyncRapierWorld3D") as RefCounted
    _assert_true(world != null, "SceneSyncRapierWorld3D can be instantiated")
    if world == null:
        return
    _assert_eq(world.call("get_profile"), BRIDGE_SCRIPT.PROFILE, "profile matches canonical contract")
    _assert_eq(
        world.call("get_hash_version"),
        BRIDGE_SCRIPT.HASH_VERSION,
        "hash version matches canonical contract"
    )
    _assert_eq(
        world.call("get_rapier_core_version"),
        BRIDGE_SCRIPT.RAPIER_CORE_VERSION,
        "Rapier core version matches canonical contract"
    )
    world = null


func _test_freefall_hashes_and_transform() -> void:
    var fixture := _new_freefall_fixture()
    var bridge = fixture["bridge"]
    var body := fixture["body"] as Node3D

    for tick_value in FREEFALL_HASHES.keys():
        var tick := int(tick_value)
        var state: Dictionary = bridge.advance_to_time(float(tick) * TIMESTEP, 0, true)
        _assert_true(bool(state.get("active", false)), "freefall is active at tick %d" % tick)
        _assert_eq(bridge.get_tick(), tick, "freefall reaches tick %d" % tick)
        _assert_eq(
            bridge.get_canonical_state_hash(),
            FREEFALL_HASHES[tick],
            "freefall canonical hash at tick %d" % tick
        )

    _assert_true(body.position.y < 5.0, "dynamic body transform follows Rapier state")
    _assert_true(body.position.x > -0.75, "dynamic body linear velocity is reflected")
    _assert_true(not body.quaternion.is_equal_approx(Quaternion.IDENTITY), "body rotation is reflected")
    _free_fixture(fixture)


func _test_shared_tick_hash_verification_and_lifecycle() -> void:
    var fixture := _new_freefall_fixture()
    var bridge = fixture["bridge"]
    var body := fixture["body"] as Node3D
    var reports: Array[Dictionary] = []
    var checks: Array[Dictionary] = []
    bridge.hash_report_requested.connect(
        func(payload: Dictionary) -> void: reports.append(payload.duplicate(true))
    )
    bridge.hash_checked.connect(
        func(report: Dictionary) -> void: checks.append(report.duplicate(true))
    )

    bridge.hash_broadcast_interval_ticks = 60
    bridge.advance_to_time(0.0, 1, true)
    bridge.advance_to_time(1.0, 1, true)
    _assert_eq(bridge.get_tick(), 60, "shared playback time maps to the fixed physics tick")
    _assert_eq(reports.size(), 2, "hash reports are emitted at tick zero and interval")
    if reports.size() >= 2:
        _assert_eq(reports[1].get("tick"), 60, "interval report carries current tick")
        _assert_eq(
            reports[1].get("hash"),
            FREEFALL_HASHES[60],
            "interval report carries canonical hash"
        )

    var matching: Dictionary = bridge.verify_remote_hash({
        "kind": "scene-physics-hash",
        "profile": BRIDGE_SCRIPT.PROFILE,
        "hashVersion": BRIDGE_SCRIPT.HASH_VERSION,
        "rapierCoreVersion": BRIDGE_SCRIPT.RAPIER_CORE_VERSION,
        "tick": 60,
        "hash": FREEFALL_HASHES[60],
    }, {"id": "remote-a"})
    _assert_true(bool(matching.get("matched", false)), "matching remote canonical hash is accepted")
    _assert_eq(matching.get("fromId"), "remote-a", "hash report records sender id")

    var mismatch: Dictionary = bridge.verify_remote_hash({
        "kind": "scene-physics-hash",
        "tick": 60,
        "hash": "0000000000000000",
    })
    _assert_true(not bool(mismatch.get("matched", true)), "hash mismatch is detected")
    _assert_eq(checks.size(), 2, "remote hash checks emit public signal")

    var missing_tick: Dictionary = bridge.verify_remote_hash({"kind": "scene-physics-hash", "hash": "x"})
    _assert_eq(missing_tick.get("remoteTick"), -1, "missing remote tick stays invalid")

    body.position = Vector3(2.0, 8.0, 0.0)
    _assert_true(
        bridge.upsert_object("box-1", body, _freefall_physics(2.0), true),
        "physics metadata update rebuilds body definition"
    )
    bridge.advance_to_time(2.0, 1, true)
    _assert_eq(bridge.get_tick(), 0, "metadata update rebases fixed world at current shared time")
    _assert_true(bridge.is_body_registered("box-1"), "updated body remains registered")

    _assert_true(bridge.remove_object("box-1"), "object removal unregisters body")
    _assert_true(not bridge.is_body_registered("box-1"), "removed body is absent")
    _assert_true(not bridge.is_active(), "removing final body clears runtime")

    bridge.upsert_object("box-1", body, _freefall_physics(), true)
    bridge.clear_runtime(true)
    _assert_true(not bridge.is_body_registered("box-1"), "disconnect cleanup clears body bindings")
    _free_fixture(fixture)


func _test_room_time_mode_rebase() -> void:
    var fixture := _new_freefall_fixture()
    var bridge = fixture["bridge"]
    bridge.advance_to_time(0.0, 0, true)
    bridge.advance_to_time(1.0, 0, true)
    _assert_eq(bridge.get_tick(), 60, "Room Time fixture starts at one second")

    var room_state: Dictionary = bridge.advance_to_time(1700000000.0, 3, true)
    _assert_eq(bridge.get_tick(), 60, "Room Time mode transition does not target Unix-scale physics ticks")
    _assert_true(not bool(room_state.get("limited", true)), "Room Time transition rebases the Rapier world without catch-up limiting")
    _assert_true(
        is_equal_approx(
            float(room_state.get("targetTime", 0.0)) - float(room_state.get("worldEpochTime", 0.0)),
            1.0
        ),
        "Room Time transition preserves the simulated world age"
    )

    var local_state: Dictionary = bridge.advance_to_time(1.0, 0, true)
    _assert_eq(bridge.get_tick(), 60, "Room Time to Local keeps the current physics tick")
    _assert_true(
        is_equal_approx(
            float(local_state.get("targetTime", 0.0)) - float(local_state.get("worldEpochTime", 0.0)),
            1.0
        ),
        "Room Time to Local preserves the simulated world age"
    )

    bridge.advance_to_time(1700000000.0, 3, true)
    var control_state: Dictionary = bridge.advance_to_time(0.0, 2, true)
    _assert_eq(bridge.get_tick(), 0, "Room Time to Control resets the physics baseline")
    _assert_true(not bool(control_state.get("limited", true)), "Control acquisition rewinds without catch-up limiting")
    _free_fixture(fixture)


func _test_missing_addon_fallback() -> void:
    var bridge = BRIDGE_SCRIPT.new()
    root.add_child(bridge)
    bridge.world_class_name = &"SceneSyncRapierWorld3DUnavailableForTest"
    _assert_true(not bridge.refresh_availability(), "missing addon reports unavailable")
    bridge.set_scene_physics({"enabled": true, "worldOptions": {"ground": null}})
    var body := Node3D.new()
    root.add_child(body)
    bridge.upsert_object("fallback-body", body, _freefall_physics(), true)
    var state: Dictionary = bridge.advance_to_time(1.0, 0, true)
    _assert_true(not bool(state.get("active", true)), "missing addon leaves physics inactive")
    _assert_eq(state.get("reason"), "rapier-addon-unavailable", "fallback reason is explicit")
    _assert_true(body.position.is_equal_approx(Vector3.ZERO), "fallback does not mutate node transform")
    bridge.free()
    body.free()


func _new_freefall_fixture() -> Dictionary:
    var bridge = BRIDGE_SCRIPT.new()
    bridge.auto_run = true
    bridge.max_steps_per_update = 600
    root.add_child(bridge)
    bridge.set_scene_physics({
        "enabled": true,
        "worldOptions": {
            "gravity": [0.0, -9.81, 0.0],
            "timestep": TIMESTEP,
            "ground": null,
        },
    })
    var body := Node3D.new()
    body.position = Vector3(-0.75, 5.0, 0.0)
    root.add_child(body)
    _assert_true(bridge.upsert_object("box-1", body, _freefall_physics(), true), "freefall body registers")
    return {"bridge": bridge, "body": body}


func _freefall_physics(mass: float = 1.0) -> Dictionary:
    return {
        "enabled": true,
        "bodyType": "dynamic",
        "shape": "box",
        "halfExtents": [0.5, 0.5, 0.5],
        "mass": mass,
        "linearVelocity": [0.75, 0.0, 0.15],
        "angularVelocity": [0.35, 1.25, 0.55],
        "linearDamping": 0.02,
        "angularDamping": 0.02,
        "canSleep": false,
        "ccd": false,
        "friction": 0.5,
        "restitution": 0.2,
        "frictionCombineRule": 0,
        "restitutionCombineRule": 0,
    }


func _free_fixture(fixture: Dictionary) -> void:
    var bridge = fixture.get("bridge", null)
    var body = fixture.get("body", null)
    if bridge != null and is_instance_valid(bridge):
        bridge.free()
    if body != null and is_instance_valid(body):
        body.free()


func _assert_true(condition: bool, test_name: String) -> void:
    if condition:
        _passed += 1
    else:
        _failed += 1
        _errors.append(test_name)


func _assert_eq(actual: Variant, expected: Variant, test_name: String) -> void:
    _assert_true(actual == expected, "%s (expected=%s actual=%s)" % [test_name, expected, actual])


func _finish() -> void:
    print("\n=== SceneSync Rapier Bridge Tests ===")
    print("PASSED: %d" % _passed)
    print("FAILED: %d" % _failed)
    for error in _errors:
        print("  FAIL: %s" % error)
    quit(0 if _failed == 0 else 1)
