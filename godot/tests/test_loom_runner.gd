extends SceneTree

const RUNNER_SCRIPT_PATH := "res://addons/scene_sync/SceneSyncLoomletRunner.cs"

var _passed := 0
var _failed := 0
var _errors: Array[String] = []


func _init() -> void:
    call_deferred("_run")


func _assert_true(condition: bool, test_name: String) -> void:
    if condition:
        _passed += 1
        print("  OK: %s" % test_name)
        return
    _failed += 1
    _errors.append(test_name)
    print("  FAIL: %s" % test_name)


func _run() -> void:
    var runner_script = load(RUNNER_SCRIPT_PATH)
    _assert_true(not ClassDB.class_exists("SceneSyncLoomletRunner"), "C# GlobalClass uses fallback path")
    _assert_true(runner_script != null, "runner script loads")
    _assert_true(runner_script is Script, "runner resource is a Script")
    _assert_true(
        runner_script != null and runner_script.get_class() == "CSharpScript",
        "runner resource is CSharpScript"
    )
    _assert_true(
        runner_script is Script and (runner_script as Script).can_instantiate(),
        "built CSharpScript can instantiate"
    )

    var direct_instance: Node = null
    if runner_script is Script and (runner_script as Script).can_instantiate():
        direct_instance = (runner_script as Script).new() as Node
    _assert_true(direct_instance != null, "built CSharpScript creates Node")
    if direct_instance != null:
        direct_instance.free()

    var manager := SceneSyncManager.new()
    manager.auto_connect = false
    root.add_child(manager)
    var runner := manager._ensure_loom_runner()
    _assert_true(runner != null, "manager fallback creates Loomlet runner")
    _assert_true(runner is Node, "manager runner is Node")
    _assert_true(manager._loom_runner == runner, "manager stores fallback runner")
    _assert_true(runner != null and runner.get_parent() == manager, "manager owns fallback runner")

    if runner != null:
        _assert_true(
            runner.has_method("BindObject") or runner.has_method("bind_object"),
            "runner exposes object bind method"
        )
        _assert_true(
            runner.has_method("SetObjectGraph") or runner.has_method("set_object_graph"),
            "runner exposes object graph method"
        )
        _assert_true(
            runner.has_method("SetSceneGraph") or runner.has_method("set_scene_graph"),
            "runner exposes scene graph method"
        )

        var target := Node3D.new()
        manager.add_child(target)
        var graph := {"version": "loomlet.graph.v1", "nodes": [], "edges": []}
        manager._call_loom_runner("BindObject", ["loom-test", target])
        manager._call_loom_runner("SetObjectGraph", ["loom-test", target, JSON.stringify(graph)])
        manager._call_loom_runner("SetSceneGraph", [JSON.stringify(graph)])
        manager._call_loom_runner("ClearObjectGraph", ["loom-test"])
        manager._call_loom_runner("UnbindObject", ["loom-test"])
        manager._call_loom_runner("ClearSceneGraph")
        _assert_true(is_instance_valid(runner), "scene and object graph methods are callable")

    var unavailable_script := GDScript.new()
    _assert_true(not unavailable_script.can_instantiate(), "unbuilt script fixture cannot instantiate")
    _assert_true(
        manager._instantiate_loom_runner_script(unavailable_script) == null,
        "unavailable assembly path remains safe"
    )
    _assert_true(
        manager._instantiate_loom_runner_script(null) == null,
        "non-Script runner resource remains safe"
    )

    manager.free()
    print("")
    print("========================================")
    print("  Loomlet Runner: PASSED=%d FAILED=%d" % [_passed, _failed])
    print("========================================")
    for error in _errors:
        print("  FAIL: %s" % error)
    quit(0 if _failed == 0 else 1)
