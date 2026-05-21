using System;
using System.Collections.Generic;
using System.Net.Http;
using GLTFast;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Afjk.SceneSync.Editor
{
    public class SceneSyncWindow : EditorWindow
    {
        private const string ShowSceneSyncGizmosPrefKey = "Afjk.SceneSync.ShowSceneSyncGizmos";
        private const string MaxGlbUploadMiBPrefKey = "Afjk.SceneSync.MaxGlbUploadMiB";
        private const float DefaultMaxGlbUploadMiB = 50f;

        internal static bool ShowSceneSyncGizmos
        {
            get => EditorPrefs.GetBool(ShowSceneSyncGizmosPrefKey, true);
            set => EditorPrefs.SetBool(ShowSceneSyncGizmosPrefKey, value);
        }

        [MenuItem("Window/Scene Sync")]
        public static void ShowWindow()
        {
            GetWindow<SceneSyncWindow>("Scene Sync");
        }

        [MenuItem("GameObject/Scene Sync/Select Scene Sync Root", false, 20)]
        private static void SelectSceneSyncRoot()
        {
            var selected = Selection.activeGameObject;
            var root = SceneSyncManager.ResolveSceneSyncRoot(selected);
            if (root != null && root != selected)
            {
                Selection.activeGameObject = root;
            }
        }

        [MenuItem("GameObject/Scene Sync/Select Scene Sync Root", true)]
        private static bool ValidateSelectSceneSyncRoot()
        {
            var selected = Selection.activeGameObject;
            if (selected == null) return false;

            var root = SceneSyncManager.ResolveSceneSyncRoot(selected);
            return root != null && root != selected;
        }

        private PresenceClient _client;
        private string _presenceUrl = "wss://afjk.jp/presence";
        private string _blobUrl = "";
        private string _room = "";
        private string _nickname = "Unity";
        private bool _connected;
        private List<PeerInfo> _peers = new List<PeerInfo>();
        private float _maxGlbUploadMiB = DefaultMaxGlbUploadMiB;

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
        private bool _applyingRemoteTransform;
        private bool _showSetup = false;
        private bool _showQuickGuide = false;
        private bool _showManagedUnityObjects = true;
        private Vector2 _scrollPosition;
        private bool _isSceneSwitching = false;

        private void OnEnable()
        {
            _maxGlbUploadMiB = EditorPrefs.GetFloat(MaxGlbUploadMiBPrefKey, DefaultMaxGlbUploadMiB);
            if (_maxGlbUploadMiB <= 0f)
            {
                _maxGlbUploadMiB = DefaultMaxGlbUploadMiB;
            }

            SceneSyncUnityGltfInstaller.RefreshUnityGltfPackageStatus();

            _client = new PresenceClient();
            _client.OnConnected += () =>
            {
                _connected = true;
                RebindPublishedUnityObjects();
                Repaint();
            };
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
            EditorSceneManager.sceneClosing += OnSceneClosing;
            EditorSceneManager.sceneOpened += OnSceneOpened;
        }

        private void OnDisable()
        {
            EditorApplication.update -= EditorUpdate;
            EditorApplication.hierarchyChanged -= OnHierarchyChanged;
            EditorSceneManager.sceneClosing -= OnSceneClosing;
            EditorSceneManager.sceneOpened -= OnSceneOpened;
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

        private long MaxGlbUploadBytes
        {
            get
            {
                var mib = Mathf.Max(1f, _maxGlbUploadMiB);
                return (long)(mib * 1024f * 1024f);
            }
        }

        private static string FormatBytesMiB(long bytes)
        {
            return $"{bytes} bytes ({bytes / 1024f / 1024f:F2} MiB)";
        }

        private bool IsGlbWithinUploadLimit(byte[] glb)
        {
            return glb != null && glb.Length <= MaxGlbUploadBytes;
        }

        /// <summary>
        /// 同期対象かどうかを判定する。
        /// MeshFilter または SkinnedMeshRenderer を持つオブジェクトのみ対象。
        /// </summary>
        private static bool IsSyncTarget(GameObject go)
        {
            if (go.hideFlags != HideFlags.None) return false;
            if (go.transform.parent == null && go.name == "SceneSync Temporary") return false;
            return go.GetComponentInChildren<MeshFilter>() != null
                || go.GetComponentInChildren<SkinnedMeshRenderer>() != null;
        }

        private void EditorUpdate()
        {
            if (!_connected) return;

            // Selection 変更のチェック
            var selection = Selection.activeGameObject;
            var selectionRoot = SceneSyncManager.ResolveSceneSyncRoot(selection);
            string selectionId = null;
            if (selectionRoot != null)
            {
                if (_instanceToObjectId.TryGetValue(selectionRoot.GetInstanceID(), out var origId))
                {
                    selectionId = origId;
                }
                else
                {
                    var identity = selectionRoot.GetComponent<SceneSyncIdentity>();
                    if (identity != null
                        && !string.IsNullOrWhiteSpace(identity.ObjectId)
                        && _managedObjects.ContainsKey(identity.ObjectId))
                    {
                        selectionId = identity.ObjectId;
                    }
                }
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

            if (_applyingRemoteTransform) return;

            if (EditorApplication.timeSinceStartup - _lastSendTime < SEND_INTERVAL) return;
            _lastSendTime = EditorApplication.timeSinceStartup;
            DetectPublishedUnityObjectTransformChanges();
        }

        private void OnGUI()
        {
            _scrollPosition = EditorGUILayout.BeginScrollView(_scrollPosition);

            GUILayout.Label("Scene Sync", EditorStyles.boldLabel);
            GUILayout.Space(4);

            DrawConnectionSection();
            GUILayout.Space(8);

            DrawManagedUnityObjectsSection();
            GUILayout.Space(8);

            DrawActionsSection();
            GUILayout.Space(8);

            DrawExportSettingsSection();
            GUILayout.Space(8);

            DrawSetupSection();
            GUILayout.Space(8);

            DrawQuickGuide();

            EditorGUILayout.EndScrollView();
        }

        private void DrawConnectionSection()
        {
            GUILayout.Label("Connection", EditorStyles.boldLabel);

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

                if (GUILayout.Button("Disconnect"))
                {
                    ClearTemporaryObjects();
                    _client.Disconnect();
                }
            }
        }

        private void DrawQuickGuide()
        {
            _showQuickGuide = EditorGUILayout.Foldout(_showQuickGuide, "Quick Guide", true);
            if (!_showQuickGuide)
            {
                EditorGUILayout.LabelField(
                    "Unity: Add Selected → Publish Selected → Move root. Remote: move root.",
                    EditorStyles.miniLabel
                );
                return;
            }

            EditorGUILayout.HelpBox(
                "Unity objects:\n" +
                "1. Select a GameObject.\n" +
                "2. Click Add Selected.\n" +
                "3. Click Publish Selected.\n" +
                "4. Move the Scene Sync root to sync transforms.\n\n" +
                "Remote objects:\n" +
                "- Remote GLB objects are temporary.\n" +
                "- Move the Scene Sync root, not imported children.\n" +
                "- Temporary objects are removed on manual Disconnect.",
                MessageType.Info
            );
        }

        private void DrawManagedUnityObjectsSection()
        {
            GUILayout.Label("Managed Unity Objects", EditorStyles.boldLabel);

            var manager = FindSceneSyncManager();
            if (manager == null)
            {
                EditorGUILayout.HelpBox(
                    "Create a SceneSyncManager from Setup to manage Unity objects.",
                    MessageType.Info
                );
                return;
            }

            EditorGUI.BeginChangeCheck();
            var includeManagerChildren = EditorGUILayout.Toggle(
                "Include Manager Children",
                manager.IncludeManagerChildren
            );
            if (EditorGUI.EndChangeCheck())
            {
                manager.IncludeManagerChildren = includeManagerChildren;
                MarkManagerDirty(manager);
            }

            var managedUnityObjects = manager.GetManagedUnityObjects();
            var managedCount = managedUnityObjects.Count;
            GUILayout.Label("Managed: " + managedCount);

            var identifiedCount = 0;
            foreach (var go in managedUnityObjects)
            {
                var identity = go != null ? go.GetComponent<SceneSyncIdentity>() : null;
                if (identity != null && identity.Origin == SceneSyncOrigin.Unity && !identity.Temporary)
                {
                    identifiedCount++;
                }
            }
            GUILayout.Label($"With Identity: {identifiedCount} / {managedCount}");

            GUILayout.Space(4);

            var list = manager.ManagedObjects;
            _showManagedUnityObjects = EditorGUILayout.Foldout(
                _showManagedUnityObjects,
                $"Object List ({list.Count})",
                true
            );

            if (_showManagedUnityObjects)
            {
                var removeIndex = -1;
                EditorGUI.BeginChangeCheck();
                for (var i = 0; i < list.Count; i++)
                {
                    EditorGUILayout.BeginHorizontal();
                    list[i] = (GameObject)EditorGUILayout.ObjectField(
                        $"Object {i + 1}",
                        list[i],
                        typeof(GameObject),
                        true
                    );
                    if (GUILayout.Button("×", GUILayout.Width(24)))
                    {
                        removeIndex = i;
                    }
                    EditorGUILayout.EndHorizontal();
                }
                var fieldChanged = EditorGUI.EndChangeCheck();

                if (removeIndex >= 0)
                {
                    list.RemoveAt(removeIndex);
                    manager.ValidateManagedObjects();
                    MarkManagerDirty(manager);
                    Repaint();
                }
                else if (fieldChanged)
                {
                    manager.ValidateManagedObjects();
                    MarkManagerDirty(manager);
                }
            }

            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("Add Selected"))
                {
                    var changed = false;
                    foreach (var selected in Selection.gameObjects)
                    {
                        var root = SceneSyncManager.ResolveSceneSyncRoot(selected);
                        if (root == null) continue;
                        if (ShouldSkipPublishObject(root)) continue;

                        EnsureManagedUnityIdentity(manager, root, out var identityChanged);
                        if (identityChanged)
                        {
                            changed = true;
                        }
                    }

                    if (changed)
                    {
                        MarkManagerDirty(manager);
                    }
                }
            }
        }

        private void DrawActionsSection()
        {
            GUILayout.Label("Actions", EditorStyles.boldLabel);

            using (new EditorGUI.DisabledScope(!_connected))
            {
                if (GUILayout.Button("Publish Selected"))
                {
                    PublishSelectedObjects();
                }

                if (GUILayout.Button("Publish Managed Objects"))
                {
                    PublishManagedObjects();
                }
            }

            if (GUILayout.Button("Apply Picking Rules"))
            {
                ApplyPickingRules();
            }

            var showSceneSyncGizmos = EditorGUILayout.ToggleLeft("Show Scene Sync Gizmos", ShowSceneSyncGizmos);
            if (showSceneSyncGizmos != ShowSceneSyncGizmos)
            {
                ShowSceneSyncGizmos = showSceneSyncGizmos;
                SceneView.RepaintAll();
            }
        }

        private void DrawExportSettingsSection()
        {
            GUILayout.Label("Export Settings", EditorStyles.boldLabel);

            var currentBackend = GlbExporter.ConfiguredBackend;
            var newBackend = (SceneSyncGlbExportBackend)EditorGUILayout.EnumPopup("GLB Export Backend", currentBackend);
            if (newBackend != currentBackend)
            {
                GlbExporter.ConfiguredBackend = newBackend;
            }

            EditorGUILayout.HelpBox(
                "Auto: Uses glTFast for normal objects. If animation is detected and UnityGLTF is available, UnityGLTF is used.\n" +
                "glTFast: Lightweight static GLB export. Animation is not exported.\n" +
                "UnityGltf: Uses UnityGLTF for GLB export with animation support. Editor only.",
                MessageType.Info
            );

            GUILayout.Space(8);

            DrawUnityGltfStatusSection();

            GUILayout.Space(8);

            EditorGUI.BeginChangeCheck();
            var newMaxGlbUploadMiB = EditorGUILayout.FloatField("Max GLB Upload Size (MiB)", _maxGlbUploadMiB);
            if (EditorGUI.EndChangeCheck())
            {
                _maxGlbUploadMiB = Mathf.Max(1f, newMaxGlbUploadMiB);
                EditorPrefs.SetFloat(MaxGlbUploadMiBPrefKey, _maxGlbUploadMiB);
            }

            EditorGUILayout.HelpBox(
                "GLB files larger than this value are not uploaded. " +
                "This is a Unity-side precheck to avoid slow failed uploads. " +
                "The server may still reject uploads with its own limit.",
                MessageType.Info
            );
        }

        private void DrawUnityGltfStatusSection()
        {
            GUILayout.Label("UnityGLTF", EditorStyles.boldLabel);

            var packageInstalled = SceneSyncUnityGltfInstaller.IsUnityGltfPackageInstalled;
            var isCheckingPackage = SceneSyncUnityGltfInstaller.IsCheckingPackageStatus;
            var defineEnabled = SceneSyncUnityGltfInstaller.IsUnityGltfDefineEnabled();
            var exporterAvailable = GlbExporter.IsUnityGltfExportAvailable;
            var isInstalling = SceneSyncUnityGltfInstaller.IsInstalling;

            using (new EditorGUILayout.VerticalScope(EditorStyles.helpBox))
            {
                GUILayout.Label("UnityGLTF is optional. Install it to export Animator / Animation clips in GLB.", EditorStyles.wordWrappedLabel);
                GUILayout.Label("glTFast remains the default lightweight exporter for non-animated objects.", EditorStyles.wordWrappedLabel);

                GUILayout.Space(8);

                using (new EditorGUILayout.HorizontalScope())
                {
                    var packageStatus = isCheckingPackage ? "Checking..." : (packageInstalled ? "Installed" : "Not installed");
                    GUILayout.Label("Package: " + packageStatus, EditorStyles.miniLabel);
                    GUILayout.Label("Define: " + (defineEnabled ? "Enabled" : "Disabled"), EditorStyles.miniLabel);
                    GUILayout.Label("Exporter: " + (exporterAvailable ? "Available" : "Not available"), EditorStyles.miniLabel);
                }

                GUILayout.Space(8);

                using (new EditorGUI.DisabledScope(isInstalling || isCheckingPackage))
                {
                    if (!packageInstalled && !isCheckingPackage)
                    {
                        if (GUILayout.Button("Install UnityGLTF", GUILayout.Height(32)))
                        {
                            SceneSyncUnityGltfInstaller.InstallUnityGltf();
                        }
                    }
                    else if (packageInstalled && !defineEnabled)
                    {
                        if (GUILayout.Button("Enable UnityGLTF Support", GUILayout.Height(32)))
                        {
                            SceneSyncUnityGltfInstaller.EnsureUnityGltfDefine();
                        }
                    }
                    else if (defineEnabled && !exporterAvailable)
                    {
                        EditorGUILayout.HelpBox(
                            "UnityGLTF support is enabled but exporter not yet registered. " +
                            "This may require script recompilation or restarting Unity.",
                            MessageType.Info
                        );
                    }
                    else if (exporterAvailable)
                    {
                        EditorGUILayout.HelpBox(
                            "UnityGLTF is ready. Animated GameObjects will be exported with animations.",
                            MessageType.Info
                        );
                    }
                }

                if (isInstalling)
                {
                    EditorGUILayout.HelpBox("Installing UnityGLTF...", MessageType.Info);
                }

                GUILayout.Space(4);

                if (GUILayout.Button("Refresh UnityGLTF Status", GUILayout.Height(24)))
                {
                    SceneSyncUnityGltfInstaller.RefreshUnityGltfPackageStatus();
                }
            }
        }

        private static void MarkManagerDirty(SceneSyncManager manager)
        {
            EditorUtility.SetDirty(manager);
            EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());
        }

        private void DrawSetupSection()
        {
            var manager = FindSceneSyncManager();
            var temporaryRoot = FindTemporaryRoot();
            var setupMissing = manager == null || temporaryRoot == null;

            if (setupMissing)
            {
                _showSetup = true;
                EditorGUILayout.Foldout(true, "Setup", true);
            }
            else
            {
                _showSetup = EditorGUILayout.Foldout(_showSetup, "Setup", true);
            }

            if (!_showSetup)
            {
                EditorGUILayout.LabelField("Setup is ready.", EditorStyles.miniLabel);
                return;
            }

            GUILayout.Label("SceneSyncManager: " + (manager != null ? "Found" : "Missing"));
            GUILayout.Label("Temporary Root: " + (temporaryRoot != null ? "Found" : "Missing"));

            if (GUILayout.Button("Create Scene Sync Setup"))
            {
                CreateSceneSyncSetup();
                manager = FindSceneSyncManager();
                temporaryRoot = FindTemporaryRoot();
            }

            using (new EditorGUILayout.HorizontalScope())
            {
                EditorGUI.BeginDisabledGroup(manager == null);
                if (GUILayout.Button("Select SceneSyncManager"))
                {
                    Selection.activeGameObject = manager.gameObject;
                }
                EditorGUI.EndDisabledGroup();

                EditorGUI.BeginDisabledGroup(temporaryRoot == null);
                if (GUILayout.Button("Select Temporary Root"))
                {
                    Selection.activeGameObject = temporaryRoot;
                }
                EditorGUI.EndDisabledGroup();
            }
        }

        private void CreateSceneSyncSetup()
        {
            var hasChanges = false;

            var manager = FindSceneSyncManager();
            if (manager == null)
            {
                var managerObject = FindRootObjectByName("SceneSyncManager");
                if (managerObject == null)
                {
                    managerObject = new GameObject("SceneSyncManager");
                    Undo.RegisterCreatedObjectUndo(managerObject, "Create Scene Sync Setup");
                    hasChanges = true;
                }

                manager = managerObject.GetComponent<SceneSyncManager>();
                if (manager == null)
                {
                    manager = Undo.AddComponent<SceneSyncManager>(managerObject);
                    hasChanges = true;
                }
            }

            var temporaryRoot = FindTemporaryRoot();
            if (temporaryRoot == null)
            {
                temporaryRoot = new GameObject("SceneSync Temporary");
                Undo.RegisterCreatedObjectUndo(temporaryRoot, "Create Scene Sync Setup");
                hasChanges = true;
            }

            if (hasChanges)
            {
                EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());
            }

            if (manager != null)
            {
                Selection.activeGameObject = manager.gameObject;
            }
        }

        private SceneSyncManager FindSceneSyncManager()
        {
            var roots = SceneManager.GetActiveScene().GetRootGameObjects();
            foreach (var root in roots)
            {
                var manager = root.GetComponentInChildren<SceneSyncManager>(true);
                if (manager != null)
                {
                    return manager;
                }
            }

            return null;
        }

        private GameObject FindTemporaryRoot()
        {
            var roots = SceneManager.GetActiveScene().GetRootGameObjects();
            foreach (var root in roots)
            {
                if (root.name == "SceneSync Temporary")
                {
                    return root;
                }
            }

            return null;
        }

        private GameObject FindRootObjectByName(string name)
        {
            var roots = SceneManager.GetActiveScene().GetRootGameObjects();
            foreach (var root in roots)
            {
                if (root.name == name)
                {
                    return root;
                }
            }

            return null;
        }

        private void OnHierarchyChanged()
        {
            if (_isSceneSwitching)
            {
                Debug.Log("[SceneSync] OnHierarchyChanged: scene switching in progress, skipping");
                return;
            }

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

                // Unity-authored root objects should not be auto-published.
                // Explicit publish registers tracked objects into _instanceToObjectId.
                continue;
            }

            foreach (var kvp in _managedObjects)
            {
                var objectId = kvp.Key;
                var go = kvp.Value;
                if (string.IsNullOrWhiteSpace(objectId)) continue;
                if (go == null) continue;

                currentIds.Add(objectId);
                currentInstanceIds.Add(go.GetInstanceID());
            }

            // Temporary root 配下の Web 由来オブジェクトも存在確認対象に含める
            var tempRoot = FindTemporaryRoot();
            if (tempRoot != null)
            {
                foreach (Transform child in tempRoot.transform)
                {
                    var childGo = child.gameObject;
                    var childInstanceId = childGo.GetInstanceID();
                    currentInstanceIds.Add(childInstanceId);

                    if (_instanceToObjectId.TryGetValue(childInstanceId, out var originalId))
                    {
                        currentIds.Add(originalId);
                    }
                }
            }

            // 削除されたオブジェクト
            foreach (var id in _knownObjectIds)
            {
                if (!currentIds.Contains(id))
                {
                    if (IsKnownUnityOriginObjectId(id))
                    {
                        continue;
                    }

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

        private void OnSceneClosing(Scene scene, bool removingScene)
        {
            Debug.Log("[SceneSync] OnSceneClosing: scene=" + scene.name + ", connected=" + _connected);
            _isSceneSwitching = true;

            if (!_connected)
            {
                return;
            }

            Debug.Log("[SceneSync] Lifecycle disconnect: clearing tracking state without sending scene-remove");
            _connected = false;
            _client?.Disconnect();

            // Clear Editor Window tracking state (but do NOT call ClearTemporaryObjects)
            _knownObjectIds.Clear();
            _managedObjects.Clear();
            _instanceToObjectId.Clear();
            _meshPaths.Clear();
            _locks.Clear();
            _currentlyLockedObjectId = null;
            _sceneReceived = false;
            _firstPeersReceived = false;
            _lastSnapshots.Clear();

            Repaint();
        }

        private void OnSceneOpened(Scene scene, OpenSceneMode mode)
        {
            Debug.Log("[SceneSync] OnSceneOpened: scene=" + scene.name + ", mode=" + mode);
            _isSceneSwitching = false;

            // Restore _connected from _client state
            // (The next manual Connect action will establish a fresh connection)
        }

        private void RebindPublishedUnityObjects()
        {
            var manager = FindSceneSyncManager();
            if (manager == null) return;

            foreach (var go in manager.GetManagedUnityObjects())
            {
                if (go == null) continue;

                var identity = go.GetComponent<SceneSyncIdentity>();
                if (identity == null) continue;
                if (identity.Origin != SceneSyncOrigin.Unity) continue;
                if (identity.Temporary) continue;
                if (string.IsNullOrWhiteSpace(identity.ObjectId)) continue;
                // ObjectId only means the object has a stable Scene Sync identity.
                // MeshPath is the marker that the Unity object was actually published before.
                if (string.IsNullOrWhiteSpace(identity.MeshPath)) continue;

                var objectId = identity.ObjectId;

                // Detect duplicate: another GameObject is already bound with this objectId.
                // This happens when a published object is duplicated (MeshPath is copied too).
                if (_managedObjects.TryGetValue(objectId, out var alreadyBound)
                    && alreadyBound != null
                    && alreadyBound != go)
                {
                    identity.MeshPath = null;
                    identity.State = SceneSyncState.Disconnected;
                    EditorUtility.SetDirty(identity);
                    Debug.LogWarning(
                        $"[SceneSync] Rebound: duplicate objectId detected on different GameObject. " +
                        $"Clearing MeshPath on duplicate. " +
                        $"original={alreadyBound.name}, duplicate={go.name}, objectId={objectId}"
                    );
                    continue;
                }

                _managedObjects[objectId] = go;
                _instanceToObjectId[go.GetInstanceID()] = objectId;
                _knownObjectIds.Add(objectId);
                _lastSnapshots[objectId] = new TransformSnapshot(go.transform);

                Debug.Log("[SceneSync] Rebound Unity object: " + go.name + " (objectId=" + objectId + ")");
            }
        }

        private bool IsBoundUnityOriginObject(string objectId)
        {
            if (string.IsNullOrWhiteSpace(objectId)) return false;

            if (!_managedObjects.TryGetValue(objectId, out var go) || go == null)
            {
                return false;
            }

            var identity = go.GetComponent<SceneSyncIdentity>();
            return identity != null
                && identity.Origin == SceneSyncOrigin.Unity
                && !identity.Temporary
                && identity.ObjectId == objectId;
        }

        private bool IsKnownUnityOriginObjectId(string objectId)
        {
            return IsBoundUnityOriginObject(objectId);
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

            DispatchSceneMessage(raw, fromId);
        }

        private void DispatchSceneMessage(string raw, string fromId = null)
        {
            if (string.IsNullOrEmpty(raw)) return;

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
            else if (raw.Contains("\"kind\":\"scene-batch\""))
            {
                HandleSceneBatch(raw, fromId);
            }
            else if (raw.Contains("\"kind\":\"scene-delta\""))
            {
                HandleSceneDelta(raw);
            }
            else if (raw.Contains("\"kind\":\"scene-add\""))
            {
                HandleSceneAdd(raw);
            }
            else if (raw.Contains("\"kind\":\"scene-remove\"") || raw.Contains("\"kind\":\"scene-delete\""))
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

        private void HandleSceneBatch(string raw, string fromId = null)
        {
            foreach (var op in ExtractTopLevelObjectsFromArray(raw, "ops"))
            {
                DispatchSceneMessage(op, fromId);
            }

            foreach (var action in ExtractTopLevelObjectsFromArray(raw, "actions"))
            {
                DispatchSceneMessage(action, fromId);
            }
        }

        private static List<string> ExtractTopLevelObjectsFromArray(string raw, string fieldName)
        {
            var result = new List<string>();
            if (string.IsNullOrEmpty(raw) || string.IsNullOrEmpty(fieldName)) return result;

            var token = "\"" + fieldName + "\"";
            var fieldIndex = raw.IndexOf(token, StringComparison.Ordinal);
            if (fieldIndex < 0) return result;

            var arrayStart = raw.IndexOf('[', fieldIndex);
            if (arrayStart < 0) return result;

            var depth = 0;
            var objectStart = -1;
            var inString = false;
            var escape = false;

            for (var i = arrayStart + 1; i < raw.Length; i++)
            {
                var ch = raw[i];

                if (escape)
                {
                    escape = false;
                    continue;
                }

                if (ch == '\\')
                {
                    escape = true;
                    continue;
                }

                if (ch == '"')
                {
                    inString = !inString;
                    continue;
                }

                if (inString) continue;

                if (ch == '{')
                {
                    if (depth == 0) objectStart = i;
                    depth++;
                    continue;
                }

                if (ch == '}')
                {
                    depth--;
                    if (depth == 0 && objectStart >= 0)
                    {
                        result.Add(raw.Substring(objectStart, i - objectStart + 1));
                        objectStart = -1;
                    }
                    continue;
                }

                if (ch == ']' && depth == 0)
                {
                    break;
                }
            }

            return result;
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

            // 各 "objectId":{...} を抽出（asset など1段ネストの {} を含む場合も対応）
            var entryPattern = new System.Text.RegularExpressions.Regex(
                "\"([^\"]+)\"\\s*:\\s*\\{((?:[^{}]|\\{[^{}]*\\})*)\\}");
            var matches = entryPattern.Matches(objectsBody);

            foreach (System.Text.RegularExpressions.Match m in matches)
            {
                var objectId = m.Groups[1].Value;
                var body = m.Groups[2].Value;

                // scene-add 相当の JSON を構築して処理
                var fakeJson = "{\"kind\":\"scene-add\",\"objectId\":\"" + objectId + "\"," + body + "}";
                Debug.Log("[SceneSync] Restore scene-state object as scene-add: " + fakeJson);
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
            if (SceneSyncManager.ResolveSceneSyncRoot(Selection.activeGameObject) == go) return;

            _applyingRemoteTransform = true;
            try
            {
                // ワイヤー（Three.js 座標系）→ Unity 座標系に逆変換
                if (position != null && position.Length >= 3)
                    go.transform.position = new Vector3(position[0], position[1], -position[2]);

                if (rotation != null && rotation.Length >= 4)
                    go.transform.rotation = new Quaternion(rotation[0], rotation[1], -rotation[2], -rotation[3]);

                if (scale != null && scale.Length >= 3)
                    go.transform.localScale = new Vector3(scale[0], scale[1], scale[2]);

                _lastSnapshots[objectId] = new TransformSnapshot(go.transform);
            }
            finally
            {
                _applyingRemoteTransform = false;
            }
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
            var pattern = System.Text.RegularExpressions.Regex.Escape(key) + @"\s*\[\s*([^\]]+)\s*\]";
            var match = System.Text.RegularExpressions.Regex.Match(json, pattern);
            if (!match.Success) return null;

            var nums = match.Groups[1].Value.Split(',');
            var result = new float[nums.Length];
            for (int i = 0; i < nums.Length; i++)
            {
                if (float.TryParse(
                    nums[i].Trim(),
                    System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out var f))
                    result[i] = f;
                else
                    Debug.LogWarning("[SceneSync] Failed to parse float: " + nums[i]);
            }
            return result;
        }

        private static string FormatArray(float[] values)
        {
            if (values == null) return "null";
            return "[" + string.Join(",", values) + "]";
        }

        private static string JsonEscape(string value)
        {
            if (string.IsNullOrEmpty(value)) return "";
            return value
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\n", "\\n")
                .Replace("\r", "\\r");
        }

        private static string FormatFloat(float value)
        {
            return value.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        private static string GenerateUnitySceneSyncObjectId()
        {
            return "unity-" + Guid.NewGuid().ToString("N");
        }

        private static string GetGlobalObjectIdString(GameObject go)
        {
            if (go == null) return string.Empty;
            var globalId = GlobalObjectId.GetGlobalObjectIdSlow(go).ToString();
            // GlobalObjectId returns the zero id when the scene is unsaved.
            // Fall back to InstanceID, which is unique per-object within the current session.
            if (globalId == "GlobalObjectId_V1-0-00000000000000000000000000000000-0-0")
                return "instanceId-" + go.GetInstanceID();
            return globalId;
        }

        private static bool HasDuplicateObjectIdOnDifferentUnityObject(SceneSyncIdentity identity)
        {
            if (identity == null || string.IsNullOrWhiteSpace(identity.ObjectId))
                return false;

            var currentGlobalId = GetGlobalObjectIdString(identity.gameObject);

#if UNITY_2023_1_OR_NEWER
            var identities = UnityEngine.Object.FindObjectsByType<SceneSyncIdentity>(
                FindObjectsInactive.Include,
                FindObjectsSortMode.None
            );
#else
            var identities = UnityEngine.Object.FindObjectsOfType<SceneSyncIdentity>(true);
#endif

            foreach (var other in identities)
            {
                if (other == null || other == identity) continue;
                if (other.Temporary) continue;
                if (other.Origin != SceneSyncOrigin.Unity) continue;
                if (other.ObjectId != identity.ObjectId) continue;

                var otherGlobalId = GetGlobalObjectIdString(other.gameObject);
                if (!string.Equals(otherGlobalId, currentGlobalId, StringComparison.Ordinal))
                    return true;
            }

            return false;
        }

        private SceneSyncIdentity EnsureUniqueManagedUnityIdentityForPublish(SceneSyncManager manager, GameObject go)
        {
            if (manager == null || go == null) return null;

            var identity = EnsureManagedUnityIdentity(manager, go, out _);
            if (identity == null) return null;

            var needsNewObjectId = string.IsNullOrWhiteSpace(identity.ObjectId)
                || HasDuplicateObjectIdOnDifferentUnityObject(identity);

            if (needsNewObjectId)
            {
                var oldObjectId = identity.ObjectId;
                identity.ObjectId = GenerateUnitySceneSyncObjectId();
                identity.State = SceneSyncState.Disconnected;
                identity.Temporary = false;
                identity.Origin = SceneSyncOrigin.Unity;
                identity.MeshPath = null;
                identity.AssetId = null;
                identity.LockOwner = null;

                EditorUtility.SetDirty(identity);
                MarkManagerDirty(manager);

                Debug.LogWarning(
                    "[SceneSync] Assigned a new Scene Sync ObjectId before publish. " +
                    "This usually happens when a GameObject with SceneSyncIdentity was duplicated. " +
                    $"GameObject={go.name}, oldObjectId={oldObjectId}, newObjectId={identity.ObjectId}"
                );
            }

            return identity;
        }

        private async void PublishSelectedObjects()
        {
            if (!_connected)
            {
                Debug.LogWarning("[SceneSync] Cannot publish selected objects: not connected.");
                return;
            }

            var manager = FindSceneSyncManager();
            if (manager == null)
            {
                Debug.LogWarning("[SceneSync] Cannot publish selected objects: SceneSyncManager not found.");
                return;
            }

            var seen = new HashSet<GameObject>();
            var skipRemainingForAnimation = false;

            foreach (var selected in Selection.gameObjects)
            {
                var root = SceneSyncManager.ResolveSceneSyncRoot(selected);
                if (root == null || !seen.Add(root)) continue;
                if (ShouldSkipPublishObject(root)) continue;

                var animationCheckResult = CheckAnimationRecommendation(root, ref skipRemainingForAnimation);
                if (!animationCheckResult) return;

                var identity = EnsureUniqueManagedUnityIdentityForPublish(manager, root);
                if (identity == null) continue;

                Debug.Log("[SceneSync] Publishing selected object: " + root.name + " (objectId=" + identity.ObjectId + ")");
                await PublishUnityObject(root, identity);
            }
        }

        private async void PublishManagedObjects()
        {
            if (!_connected)
            {
                Debug.LogWarning("[SceneSync] Cannot publish managed objects: not connected.");
                return;
            }

            var manager = FindSceneSyncManager();
            if (manager == null)
            {
                Debug.LogWarning("[SceneSync] Cannot publish managed objects: SceneSyncManager not found.");
                return;
            }

            var seen = new HashSet<GameObject>();
            var skipRemainingForAnimation = false;

            foreach (var go in manager.GetManagedUnityObjects())
            {
                if (go == null || !seen.Add(go)) continue;
                if (ShouldSkipPublishObject(go)) continue;

                var animationCheckResult = CheckAnimationRecommendation(go, ref skipRemainingForAnimation);
                if (!animationCheckResult) return;

                var identity = EnsureUniqueManagedUnityIdentityForPublish(manager, go);
                if (identity == null) continue;

                Debug.Log("[SceneSync] Publishing managed object: " + go.name + " (objectId=" + identity.ObjectId + ")");
                await PublishUnityObject(go, identity);
            }
        }

        private bool ShouldSkipPublishObject(GameObject go)
        {
            var temporaryRoot = FindTemporaryRoot();
            if (temporaryRoot != null
                && (go == temporaryRoot || go.transform.IsChildOf(temporaryRoot.transform)))
            {
                Debug.Log("[SceneSync] Skipping temporary object: " + go.name);
                return true;
            }

            var identity = SceneSyncManager.FindSceneSyncIdentityInParents(go);
            if (identity == null) return false;

            if (identity.Temporary || identity.Origin == SceneSyncOrigin.Remote)
            {
                Debug.Log("[SceneSync] Skipping temporary object: " + identity.gameObject.name);
                return true;
            }

            return false;
        }

        private bool CheckAnimationRecommendation(GameObject go, ref bool skipRemaining)
        {
            if (go == null) return true;
            if (GlbExporter.ConfiguredBackend == SceneSyncGlbExportBackend.GltfFast) return true;
            if (!GlbExporter.ShouldRecommendUnityGltf(go)) return true;

            if (skipRemaining)
            {
                return true;
            }

            var result = EditorUtility.DisplayDialogComplex(
                "Scene Sync: Animation detected",
                "This GameObject appears to contain animation.\n\n" +
                "Scene Sync can publish static GLB with glTFast, but animations may not be exported.\n" +
                "Install UnityGLTF to publish GLB with animation support.",
                "Install UnityGLTF",
                "Continue with glTFast",
                "Cancel"
            );

            if (result == 0)
            {
                SceneSyncUnityGltfInstaller.InstallUnityGltf();
                return false;
            }

            if (result == 1)
            {
                skipRemaining = true;
                return true;
            }

            return false;
        }

        // Ensures a Unity-authored object is registered as managed and has a stable Scene Sync identity.
        // This does not publish or upload anything.
        private SceneSyncIdentity EnsureManagedUnityIdentity(SceneSyncManager manager, GameObject go, out bool changed)
        {
            changed = false;
            if (manager == null || go == null) return null;

            var addedToManaged = manager.AddManagedObject(go);
            var existing = go.GetComponent<SceneSyncIdentity>();
            var hadIdentity = existing != null;
            var previousObjectId = existing != null ? existing.ObjectId : null;
            var previousOrigin = existing != null ? existing.Origin : SceneSyncOrigin.Unknown;
            var previousTemporary = existing != null && existing.Temporary;
            var previousState = existing != null ? existing.State : SceneSyncState.Synced;

            var identity = manager.EnsureUnityManagedIdentity(go);
            if (identity == null)
            {
                Debug.LogWarning("[SceneSync] Skipping object without publishable identity: " + go.name);
                return null;
            }

            changed = addedToManaged
                || !hadIdentity
                || string.IsNullOrWhiteSpace(previousObjectId)
                || previousOrigin != identity.Origin
                || previousTemporary != identity.Temporary
                || ((previousState == SceneSyncState.Disconnected || previousState == SceneSyncState.Error)
                    && identity.State == SceneSyncState.Synced);

            if (changed)
            {
                manager.ValidateManagedObjects();
                EditorUtility.SetDirty(manager);
                EditorUtility.SetDirty(identity);
                EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());
            }

            return identity;
        }

        private async System.Threading.Tasks.Task PublishUnityObject(GameObject go, SceneSyncIdentity identity)
        {
            if (go == null || identity == null) return;
            if (string.IsNullOrWhiteSpace(identity.ObjectId)) return;
            if (!_connected || _client == null) return;

            if (go.GetComponentInChildren<MeshFilter>() == null
                && go.GetComponentInChildren<SkinnedMeshRenderer>() == null)
            {
                Debug.LogWarning("[SceneSync] Cannot publish object without mesh: " + go.name);
                return;
            }

            var glb = await PresenceClient.ExportGameObjectAsGlb(go);
            if (glb == null)
            {
                Debug.LogWarning("[SceneSync] Cannot publish object without mesh: " + go.name);
                return;
            }

            var glbSizeMiB = glb.Length / 1024f / 1024f;
            Debug.Log(
                $"[SceneSync] Exported GLB: {go.name}, " +
                $"objectId={identity.ObjectId}, " +
                $"size={glb.Length} bytes ({glbSizeMiB:F2} MiB)"
            );

            if (!IsGlbWithinUploadLimit(glb))
            {
                identity.State = SceneSyncState.Error;
                EditorUtility.SetDirty(identity);
                EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());

                Debug.LogError(
                    $"[SceneSync] Publish aborted before upload because GLB is too large: " +
                    $"{go.name}, objectId={identity.ObjectId}, " +
                    $"size={FormatBytesMiB(glb.Length)}, " +
                    $"limit={FormatBytesMiB(MaxGlbUploadBytes)}"
                );
                return;
            }

            var objectId = identity.ObjectId;
            var path = PresenceClient.GenerateRandomPath();

            var uploaded = await PresenceClient.UploadGlb(glb, GetBlobUrl(), path);
            if (!uploaded)
            {
                identity.State = SceneSyncState.Error;
                EditorUtility.SetDirty(identity);
                EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());

                Debug.LogError(
                    $"[SceneSync] Publish aborted because GLB upload failed: " +
                    $"{go.name}, objectId={objectId}, path={path}, size={glb.Length} bytes ({glbSizeMiB:F2} MiB)"
                );
                return;
            }

            _meshPaths[objectId] = path;
            identity.MeshPath = path;
            identity.State = SceneSyncState.Synced;
            EditorUtility.SetDirty(identity);
            EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());

            var pos = go.transform.position;
            var rot = go.transform.rotation;
            var scl = go.transform.localScale;
            var payload = "{\"kind\":\"scene-add\",\"objectId\":\"" + JsonEscape(objectId) + "\",\"name\":\"" + JsonEscape(go.name) + "\"" +
                ",\"position\":[" + FormatFloat(pos.x) + "," + FormatFloat(pos.y) + "," + FormatFloat(-pos.z) + "]" +
                ",\"rotation\":[" + FormatFloat(rot.x) + "," + FormatFloat(rot.y) + "," + FormatFloat(-rot.z) + "," + FormatFloat(-rot.w) + "]" +
                ",\"scale\":[" + FormatFloat(scl.x) + "," + FormatFloat(scl.y) + "," + FormatFloat(scl.z) + "]" +
                ",\"meshPath\":\"" + JsonEscape(path) + "\"" +
                ",\"asset\":{\"type\":\"mesh\",\"visualBasis\":\"unity\"}}";
            await _client.Broadcast(payload);

            _managedObjects[objectId] = go;
            _instanceToObjectId[go.GetInstanceID()] = objectId;
            _knownObjectIds.Add(objectId);
            _lastSnapshots[objectId] = new TransformSnapshot(go.transform);

            Debug.Log("[SceneSync] Published Unity object: " + go.name);
        }

        private void DetectPublishedUnityObjectTransformChanges()
        {
            var publishedEntries = new List<KeyValuePair<string, GameObject>>(_managedObjects);
            foreach (var kvp in publishedEntries)
            {
                var objectId = kvp.Key;
                var go = kvp.Value;

                if (go == null) continue;
                if (ShouldSkipTransformSync(go)) continue;

                var identity = go.GetComponent<SceneSyncIdentity>();
                if (identity == null || identity.ObjectId != objectId) continue;

                if (!_lastSnapshots.TryGetValue(objectId, out var snapshot))
                {
                    _lastSnapshots[objectId] = new TransformSnapshot(go.transform);
                    continue;
                }

                if (!snapshot.IsDifferentFrom(go.transform)) continue;

                _lastSnapshots[objectId] = new TransformSnapshot(go.transform);
                _ = SendUnityTransformDelta(objectId, go);
            }
        }

        private bool ShouldSkipTransformSync(GameObject go)
        {
            if (go == null) return true;

            var temporaryRoot = FindTemporaryRoot();
            if (temporaryRoot != null && go == temporaryRoot)
            {
                return true;
            }

            var identity = go.GetComponent<SceneSyncIdentity>();
            if (identity == null) return true;
            if (string.IsNullOrWhiteSpace(identity.ObjectId)) return true;

            if (identity.Origin == SceneSyncOrigin.Unity && !identity.Temporary)
            {
                return false;
            }

            if (identity.Origin == SceneSyncOrigin.Remote && identity.Temporary)
            {
                return false;
            }

            return true;
        }

        private async System.Threading.Tasks.Task SendUnityTransformDelta(string objectId, GameObject go)
        {
            if (!_connected || _client == null) return;
            if (string.IsNullOrWhiteSpace(objectId) || go == null) return;

            var pos = go.transform.position;
            var rot = go.transform.rotation;
            var scl = go.transform.localScale;

            var payload = "{\"kind\":\"scene-delta\",\"objectId\":\"" + JsonEscape(objectId) + "\"" +
                ",\"position\":[" + FormatFloat(pos.x) + "," + FormatFloat(pos.y) + "," + FormatFloat(-pos.z) + "]" +
                ",\"rotation\":[" + FormatFloat(rot.x) + "," + FormatFloat(rot.y) + "," + FormatFloat(-rot.z) + "," + FormatFloat(-rot.w) + "]" +
                ",\"scale\":[" + FormatFloat(scl.x) + "," + FormatFloat(scl.y) + "," + FormatFloat(scl.z) + "]" +
                "}";

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

            if (IsBoundUnityOriginObject(objectId))
            {
                Debug.Log("[SceneSync] scene-add received: objectId=" + objectId + " → bound Unity object, skipping remote creation");
                return;
            }

            // 既に存在する場合はスキップ
            if (_managedObjects.ContainsKey(objectId))
            {
                var existing = _managedObjects[objectId];
                Debug.Log("[SceneSync] scene-add received: objectId=" + objectId
                    + " → already managed (name=" + (existing != null ? existing.name : "null")
                    + ", unityOrigin=" + IsBoundUnityOriginObject(objectId) + "), skipping");
                return;
            }

            Debug.Log("[SceneSync] scene-add received: objectId=" + objectId + " → not yet managed");

            var nameMatch = System.Text.RegularExpressions.Regex.Match(
                raw, "\"name\":\"([^\"]+)\"");
            var name = nameMatch.Success ? nameMatch.Groups[1].Value : objectId;

            float[] position = ExtractArray(raw, "\"position\":");
            float[] rotation = ExtractArray(raw, "\"rotation\":");
            float[] scale = ExtractArray(raw, "\"scale\":");

            Debug.Log(
                "[SceneSync] scene-add transform parse: objectId=" + objectId +
                " position=" + FormatArray(position) +
                " rotation=" + FormatArray(rotation) +
                " scale=" + FormatArray(scale)
            );

            if (position == null || rotation == null || scale == null)
            {
                Debug.LogWarning(
                    "[SceneSync] scene-add missing transform for objectId=" + objectId +
                    " raw=" + raw
                );
            }

            var meshPathMatch = System.Text.RegularExpressions.Regex.Match(
                raw, "\"meshPath\":\"([^\"]+)\"");
            var meshPath = meshPathMatch.Success ? meshPathMatch.Groups[1].Value : null;
            var assetIdMatch = System.Text.RegularExpressions.Regex.Match(
                raw, "\"assetId\":\"([^\"]+)\"");
            var assetId = assetIdMatch.Success ? assetIdMatch.Groups[1].Value : null;

            // Extract visualBasis from asset JSON
            var visualBasisMatch = System.Text.RegularExpressions.Regex.Match(
                raw, "\"visualBasis\":\"([^\"]+)\"");
            var visualBasis = visualBasisMatch.Success ? visualBasisMatch.Groups[1].Value : null;

            // meshPath を保存
            if (!string.IsNullOrEmpty(meshPath))
            {
                _meshPaths[objectId] = meshPath;
            }

            // メッシュがある場合は glB をダウンロードしてインポート
            if (!string.IsNullOrEmpty(meshPath))
            {
                _ = DownloadAndCreateObject(objectId, name, meshPath, position, rotation, scale, assetId, visualBasis);
            }
            else
            {
                // メッシュなしの場合はプレースホルダーの Cube を作成
                var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
                go.name = name;
                ConfigureRemoteTemporaryIdentity(go, objectId, meshPath, assetId);
                go.transform.SetParent(GetOrCreateTemporaryRoot(), worldPositionStays: false);
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

            Debug.Log(
                "[SceneSync] scene-remove received: objectId=" + objectId
                + ", found=" + (go != null)
                + ", unityOrigin=" + IsBoundUnityOriginObject(objectId));

            if (IsBoundUnityOriginObject(objectId))
            {
                var identity = go.GetComponent<SceneSyncIdentity>();
                if (identity != null)
                {
                    identity.State = SceneSyncState.Disconnected;
                    identity.Temporary = false;
                    identity.Origin = SceneSyncOrigin.Unity;
                    identity.MeshPath = null;
                    identity.AssetId = null;
                    identity.LockOwner = null;
                    EditorUtility.SetDirty(identity);
                }
                ForgetObject(objectId, go);
                Debug.Log("[SceneSync] Remote removed Unity-authored object; restored to unpublished state: " + objectId);
            }
            else
            {
                ForgetObject(objectId, go);
                if (go != null)
                {
                    Debug.Log("[SceneSync] Remote removed temporary object; destroying local object: " + objectId);
                    DestroyImmediate(go);
                }
            }
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

            var assetIdMatch = System.Text.RegularExpressions.Regex.Match(
                raw, "\"assetId\":\"([^\"]+)\"");
            var assetId = assetIdMatch.Success ? assetIdMatch.Groups[1].Value : null;

            // Extract visualBasis from asset JSON
            var visualBasisMatch = System.Text.RegularExpressions.Regex.Match(
                raw, "\"visualBasis\":\"([^\"]+)\"");
            var visualBasis = visualBasisMatch.Success ? visualBasisMatch.Groups[1].Value : null;

            // meshPath を保存
            _meshPaths[objectId] = meshPath;

            var go = FindManagedObject(objectId);
            var name = go != null ? go.name : objectId;

            Debug.Log(
                "[SceneSync] scene-mesh received: objectId=" + objectId
                + ", found=" + (go != null)
                + ", unityOrigin=" + IsBoundUnityOriginObject(objectId));

            if (go != null && IsBoundUnityOriginObject(objectId))
            {
                var identity = go.GetComponent<SceneSyncIdentity>();
                if (identity != null)
                {
                    identity.MeshPath = meshPath;
                    if (assetId != null) identity.AssetId = assetId;
                    EditorUtility.SetDirty(identity);
                }
                Debug.Log("[SceneSync] Received scene-mesh for Unity-authored object; keeping local GameObject: " + objectId);
                return;
            }

            // 既存の remote temporary object は従来通り置き換えてよい
            if (go != null)
            {
                var pos = go.transform.position;
                var rot = go.transform.rotation;
                var scl = go.transform.localScale;
                ForgetObject(objectId, go);
                DestroyImmediate(go);

                _ = DownloadAndCreateObject(objectId, name, meshPath,
                    new float[] { pos.x, pos.y, -pos.z },
                    new float[] { rot.x, rot.y, -rot.z, -rot.w },
                    new float[] { scl.x, scl.y, scl.z },
                    assetId, visualBasis);
            }
            else
            {
                _ = DownloadAndCreateObject(objectId, name, meshPath, null, null, null, assetId, visualBasis);
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

        private static bool IsUnderSceneSyncInternalHierarchy(GameObject go)
        {
            var t = go.transform;
            while (t != null)
            {
                if (t.name == "SceneSync Temporary") return true;
                if (t.name == "SceneSyncManager") return true;
                t = t.parent;
            }
            return false;
        }

        private bool ShouldIncludeInUnitySceneState(SceneSyncIdentity identity)
        {
            if (identity == null) return false;

            // Do not re-export remote temporary objects received from Web.
            if (identity.Origin == SceneSyncOrigin.Remote) return false;
            if (identity.Temporary) return false;

            return true;
        }

        private async System.Threading.Tasks.Task HandleSceneRequest(string fromId)
        {
            Debug.Log("[SceneSync] Responding to scene-request for: " + fromId);

            var rootObjects = UnityEngine.SceneManagement.SceneManager
                .GetActiveScene().GetRootGameObjects();

            var objectsJson = new System.Text.StringBuilder();
            objectsJson.Append("{");
            bool first = true;
            var pendingUploads = new List<(string objectId, byte[] glb, string path)>();
            var objectData = new Dictionary<string, (GameObject go, string path, Transform transform)>();
            int sceneStateObjectCount = 0;

            foreach (var go in rootObjects)
            {
                if (!IsSyncTarget(go)) continue;

                var objectId = go.GetInstanceID().ToString();

                if (IsUnderSceneSyncInternalHierarchy(go))
                {
                    Debug.Log($"[SceneSync] scene-state skip: internal hierarchy: objectId={objectId} name={go.name}");
                    continue;
                }

                var identity = go.GetComponent<SceneSyncIdentity>();
                if (identity != null && !ShouldIncludeInUnitySceneState(identity))
                {
                    Debug.Log($"[SceneSync] scene-state skip: objectId={objectId} origin={identity.Origin} temporary={identity.Temporary}");
                    continue;
                }

                var originStr = identity != null ? identity.Origin.ToString() : "None";
                var temporaryStr = identity != null ? identity.Temporary.ToString() : "None";
                Debug.Log($"[SceneSync] scene-state include: source=rootObjects objectId={objectId} name={go.name} origin={originStr} temporary={temporaryStr}");

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
                        if (!IsGlbWithinUploadLimit(glb))
                        {
                            Debug.LogWarning(
                                $"[SceneSync] scene-state skipped before upload because GLB is too large: " +
                                $"objectId={objectId}, name={go.name}, " +
                                $"size={FormatBytesMiB(glb.Length)}, " +
                                $"limit={FormatBytesMiB(MaxGlbUploadBytes)}"
                            );
                            // サイズ超過オブジェクトは objectData に追加しない
                            continue;
                        }

                        path = PresenceClient.GenerateRandomPath();
                        pendingUploads.Add((objectId, glb, path));
                    }
                }

                objectData[objectId] = (go, path, go.transform);
                sceneStateObjectCount++;
            }

            // Web 由来のオブジェクトも含める（ただしリモート一時的オブジェクトは除外）
            foreach (var kvp in _managedObjects)
            {
                if (int.TryParse(kvp.Key, out _)) continue; // Unity 由来はスキップ（上で処理済み）
                var go = kvp.Value;
                if (go == null) continue;

                var identity = go.GetComponent<SceneSyncIdentity>();
                if (!ShouldIncludeInUnitySceneState(identity))
                {
                    var originStr = identity != null ? identity.Origin.ToString() : "Unknown";
                    var temporaryStr = identity != null ? identity.Temporary.ToString() : "Unknown";
                    Debug.Log($"[SceneSync] scene-state skip: objectId={kvp.Key} origin={originStr} temporary={temporaryStr}");
                    continue;
                }

                string path = null;
                _meshPaths.TryGetValue(kvp.Key, out path);

                objectData[kvp.Key] = (go, path, go.transform);
                sceneStateObjectCount++;
            }

            Debug.Log($"[SceneSync] Building scene-state. count={sceneStateObjectCount}");

            // アップロードを先に完了させる
            var failedObjectIds = new HashSet<string>();
            foreach (var (objectId, glb, path) in pendingUploads)
            {
                var uploaded = await PresenceClient.UploadGlb(glb, GetBlobUrl(), path);
                if (uploaded)
                {
                    _meshPaths[objectId] = path;
                }
                else
                {
                    failedObjectIds.Add(objectId);
                }
            }

            // JSON を構築（失敗したオブジェクトは scene-state から除外）
            first = true;
            foreach (var kvp in objectData)
            {
                var objectId = kvp.Key;
                var (go, path, transform) = kvp.Value;

                // アップロード失敗オブジェクトは scene-state に含めない
                if (failedObjectIds.Contains(objectId))
                {
                    Debug.LogWarning(
                        $"[SceneSync] scene-state skipped because GLB upload failed: " +
                        $"objectId={objectId}, name={go.name}"
                    );
                    continue;
                }

                if (!first) objectsJson.Append(",");
                first = false;

                var isUnityVisualBasis = go.GetComponent<SceneSyncIdentity>() == null
                    || go.GetComponent<SceneSyncIdentity>().Origin == SceneSyncOrigin.Unity;
                var meshPathJson = path != null ? ",\"meshPath\":\"" + path + "\"" : "";
                var assetJson = path != null && isUnityVisualBasis
                    ? ",\"asset\":{\"type\":\"mesh\",\"visualBasis\":\"unity\"}"
                    : "";

                var pos = transform.position;
                var rot = transform.rotation;
                var scl = transform.localScale;

                objectsJson.Append("\"" + objectId + "\":{\"name\":\"" + go.name + "\"" +
                    ",\"position\":[" + pos.x + "," + pos.y + "," + (-pos.z) + "]" +
                    ",\"rotation\":[" + rot.x + "," + rot.y + "," + (-rot.z) + "," + (-rot.w) + "]" +
                    ",\"scale\":[" + scl.x + "," + scl.y + "," + scl.z + "]" +
                    meshPathJson + assetJson + "}");
            }

            objectsJson.Append("}");

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
            float[] position, float[] rotation, float[] scale, string assetId = null, string visualBasis = null)
        {
            try
            {
                if (!string.IsNullOrEmpty(meshPath))
                {
                    _meshPaths[objectId] = meshPath;
                }

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
                    ConfigureRemoteTemporaryIdentity(fallback, objectId, meshPath, assetId);
                    fallback.transform.SetParent(GetOrCreateTemporaryRoot(), worldPositionStays: false);
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
                    ConfigureRemoteTemporaryIdentity(go, objectId, meshPath, assetId);
                    go.transform.SetParent(GetOrCreateTemporaryRoot(), worldPositionStays: false);
                    var importedGlbRoot = new GameObject("ImportedGlbRoot");
                    importedGlbRoot.transform.SetParent(go.transform, worldPositionStays: false);

                    // Keep the synchronized object transform on the parent and apply the
                    // same Unity GLB visual correction as Runtime/SceneSyncManager.
                    importedGlbRoot.transform.localPosition = Vector3.zero;
                    var shouldApplyUnityImportYawCorrection = visualBasis != "unity";
                    importedGlbRoot.transform.localRotation = shouldApplyUnityImportYawCorrection
                        ? Quaternion.Euler(0f, 180f, 0f)
                        : Quaternion.identity;
                    importedGlbRoot.transform.localScale = Vector3.one;

                    Debug.Log(
                        "[SceneSync] GLB visual basis: objectId=" + objectId
                        + ", visualBasis=" + (visualBasis ?? "web")
                        + ", applyUnityImportYawCorrection=" + shouldApplyUnityImportYawCorrection
                        + ", importedGlbRoot.localEulerAngles=" + importedGlbRoot.transform.localEulerAngles);

                    await gltf.InstantiateMainSceneAsync(importedGlbRoot.transform);
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
                    ConfigureRemoteTemporaryIdentity(fallback, objectId, meshPath, assetId);
                    fallback.transform.SetParent(GetOrCreateTemporaryRoot(), worldPositionStays: false);
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

        private static SceneSyncIdentity EnsureSceneSyncIdentity(GameObject go)
        {
            var identity = go.GetComponent<SceneSyncIdentity>();
            if (identity == null)
            {
                identity = go.AddComponent<SceneSyncIdentity>();
            }

            return identity;
        }

        private static void ConfigureRemoteTemporaryIdentity(GameObject go, string objectId, string meshPath, string assetId = null)
        {
            var identity = EnsureSceneSyncIdentity(go);
            identity.ConfigureRemoteTemporary(objectId, meshPath, assetId);
            SceneSyncPickingUtility.ApplyImportedChildPicking(identity);
        }

        private static void ApplyPickingRules()
        {
            var identities = UnityEngine.Object.FindObjectsOfType<SceneSyncIdentity>();
            foreach (var identity in identities)
            {
                SceneSyncPickingUtility.ApplyImportedChildPicking(identity);
            }
        }

        private Transform GetOrCreateTemporaryRoot()
        {
            var root = FindTemporaryRoot();
            if (root != null)
            {
                return root.transform;
            }

            var created = new GameObject("SceneSync Temporary");
            created.transform.SetPositionAndRotation(Vector3.zero, Quaternion.identity);
            created.transform.localScale = Vector3.one;
            return created.transform;
        }

        private void ClearTemporaryObjects()
        {
            var root = FindTemporaryRoot()?.transform;
            if (root == null) return;

            for (var i = root.childCount - 1; i >= 0; i--)
            {
                var child = root.GetChild(i).gameObject;
                ForgetSceneSyncObject(child);

                if (Application.isPlaying)
                {
                    Destroy(child);
                }
                else
                {
                    DestroyImmediate(child);
                }
            }

            EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());
        }

        private void ForgetSceneSyncObject(GameObject go)
        {
            var identity = go.GetComponent<SceneSyncIdentity>();
            if (identity == null || !identity.Temporary || string.IsNullOrEmpty(identity.ObjectId))
            {
                return;
            }

            ForgetObject(identity.ObjectId, go);
        }

        private void ForgetObject(string objectId, GameObject go = null)
        {
            if (string.IsNullOrWhiteSpace(objectId)) return;

            _managedObjects.Remove(objectId);
            _meshPaths.Remove(objectId);
            _locks.Remove(objectId);
            _lastSnapshots.Remove(objectId);
            _knownObjectIds.Remove(objectId);

            if (go != null)
            {
                _instanceToObjectId.Remove(go.GetInstanceID());
                foreach (var t in go.GetComponentsInChildren<Transform>(true))
                {
                    _instanceToObjectId.Remove(t.gameObject.GetInstanceID());
                }
                return;
            }

            var stale = new List<int>();
            foreach (var kvp in _instanceToObjectId)
            {
                if (kvp.Value == objectId)
                    stale.Add(kvp.Key);
            }

            foreach (var key in stale)
                _instanceToObjectId.Remove(key);
        }

        private struct TransformSnapshot
        {
            public Vector3 position;
            public Quaternion rotation;
            public Vector3 scale;

            public TransformSnapshot(Transform t)
            {
                position = t.position;
                rotation = t.rotation;
                scale = t.localScale;
            }

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

            public bool IsDifferentFrom(Transform t)
            {
                return Vector3.Distance(position, t.position) > 0.0001f
                    || Quaternion.Angle(rotation, t.rotation) > 0.01f
                    || Vector3.Distance(scale, t.localScale) > 0.0001f;
            }
        }
    }
}
