extends SceneTree

const BRIDGE_SCRIPT := preload("res://addons/scene_sync/scene_sync_rapier_bridge.gd")

var _passed := 0
var _failed := 0
var _errors: Array[String] = []


func _init() -> void:
	call_deferred("_run")


func _run() -> void:
	_assert_true(Engine.is_editor_hint(), "test runs with the editor hint enabled")

	var bridge = BRIDGE_SCRIPT.new()
	root.add_child(bridge)
	bridge.set_scene_physics({
		"enabled": true,
		"worldOptions": {
			"gravity": [0.0, -9.81, 0.0],
			"timestep": 1.0 / 60.0,
			"ground": null,
		},
	})
	var body := Node3D.new()
	body.position = Vector3(0.0, 5.0, 0.0)
	root.add_child(body)
	_assert_true(bridge.upsert_object("editor-body", body, {
		"enabled": true,
		"bodyType": "dynamic",
		"shape": "box",
		"halfExtents": [0.5, 0.5, 0.5],
		"mass": 1.0,
	}), "editor physics metadata remains registered")

	_assert_true(not bridge.refresh_availability(), "runtime extension is unavailable in editor mode")
	_assert_eq(
		bridge.get_availability_reason(),
		BRIDGE_SCRIPT.EDITOR_UNAVAILABLE_REASON,
		"editor fallback reason requires Play"
	)
	var state: Dictionary = {}
	for index in range(3):
		state = bridge.advance_to_time(float(index + 1), 0, true)
	_assert_true(not bool(state.get("active", true)), "editor fallback leaves physics inactive")
	_assert_eq(
		state.get("reason"),
		BRIDGE_SCRIPT.EDITOR_UNAVAILABLE_REASON,
		"advance reports the editor fallback reason"
	)
	_assert_eq(bridge.get_tick(), 0, "editor fallback does not call the placeholder tick method")
	_assert_eq(bridge.get_canonical_state_hash(), "", "editor fallback does not call the placeholder hash method")
	_assert_eq(
		bridge.get_status().get("reason"),
		BRIDGE_SCRIPT.EDITOR_UNAVAILABLE_REASON,
		"status exposes the Play requirement"
	)
	_assert_true(body.position.is_equal_approx(Vector3(0.0, 5.0, 0.0)), "editor fallback preserves transforms")

	bridge.free()
	body.free()
	_finish()


func _assert_true(condition: bool, test_name: String) -> void:
	if condition:
		_passed += 1
	else:
		_failed += 1
		_errors.append(test_name)


func _assert_eq(actual: Variant, expected: Variant, test_name: String) -> void:
	_assert_true(actual == expected, "%s (expected=%s actual=%s)" % [test_name, expected, actual])


func _finish() -> void:
	print("\n=== SceneSync Rapier Editor Fallback Tests ===")
	print("PASSED: %d" % _passed)
	print("FAILED: %d" % _failed)
	for error in _errors:
		print("  FAIL: %s" % error)
	quit(0 if _failed == 0 else 1)
