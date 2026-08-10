extends Node3D

const BRIDGE_SCRIPT := preload("res://addons/scene_sync/scene_sync_rapier_bridge.gd")
const EXPECTED_TICK_60_HASH := "14f6c93758a3967a"
const RESULT_PATH := "user://scenesync_rapier_platform_smoke.json"


func _ready() -> void:
    var bridge = BRIDGE_SCRIPT.new()
    add_child(bridge)
    bridge.set_scene_physics({
        "enabled": true,
        "worldOptions": {
            "gravity": [0.0, -9.81, 0.0],
            "timestep": 1.0 / 60.0,
            "ground": null,
        },
    })
    var body := Node3D.new()
    body.position = Vector3(-0.75, 5.0, 0.0)
    add_child(body)
    var registered: bool = bridge.upsert_object("box-1", body, {
        "enabled": true,
        "bodyType": "dynamic",
        "shape": "box",
        "halfExtents": [0.5, 0.5, 0.5],
        "density": 1.0,
        "linearVelocity": [0.75, 0.0, 0.15],
        "angularVelocity": [0.35, 1.25, 0.55],
        "linearDamping": 0.02,
        "angularDamping": 0.02,
        "canSleep": false,
        "ccd": false,
        "friction": 0.5,
        "restitution": 0.2,
        "frictionCombineRule": 0,
        "restitutionCombineRule": 0,
    }, true)
    var state: Dictionary = bridge.advance_to_time(0.0, 0, true)
    state = bridge.advance_to_time(1.0, 0, true)
    var passed := (
        registered
        and bool(state.get("active", false))
        and int(state.get("tick", -1)) == 60
        and String(state.get("hash", "")) == EXPECTED_TICK_60_HASH
        and body.position.y < 5.0
    )
    var platform := OS.get_name()
    var result_file := FileAccess.open(RESULT_PATH, FileAccess.WRITE)
    if result_file != null:
        result_file.store_string(JSON.stringify({
            "passed": passed,
            "platform": platform,
            "tick": int(state.get("tick", -1)),
            "hash": String(state.get("hash", "")),
            "expectedHash": EXPECTED_TICK_60_HASH,
            "registered": registered,
            "available": bool(state.get("available", false)),
            "reason": String(state.get("reason", "")),
            "position": [body.position.x, body.position.y, body.position.z],
        }))
        result_file.close()
    if passed:
        print("SCENESYNC_RAPIER_PLATFORM_SMOKE PASS platform=%s tick=60 hash=%s" % [
            platform,
            EXPECTED_TICK_60_HASH,
        ])
    else:
        push_error("SCENESYNC_RAPIER_PLATFORM_SMOKE FAIL platform=%s state=%s" % [platform, state])
    bridge.clear_runtime(true)
    bridge.queue_free()
    body.queue_free()
    await get_tree().process_frame
    get_tree().quit(0 if passed else 1)
