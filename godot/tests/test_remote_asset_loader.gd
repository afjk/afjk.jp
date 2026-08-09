extends SceneTree

const LOADER_SCRIPT := preload("res://addons/scene_sync/scene_sync_remote_asset_loader.gd")
const DETAIL_KEYS := [
    "assetType",
    "attempt",
    "bytes",
    "maxAttempts",
    "reason",
    "requestResult",
    "retryDelay",
    "status",
    "willRetry",
]
const MISMATCHED_ASSET_ID := "sha256-0000000000000000000000000000000000000000000000000000000000000000"
const REDACTION_SECRET := "room-secret-do-not-log"

var _loader: Node
var _base_url: String
var _loaded: Array[Dictionary] = []
var _failed: Array[Dictionary] = []
var _diagnostics: Array[Dictionary] = []
var _passed: int = 0
var _failed_count: int = 0
var _errors: Array[String] = []


func _init() -> void:
    call_deferred("_run")


func _run() -> void:
    var port := OS.get_environment("SCENESYNC_REMOTE_ASSET_TEST_PORT")
    if port == "":
        port = "18788"
    _base_url = "http://127.0.0.1:%s" % port

    _loader = LOADER_SCRIPT.new()
    _loader.retry_base_delay_seconds = 0.01
    _loader.request_timeout_seconds = 2.0
    _loader.asset_loaded.connect(_on_asset_loaded)
    _loader.asset_failed.connect(_on_asset_failed)
    _loader.diagnostic.connect(_on_diagnostic)
    root.add_child(_loader)

    if not await _reset_server():
        _fail("fixture server", "fixture server is unavailable at the configured loopback port")
        await _finish()
        return

    _test_url_policy()
    await _test_valid_assets()
    await _test_retry_and_terminal_failures()
    await _test_status_retry_matrix()
    await _test_redirect_policy()
    await _test_cancel_and_signature_update()
    await _test_backoff_cancel()
    await _test_concurrency_and_queue_bounds()
    await _test_diagnostic_shape()
    await _test_request_counts()
    await _finish()


func _test_url_policy() -> void:
    _assert_true(_loader._is_allowed_url("https://example.test/model.glb"), "URL policy accepts HTTPS")
    _assert_true(_loader._is_allowed_url("http://localhost:18788/model.glb"), "URL policy accepts localhost HTTP on desktop")
    _assert_true(_loader._is_allowed_url("http://127.42.0.1:18788/model.glb"), "URL policy accepts 127/8 HTTP on desktop")
    _assert_true(_loader._is_allowed_url("http://[::1]:18788/model.glb"), "URL policy accepts IPv6 loopback HTTP on desktop")
    _assert_true(not _loader._is_allowed_url("http://localhost.evil/model.glb"), "URL policy rejects localhost suffix host")
    _assert_true(not _loader._is_allowed_url("http://user@localhost:18788/model.glb"), "URL policy rejects userinfo")
    _assert_true(not _loader._is_allowed_url("http://192.0.2.1/model.glb"), "URL policy rejects remote HTTP")


func _test_valid_assets() -> void:
    _loader.request_asset("valid-mesh", "valid-mesh-v1", _asset("mesh", "/glb/valid"))
    var mesh_event := await _wait_for_terminal("valid-mesh")
    _assert_eq(mesh_event.get("kind", ""), "loaded", "valid GLB loads")
    _assert_eq(mesh_event.get("assetType", ""), "mesh", "valid GLB reports mesh type")

    _loader.request_asset("valid-text", "valid-text-v1", _asset("text", "/text"))
    var text_event := await _wait_for_terminal("valid-text")
    _assert_eq(text_event.get("kind", ""), "loaded", "URL text loads")
    var text_data: PackedByteArray = text_event.get("data", PackedByteArray())
    _assert_true("Scene Sync" in text_data.get_string_from_utf8(), "URL text preserves UTF-8 data")

    _loader.request_asset("valid-image", "valid-image-v1", _asset("image", "/image/png"))
    var image_event := await _wait_for_terminal("valid-image")
    _assert_eq(image_event.get("kind", ""), "loaded", "actual PNG loads")
    var image_data: PackedByteArray = image_event.get("data", PackedByteArray())
    _assert_true(image_data.size() > 24, "actual PNG fixture bytes preserved")

    _loader.request_asset("valid-jpeg-header", "valid-jpeg-header-v1", _asset("image", "/image/jpeg-header"))
    var jpeg_event := await _wait_for_terminal("valid-jpeg-header")
    _assert_eq(jpeg_event.get("kind", ""), "loaded", "JPEG dimensions are recognized")

    _loader.request_asset("valid-webp-header", "valid-webp-header-v1", _asset("image", "/image/webp-header"))
    var webp_event := await _wait_for_terminal("valid-webp-header")
    _assert_eq(webp_event.get("kind", ""), "loaded", "WebP VP8X dimensions are recognized")


func _test_retry_and_terminal_failures() -> void:
    _loader.request_asset("first-503", "first-503-v1", _asset("mesh", "/retry/first-503"))
    var retry_success := await _wait_for_terminal("first-503")
    _assert_eq(retry_success.get("kind", ""), "loaded", "503 then success loads")

    _loader.request_asset("always-503", "always-503-v1", _asset("mesh", "/retry/always-503"))
    var retry_failure := await _wait_for_terminal("always-503")
    _assert_failure(retry_failure, "http-status", 4, "always 503 exhausts retry budget")

    var not_found_asset := _asset("mesh", "/status/404")
    not_found_asset["url"] += "?room=" + REDACTION_SECRET
    _loader.request_asset("not-found", "not-found-v1", not_found_asset)
    var not_found := await _wait_for_terminal("not-found")
    _assert_failure(not_found, "http-status", 1, "404 is terminal")

    _loader.request_asset("empty", "empty-v1", _asset("mesh", "/retry/empty"))
    var empty := await _wait_for_terminal("empty")
    _assert_failure(empty, "empty-body", 4, "empty body exhausts retry budget")

    _loader.request_asset("invalid-glb", "invalid-glb-v1", _asset("mesh", "/glb/invalid"))
    var invalid := await _wait_for_terminal("invalid-glb")
    _assert_failure(invalid, "glb-magic", 1, "invalid GLB is terminal")

    var hash_asset := _asset("mesh", "/glb/hash-mismatch")
    hash_asset["assetId"] = MISMATCHED_ASSET_ID
    _loader.request_asset("hash-mismatch", "hash-mismatch-v1", hash_asset)
    var hash_mismatch := await _wait_for_terminal("hash-mismatch")
    _assert_failure(hash_mismatch, "asset-id-mismatch", 1, "GLB hash mismatch is terminal")

    _loader.request_asset("invalid-utf8", "invalid-utf8-v1", _asset("text", "/text/invalid-utf8"))
    var invalid_utf8 := await _wait_for_terminal("invalid-utf8")
    _assert_failure(invalid_utf8, "text-invalid-utf8", 1, "invalid UTF-8 is terminal")

    _loader.request_asset("oversize-text", "oversize-text-v1", _asset("text", "/text/oversize"))
    var oversize_text := await _wait_for_terminal("oversize-text")
    _assert_failure(oversize_text, "body-too-large", 1, "oversize text is terminal")

    _loader.request_asset(
        "oversize-image-dimensions",
        "oversize-image-dimensions-v1",
        _asset("image", "/image/oversize-dimensions")
    )
    var oversize_image := await _wait_for_terminal("oversize-image-dimensions")
    _assert_failure(
        oversize_image,
        "image-dimensions-exceeded",
        1,
        "oversize image dimensions are terminal"
    )


func _test_status_retry_matrix() -> void:
    for status in [408, 425, 429, 500]:
        var object_id := "retry-%d" % status
        _loader.request_asset(object_id, object_id + "-v1", _asset("mesh", "/retry/%d" % status))
        var event := await _wait_for_terminal(object_id)
        _assert_eq(event.get("kind", ""), "loaded", "HTTP %d is retried" % status)


func _test_redirect_policy() -> void:
    _loader.request_asset("redirect", "redirect-v1", _asset("mesh", "/redirect"))
    var redirect := await _wait_for_terminal("redirect")
    _assert_failure(redirect, "redirect-disabled", 1, "redirect is disabled and terminal")


func _test_cancel_and_signature_update() -> void:
    _loader.request_asset("updated", "old-signature", _asset("mesh", "/slow/update"))
    await _wait_seconds(0.03)
    _loader.request_asset("updated", "new-signature", _asset("mesh", "/glb/replacement"))
    var updated := await _wait_for_terminal("updated")
    _assert_eq(updated.get("kind", ""), "loaded", "signature update loads replacement")
    _assert_eq(updated.get("signature", ""), "new-signature", "signature update suppresses stale result")
    await _wait_seconds(0.3)
    _assert_true(not _has_terminal("updated", "old-signature"), "stale signature emits no terminal signal")

    _loader.request_asset("cancelled", "cancelled-v1", _asset("mesh", "/slow/cancel"))
    await _wait_seconds(0.03)
    _loader.cancel_object("cancelled")
    await _wait_seconds(0.3)
    _assert_true(not _has_terminal("cancelled", "cancelled-v1"), "cancelled request emits no terminal signal")


func _test_backoff_cancel() -> void:
    _loader.retry_base_delay_seconds = 0.25
    _loader.request_asset("backoff-cancel", "backoff-cancel-v1", _asset("mesh", "/retry/backoff-cancel"))
    _assert_true(
        await _wait_for_diagnostic("backoff-cancel", 1),
        "backoff cancellation observes first diagnostic"
    )
    _loader.cancel_object("backoff-cancel")
    await process_frame
    await process_frame
    _assert_true(not _has_terminal("backoff-cancel", "backoff-cancel-v1"), "backoff cancellation emits no terminal")
    _loader.retry_base_delay_seconds = 0.01


func _test_concurrency_and_queue_bounds() -> void:
    _loader.max_concurrent_requests = 1
    _loader.max_pending_requests = 2
    _loader.request_asset("concurrency-a", "concurrency-a-v1", _asset("mesh", "/slow/concurrency/a"))
    _loader.request_asset("concurrency-b", "concurrency-b-v1", _asset("mesh", "/slow/concurrency/b"))
    _loader.request_asset("concurrency-c", "concurrency-c-v1", _asset("mesh", "/slow/concurrency/c"))

    var queue_full := await _wait_for_terminal("concurrency-c")
    _assert_failure(queue_full, "queue-full", 1, "pending queue rejects excess request")
    _assert_eq((await _wait_for_terminal("concurrency-a")).get("kind", ""), "loaded", "first queued asset loads")
    _assert_eq((await _wait_for_terminal("concurrency-b")).get("kind", ""), "loaded", "second queued asset loads")

    var stats := await _get_stats()
    _assert_true(int(stats.get("maxActiveSlowRequests", 0)) <= 1, "concurrency limit caps active HTTP requests")
    var counts_value = stats.get("counts", {})
    var counts: Dictionary = counts_value if counts_value is Dictionary else {}
    _assert_eq(int(counts.get("/slow/concurrency/c", 0)), 0, "queue-full asset never reaches server")
    _loader.max_concurrent_requests = 4
    _loader.max_pending_requests = 64


func _test_diagnostic_shape() -> void:
    _assert_true(not _diagnostics.is_empty(), "failure diagnostics were emitted")
    for event in _diagnostics:
        var detail_value = event.get("detail", {})
        if not (detail_value is Dictionary):
            _fail("diagnostic detail shape", "detail is not a Dictionary")
            continue
        var detail := detail_value as Dictionary
        var keys := detail.keys()
        keys.sort()
        _assert_eq(keys, DETAIL_KEYS, "diagnostic field whitelist")
        var serialized := JSON.stringify(detail)
        _assert_true(serialized.find("127.0.0.1") == -1, "diagnostic omits URL host")
        _assert_true(serialized.to_lower().find("room") == -1, "diagnostic omits room data")
        _assert_true(serialized.find(REDACTION_SECRET) == -1, "diagnostic omits URL query secret")
        _assert_true(not detail.has("url"), "diagnostic omits URL field")


func _test_request_counts() -> void:
    var counts := await _get_counts()
    _assert_eq(int(counts.get("/glb/valid", 0)), 1, "valid GLB requested once and redirect not followed")
    _assert_eq(int(counts.get("/text", 0)), 1, "text requested once")
    _assert_eq(int(counts.get("/image/png", 0)), 1, "PNG requested once")
    _assert_eq(int(counts.get("/image/jpeg-header", 0)), 1, "JPEG header requested once")
    _assert_eq(int(counts.get("/image/webp-header", 0)), 1, "WebP header requested once")
    _assert_eq(int(counts.get("/retry/first-503", 0)), 2, "first 503 retried once")
    _assert_eq(int(counts.get("/retry/always-503", 0)), 4, "always 503 attempted exactly four times")
    _assert_eq(int(counts.get("/status/404", 0)), 1, "404 attempted once")
    _assert_eq(int(counts.get("/retry/empty", 0)), 4, "empty response attempted exactly four times")
    _assert_eq(int(counts.get("/glb/invalid", 0)), 1, "invalid GLB attempted once")
    _assert_eq(int(counts.get("/glb/hash-mismatch", 0)), 1, "hash mismatch attempted once")
    _assert_eq(int(counts.get("/redirect", 0)), 1, "redirect endpoint attempted once")
    _assert_eq(int(counts.get("/slow/update", 0)), 1, "stale request started once")
    _assert_eq(int(counts.get("/glb/replacement", 0)), 1, "replacement requested once")
    _assert_eq(int(counts.get("/slow/cancel", 0)), 1, "cancelled request started once")
    _assert_eq(int(counts.get("/retry/backoff-cancel", 0)), 1, "backoff cancellation prevents retry")
    _assert_eq(int(counts.get("/text/invalid-utf8", 0)), 1, "invalid UTF-8 attempted once")
    _assert_eq(int(counts.get("/text/oversize", 0)), 1, "oversize text attempted once")
    _assert_eq(int(counts.get("/image/oversize-dimensions", 0)), 1, "oversize image attempted once")
    for status in [408, 425, 429, 500]:
        _assert_eq(int(counts.get("/retry/%d" % status, 0)), 2, "HTTP %d attempted twice" % status)


func _asset(asset_type: String, path: String) -> Dictionary:
    return {
        "type": asset_type,
        "source": "url",
        "url": _base_url + path,
    }


func _wait_for_terminal(object_id: String, timeout_seconds: float = 3.0) -> Dictionary:
    var elapsed := 0.0
    while elapsed < timeout_seconds:
        var terminal := _terminal_for(object_id)
        if not terminal.is_empty():
            return terminal
        var started := Time.get_ticks_msec()
        await process_frame
        elapsed += maxf(float(Time.get_ticks_msec() - started) / 1000.0, 0.001)
    _fail("terminal signal for %s" % object_id, "timed out")
    return {}


func _wait_for_diagnostic(object_id: String, attempt: int, timeout_seconds: float = 2.0) -> bool:
    var elapsed := 0.0
    while elapsed < timeout_seconds:
        for event in _diagnostics:
            var detail_value = event.get("detail", {})
            var detail: Dictionary = detail_value if detail_value is Dictionary else {}
            if (
                String(event.get("objectId", "")) == object_id
                and int(detail.get("attempt", 0)) == attempt
            ):
                return true
        var started := Time.get_ticks_msec()
        await process_frame
        elapsed += maxf(float(Time.get_ticks_msec() - started) / 1000.0, 0.001)
    return false


func _terminal_for(object_id: String) -> Dictionary:
    for event in _loaded:
        if String(event.get("objectId", "")) == object_id:
            return event
    for event in _failed:
        if String(event.get("objectId", "")) == object_id:
            return event
    return {}


func _has_terminal(object_id: String, signature: String) -> bool:
    for event in _loaded + _failed:
        if (
            String(event.get("objectId", "")) == object_id
            and String(event.get("signature", "")) == signature
        ):
            return true
    return false


func _assert_failure(event: Dictionary, reason: String, attempt: int, test_name: String) -> void:
    _assert_eq(event.get("kind", ""), "failed", test_name + " kind")
    var detail_value = event.get("detail", {})
    var detail: Dictionary = detail_value if detail_value is Dictionary else {}
    _assert_eq(detail.get("reason", ""), reason, test_name + " reason")
    _assert_eq(int(detail.get("attempt", 0)), attempt, test_name + " attempt")
    _assert_eq(bool(detail.get("willRetry", true)), false, test_name + " terminal flag")


func _reset_server() -> bool:
    var response := await _http_get("/reset")
    return int(response.get("status", 0)) == 204


func _get_counts() -> Dictionary:
    var response := await _http_get("/counts")
    if int(response.get("status", 0)) != 200:
        _fail("fixture request counts", "count endpoint returned HTTP %d" % int(response.get("status", 0)))
        return {}
    var body: PackedByteArray = response.get("body", PackedByteArray())
    var parsed = JSON.parse_string(body.get_string_from_utf8())
    if parsed is Dictionary:
        return parsed as Dictionary
    _fail("fixture request counts", "count endpoint returned invalid JSON")
    return {}


func _get_stats() -> Dictionary:
    var response := await _http_get("/stats")
    if int(response.get("status", 0)) != 200:
        _fail("fixture request stats", "stats endpoint returned HTTP %d" % int(response.get("status", 0)))
        return {}
    var body: PackedByteArray = response.get("body", PackedByteArray())
    var parsed = JSON.parse_string(body.get_string_from_utf8())
    if parsed is Dictionary:
        return parsed as Dictionary
    _fail("fixture request stats", "stats endpoint returned invalid JSON")
    return {}


func _http_get(path: String) -> Dictionary:
    var request := HTTPRequest.new()
    request.timeout = 2.0
    root.add_child(request)
    var start_error := request.request(_base_url + path)
    if start_error != OK:
        request.queue_free()
        await process_frame
        return {"status": 0, "body": PackedByteArray()}
    var result: Array = await request.request_completed
    request.queue_free()
    await process_frame
    if result.size() < 4 or int(result[0]) != HTTPRequest.RESULT_SUCCESS:
        return {"status": 0, "body": PackedByteArray()}
    return {"status": int(result[1]), "body": result[3]}


func _wait_seconds(seconds: float) -> void:
    await create_timer(seconds).timeout


func _on_asset_loaded(
    object_id: String,
    signature: String,
    asset_type: String,
    data: PackedByteArray
) -> void:
    _loaded.append({
        "kind": "loaded",
        "objectId": object_id,
        "signature": signature,
        "assetType": asset_type,
        "data": data,
    })


func _on_asset_failed(
    object_id: String,
    signature: String,
    asset_type: String,
    detail: Dictionary
) -> void:
    _failed.append({
        "kind": "failed",
        "objectId": object_id,
        "signature": signature,
        "assetType": asset_type,
        "detail": detail.duplicate(true),
    })


func _on_diagnostic(object_id: String, detail: Dictionary) -> void:
    _diagnostics.append({
        "objectId": object_id,
        "detail": detail.duplicate(true),
    })


func _assert_true(condition: bool, test_name: String) -> void:
    _assert_eq(condition, true, test_name)


func _assert_eq(actual, expected, test_name: String) -> void:
    if actual == expected:
        _passed += 1
        print("  OK: %s" % test_name)
        return
    _fail(test_name, "expected %s but got %s" % [str(expected), str(actual)])


func _fail(test_name: String, reason: String) -> void:
    _failed_count += 1
    var message := "%s: %s" % [test_name, reason]
    _errors.append(message)
    print("  FAIL: %s" % message)


func _finish() -> void:
    if _loader != null and is_instance_valid(_loader):
        _loader.cancel_all()
        _loader.free()
    print("")
    print("========================================")
    print("  Remote Asset Loader: PASSED=%d FAILED=%d" % [_passed, _failed_count])
    print("========================================")
    for error in _errors:
        print("  FAIL: %s" % error)
    quit(0 if _failed_count == 0 else 1)
