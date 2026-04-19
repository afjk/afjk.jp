using System;
using System.Collections.Generic;
using System.Net.Http;
using GLTFast;
using UnityEngine;

namespace Afjk.SceneSync
{
    public class SceneSyncManager : MonoBehaviour
    {
        [SerializeField] private string _presenceUrl = "wss://afjk.jp/presence";
        [SerializeField] private string _blobUrl = "";
        [SerializeField] private string _room = "";
        [SerializeField] private string _nickname = "Unity";
        [SerializeField] private bool _autoConnect = true;
        [SerializeField] private Transform _syncRoot;

        private PresenceClientRuntime _client;
        private bool _connected;
        private List<PeerInfo> _peers = new List<PeerInfo>();
        private GameObject _selectedObject;

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
        private double _lastTime;

        public bool IsConnected => _connected;
        public string Room => _client?.Room;
        public List<PeerInfo> Peers => _peers;
        public GameObject SelectedObject => _selectedObject;

        public event Action OnConnected;
        public event Action OnDisconnected;
        public event Action<List<PeerInfo>> OnPeersUpdated;
        public event Action<string, GameObject> OnObjectAdded;
        public event Action<string> OnObjectRemoved;

        private void Awake()
        {
            _client = new PresenceClientRuntime();
            _client.OnConnected += () =>
            {
                _connected = true;
                OnConnected?.Invoke();
                Debug.Log("[SceneSync] Connected");
            };
            _client.OnDisconnected += () =>
            {
                _connected = false;
                _sceneReceived = false;
                _firstPeersReceived = false;
                OnDisconnected?.Invoke();
                Debug.Log("[SceneSync] Disconnected");
            };
            _client.OnPeersUpdated += (peers) =>
            {
                _peers = peers;
                OnPeersUpdated?.Invoke(_peers);

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

            _lastTime = Time.realtimeSinceStartup;
        }

        private void Start()
        {
            if (_autoConnect)
            {
                _ = Connect();
            }
        }

        private void OnDestroy()
        {
            _client?.Disconnect();
        }

        public async System.Threading.Tasks.Task Connect()
        {
            await _client.ConnectAsync(_presenceUrl, _room, _nickname);
        }

        public void Disconnect()
        {
            _client?.Disconnect();
        }

        public void SelectObject(GameObject go)
        {
            _selectedObject = go;
        }

        public void DeselectObject()
        {
            _selectedObject = null;
        }

        public async System.Threading.Tasks.Task SyncAllMeshes()
        {
            if (!_connected) return;

            var rootObjects = GetAllSyncTargets();

            foreach (var go in rootObjects)
            {
                if (go.hideFlags != HideFlags.None) continue;
                if (go.GetComponentInChildren<MeshFilter>() == null
                    && go.GetComponentInChildren<SkinnedMeshRenderer>() == null)
                    continue;

                var glb = await PresenceClientRuntime.ExportGameObjectAsGlb(go);
                if (glb == null) continue;

                var objectId = go.GetInstanceID().ToString();

                // blob store に POST（全クライアント共有）
                var path = PresenceClientRuntime.GenerateRandomPath();
                _meshPaths[objectId] = path;
                await PresenceClientRuntime.UploadGlb(glb, GetBlobUrl(), path);

                var payload = "{\"kind\":\"scene-mesh\",\"objectId\":\"" + objectId + "\",\"meshPath\":\"" + path + "\"}";
                await _client.Broadcast(payload);
            }
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

        private void Update()
        {
            if (!_connected) return;

            var currentTime = Time.realtimeSinceStartup;
            var deltaTime = currentTime - _lastTime;
            _lastTime = currentTime;

            // ロック状態の更新
            string selectionId = null;
            if (_selectedObject != null)
            {
                if (_instanceToObjectId.TryGetValue(_selectedObject.GetInstanceID(), out var origId))
                    selectionId = origId;
                else if (IsSyncTarget(_selectedObject))
                    selectionId = _selectedObject.GetInstanceID().ToString();
            }

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

            // Transform delta 送信（50ms 間隔）
            if (currentTime - _lastSendTime >= SEND_INTERVAL)
            {
                _lastSendTime = currentTime;
                SendTransformDelta();
            }

            // シーン差分検出
            DetectHierarchyChanges();
        }

        private void SendTransformDelta()
        {
            if (_selectedObject == null) return;

            // メッシュを持たない && Web 由来でもないオブジェクトは同期しない
            if (!_instanceToObjectId.ContainsKey(_selectedObject.GetInstanceID())
                && !IsSyncTarget(_selectedObject))
                return;

            string id;
            if (_instanceToObjectId.TryGetValue(_selectedObject.GetInstanceID(), out var origDeltaId))
                id = origDeltaId;
            else
                id = _selectedObject.GetInstanceID().ToString();

            var t = _selectedObject.transform;
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

        private static GameObject[] GetSyncRootChildren(GameObject root)
        {
            var children = new List<GameObject>();
            foreach (Transform child in root.transform)
                children.Add(child.gameObject);
            return children.ToArray();
        }

        private GameObject[] GetAllSyncTargets()
        {
            // _syncRoot が指定されていても Scene Root も監視する
            // （_syncRoot の外にあるオブジェクトが削除判定されるのを防ぐ）
            var rootObjectsList = new List<GameObject>();

            if (_syncRoot != null)
            {
                foreach (var child in GetSyncRootChildren(_syncRoot.gameObject))
                    rootObjectsList.Add(child);
            }

            var sceneRoots = UnityEngine.SceneManagement.SceneManager.GetActiveScene().GetRootGameObjects();
            var syncRootGO = _syncRoot != null ? _syncRoot.gameObject : null;

            foreach (var sceneRoot in sceneRoots)
            {
                // _syncRoot 自体は追加しない（既に子として処理済み）
                if (syncRootGO != null && sceneRoot == syncRootGO)
                    continue;

                rootObjectsList.Add(sceneRoot);
            }

            return rootObjectsList.ToArray();
        }

        private void DetectHierarchyChanges()
        {
            if (!_connected) return;
            var currentIds = new HashSet<string>();
            var currentInstanceIds = new HashSet<int>();

            var rootObjects = GetAllSyncTargets();

            foreach (var go in rootObjects)
            {
                var instanceId = go.GetInstanceID();

                // Web 由来オブジェクト（hideFlags に関係なく同期対象）
                if (_instanceToObjectId.TryGetValue(instanceId, out var originalId))
                {
                    // Web 由来: 元の objectId で管理
                    currentIds.Add(originalId);
                    currentInstanceIds.Add(instanceId);
                    continue;
                }

                // Unity 由来は hideFlags をチェック
                if (go.hideFlags != HideFlags.None) continue;
                currentInstanceIds.Add(instanceId);

                // メッシュを持たないオブジェクトはスキップ
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

        private static bool IsSyncTarget(GameObject go)
        {
            if (go.hideFlags != HideFlags.None) return false;
            return go.GetComponentInChildren<MeshFilter>() != null
                || go.GetComponentInChildren<SkinnedMeshRenderer>() != null;
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
                glb = await PresenceClientRuntime.ExportGameObjectAsGlb(go);
                if (glb != null)
                    path = PresenceClientRuntime.GenerateRandomPath();
            }

            // アップロードを先に完了させてから Broadcast する
            if (glb != null && path != null)
            {
                _meshPaths[go.GetInstanceID().ToString()] = path;
                await PresenceClientRuntime.UploadGlb(glb, GetBlobUrl(), path);
            }

            var meshPathJson = path != null ? ",\"meshPath\":\"" + path + "\"" : "";
            var payload = "{\"kind\":\"scene-add\",\"objectId\":\"" + go.GetInstanceID() + "\",\"name\":\"" + go.name + "\"" +
                ",\"position\":[" + pos.x + "," + pos.y + "," + (-pos.z) + "]" +
                ",\"rotation\":[" + rot.x + "," + rot.y + "," + (-rot.z) + "," + (-rot.w) + "]" +
                ",\"scale\":[" + scl.x + "," + scl.y + "," + scl.z + "]" +
                meshPathJson + "}";
            await _client.Broadcast(payload);

            _knownObjectIds.Add(go.GetInstanceID().ToString());
            OnObjectAdded?.Invoke(go.GetInstanceID().ToString(), go);
        }

        private async System.Threading.Tasks.Task SendSceneRemove(string objectId)
        {
            var payload = "{\"kind\":\"scene-remove\",\"objectId\":\"" + objectId + "\"}";
            await _client.Broadcast(payload);
            OnObjectRemoved?.Invoke(objectId);
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
            if (go == _selectedObject) return;

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
                var rootObjects = GetAllSyncTargets();

                foreach (var r in rootObjects)
                {
                    if (r.GetInstanceID() == id)
                    {
                        _managedObjects[objectId] = r;
                        return r;
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
                // プレースホルダーを先行登録（同期フェーズで登録を確実にする）
                var placeholder = new GameObject(objectId);
                placeholder.hideFlags = HideFlags.NotEditable;
                if (_syncRoot != null)
                    placeholder.transform.SetParent(_syncRoot, worldPositionStays: true);

                _managedObjects[objectId] = placeholder;
                _knownObjectIds.Add(objectId);
                _instanceToObjectId[placeholder.GetInstanceID()] = objectId;

                // 非同期でダウンロード・インポート開始
                _ = DownloadAndCreateObject(objectId, name, meshPath, position, rotation, scale);
            }
            else
            {
                // メッシュなしの場合は Cube を作成
                var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
                go.name = name;

                _managedObjects[objectId] = go;
                _knownObjectIds.Add(objectId);
                _instanceToObjectId[go.GetInstanceID()] = objectId;

                // 位置・回転・スケールを設定（SetParent の前）
                ApplyTransform(go, position, rotation, scale);

                // SetParent は ApplyTransform の後で実行（ワールド座標を保持）
                if (_syncRoot != null)
                    go.transform.SetParent(_syncRoot, worldPositionStays: true);

                OnObjectAdded?.Invoke(objectId, go);
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
                Destroy(go);
                _managedObjects.Remove(objectId);
                _knownObjectIds.Remove(objectId);
            }
            _meshPaths.Remove(objectId);
            _locks.Remove(objectId);
            OnObjectRemoved?.Invoke(objectId);
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
                Destroy(go);
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

            var rootObjects = GetAllSyncTargets();

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
                    var glb = await PresenceClientRuntime.ExportGameObjectAsGlb(go);
                    if (glb != null)
                    {
                        path = PresenceClientRuntime.GenerateRandomPath();
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
                await PresenceClientRuntime.UploadGlb(glb, GetBlobUrl(), path);

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

        private static string FormatArray(float[] values)
        {
            if (values == null) return "null";
            return "[" + string.Join(", ", values) + "]";
        }

        private static int CountDescendants(Transform root)
        {
            if (root == null) return 0;

            var count = 0;
            foreach (Transform child in root)
            {
                count++;
                count += CountDescendants(child);
            }

            return count;
        }

        private static string DescribeGameObject(GameObject go)
        {
            if (go == null) return "null";

            return "name=" + go.name
                + ", instanceId=" + go.GetInstanceID()
                + ", activeSelf=" + go.activeSelf
                + ", activeInHierarchy=" + go.activeInHierarchy
                + ", children=" + go.transform.childCount
                + ", descendants=" + CountDescendants(go.transform)
                + ", meshFilters=" + go.GetComponentsInChildren<MeshFilter>(true).Length
                + ", skinnedMeshes=" + go.GetComponentsInChildren<SkinnedMeshRenderer>(true).Length
                + ", renderers=" + go.GetComponentsInChildren<Renderer>(true).Length;
        }

        private string DescribeManagedObjectState(string objectId)
        {
            if (string.IsNullOrEmpty(objectId)) return "objectId=null";

            if (!_managedObjects.TryGetValue(objectId, out var managed))
                return "objectId=" + objectId + ", managedObject=missing";

            return "objectId=" + objectId + ", managedObject={" + DescribeGameObject(managed) + "}";
        }

        private async System.Threading.Tasks.Task DownloadAndCreateObject(
            string objectId, string name, string meshPath,
            float[] position, float[] rotation, float[] scale)
        {
            _knownObjectIds.Add(objectId);

            try
            {
                var url = GetBlobUrl() + "/" + meshPath;
                Debug.Log(
                    "[SceneSync] Downloading mesh: url=" + url
                    + ", objectId=" + objectId
                    + ", name=" + name
                    + ", meshPath=" + meshPath
                    + ", position=" + FormatArray(position)
                    + ", rotation=" + FormatArray(rotation)
                    + ", scale=" + FormatArray(scale)
                    + ", managedState=" + DescribeManagedObjectState(objectId));

                var http = new HttpClient();
                var response = await http.GetAsync(url);

                Debug.Log(
                    "[SceneSync] Download response: status=" + (int)response.StatusCode + " " + response.StatusCode
                    + ", contentType=" + response.Content.Headers.ContentType
                    + ", contentLength=" + response.Content.Headers.ContentLength
                    + ", requestUri=" + response.RequestMessage?.RequestUri);

                if (!response.IsSuccessStatusCode)
                {
                    Debug.LogWarning(
                        "[SceneSync] Download failed: status=" + (int)response.StatusCode + " " + response.StatusCode
                        + ", objectId=" + objectId
                        + ", name=" + name
                        + ", meshPath=" + meshPath);
                    // フォールバック: プレースホルダーを Cube で置き換え
                    var placeholder = _managedObjects[objectId];
                    var placeholderInstanceId = placeholder.GetInstanceID();

                    var fallback = GameObject.CreatePrimitive(PrimitiveType.Cube);
                    fallback.name = name;

                    // プレースホルダーのマッピングを fallback に移動
                    _instanceToObjectId.Remove(placeholderInstanceId);
                    _instanceToObjectId[fallback.GetInstanceID()] = objectId;
                    _managedObjects[objectId] = fallback;

                    // 位置・回転・スケールを設定（SetParent の前）
                    ApplyTransform(fallback, position, rotation, scale);

                    // SetParent は ApplyTransform の後で実行（ワールド座標を保持）
                    if (_syncRoot != null)
                        fallback.transform.SetParent(_syncRoot, worldPositionStays: true);

                    // プレースホルダーを削除
                    Destroy(placeholder);

                    OnObjectAdded?.Invoke(objectId, fallback);
                    return;
                }

                var glbBytes = await response.Content.ReadAsByteArrayAsync();
                var tempPath = System.IO.Path.Combine(
                    Application.temporaryCachePath, meshPath + ".glb");
                System.IO.File.WriteAllBytes(tempPath, glbBytes);

                Debug.Log(
                    "[SceneSync] Mesh bytes saved: bytes=" + glbBytes.Length
                    + ", tempPath=" + tempPath
                    + ", fileExists=" + System.IO.File.Exists(tempPath));

                // Runtime 用: フレーム時間を考慮した非同期読み込み
                var deferAgent = gameObject.AddComponent<TimeBudgetPerFrameDeferAgent>();
                var importSettings = new ImportSettings
                {
                    AnimationMethod = AnimationMethod.None,
                };
                var gltf = new GltfImport(
                    downloadProvider: null,
                    deferAgent: deferAgent);
                Debug.Log(
                    "[SceneSync] Starting glTF load: tempPath=" + tempPath
                    + ", importSettings.AnimationMethod=" + importSettings.AnimationMethod
                    + ", deferAgent=" + (deferAgent != null ? deferAgent.GetType().Name : "null"));
                var success = await gltf.Load("file://" + tempPath, importSettings);

                var root = gltf.GetSourceRoot();
                Debug.Log(
                    "[SceneSync] glTF load result: success=" + success
                    + ", loadingDone=" + gltf.LoadingDone
                    + ", loadingError=" + gltf.LoadingError
                    + ", sceneCount=" + gltf.SceneCount
                    + ", defaultScene=" + (gltf.DefaultSceneIndex.HasValue ? gltf.DefaultSceneIndex.Value.ToString() : "null")
                    + ", nodes=" + (root?.Nodes != null ? root.Nodes.Count.ToString() : "null")
                    + ", meshes=" + (root?.Meshes != null ? root.Meshes.Count.ToString() : "null")
                    + ", materials=" + (root?.Materials != null ? root.Materials.Count.ToString() : "null")
                    + ", images=" + (root?.Images != null ? root.Images.Count.ToString() : "null")
                    + ", textures=" + (root?.Textures != null ? root.Textures.Count.ToString() : "null"));

                if (success)
                {
                    var placeholder = _managedObjects[objectId];
                    var placeholderInstanceId = placeholder.GetInstanceID();

                    var go = new GameObject(name);

                    // プレースホルダーのマッピングを新オブジェクトに移動
                    _instanceToObjectId.Remove(placeholderInstanceId);
                    _instanceToObjectId[go.GetInstanceID()] = objectId;
                    _managedObjects[objectId] = go;

                    Debug.Log(
                        "[SceneSync] Instantiating glTF main scene: parent=" + DescribeGameObject(go)
                        + ", placeholder=" + DescribeGameObject(placeholder));
                    await gltf.InstantiateMainSceneAsync(go.transform);
                    // glB 経路だけ handedness 補正と wire の Z 反転が重なり、
                    // 見た目が Y 軸 180° ずれるため、import 直後に補正する。
                    var y180 = Quaternion.Euler(0f, 180f, 0f);
                    foreach (Transform child in go.transform)
                    {
                        child.localRotation = y180 * child.localRotation;
                    }

                    // 位置・回転・スケールを設定（SetParent の前）
                    ApplyTransform(go, position, rotation, scale);

                    // SetParent は ApplyTransform の後で実行（ワールド座標を保持）
                    if (_syncRoot != null)
                        go.transform.SetParent(_syncRoot, worldPositionStays: true);

                    // プレースホルダーを削除
                    Destroy(placeholder);

                    Debug.Log(
                        "[SceneSync] Imported mesh: name=" + name
                        + ", objectId=" + objectId
                        + ", meshPath=" + meshPath
                        + ", importedObject={" + DescribeGameObject(go) + "}");
                    OnObjectAdded?.Invoke(objectId, go);
                }
                else
                {
                    Debug.LogWarning(
                        "[SceneSync] glTF import failed: name=" + name
                        + ", objectId=" + objectId
                        + ", meshPath=" + meshPath
                        + ", loadingDone=" + gltf.LoadingDone
                        + ", loadingError=" + gltf.LoadingError
                        + ", sceneCount=" + gltf.SceneCount
                        + ", defaultScene=" + (gltf.DefaultSceneIndex.HasValue ? gltf.DefaultSceneIndex.Value.ToString() : "null"));
                    var placeholder = _managedObjects[objectId];
                    var placeholderInstanceId = placeholder.GetInstanceID();

                    var fallback = GameObject.CreatePrimitive(PrimitiveType.Cube);
                    fallback.name = name;

                    // プレースホルダーのマッピングを fallback に移動
                    _instanceToObjectId.Remove(placeholderInstanceId);
                    _instanceToObjectId[fallback.GetInstanceID()] = objectId;
                    _managedObjects[objectId] = fallback;

                    // 位置・回転・スケールを設定（SetParent の前）
                    ApplyTransform(fallback, position, rotation, scale);

                    // SetParent は ApplyTransform の後で実行（ワールド座標を保持）
                    if (_syncRoot != null)
                        fallback.transform.SetParent(_syncRoot, worldPositionStays: true);

                    // プレースホルダーを削除
                    Destroy(placeholder);

                    OnObjectAdded?.Invoke(objectId, fallback);
                }

                // 一時ファイル削除
                try { System.IO.File.Delete(tempPath); } catch { }

                // DeferAgent 削除
                if (deferAgent != null)
                    Destroy(deferAgent);
            }
            catch (Exception ex)
            {
                Debug.LogWarning(
                    "[SceneSync] DownloadAndCreate failed: objectId=" + objectId
                    + ", name=" + name
                    + ", meshPath=" + meshPath
                    + ", managedState=" + DescribeManagedObjectState(objectId)
                    + "\n" + ex);
                if (!_managedObjects.ContainsKey(objectId))
                    _knownObjectIds.Remove(objectId);
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
