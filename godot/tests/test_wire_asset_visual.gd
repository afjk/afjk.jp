extends SceneTree

const VISUAL := preload("res://addons/scene_sync/scene_sync_wire_asset_visual.gd")

var _passed: int = 0
var _failed: int = 0
var _errors: Array[String] = []


func _init() -> void:
    call_deferred("_run")


func _run() -> void:
    await _test_actual_image_and_cleanup()
    await _test_text_style_and_truncation()
    await _test_glb_visual_basis()
    await _test_primitive_restore()
    _finish()


func _test_actual_image_and_cleanup() -> void:
    var fixture := _new_host_with_fallback()
    var host := fixture["host"] as Node3D
    var fallback := fixture["fallback"] as MeshInstance3D
    var original_mesh := fallback.mesh
    var original_material := fallback.material_override

    var image := Image.create(2, 1, false, Image.FORMAT_RGBA8)
    image.set_pixel(0, 0, Color.RED)
    image.set_pixel(1, 0, Color.BLUE)
    var png := image.save_png_to_buffer()
    var result := VISUAL.apply_image_bytes(host, png)
    _assert_true(bool(result.get("ok", false)), "actual PNG decodes")
    var visual := result.get("node", null) as MeshInstance3D
    _assert_true(visual != null, "image visual is MeshInstance3D")
    if visual != null:
        var quad := visual.mesh as QuadMesh
        _assert_true(quad != null, "image visual uses QuadMesh")
        if quad != null:
            _assert_true(quad.size.is_equal_approx(Vector2(2.0, 1.0)), "image aspect ratio is preserved")
    _assert_eq(fallback.visible, false, "image hides fallback")
    _assert_true(VISUAL._image_dimensions_within_budget(8192, 4096), "image pixel budget accepts boundary")
    _assert_true(not VISUAL._image_dimensions_within_budget(8192, 4097), "image pixel budget rejects excess pixels")
    _assert_true(not VISUAL._image_dimensions_within_budget(8193, 1), "image dimension budget rejects excess width")

    VISUAL.clear_owned_visual(host)
    _assert_eq(_owned_child_count(host), 0, "clear removes owned image visual")
    _assert_eq(fallback.visible, true, "clear restores fallback visibility")
    _assert_eq(fallback.mesh, original_mesh, "clear restores fallback mesh")
    _assert_eq(fallback.material_override, original_material, "clear restores fallback material")
    host.free()
    await process_frame


func _test_text_style_and_truncation() -> void:
    var fixture := _new_host_with_fallback()
    var host := fixture["host"] as Node3D
    var long_text := "x".repeat(600)
    var asset := {
        "type": "text",
        "source": "inline",
        "text": long_text,
        "color": "#ff0000",
        "backgroundColor": "rgba(0,0,255,0.5)",
        "align": "right",
        "layout": {
            "width": 3.0,
            "height": 1.0,
            "padding": 0.1,
            "fontSize": 50,
            "lineHeight": 1.5,
        },
    }
    var inline_result := VISUAL.apply_text(host, asset)
    _assert_true(bool(inline_result.get("ok", false)), "inline text visual applies")
    _assert_eq(bool(inline_result.get("truncated", false)), true, "inline text reports truncation")
    _assert_eq(int(inline_result.get("characters", 0)), 512, "inline text truncates to display budget")
    var inline_root := inline_result.get("node", null) as Node3D
    var label := inline_root.find_child("RemoteTextLabel", true, false) as Label3D if inline_root != null else null
    _assert_true(label != null, "inline text creates Label3D")
    if label != null:
        _assert_eq(label.text.length(), 512, "inline Label3D contains truncated text")
        _assert_eq(label.font_size, 50, "inline text applies font size")
        _assert_eq(label.horizontal_alignment, HORIZONTAL_ALIGNMENT_RIGHT, "inline text applies alignment")
        _assert_true(label.modulate.is_equal_approx(Color.RED), "inline text applies color")

    var url_asset := {
        "type": "text",
        "source": "url",
        "url": "https://example.test/text.txt",
        "align": "left",
    }
    var url_result := VISUAL.apply_text(host, url_asset, "Downloaded UTF-8 text")
    _assert_true(bool(url_result.get("ok", false)), "URL text body applies")
    _assert_eq(bool(url_result.get("truncated", true)), false, "short URL text is not truncated")
    _assert_eq(_owned_child_count(host), 1, "text replacement keeps one owned visual root")
    var url_root := url_result.get("node", null) as Node3D
    var url_label := url_root.find_child("RemoteTextLabel", true, false) as Label3D if url_root != null else null
    _assert_eq(url_label.text if url_label != null else "", "Downloaded UTF-8 text", "URL text uses downloaded body")
    _assert_eq(
        url_label.horizontal_alignment if url_label != null else -1,
        HORIZONTAL_ALIGNMENT_LEFT,
        "URL text applies style"
    )

    VISUAL.clear_owned_visual(host)
    _assert_eq(_owned_child_count(host), 0, "text clear removes owned visual")
    host.free()
    await process_frame


func _test_glb_visual_basis() -> void:
    var source := MeshInstance3D.new()
    source.mesh = BoxMesh.new()
    root.add_child(source)
    var glb := SceneSyncGltfHelper.export_glb(source)
    source.free()

    var fixture := _new_host_with_fallback()
    var host := fixture["host"] as Node3D
    var fallback := fixture["fallback"] as MeshInstance3D
    var result := VISUAL.apply_glb_bytes(host, glb, {"visualBasis": "unity"})
    _assert_true(bool(result.get("ok", false)), "GLB visual applies")
    var visual := result.get("node", null) as Node3D
    _assert_true(visual != null, "GLB result exposes visual")
    if visual != null:
        _assert_true(is_equal_approx(visual.rotation.y, PI), "GLB applies unity visual basis")
    _assert_eq(fallback.visible, false, "GLB hides fallback")
    _assert_eq(_owned_child_count(host), 1, "GLB creates one owned root")

    VISUAL.clear_owned_visual(host)
    _assert_eq(fallback.visible, true, "GLB clear restores fallback")
    _assert_eq(_owned_child_count(host), 0, "GLB clear removes owned root")
    host.free()
    await process_frame


func _test_primitive_restore() -> void:
    var fixture := _new_host_with_fallback()
    var host := fixture["host"] as Node3D
    var fallback := fixture["fallback"] as MeshInstance3D
    var original_mesh := fallback.mesh
    var original_material := fallback.material_override

    var result := VISUAL.apply_primitive(host, {
        "type": "primitive",
        "primitive": "sphere",
        "color": "#00ff00",
    })
    _assert_true(bool(result.get("ok", false)), "primitive visual applies")
    _assert_true(fallback.mesh is SphereMesh, "primitive replaces fallback mesh")
    var material := fallback.material_override as StandardMaterial3D
    _assert_true(material != null and material.albedo_color.is_equal_approx(Color.GREEN), "primitive applies color")

    VISUAL.clear_owned_visual(host)
    _assert_eq(fallback.mesh, original_mesh, "primitive clear restores original mesh")
    _assert_eq(fallback.material_override, original_material, "primitive clear restores original material")
    _assert_eq(fallback.visible, true, "primitive clear restores visibility")
    host.free()
    await process_frame


func _new_host_with_fallback() -> Dictionary:
    var host := Node3D.new()
    root.add_child(host)
    var fallback := MeshInstance3D.new()
    fallback.name = "Fallback"
    fallback.mesh = BoxMesh.new()
    var material := StandardMaterial3D.new()
    material.albedo_color = Color(0.25, 0.5, 0.75)
    fallback.material_override = material
    host.add_child(fallback)
    return {"host": host, "fallback": fallback}


func _owned_child_count(host: Node3D) -> int:
    var count := 0
    for child in host.get_children():
        if bool(child.get_meta("scene_sync_adapter_owned", false)):
            count += 1
    return count


func _assert_true(condition: bool, test_name: String) -> void:
    _assert_eq(condition, true, test_name)


func _assert_eq(actual, expected, test_name: String) -> void:
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
    print("  Wire Asset Visual: PASSED=%d FAILED=%d" % [_passed, _failed])
    print("========================================")
    for error in _errors:
        print("  FAIL: %s" % error)
    quit(0 if _failed == 0 else 1)
