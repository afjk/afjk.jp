class_name SceneSyncWireAssetVisual
extends RefCounted

const OWNED_META := "scene_sync_adapter_owned"
const APPLIED_TYPE_META := "scene_sync_adapter_applied_type"
const FALLBACK_SNAPSHOT_META := "scene_sync_adapter_fallback_snapshot"
const PRIMITIVE_OVERRIDE_META := "scene_sync_adapter_primitive_override"

const MAX_TEXT_LENGTH := 512
const MAX_IMAGE_DIMENSION := 8192
const MAX_IMAGE_PIXELS := 32 * 1024 * 1024
const TEXT_PIXEL_SIZE := 1.0 / 512.0
const DEFAULT_PANEL_WIDTH := 2.4
const DEFAULT_PANEL_HEIGHT := 1.6
const DEFAULT_TEXT_PADDING := 0.08
const DEFAULT_FONT_SIZE := 42
const DEFAULT_LINE_HEIGHT := 1.35
const DEFAULT_PRIMITIVE_COLOR := "#888888"


static func apply_glb_bytes(host: Node3D, data: PackedByteArray, asset: Dictionary = {}) -> Dictionary:
    if not _is_valid_host(host):
        return _failure("invalid-host")
    if data.is_empty():
        return _failure("empty-body")

    var visual := SceneSyncGltfHelper.import_glb(data)
    if visual == null:
        return _failure("glb-import-failed")

    visual.name = "RemoteAssetVisual"
    visual.set_meta(OWNED_META, true)
    if _safe_string(asset.get("visualBasis", "")).strip_edges().to_lower() == "unity":
        visual.rotation = Vector3(0.0, PI, 0.0)

    _replace_owned_visual(host, visual, "mesh")
    return _success(visual, {
        "assetType": "mesh",
        "bytes": data.size(),
    })


static func apply_image_bytes(host: Node3D, data: PackedByteArray) -> Dictionary:
    if not _is_valid_host(host):
        return _failure("invalid-host")
    if data.is_empty():
        return _failure("empty-body")

    var image := Image.new()
    var decode_error := ERR_FILE_UNRECOGNIZED
    var format := ""
    if _is_png(data):
        format = "png"
        decode_error = image.load_png_from_buffer(data)
    elif _is_jpeg(data):
        format = "jpeg"
        decode_error = image.load_jpg_from_buffer(data)
    elif _is_webp(data):
        format = "webp"
        decode_error = image.load_webp_from_buffer(data)

    if decode_error != OK or image.is_empty():
        return _failure("image-decode-failed")
    if not _image_dimensions_within_budget(image.get_width(), image.get_height()):
        return _failure("image-dimensions-exceeded")

    var visual := MeshInstance3D.new()
    visual.name = "RemoteImageVisual"
    visual.set_meta(OWNED_META, true)

    var quad := QuadMesh.new()
    var aspect := float(image.get_width()) / maxf(float(image.get_height()), 1.0)
    quad.size = (
        Vector2(2.0, maxf(2.0 / aspect, 0.1))
        if aspect >= 1.0
        else Vector2(maxf(2.0 * aspect, 0.1), 2.0)
    )
    visual.mesh = quad

    var material := StandardMaterial3D.new()
    material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
    material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
    material.cull_mode = BaseMaterial3D.CULL_DISABLED
    material.albedo_texture = ImageTexture.create_from_image(image)
    visual.material_override = material

    _replace_owned_visual(host, visual, "image")
    return _success(visual, {
        "assetType": "image",
        "bytes": data.size(),
        "format": format,
        "width": image.get_width(),
        "height": image.get_height(),
    })


static func apply_text(host: Node3D, asset: Dictionary, text_value: Variant = null) -> Dictionary:
    if not _is_valid_host(host):
        return _failure("invalid-host")

    var text := _safe_string(text_value, _safe_string(asset.get("text", "")))
    var truncated := false
    if text.length() > MAX_TEXT_LENGTH:
        text = text.left(MAX_TEXT_LENGTH)
        truncated = true

    var layout := _safe_dictionary(asset.get("layout", {}))
    var asset_width := _safe_float(asset.get("width", DEFAULT_PANEL_WIDTH), DEFAULT_PANEL_WIDTH)
    var asset_height := _safe_float(asset.get("height", DEFAULT_PANEL_HEIGHT), DEFAULT_PANEL_HEIGHT)
    var width_m := _safe_float(layout.get("width", asset_width), asset_width)
    var height_m := _safe_float(layout.get("height", asset_height), asset_height)
    width_m = clampf(width_m, 0.05, 100.0)
    height_m = clampf(height_m, 0.05, 100.0)

    var padding_value = layout.get("padding", null)
    if padding_value == null:
        padding_value = asset.get("padding", DEFAULT_TEXT_PADDING)
    var padding := _layout_padding(padding_value)
    var content_width_m := maxf(width_m - padding.x - padding.z, TEXT_PIXEL_SIZE * 16.0)

    var visual := Node3D.new()
    visual.name = "RemoteTextVisual"
    visual.set_meta(OWNED_META, true)

    var background := MeshInstance3D.new()
    background.name = "RemoteTextBackground"
    background.set_meta(OWNED_META, true)
    var quad := QuadMesh.new()
    quad.size = Vector2(width_m, height_m)
    background.mesh = quad

    var background_material := StandardMaterial3D.new()
    background_material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
    background_material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
    background_material.cull_mode = BaseMaterial3D.CULL_DISABLED
    background_material.albedo_color = _parse_css_color(
        asset.get("backgroundColor", null),
        Color(0.0, 0.0, 0.0, 0.65)
    )
    background.material_override = background_material
    visual.add_child(background)

    var label := Label3D.new()
    label.name = "RemoteTextLabel"
    label.set_meta(OWNED_META, true)
    label.text = text
    label.pixel_size = TEXT_PIXEL_SIZE
    var asset_font_size := _safe_float(asset.get("fontSize", DEFAULT_FONT_SIZE), float(DEFAULT_FONT_SIZE))
    label.font_size = int(round(clampf(
        _safe_float(
            layout.get("fontSize", asset_font_size),
            asset_font_size
        ),
        12.0,
        96.0
    )))
    label.width = maxi(int(round(content_width_m / TEXT_PIXEL_SIZE)), 16)
    label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
    label.modulate = _parse_css_color(asset.get("color", null), Color.WHITE)
    label.outline_size = 6
    label.position = Vector3(
        (padding.x - padding.z) * 0.5,
        (padding.w - padding.y) * 0.5,
        0.003
    )

    var scroll_value = layout.get("scroll", null)
    if not (scroll_value is Dictionary):
        scroll_value = asset.get("scroll", {})
    var scroll := _safe_dictionary(scroll_value)
    label.position.y += clampf(_safe_float(scroll.get("y", 0.0), 0.0), -10000.0, 10000.0)
    var asset_line_height := _safe_float(
        asset.get("lineHeight", DEFAULT_LINE_HEIGHT),
        DEFAULT_LINE_HEIGHT
    )
    var line_height := clampf(
        _safe_float(
            layout.get("lineHeight", asset_line_height),
            asset_line_height
        ),
        0.5,
        4.0
    )
    label.line_spacing = int(round(float(label.font_size) * (line_height - 1.0)))

    var alignment := _first_safe_string([
        asset.get("align", null),
        layout.get("alignment", null),
        asset.get("alignment", null),
    ], "center").strip_edges().to_lower()
    match alignment:
        "left":
            label.horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT
        "right":
            label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
        _:
            label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
    visual.add_child(label)

    _replace_owned_visual(host, visual, "text")
    return _success(visual, {
        "assetType": "text",
        "characters": text.length(),
        "truncated": truncated,
    })


static func apply_primitive(host: Node3D, asset: Dictionary) -> Dictionary:
    if not _is_valid_host(host):
        return _failure("invalid-host")

    clear_owned_visual(host)
    var primitive_name := _safe_string(asset.get("primitive", "box"), "box").strip_edges().to_lower()
    var mesh := _mesh_for_primitive(primitive_name)
    if mesh == null:
        primitive_name = "box"
        mesh = BoxMesh.new()

    var target := _find_fallback_mesh(host)
    if target == null:
        target = MeshInstance3D.new()
        target.name = "RemotePrimitiveVisual"
        target.set_meta(OWNED_META, true)
        host.add_child(target)
    else:
        _save_fallback_snapshot(target)
        target.visible = true
        target.set_meta(PRIMITIVE_OVERRIDE_META, true)

    target.mesh = mesh
    var material := StandardMaterial3D.new()
    material.albedo_color = _parse_css_color(
        asset.get("color", null),
        Color.from_string(DEFAULT_PRIMITIVE_COLOR, Color(0.53, 0.53, 0.53))
    )
    target.material_override = material
    host.set_meta(APPLIED_TYPE_META, "primitive")
    return _success(target, {
        "assetType": "primitive",
        "primitive": primitive_name,
    })


static func clear_owned_visual(host: Node3D) -> void:
    if not _is_valid_host(host):
        return
    _clear_owned_children(host)
    _restore_fallback(host)
    if host.has_meta(APPLIED_TYPE_META):
        host.remove_meta(APPLIED_TYPE_META)


static func _replace_owned_visual(host: Node3D, visual: Node3D, asset_type: String) -> void:
    _clear_owned_children(host)
    _restore_fallback(host)
    _hide_fallback(host)
    host.add_child(visual)
    host.set_meta(APPLIED_TYPE_META, asset_type)


static func _clear_owned_children(host: Node3D) -> void:
    for child in host.get_children():
        if child is Node and bool((child as Node).get_meta(OWNED_META, false)):
            host.remove_child(child)
            (child as Node).queue_free()


static func _hide_fallback(host: Node3D) -> void:
    var fallback := _find_fallback_mesh(host)
    if fallback == null:
        return
    _save_fallback_snapshot(fallback)
    if fallback == host:
        fallback.mesh = null
        fallback.material_override = null
    else:
        fallback.visible = false


static func _save_fallback_snapshot(fallback: MeshInstance3D) -> void:
    if fallback.has_meta(FALLBACK_SNAPSHOT_META):
        return
    fallback.set_meta(FALLBACK_SNAPSHOT_META, {
        "mesh": fallback.mesh,
        "materialOverride": fallback.material_override,
        "visible": fallback.visible,
    })


static func _restore_fallback(host: Node3D) -> void:
    var fallback := _find_fallback_mesh(host)
    if fallback == null or not fallback.has_meta(FALLBACK_SNAPSHOT_META):
        return
    var snapshot_value = fallback.get_meta(FALLBACK_SNAPSHOT_META)
    fallback.remove_meta(FALLBACK_SNAPSHOT_META)
    if not (snapshot_value is Dictionary):
        return
    var snapshot := snapshot_value as Dictionary
    var mesh_value = snapshot.get("mesh", null)
    if mesh_value is Mesh:
        fallback.mesh = mesh_value as Mesh
    else:
        fallback.mesh = null
    var material_value = snapshot.get("materialOverride", null)
    if material_value is Material:
        fallback.material_override = material_value as Material
    else:
        fallback.material_override = null
    fallback.visible = _safe_bool(snapshot.get("visible", true), true)
    if fallback.has_meta(PRIMITIVE_OVERRIDE_META):
        fallback.remove_meta(PRIMITIVE_OVERRIDE_META)


static func _find_fallback_mesh(host: Node3D) -> MeshInstance3D:
    if host is MeshInstance3D and not bool(host.get_meta(OWNED_META, false)):
        return host as MeshInstance3D
    for child in host.get_children():
        if child is MeshInstance3D and not bool((child as Node).get_meta(OWNED_META, false)):
            return child as MeshInstance3D
    return null


static func _mesh_for_primitive(primitive_name: String) -> Mesh:
    match primitive_name:
        "box":
            return BoxMesh.new()
        "sphere":
            return SphereMesh.new()
        "cylinder":
            return CylinderMesh.new()
        "cone":
            var cone := CylinderMesh.new()
            cone.top_radius = 0.0
            return cone
        "plane":
            return PlaneMesh.new()
        "torus":
            return TorusMesh.new()
        "capsule":
            return CapsuleMesh.new()
        _:
            return null


static func _layout_padding(value: Variant) -> Vector4:
    if value is Dictionary:
        var dictionary := value as Dictionary
        var horizontal := clampf(_safe_float(dictionary.get("horizontal", 0.0), 0.0), 0.0, 100.0)
        var vertical := clampf(_safe_float(dictionary.get("vertical", horizontal), horizontal), 0.0, 100.0)
        return Vector4(
            clampf(_safe_float(dictionary.get("left", horizontal), horizontal), 0.0, 100.0),
            clampf(_safe_float(dictionary.get("top", vertical), vertical), 0.0, 100.0),
            clampf(_safe_float(dictionary.get("right", horizontal), horizontal), 0.0, 100.0),
            clampf(_safe_float(dictionary.get("bottom", vertical), vertical), 0.0, 100.0)
        )
    var padding := clampf(_safe_float(value, DEFAULT_TEXT_PADDING), 0.0, 100.0)
    return Vector4(padding, padding, padding, padding)


static func _parse_css_color(value: Variant, fallback: Color) -> Color:
    var text := _safe_string(value).strip_edges().to_lower()
    if text.begins_with("#") and text.length() in [4, 7, 9] and _is_hex_string(text.substr(1)):
        return Color.from_string(text, fallback)

    var is_rgba := text.begins_with("rgba(") and text.ends_with(")")
    var is_rgb := text.begins_with("rgb(") and text.ends_with(")")
    if not is_rgb and not is_rgba:
        return fallback

    var start := 5 if is_rgba else 4
    var parts := text.substr(start, text.length() - start - 1).split(",")
    if parts.size() != (4 if is_rgba else 3):
        return fallback

    var channels: Array[float] = []
    for index in 3:
        var channel_text := parts[index].strip_edges()
        if not channel_text.is_valid_float():
            return fallback
        var channel := float(channel_text)
        if is_nan(channel) or is_inf(channel):
            return fallback
        channels.append(clampf(channel / 255.0, 0.0, 1.0))

    var alpha := 1.0
    if is_rgba:
        var alpha_text := parts[3].strip_edges()
        if not alpha_text.is_valid_float():
            return fallback
        alpha = float(alpha_text)
        if is_nan(alpha) or is_inf(alpha):
            return fallback
        if alpha > 1.0:
            alpha /= 255.0

    return Color(channels[0], channels[1], channels[2], clampf(alpha, 0.0, 1.0))


static func _is_hex_string(value: String) -> bool:
    if value == "":
        return false
    const HEX := "0123456789abcdef"
    for index in value.length():
        if HEX.find(value.substr(index, 1).to_lower()) < 0:
            return false
    return true


static func _safe_dictionary(value: Variant) -> Dictionary:
    if value is Dictionary:
        return value as Dictionary
    return {}


static func _safe_string(value: Variant, fallback: String = "") -> String:
    if value is String:
        return value
    if value is StringName:
        return String(value)
    return fallback


static func _first_safe_string(values: Array, fallback: String = "") -> String:
    for value in values:
        var result := _safe_string(value)
        if result != "":
            return result
    return fallback


static func _safe_float(value: Variant, fallback: float) -> float:
    var result := fallback
    if value is int or value is float:
        result = float(value)
    elif value is String:
        var text := String(value)
        if text.is_valid_float():
            result = float(text)
    if is_nan(result) or is_inf(result):
        return fallback
    return result


static func _safe_bool(value: Variant, fallback: bool) -> bool:
    return value if value is bool else fallback


static func _image_dimensions_within_budget(width: int, height: int) -> bool:
    return (
        width > 0
        and height > 0
        and width <= MAX_IMAGE_DIMENSION
        and height <= MAX_IMAGE_DIMENSION
        and width * height <= MAX_IMAGE_PIXELS
    )


static func _is_valid_host(host: Node3D) -> bool:
    return host != null and is_instance_valid(host)


static func _is_png(data: PackedByteArray) -> bool:
    return (
        data.size() >= 8
        and data[0] == 0x89
        and data[1] == 0x50
        and data[2] == 0x4e
        and data[3] == 0x47
        and data[4] == 0x0d
        and data[5] == 0x0a
        and data[6] == 0x1a
        and data[7] == 0x0a
    )


static func _is_jpeg(data: PackedByteArray) -> bool:
    return data.size() >= 3 and data[0] == 0xff and data[1] == 0xd8 and data[2] == 0xff


static func _is_webp(data: PackedByteArray) -> bool:
    return (
        data.size() >= 12
        and data[0] == 0x52
        and data[1] == 0x49
        and data[2] == 0x46
        and data[3] == 0x46
        and data[8] == 0x57
        and data[9] == 0x45
        and data[10] == 0x42
        and data[11] == 0x50
    )


static func _success(node: Node3D, details: Dictionary = {}) -> Dictionary:
    var result := {
        "ok": true,
        "node": node,
    }
    for key in details.keys():
        result[key] = details[key]
    return result


static func _failure(reason: String) -> Dictionary:
    return {
        "ok": false,
        "reason": reason,
    }
