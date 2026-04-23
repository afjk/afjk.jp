class_name SceneSyncGltfHelper
extends RefCounted


static func import_glb(data: PackedByteArray) -> Node3D:
    print("[SceneSync] import_glb: start, data size = %d bytes" % data.size())
    if data.is_empty():
        printerr("[SceneSync] import_glb: data is empty")
        return null

    var doc := GLTFDocument.new()
    var state := GLTFState.new()

    var temp_path := OS.get_temp_dir().path_join(
        "scene_sync_import_%d.glb" % Time.get_ticks_msec()
    )
    print("[SceneSync] import_glb: writing temp file -> %s" % temp_path)
    var file := FileAccess.open(temp_path, FileAccess.WRITE)
    if file == null:
        printerr("[SceneSync] import_glb: failed to open temp file (error: %s)" % error_string(FileAccess.get_open_error()))
        return null
    file.store_buffer(data)
    file.close()
    print("[SceneSync] import_glb: temp file written, calling append_from_file")

    var err := doc.append_from_file(temp_path, state)
    DirAccess.remove_absolute(temp_path)
    print("[SceneSync] import_glb: append_from_file result = %s" % error_string(err))

    if err != OK:
        printerr("[SceneSync] import_glb: glTF parse failed: %s" % error_string(err))
        return null

    print("[SceneSync] import_glb: meshes=%d, materials=%d, textures=%d, images=%d" % [
        state.meshes.size(), state.materials.size(),
        state.textures.size(), state.images.size()
    ])

    print("[SceneSync] import_glb: calling generate_scene")
    var scene = doc.generate_scene(state)
    print("[SceneSync] import_glb: generate_scene returned %s" % (scene.get_class() if scene != null else "null"))

    if scene != null:
        _print_node_tree(scene, "  ")

    if scene == null:
        printerr("[SceneSync] import_glb: generate_scene returned null")
        return null

    # generate_scene() はエディターモードで ImporterMeshInstance3D を生成するため
    # ランタイムで描画可能な MeshInstance3D に変換する
    _convert_importer_meshes(scene)
    _print_node_tree(scene, "  ")

    # GLB バイト列は改変しない。
    # Godot の glTF instantiate 結果だけが他クライアントと前後反転するため、
    # 受信表示用のコンテナ配下で見た目補正を持たせる。
    var container := Node3D.new()
    container.name = "ImportedGlb"
    container.add_child(scene)
    if scene is Node3D:
        (scene as Node3D).rotate_y(PI)
    return container


static func _convert_importer_meshes(node: Node) -> void:
    # 子を先に処理してから自身を変換（bottom-up）
    for child in node.get_children():
        _convert_importer_meshes(child)

    if not (node is ImporterMeshInstance3D):
        return

    var src := node as ImporterMeshInstance3D
    var mi := MeshInstance3D.new()
    mi.name = src.name
    mi.transform = src.transform
    mi.visible = src.visible
    if src.mesh != null:
        mi.mesh = src.mesh.get_mesh()
    mi.skin = src.skin
    src.replace_by(mi)
    src.queue_free()


static func _print_node_tree(node: Node, indent: String) -> void:
    var info := node.get_class()
    if node is MeshInstance3D:
        var mi := node as MeshInstance3D
        info += " mesh=%s" % ("null" if mi.mesh == null else mi.mesh.get_class())
        if mi.mesh != null:
            info += " surfaces=%d" % mi.mesh.get_surface_count()
    print("[SceneSync]   %s%s (\"%s\")" % [indent, info, node.name])
    for child in node.get_children():
        _print_node_tree(child, indent + "  ")


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
