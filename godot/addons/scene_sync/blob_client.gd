class_name SceneSyncBlobClient
extends Node

var blob_base_url: String = "https://afjk.jp/presence/blob"


func upload_glb(data: PackedByteArray, path: String) -> Error:
    var request := HTTPRequest.new()
    add_child(request)

    var url := "%s/%s" % [blob_base_url.trim_suffix("/"), path.uri_encode()]
    var headers := PackedStringArray(["Content-Type: model/gltf-binary"])
    var err := request.request_raw(url, headers, HTTPClient.METHOD_POST, data)
    if err != OK:
        push_warning("[SceneSync] Blob upload request failed: %s" % error_string(err))
        request.queue_free()
        return err

    var result: Array = await request.request_completed
    request.queue_free()

    var response_code := int(result[1])
    if response_code != 201:
        push_warning("[SceneSync] Blob upload failed: HTTP %d (%s)" % [response_code, path])
        return ERR_CANT_CONNECT
    return OK


func download_glb(path: String) -> PackedByteArray:
    var request := HTTPRequest.new()
    add_child(request)

    var url := "%s/%s" % [blob_base_url.trim_suffix("/"), path.uri_encode()]
    var err := request.request(url)
    if err != OK:
        push_warning("[SceneSync] Blob download request failed: %s" % error_string(err))
        request.queue_free()
        return PackedByteArray()

    var result: Array = await request.request_completed
    request.queue_free()

    var response_code := int(result[1])
    if response_code != 200:
        return PackedByteArray()

    return result[3]


static func generate_random_path() -> String:
    const CHARS := "abcdefghijklmnopqrstuvwxyz0123456789"
    var rng := RandomNumberGenerator.new()
    rng.randomize()
    var result := ""
    for i in range(8):
        result += CHARS[rng.randi_range(0, CHARS.length() - 1)]
    return result
