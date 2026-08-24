@tool
class_name SceneSyncGaussianSplatNode3D
extends Node3D

## KHR_gaussian_splatting GLB を配置するための Node3D。
##
## Editor / Runtime のどちらでも同じ経路（SceneSyncGaussianSplatBackend）で
## 視覚ノードを組み立てる。@tool なのでシーンを開いた時点で 3D viewport に表示され、
## 確認のために Runtime を起動する必要はない。
##
## 視覚ノードは owner を持たないため .tscn には保存されず、glb_path から毎回再構築する。
## Transform / visible は通常の Node3D として編集・保存できる。
##
## Godot プロジェクト内（res://）に GLB を置く場合は、Import dock で
## "Keep File (exported as is)" を選ぶ。Godot 標準の glTF importer は
## KHR_gaussian_splatting を解釈できないため、そのままではエクスポート後に読めなくなる。

signal splat_loaded(info: Dictionary)
signal splat_failed(reason: String)

const VISUAL_NAME := "GaussianSplatVisual"

## GLB のパス。res:// でもファイルシステムの絶対パスでもよい。
@export_file("*.glb") var glb_path: String = "":
    set(value):
        if glb_path == value:
            return
        glb_path = value
        # ツリーに入る前（.tscn の読み込み中や Inspector からの設定）でも組み立てる。
        # 二重読み込みは _ready() 側の has_visual() チェックで避ける。
        if auto_load:
            reload()

## glb_path が設定された時点で自動的に読み込むか。
@export var auto_load: bool = true

var _info: Dictionary = {}
var _source: String = ""


func _ready() -> void:
    if auto_load and glb_path != "" and not has_visual():
        reload()


## glb_path から読み直す。
func reload() -> bool:
    if glb_path == "":
        _clear_visual()
        return false

    var data := FileAccess.get_file_as_bytes(glb_path)
    if data.is_empty():
        var reason := "file-unreadable: %s (%s)" % [glb_path, error_string(FileAccess.get_open_error())]
        push_warning("[SceneSync] Gaussian Splat load failed: %s" % reason)
        _clear_visual()
        splat_failed.emit(reason)
        return false

    return load_from_bytes(data)


## GLB バイト列から読み込む。SceneSync 経由のランタイムロードもここを通る。
func load_from_bytes(data: PackedByteArray) -> bool:
    var info := SceneSyncGaussianSplatGlb.inspect(data)
    if not bool(info.get("hasGaussianSplatting", false)):
        var reason := "not-a-gaussian-splat-glb"
        push_warning("[SceneSync] Gaussian Splat load failed: %s" % reason)
        _clear_visual()
        splat_failed.emit(reason)
        return false

    var visual := SceneSyncGaussianSplatBackend.create_visual(data, info)
    if not bool(visual.get("ok", false)):
        var reason := String(visual.get("reason", "unknown"))
        push_warning("[SceneSync] Gaussian Splat load failed: %s" % reason)
        _clear_visual()
        splat_failed.emit(reason)
        return false

    _clear_visual()
    var node := visual["node"] as Node3D
    node.name = VISUAL_NAME
    add_child(node)
    # owner は設定しない。視覚ノードは .tscn へ保存せず glb_path から再構築する。

    _info = info
    _source = String(visual.get("source", ""))
    splat_loaded.emit(info)
    return true


## 直近に読み込んだ GLB の検査結果。
func get_splat_info() -> Dictionary:
    return _info.duplicate(true)


## "backend" なら専用 renderer、"preview" なら依存ゼロの点群プレビュー。
func get_visual_source() -> String:
    return _source


func has_visual() -> bool:
    return get_node_or_null(NodePath(VISUAL_NAME)) != null


func _clear_visual() -> void:
    _info = {}
    _source = ""
    var existing := get_node_or_null(NodePath(VISUAL_NAME))
    if existing != null:
        remove_child(existing)
        existing.queue_free()


func _get_configuration_warnings() -> PackedStringArray:
    var warnings := PackedStringArray()
    if glb_path == "":
        warnings.append("KHR_gaussian_splatting GLB のパスを設定してください。")
    elif not SceneSyncGaussianSplatBackend.is_available():
        warnings.append(
            "Gaussian Splat renderer backend が未登録です。点群プレビューで表示します。"
        )
    return warnings
