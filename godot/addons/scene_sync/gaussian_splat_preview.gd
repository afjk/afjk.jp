class_name SceneSyncGaussianSplatPreview
extends RefCounted

## KHR_gaussian_splatting GLB の依存ゼロプレビュー。
##
## splat を楕円として描くには専用 renderer（godot-gsplat 等）が必要だが、
## そのバックエンドが登録されていない環境でも「読み込んだものが見える」状態を保つため、
## POSITION / COLOR_0（または SH0 + OPACITY）だけを読み出して点群として描画する。
##
## これはあくまでプレビューであり、正式な描画は
## SceneSyncGaussianSplatBackend に登録されたバックエンドが担当する。

const PREVIEW_META := "scene_sync_gaussian_splat_preview"

## プレビューに使う最大点数。これを超える splat は間引く。
const MAX_PREVIEW_POINTS := 300000

const SH_C0 := 0.2820947917738781

const COMPONENT_BYTE := 5120
const COMPONENT_UNSIGNED_BYTE := 5121
const COMPONENT_SHORT := 5122
const COMPONENT_UNSIGNED_SHORT := 5123
const COMPONENT_UNSIGNED_INT := 5125
const COMPONENT_FLOAT := 5126

const TYPE_COMPONENT_COUNTS := {
    "SCALAR": 1,
    "VEC2": 2,
    "VEC3": 3,
    "VEC4": 4,
}


## GLB から点群プレビューを組み立てる。
## 戻り値: { "ok": bool, "node": Node3D, "pointCount": int, "reason": String }
static func build(data: PackedByteArray, info: Dictionary = {}) -> Dictionary:
    var parsed := SceneSyncGaussianSplatGlb.parse_glb(data)
    if not bool(parsed.get("ok", false)):
        return _failure(String(parsed.get("error", "glb-parse-failed")))

    var gltf := parsed["json"] as Dictionary
    var bin_offset := int(parsed.get("binOffset", -1))
    if bin_offset < 0:
        return _failure("glb-bin-chunk-missing")

    var inspected := info if bool(info.get("parsed", false)) else SceneSyncGaussianSplatGlb.inspect_gltf(gltf)
    var primitives := inspected.get("primitives", []) as Array
    if primitives.is_empty():
        return _failure("no-gaussian-splat-primitive")

    var positions := PackedVector3Array()
    var colors := PackedColorArray()

    for entry_value in primitives:
        if not (entry_value is Dictionary):
            continue
        var entry := entry_value as Dictionary
        var primitive := _primitive_at(gltf, int(entry.get("meshIndex", -1)), int(entry.get("primitiveIndex", -1)))
        if primitive.is_empty():
            continue
        var appended := _append_primitive(gltf, data, bin_offset, primitive, positions, colors)
        if appended != "":
            return _failure(appended)

    if positions.is_empty():
        return _failure("no-decodable-splat-attribute")

    var mesh := ArrayMesh.new()
    var arrays := []
    arrays.resize(Mesh.ARRAY_MAX)
    arrays[Mesh.ARRAY_VERTEX] = positions
    arrays[Mesh.ARRAY_COLOR] = colors
    mesh.add_surface_from_arrays(Mesh.PRIMITIVE_POINTS, arrays)

    var material := StandardMaterial3D.new()
    material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
    material.vertex_color_use_as_albedo = true
    material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
    material.use_point_size = true
    material.point_size = 3.0
    material.disable_receive_shadows = true
    mesh.surface_set_material(0, material)

    var instance := MeshInstance3D.new()
    instance.name = "GaussianSplatPreview"
    instance.mesh = mesh
    instance.set_meta(PREVIEW_META, true)

    return {
        "ok": true,
        "node": instance,
        "pointCount": positions.size(),
        "reason": "",
    }


static func _append_primitive(
    gltf: Dictionary,
    data: PackedByteArray,
    bin_offset: int,
    primitive: Dictionary,
    positions: PackedVector3Array,
    colors: PackedColorArray
) -> String:
    var attributes := _dictionary(primitive.get("attributes", {}))

    var position_values := _read_accessor(gltf, data, bin_offset, attributes.get("POSITION", null))
    if not bool(position_values.get("ok", false)):
        return String(position_values.get("reason", "position-unreadable"))
    if int(position_values.get("components", 0)) < 3:
        return "position-component-count"

    var count := int(position_values.get("count", 0))
    if count <= 0:
        return "empty-splat-primitive"

    var stride := maxi(1, ceili(float(count) / float(MAX_PREVIEW_POINTS)))
    var values := position_values["values"] as PackedFloat32Array
    var components := int(position_values.get("components", 3))

    var color_values := _read_optional_accessor(gltf, data, bin_offset, attributes.get("COLOR_0", null))
    var sh0_values := _read_optional_accessor(
        gltf, data, bin_offset, attributes.get("KHR_gaussian_splatting:SH_DEGREE_0_COEF_0", null)
    )
    var opacity_values := _read_optional_accessor(
        gltf, data, bin_offset, attributes.get("KHR_gaussian_splatting:OPACITY", null)
    )

    var index := 0
    while index < count:
        var base := index * components
        positions.append(Vector3(values[base], values[base + 1], values[base + 2]))
        colors.append(_color_at(index, color_values, sh0_values, opacity_values))
        index += stride

    return ""


static func _color_at(
    index: int,
    color_values: Dictionary,
    sh0_values: Dictionary,
    opacity_values: Dictionary
) -> Color:
    if bool(color_values.get("ok", false)):
        var color_components := int(color_values.get("components", 3))
        var color_array := color_values["values"] as PackedFloat32Array
        var color_base := index * color_components
        if color_base + color_components <= color_array.size():
            return Color(
                color_array[color_base],
                color_array[color_base + 1],
                color_array[color_base + 2],
                color_array[color_base + 3] if color_components >= 4 else 1.0
            )

    var rgb := Color(0.8, 0.8, 0.8, 1.0)
    if bool(sh0_values.get("ok", false)) and int(sh0_values.get("components", 0)) >= 3:
        var sh_array := sh0_values["values"] as PackedFloat32Array
        var sh_base := index * int(sh0_values.get("components", 3))
        if sh_base + 3 <= sh_array.size():
            rgb = Color(
                clampf(0.5 + SH_C0 * sh_array[sh_base], 0.0, 1.0),
                clampf(0.5 + SH_C0 * sh_array[sh_base + 1], 0.0, 1.0),
                clampf(0.5 + SH_C0 * sh_array[sh_base + 2], 0.0, 1.0),
                1.0
            )

    if bool(opacity_values.get("ok", false)):
        var opacity_array := opacity_values["values"] as PackedFloat32Array
        var opacity_base := index * int(opacity_values.get("components", 1))
        if opacity_base < opacity_array.size():
            rgb.a = clampf(opacity_array[opacity_base], 0.0, 1.0)

    return rgb


static func _read_optional_accessor(
    gltf: Dictionary,
    data: PackedByteArray,
    bin_offset: int,
    accessor_index
) -> Dictionary:
    if accessor_index == null:
        return {"ok": false, "reason": "absent"}
    return _read_accessor(gltf, data, bin_offset, accessor_index)


## accessor を float 配列として読み出す。
## sparse / 非 GLB buffer / 圧縮 bufferView は未対応（プレビューを諦める）。
static func _read_accessor(
    gltf: Dictionary,
    data: PackedByteArray,
    bin_offset: int,
    accessor_index
) -> Dictionary:
    if accessor_index == null:
        return _read_failure("accessor-missing")

    var accessors := _array(gltf.get("accessors", []))
    var index := int(accessor_index)
    if index < 0 or index >= accessors.size():
        return _read_failure("accessor-out-of-range")

    var accessor := _dictionary(accessors[index])
    if accessor.has("sparse"):
        return _read_failure("sparse-accessor-unsupported")

    var type_name := String(accessor.get("type", ""))
    if not TYPE_COMPONENT_COUNTS.has(type_name):
        return _read_failure("accessor-type-unsupported")
    var components := int(TYPE_COMPONENT_COUNTS[type_name])

    var component_type := int(accessor.get("componentType", 0))
    var component_size := _component_size(component_type)
    if component_size <= 0:
        return _read_failure("component-type-unsupported")

    var count := int(accessor.get("count", 0))
    if count <= 0:
        return _read_failure("accessor-empty")

    if not accessor.has("bufferView"):
        # bufferView 省略時は全ゼロ。プレビューでは扱わない。
        return _read_failure("accessor-without-buffer-view")

    var buffer_views := _array(gltf.get("bufferViews", []))
    var buffer_view_index := int(accessor.get("bufferView", -1))
    if buffer_view_index < 0 or buffer_view_index >= buffer_views.size():
        return _read_failure("buffer-view-out-of-range")

    var buffer_view := _dictionary(buffer_views[buffer_view_index])
    if _dictionary(buffer_view.get("extensions", {})).size() > 0:
        return _read_failure("compressed-buffer-view-unsupported")
    if int(buffer_view.get("buffer", 0)) != 0:
        return _read_failure("external-buffer-unsupported")

    var buffers := _array(gltf.get("buffers", []))
    if buffers.is_empty() or _dictionary(buffers[0]).has("uri"):
        return _read_failure("external-buffer-unsupported")

    var element_size := component_size * components
    var byte_stride := int(buffer_view.get("byteStride", 0))
    if byte_stride <= 0:
        byte_stride = element_size
    if byte_stride < element_size:
        return _read_failure("invalid-byte-stride")

    var start := bin_offset + int(buffer_view.get("byteOffset", 0)) + int(accessor.get("byteOffset", 0))
    var required := start + byte_stride * (count - 1) + element_size
    if start < 0 or required > data.size():
        return _read_failure("accessor-out-of-bounds")

    var normalized := bool(accessor.get("normalized", false))
    var values := PackedFloat32Array()
    values.resize(count * components)

    for element in count:
        var element_offset := start + element * byte_stride
        for component in components:
            var offset := element_offset + component * component_size
            values[element * components + component] = _decode_component(
                data, offset, component_type, normalized
            )

    return {
        "ok": true,
        "values": values,
        "count": count,
        "components": components,
        "reason": "",
    }


static func _decode_component(
    data: PackedByteArray,
    offset: int,
    component_type: int,
    normalized: bool
) -> float:
    match component_type:
        COMPONENT_FLOAT:
            return data.decode_float(offset)
        COMPONENT_UNSIGNED_BYTE:
            var u8 := float(data.decode_u8(offset))
            return u8 / 255.0 if normalized else u8
        COMPONENT_BYTE:
            var s8 := float(data.decode_s8(offset))
            return maxf(s8 / 127.0, -1.0) if normalized else s8
        COMPONENT_UNSIGNED_SHORT:
            var u16 := float(data.decode_u16(offset))
            return u16 / 65535.0 if normalized else u16
        COMPONENT_SHORT:
            var s16 := float(data.decode_s16(offset))
            return maxf(s16 / 32767.0, -1.0) if normalized else s16
        COMPONENT_UNSIGNED_INT:
            return float(data.decode_u32(offset))
    return 0.0


static func _component_size(component_type: int) -> int:
    match component_type:
        COMPONENT_BYTE, COMPONENT_UNSIGNED_BYTE:
            return 1
        COMPONENT_SHORT, COMPONENT_UNSIGNED_SHORT:
            return 2
        COMPONENT_UNSIGNED_INT, COMPONENT_FLOAT:
            return 4
    return 0


static func _primitive_at(gltf: Dictionary, mesh_index: int, primitive_index: int) -> Dictionary:
    var meshes := _array(gltf.get("meshes", []))
    if mesh_index < 0 or mesh_index >= meshes.size():
        return {}
    var primitives := _array(_dictionary(meshes[mesh_index]).get("primitives", []))
    if primitive_index < 0 or primitive_index >= primitives.size():
        return {}
    return _dictionary(primitives[primitive_index])


static func _failure(reason: String) -> Dictionary:
    return {"ok": false, "node": null, "pointCount": 0, "reason": reason}


static func _read_failure(reason: String) -> Dictionary:
    return {"ok": false, "values": PackedFloat32Array(), "count": 0, "components": 0, "reason": reason}


static func _array(value) -> Array:
    return value as Array if value is Array else []


static func _dictionary(value) -> Dictionary:
    return value as Dictionary if value is Dictionary else {}
