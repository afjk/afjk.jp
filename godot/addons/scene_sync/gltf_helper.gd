class_name SceneSyncGltfHelper
extends RefCounted


static func import_glb(data: PackedByteArray) -> Node3D:
    if data.is_empty():
        return null

    var doc := GLTFDocument.new()
    var state := GLTFState.new()
    var err := doc.append_from_buffer(data, "", state)
    if err != OK:
        printerr("[SceneSync] glTF import failed: %s" % error_string(err))
        return null

    var scene = doc.generate_scene(state)
    if scene is Node3D:
        return scene

    if scene != null:
        var wrapper := Node3D.new()
        wrapper.name = "ImportedGlb"
        wrapper.add_child(scene)
        return wrapper

    return null


static func export_glb(node: Node3D) -> PackedByteArray:
    var doc := GLTFDocument.new()
    var state := GLTFState.new()

    var is_in_tree := node.is_inside_tree()
    var original_transform := node.global_transform if is_in_tree else node.transform
    if is_in_tree:
        node.global_transform = Transform3D(Basis.IDENTITY, Vector3.ZERO)
    else:
        node.transform = Transform3D(Basis.IDENTITY, Vector3.ZERO)

    var err := doc.append_from_scene(node, state)

    if is_in_tree:
        node.global_transform = original_transform
    else:
        node.transform = original_transform

    if err != OK:
        printerr("[SceneSync] glTF export failed: %s" % error_string(err))
        return PackedByteArray()

    return doc.generate_buffer(state)
