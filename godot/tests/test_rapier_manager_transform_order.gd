extends SceneTree

const FIXTURE_PATH := "res://tests/fixtures/domino_physics_issue_504.json"
const TIMESTEP := 1.0 / 60.0

var _passed := 0
var _failed := 0
var _errors: Array[String] = []


func _init() -> void:
    call_deferred("_run")


func _run() -> void:
    _test_scene_add_and_delta_transform_order()
    _test_published_domino_fixture()
    _finish()


func _test_scene_add_and_delta_transform_order() -> void:
    var fixture := _new_manager_fixture()
    var manager := fixture["manager"] as SceneSyncManager
    var bridge = manager.get_rapier_bridge()
    var physics_change_count := [0]
    manager.object_physics_changed.connect(
        func(object_id: String, _node: Node3D, _physics: Dictionary) -> void:
            if object_id == "order-ramp":
                physics_change_count[0] += 1
    )

    var ramp_position := Vector3(-3.05, 1.18, 0.0)
    var ramp_rotation := Quaternion(0.0, 0.0, -0.13917310096006544, 0.9902680687415704)
    var ramp_scale := Vector3(4.4, 0.18, 1.1)
    var ramp_physics := {
        "enabled": true,
        "bodyType": "static",
        "shape": "box",
        "halfExtents": [2.2, 0.09, 0.55],
        "friction": 0.72,
    }
    manager._handle_scene_add(_object_payload(
        "order-ramp", "Ramp", "box", ramp_position, ramp_rotation, ramp_scale, ramp_physics
    ))

    var definition: Dictionary = bridge._body_definitions.get("order-ramp", {})
    _assert_vec3(definition.get("position", Vector3.ZERO), ramp_position, "scene-add registers received position")
    _assert_quaternion(
        definition.get("rotation", Quaternion.IDENTITY),
        ramp_rotation,
        "scene-add registers received rotation"
    )
    _assert_vec3(
        definition.get("halfExtents", Vector3.ZERO),
        Vector3(2.2, 0.09, 0.55),
        "scene-add keeps explicit half extents unscaled"
    )
    _assert_eq(physics_change_count[0], 1, "scene-add emits one final physics definition")
    var ramp_node := manager._managed_objects["order-ramp"] as Node3D
    _assert_true(
        ramp_node.transform.basis.is_equal_approx(Basis(ramp_rotation).scaled_local(ramp_scale)),
        "scene-add visual transform matches collider transform"
    )
    _assert_basis_orthogonal(ramp_node.transform.basis, "scene-add rotated non-uniform scale stays orthogonal")

    var readd_position := Vector3(-2.75, 1.35, 0.1)
    var readd_rotation := Quaternion(Vector3.FORWARD, deg_to_rad(-12.0))
    manager._handle_scene_add(_object_payload(
        "order-ramp", "Ramp", "box", readd_position, readd_rotation, ramp_scale, ramp_physics
    ))
    definition = bridge._body_definitions.get("order-ramp", {})
    _assert_vec3(definition.get("position", Vector3.ZERO), readd_position, "existing scene-add refreshes final position")
    _assert_quaternion(
        definition.get("rotation", Quaternion.IDENTITY),
        readd_rotation,
        "existing scene-add refreshes final rotation"
    )
    _assert_eq(physics_change_count[0], 2, "existing scene-add emits one refreshed definition")

    var delta_position := Vector3(-2.4, 1.5, -0.2)
    var delta_rotation := Quaternion(Vector3.FORWARD, deg_to_rad(-8.0))
    manager._handle_scene_delta({
        "kind": "scene-delta",
        "objectId": "order-ramp",
        "position": SceneSyncProtocol.pos_to_wire(delta_position),
        "rotation": SceneSyncProtocol.rot_to_wire(delta_rotation),
        "scale": SceneSyncProtocol.scale_to_wire(ramp_scale),
        "physics": ramp_physics.duplicate(true),
    })
    definition = bridge._body_definitions.get("order-ramp", {})
    _assert_vec3(definition.get("position", Vector3.ZERO), delta_position, "scene-delta registers final position")
    _assert_quaternion(
        definition.get("rotation", Quaternion.IDENTITY),
        delta_rotation,
        "scene-delta registers final rotation"
    )
    _assert_eq(physics_change_count[0], 3, "scene-delta emits one final physics definition")
    _assert_basis_orthogonal(ramp_node.transform.basis, "scene-delta rotated non-uniform scale stays orthogonal")

    var replacement_position := Vector3(-2.0, 1.75, 0.25)
    var replacement_rotation := Quaternion(Vector3.UP, deg_to_rad(20.0))
    manager._replace_object_with_mesh_data(
        "order-ramp",
        _object_payload(
            "order-ramp", "RampReplacement", "box",
            replacement_position, replacement_rotation, ramp_scale, ramp_physics
        ),
        PackedByteArray()
    )
    definition = bridge._body_definitions.get("order-ramp", {})
    _assert_vec3(
        definition.get("position", Vector3.ZERO),
        replacement_position,
        "async mesh replacement registers final position"
    )
    _assert_quaternion(
        definition.get("rotation", Quaternion.IDENTITY),
        replacement_rotation,
        "async mesh replacement registers final rotation"
    )
    _assert_eq(physics_change_count[0], 4, "async mesh replacement emits one final definition")

    var explicit_position := Vector3(1.0, 2.0, 3.0)
    var explicit_rotation := Quaternion(Vector3.UP, deg_to_rad(35.0))
    var explicit_physics := {
        "enabled": true,
        "bodyType": "static",
        "shape": "box",
        "halfExtents": [0.25, 0.5, 0.75],
        "initialTransform": {
            "position": SceneSyncProtocol.pos_to_wire(explicit_position),
            "rotation": SceneSyncProtocol.rot_to_wire(explicit_rotation),
            "scale": SceneSyncProtocol.scale_to_wire(Vector3.ONE),
        },
    }
    manager._handle_scene_add(_object_payload(
        "explicit-transform", "Explicit", "box",
        Vector3(9.0, 8.0, 7.0), Quaternion.IDENTITY, Vector3(3.0, 4.0, 5.0), explicit_physics
    ))
    definition = bridge._body_definitions.get("explicit-transform", {})
    _assert_vec3(
        definition.get("position", Vector3.ZERO),
        explicit_position,
        "explicit initialTransform position takes precedence"
    )
    _assert_quaternion(
        definition.get("rotation", Quaternion.IDENTITY),
        explicit_rotation,
        "explicit initialTransform rotation takes precedence"
    )
    _assert_vec3(
        definition.get("halfExtents", Vector3.ZERO),
        Vector3(0.25, 0.5, 0.75),
        "explicit initialTransform does not rescale half extents"
    )

    manager._handle_scene_add(_object_payload(
        "explicit-radius", "Sphere", "sphere",
        Vector3(2.0, 3.0, 4.0), Quaternion.IDENTITY, Vector3(6.0, 6.0, 6.0),
        {"enabled": true, "bodyType": "dynamic", "shape": "sphere", "radius": 0.28}
    ))
    definition = bridge._body_definitions.get("explicit-radius", {})
    _assert_true(
        is_equal_approx(float(definition.get("radius", 0.0)), 0.28),
        "explicit radius is not multiplied by visual scale"
    )
    _free_manager_fixture(fixture)


func _test_published_domino_fixture() -> void:
    var fixture_value = JSON.parse_string(FileAccess.get_file_as_string(FIXTURE_PATH))
    _assert_true(fixture_value is Dictionary, "published domino fixture parses")
    if not (fixture_value is Dictionary):
        return
    var domino_fixture := fixture_value as Dictionary
    _assert_eq(
        domino_fixture.get("sourceSha256", ""),
        "b0bb9a504e15b04d32fe9752a480f5c8fe835762fd48fb5bac541683f3cfcde0",
        "published domino fixture records source hash"
    )

    var fixture := _new_manager_fixture(domino_fixture.get("physics", {}))
    var manager := fixture["manager"] as SceneSyncManager
    var objects_value = domino_fixture.get("objects", [])
    _assert_true(objects_value is Array, "published domino fixture contains objects")
    if not (objects_value is Array):
        _free_manager_fixture(fixture)
        return
    for object_value in objects_value:
        if not (object_value is Dictionary):
            continue
        var payload := (object_value as Dictionary).duplicate(true)
        payload["objectId"] = str(payload.get("id", ""))
        payload.erase("id")
        manager._handle_scene_add(payload)

    var bridge = manager.get_rapier_bridge()
    _assert_eq(bridge._body_definitions.size(), 21, "published domino payload registers all physics bodies")
    var ramp_definition: Dictionary = bridge._body_definitions.get("ramp", {})
    _assert_vec3(
        ramp_definition.get("position", Vector3.ZERO),
        Vector3(-3.05, 1.18, 0.0),
        "published ramp collider uses received position"
    )
    _assert_quaternion(
        ramp_definition.get("rotation", Quaternion.IDENTITY),
        Quaternion(0.0, 0.0, -0.13917310096006544, 0.9902680687415704),
        "published ramp collider uses received rotation"
    )

    var domino_node := manager._managed_objects["domino-01"] as Node3D
    var initial_domino_position := domino_node.position
    var initial_domino_rotation := domino_node.quaternion
    bridge.advance_to_time(0.0, SceneSyncPlaybackClock.LOCAL, true)
    var tick_60_state: Dictionary = bridge.advance_to_time(60.0 * TIMESTEP, SceneSyncPlaybackClock.LOCAL, true)
    _assert_true(bool(tick_60_state.get("active", false)), "published domino simulation is active")
    _assert_eq(bridge.get_tick(), 60, "published domino simulation reaches tick 60")
    var ball_node := manager._managed_objects["ball"] as Node3D
    _assert_vec3(
        ball_node.position,
        Vector3(-2.856352, 1.506579, 0.0),
        "published ball rolls along the visible ramp at tick 60"
    )

    bridge.advance_to_time(120.0 * TIMESTEP, SceneSyncPlaybackClock.LOCAL, true)
    _assert_true(
        not domino_node.position.is_equal_approx(initial_domino_position)
        or not domino_node.quaternion.is_equal_approx(initial_domino_rotation),
        "published ball moves or rotates domino 01 by tick 120"
    )
    bridge.advance_to_time(480.0 * TIMESTEP, SceneSyncPlaybackClock.LOCAL, true)
    _assert_eq(bridge.get_tick(), 480, "published domino simulation reaches tick 480")
    _assert_true(bridge.get_canonical_state_hash() != "", "published domino simulation exposes a final hash")
    _free_manager_fixture(fixture)


func _new_manager_fixture(scene_physics: Variant = null) -> Dictionary:
    var manager := SceneSyncManager.new()
    manager.auto_connect = false
    var sync_root := Node3D.new()
    root.add_child(sync_root)
    manager.sync_root = sync_root
    root.add_child(manager)
    var physics: Variant = scene_physics
    if not (physics is Dictionary):
        physics = {
            "enabled": true,
            "worldOptions": {
                "gravity": -9.81,
                "ground": null,
                "timestep": TIMESTEP,
            },
        }
    manager._apply_scene_physics_payload({"physics": (physics as Dictionary).duplicate(true)}, true)
    return {"manager": manager, "syncRoot": sync_root}


func _free_manager_fixture(fixture: Dictionary) -> void:
    var manager = fixture.get("manager", null)
    var sync_root = fixture.get("syncRoot", null)
    if manager != null and is_instance_valid(manager):
        manager.free()
    if sync_root != null and is_instance_valid(sync_root):
        sync_root.free()


func _object_payload(
    object_id: String,
    object_name: String,
    primitive: String,
    position: Vector3,
    rotation: Quaternion,
    scale: Vector3,
    physics: Dictionary
) -> Dictionary:
    return {
        "kind": "scene-add",
        "objectId": object_id,
        "name": object_name,
        "position": SceneSyncProtocol.pos_to_wire(position),
        "rotation": SceneSyncProtocol.rot_to_wire(rotation),
        "scale": SceneSyncProtocol.scale_to_wire(scale),
        "asset": {"type": "primitive", "primitive": primitive},
        "physics": physics.duplicate(true),
    }


func _assert_vec3(actual: Variant, expected: Vector3, test_name: String) -> void:
    _assert_true(actual is Vector3 and (actual as Vector3).is_equal_approx(expected), test_name)


func _assert_quaternion(actual: Variant, expected: Quaternion, test_name: String) -> void:
    _assert_true(actual is Quaternion and (actual as Quaternion).is_equal_approx(expected), test_name)


func _assert_basis_orthogonal(basis: Basis, test_name: String) -> void:
    var x := basis.x.normalized()
    var y := basis.y.normalized()
    var z := basis.z.normalized()
    _assert_true(
        absf(x.dot(y)) < 0.00001 and absf(x.dot(z)) < 0.00001 and absf(y.dot(z)) < 0.00001,
        test_name
    )


func _assert_true(condition: bool, test_name: String) -> void:
    if condition:
        _passed += 1
    else:
        _failed += 1
        _errors.append(test_name)


func _assert_eq(actual: Variant, expected: Variant, test_name: String) -> void:
    _assert_true(actual == expected, "%s (expected=%s actual=%s)" % [test_name, expected, actual])


func _finish() -> void:
    print("\n=== SceneSync Rapier Manager Transform Order Tests ===")
    print("PASSED: %d" % _passed)
    print("FAILED: %d" % _failed)
    for error in _errors:
        print("  FAIL: %s" % error)
    quit(0 if _failed == 0 else 1)
