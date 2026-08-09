class_name SceneSyncAnimationPolicy
extends RefCounted

const DEFAULT_MODE := "loop"
const ONCE_MODE := "once"
const RESET_ANIMATION_NAME := "RESET"


static func normalize(raw: Variant) -> Dictionary:
    var source: Dictionary = raw if raw is Dictionary else {}
    var result := {
        "enabled": true,
        "clipName": "",
        "clip": null,
        "mode": DEFAULT_MODE,
        "speed": 1.0,
        "offset": 0.0,
    }

    var enabled_value = source.get("enabled", true)
    if enabled_value is bool:
        result["enabled"] = enabled_value

    var clip_name_value = source.get("clipName", "")
    if clip_name_value is String:
        result["clipName"] = (clip_name_value as String).strip_edges()

    var clip_value = source.get("clip", null)
    if clip_value is String:
        var clip_text := (clip_value as String).strip_edges()
        if clip_text != "":
            result["clip"] = clip_text
    elif _is_finite_number(clip_value):
        result["clip"] = int(clip_value)

    var mode_value = source.get("mode", DEFAULT_MODE)
    if mode_value is String and (mode_value as String).to_lower() == ONCE_MODE:
        result["mode"] = ONCE_MODE

    var speed_value = source.get("speed", 1.0)
    if _is_finite_number(speed_value):
        result["speed"] = maxf(0.0, float(speed_value))

    var offset_value = source.get("offset", 0.0)
    if _is_finite_number(offset_value):
        result["offset"] = float(offset_value)

    return result


static func apply(root: Node, raw: Variant = null) -> Dictionary:
    var policy := normalize(raw)
    var result := _result_from_policy(policy)

    if root == null or not is_instance_valid(root):
        result["reason"] = "invalid-root"
        return result

    var players := _collect_animation_players(root)
    if players.is_empty():
        result["reason"] = "no-animation-player"
        return result

    _stop_players(players)
    if not bool(policy["enabled"]):
        result["reason"] = "disabled"
        return result

    var candidates := _collect_candidates(players)
    if candidates.is_empty():
        result["reason"] = "no-animation-clip"
        return result

    var selected := _select_candidate(candidates, policy)
    if selected.is_empty():
        result["reason"] = "no-animation-clip"
        return result

    var player := selected["player"] as AnimationPlayer
    var qualified_name := String(selected["qualified_name"])
    var animation := _isolate_selected_animation(player, qualified_name)
    if animation == null:
        result["reason"] = "animation-duplicate-failed"
        return result

    var mode := String(policy["mode"])
    animation.loop_mode = Animation.LOOP_NONE if mode == ONCE_MODE else Animation.LOOP_LINEAR

    var offset := _normalize_offset(float(policy["offset"]), animation.length, mode)
    var speed := float(policy["speed"])

    player.play(qualified_name)
    player.speed_scale = speed
    player.seek(offset, true)

    result["applied"] = true
    result["clipName"] = String(selected["local_name"])
    result["mode"] = mode
    result["speed"] = speed
    result["offset"] = offset
    result["reason"] = "applied"
    return result


static func sample(root: Node, raw: Variant, playback_time: Variant) -> Dictionary:
    var policy := normalize(raw)
    var result := _result_from_policy(policy)
    if root == null or not is_instance_valid(root):
        result["reason"] = "invalid-root"
        return result

    var players := _collect_animation_players(root)
    if players.is_empty():
        result["reason"] = "no-animation-player"
        return result

    _stop_players(players)
    if not bool(policy["enabled"]):
        result["reason"] = "disabled"
        return result

    var candidates := _collect_candidates(players)
    if candidates.is_empty():
        result["reason"] = "no-animation-clip"
        return result
    var selected := _select_candidate(candidates, policy)
    if selected.is_empty():
        result["reason"] = "no-animation-clip"
        return result

    var player := selected["player"] as AnimationPlayer
    var qualified_name := String(selected["qualified_name"])
    var animation := player.get_animation(qualified_name)
    if animation == null:
        result["reason"] = "animation-missing"
        return result

    var clock_time := float(playback_time) if _is_finite_number(playback_time) else 0.0
    clock_time = maxf(clock_time, 0.0)
    var mode := String(policy["mode"])
    var sample_time := _normalize_offset(
        clock_time * float(policy["speed"]) + float(policy["offset"]),
        animation.length,
        mode
    )
    player.play(qualified_name)
    player.speed_scale = 0.0
    player.seek(sample_time, true)

    result["applied"] = true
    result["clipName"] = String(selected["local_name"])
    result["mode"] = mode
    result["speed"] = float(policy["speed"])
    result["offset"] = sample_time
    result["reason"] = "sampled"
    return result


static func stop(root: Node) -> int:
    if root == null or not is_instance_valid(root):
        return 0
    var players := _collect_animation_players(root)
    _stop_players(players)
    return players.size()


static func _result_from_policy(policy: Dictionary) -> Dictionary:
    return {
        "applied": false,
        "enabled": bool(policy.get("enabled", true)),
        "clipName": String(policy.get("clipName", "")),
        "mode": String(policy.get("mode", DEFAULT_MODE)),
        "speed": float(policy.get("speed", 1.0)),
        "offset": float(policy.get("offset", 0.0)),
        "reason": "",
    }


static func _is_finite_number(value: Variant) -> bool:
    if not (value is int or value is float):
        return false
    return is_finite(float(value))


static func _collect_animation_players(root: Node) -> Array:
    var players: Array = []
    _append_animation_players(root, players)
    players.sort_custom(_animation_player_less)
    return players


static func _animation_player_less(a: AnimationPlayer, b: AnimationPlayer) -> bool:
    return _node_sort_key(a) < _node_sort_key(b)


static func _append_animation_players(node: Node, players: Array) -> void:
    if node is AnimationPlayer:
        players.append(node)
    for child in node.get_children():
        if child is Node:
            _append_animation_players(child, players)


static func _node_sort_key(node: Node) -> String:
    var parts: Array[String] = []
    var current := node
    while current != null:
        parts.push_front("%s:%08d" % [current.name, current.get_index()])
        current = current.get_parent()
    return "/".join(parts)


static func _stop_players(players: Array) -> void:
    for player_value in players:
        var player := player_value as AnimationPlayer
        if player == null or not is_instance_valid(player):
            continue
        player.stop()


static func _collect_candidates(players: Array) -> Array:
    var candidates: Array = []
    for player_value in players:
        var player := player_value as AnimationPlayer
        if player == null or not is_instance_valid(player):
            continue
        var names := player.get_animation_list()
        names.sort()
        for name_value in names:
            var qualified_name := String(name_value)
            var local_name := _local_animation_name(qualified_name)
            if local_name.to_upper() == RESET_ANIMATION_NAME:
                continue
            candidates.append({
                "player": player,
                "qualified_name": qualified_name,
                "local_name": local_name,
            })
    return candidates


static func _select_candidate(candidates: Array, policy: Dictionary) -> Dictionary:
    var clip_name := String(policy.get("clipName", ""))
    if clip_name != "":
        var by_clip_name := _find_named_candidate(candidates, clip_name)
        if not by_clip_name.is_empty():
            return by_clip_name

    var clip_value = policy.get("clip", null)
    if clip_value is String:
        var by_clip_text := _find_named_candidate(candidates, String(clip_value))
        if not by_clip_text.is_empty():
            return by_clip_text
        if String(clip_value).is_valid_int():
            return _candidate_at(candidates, int(clip_value))
    elif clip_value is int:
        return _candidate_at(candidates, int(clip_value))

    return candidates[0] as Dictionary


static func _find_named_candidate(candidates: Array, requested: String) -> Dictionary:
    var target := requested.strip_edges()
    if target == "":
        return {}

    for candidate_value in candidates:
        var candidate := candidate_value as Dictionary
        if String(candidate["qualified_name"]) == target:
            return candidate

    var suffix := "/" + target
    for candidate_value in candidates:
        var candidate := candidate_value as Dictionary
        if String(candidate["qualified_name"]).ends_with(suffix):
            return candidate

    return {}


static func _candidate_at(candidates: Array, index: int) -> Dictionary:
    if candidates.is_empty():
        return {}
    var clamped_index := clampi(index, 0, candidates.size() - 1)
    return candidates[clamped_index] as Dictionary


static func _local_animation_name(qualified_name: String) -> String:
    var slash_index := qualified_name.find("/")
    if slash_index < 0:
        return qualified_name
    return qualified_name.substr(slash_index + 1)


static func _library_name(qualified_name: String) -> String:
    var slash_index := qualified_name.find("/")
    if slash_index < 0:
        return ""
    return qualified_name.substr(0, slash_index)


static func _isolate_selected_animation(player: AnimationPlayer, qualified_name: String) -> Animation:
    var library_name := _library_name(qualified_name)
    var local_name := _local_animation_name(qualified_name)
    if not player.has_animation_library(library_name):
        return null

    var source_library := player.get_animation_library(library_name)
    if source_library == null or not source_library.has_animation(local_name):
        return null

    var duplicate_library := source_library.duplicate(true) as AnimationLibrary
    if duplicate_library == null:
        return null

    var animation_names := source_library.get_animation_list()
    for animation_name_value in animation_names:
        var animation_name := String(animation_name_value)
        var source_animation := source_library.get_animation(animation_name)
        if source_animation == null:
            continue
        var duplicate_animation := source_animation.duplicate(true) as Animation
        if duplicate_animation == null:
            return null
        if duplicate_library.has_animation(animation_name):
            duplicate_library.remove_animation(animation_name)
        var add_animation_error := duplicate_library.add_animation(animation_name, duplicate_animation)
        if add_animation_error != OK:
            return null

    player.remove_animation_library(library_name)
    var add_library_error := player.add_animation_library(library_name, duplicate_library)
    if add_library_error != OK:
        player.add_animation_library(library_name, source_library)
        return null

    return duplicate_library.get_animation(local_name)


static func _normalize_offset(offset: float, duration: float, mode: String) -> float:
    if not is_finite(offset) or not is_finite(duration) or duration <= 0.0:
        return 0.0
    if mode == ONCE_MODE:
        return clampf(offset, 0.0, duration)
    return fposmod(offset, duration)
