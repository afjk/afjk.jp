@tool
extends EditorPlugin

var dock: Control


func _enter_tree() -> void:
    dock = preload("res://addons/scene_sync/scene_sync_dock.tscn").instantiate()
    if dock.has_method("set_editor_interface"):
        dock.call("set_editor_interface", get_editor_interface())
    add_control_to_dock(DOCK_SLOT_RIGHT_BL, dock)

    var selection := get_editor_interface().get_selection()
    if selection != null and not selection.selection_changed.is_connected(_on_selection_changed):
        selection.selection_changed.connect(_on_selection_changed)


func _exit_tree() -> void:
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
