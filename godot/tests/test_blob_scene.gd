extends Node

var _blob_client: SceneSyncBlobClient
var _timeout: float = 15.0
var _elapsed: float = 0.0
var _test_done: bool = false
var _passed: int = 0
var _failed: int = 0


func _ready() -> void:
    _blob_client = SceneSyncBlobClient.new()
    add_child(_blob_client)

    var url = OS.get_environment("SCENESYNC_BLOB_URL")
    if url == "":
        url = "http://localhost:8787/blob"
    _blob_client.blob_base_url = url

    _run_tests()


func _process(delta: float) -> void:
    _elapsed += delta
    if _elapsed > _timeout and not _test_done:
        _finish_all()


func _run_tests() -> void:
    var test_path = SceneSyncBlobClient.generate_random_path()
    var test_data = "hello scenesync".to_utf8_buffer()

    print("[Test] Uploading to %s/%s" % [_blob_client.blob_base_url, test_path])
    var upload_err = await _blob_client.upload_glb(test_data, test_path)
    if upload_err == OK:
        _passed += 1
        print("  OK: upload_glb")
    else:
        _failed += 1
        print("  FAIL: upload_glb error=%s" % error_string(upload_err))

    print("[Test] Downloading %s" % test_path)
    var downloaded = await _blob_client.download_glb(test_path)
    if downloaded == test_data:
        _passed += 1
        print("  OK: download_glb roundtrip")
    else:
        _failed += 1
        print("  FAIL: download_glb data mismatch (got %d bytes)" % downloaded.size())

    var missing = await _blob_client.download_glb("nonexistent-path-12345")
    if missing.size() == 0:
        _passed += 1
        print("  OK: download_glb missing returns empty")
    else:
        _failed += 1
        print("  FAIL: download_glb missing should be empty")

    _finish_all()


func _finish_all() -> void:
    if _test_done:
        return
    _test_done = true
    print("")
    print("========================================")
    print("  Blob Tests: PASSED=%d FAILED=%d" % [_passed, _failed])
    print("========================================")
    get_tree().quit(0 if _failed == 0 else 1)
