extends SceneTree

var _passed: int = 0
var _failed: int = 0
var _errors: Array[String] = []


func _init() -> void:
    _run_protocol_tests()
    _run_presence_client_tests()
    _run_blob_client_tests()
    _run_gltf_helper_tests()
    _run_manager_tests()
    _finish()


func _assert_eq(actual, expected, test_name: String) -> void:
    if actual == expected:
        _passed += 1
        print("  OK: %s" % test_name)
        return

    _failed += 1
    var msg := "%s: expected %s but got %s" % [test_name, str(expected), str(actual)]
    _errors.append(msg)
    print("  FAIL: %s" % msg)


func _assert_true(condition: bool, test_name: String) -> void:
    _assert_eq(condition, true, test_name)


func _assert_not_empty(value, test_name: String) -> void:
    var is_empty := value == null
    if value is String:
        is_empty = value == ""
    elif value is Array:
        is_empty = value.is_empty()
    elif value is PackedByteArray:
        is_empty = value.is_empty()

    if is_empty:
        _failed += 1
        var msg := "%s: value was empty/null" % test_name
        _errors.append(msg)
        print("  FAIL: %s" % msg)
        return

    _passed += 1
    print("  OK: %s" % test_name)


func _run_protocol_tests() -> void:
    print("\n--- SceneSyncProtocol Tests ---")

    var wire = SceneSyncProtocol.pos_to_wire(Vector3(1.0, 2.0, 3.0))
    _assert_eq(wire, [1.0, 2.0, 3.0], "pos_to_wire basic")

    var pos = SceneSyncProtocol.pos_from_wire([4.0, 5.0, 6.0])
    _assert_eq(pos, Vector3(4.0, 5.0, 6.0), "pos_from_wire basic")

    var q = Quaternion(0.1, 0.2, 0.3, 0.9).normalized()
    var q_wire = SceneSyncProtocol.rot_to_wire(q)
    var q_back = SceneSyncProtocol.rot_from_wire(q_wire)
    _assert_true(q.is_equal_approx(q_back), "rot roundtrip")

    var delta = SceneSyncProtocol.make_scene_delta(
        "obj-1",
        Vector3(1, 2, 3),
        Quaternion.IDENTITY,
        Vector3.ONE
    )
    _assert_eq(delta["kind"], "scene-delta", "make_scene_delta kind")
    _assert_eq(delta["objectId"], "obj-1", "make_scene_delta objectId")

    var add = SceneSyncProtocol.make_scene_add(
        "obj-2",
        "Cube",
        Vector3.ZERO,
        Quaternion.IDENTITY,
        Vector3.ONE,
        "abc123"
    )
    _assert_eq(add["kind"], "scene-add", "make_scene_add kind")
    _assert_eq(add["meshPath"], "abc123", "make_scene_add meshPath")

    var add2 = SceneSyncProtocol.make_scene_add(
        "obj-3",
        "Sphere",
        Vector3.ZERO,
        Quaternion.IDENTITY,
        Vector3.ONE
    )
    _assert_true(not add2.has("meshPath"), "make_scene_add no meshPath")

    var rm = SceneSyncProtocol.make_scene_remove("obj-1")
    _assert_eq(rm["kind"], "scene-remove", "make_scene_remove kind")

    var payload = {
        "position": [1.0, 2.0, 3.0],
        "rotation": [0.0, 0.0, 0.0, 1.0],
        "scale": [2.0, 2.0, 2.0]
    }
    var xform = SceneSyncProtocol.extract_transform(payload)
    _assert_eq(xform["position"], Vector3(1, 2, 3), "extract_transform pos")
    _assert_eq(xform["scale"], Vector3(2, 2, 2), "extract_transform scale")

    var json_str = JSON.stringify(delta)
    _assert_true(json_str.find("scene-delta") != -1, "JSON stringify scene-delta")


func _run_presence_client_tests() -> void:
    print("\n--- SceneSyncPresenceClient Tests ---")

    var client = SceneSyncPresenceClient.new()
    _assert_true(client != null, "client instantiation")
    _assert_eq(client.id, "", "client initial id empty")
    _assert_eq(client.room, "", "client initial room empty")


func _run_blob_client_tests() -> void:
    print("\n--- SceneSyncBlobClient Tests ---")

    var path1 = SceneSyncBlobClient.generate_random_path()
    var path2 = SceneSyncBlobClient.generate_random_path()
    _assert_true(path1.length() == 8, "random_path length 8")
    _assert_true(path1 != path2, "random_path unique")


func _run_gltf_helper_tests() -> void:
    print("\n--- SceneSyncGltfHelper Tests ---")

    var mesh_instance := MeshInstance3D.new()
    mesh_instance.mesh = BoxMesh.new()
    root.add_child(mesh_instance)

    var glb_data = SceneSyncGltfHelper.export_glb(mesh_instance)
    _assert_true(glb_data.size() > 0, "export_glb produces bytes")

    if glb_data.size() >= 4:
        var magic = glb_data.decode_u32(0)
        _assert_eq(magic, 0x46546C67, "glB magic bytes")

    var imported = SceneSyncGltfHelper.import_glb(glb_data)
    _assert_true(imported != null, "import_glb returns Node3D")
    if imported != null:
        _assert_true(imported is Node3D, "import_glb type is Node3D")
        imported.queue_free()

    mesh_instance.queue_free()

    var empty_result = SceneSyncGltfHelper.import_glb(PackedByteArray())
    _assert_true(empty_result == null, "import_glb empty returns null")


func _run_manager_tests() -> void:
    print("\n--- SceneSyncManager Tests ---")

    var manager := SceneSyncManager.new()
    manager.auto_connect = false
    manager.room = "test-headless"
    manager.nickname = "HeadlessTest"
    root.add_child(manager)

    _assert_true(manager != null, "manager instantiation")
    _assert_eq(manager.room, "test-headless", "manager room")
    _assert_eq(manager.nickname, "HeadlessTest", "manager nickname")

    manager.queue_free()


func _finish() -> void:
    print("")
    print("========================================")
    print("  PASSED: %d  FAILED: %d" % [_passed, _failed])
    print("========================================")
    for err in _errors:
        print("  FAIL: %s" % err)
    print("")
    quit(0 if _failed == 0 else 1)
