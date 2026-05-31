"""GLB export / import helpers for Blender."""

from __future__ import annotations

import math
import os
import tempfile

import bpy
from mathutils import Matrix

from .glb_alpha_modes import normalize_glb_alpha_modes


def _walk_hierarchy(root: bpy.types.Object) -> list[bpy.types.Object]:
    items = [root]
    for child in root.children:
        items.extend(_walk_hierarchy(child))
    return items


def _has_animation_data(data) -> bool:
    animation_data = getattr(data, "animation_data", None)
    if animation_data is None:
        return False
    if getattr(animation_data, "action", None) is not None:
        return True
    nla_tracks = getattr(animation_data, "nla_tracks", None)
    return bool(nla_tracks and len(nla_tracks) > 0)


def object_has_animation(obj: bpy.types.Object) -> bool:
    """Best-effort check for object, armature, material, or shape-key animation."""
    for item in _walk_hierarchy(obj):
        if _has_animation_data(item):
            return True
        if _has_animation_data(getattr(item, "data", None)):
            return True

        data = getattr(item, "data", None)
        shape_keys = getattr(data, "shape_keys", None)
        if _has_animation_data(shape_keys):
            return True

        for slot in getattr(item, "material_slots", []):
            if _has_animation_data(getattr(slot, "material", None)):
                return True

    return False


def object_has_shape_keys(obj: bpy.types.Object) -> bool:
    """Return true when the object hierarchy contains exportable shape keys."""
    for item in _walk_hierarchy(obj):
        data = getattr(item, "data", None)
        shape_keys = getattr(data, "shape_keys", None)
        key_blocks = getattr(shape_keys, "key_blocks", None)
        if key_blocks and len(key_blocks) > 1:
            return True
    return False


def _ensure_gltf_addon() -> bool:
    if "io_scene_gltf2" in bpy.context.preferences.addons:
        return True
    try:
        bpy.ops.preferences.addon_enable(module="io_scene_gltf2")
        return True
    except Exception:
        print("[SceneSync] glTF importer/exporter addon is not enabled")
        return False


def _new_empty(name: str) -> bpy.types.Object:
    bpy.ops.object.empty_add(type="PLAIN_AXES")
    obj = bpy.context.active_object
    obj.name = name
    return obj


def _export_gltf(kwargs: dict) -> None:
    try:
        properties = bpy.ops.export_scene.gltf.get_rna_type().properties
        supported = {prop.identifier for prop in properties}
        kwargs = {key: value for key, value in kwargs.items() if key in supported}
    except Exception:
        pass

    bpy.ops.export_scene.gltf(**kwargs)


def export_object_as_glb(
    obj: bpy.types.Object,
    *,
    include_animations: bool = True,
    normalize_alpha_modes: bool = True,
) -> bytes | None:
    """
    Export an object to GLB bytes.

    The exported carrier GLB is shape-only: the duplicated export root is moved
    to identity so Scene Sync wire transforms remain the single source of
    placement truth.
    """
    if not _ensure_gltf_addon():
        return None

    prev_active = bpy.context.view_layer.objects.active
    prev_selected = list(bpy.context.selected_objects)
    export_root = None

    with tempfile.NamedTemporaryFile(suffix=".glb", delete=False) as f:
        tmp = f.name

    try:
        bpy.ops.object.select_all(action="DESELECT")
        for item in _walk_hierarchy(obj):
            item.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.duplicate()
        duplicated = list(bpy.context.selected_objects)
        export_root = None
        for item in duplicated:
            if item.name == obj.name:
                export_root = item
                break
        if export_root is None:
            export_root = bpy.context.active_object
        export_root.name = f"SceneSyncExport_{obj.name}"
        export_root.matrix_world = Matrix.Identity(4)

        bpy.ops.object.select_all(action="DESELECT")
        for item in duplicated:
            item.select_set(True)
        bpy.context.view_layer.objects.active = export_root

        has_shape_keys = object_has_shape_keys(export_root)
        # Blender's glTF exporter warns that applying modifiers/transforms during
        # export prevents shape keys from being exported.
        export_apply = not has_shape_keys

        _export_gltf({
            "filepath": tmp,
            "use_selection": True,
            "export_format": "GLB",
            "export_apply": export_apply,
            "export_animations": include_animations,
            "export_frame_range": include_animations,
            "export_force_sampling": include_animations,
            "export_nla_strips": include_animations,
            "export_skins": True,
            "export_morph": True,
            "export_morph_normal": True,
            "export_morph_tangent": False,
            "export_morph_animation": include_animations,
        })

        with open(tmp, "rb") as f:
            data = f.read()

        if normalize_alpha_modes:
            try:
                normalized, report = normalize_glb_alpha_modes(data)
                if report.get("changed"):
                    materials = report.get("materials", [])
                    print(
                        f"[SceneSync] GLB alpha modes normalized for '{obj.name}': "
                        f"{len(materials)} material(s)"
                    )
                    for material in materials:
                        print(
                            "[SceneSync]   "
                            f"{material.get('name', material.get('index'))}: "
                            f"{material.get('before')} -> {material.get('after')}"
                        )
                data = normalized
            except Exception as e:
                print(f"[SceneSync] GLB alpha mode normalization skipped for '{obj.name}': {e}")

        return data

    except Exception as e:
        print(f"[SceneSync] GLB export failed for '{obj.name}': {e}")
        return None

    finally:
        if export_root and export_root.name in bpy.data.objects:
            for item in reversed(_walk_hierarchy(export_root)):
                if item.name in bpy.data.objects:
                    bpy.data.objects.remove(item, do_unlink=True)
        if os.path.exists(tmp):
            os.unlink(tmp)

        bpy.ops.object.select_all(action="DESELECT")
        for selected in prev_selected:
            if selected and selected.name in bpy.data.objects:
                selected.select_set(True)
        if prev_active and prev_active.name in bpy.data.objects:
            bpy.context.view_layer.objects.active = prev_active


def import_glb(data: bytes, name: str, visual_basis: str | None = None) -> bpy.types.Object | None:
    """Import GLB data into the current scene and return a stable root object."""
    if not _ensure_gltf_addon():
        return None

    prev_active = bpy.context.view_layer.objects.active
    prev_selected = list(bpy.context.selected_objects)

    with tempfile.NamedTemporaryFile(suffix=".glb", delete=False) as f:
        f.write(data)
        tmp = f.name

    try:
        bpy.ops.object.select_all(action="DESELECT")
        bpy.ops.import_scene.gltf(filepath=tmp)

        imported = list(bpy.context.selected_objects)
        if not imported:
            return None

        imported_set = set(imported)
        top_level = [item for item in imported if item.parent not in imported_set]

        if visual_basis == "unity":
            root = _new_empty(name)
            visual = _new_empty(f"{name} Visual")
            visual.parent = root
            visual.rotation_euler.rotate_axis("Z", math.pi)
            for item in top_level:
                if item != root and item != visual:
                    item.parent = visual
        elif len(imported) == 1:
            root = imported[0]
        else:
            root = _new_empty(name)
            root.name = name
            for item in top_level:
                if item != root and item.parent is None:
                    item.parent = root

        root.name = name

        return root

    except Exception as e:
        print(f"[SceneSync] GLB import failed: {e}")
        return None

    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
        bpy.ops.object.select_all(action="DESELECT")
        for selected in prev_selected:
            if selected and selected.name in bpy.data.objects:
                selected.select_set(True)
        if prev_active and prev_active.name in bpy.data.objects:
            bpy.context.view_layer.objects.active = prev_active
