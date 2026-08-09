class_name SceneSyncRemoteAssetLoader
extends Node

signal asset_loaded(object_id: String, signature: String, asset_type: String, data: PackedByteArray)
signal asset_failed(object_id: String, signature: String, asset_type: String, detail: Dictionary)
signal diagnostic(object_id: String, detail: Dictionary)

@export var retry_base_delay_seconds: float = 1.0
@export var request_timeout_seconds: float = 30.0
@export_range(1, 64, 1) var max_concurrent_requests: int = 4
@export_range(1, 1024, 1) var max_pending_requests: int = 64

const MAX_ATTEMPTS: int = 4
const MAX_GLB_BYTES: int = 50 * 1024 * 1024
const MAX_IMAGE_BYTES: int = 20 * 1024 * 1024
const MAX_TEXT_BYTES: int = 1024 * 1024
const MAX_IMAGE_DIMENSION: int = 8192
const MAX_IMAGE_PIXELS: int = 32 * 1024 * 1024
const GLB_MAGIC: int = 0x46546c67
const GLB_VERSION: int = 2

var _next_token: int = 1
var _states: Dictionary = {}
var _active_request_count: int = 0


func request_asset(object_id: String, signature: String, asset: Dictionary) -> void:
    var current_value = _states.get(object_id, {})
    if current_value is Dictionary:
        var current := current_value as Dictionary
        if not current.is_empty() and String(current.get("signature", "")) == signature:
            return

    cancel_object(object_id)
    if _states.size() >= _pending_limit():
        var asset_type := _safe_string(asset.get("type", "")).to_lower()
        var detail := _make_detail(
            asset_type,
            _failure("queue-full", -1, 0, 0, false),
            1,
            0.0,
            false
        )
        _emit_diagnostic(object_id, detail)
        asset_failed.emit(object_id, signature, asset_type, detail)
        return
    var token := _next_token
    _next_token += 1
    _states[object_id] = {
        "signature": signature,
        "token": token,
        "request": null,
    }
    call_deferred("_run_request", object_id, signature, token, asset.duplicate(true))


func cancel_object(object_id: String) -> void:
    var active_request: HTTPRequest = null
    var state_value = _states.get(object_id, {})
    if state_value is Dictionary:
        var state := state_value as Dictionary
        var request_value = state.get("request", null)
        if request_value is HTTPRequest:
            active_request = request_value as HTTPRequest
    _states.erase(object_id)
    if active_request != null:
        _cancel_and_release_request(active_request)


func cancel_all() -> void:
    var object_ids := _states.keys()
    for object_id in object_ids:
        cancel_object(String(object_id))


func _exit_tree() -> void:
    cancel_all()


func _run_request(object_id: String, signature: String, token: int, asset: Dictionary) -> void:
    if not _is_current(object_id, signature, token):
        return

    var asset_type := _safe_string(asset.get("type", "")).to_lower()
    var maximum_size := _maximum_size_for_type(asset_type)
    if maximum_size <= 0:
        _finish_failure(
            object_id,
            signature,
            token,
            asset_type,
            _failure("unsupported-asset-type", -1, 0, 0, false),
            1
        )
        return

    var url := _safe_string(asset.get("url", ""))
    if not _is_allowed_url(url):
        _finish_failure(
            object_id,
            signature,
            token,
            asset_type,
            _failure("url-policy", -1, 0, 0, false),
            1
        )
        return

    for attempt in range(1, MAX_ATTEMPTS + 1):
        if not _is_current(object_id, signature, token):
            return

        if not await _acquire_request_slot(object_id, signature, token):
            return
        var response := await _fetch_once(object_id, signature, token, url, maximum_size)
        _release_request_slot()
        if not _is_current(object_id, signature, token):
            return

        if bool(response.get("ok", false)):
            var data: PackedByteArray = response.get("data", PackedByteArray())
            var validation := _validate_asset(
                asset_type,
                asset,
                data,
                int(response.get("requestResult", HTTPRequest.RESULT_SUCCESS)),
                int(response.get("status", 0))
            )
            if bool(validation.get("ok", false)):
                _states.erase(object_id)
                asset_loaded.emit(object_id, signature, asset_type, data)
                return
            response = validation

        var transient := bool(response.get("transient", false))
        var will_retry := transient and attempt < MAX_ATTEMPTS and get_tree() != null
        var retry_delay := 0.0
        if will_retry:
            retry_delay = maxf(retry_base_delay_seconds, 0.0) * pow(2.0, float(attempt - 1))

        var detail := _make_detail(asset_type, response, attempt, retry_delay, will_retry)
        _emit_diagnostic(object_id, detail)
        if not will_retry:
            _states.erase(object_id)
            asset_failed.emit(object_id, signature, asset_type, detail)
            return

        if not await _wait_retry_delay(object_id, signature, token, retry_delay):
            return


func _fetch_once(
    object_id: String,
    signature: String,
    token: int,
    url: String,
    maximum_size: int
) -> Dictionary:
    var request := HTTPRequest.new()
    request.body_size_limit = maximum_size
    request.max_redirects = 0
    request.timeout = maxf(request_timeout_seconds, 0.0)
    add_child(request)

    if not _set_active_request(object_id, signature, token, request):
        request.queue_free()
        return _failure("stale", -1, 0, 0, false)

    var start_error := request.request(url)
    if start_error != OK:
        _clear_active_request(object_id, signature, token, request)
        request.queue_free()
        return _failure("request-start", int(start_error), 0, 0, true)

    var result: Array = await request.request_completed
    _clear_active_request(object_id, signature, token, request)
    if is_instance_valid(request):
        request.queue_free()

    if result.size() < 4:
        return _failure("incomplete-response", -1, 0, 0, true)

    var request_result := int(result[0])
    var status := int(result[1])
    var body := PackedByteArray()
    if result[3] is PackedByteArray:
        body = result[3]

    if request_result == HTTPRequest.RESULT_BODY_SIZE_LIMIT_EXCEEDED:
        return _failure("body-too-large", request_result, status, body.size(), false)
    if request_result == HTTPRequest.RESULT_REDIRECT_LIMIT_REACHED:
        return _failure("redirect-disabled", request_result, status, body.size(), false)
    if request_result != HTTPRequest.RESULT_SUCCESS:
        return _failure("transport", request_result, status, body.size(), true)
    if status < 200 or status >= 300:
        var transient_status := status in [408, 425, 429] or status >= 500
        return _failure("http-status", request_result, status, body.size(), transient_status)
    if body.is_empty():
        return _failure("empty-body", request_result, status, 0, true)
    if body.size() > maximum_size:
        return _failure("body-too-large", request_result, status, body.size(), false)
    return {
        "ok": true,
        "data": body,
        "requestResult": request_result,
        "status": status,
        "bytes": body.size(),
    }


func _validate_asset(
    asset_type: String,
    asset: Dictionary,
    data: PackedByteArray,
    request_result: int,
    status: int
) -> Dictionary:
    match asset_type:
        "mesh":
            return _validate_glb(asset, data, request_result, status)
        "image":
            return _validate_image(data, request_result, status)
        "text":
            if data.get_string_from_utf8().to_utf8_buffer() != data:
                return _failure("text-invalid-utf8", request_result, status, data.size(), false)
    return {"ok": true}


func _validate_glb(
    asset: Dictionary,
    data: PackedByteArray,
    request_result: int,
    status: int
) -> Dictionary:
    if data.size() < 12:
        return _failure("glb-too-small", request_result, status, data.size(), false)
    if data.decode_u32(0) != GLB_MAGIC:
        return _failure("glb-magic", request_result, status, data.size(), false)
    if data.decode_u32(4) != GLB_VERSION:
        return _failure("glb-version", request_result, status, data.size(), false)
    if data.decode_u32(8) != data.size():
        return _failure("glb-length", request_result, status, data.size(), false)

    var asset_id := _safe_string(asset.get("assetId", ""))
    if asset_id.begins_with("sha256-") and _compute_asset_id(data) != asset_id:
        return _failure("asset-id-mismatch", request_result, status, data.size(), false)
    return {"ok": true}


func _validate_image(data: PackedByteArray, request_result: int, status: int) -> Dictionary:
    var dimensions := _image_dimensions(data)
    if not bool(dimensions.get("recognized", false)):
        return _failure("image-signature", request_result, status, data.size(), false)
    var width := int(dimensions.get("width", 0))
    var height := int(dimensions.get("height", 0))
    if width <= 0 or height <= 0:
        return _failure("image-dimensions", request_result, status, data.size(), false)
    if not _image_dimensions_within_budget(width, height):
        return _failure("image-dimensions-exceeded", request_result, status, data.size(), false)
    return {"ok": true}


func _image_dimensions(data: PackedByteArray) -> Dictionary:
    if data.size() >= 24 and data.slice(0, 8) == PackedByteArray([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]):
        if data.slice(12, 16).get_string_from_ascii() != "IHDR":
            return {"recognized": true}
        return {
            "recognized": true,
            "width": _read_u32_be(data, 16),
            "height": _read_u32_be(data, 20),
        }
    if data.size() >= 3 and data[0] == 0xff and data[1] == 0xd8 and data[2] == 0xff:
        return _jpeg_dimensions(data)
    if (
        data.size() >= 20
        and data.slice(0, 4).get_string_from_ascii() == "RIFF"
        and data.slice(8, 12).get_string_from_ascii() == "WEBP"
    ):
        return _webp_dimensions(data)
    return {"recognized": false}


func _jpeg_dimensions(data: PackedByteArray) -> Dictionary:
    var offset := 2
    while offset + 1 < data.size():
        while offset < data.size() and data[offset] == 0xff:
            offset += 1
        if offset >= data.size():
            break
        var marker := int(data[offset])
        offset += 1
        if marker == 0xd9 or marker == 0xda:
            break
        if marker == 0x01 or marker in range(0xd0, 0xd8):
            continue
        if offset + 1 >= data.size():
            break
        var segment_length := _read_u16_be(data, offset)
        if segment_length < 2 or offset + segment_length > data.size():
            break
        if marker in [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]:
            if segment_length < 7:
                break
            return {
                "recognized": true,
                "width": _read_u16_be(data, offset + 5),
                "height": _read_u16_be(data, offset + 3),
            }
        offset += segment_length
    return {"recognized": true}


func _webp_dimensions(data: PackedByteArray) -> Dictionary:
    var chunk_type := data.slice(12, 16).get_string_from_ascii()
    if chunk_type == "VP8X" and data.size() >= 30:
        return {
            "recognized": true,
            "width": 1 + _read_u24_le(data, 24),
            "height": 1 + _read_u24_le(data, 27),
        }
    if chunk_type == "VP8L" and data.size() >= 25 and data[20] == 0x2f:
        var b0 := int(data[21])
        var b1 := int(data[22])
        var b2 := int(data[23])
        var b3 := int(data[24])
        return {
            "recognized": true,
            "width": 1 + b0 + ((b1 & 0x3f) << 8),
            "height": 1 + ((b1 & 0xc0) >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10),
        }
    if (
        chunk_type == "VP8 "
        and data.size() >= 30
        and data[23] == 0x9d
        and data[24] == 0x01
        and data[25] == 0x2a
    ):
        return {
            "recognized": true,
            "width": (int(data[26]) | (int(data[27]) << 8)) & 0x3fff,
            "height": (int(data[28]) | (int(data[29]) << 8)) & 0x3fff,
        }
    return {"recognized": true}


func _image_dimensions_within_budget(width: int, height: int) -> bool:
    return (
        width > 0
        and height > 0
        and width <= MAX_IMAGE_DIMENSION
        and height <= MAX_IMAGE_DIMENSION
        and width * height <= MAX_IMAGE_PIXELS
    )


func _read_u16_be(data: PackedByteArray, offset: int) -> int:
    if offset < 0 or offset + 2 > data.size():
        return 0
    return (int(data[offset]) << 8) | int(data[offset + 1])


func _read_u32_be(data: PackedByteArray, offset: int) -> int:
    if offset < 0 or offset + 4 > data.size():
        return 0
    return (
        (int(data[offset]) << 24)
        | (int(data[offset + 1]) << 16)
        | (int(data[offset + 2]) << 8)
        | int(data[offset + 3])
    )


func _read_u24_le(data: PackedByteArray, offset: int) -> int:
    if offset < 0 or offset + 3 > data.size():
        return 0
    return int(data[offset]) | (int(data[offset + 1]) << 8) | (int(data[offset + 2]) << 16)


func _maximum_size_for_type(asset_type: String) -> int:
    match asset_type:
        "mesh":
            return MAX_GLB_BYTES
        "image":
            return MAX_IMAGE_BYTES
        "text":
            return MAX_TEXT_BYTES
    return 0


func _pending_limit() -> int:
    return maxi(maxi(max_pending_requests, 1), _concurrency_limit())


func _concurrency_limit() -> int:
    return maxi(max_concurrent_requests, 1)


func _acquire_request_slot(object_id: String, signature: String, token: int) -> bool:
    while _is_current(object_id, signature, token):
        if _active_request_count < _concurrency_limit():
            _active_request_count += 1
            return true
        var tree := get_tree()
        if tree == null:
            return false
        await tree.process_frame
    return false


func _release_request_slot() -> void:
    _active_request_count = maxi(_active_request_count - 1, 0)


func _wait_retry_delay(
    object_id: String,
    signature: String,
    token: int,
    delay_seconds: float
) -> bool:
    var remaining := maxf(delay_seconds, 0.0)
    var last_ticks := Time.get_ticks_usec()
    while _is_current(object_id, signature, token):
        if remaining <= 0.0:
            return true
        var tree := get_tree()
        if tree == null:
            return false
        await tree.process_frame
        var next_ticks := Time.get_ticks_usec()
        remaining -= maxf(float(next_ticks - last_ticks) / 1000000.0, 0.0)
        last_ticks = next_ticks
    return false


func _is_allowed_url(url: String) -> bool:
    if url == "" or url != url.strip_edges() or "\\" in url:
        return false

    var scheme_end := url.find("://")
    if scheme_end <= 0:
        return false
    var scheme := url.substr(0, scheme_end).to_lower()
    if scheme != "https" and scheme != "http":
        return false

    var remainder := url.substr(scheme_end + 3)
    var authority_end := remainder.length()
    for separator in ["/", "?", "#"]:
        var position := remainder.find(separator)
        if position >= 0:
            authority_end = mini(authority_end, position)
    var authority := remainder.substr(0, authority_end)
    if authority == "" or "@" in authority or "%" in authority:
        return false
    for byte_value in authority.to_utf8_buffer():
        if int(byte_value) <= 0x20 or int(byte_value) == 0x7f:
            return false

    var host := ""
    if authority.begins_with("["):
        var closing_bracket := authority.find("]")
        if closing_bracket <= 1:
            return false
        host = authority.substr(1, closing_bracket - 1).to_lower()
        var suffix := authority.substr(closing_bracket + 1)
        if suffix != "" and (not suffix.begins_with(":") or not _is_valid_port(suffix.substr(1))):
            return false
    else:
        if "[" in authority or "]" in authority:
            return false
        if authority.count(":") > 1:
            return false
        var colon := authority.rfind(":")
        if colon >= 0:
            host = authority.substr(0, colon).to_lower()
            if not _is_valid_port(authority.substr(colon + 1)):
                return false
        else:
            host = authority.to_lower()

    if host == "":
        return false
    if scheme == "https":
        return true
    if OS.has_feature("mobile"):
        return false
    return host == "localhost" or host == "::1" or _is_ipv4_loopback(host)


func _is_valid_port(value: String) -> bool:
    if value == "" or not value.is_valid_int():
        return false
    var port := int(value)
    return port >= 1 and port <= 65535


func _is_ipv4_loopback(host: String) -> bool:
    var parts := host.split(".", false)
    if parts.size() != 4:
        return false
    for index in range(parts.size()):
        var part := String(parts[index])
        if part == "" or not part.is_valid_int():
            return false
        if part.length() > 1 and part.begins_with("0"):
            return false
        var octet := int(part)
        if octet < 0 or octet > 255:
            return false
        if index == 0 and octet != 127:
            return false
    return true


func _safe_string(value: Variant) -> String:
    if value is String:
        return value
    if value is StringName:
        return String(value)
    return ""


func _compute_asset_id(data: PackedByteArray) -> String:
    var hashing := HashingContext.new()
    if hashing.start(HashingContext.HASH_SHA256) != OK:
        return ""
    hashing.update(data)
    return "sha256-" + _bytes_to_hex(hashing.finish())


func _bytes_to_hex(data: PackedByteArray) -> String:
    const HEX := "0123456789abcdef"
    var result := ""
    for byte_value in data:
        var value := int(byte_value)
        result += HEX.substr((value >> 4) & 0x0f, 1)
        result += HEX.substr(value & 0x0f, 1)
    return result


func _failure(reason: String, request_result: int, status: int, size: int, transient: bool) -> Dictionary:
    return {
        "ok": false,
        "reason": reason,
        "requestResult": request_result,
        "status": status,
        "bytes": size,
        "transient": transient,
    }


func _make_detail(
    asset_type: String,
    response: Dictionary,
    attempt: int,
    retry_delay: float,
    will_retry: bool
) -> Dictionary:
    return {
        "assetType": asset_type,
        "reason": _safe_string(response.get("reason", "unknown")),
        "requestResult": int(response.get("requestResult", -1)),
        "status": int(response.get("status", 0)),
        "bytes": int(response.get("bytes", 0)),
        "attempt": attempt,
        "maxAttempts": MAX_ATTEMPTS,
        "retryDelay": retry_delay,
        "willRetry": will_retry,
    }


func _finish_failure(
    object_id: String,
    signature: String,
    token: int,
    asset_type: String,
    response: Dictionary,
    attempt: int
) -> void:
    if not _is_current(object_id, signature, token):
        return
    var detail := _make_detail(asset_type, response, attempt, 0.0, false)
    _emit_diagnostic(object_id, detail)
    _states.erase(object_id)
    asset_failed.emit(object_id, signature, asset_type, detail)


func _emit_diagnostic(object_id: String, detail: Dictionary) -> void:
    diagnostic.emit(object_id, detail.duplicate(true))
    push_warning(
        (
            "[SceneSync] remote asset failure type=%s reason=%s result=%d status=%d bytes=%d "
            + "attempt=%d/%d retry=%.3f willRetry=%s"
        )
        % [
            _safe_string(detail.get("assetType", "")),
            _safe_string(detail.get("reason", "unknown")),
            int(detail.get("requestResult", -1)),
            int(detail.get("status", 0)),
            int(detail.get("bytes", 0)),
            int(detail.get("attempt", 0)),
            int(detail.get("maxAttempts", MAX_ATTEMPTS)),
            float(detail.get("retryDelay", 0.0)),
            str(bool(detail.get("willRetry", false))),
        ]
    )


func _is_current(object_id: String, signature: String, token: int) -> bool:
    var state_value = _states.get(object_id, {})
    if not (state_value is Dictionary):
        return false
    var state := state_value as Dictionary
    return (
        String(state.get("signature", "")) == signature
        and int(state.get("token", -1)) == token
    )


func _set_active_request(
    object_id: String,
    signature: String,
    token: int,
    request: HTTPRequest
) -> bool:
    if not _is_current(object_id, signature, token):
        return false
    var state := _states[object_id] as Dictionary
    state["request"] = request
    _states[object_id] = state
    return true


func _clear_active_request(
    object_id: String,
    signature: String,
    token: int,
    request: HTTPRequest
) -> void:
    if not _is_current(object_id, signature, token):
        return
    var state := _states[object_id] as Dictionary
    if state.get("request", null) == request:
        state["request"] = null
        _states[object_id] = state


func _cancel_and_release_request(request: HTTPRequest) -> void:
    if not is_instance_valid(request):
        return
    request.cancel_request()
    request.request_completed.emit(
        HTTPRequest.RESULT_REQUEST_FAILED,
        0,
        PackedStringArray(),
        PackedByteArray()
    )
