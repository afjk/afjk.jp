extends SceneTree

## 固定 godot-gsplat GDExtension が入っている環境で、SceneSync の共通 GLB fixture が
## 本物の GaussianSplatNode3D / render data になることを確認する integration smoke。

const GaussianBackend := preload("res://addons/scene_sync/gaussian_splat_backend.gd")

var _passed := 0
var _failed := 0


func _initialize() -> void:
    call_deferred("_run")


func _run() -> void:
    print("\n--- SceneSync godot-gsplat Backend Smoke ---")
    var required := OS.get_environment("SCENESYNC_REQUIRE_GODOT_GSPLAT") == "1"

    if not GaussianBackend.reset_to_default_backend():
        if required:
            _fail("pinned godot-gsplat backend is required but unavailable")
        else:
            print("  SKIP: optional godot-gsplat dependency is not installed")
        _finish()
        return

    _assert_true(
        GaussianBackend.backend_name().begins_with("godot-gsplat @ dfc8df4893f0"),
        "fixed godot-gsplat commit is selected"
    )

    var minimal := FileAccess.get_file_as_bytes(_fixture_path("minimal-khr-gaussian-splatting.glb"))
    var result: Dictionary = GaussianBackend.create_visual(minimal)
    _assert_true(bool(result.get("ok", false)), "SceneSync creates a visual from the shared fixture")
    _assert_eq(
        String(result.get("source", "")),
        GaussianBackend.SOURCE_BACKEND,
        "the real backend is used instead of the point preview"
    )

    var splat := result.get("node") as Node3D
    _assert_true(splat != null and splat.is_class("GaussianSplatNode3D"), "visual is GaussianSplatNode3D")
    if splat != null:
        _assert_true(bool(splat.call("has_asset")), "godot-gsplat decoded a real GaussianSplatAsset")
        _assert_eq(int(splat.call("get_imported_point_count")), 8, "all fixture splats are decoded")
        _assert_eq(int(splat.get("render_profile")), 2, "desktop uses the bounded Middle profile")
        _assert_eq(int(splat.call("get_sh_degree")), 3, "desktop keeps SH degree 3")

        var world := Node3D.new()
        root.add_child(world)
        var camera := Camera3D.new()
        camera.position = Vector3(0.0, 0.0, 3.0)
        camera.current = true
        world.add_child(camera)
        world.add_child(splat)

        var deadline := Time.get_ticks_msec() + 5000
        while int(splat.call("get_rendered_splat_count")) == 0 \
                and Time.get_ticks_msec() < deadline:
            await process_frame

        var rendered := int(splat.call("get_rendered_splat_count"))
        var rendering_device := RenderingServer.get_rendering_device()
        if rendering_device != null:
            _assert_eq(rendered, 8, "the native renderer built eight Gaussian ellipse instances")
        else:
            print("  SKIP: headless platform has no RenderingDevice; decoded asset was still verified")

        var weak: WeakRef = weakref(splat)
        world.remove_child(splat)
        splat.free()
        await process_frame
        _assert_true(weak.get_ref() == null, "delete releases the native splat node")
        root.remove_child(world)
        world.free()

    var ring := FileAccess.get_file_as_bytes(_fixture_path("ring-gaussian-splats.glb"))
    var reloaded: Dictionary = GaussianBackend.create_visual(ring)
    _assert_eq(
        String(reloaded.get("source", "")),
        GaussianBackend.SOURCE_BACKEND,
        "the backend can create a second splat after delete"
    )
    if reloaded.get("node") is Node3D:
        var ring_node := reloaded["node"] as Node3D
        _assert_eq(int(ring_node.call("get_imported_point_count")), 16, "second GLB decodes all splats")
        ring_node.free()

    var capture_path := OS.get_environment("SCENESYNC_GAUSSIAN_GLB_FIXTURE")
    if capture_path != "" and FileAccess.file_exists(capture_path):
        var capture := FileAccess.get_file_as_bytes(capture_path)
        var capture_info := SceneSyncGaussianSplatGlb.inspect(capture)
        var capture_result: Dictionary = GaussianBackend.create_visual(capture, capture_info)
        _assert_eq(
            String(capture_result.get("source", "")),
            GaussianBackend.SOURCE_BACKEND,
            "real capture uses the native backend"
        )
        if capture_result.get("node") is Node3D:
            var capture_node := capture_result["node"] as Node3D
            _assert_eq(
                int(capture_node.call("get_imported_point_count")),
                int(capture_info.get("splatCount", 0)),
                "real capture preserves every splat"
            )
            _assert_eq(int(capture_node.call("get_sh_degree")), 3, "real capture uses SH degree 3")
            capture_node.free()

    GaussianBackend.unregister_backend()
    _finish()


func _fixture_path(file_name: String) -> String:
    var project_dir := ProjectSettings.globalize_path("res://")
    return project_dir.path_join("../html/scenesync/experiments/fixtures").path_join(file_name).simplify_path()


func _assert_true(value: bool, label: String) -> void:
    if value:
        _passed += 1
        print("  PASS: %s" % label)
    else:
        _fail(label)


func _assert_eq(actual: Variant, expected: Variant, label: String) -> void:
    if actual == expected:
        _passed += 1
        print("  PASS: %s" % label)
    else:
        _fail("%s (expected=%s actual=%s)" % [label, expected, actual])


func _fail(label: String) -> void:
    _failed += 1
    push_error("  FAIL: %s" % label)


func _finish() -> void:
    print("  RESULT: PASS=%d FAIL=%d" % [_passed, _failed])
    quit(0 if _failed == 0 else 1)
