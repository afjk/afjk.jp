using System;
using System.Collections.Generic;
using System.Net.Http;
using GLTFast;
using UnityEditor;
using UnityEngine;

namespace Afjk.SceneSync.Editor
{
    public class SceneSyncWindow : EditorWindow
    {
        [MenuItem("Window/Scene Sync")]
        public static void ShowWindow()
        {
            GetWindow<SceneSyncWindow>("Scene Sync");
        }

        private PresenceClient _client;
        private string _presenceUrl = "wss://afjk.jp/presence";
        private string _blobUrl = "";
        private string _room = "";
        private string _nickname = "Unity";
        private bool _connected;
        private List<PeerInfo> _peers = new List<PeerInfo>();

        private Dictionary<string, TransformSnapshot> _lastSnapshots = new Dictionary<string, TransformSnapshot>();
        private double _lastSendTime;
        private const double SEND_INTERVAL = 0.05; // 50ms
        private Dictionary<string, GameObject> _managedObjects = new Dictionary<string, GameObject>();
        private HashSet<string> _knownObjectIds = new HashSet<string>();
        private Dictionary<string, string> _locks = new Dictionary<string, string>(); // objectId → lockOwnerId
        private string _currentlyLockedObjectId;
        private Dictionary<string, string> _meshPaths = new Dictionary<string, string>(); // objectId → meshPath
        private bool _sceneReceived = false;
        private bool _firstPeersReceived = false;
        private Dictionary<int, string> _instanceToObjectId = new Dictionary<int, string>(); // Unity InstanceID → 元の objectId

        private void OnEnable()
        {
            _client = new PresenceClient();
            _client.OnConnected += () => { _connected = true; Repaint(); };
            _client.OnDisconnected += () =>
            {
                _connected = false;
                _sceneReceived = false;
                _firstPeersReceived = false;
                Repaint();
            };
            _client.OnPeersUpdated += (peers) =>
            {
                _peers = peers;
                Repaint();

                // 初回 peers 受信時にシーンリクエストを送信
                if (!_firstPeersReceived && peers.Count > 0)
                {
                    _firstPeersReceived = true;
                    if (!_sceneReceived)
                    {
                        _ = RequestSceneFromPeer();
                    }
                }
            };
            _client.OnHandoffReceived += OnHandoff;

            EditorApplication.update += EditorUpdate;
            EditorApplication.hierarchyChanged += OnHierarchyChanged;
        }

        private void OnDisable()
        {
            EditorApplication.update -= EditorUpdate;
            EditorApplication.hierarchyChanged -= OnHierarchyChanged;
            _client?.Disconnect();
        }

        private string GetBlobUrl()
        {
            if (!string.IsNullOrEmpty(_blobUrl)) return _blobUrl;

            // wss://staging.afjk.jp/presence → https://staging.afjk.jp/presence/blob
            // ws://localhost:8787 → http://localhost:8787/blob
            var url = _presenceUrl
                .Replace("wss://", "https://")
                .Replace("ws://", "http://");
            if (url.EndsWith("/")) url = url.TrimEnd('/');
            return url + "/blob";
        }

        /// <summary>
        /// 同期対象かどうかを判定する。
        /// MeshFilter または SkinnedMeshRenderer を持つオブジェクトのみ対象。
        /// </summary>
        private static bool IsSyncTarget(GameObject go)
        {
            if (go.hideFlags != HideFlags.None) return false;
            return go.GetComponentInChildren<MeshFilter>() != null
                || go.GetComponentInChildren<SkinnedMeshRenderer>() != null;
        }

        private void EditorUpdate()
        {
            if (!_connected) return;

            // Selection 変更のチェック
            var selection = Selection.activeGameObject;
            string selectionId = null;
            if (selection != null)
            {
                if (_instanceToObjectId.TryGetValue(selection.GetInstanceID(), out var origId))
                    selectionId = origId;
                else if (IsSyncTarget(selection))
                    selectionId = selection.GetInstanceID().ToString();
                // メッシュなしの Unity オブジェクト（Camera 等）は selectionId = null のまま
            }

            // ロック状態の更新
            if (selectionId != _currentlyLockedObjectId)
            {
                // 前の選択をアンロック
                if (_currentlyLockedObjectId != null)
                {
                    _ = _client.Broadcast("{\"kind\":\"scene-unlock\",\"objectId\":\"" + _currentlyLockedObjectId + "\"}");
                }

                // 新しい選択をロック
                _currentlyLockedObjectId = selectionId;
                if (selectionId != null)
                {
                    _ = _client.Broadcast("{\"kind\":\"scene-lock\",\"objectId\":\"" + selectionId + "\"}");
                }
            }

            if (EditorApplication.timeSinceStartup - _lastSendTime < SEND_INTERVAL) return;
            _lastSendTime = EditorApplication.timeSinceStartup;

            if (selection == null) return;

            // メッシュを持たない && Web 由来でもないオブジェクトは同期しない
            if (!_instanceToObjectId.ContainsKey(selection.GetInstanceID())
                && !IsSyncTarget(selection))
                return;

            string id;
            if (_instanceToObjectId.TryGetValue(selection.GetInstanceID(), out var origDeltaId))
                id = origDeltaId;
            else
                id = selection.GetInstanceID().ToString();

            var t = selection.transform;
            var current = new TransformSnapshot(t.position, t.rotation, t.localScale);

            if (_lastSnapshots.TryGetValue(id, out var last) && last.Equals(current))
                return;

            _lastSnapshots[id] = current;

            var pos = t.position;
            var rot = t.rotation;
            var scl = t.localScale;

            var payload = "{" +
                "\"kind\":\"scene-delta\"," +
                "\"objectId\":\"" + id + "\"," +
                "\"position\":[" + pos.x + "," + pos.y + "," + (-pos.z) + "]," +
                "\"rotation\":[" + rot.x + "," + rot.y + "," + (-rot.z) + "," + (-rot.w) + "]," +
                "\"scale\":[" + scl.x + "," + scl.y + "," + scl.z + "]" +
                "}";
            _ = _client.Broadcast(payload);
        }

        private void OnGUI()
        {
            GUILayout.Label("Scene Sync", EditorStyles.boldLabel);
            GUILayout.Space(4);

            _presenceUrl = EditorGUILayout.TextField("Presence URL", _presenceUrl);
            _blobUrl = EditorGUILayout.TextField("Blob URL", _blobUrl);
            _room = EditorGUILayout.TextField("Room", _room);
            _nickname = EditorGUILayout.TextField("Nickname", _nickname);

            GUILayout.Space(8);

            if (!_connected)
            {
                if (GUILayout.Button("Connect"))
                {
                    _ = _client.ConnectAsync(_presenceUrl, _room, _nickname);
                }
            }
            else
            {
                EditorGUILayout.HelpBox(
                    "Connected\nRoom: " + _client.Room + "\nPeers: " + _peers.Count,
                    MessageType.Info
                );

                if (_peers.Count > 0)
                {
                    GUILayout.Label("Peers:", EditorStyles.miniLabel);
                    foreach (var p in _peers)
                    {
                        GUILayout.Label("  " + p.nickname + " (" + p.device + ")",
                            EditorStyles.miniLabel);
                    }
                }

                GUILayout.Space(8);

                if (GUILayout.Button("Sync Meshes"))
                {
                    _ = SyncAllMeshes();
                }

                if (GUILayout.Button("Disconnect"))
                {
                    _client.Disconnect();
                }
            }
        }

        private void OnHierarchyChanged()
        {
            if (!_connected) return;
            var currentIds = new HashSet<string>();
            var currentInstanceIds = new HashSet<int>();
            var rootObjects = UnityEngine.SceneManagement.SceneManager
                .GetActiveScene().GetRootGameObjects();

            foreach (var go in rootObjects)
            {
                if (go.hideFlags != HideFlags.None) continue;
                var instanceId = go.GetInstanceID();
                currentInstanceIds.Add(instanceId);

                // Web 由来オブジェクト
                if (_instanceToObjectId.TryGetValue(instanceId, out var originalId))
                {
                    // Web 由来: 元の objectId で管理
                    currentIds.Add(originalId);
                    continue;
                }

                // Unity 由来: メッシュを持たないオブジェクトはスキップ
                if (!IsSyncTarget(go)) continue;

                var id = instanceId.ToString();
                currentIds.Add(id);

                if (!_knownObjectIds.Contains(id))
                {
                    // 新規オブジェクト
                    _ = SendSceneAdd(go);
                }
            }

            // 削除されたオブジェクト
            foreach (var id in _knownObjectIds)
            {
                if (!currentIds.Contains(id))
                {
                    _ = SendSceneRemove(id);
                    _meshPaths.Remove(id);
                    _locks.Remove(id);
                }
            }

            // _instanceToObjectId のクリーンアップ（削除された GameObject を除去）
            var staleInstances = new List<int>();
            foreach (var kvp in _instanceToObjectId)
            {
                if (!currentInstanceIds.Contains(kvp.Key))
                    staleInstances.Add(kvp.Key);
            }
            foreach (var key in staleInstances)
                _instanceToObjectId.Remove(key);

            _knownObjectIds = currentIds;
        }

        private void OnHandoff(string raw)
        {
            if (!raw.Contains("\"kind\"")) return;

            // from.id を抽出（handoff メッセージに含まれる）
            string fromId = null;
            var fromIdMatch = System.Text.RegularExpressions.Regex.Match(
                raw, "\"from\"\\s*:\\s*\\{[^}]*\"id\"\\s*:\\s*\"([^\"]+)\"");
            if (fromIdMatch.Success)
                fromId = fromIdMatch.Groups[1].Value;

            if (raw.Contains("\"kind\":\"scene-request\""))
            {
                if (fromId != null)
                    _ = HandleSceneRequest(fromId);
                else
                    Debug.LogWarning("[SceneSync] scene-request without from.id");
            }
            else if (raw.Contains("\"kind\":\"scene-state\""))
            {
                HandleSceneState(raw);
            }
            else if (raw.Contains("\"kind\":\"scene-delta\""))
            {
                HandleSceneDelta(raw);
            }
            else if (raw.Contains("\"kind\":\"scene-add\""))
            {
                HandleSceneAdd(raw);
            }
            else if (raw.Contains("\"kind\":\"scene-remove\""))
            {
                HandleSceneRemove(raw);
            }
            else if (raw.Contains("\"kind\":\"scene-mesh\""))
            {
                HandleSceneMesh(raw);
            }
            else if (raw.Contains("\"kind\":\"scene-lock\""))
            {
                HandleSceneLock(raw);
            }
            else if (raw.Contains("\"kind\":\"scene-unlock\""))
            {
                HandleSceneUnlock(raw);
            }
        }

        private async System.Threading.Tasks.Task RequestSceneFromPeer()
        {
            var peers = _peers;
            if (peers == null || peers.Count == 0)
            {
                _sceneReceived = true;
                return;
            }

            // 自分以外の最初のピアに handoff で送信
            foreach (var peer in peers)
            {
                if (peer.id == _client.Id) continue;

                Debug.Log("[SceneSync] Requesting scene from: " +
                    (peer.nickname ?? peer.id));
                await _client.SendHandoff(peer.id,
                    "{\"kind\":\"scene-request\"}");
                return;
            }

            // 自分しかいない
            _sceneReceived = true;
        }

        private void HandleSceneState(string raw)
        {
            _sceneReceived = true;
            Debug.Log("[SceneSync] Received scene-state");

            // "objects":{...} の中身を簡易パース
            var objectsMatch = System.Text.RegularExpressions.Regex.Match(
                raw, "\"objects\"\\s*:\\s*\\{(.+)\\}\\s*\\}\\s*$");
            if (!objectsMatch.Success) return;

            var objectsBody = objectsMatch.Groups[1].Value;

            // 各 "objectId":{...} を抽出
            var entryPattern = new System.Text.RegularExpressions.Regex(
                "\"([^\"]+)\"\\s*:\\s*\\{([^{}]+)\\}");
            var matches = entryPattern.Matches(objectsBody);

            foreach (System.Text.RegularExpressions.Match m in matches)
            {
                var objectId = m.Groups[1].Value;
                var body = m.Groups[2].Value;

                // scene-add 相当の JSON を構築して処理
                var fakeJson = "{\"kind\":\"scene-add\",\"objectId\":\"" + objectId + "\"," + body + "}";
                HandleSceneAdd(fakeJson);
            }
        }

        private void HandleSceneDelta(string raw)
        {
            // 簡易 JSON パース（scene-delta 専用）
            var objectIdMatch = System.Text.RegularExpressions.Regex.Match(raw, "\"objectId\":\"([^\"]+)\"");
            if (!objectIdMatch.Success) return;
            var objectId = objectIdMatch.Groups[1].Value;

            float[] position = ExtractArray(raw, "\"position\":");
            float[] rotation = ExtractArray(raw, "\"rotation\":");
            float[] scale = ExtractArray(raw, "\"scale\":");

            var go = FindManagedObject(objectId);
            if (go == null) return;

            // 現在選択されているオブジェクトなら無視（Last-Writer-Wins）
            if (Selection.activeGameObject == go) return;

            // ワイヤー（Three.js 座標系）→ Unity 座標系に逆変換
            if (position != null && position.Length >= 3)
                go.transform.position = new Vector3(position[0], position[1], -position[2]);

            if (rotation != null && rotation.Length >= 4)
                go.transform.rotation = new Quaternion(rotation[0], rotation[1], -rotation[2], -rotation[3]);

            if (scale != null && scale.Length >= 3)
                go.transform.localScale = new Vector3(scale[0], scale[1], scale[2]);
        }

        private GameObject FindManagedObject(string objectId)
        {
            if (_managedObjects.TryGetValue(objectId, out var go))
            {
                if (go != null) return go;
                _managedObjects.Remove(objectId);
            }

            // Unity 由来の objectId は数値（InstanceID）
            if (int.TryParse(objectId, out var id))
            {
                var rootObjects = UnityEngine.SceneManagement.SceneManager
                    .GetActiveScene().GetRootGameObjects();

                foreach (var root in rootObjects)
                {
                    if (root.GetInstanceID() == id)
                    {
                        _managedObjects[objectId] = root;
                        return root;
                    }
                }
            }

            // Web 由来の objectId ("web-xxxxx") は _managedObjects にのみ存在
            return null;
        }

        private float[] ExtractArray(string json, string key)
        {
            var pattern = System.Text.RegularExpressions.Regex.Escape(key) + @"\s*\[([\d\.,\-\s]+)\]";
            var match = System.Text.RegularExpressions.Regex.Match(json, pattern);
            if (!match.Success) return null;

            var nums = match.Groups[1].Value.Split(',');
            var result = new float[nums.Length];
            for (int i = 0; i < nums.Length; i++)
            {
                if (float.TryParse(nums[i].Trim(), out var f))
                    result[i] = f;
            }
            return result;
        }

        private async System.Threading.Tasks.Task SendSceneAdd(GameObject go)
        {
            var pos = go.transform.position;
            var rot = go.transform.rotation;
            var scl = go.transform.localScale;

            byte[] glb = null;
            string path = null;
            if (go.GetComponentInChildren<MeshFilter>() != null
                || go.GetComponentInChildren<SkinnedMeshRenderer>() != null)
            {
                glb = await PresenceClient.ExportGameObjectAsGlb(go);
                if (glb != null)
                    path = PresenceClient.GenerateRandomPath();
            }

            // アップロードを先に完了させてから Broadcast する
            if (glb != null && path != null)
            {
                _meshPaths[go.GetInstanceID().ToString()] = path;
                await PresenceClient.UploadGlb(glb, GetBlobUrl(), path);
            }

            var meshPathJson = path != null ? ",\"meshPath\":\"" + path + "\"" : "";
            var payload = "{\"kind\":\"scene-add\",\"objectId\":\"" + go.GetInstanceID() + "\",\"name\":\"" + go.name + "\"" +
                ",\"position\":[" + pos.x + "," + pos.y + "," + (-pos.z) + "]" +
                ",\"rotation\":[" + rot.x + "," + rot.y + "," + (-rot.z) + "," + (-rot.w) + "]" +
                ",\"scale\":[" + scl.x + "," + scl.y + "," + scl.z + "]" +
                meshPathJson + "}";
            await _client.Broadcast(payload);
        }

        private async System.Threading.Tasks.Task SendSceneRemove(string objectId)
        {
            var payload = "{\"kind\":\"scene-remove\",\"objectId\":\"" + objectId + "\"}";
            await _client.Broadcast(payload);
        }

        private void HandleSceneAdd(string raw)
        {
            var objectIdMatch = System.Text.RegularExpressions.Regex.Match(
                raw, "\"objectId\":\"([^\"]+)\"");
            if (!objectIdMatch.Success) return;
            var objectId = objectIdMatch.Groups[1].Value;

            // 既に存在する場合はスキップ
            if (_managedObjects.ContainsKey(objectId)) return;

            var nameMatch = System.Text.RegularExpressions.Regex.Match(
                raw, "\"name\":\"([^\"]+)\"");
            var name = nameMatch.Success ? nameMatch.Groups[1].Value : objectId;

            float[] position = ExtractArray(raw, "\"position\":");
            float[] rotation = ExtractArray(raw, "\"rotation\":");
            float[] scale = ExtractArray(raw, "\"scale\":");

            var meshPathMatch = System.Text.RegularExpressions.Regex.Match(
                raw, "\"meshPath\":\"([^\"]+)\"");
            var meshPath = meshPathMatch.Success ? meshPathMatch.Groups[1].Value : null;

            // meshPath を保存
            if (!string.IsNullOrEmpty(meshPath))
            {
                _meshPaths[objectId] = meshPath;
            }

            // メッシュがある場合は glB をダウンロードしてインポート
            if (!string.IsNullOrEmpty(meshPath))
            {
                _ = DownloadAndCreateObject(objectId, name, meshPath, position, rotation, scale);
            }
            else
            {
                // メッシュなしの場合はプレースホルダーの Cube を作成
                var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
                go.name = name;
                ApplyTransform(go, position, rotation, scale);
                _managedObjects[objectId] = go;
                _knownObjectIds.Add(objectId);
                _instanceToObjectId[go.GetInstanceID()] = objectId;
            }
        }

        private void HandleSceneRemove(string raw)
        {
            var objectIdMatch = System.Text.RegularExpressions.Regex.Match(raw, "\"objectId\":\"([^\"]+)\"");
            if (!objectIdMatch.Success) return;
            var objectId = objectIdMatch.Groups[1].Value;

            var go = FindManagedObject(objectId);
            if (go != null)
            {
                _instanceToObjectId.Remove(go.GetInstanceID());
                DestroyImmediate(go);
                _managedObjects.Remove(objectId);
                _knownObjectIds.Remove(objectId);
            }
            _meshPaths.Remove(objectId);
            _locks.Remove(objectId);
        }

        private void HandleSceneMesh(string raw)
        {
            var objectIdMatch = System.Text.RegularExpressions.Regex.Match(
                raw, "\"objectId\":\"([^\"]+)\"");
            if (!objectIdMatch.Success) return;
            var objectId = objectIdMatch.Groups[1].Value;

            var meshPathMatch = System.Text.RegularExpressions.Regex.Match(
                raw, "\"meshPath\":\"([^\"]+)\"");
            if (!meshPathMatch.Success) return;
            var meshPath = meshPathMatch.Groups[1].Value;

            // meshPath を保存
            _meshPaths[objectId] = meshPath;

            var go = FindManagedObject(objectId);
            var name = go != null ? go.name : objectId;

            // 既存オブジェクトがあれば削除して再作成
            if (go != null)
            {
                var pos = go.transform.position;
                var rot = go.transform.rotation;
                var scl = go.transform.localScale;
                DestroyImmediate(go);
                _managedObjects.Remove(objectId);

                _ = DownloadAndCreateObject(objectId, name, meshPath,
                    new float[] { pos.x, pos.y, -pos.z },
                    new float[] { rot.x, rot.y, -rot.z, -rot.w },
                    new float[] { scl.x, scl.y, scl.z });
            }
            else
            {
                _ = DownloadAndCreateObject(objectId, name, meshPath, null, null, null);
            }
        }

        private async System.Threading.Tasks.Task SyncAllMeshes()
        {
            var rootObjects = UnityEngine.SceneManagement.SceneManager
                .GetActiveScene().GetRootGameObjects();

            foreach (var go in rootObjects)
            {
                if (go.hideFlags != HideFlags.None) continue;
                if (go.GetComponentInChildren<MeshFilter>() == null
                    && go.GetComponentInChildren<SkinnedMeshRenderer>() == null)
                    continue;

                var glb = await PresenceClient.ExportGameObjectAsGlb(go);
                if (glb == null) continue;

                var objectId = go.GetInstanceID().ToString();

                // blob store に POST（全クライアント共有）
                var path = PresenceClient.GenerateRandomPath();
                _meshPaths[objectId] = path;
                await PresenceClient.UploadGlb(glb, GetBlobUrl(), path);

                var payload = "{\"kind\":\"scene-mesh\",\"objectId\":\"" + objectId + "\",\"meshPath\":\"" + path + "\"}";
                await _client.Broadcast(payload);
            }
        }

        private void HandleSceneLock(string raw)
        {
            var objectIdMatch = System.Text.RegularExpressions.Regex.Match(raw, "\"objectId\":\"([^\"]+)\"");
            if (!objectIdMatch.Success) return;
            var objectId = objectIdMatch.Groups[1].Value;

            var fromIdMatch = System.Text.RegularExpressions.Regex.Match(raw, "\"id\":\"([^\"]+)\"");
            var fromId = fromIdMatch.Success ? fromIdMatch.Groups[1].Value : null;

            _locks[objectId] = fromId;
        }

        private void HandleSceneUnlock(string raw)
        {
            var objectIdMatch = System.Text.RegularExpressions.Regex.Match(raw, "\"objectId\":\"([^\"]+)\"");
            if (!objectIdMatch.Success) return;
            var objectId = objectIdMatch.Groups[1].Value;

            _locks.Remove(objectId);
        }

        private async System.Threading.Tasks.Task HandleSceneRequest(string fromId)
        {
            Debug.Log("[SceneSync] Responding to scene-request for: " + fromId);

            var rootObjects = UnityEngine.SceneManagement.SceneManager
                .GetActiveScene().GetRootGameObjects();

            var objectsJson = new System.Text.StringBuilder();
            objectsJson.Append("{");
            bool first = true;
            var pendingUploads = new List<(byte[] glb, string path)>();

            foreach (var go in rootObjects)
            {
                if (!IsSyncTarget(go)) continue;

                var objectId = go.GetInstanceID().ToString();
                var pos = go.transform.position;
                var rot = go.transform.rotation;
                var scl = go.transform.localScale;

                // 保存済み meshPath を優先使用
                string path = null;
                if (_meshPaths.TryGetValue(objectId, out var savedPath))
                {
                    path = savedPath;
                }
                else if (go.GetComponentInChildren<MeshFilter>() != null
                    || go.GetComponentInChildren<SkinnedMeshRenderer>() != null)
                {
                    var glb = await PresenceClient.ExportGameObjectAsGlb(go);
                    if (glb != null)
                    {
                        path = PresenceClient.GenerateRandomPath();
                        pendingUploads.Add((glb, path));
                        _meshPaths[objectId] = path;
                    }
                }

                if (!first) objectsJson.Append(",");
                first = false;
                var meshPathJson = path != null ? ",\"meshPath\":\"" + path + "\"" : "";
                objectsJson.Append("\"" + objectId + "\":{\"name\":\"" + go.name + "\"" +
                    ",\"position\":[" + pos.x + "," + pos.y + "," + (-pos.z) + "]" +
                    ",\"rotation\":[" + rot.x + "," + rot.y + "," + (-rot.z) + "," + (-rot.w) + "]" +
                    ",\"scale\":[" + scl.x + "," + scl.y + "," + scl.z + "]" +
                    meshPathJson + "}");
            }

            // Web 由来のオブジェクトも含める
            foreach (var kvp in _managedObjects)
            {
                if (int.TryParse(kvp.Key, out _)) continue; // Unity 由来はスキップ（上で処理済み）
                var go = kvp.Value;
                if (go == null) continue;

                var pos = go.transform.position;
                var rot = go.transform.rotation;
                var scl = go.transform.localScale;

                string path = null;
                _meshPaths.TryGetValue(kvp.Key, out path);

                if (!first) objectsJson.Append(",");
                first = false;
                var meshPathJson = path != null ? ",\"meshPath\":\"" + path + "\"" : "";
                objectsJson.Append("\"" + kvp.Key + "\":{\"name\":\"" + go.name + "\"" +
                    ",\"position\":[" + pos.x + "," + pos.y + "," + (-pos.z) + "]" +
                    ",\"rotation\":[" + rot.x + "," + rot.y + "," + (-rot.z) + "," + (-rot.w) + "]" +
                    ",\"scale\":[" + scl.x + "," + scl.y + "," + scl.z + "]" +
                    meshPathJson + "}");
            }

            objectsJson.Append("}");

            // アップロードを先に完了させる
            foreach (var (glb, path) in pendingUploads)
                await PresenceClient.UploadGlb(glb, GetBlobUrl(), path);

            // handoff で 1対1 返信（broadcast ではない）
            var payload = "{\"kind\":\"scene-state\",\"objects\":" + objectsJson + "}";
            await _client.SendHandoff(fromId, payload);
        }

        private void ApplyTransform(GameObject go, float[] position, float[] rotation, float[] scale)
        {
            // Wire 形式（Three.js 座標系）→ Unity 座標系
            if (position != null && position.Length >= 3)
                go.transform.position = new Vector3(position[0], position[1], -position[2]);

            if (rotation != null && rotation.Length >= 4)
                go.transform.rotation = new Quaternion(rotation[0], rotation[1], -rotation[2], -rotation[3]);

            if (scale != null && scale.Length >= 3)
                go.transform.localScale = new Vector3(scale[0], scale[1], scale[2]);
        }

        private async System.Threading.Tasks.Task DownloadAndCreateObject(
            string objectId, string name, string meshPath,
            float[] position, float[] rotation, float[] scale)
        {
            try
            {
                var url = GetBlobUrl() + "/" + meshPath;
                Debug.Log("[SceneSync] Downloading mesh: " + url);

                var http = new HttpClient();
                var response = await http.GetAsync(url);

                if (!response.IsSuccessStatusCode)
                {
                    Debug.LogWarning("[SceneSync] Download failed: " + response.StatusCode);
                    // フォールバック: Cube を作成
                    var fallback = GameObject.CreatePrimitive(PrimitiveType.Cube);
                    fallback.name = name;
                    ApplyTransform(fallback, position, rotation, scale);
                    _managedObjects[objectId] = fallback;
                    _knownObjectIds.Add(objectId);
                    _instanceToObjectId[fallback.GetInstanceID()] = objectId;
                    return;
                }

                var glbBytes = await response.Content.ReadAsByteArrayAsync();
                var tempPath = System.IO.Path.Combine(
                    Application.temporaryCachePath, meshPath + ".glb");
                System.IO.File.WriteAllBytes(tempPath, glbBytes);

                // Editor モード: UninterruptedDeferAgent（DontDestroyOnLoad を使わない）
                var deferAgent = new GLTFast.UninterruptedDeferAgent();
                var importSettings = new GLTFast.ImportSettings
                {
                    AnimationMethod = GLTFast.AnimationMethod.None,
                };
                var gltf = new GLTFast.GltfImport(
                    downloadProvider: null,
                    deferAgent: deferAgent);
                var success = await gltf.Load("file://" + tempPath, importSettings);

                if (success)
                {
                    var go = new GameObject(name);
                    await gltf.InstantiateMainSceneAsync(go.transform);
                    // glTFast の座標変換は子ノードに含まれるのでそのまま保持
                    // wire の値は親の go に適用する
                    ApplyTransform(go, position, rotation, scale);
                    _managedObjects[objectId] = go;
                    _knownObjectIds.Add(objectId);
                    _instanceToObjectId[go.GetInstanceID()] = objectId;
                    Debug.Log("[SceneSync] Imported mesh: " + name);
                }
                else
                {
                    Debug.LogWarning("[SceneSync] glTF import failed for: " + name);
                    var fallback = GameObject.CreatePrimitive(PrimitiveType.Cube);
                    fallback.name = name;
                    ApplyTransform(fallback, position, rotation, scale);
                    _managedObjects[objectId] = fallback;
                    _knownObjectIds.Add(objectId);
                    _instanceToObjectId[fallback.GetInstanceID()] = objectId;
                }

                // 一時ファイル削除
                try { System.IO.File.Delete(tempPath); } catch { }
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[SceneSync] DownloadAndCreate failed: " + ex.Message);
            }
        }

        private struct TransformSnapshot
        {
            public Vector3 position;
            public Quaternion rotation;
            public Vector3 scale;

            public TransformSnapshot(Vector3 p, Quaternion r, Vector3 s)
            {
                position = p;
                rotation = r;
                scale = s;
            }

            public bool Equals(TransformSnapshot other)
            {
                return position == other.position
                    && rotation == other.rotation
                    && scale == other.scale;
            }
        }
    }
}
