using System;
using System.Collections.Generic;
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

        private void OnEnable()
        {
            _client = new PresenceClient();
            _client.OnConnected += () => { _connected = true; Repaint(); };
            _client.OnDisconnected += () => { _connected = false; Repaint(); };
            _client.OnPeersUpdated += (peers) => { _peers = peers; Repaint(); };
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

        private void EditorUpdate()
        {
            if (!_connected) return;

            // Selection 変更のチェック
            var selection = Selection.activeGameObject;
            var selectionId = selection != null ? selection.GetInstanceID().ToString() : null;

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

            var id = selection.GetInstanceID().ToString();
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
                "\"rotation\":[" + (-rot.x) + "," + (-rot.y) + "," + rot.z + "," + rot.w + "]," +
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
            var rootObjects = UnityEngine.SceneManagement.SceneManager
                .GetActiveScene().GetRootGameObjects();

            foreach (var go in rootObjects)
            {
                if (go.hideFlags != HideFlags.None) continue;
                var id = go.GetInstanceID().ToString();
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
                }
            }

            _knownObjectIds = currentIds;
        }

        private void OnHandoff(string raw)
        {
            // JSON から kind を抽出
            if (!raw.Contains("\"kind\"")) return;

            if (raw.Contains("\"kind\":\"scene-request\""))
            {
                _ = HandleSceneRequest();
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
                go.transform.rotation = new Quaternion(-rotation[0], -rotation[1], rotation[2], rotation[3]);

            if (scale != null && scale.Length >= 3)
                go.transform.localScale = new Vector3(scale[0], scale[1], scale[2]);
        }

        private GameObject FindManagedObject(string objectId)
        {
            if (_managedObjects.TryGetValue(objectId, out var go))
                return go;

            var id = int.Parse(objectId);
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

            var meshPathJson = path != null ? ",\"meshPath\":\"" + path + "\"" : "";
            var payload = "{\"kind\":\"scene-add\",\"objectId\":\"" + go.GetInstanceID() + "\",\"name\":\"" + go.name + "\"" +
                ",\"position\":[" + pos.x + "," + pos.y + "," + (-pos.z) + "]" +
                ",\"rotation\":[" + (-rot.x) + "," + (-rot.y) + "," + rot.z + "," + rot.w + "]" +
                ",\"scale\":[" + scl.x + "," + scl.y + "," + scl.z + "]" +
                meshPathJson + "}";
            await _client.Broadcast(payload);

            if (glb != null && path != null)
                _ = PresenceClient.UploadGlb(glb, GetBlobUrl(), path);
        }

        private async System.Threading.Tasks.Task SendSceneRemove(string objectId)
        {
            var payload = "{\"kind\":\"scene-remove\",\"objectId\":\"" + objectId + "\"}";
            await _client.Broadcast(payload);
        }

        private void HandleSceneAdd(string raw)
        {
            // ブラウザが受信した場合の処理
            // Unity 受信は簡略化（GameObject 生成は複雑なため省略）
        }

        private void HandleSceneRemove(string raw)
        {
            var objectIdMatch = System.Text.RegularExpressions.Regex.Match(raw, "\"objectId\":\"([^\"]+)\"");
            if (!objectIdMatch.Success) return;
            var objectId = objectIdMatch.Groups[1].Value;

            var go = FindManagedObject(objectId);
            if (go != null)
            {
                DestroyImmediate(go);
                _managedObjects.Remove(objectId);
                _knownObjectIds.Remove(objectId);
            }
        }

        private void HandleSceneMesh(string raw)
        {
            // ブラウザが受信した場合の処理
            // Unity 受信は不要（glB ロード機能がないため）
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
                var payload = "{\"kind\":\"scene-mesh\",\"objectId\":\"" + objectId + "\",\"meshPath\":\"" + path + "\"}";
                await _client.Broadcast(payload);
                _ = PresenceClient.UploadGlb(glb, GetBlobUrl(), path);
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

        private async System.Threading.Tasks.Task HandleSceneRequest()
        {
            var rootObjects = UnityEngine.SceneManagement.SceneManager
                .GetActiveScene().GetRootGameObjects();

            var objectsJson = new System.Text.StringBuilder();
            objectsJson.Append("{");
            bool first = true;
            var pendingUploads = new List<(byte[] glb, string path)>();

            foreach (var go in rootObjects)
            {
                if (go.hideFlags != HideFlags.None) continue;

                var pos = go.transform.position;
                var rot = go.transform.rotation;
                var scl = go.transform.localScale;

                string path = null;
                if (go.GetComponentInChildren<MeshFilter>() != null
                    || go.GetComponentInChildren<SkinnedMeshRenderer>() != null)
                {
                    var glb = await PresenceClient.ExportGameObjectAsGlb(go);
                    if (glb != null)
                    {
                        path = PresenceClient.GenerateRandomPath();
                        pendingUploads.Add((glb, path));
                    }
                }

                if (!first) objectsJson.Append(",");
                first = false;
                var meshPathJson = path != null ? ",\"meshPath\":\"" + path + "\"" : "";
                objectsJson.Append("\"" + go.GetInstanceID() + "\":{\"name\":\"" + go.name + "\"" +
                    ",\"position\":[" + pos.x + "," + pos.y + "," + (-pos.z) + "]" +
                    ",\"rotation\":[" + (-rot.x) + "," + (-rot.y) + "," + rot.z + "," + rot.w + "]" +
                    ",\"scale\":[" + scl.x + "," + scl.y + "," + scl.z + "]" +
                    meshPathJson + "}");
            }
            objectsJson.Append("}");

            var payload = "{\"kind\":\"scene-state\",\"objects\":" + objectsJson + "}";
            await _client.Broadcast(payload);

            // broadcast 後にアップロード（ブラウザが GET を始めるのを待って PUT）
            foreach (var (glb, path) in pendingUploads)
                _ = PresenceClient.UploadGlb(glb, GetBlobUrl(), path);
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
