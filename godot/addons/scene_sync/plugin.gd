@tool
extends EditorPlugin

const GAUSSIAN_SPLAT_MENU_ITEM := "Scene Sync: Gaussian Splat GLB を読み込む..."

var dock: Control


func _enter_tree() -> void:
    SceneSyncGaussianSplatBackend.reset_to_default_backend()

    dock = preload("res://addons/scene_sync/scene_sync_dock.tscn").instantiate()
    if dock.has_method("set_editor_interface"):
        dock.call("set_editor_interface", get_editor_interface())
    add_control_to_dock(DOCK_SLOT_RIGHT_BL, dock)

    var selection := get_editor_interface().get_selection()
    if selection != null and not selection.selection_changed.is_connected(_on_selection_changed):
        selection.selection_changed.connect(_on_selection_changed)

    add_tool_menu_item(GAUSSIAN_SPLAT_MENU_ITEM, _on_import_gaussian_splat_pressed)


func _exit_tree() -> void:
    remove_tool_menu_item(GAUSSIAN_SPLAT_MENU_ITEM)

    var selection := get_editor_interface().get_selection()
    if selection != null and selection.selection_changed.is_connected(_on_selection_changed):
        selection.selection_changed.disconnect(_on_selection_changed)

    if dock:
        remove_control_from_docks(dock)
        dock.queue_free()
        dock = null


func _on_selection_changed() -> void:
    if dock and dock.has_method("on_editor_selection_changed"):
        dock.call("on_editor_selection_changed")


## Project > Tools から KHR_gaussian_splatting GLB を編集中のシーンへ配置する。
##
## Godot 標準の glTF importer は KHR_gaussian_splatting を解釈できないため、
## FileSystem dock 経由の import ではなく GLB のパスを参照する
## SceneSyncGaussianSplatNode3D を追加する。表示は @tool ノードが Editor 上で
## 組み立てるので、確認のために Runtime を起動する必要はない。
func _on_import_gaussian_splat_pressed() -> void:
    var dialog := EditorFileDialog.new()
    dialog.file_mode = EditorFileDialog.FILE_MODE_OPEN_FILE
    dialog.access = EditorFileDialog.ACCESS_FILESYSTEM
    dialog.title = "Gaussian Splat GLB を選択"
    dialog.clear_filters()
    dialog.add_filter("*.glb", "KHR_gaussian_splatting GLB")
    dialog.file_selected.connect(_on_gaussian_splat_file_selected.bind(dialog))
    dialog.canceled.connect(dialog.queue_free)
    get_editor_interface().get_base_control().add_child(dialog)
    dialog.popup_centered_ratio(0.6)


func _on_gaussian_splat_file_selected(path: String, dialog: EditorFileDialog) -> void:
    dialog.queue_free()

    var scene_root := get_editor_interface().get_edited_scene_root()
    if scene_root == null:
        push_warning("[SceneSync] Gaussian Splat GLB を配置するシーンを先に開いてください。")
        return

    var data := FileAccess.get_file_as_bytes(path)
    if data.is_empty():
        push_warning("[SceneSync] GLB を読めませんでした: %s" % path)
        return

    var info := SceneSyncGaussianSplatGlb.inspect(data)
    if not bool(info.get("hasGaussianSplatting", false)):
        push_warning(
            "[SceneSync] %s は KHR_gaussian_splatting GLB ではありません。通常の GLB は FileSystem から配置してください。"
            % path.get_file()
        )
        return
    if not bool(info.get("valid", false)):
        push_warning(
            "[SceneSync] %s は KHR_gaussian_splatting GLB として不正です: %s"
            % [path.get_file(), ", ".join(info.get("errors", PackedStringArray()) as PackedStringArray)]
        )
        return

    var node := SceneSyncGaussianSplatNode3D.new()
    node.name = path.get_file().get_basename()
    node.glb_path = path

    var undo_redo := get_undo_redo()
    undo_redo.create_action("Add Gaussian Splat GLB")
    undo_redo.add_do_method(scene_root, "add_child", node)
    undo_redo.add_do_property(node, "owner", scene_root)
    undo_redo.add_do_reference(node)
    undo_redo.add_undo_method(scene_root, "remove_child", node)
    undo_redo.commit_action()

    var selection := get_editor_interface().get_selection()
    if selection != null:
        selection.clear()
        selection.add_node(node)

    print(
        "[SceneSync] Gaussian Splat GLB added: %s (%s)"
        % [path, SceneSyncGaussianSplatGlb.describe(info)]
    )
