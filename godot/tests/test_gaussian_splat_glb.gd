extends SceneTree

## KHR_gaussian_splatting GLB の検出 / プレビュー / バックエンド振り分けのテスト。
##
## fixture は Web 実装と同じものを使う（html/scenesync/experiments/fixtures/）。
## Web / Unity / Godot が同一 GLB を共有できることが目的なので、
## エンジンごとに fixture を複製しない。

var _passed: int = 0
var _failed: int = 0
var _errors: Array[String] = []


class StubSplatBackend extends RefCounted:
    var accept: bool = true
    var return_null: bool = false
    var last_info: Dictionary = {}
    var call_count: int = 0

    func get_backend_name() -> String:
        return "StubSplatBackend"

    func can_render(info: Dictionary) -> bool:
        last_info = info
        return accept

    func create_splat_node(_data: PackedByteArray, _info: Dictionary) -> Node3D:
        call_count += 1
        if return_null:
            return null
        var node := Node3D.new()
        node.name = "StubSplatNode"
        return node


class IncompleteBackend extends RefCounted:
    func get_backend_name() -> String:
        return "IncompleteBackend"


func _init() -> void:
    _run_inspect_tests()
    _run_preview_tests()
    _run_backend_tests()
    _run_import_routing_tests()
    _run_node_tests()
    _finish()


# --- helpers ---------------------------------------------------------------


func _fixture_path(file_name: String) -> String:
    var project_dir := ProjectSettings.globalize_path("res://")
    return project_dir.path_join("../html/scenesync/experiments/fixtures").path_join(file_name).simplify_path()


func _fixture_bytes(file_name: String) -> PackedByteArray:
    var data := FileAccess.get_file_as_bytes(_fixture_path(file_name))
    if data.is_empty():
        _fail("fixture %s is unreadable (%s)" % [file_name, _fixture_path(file_name)])
    return data


func _box_glb() -> PackedByteArray:
    var mesh_instance := MeshInstance3D.new()
    mesh_instance.mesh = BoxMesh.new()
    root.add_child(mesh_instance)
    var data := SceneSyncGltfHelper.export_glb(mesh_instance)
    mesh_instance.free()
    return data


func _assert_eq(actual, expected, test_name: String) -> void:
    if actual == expected:
        _passed += 1
        print("  OK: %s" % test_name)
        return
    _fail("%s: expected %s but got %s" % [test_name, str(expected), str(actual)])


func _assert_true(condition: bool, test_name: String) -> void:
    _assert_eq(condition, true, test_name)


func _assert_approx(actual: float, expected: float, tolerance: float, test_name: String) -> void:
    if absf(actual - expected) <= tolerance:
        _passed += 1
        print("  OK: %s" % test_name)
        return
    _fail("%s: expected %f (+/-%f) but got %f" % [test_name, expected, tolerance, actual])


func _fail(message: String) -> void:
    _failed += 1
    _errors.append(message)
    print("  FAIL: %s" % message)


# --- inspect ---------------------------------------------------------------


func _run_inspect_tests() -> void:
    print("\n--- SceneSyncGaussianSplatGlb Tests ---")

    var minimal := _fixture_bytes("minimal-khr-gaussian-splatting.glb")
    var info := SceneSyncGaussianSplatGlb.inspect(minimal)
    _assert_true(bool(info["parsed"]), "minimal fixture parses")
    _assert_true(bool(info["hasGaussianSplatting"]), "minimal fixture is detected as Gaussian Splat")
    _assert_true(bool(info["extensionDeclared"]), "minimal fixture declares extensionsUsed")
    _assert_true(bool(info["valid"]), "minimal fixture is valid")
    _assert_eq(int(info["splatCount"]), 8, "minimal fixture splat count")
    _assert_eq((info["primitives"] as Array).size(), 1, "minimal fixture primitive count")
    _assert_true(not bool(info["hasRegularMeshPrimitive"]), "minimal fixture has no regular mesh")
    _assert_eq((info["errors"] as PackedStringArray).size(), 0, "minimal fixture has no errors")
    _assert_eq((info["warnings"] as PackedStringArray).size(), 0, "minimal fixture has no warnings")
    _assert_eq(int(info["byteLength"]), minimal.size(), "inspect reports byte length")

    var first := (info["primitives"] as Array)[0] as Dictionary
    _assert_eq(String(first["kernel"]), "ellipse", "minimal fixture kernel")
    _assert_eq(String(first["colorSpace"]), "srgb_rec709_display", "minimal fixture colorSpace")
    _assert_true(bool(first["validMode"]), "minimal fixture primitive mode is POINTS")

    var ring := _fixture_bytes("ring-gaussian-splats.glb")
    var ring_info := SceneSyncGaussianSplatGlb.inspect(ring)
    _assert_true(bool(ring_info["valid"]), "converted fixture is valid")
    _assert_eq(int(ring_info["splatCount"]), 16, "converted fixture splat count")

    var box_info := SceneSyncGaussianSplatGlb.inspect(_box_glb())
    _assert_true(not bool(box_info["hasGaussianSplatting"]), "plain mesh GLB is not a Gaussian Splat GLB")
    _assert_true(bool(box_info["hasRegularMeshPrimitive"]), "plain mesh GLB reports a regular primitive")
    _assert_true(not bool(box_info["valid"]), "plain mesh GLB is not valid as a splat GLB")

    _assert_true(not bool(SceneSyncGaussianSplatGlb.parse_glb(PackedByteArray())["ok"]), "empty data fails to parse")
    var bad_magic := minimal.duplicate()
    bad_magic.encode_u32(0, 0x12345678)
    _assert_eq(
        String(SceneSyncGaussianSplatGlb.parse_glb(bad_magic)["error"]),
        "Invalid GLB magic",
        "bad magic is rejected"
    )
    var bad_length := minimal.duplicate()
    bad_length.encode_u32(8, minimal.size() + 64)
    _assert_eq(
        String(SceneSyncGaussianSplatGlb.parse_glb(bad_length)["error"]),
        "Invalid GLB length",
        "declared length beyond the buffer is rejected"
    )
    _assert_true(
        SceneSyncGaussianSplatGlb.parse_glb(minimal).get("binOffset", -1) > 0,
        "parse_glb locates the BIN chunk"
    )

    var undeclared := SceneSyncGaussianSplatGlb.inspect_gltf(_splat_gltf({}, {"extensionsUsed": []}))
    _assert_true(bool(undeclared["hasGaussianSplatting"]), "undeclared extension is still detected")
    _assert_true(not bool(undeclared["valid"]), "undeclared extension is invalid")
    _assert_eq((undeclared["errors"] as PackedStringArray).size(), 1, "undeclared extension reports one error")

    var triangles := SceneSyncGaussianSplatGlb.inspect_gltf(_splat_gltf({"mode": 4}))
    _assert_true(not bool(triangles["valid"]), "non-POINTS mode is invalid")

    var missing_attribute := _splat_gltf({})
    var attributes := ((missing_attribute["meshes"][0]["primitives"][0]) as Dictionary)["attributes"] as Dictionary
    attributes.erase("KHR_gaussian_splatting:OPACITY")
    var missing_info := SceneSyncGaussianSplatGlb.inspect_gltf(missing_attribute)
    _assert_true(not bool(missing_info["valid"]), "missing required attribute is invalid")

    var odd_kernel := SceneSyncGaussianSplatGlb.inspect_gltf(_splat_gltf({}, {}, {"kernel": "gaussian"}))
    _assert_true(bool(odd_kernel["valid"]), "unknown kernel is a warning, not an error")
    _assert_eq((odd_kernel["warnings"] as PackedStringArray).size(), 1, "unknown kernel reports a warning")

    var mixed := _splat_gltf({})
    (mixed["meshes"] as Array).append({
        "primitives": [{"mode": 4, "attributes": {"POSITION": 0}}],
    })
    var mixed_info := SceneSyncGaussianSplatGlb.inspect_gltf(mixed)
    _assert_true(bool(mixed_info["hasGaussianSplatting"]), "mixed GLB is detected as Gaussian Splat")
    _assert_true(bool(mixed_info["hasRegularMeshPrimitive"]), "mixed GLB reports a regular primitive")


## Gaussian Splat primitive をひとつ持つ最小の glTF JSON を組み立てる。
func _splat_gltf(
    primitive_overrides: Dictionary = {},
    root_overrides: Dictionary = {},
    extension_overrides: Dictionary = {}
) -> Dictionary:
    var extension := {
        "kernel": "ellipse",
        "colorSpace": "srgb_rec709_display",
        "projection": "perspective",
        "sortingMethod": "cameraDistance",
    }
    extension.merge(extension_overrides, true)

    var primitive := {
        "mode": 0,
        "attributes": {
            "POSITION": 0,
            "KHR_gaussian_splatting:ROTATION": 1,
            "KHR_gaussian_splatting:SCALE": 2,
            "KHR_gaussian_splatting:OPACITY": 3,
            "KHR_gaussian_splatting:SH_DEGREE_0_COEF_0": 4,
        },
        "extensions": {"KHR_gaussian_splatting": extension},
    }
    primitive.merge(primitive_overrides, true)

    var gltf := {
        "asset": {"version": "2.0"},
        "extensionsUsed": ["KHR_gaussian_splatting"],
        "meshes": [{"primitives": [primitive]}],
        "accessors": [
            {"count": 3, "type": "VEC3", "componentType": 5126},
            {"count": 3, "type": "VEC4", "componentType": 5126},
            {"count": 3, "type": "VEC3", "componentType": 5126},
            {"count": 3, "type": "SCALAR", "componentType": 5126},
            {"count": 3, "type": "VEC3", "componentType": 5126},
        ],
    }
    gltf.merge(root_overrides, true)
    return gltf


# --- preview ---------------------------------------------------------------


func _run_preview_tests() -> void:
    print("\n--- SceneSyncGaussianSplatPreview Tests ---")

    var minimal := _fixture_bytes("minimal-khr-gaussian-splatting.glb")
    var preview := SceneSyncGaussianSplatPreview.build(minimal)
    _assert_true(bool(preview["ok"]), "preview builds from the minimal fixture")
    _assert_eq(int(preview["pointCount"]), 8, "preview point count matches splat count")

    var node := preview["node"] as MeshInstance3D
    _assert_true(node != null, "preview returns a MeshInstance3D")
    if node != null:
        var mesh := node.mesh as ArrayMesh
        _assert_eq(mesh.get_surface_count(), 1, "preview mesh has one surface")
        _assert_eq(mesh.surface_get_primitive_type(0), Mesh.PRIMITIVE_POINTS, "preview mesh uses POINTS")

        var arrays := mesh.surface_get_arrays(0)
        var vertices := arrays[Mesh.ARRAY_VERTEX] as PackedVector3Array
        var colors := arrays[Mesh.ARRAY_COLOR] as PackedColorArray
        _assert_eq(vertices.size(), 8, "preview vertex count")
        _assert_eq(colors.size(), 8, "preview color count")
        # fixture の 1点目は position (-0.6, -0.4, 0) / color (1.0, 0.2, 0.2) / opacity 0.95
        _assert_approx(vertices[0].x, -0.6, 0.0001, "preview decodes POSITION.x")
        _assert_approx(vertices[0].y, -0.4, 0.0001, "preview decodes POSITION.y")
        _assert_approx(colors[0].r, 1.0, 0.01, "preview decodes SH0 red")
        _assert_approx(colors[0].g, 0.2, 0.01, "preview decodes SH0 green")
        _assert_approx(colors[0].a, 0.95, 0.01, "preview decodes OPACITY into alpha")
        node.free()

    # 変換済み fixture は COLOR_0（normalized ubyte）を持つので、そちらを優先して読む。
    var ring := SceneSyncGaussianSplatPreview.build(_fixture_bytes("ring-gaussian-splats.glb"))
    _assert_true(bool(ring["ok"]), "preview builds from the converted fixture")
    _assert_eq(int(ring["pointCount"]), 16, "converted fixture preview point count")
    if bool(ring["ok"]):
        var ring_node := ring["node"] as MeshInstance3D
        var ring_colors := (ring_node.mesh as ArrayMesh).surface_get_arrays(0)[Mesh.ARRAY_COLOR] as PackedColorArray
        _assert_true(ring_colors.size() == 16, "converted fixture preview has per-splat colors")
        ring_node.free()

    var not_a_splat := SceneSyncGaussianSplatPreview.build(_box_glb())
    _assert_true(not bool(not_a_splat["ok"]), "preview refuses a plain mesh GLB")
    _assert_eq(String(not_a_splat["reason"]), "no-gaussian-splat-primitive", "preview reports why it refused")

    var broken := SceneSyncGaussianSplatPreview.build(PackedByteArray([1, 2, 3, 4]))
    _assert_true(not bool(broken["ok"]), "preview refuses truncated data")


# --- backend ---------------------------------------------------------------


func _run_backend_tests() -> void:
    print("\n--- SceneSyncGaussianSplatBackend Tests ---")

    var minimal := _fixture_bytes("minimal-khr-gaussian-splatting.glb")

    SceneSyncGaussianSplatBackend.unregister_backend()
    _assert_true(not SceneSyncGaussianSplatBackend.is_available(), "no backend is registered by default")

    var fallback := SceneSyncGaussianSplatBackend.create_visual(minimal)
    _assert_true(bool(fallback["ok"]), "create_visual succeeds without a backend")
    _assert_eq(String(fallback["source"]), SceneSyncGaussianSplatBackend.SOURCE_PREVIEW, "falls back to the preview")
    var fallback_node := fallback["node"] as Node3D
    _assert_true(
        bool(fallback_node.get_meta(SceneSyncGaussianSplatBackend.SPLAT_NODE_META, false)),
        "preview node is tagged as a Gaussian Splat node"
    )
    fallback_node.free()

    _assert_true(
        not SceneSyncGaussianSplatBackend.register_backend(IncompleteBackend.new()),
        "a backend missing required methods is rejected"
    )

    var stub := StubSplatBackend.new()
    _assert_true(SceneSyncGaussianSplatBackend.register_backend(stub), "a complete backend registers")
    _assert_eq(SceneSyncGaussianSplatBackend.backend_name(), "StubSplatBackend", "backend name is reported")

    var rendered := SceneSyncGaussianSplatBackend.create_visual(minimal)
    _assert_eq(String(rendered["source"]), SceneSyncGaussianSplatBackend.SOURCE_BACKEND, "backend renders the GLB")
    _assert_eq(stub.call_count, 1, "backend receives the GLB once")
    _assert_eq(int(stub.last_info.get("splatCount", 0)), 8, "backend receives the inspection result")
    (rendered["node"] as Node3D).free()

    stub.accept = false
    var declined := SceneSyncGaussianSplatBackend.create_visual(minimal)
    _assert_eq(
        String(declined["source"]),
        SceneSyncGaussianSplatBackend.SOURCE_PREVIEW,
        "declining backend falls back to the preview"
    )
    (declined["node"] as Node3D).free()

    stub.accept = true
    stub.return_null = true
    var empty := SceneSyncGaussianSplatBackend.create_visual(minimal)
    _assert_eq(
        String(empty["source"]),
        SceneSyncGaussianSplatBackend.SOURCE_PREVIEW,
        "backend returning null falls back to the preview"
    )
    (empty["node"] as Node3D).free()

    SceneSyncGaussianSplatBackend.unregister_backend()
    _assert_true(not SceneSyncGaussianSplatBackend.is_available(), "backend can be unregistered")

    var refused := SceneSyncGaussianSplatBackend.create_visual(_box_glb())
    _assert_true(not bool(refused["ok"]), "create_visual refuses a plain mesh GLB")
    _assert_eq(String(refused["reason"]), "not-a-gaussian-splat-glb", "create_visual reports why it refused")


# --- import routing --------------------------------------------------------


func _run_import_routing_tests() -> void:
    print("\n--- SceneSyncGltfHelper Gaussian Splat routing Tests ---")

    SceneSyncGaussianSplatBackend.unregister_backend()

    var imported := SceneSyncGltfHelper.import_glb(_fixture_bytes("minimal-khr-gaussian-splatting.glb"))
    _assert_true(imported != null, "import_glb accepts a Gaussian Splat GLB")
    if imported != null:
        _assert_eq(imported.name, "ImportedGlb", "Gaussian Splat container keeps the ImportedGlb name")
        _assert_true(
            bool(imported.get_meta(SceneSyncGaussianSplatBackend.SPLAT_NODE_META, false)),
            "Gaussian Splat container is tagged"
        )
        _assert_eq(imported.get_child_count(), 1, "Gaussian Splat container holds the visual")
        _assert_true(imported.get_child(0) is MeshInstance3D, "preview visual is a MeshInstance3D")
        imported.free()

    var stub := StubSplatBackend.new()
    SceneSyncGaussianSplatBackend.register_backend(stub)
    var backend_imported := SceneSyncGltfHelper.import_glb(_fixture_bytes("minimal-khr-gaussian-splatting.glb"))
    _assert_true(backend_imported != null, "import_glb routes to the registered backend")
    if backend_imported != null:
        _assert_eq(
            String(backend_imported.get_meta(SceneSyncGaussianSplatBackend.SPLAT_SOURCE_META, "")),
            SceneSyncGaussianSplatBackend.SOURCE_BACKEND,
            "import_glb records the backend as the visual source"
        )
        _assert_eq(backend_imported.get_child(0).name, "StubSplatNode", "backend node is attached")
        backend_imported.free()
    SceneSyncGaussianSplatBackend.unregister_backend()

    var plain := SceneSyncGltfHelper.import_glb(_box_glb())
    _assert_true(plain != null, "import_glb still imports plain mesh GLBs")
    if plain != null:
        _assert_true(
            not bool(plain.get_meta(SceneSyncGaussianSplatBackend.SPLAT_NODE_META, false)),
            "plain mesh GLB is not tagged as a Gaussian Splat"
        )
        plain.free()


# --- editor node -----------------------------------------------------------


func _run_node_tests() -> void:
    print("\n--- SceneSyncGaussianSplatNode3D Tests ---")

    SceneSyncGaussianSplatBackend.unregister_backend()

    var node := SceneSyncGaussianSplatNode3D.new()
    root.add_child(node)
    # Inspector で glb_path を設定した時と同じ経路。シーンを開いた時は _ready() が
    # 同じ reload() を呼ぶ。
    node.glb_path = _fixture_path("minimal-khr-gaussian-splatting.glb")

    _assert_true(node.has_visual(), "node builds its visual when glb_path is set")
    _assert_eq(node.get_visual_source(), SceneSyncGaussianSplatBackend.SOURCE_PREVIEW, "node uses the preview fallback")
    _assert_eq(int(node.get_splat_info().get("splatCount", 0)), 8, "node exposes the inspection result")
    _assert_eq(
        node.get_child(0).name,
        SceneSyncGaussianSplatNode3D.VISUAL_NAME,
        "node names its visual child consistently"
    )
    _assert_true(node.get_child(0).owner == null, "visual child is not persisted into the scene file")

    # Transform / visibility は通常の Node3D と同じ扱い。
    node.position = Vector3(1.0, 2.0, 3.0)
    node.visible = false
    _assert_eq(node.position, Vector3(1.0, 2.0, 3.0), "node transform is editable")
    _assert_true(not node.visible, "node visibility is editable")

    var reload_ok: bool = node.reload()
    _assert_true(reload_ok, "node reloads from glb_path")
    _assert_eq(node.get_child_count(), 1, "reload replaces the previous visual")

    node.glb_path = ""
    _assert_true(not node.has_visual(), "clearing glb_path clears the visual")

    var loaded_from_bytes: bool = node.load_from_bytes(_fixture_bytes("ring-gaussian-splats.glb"))
    _assert_true(loaded_from_bytes, "node loads from raw bytes (SceneSync runtime path)")
    _assert_eq(int(node.get_splat_info().get("splatCount", 0)), 16, "node updates its inspection result")

    var rejected: bool = node.load_from_bytes(_box_glb())
    _assert_true(not rejected, "node rejects a plain mesh GLB")
    _assert_true(not node.has_visual(), "rejected load leaves no visual")

    root.remove_child(node)
    node.free()


func _finish() -> void:
    print("")
    print("========================================")
    print("  PASSED: %d  FAILED: %d" % [_passed, _failed])
    print("========================================")
    for err in _errors:
        print("  FAIL: %s" % err)
    print("")
    quit(0 if _failed == 0 else 1)
