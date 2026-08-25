class_name SceneSyncGodotGsplatBackend
extends RefCounted

## godot-gsplat の実 renderer adapter。
##
## 固定 commit の GDExtension が利用可能なら GaussianSplatNode3D を動的に生成し、
## SceneSync の KHR_gaussian_splatting GLB bytes を公開 source_gltf API へ渡す。
## addon が未導入でもこの script 自体は parse でき、SceneSync は点群 preview へ戻る。

const UPSTREAM_COMMIT := "dfc8df4893f0f6e26c847590ff1669fa8404da6d"
const BACKEND_NAME := "godot-gsplat @ dfc8df4893f0"
const NODE_CLASS_NAME := &"GaussianSplatNode3D"
const EXTENSION_PATHS := [
    "res://godot_gsplat.gdextension",
    "res://addons/godot_gsplat/godot_gsplat.gdextension",
]

const PROFILE_AUTO := -1
const PROFILE_LOW := 1
const PROFILE_MIDDLE := 2
const PROFILE_HIGH := 3
const PROFILE_XR := 4
const PROFILE_SETTING := "scene_sync/gaussian_splat/render_profile"
const PROFILE_KEY_SH_DEGREE := "sh_degree"

static var _warned_compatibility_renderer := false


func get_backend_name() -> String:
    return BACKEND_NAME


func can_render(info: Dictionary) -> bool:
    if not bool(info.get("valid", false)) or not bool(info.get("hasGaussianSplatting", false)):
        return false

    var rendering_method := String(
        ProjectSettings.get_setting("rendering/renderer/rendering_method", "gl_compatibility")
    )
    if rendering_method == "gl_compatibility":
        if not _warned_compatibility_renderer:
            _warned_compatibility_renderer = true
            push_warning(
                "[SceneSync] godot-gsplat requires Godot's Mobile or Forward+ renderer; "
                + "gl_compatibility will use the point preview."
            )
        return false

    return is_runtime_available()


func create_splat_node(data: PackedByteArray, info: Dictionary) -> Node3D:
    if data.is_empty() or not can_render(info):
        return null

    var instance := ClassDB.instantiate(NODE_CLASS_NAME)
    if not instance is Node3D:
        if instance != null and instance.has_method("free"):
            instance.call("free")
        push_warning("[SceneSync] godot-gsplat did not create a GaussianSplatNode3D")
        return null

    var splat_node := instance as Node3D
    # Upstream requires the profile before binding. Otherwise a large capture starts an
    # unbounded first build before the budget/profile can be applied.
    var profile := _apply_render_profile(splat_node)

    var temp_path := _write_temp_glb(data)
    if temp_path == "":
        splat_node.free()
        return null

    splat_node.set("source_gltf", temp_path)
    DirAccess.remove_absolute(temp_path)

    if not splat_node.has_method("has_asset") or not bool(splat_node.call("has_asset")):
        var reason := "godot-gsplat failed to decode the GLB"
        if splat_node.has_method("get_last_load_error"):
            var upstream_reason := String(splat_node.call("get_last_load_error"))
            if upstream_reason != "":
                reason = upstream_reason
        push_warning("[SceneSync] %s" % reason)
        splat_node.free()
        return null

    splat_node.name = "GodotGaussianSplat"
    splat_node.set_meta("scene_sync_godot_gsplat_commit", UPSTREAM_COMMIT)
    splat_node.set_meta("scene_sync_godot_gsplat_profile", profile)
    return splat_node


## GDExtension を必要なときだけロードし、native class が登録済みか返す。
static func is_runtime_available() -> bool:
    if ClassDB.class_exists(NODE_CLASS_NAME):
        return true

    for path in EXTENSION_PATHS:
        if not FileAccess.file_exists(path):
            continue
        if GDExtensionManager.is_extension_loaded(path):
            return ClassDB.class_exists(NODE_CLASS_NAME)

        var status := GDExtensionManager.load_extension(path)
        if status == GDExtensionManager.LOAD_STATUS_OK \
                or status == GDExtensionManager.LOAD_STATUS_ALREADY_LOADED:
            return ClassDB.class_exists(NODE_CLASS_NAME)

        push_warning("[SceneSync] Failed to load godot-gsplat GDExtension (%s): status=%s" % [path, status])

    return false


static func _apply_render_profile(splat_node: Node3D) -> int:
    var configured := int(ProjectSettings.get_setting(PROFILE_SETTING, PROFILE_AUTO))
    if configured >= PROFILE_LOW and configured <= PROFILE_XR:
        splat_node.set("render_profile", configured)
        return configured

    var xr_interface := XRServer.primary_interface
    if xr_interface != null and xr_interface.is_initialized():
        splat_node.set("render_profile", PROFILE_XR)
        return PROFILE_XR

    # Middle caps the active set at 500k, avoiding the all-in-frame GPU stall seen
    # with large room captures. Override only SH so degree 0–3 remains available;
    # the full source asset stays decoded and is not decimated.
    splat_node.set("render_profile", PROFILE_MIDDLE)
    if splat_node.has_method("get_profile_settings") \
            and splat_node.has_method("apply_profile_settings"):
        var settings: Dictionary = splat_node.call("get_profile_settings", PROFILE_MIDDLE)
        settings[PROFILE_KEY_SH_DEGREE] = 3
        splat_node.call("apply_profile_settings", settings)
    return PROFILE_MIDDLE


static func _write_temp_glb(data: PackedByteArray) -> String:
    var file_name := "scenesync-gsplat-%s-%s-%s.glb" % [
        OS.get_process_id(),
        Time.get_ticks_usec(),
        hash(data),
    ]
    var path := OS.get_temp_dir().path_join(file_name)
    var file := FileAccess.open(path, FileAccess.WRITE)
    if file == null:
        push_warning(
            "[SceneSync] Failed to create a temporary GLB for godot-gsplat: %s"
            % error_string(FileAccess.get_open_error())
        )
        return ""

    file.store_buffer(data)
    file.close()
    return path
