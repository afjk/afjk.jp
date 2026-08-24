class_name SceneSyncGaussianSplatGlb
extends RefCounted

## KHR_gaussian_splatting GLB の検査（依存ゼロ）。
##
## SceneSync の 3DGS 交換形式は GLB + KHR_gaussian_splatting に統一されている。
## Godot 標準の GLTFDocument はこの拡張を知らないため、GLB を
## append_from_file() へ渡す前にここで判定し、Gaussian Splat backend へ振り分ける。
##
## 判定ロジックは Web 実装
## html/assets/js/scenesync/loaders/khr-gaussian-splatting.js と同じ規則にそろえている。

const EXTENSION_NAME := "KHR_gaussian_splatting"

const REQUIRED_ATTRIBUTES := [
    "POSITION",
    "KHR_gaussian_splatting:ROTATION",
    "KHR_gaussian_splatting:SCALE",
    "KHR_gaussian_splatting:OPACITY",
    "KHR_gaussian_splatting:SH_DEGREE_0_COEF_0",
]

const SUPPORTED_KERNELS := ["ellipse"]
const SUPPORTED_COLOR_SPACES := ["srgb_rec709_display", "lin_rec709_display"]
const SUPPORTED_PROJECTIONS := ["perspective"]
const SUPPORTED_SORTING_METHODS := ["cameraDistance"]

const GLB_MAGIC := 0x46546C67
const GLB_JSON_CHUNK_TYPE := 0x4E4F534A
const GLB_BIN_CHUNK_TYPE := 0x004E4942
const GLB_VERSION := 2
const GLTF_POINTS_MODE := 0
const GLB_HEADER_SIZE := 12
const GLB_CHUNK_HEADER_SIZE := 8


## GLB バイト列から JSON chunk を取り出す。
## 戻り値: { "ok": bool, "json": Dictionary, "error": String }
static func parse_glb_json(data: PackedByteArray) -> Dictionary:
    var parsed := parse_glb(data)
    return {
        "ok": parsed.get("ok", false),
        "json": parsed.get("json", {}),
        "error": parsed.get("error", ""),
    }


## GLB バイト列を JSON chunk と BIN chunk の位置へ分解する。
## 戻り値: { "ok": bool, "json": Dictionary, "binOffset": int, "binLength": int, "error": String }
static func parse_glb(data: PackedByteArray) -> Dictionary:
    if data.size() < GLB_HEADER_SIZE + GLB_CHUNK_HEADER_SIZE:
        return _parse_failure("GLB is too short")
    if data.decode_u32(0) != GLB_MAGIC:
        return _parse_failure("Invalid GLB magic")
    if data.decode_u32(4) != GLB_VERSION:
        return _parse_failure("Only GLB 2.0 is supported")

    var declared_length := int(data.decode_u32(8))
    if declared_length > data.size() or declared_length < GLB_HEADER_SIZE + GLB_CHUNK_HEADER_SIZE:
        return _parse_failure("Invalid GLB length")

    var json_chunk: Dictionary = {}
    var has_json := false
    var bin_offset := -1
    var bin_length := 0

    var offset := GLB_HEADER_SIZE
    while offset + GLB_CHUNK_HEADER_SIZE <= declared_length:
        var chunk_length := int(data.decode_u32(offset))
        var chunk_type := int(data.decode_u32(offset + 4))
        var chunk_start := offset + GLB_CHUNK_HEADER_SIZE
        var chunk_end := chunk_start + chunk_length
        if chunk_end > declared_length:
            return _parse_failure("Invalid GLB chunk length")

        if chunk_type == GLB_JSON_CHUNK_TYPE and not has_json:
            var text := data.slice(chunk_start, chunk_end).get_string_from_utf8()
            var parsed = JSON.parse_string(text.strip_edges())
            if not (parsed is Dictionary):
                return _parse_failure("GLB JSON chunk is not an object")
            json_chunk = parsed as Dictionary
            has_json = true
        elif chunk_type == GLB_BIN_CHUNK_TYPE and bin_offset < 0:
            bin_offset = chunk_start
            bin_length = chunk_length

        offset = chunk_end

    if not has_json:
        return _parse_failure("GLB JSON chunk not found")

    return {
        "ok": true,
        "json": json_chunk,
        "binOffset": bin_offset,
        "binLength": bin_length,
        "error": "",
    }


## GLB バイト列を検査する。詳細は inspect_gltf() を参照。
static func inspect(data: PackedByteArray) -> Dictionary:
    var parsed := parse_glb_json(data)
    if not bool(parsed.get("ok", false)):
        var result := _empty_result()
        result["errors"] = PackedStringArray([String(parsed.get("error", "GLB parse failed"))])
        result["parsed"] = false
        return result

    var result := inspect_gltf(parsed["json"] as Dictionary)
    result["byteLength"] = data.size()
    return result


## glTF JSON を検査する。
## 戻り値のキー:
##   parsed                  JSON chunk を読めたか
##   hasGaussianSplatting    KHR_gaussian_splatting primitive を1つ以上含むか
##   extensionDeclared       extensionsUsed に宣言されているか
##   extensionRequired       extensionsRequired に含まれるか
##   hasRegularMeshPrimitive 通常 mesh primitive を併せ持つか（混在 GLB）
##   splatCount              splat 総数（POSITION accessor の count 合計）
##   primitives              primitive ごとの検査結果
##   warnings / errors       診断メッセージ
##   valid                   Gaussian Splat として読み込んでよいか
static func inspect_gltf(gltf: Dictionary) -> Dictionary:
    var result := _empty_result()
    result["parsed"] = true

    var extensions_used := _string_array(gltf.get("extensionsUsed", []))
    var extensions_required := _string_array(gltf.get("extensionsRequired", []))
    result["extensionDeclared"] = extensions_used.has(EXTENSION_NAME)
    result["extensionRequired"] = extensions_required.has(EXTENSION_NAME)

    var accessors := _array(gltf.get("accessors", []))
    var meshes := _array(gltf.get("meshes", []))
    var primitives: Array[Dictionary] = []
    var warnings := PackedStringArray()
    var errors := PackedStringArray()
    var has_regular := false
    var splat_count := 0

    for mesh_index in meshes.size():
        var mesh_value = meshes[mesh_index]
        if not (mesh_value is Dictionary):
            continue
        var mesh_primitives := _array((mesh_value as Dictionary).get("primitives", []))
        for primitive_index in mesh_primitives.size():
            var primitive_value = mesh_primitives[primitive_index]
            if not (primitive_value is Dictionary):
                continue
            var primitive := primitive_value as Dictionary
            var extension := _dictionary(_dictionary(primitive.get("extensions", {})).get(EXTENSION_NAME, {}))
            if not _has_extension(primitive):
                has_regular = true
                continue

            var entry := _inspect_primitive(primitive, extension, accessors, mesh_index, primitive_index)
            primitives.append(entry)
            splat_count += int(entry.get("splatCount", 0))

            var label := "meshes[%d].primitives[%d]" % [mesh_index, primitive_index]
            if not bool(entry.get("validMode", false)):
                errors.append("%s: mode must be POINTS (0)" % label)
            var missing := entry.get("missingAttributes", PackedStringArray()) as PackedStringArray
            if not missing.is_empty():
                errors.append("%s: missing required attributes: %s" % [label, ", ".join(missing)])
            if not bool(entry.get("supportedKernel", false)):
                warnings.append("%s: unknown kernel %s" % [label, String(entry.get("kernel", ""))])
            if not bool(entry.get("supportedColorSpace", false)):
                warnings.append("%s: unknown colorSpace %s" % [label, String(entry.get("colorSpace", ""))])
            if not bool(entry.get("supportedProjection", false)):
                warnings.append("%s: unsupported projection %s" % [label, String(entry.get("projection", ""))])
            if not bool(entry.get("supportedSortingMethod", false)):
                warnings.append("%s: unsupported sortingMethod %s" % [label, String(entry.get("sortingMethod", ""))])

    if not primitives.is_empty() and not bool(result["extensionDeclared"]):
        errors.append("%s primitive exists but extensionsUsed does not declare it" % EXTENSION_NAME)

    result["hasGaussianSplatting"] = not primitives.is_empty()
    result["hasRegularMeshPrimitive"] = has_regular
    result["splatCount"] = splat_count
    result["primitives"] = primitives
    result["warnings"] = warnings
    result["errors"] = errors
    result["valid"] = not primitives.is_empty() and errors.is_empty()
    return result


## 1行の診断文字列。ログ用。
static func describe(info: Dictionary) -> String:
    if not bool(info.get("hasGaussianSplatting", false)):
        return "no KHR_gaussian_splatting primitive"
    return "splats=%d, primitives=%d, mixedWithMesh=%s, valid=%s, errors=[%s], warnings=[%s]" % [
        int(info.get("splatCount", 0)),
        (info.get("primitives", []) as Array).size(),
        str(bool(info.get("hasRegularMeshPrimitive", false))),
        str(bool(info.get("valid", false))),
        ", ".join(info.get("errors", PackedStringArray()) as PackedStringArray),
        ", ".join(info.get("warnings", PackedStringArray()) as PackedStringArray),
    ]


static func _inspect_primitive(
    primitive: Dictionary,
    extension: Dictionary,
    accessors: Array,
    mesh_index: int,
    primitive_index: int
) -> Dictionary:
    var attributes := _dictionary(primitive.get("attributes", {}))
    var missing := PackedStringArray()
    for semantic in REQUIRED_ATTRIBUTES:
        var accessor_index = attributes.get(semantic, null)
        if not _is_accessor_index(accessor_index):
            missing.append(String(semantic))

    var kernel := _optional_string(extension.get("kernel", null))
    var color_space := _optional_string(extension.get("colorSpace", null))
    var projection := _optional_string(extension.get("projection", null))
    var sorting_method := _optional_string(extension.get("sortingMethod", null))

    return {
        "meshIndex": mesh_index,
        "primitiveIndex": primitive_index,
        "splatCount": _accessor_count(accessors, attributes.get("POSITION", null)),
        "kernel": kernel,
        "colorSpace": color_space,
        "projection": projection,
        "sortingMethod": sorting_method,
        "missingAttributes": missing,
        "validMode": int(primitive.get("mode", 4)) == GLTF_POINTS_MODE,
        "supportedKernel": SUPPORTED_KERNELS.has(kernel),
        "supportedColorSpace": SUPPORTED_COLOR_SPACES.has(color_space),
        # projection / sortingMethod は省略可能。省略時は既定値とみなす。
        "supportedProjection": projection == "" or SUPPORTED_PROJECTIONS.has(projection),
        "supportedSortingMethod": sorting_method == "" or SUPPORTED_SORTING_METHODS.has(sorting_method),
    }


static func _has_extension(primitive: Dictionary) -> bool:
    var extensions = primitive.get("extensions", null)
    if not (extensions is Dictionary):
        return false
    return (extensions as Dictionary).has(EXTENSION_NAME)


static func _accessor_count(accessors: Array, accessor_index) -> int:
    if not _is_accessor_index(accessor_index):
        return 0
    var index := int(accessor_index)
    if index < 0 or index >= accessors.size():
        return 0
    var accessor = accessors[index]
    if not (accessor is Dictionary):
        return 0
    return int((accessor as Dictionary).get("count", 0))


static func _is_accessor_index(value) -> bool:
    if value is int:
        return true
    # JSON.parse_string() は整数を float で返す場合がある
    if value is float:
        return is_equal_approx(value, roundf(value))
    return false


static func _empty_result() -> Dictionary:
    return {
        "parsed": false,
        "hasGaussianSplatting": false,
        "extensionDeclared": false,
        "extensionRequired": false,
        "hasRegularMeshPrimitive": false,
        "splatCount": 0,
        "byteLength": 0,
        "primitives": [] as Array[Dictionary],
        "warnings": PackedStringArray(),
        "errors": PackedStringArray(),
        "valid": false,
    }


static func _parse_failure(message: String) -> Dictionary:
    return {"ok": false, "json": {}, "binOffset": -1, "binLength": 0, "error": message}


static func _array(value) -> Array:
    return value as Array if value is Array else []


static func _dictionary(value) -> Dictionary:
    return value as Dictionary if value is Dictionary else {}


static func _string_array(value) -> PackedStringArray:
    var result := PackedStringArray()
    for entry in _array(value):
        result.append(String(entry))
    return result


static func _optional_string(value) -> String:
    return "" if value == null else String(value)
