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


func _assert_basis_orthogonal(basis: Basis, test_name: String) -> void:
    var x := basis.x.normalized()
    var y := basis.y.normalized()
    var z := basis.z.normalized()
    _assert_true(
        absf(x.dot(y)) < 0.00001
            and absf(x.dot(z)) < 0.00001
            and absf(y.dot(z)) < 0.00001,
        test_name
    )


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


func _make_animation_order_glb(names: Array[String]) -> PackedByteArray:
    var animations: Array[Dictionary] = []
    for animation_name in names:
        animations.append({"name": animation_name, "channels": [], "samplers": []})
    var document := {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": "Root"}],
        "animations": animations,
    }
    var json_bytes := JSON.stringify(document).to_utf8_buffer()
    while json_bytes.size() % 4 != 0:
        json_bytes.append(0x20)

    var result := PackedByteArray()
    result.resize(20 + json_bytes.size())
    result.encode_u32(0, 0x46546C67)
    result.encode_u32(4, 2)
    result.encode_u32(8, result.size())
    result.encode_u32(12, json_bytes.size())
    result.encode_u32(16, 0x4E4F534A)
    for index in range(json_bytes.size()):
        result[20 + index] = json_bytes[index]
    return result


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

    var animation_policy := {
        "enabled": true,
        "clipName": "Survey",
        "mode": "loop",
        "speed": 0.75,
        "offset": 1.25,
    }
    var delta_with_animation = SceneSyncProtocol.make_scene_delta(
        "obj-anim",
        Vector3.ZERO,
        Quaternion.IDENTITY,
        Vector3.ONE,
        "",
        null,
        {},
        {},
        animation_policy
    )
    _assert_eq(delta_with_animation["animation"]["clipName"], "Survey", "make_scene_delta animation")
    var delta_clear_animation = SceneSyncProtocol.make_scene_delta(
        "obj-anim", Vector3.ZERO, Quaternion.IDENTITY, Vector3.ONE,
        "", null, {}, {}, null, null, false, true
    )
    _assert_true(
        delta_clear_animation.has("animation") and delta_clear_animation["animation"] == null,
        "make_scene_delta animation null"
    )
    var delta_with_physics = SceneSyncProtocol.make_scene_delta(
        "obj-physics", Vector3.ZERO, Quaternion.IDENTITY, Vector3.ONE,
        "", null, {}, {}, null, {"bodyType": "dynamic"}, true
    )
    _assert_eq(delta_with_physics["physics"]["bodyType"], "dynamic", "make_scene_delta physics")
    var delta_clear_physics = SceneSyncProtocol.make_scene_delta(
        "obj-physics", Vector3.ZERO, Quaternion.IDENTITY, Vector3.ONE,
        "", null, {}, {}, null, null, true
    )
    _assert_true(delta_clear_physics.has("physics") and delta_clear_physics["physics"] == null, "make_scene_delta physics null")

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

    var add_with_animation = SceneSyncProtocol.make_scene_add(
        "obj-anim",
        "Fox",
        Vector3.ZERO,
        Quaternion.IDENTITY,
        Vector3.ONE,
        "mesh-path",
        {"type": "mesh", "meshPath": "mesh-path"},
        "asset-anim",
        {},
        "",
        "",
        true,
        animation_policy
    )
    _assert_eq(add_with_animation["animation"]["offset"], 1.25, "make_scene_add animation")
    var add_with_physics = SceneSyncProtocol.make_scene_add(
        "obj-physics", "Body", Vector3.ZERO, Quaternion.IDENTITY, Vector3.ONE,
        "", {}, "", {}, "", "", true, null, {"shape": "box"}, true
    )
    _assert_eq(add_with_physics["physics"]["shape"], "box", "make_scene_add physics")

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

    var mesh_with_animation = SceneSyncProtocol.make_scene_mesh(
        "obj-anim",
        "mesh-path",
        "asset-anim",
        {"type": "mesh", "meshPath": "mesh-path"},
        {},
        "",
        "",
        animation_policy
    )
    _assert_eq(mesh_with_animation["animation"]["mode"], "loop", "make_scene_mesh animation")
    var mesh_with_physics = SceneSyncProtocol.make_scene_mesh(
        "obj-physics", "mesh-path", "", {}, {}, "", "", null, {"mass": 2.0}, true
    )
    _assert_eq(mesh_with_physics["physics"]["mass"], 2.0, "make_scene_mesh physics")

    var state = SceneSyncProtocol.make_scene_state(
        {"obj-4": add_with_wire_metadata},
        {"objects": {"obj-4": {"nodes": []}}},
        "outdoor_night"
    )
    _assert_true(state.has("loomGraphs"), "make_scene_state loomGraphs")
    _assert_eq(state["envId"], "outdoor_night", "make_scene_state envId")
    var state_with_physics = SceneSyncProtocol.make_scene_state({}, {}, "", {"gravity": [0, -9.8, 0]}, true)
    _assert_true(state_with_physics.has("physics"), "make_scene_state physics")
    var scene_physics_clear = SceneSyncProtocol.make_scene_physics(null, true)
    _assert_true(scene_physics_clear.has("physics") and scene_physics_clear["physics"] == null, "make_scene_physics null")

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
    var received_server_time := [0.0]
    client.server_time_received.connect(
        func(value: float, _received_monotonic: float) -> void: received_server_time[0] = value
    )
    client._handle_message(JSON.stringify({
        "type": "welcome", "id": "client-1", "room": "room-1", "serverTime": 1700000000123.0,
    }))
    _assert_eq(client.server_time_msec, 1700000000123.0, "welcome stores serverTime")
    _assert_eq(received_server_time[0], 1700000000123.0, "welcome emits server time anchor")


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

    var source_order := ["Zulu", "Alpha", "Middle"] as Array[String]
    var ordered_import := SceneSyncGltfHelper.import_glb(_make_animation_order_glb(source_order))
    _assert_true(ordered_import != null, "import_glb ordered animations returns Node3D")
    if ordered_import != null:
        root.add_child(ordered_import)
        _assert_eq(
            ordered_import.get_meta(SceneSyncAnimationPolicy.CLIP_ORDER_META, []),
            source_order,
            "import_glb preserves source animation order metadata"
        )
        var first_clip := SceneSyncAnimationPolicy.apply(ordered_import, {"clip": 0})
        _assert_eq(first_clip["clipName"], "Zulu", "animation clip index zero uses GLB source order")
        var second_clip := SceneSyncAnimationPolicy.apply(ordered_import, {"clip": 1})
        _assert_eq(second_clip["clipName"], "Alpha", "animation clip index one uses GLB source order")
        var named_clip := SceneSyncAnimationPolicy.apply(ordered_import, {
            "clip": 0,
            "clipName": "Middle",
        })
        _assert_eq(named_clip["clipName"], "Middle", "animation clipName still takes precedence")
        ordered_import.free()


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
    _assert_true(manager.get_rapier_status()["available"], "manager detects vendored Rapier extension")

    _assert_eq(
        manager._visual_basis_from_payload({"asset": {"type": "mesh", "visualBasis": null}}),
        "",
        "manager nullable visualBasis"
    )
    _assert_eq(
        manager._asset_id_from_payload({"assetId": null, "asset": {"assetId": null}}),
        "",
        "manager nullable assetId"
    )
    _assert_true(
        manager._asset_needs_placeholder({"type": "mesh", "source": "url", "url": "https://example.test/a.glb"}),
        "manager URL mesh route"
    )
    _assert_true(
        not manager._asset_needs_placeholder({"type": "mesh", "source": "carrier", "meshPath": "carrier-path"}),
        "manager carrier mesh route remains separate"
    )
    _assert_true(
        not manager._has_remote_asset_url({
            "type": "mesh", "source": "carrier", "meshPath": "carrier-path", "url": "https://stale.test/model.glb",
        }),
        "manager carrier source ignores stale URL"
    )
    var signature_asset := {"type": "image", "source": "url", "url": "https://example.test/a.png"}
    _assert_eq(
        manager._asset_signature(signature_asset),
        manager._asset_signature(signature_asset.duplicate(true)),
        "manager stable asset signature"
    )
    _assert_true(manager._is_sha256_asset_id("sha256-" + "0".repeat(64)), "manager accepts strict SHA-256 assetId")
    _assert_true(not manager._is_sha256_asset_id("shared-friendly-id"), "manager rejects non-SHA URL cache key")
    _assert_true(
        not manager._is_sha256_asset_id("sha256-" + "A".repeat(64)),
        "manager rejects uppercase URL cache key"
    )

    var ramp_rotation := Quaternion(Vector3.FORWARD, deg_to_rad(-16.0))
    var ramp_scale := Vector3(4.4, 0.18, 1.1)
    manager._handle_scene_state({
        "kind": "scene-state",
        "objects": {
            "trs-ramp": {
                "name": "Ramp",
                "position": SceneSyncProtocol.pos_to_wire(Vector3(1.0, 2.0, 3.0)),
                "rotation": SceneSyncProtocol.rot_to_wire(ramp_rotation),
                "scale": SceneSyncProtocol.scale_to_wire(ramp_scale),
                "asset": {"type": "primitive", "primitive": "box"},
            },
        },
    })
    var ramp_node := manager._managed_objects["trs-ramp"] as Node3D
    var expected_ramp_basis := Basis(ramp_rotation).scaled_local(ramp_scale)
    _assert_true(
        ramp_node.transform.basis.is_equal_approx(expected_ramp_basis),
        "manager scene-state composes rotated non-uniform local scale"
    )
    _assert_basis_orthogonal(
        ramp_node.transform.basis,
        "manager scene-state rotated non-uniform basis stays orthogonal"
    )

    var domino_rotation := Quaternion(Vector3(0.3, 0.8, 0.5).normalized(), deg_to_rad(57.0))
    var domino_scale := Vector3(0.12, 1.32, 0.52)
    manager._handle_scene_delta({
        "kind": "scene-delta",
        "objectId": "trs-ramp",
        "rotation": SceneSyncProtocol.rot_to_wire(domino_rotation),
        "scale": SceneSyncProtocol.scale_to_wire(domino_scale),
    })
    var expected_domino_basis := Basis(domino_rotation).scaled_local(domino_scale)
    _assert_true(
        ramp_node.transform.basis.is_equal_approx(expected_domino_basis),
        "manager scene-delta composes Domino-like dynamic rotation"
    )
    _assert_basis_orthogonal(
        ramp_node.transform.basis,
        "manager Domino-like dynamic rotation stays orthogonal"
    )
    var domino_snapshot := manager._snapshot_for_node(ramp_node)
    var domino_roundtrip_basis := Basis(domino_snapshot["rotation"]).scaled_local(domino_snapshot["scale"])
    _assert_true(
        domino_roundtrip_basis.is_equal_approx(ramp_node.transform.basis),
        "manager apply snapshot TRS roundtrip preserves basis"
    )
    _assert_true(
        domino_snapshot["position"].is_equal_approx(Vector3(1.0, 2.0, 3.0)),
        "manager scene-delta preserves omitted position"
    )

    var transform_regressions := [
        {
            "name": "identity rotation",
            "rotation": Quaternion.IDENTITY,
            "scale": Vector3(0.12, 1.32, 0.52),
        },
        {
            "name": "uniform scale",
            "rotation": ramp_rotation,
            "scale": Vector3(2.0, 2.0, 2.0),
        },
        {
            "name": "negative scale",
            "rotation": ramp_rotation,
            "scale": Vector3(-4.4, 0.18, 1.1),
        },
    ]
    for regression in transform_regressions:
        var regression_rotation: Quaternion = regression["rotation"]
        var regression_scale: Vector3 = regression["scale"]
        manager._apply_transform_to_node(ramp_node, {
            "rotation": regression_rotation,
            "scale": regression_scale,
        })
        var expected_basis := Basis(regression_rotation).scaled_local(regression_scale)
        var case_name: String = regression["name"]
        _assert_true(
            ramp_node.transform.basis.is_equal_approx(expected_basis),
            "manager %s uses local TRS order" % case_name
        )
        _assert_basis_orthogonal(
            ramp_node.transform.basis,
            "manager %s basis stays orthogonal" % case_name
        )
        var regression_snapshot := manager._snapshot_for_node(ramp_node)
        var regression_roundtrip := Basis(regression_snapshot["rotation"]).scaled_local(regression_snapshot["scale"])
        _assert_true(
            regression_roundtrip.is_equal_approx(expected_basis),
            "manager %s snapshot recomposes original basis" % case_name
        )

    var animation_node := Node3D.new()
    sync_root.add_child(animation_node)
    animation_node.set_meta("scene_sync_object_id", "obj-anim")
    manager._managed_objects["obj-anim"] = animation_node
    manager._known_ids["obj-anim"] = true
    var animation_player := AnimationPlayer.new()
    animation_node.add_child(animation_player)
    var animation_library := AnimationLibrary.new()
    var survey_animation := Animation.new()
    survey_animation.length = 2.0
    animation_library.add_animation("Fox", survey_animation)
    animation_player.add_animation_library("", animation_library)
    manager._apply_payload_metadata(animation_node, "obj-anim", {
        "animation": {
            "enabled": true,
            "clipName": "Fox",
            "mode": "once",
            "speed": 0.5,
            "offset": 0.25,
        },
    }, true)
    _assert_true(animation_node.has_meta("scene_sync_animation"), "manager stores animation metadata")
    _assert_eq(manager.get_animation_policy("obj-anim")["clipName"], "Fox", "manager exposes animation policy")
    _assert_eq(animation_player.current_animation, "Fox", "manager applies named animation clip")
    _assert_true(is_equal_approx(animation_player.speed_scale, 0.5), "manager applies animation speed")
    _assert_eq(
        animation_player.get_animation("Fox").loop_mode,
        Animation.LOOP_NONE,
        "manager applies animation once mode"
    )
    var policy_copy := manager.get_animation_policy("obj-anim")
    policy_copy["clipName"] = "Mutated"
    _assert_eq(manager.get_animation_policy("obj-anim")["clipName"], "Fox", "manager policy getter deep copies")
    manager._apply_payload_metadata(animation_node, "obj-anim", {"name": "Animated"}, true)
    _assert_eq(manager.get_animation_policy("obj-anim")["clipName"], "Fox", "manager preserves omitted animation")
    manager._apply_payload_metadata(animation_node, "obj-anim", {"animation": {"speed": 0.25}}, true)
    var merged_animation := manager.get_animation_policy("obj-anim")
    _assert_eq(merged_animation["clipName"], "Fox", "manager partial animation keeps clip")
    _assert_eq(merged_animation["mode"], "once", "manager partial animation keeps mode")
    _assert_eq(merged_animation["offset"], 0.25, "manager partial animation keeps offset")
    _assert_eq(merged_animation["speed"], 0.25, "manager partial animation updates speed")
    var indexed_animation := manager._merge_animation_policy(merged_animation, {"clip": 0})
    _assert_true(not indexed_animation.has("clipName"), "manager clip index clears stale clipName")
    var animation_roundtrip = SceneSyncProtocol.make_scene_add(
        "obj-anim",
        animation_node.name,
        Vector3.ZERO,
        Quaternion.IDENTITY,
        Vector3.ONE,
        "",
        {},
        "",
        {},
        "",
        "",
        true,
        manager.get_animation_policy("obj-anim")
    )
    _assert_eq(animation_roundtrip["animation"]["offset"], 0.25, "manager animation wire roundtrip")
    manager._apply_payload_metadata(animation_node, "obj-anim", {"animation": null}, true)
    _assert_true(not animation_node.has_meta("scene_sync_animation"), "manager clears explicit null animation")
    _assert_true(not manager._animation_policies.has("obj-anim"), "manager clears animation dictionary")
    _assert_eq(animation_player.current_animation, "Fox", "manager defaults to first clip after clear")
    _assert_eq(
        animation_player.get_animation("Fox").loop_mode,
        Animation.LOOP_LINEAR,
        "manager defaults to loop after clear"
    )
    var sampled_resource := animation_player.get_animation("Fox")
    var sample_result := SceneSyncAnimationPolicy.sample(animation_node, {
        "clipName": "Fox", "mode": "loop", "speed": 1.0, "offset": 0.25,
    }, 2.0)
    _assert_eq(sample_result["reason"], "sampled", "animation deterministic sample applies")
    _assert_true(is_equal_approx(animation_player.current_animation_position, 0.25), "animation sample wraps loop time")
    _assert_true(animation_player.get_animation("Fox") == sampled_resource, "animation sample reuses resource")

    animation_node.set_meta("scene_sync_remote_object", true)
    var authored_clock_node := Node3D.new()
    sync_root.add_child(authored_clock_node)
    authored_clock_node.set_meta("scene_sync_object_id", "authored-clock")
    manager._managed_objects["authored-clock"] = authored_clock_node
    manager._known_ids["authored-clock"] = true
    var authored_clock_player := AnimationPlayer.new()
    authored_clock_node.add_child(authored_clock_player)
    var authored_clock_library := AnimationLibrary.new()
    var authored_clock_animation := Animation.new()
    authored_clock_animation.length = 2.0
    authored_clock_library.add_animation("Authored", authored_clock_animation)
    authored_clock_player.add_animation_library("", authored_clock_library)
    authored_clock_player.play("Authored")
    authored_clock_player.speed_scale = 0.75
    authored_clock_player.seek(0.4, true)

    manager.follow_shared_playback()
    _assert_eq(manager.get_playback_clock_state()["modeName"], "shared-playback-follow", "manager follows shared clock")
    manager._dispatch_scene_payload({
        "kind": "scene-clock",
        "mode": "shared-playback",
        "paused": true,
        "pausedTime": 1.5,
        "revision": 1,
        "objectClocks": {"obj-anim": {"sharedEpochTime": 0.0}},
    }, {"id": "remote-controller"})
    manager._update_playback_clock()
    _assert_true(is_equal_approx(animation_player.current_animation_position, 1.5), "manager samples followed clock")
    var clock_runner := manager._ensure_loom_runner()
    var runner_get_override := (
        "GetTimeOverride" if clock_runner.has_method("GetTimeOverride") else "get_time_override"
    )
    _assert_true(
        is_equal_approx(float(clock_runner.call(runner_get_override, "obj-anim")), 1.5),
        "manager supplies the same ObjectAge to Animation and Loomlet"
    )
    _assert_true(is_equal_approx(animation_player.speed_scale, 0.0), "shared clock freezes local animation advance")
    _assert_true(is_equal_approx(authored_clock_player.speed_scale, 0.75), "shared clock leaves authored animation speed unchanged")
    _assert_true(
        is_equal_approx(authored_clock_player.current_animation_position, 0.4),
        "shared clock leaves authored animation position unchanged"
    )
    manager.playback_clock_mode = SceneSyncPlaybackClock.LOCAL
    manager._update_playback_clock()
    _assert_eq(manager.get_playback_clock_state()["modeName"], "local", "manager returns to local clock")
    _assert_true(is_equal_approx(animation_player.speed_scale, 1.0), "direct local clock setting resumes policy playback")
    manager.seek_playback_clock(1.25)
    manager._update_playback_clock()
    var local_object_time := float(clock_runner.call(runner_get_override, "obj-anim"))
    _assert_true(
        is_equal_approx(animation_player.current_animation_position, fmod(local_object_time, 2.0)),
        "local transport supplies the same ObjectAge to Animation and Loomlet"
    )
    _assert_true(is_equal_approx(animation_player.speed_scale, 0.0), "local transport switches Animation to deterministic sampling")
    manager.pause_playback_clock()
    manager._update_playback_clock()
    _assert_true(bool(manager.get_playback_clock_state().get("paused", false)), "manager local pause freezes all consumers")

    manager._apply_scene_physics_payload({"physics": {"gravity": [0, -9.8, 0]}}, true)
    _assert_true(manager.has_meta("scene_sync_physics"), "manager stores scene physics metadata")
    var scene_physics_copy := manager.get_scene_physics()
    scene_physics_copy["gravity"] = []
    _assert_eq(manager.get_scene_physics()["gravity"].size(), 3, "manager scene physics getter deep copies")
    manager._apply_scene_physics_payload({"kind": "scene-state"}, true)
    _assert_true(manager.get_scene_physics().has("gravity"), "manager preserves omitted scene physics")
    manager._apply_scene_physics_payload({"physics": null}, true)
    _assert_true(manager.get_scene_physics().is_empty(), "manager clears explicit null scene physics")
    _assert_true(not manager.has_meta("scene_sync_physics"), "manager clears scene physics metadata")

    manager._apply_payload_metadata(animation_node, "obj-anim", {"physics": {"bodyType": "dynamic", "mass": 2.0}}, true)
    var object_physics_copy := manager.get_object_physics("obj-anim")
    object_physics_copy["mass"] = 99.0
    _assert_eq(manager.get_object_physics("obj-anim")["mass"], 2.0, "manager object physics getter deep copies")
    manager._apply_payload_metadata(animation_node, "obj-anim", {"name": "PhysicsBody"}, true)
    _assert_eq(manager.get_object_physics("obj-anim")["bodyType"], "dynamic", "manager preserves omitted object physics")
    var physics_roundtrip = SceneSyncProtocol.make_scene_add(
        "obj-anim", animation_node.name, Vector3.ZERO, Quaternion.IDENTITY, Vector3.ONE,
        "", {}, "", {}, "", "", true, null,
        manager.get_object_physics("obj-anim"), manager._has_object_physics("obj-anim")
    )
    _assert_eq(physics_roundtrip["physics"]["mass"], 2.0, "manager object physics wire roundtrip")
    manager._apply_payload_metadata(animation_node, "obj-anim", {"physics": null}, true)
    _assert_true(not animation_node.has_meta("scene_sync_physics"), "manager clears explicit null object physics")

    manager._apply_scene_physics_payload({
        "physics": {
            "enabled": true,
            "worldOptions": {"gravity": [0, -9.81, 0], "timestep": 1.0 / 60.0, "ground": null},
        },
    }, true)
    manager._apply_payload_metadata(animation_node, "obj-anim", {
        "physics": {
            "enabled": true,
            "bodyType": "dynamic",
            "shape": "box",
            "halfExtents": [0.5, 0.5, 0.5],
            "density": 1.0,
            "canSleep": false,
        },
    }, true)
    var rapier_bridge = manager.get_rapier_bridge()
    _assert_true(rapier_bridge.is_body_registered("obj-anim"), "manager registers physics metadata with Rapier")
    var rapier_state: Dictionary = rapier_bridge.advance_to_time(0.0, SceneSyncPlaybackClock.LOCAL, true)
    _assert_true(bool(rapier_state.get("active", false)), "manager Rapier bridge executes enabled scene physics")
    _assert_not_empty(rapier_state.get("hash", ""), "manager Rapier bridge exposes canonical hash")
    manager._apply_payload_metadata(animation_node, "obj-anim", {"physics": null}, true)
    _assert_true(not rapier_bridge.is_body_registered("obj-anim"), "manager unregisters cleared physics metadata")
    manager._apply_scene_physics_payload({"physics": null}, true)

    var failed_url_node := Node3D.new()
    sync_root.add_child(failed_url_node)
    failed_url_node.set_meta("scene_sync_object_id", "url-failure")
    manager._managed_objects["url-failure"] = failed_url_node
    manager._known_ids["url-failure"] = true
    manager._remote_asset_contexts["url-failure"] = {
        "signature": "sig-failure",
        "nodeId": failed_url_node.get_instance_id(),
        "asset": {"type": "mesh", "source": "url", "url": "https://example.test/failure.glb"},
    }
    manager._pending_recoveries.clear()
    manager._on_remote_asset_failed("url-failure", "sig-failure", "mesh", {"reason": "transport"})
    _assert_true(manager._pending_recoveries.is_empty(), "manager URL failure skips peer recovery")
    _assert_true(not manager._remote_asset_contexts.has("url-failure"), "manager URL failure clears context")

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

    var pasted_object_ids := ["paste-a", "paste-b", "paste-c"]
    for pasted_object_id in pasted_object_ids:
        manager._handle_scene_add({
            "kind": "scene-add",
            "objectId": pasted_object_id,
            "name": "Web Crate Copy",
            "position": [0.0, 0.0, 0.0],
            "rotation": [0.0, 0.0, 0.0, 1.0],
            "scale": [1.0, 1.0, 1.0],
            "asset": {"type": "primitive", "primitive": "box"},
        })
    var pasted_instance_ids := {}
    for pasted_object_id in pasted_object_ids:
        var pasted_node := manager._managed_objects.get(pasted_object_id) as Node3D
        _assert_true(pasted_node != null, "manager tracks each same-name Web paste")
        if pasted_node != null:
            pasted_instance_ids[pasted_node.get_instance_id()] = true
            _assert_eq(
                pasted_node.get_meta("scene_sync_object_id", ""),
                pasted_object_id,
                "manager preserves each same-name Web paste identity"
            )
    _assert_eq(pasted_instance_ids.size(), 3, "manager creates distinct nodes for same-name Web pastes")

    var mesh_existing := Node3D.new()
    mesh_existing.name = "MeshTarget"
    sync_root.add_child(mesh_existing)
    var authored_mesh_child := Node3D.new()
    authored_mesh_child.name = "AuthoredChild"
    mesh_existing.add_child(authored_mesh_child)
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
        "physics": {"bodyType": "fixed", "friction": 0.5},
    })
    _assert_true(manager._managed_objects.has("obj-mesh-rebind"), "manager scene-mesh rebind tracks object")
    _assert_true(manager._mesh_paths.has("obj-mesh-rebind"), "manager scene-mesh rebind stores meshPath")
    _assert_true(manager._managed_objects["obj-mesh-rebind"] == mesh_existing, "manager scene-mesh keeps authored root")
    _assert_true(not mesh_existing.is_queued_for_deletion(), "manager scene-mesh does not delete authored root")
    _assert_true(authored_mesh_child.get_parent() == mesh_existing, "manager scene-mesh preserves authored subtree")
    var rebound_node := manager._managed_objects["obj-mesh-rebind"] as Node3D
    _assert_eq(manager.get_object_physics("obj-mesh-rebind")["bodyType"], "fixed", "manager mesh replacement preserves physics")
    _assert_true(not rebound_node.has_meta("scene_sync_remote_object"), "manager authored rebind remains non-remote")
    manager._handle_scene_remove({"kind": "scene-remove", "objectId": "obj-mesh-rebind"})
    _assert_true(not mesh_existing.is_queued_for_deletion(), "manager remove preserves authored bound node")
    _assert_true(not manager._managed_objects.has("obj-mesh-rebind"), "manager remove unmanages authored bound node")
    _assert_true(not mesh_existing.has_meta("scene_sync_object_id"), "manager remove unpublishes authored identity")
    _assert_true(mesh_existing.has_meta("scene_sync_physics"), "manager remove preserves authored physics metadata")

    var remote_remove := Node3D.new()
    remote_remove.set_meta("scene_sync_object_id", "remote-remove")
    remote_remove.set_meta("scene_sync_remote_object", true)
    sync_root.add_child(remote_remove)
    manager._managed_objects["remote-remove"] = remote_remove
    manager._known_ids["remote-remove"] = true
    manager._handle_scene_remove({"kind": "scene-delete", "objectId": "remote-remove"})
    _assert_true(remote_remove.is_queued_for_deletion(), "manager remove deletes remote-owned node")
    _assert_true(not manager._managed_objects.has("remote-remove"), "manager remove unmanages remote-owned node")

    var remote_only := Node3D.new()
    remote_only.set_meta("scene_sync_object_id", "remote-only")
    remote_only.set_meta("scene_sync_remote_object", true)
    sync_root.add_child(remote_only)
    manager._managed_objects["remote-only"] = remote_only
    manager._known_ids["remote-only"] = true
    var authored_survivor := Node3D.new()
    authored_survivor.set_meta("scene_sync_object_id", "authored-survivor")
    authored_survivor.set_meta("scene_sync_animation", {"clipName": "Authored"})
    authored_survivor.set_meta("scene_sync_physics", {"bodyType": "fixed"})
    sync_root.add_child(authored_survivor)
    manager._managed_objects["authored-survivor"] = authored_survivor
    manager._known_ids["authored-survivor"] = true
    manager.playback_clock_mode = SceneSyncPlaybackClock.SHARED_PLAYBACK_FOLLOW
    manager._update_playback_clock()
    _assert_eq(manager._playback_clock.mode, SceneSyncPlaybackClock.SHARED_PLAYBACK_FOLLOW, "manager syncs direct clock mode setting")
    manager._on_disconnected()
    _assert_true(remote_only.is_queued_for_deletion(), "manager disconnect deletes remote-only node")
    _assert_true(not authored_survivor.is_queued_for_deletion(), "manager disconnect preserves authored node")
    _assert_true(authored_survivor.has_meta("scene_sync_animation"), "manager disconnect preserves authored animation meta")
    _assert_true(authored_survivor.has_meta("scene_sync_physics"), "manager disconnect preserves authored physics meta")
    _assert_eq(
        manager.playback_clock_mode,
        SceneSyncPlaybackClock.SHARED_PLAYBACK_FOLLOW,
        "manager disconnect preserves configured clock mode"
    )
    _assert_true(manager._managed_objects.is_empty(), "manager disconnect clears managed object map")
    _assert_true(manager._mesh_data_by_asset_id.is_empty(), "manager disconnect clears asset cache")

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
    _assert_eq(empty_status.get("reason", ""), "no mesh found in this node or children. Add a MeshInstance3D under this node.", "manager publish candidate skips meshless Node3D")

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
