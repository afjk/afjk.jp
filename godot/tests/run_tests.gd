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

    var delta_with_metadata = SceneSyncProtocol.make_scene_delta(
        "obj-1",
        Vector3(1, 2, 3),
        Quaternion.IDENTITY,
        Vector3.ONE,
        "Renamed",
        false,
        {"type": "primitive", "primitive": "sphere", "color": "#ff0000"},
        {"loomGraph": {"nodes": []}}
    )
    _assert_eq(delta_with_metadata["name"], "Renamed", "make_scene_delta name metadata")
    _assert_eq(delta_with_metadata["visible"], false, "make_scene_delta visible metadata")
    _assert_eq(delta_with_metadata["asset"]["primitive"], "sphere", "make_scene_delta asset metadata")
    _assert_true(delta_with_metadata["metadata"].has("loomGraph"), "make_scene_delta loomGraph metadata")

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

    var add_with_wire_metadata = SceneSyncProtocol.make_scene_add(
        "obj-4",
        "UnityCube",
        Vector3.ZERO,
        Quaternion.IDENTITY,
        Vector3.ONE,
        "mesh-path",
        {
            "type": "mesh",
            "source": "unity",
            "meshPath": "mesh-path",
            "visualBasis": "unity",
        },
        "asset-1",
        {"tags": ["unity"]},
        "unity",
        "SceneRoot/UnityCube",
        false
    )
    _assert_eq(add_with_wire_metadata["origin"], "unity", "make_scene_add origin")
    _assert_eq(add_with_wire_metadata["unityHierarchyPath"], "SceneRoot/UnityCube", "make_scene_add hierarchy path")
    _assert_eq(add_with_wire_metadata["assetId"], "asset-1", "make_scene_add assetId")
    _assert_eq(add_with_wire_metadata["asset"]["visualBasis"], "unity", "make_scene_add visualBasis")
    _assert_eq(add_with_wire_metadata["visible"], false, "make_scene_add visible")

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

    var mesh = SceneSyncProtocol.make_scene_mesh(
        "obj-4",
        "mesh-path",
        "asset-1",
        {"type": "mesh", "meshPath": "mesh-path", "visualBasis": "unity"},
        {"tags": ["unity"]},
        "unity",
        "SceneRoot/UnityCube"
    )
    _assert_eq(mesh["kind"], "scene-mesh", "make_scene_mesh kind")
    _assert_eq(mesh["assetId"], "asset-1", "make_scene_mesh assetId")
    _assert_eq(mesh["asset"]["visualBasis"], "unity", "make_scene_mesh visualBasis")

    var state = SceneSyncProtocol.make_scene_state(
        {"obj-4": add_with_wire_metadata},
        {"objects": {"obj-4": {"nodes": []}}},
        "outdoor_night"
    )
    _assert_true(state.has("loomGraphs"), "make_scene_state loomGraphs")
    _assert_eq(state["envId"], "outdoor_night", "make_scene_state envId")

    var env = SceneSyncProtocol.make_scene_env("studio")
    _assert_eq(env["kind"], "scene-env", "make_scene_env kind")
    _assert_eq(env["envId"], "studio", "make_scene_env envId")

    var batch = SceneSyncProtocol.make_scene_batch([delta, mesh])
    _assert_eq(batch["kind"], "scene-batch", "make_scene_batch kind")
    _assert_eq(batch["ops"].size(), 2, "make_scene_batch ops")

    var graph := {"version": "loomlet.graph.v1", "nodes": [], "edges": []}
    var graph_set = SceneSyncProtocol.make_scene_graph_set(graph, "obj-4")
    _assert_eq(graph_set["kind"], "scene-graph-set", "make_scene_graph_set kind")
    _assert_eq(graph_set["scope"], "object", "make_scene_graph_set object scope")
    _assert_eq(graph_set["objectId"], "obj-4", "make_scene_graph_set objectId")

    var graph_clear = SceneSyncProtocol.make_scene_graph_clear("obj-4")
    _assert_eq(graph_clear["kind"], "scene-graph-clear", "make_scene_graph_clear kind")
    _assert_eq(graph_clear["scope"], "object", "make_scene_graph_clear object scope")

    var asset_request = SceneSyncProtocol.make_scene_asset_request("req-1", "obj-4", "asset-1", "mesh-path", 1234)
    _assert_eq(asset_request["kind"], "scene-asset-request", "make_scene_asset_request kind")
    _assert_eq(asset_request["assetId"], "asset-1", "make_scene_asset_request assetId")

    var file_handoff = SceneSyncProtocol.make_file_handoff("pipe-path", "asset-1.glb", 1234, "model/gltf-binary", "https://example.test/#pipe-path")
    _assert_eq(file_handoff["kind"], "file", "make_file_handoff kind")
    _assert_eq(file_handoff["mime"], "model/gltf-binary", "make_file_handoff mime")

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
    _assert_eq(
        SceneSyncBlobClient.compute_asset_id(PackedByteArray([1, 2, 3, 4])),
        "sha256-9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
        "compute_asset_id sha256"
    )


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
    var sync_root := Node3D.new()
    root.add_child(sync_root)
    manager.sync_root = sync_root
    root.add_child(manager)

    _assert_true(manager != null, "manager instantiation")
    _assert_eq(manager.room, "test-headless", "manager room")
    _assert_eq(manager.nickname, "HeadlessTest", "manager nickname")

    var graph := {"version": "loomlet.graph.v1", "nodes": [], "edges": []}
    manager._dispatch_scene_payload({
        "type": "scene-graph-set",
        "scope": "object",
        "objectId": "obj-1",
        "graph": graph,
    }, {})
    _assert_true(manager._loom_graphs["objects"].has("obj-1"), "manager stores object graph from type payload")

    manager._dispatch_scene_payload({
        "kind": "scene-graph-clear",
        "scope": "object",
        "objectId": "obj-1",
    }, {})
    _assert_true(not manager._loom_graphs.has("objects"), "manager clears object graph")

    manager._dispatch_scene_payload({
        "kind": "scene-batch",
        "ops": [{"kind": "scene-env", "envId": "ops-env"}],
        "actions": [{"kind": "scene-env", "envId": "actions-env"}],
    }, {})
    _assert_eq(manager._env_id, "ops-env", "manager scene-batch prefers ops over actions")

    manager._handle_scene_state({
        "kind": "scene-state",
        "objects": {},
        "envId": "outdoor_night",
        "loomGraphs": {"scene": graph},
    })
    _assert_true(manager._loom_graphs.has("scene"), "manager preserves scene-state loomGraphs")
    _assert_eq(manager._env_id, "outdoor_night", "manager preserves scene-state envId")

    var bytes := PackedByteArray([1, 2, 3, 4])
    manager._cache_mesh_data("mesh-path", "asset-1", bytes)
    _assert_eq(manager._get_cached_mesh_data("", "asset-1"), bytes, "manager cache lookup by assetId")
    _assert_eq(manager._get_cached_mesh_data("mesh-path", ""), bytes, "manager cache lookup by meshPath")
    _assert_eq(manager._get_piping_server_base(), "https://pipe.afjk.jp", "manager piping base default")

    manager._pending_recoveries["req-1"] = {
        "requestId": "req-1",
        "objectId": "obj-1",
        "assetId": "asset-1",
        "meshPath": "mesh-path",
        "expectedSize": 4,
        "requestedPeerIds": {"peer-1": true},
    }
    _assert_true(
        manager._can_accept_file_handoff("peer-1", "asset-1.glb", 4, "model/gltf-binary"),
        "manager accepts matching recovery file handoff"
    )
    _assert_true(
        not manager._can_accept_file_handoff("peer-2", "asset-1.glb", 4, "model/gltf-binary"),
        "manager rejects unrequested recovery file handoff"
    )

    var imported := Node3D.new()
    var wrapped = manager._wrap_imported_mesh_for_visual_basis(imported, "unity")
    _assert_true(wrapped != imported, "manager wraps unity visualBasis mesh")
    _assert_eq(wrapped.get_child_count(), 1, "manager wrapped mesh child count")
    var visual_root := wrapped.get_child(0) as Node3D
    _assert_true(is_equal_approx(visual_root.rotation.y, PI), "manager unity visualBasis yaw correction")

    var existing := Node3D.new()
    existing.name = "UnityCube"
    sync_root.add_child(existing)
    var resolved = manager._resolve_existing_sync_target_for_payload("obj-2", {"name": "UnityCube"})
    _assert_eq(resolved, existing, "manager resolves existing node by unique name")

    var mesh_existing := Node3D.new()
    mesh_existing.name = "MeshTarget"
    sync_root.add_child(mesh_existing)
    var mesh_child := MeshInstance3D.new()
    mesh_child.mesh = BoxMesh.new()
    var mesh_bytes = SceneSyncGltfHelper.export_glb(mesh_child)
    mesh_child.free()
    _assert_true(mesh_bytes.size() > 0, "manager scene-mesh rebind test data")
    manager._cache_mesh_data("mesh-rebind", "asset-rebind", mesh_bytes)
    manager._handle_scene_mesh({
        "kind": "scene-mesh",
        "objectId": "obj-mesh-rebind",
        "name": "MeshTarget",
        "meshPath": "mesh-rebind",
        "assetId": "asset-rebind",
        "asset": {
            "type": "mesh",
            "meshPath": "mesh-rebind",
            "assetId": "asset-rebind",
        },
    })
    _assert_true(manager._managed_objects.has("obj-mesh-rebind"), "manager scene-mesh rebind tracks object")
    _assert_true(manager._mesh_paths.has("obj-mesh-rebind"), "manager scene-mesh rebind stores meshPath")
    _assert_true(manager._managed_objects["obj-mesh-rebind"] != mesh_existing, "manager scene-mesh rebind loads replacement mesh")

    var publish_root := Node3D.new()
    root.add_child(publish_root)
    manager.sync_root = publish_root

    var publish_target := Node3D.new()
    publish_target.name = "PublishTarget"
    publish_root.add_child(publish_target)
    var publish_mesh := MeshInstance3D.new()
    publish_mesh.mesh = BoxMesh.new()
    publish_target.add_child(publish_mesh)

    var publish_status := manager.get_publish_candidate_status(publish_target)
    _assert_true(bool(publish_status.get("publishable", false)), "manager publish candidate with descendant mesh")

    var empty_target := Node3D.new()
    empty_target.name = "EmptyPublishTarget"
    publish_root.add_child(empty_target)
    var empty_status := manager.get_publish_candidate_status(empty_target)
    _assert_eq(empty_status.get("reason", ""), "no mesh found in this node or children", "manager publish candidate skips meshless Node3D")

    var plain_node := Node.new()
    plain_node.name = "PlainNode"
    var plain_status := manager.get_publish_candidate_status(plain_node)
    _assert_eq(plain_status.get("reason", ""), "selected node is not Node3D", "manager publish candidate skips non Node3D")
    plain_node.free()

    var reusable_scene := Node3D.new()
    root.add_child(reusable_scene)
    var reusable_root := Node3D.new()
    reusable_root.name = "SceneSyncRoot"
    reusable_scene.add_child(reusable_root)
    var create_result := manager.create_scene_sync_root(reusable_scene)
    _assert_eq(create_result.get("root", null), reusable_root, "manager create SceneSyncRoot reuses existing root")

    manager.sync_root = publish_root
    var children_status := manager.get_publish_children_status()
    _assert_eq(children_status.get("published", 0), 1, "manager publish children counts publishable nodes")
    _assert_eq(children_status.get("skipped", 0), 1, "manager publish children counts skipped nodes")

    reusable_scene.free()
    publish_root.free()
    wrapped.free()
    manager.free()
    sync_root.free()


func _finish() -> void:
    print("")
    print("========================================")
    print("  PASSED: %d  FAILED: %d" % [_passed, _failed])
    print("========================================")
    for err in _errors:
        print("  FAIL: %s" % err)
    print("")
    quit(0 if _failed == 0 else 1)
