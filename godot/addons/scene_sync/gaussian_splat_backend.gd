class_name SceneSyncGaussianSplatBackend
extends RefCounted

## Gaussian Splat renderer のバックエンド登録。
##
## Scene-Sync-Godot は 3DGS の parser も renderer も自前では持たない。
## KHR_gaussian_splatting GLB を検出したら、ここに登録されたバックエンド
## （godot-gsplat 等）へバイト列をそのまま渡す。
##
## バックエンドは次のメソッドを持つ Object であればよい（duck typing）:
##
##   get_backend_name() -> String
##   can_render(info: Dictionary) -> bool
##   create_splat_node(data: PackedByteArray, info: Dictionary) -> Node3D
##
## バックエンドが未登録、または can_render() が false を返した場合は
## SceneSyncGaussianSplatPreview の点群プレビューへフォールバックする。
## Editor / Runtime のどちらでも同じ経路を通る。

const REQUIRED_METHODS := ["get_backend_name", "can_render", "create_splat_node"]

const SOURCE_BACKEND := "backend"
const SOURCE_PREVIEW := "preview"

## 生成されたノードに付く meta。Scene Sync が所有権を判定するために使う。
const SPLAT_NODE_META := "scene_sync_gaussian_splat"
const SPLAT_SOURCE_META := "scene_sync_gaussian_splat_source"

static var _backend: Object = null


## バックエンドを登録する。必要なメソッドが欠けている場合は false。
static func register_backend(backend: Object) -> bool:
    if backend == null:
        return false
    for method in REQUIRED_METHODS:
        if not backend.has_method(method):
            push_warning(
                "[SceneSync] Gaussian Splat backend is missing required method: %s" % method
            )
            return false
    _backend = backend
    print("[SceneSync] Gaussian Splat backend registered: %s" % backend_name())
    return true


static func unregister_backend() -> void:
    _backend = null


static func get_backend() -> Object:
    if _backend != null and not is_instance_valid(_backend):
        _backend = null
    return _backend


static func is_available() -> bool:
    return get_backend() != null


static func backend_name() -> String:
    var backend := get_backend()
    if backend == null:
        return ""
    return String(backend.call("get_backend_name"))


## Gaussian Splat の視覚ノードを生成する。
## 戻り値: {
##   "ok": bool, "node": Node3D, "source": "backend" | "preview",
##   "backendName": String, "pointCount": int, "reason": String
## }
static func create_visual(data: PackedByteArray, info: Dictionary = {}) -> Dictionary:
    var inspected := info
    if not bool(inspected.get("parsed", false)):
        inspected = SceneSyncGaussianSplatGlb.inspect(data)

    if not bool(inspected.get("hasGaussianSplatting", false)):
        return _failure("not-a-gaussian-splat-glb")

    for message in inspected.get("errors", PackedStringArray()) as PackedStringArray:
        push_warning("[SceneSync] Gaussian Splat GLB error: %s" % message)
    for message in inspected.get("warnings", PackedStringArray()) as PackedStringArray:
        push_warning("[SceneSync] Gaussian Splat GLB warning: %s" % message)

    if not bool(inspected.get("valid", false)):
        return _failure("invalid-gaussian-splat-glb")

    var backend := get_backend()
    if backend != null and bool(backend.call("can_render", inspected)):
        var node = backend.call("create_splat_node", data, inspected)
        if node is Node3D:
            var splat_node := node as Node3D
            _tag(splat_node, SOURCE_BACKEND)
            return {
                "ok": true,
                "node": splat_node,
                "source": SOURCE_BACKEND,
                "backendName": backend_name(),
                "pointCount": int(inspected.get("splatCount", 0)),
                "reason": "",
            }
        push_warning(
            "[SceneSync] Gaussian Splat backend '%s' returned no Node3D; falling back to preview"
            % backend_name()
        )

    var preview := SceneSyncGaussianSplatPreview.build(data, inspected)
    if not bool(preview.get("ok", false)):
        return _failure(String(preview.get("reason", "preview-failed")))

    var preview_node := preview["node"] as Node3D
    _tag(preview_node, SOURCE_PREVIEW)
    if backend == null:
        print(
            "[SceneSync] No Gaussian Splat backend registered; showing point-cloud preview (%d points)"
            % int(preview.get("pointCount", 0))
        )
    return {
        "ok": true,
        "node": preview_node,
        "source": SOURCE_PREVIEW,
        "backendName": "",
        "pointCount": int(preview.get("pointCount", 0)),
        "reason": "",
    }


static func _tag(node: Node3D, source: String) -> void:
    if node == null:
        return
    node.set_meta(SPLAT_NODE_META, true)
    node.set_meta(SPLAT_SOURCE_META, source)


static func _failure(reason: String) -> Dictionary:
    return {
        "ok": false,
        "node": null,
        "source": "",
        "backendName": "",
        "pointCount": 0,
        "reason": reason,
    }
