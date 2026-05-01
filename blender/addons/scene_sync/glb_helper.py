"""GLB export / import helpers for Blender."""

import os
import tempfile

import bpy


def export_object_as_glb(obj: bpy.types.Object) -> bytes | None:
    """
    Export *obj* (and its children) to GLB bytes with Y-up conversion.
    Returns None on failure.
    """
    if "io_scene_gltf2" not in bpy.context.preferences.addons:
        print("[SceneSync] glTF exporter addon is not enabled")
        return None

    # Save and restore selection so we don't disrupt the user.
    prev_active = bpy.context.view_layer.objects.active
    prev_selected = set(o.name for o in bpy.context.selected_objects)

    with tempfile.NamedTemporaryFile(suffix=".glb", delete=False) as f:
        tmp = f.name

    try:
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj

        bpy.ops.export_scene.gltf(
            filepath=tmp,
            use_selection=True,
            export_format="GLB",
            export_apply=True,
        )

        with open(tmp, "rb") as f:
            return f.read()

    except Exception as e:
        print(f"[SceneSync] GLB export failed for '{obj.name}': {e}")
        return None

    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
        # Restore selection
        bpy.ops.object.select_all(action="DESELECT")
        for name in prev_selected:
            o = bpy.data.objects.get(name)
            if o:
                o.select_set(True)
        if prev_active and prev_active.name in bpy.data.objects:
            bpy.context.view_layer.objects.active = prev_active


def import_glb(data: bytes, name: str) -> bpy.types.Object | None:
    """
    Import GLB *data* into the current scene.
    Returns the root object or None on failure.
    """
    if "io_scene_gltf2" not in bpy.context.preferences.addons:
        print("[SceneSync] glTF importer addon is not enabled")
        return None

    with tempfile.NamedTemporaryFile(suffix=".glb", delete=False) as f:
        f.write(data)
        tmp = f.name

    try:
        bpy.ops.object.select_all(action="DESELECT")
        bpy.ops.import_scene.gltf(filepath=tmp)

        imported = list(bpy.context.selected_objects)
        if not imported:
            return None

        if len(imported) == 1:
            root = imported[0]
        else:
            bpy.ops.object.empty_add(type="PLAIN_AXES")
            root = bpy.context.active_object
            for o in imported:
                if o.parent is None:
                    o.parent = root

        root.name = name
        return root

    except Exception as e:
        print(f"[SceneSync] GLB import failed: {e}")
        return None

    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
