using System;
using System.Collections.Generic;
using System.Linq;
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
        private const string ApplyTransparentNameHintsForExportPrefKey = "Afjk.SceneSync.ApplyTransparentNameHintsForExport";
        private const string RapierBridgeTypeName = "Afjk.SceneSync.Rapier.SceneSyncRapierBridge";
        private const string RapierInteractionControllerTypeName =
            "Afjk.SceneSync.Rapier.SceneSyncRapierInteractionController";
        private const string DefaultRapierScenePhysicsJson =
            "{\"version\":1,\"enabled\":true,\"duration\":10,\"worldOptions\":{\"gravity\":[0,-9.81,0],\"ground\":null,\"timestep\":0.016666666666666666}}";
        private const float DefaultMaxGlbUploadMiB = 50f;
        private const int MaxPersistentGlbSizeBytes = 50 * 1024 * 1024;
        private const long MaxPersistentGlbCacheBytes = 512L * 1024L * 1024L;

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
        private bool _applyTransparentNameHintsForExport;

        private Dictionary<string, TransformSnapshot> _lastSnapshots = new Dictionary<string, TransformSnapshot>();
        private double _lastSendTime;
        private const double SEND_INTERVAL = 0.05; // 50ms
        private Dictionary<string, GameObject> _managedObjects = new Dictionary<string, GameObject>();
        private HashSet<string> _knownObjectIds = new HashSet<string>();
        private Dictionary<string, string> _locks = new Dictionary<string, string>(); // objectId → lockOwnerId
        private string _currentlyLockedObjectId;
        private Dictionary<string, string> _meshPaths = new Dictionary<string, string>(); // objectId → meshPath
        private Dictionary<string, string> _pendingObjectLoomGraphs = new Dictionary<string, string>();
        private bool _sceneReceived = false;
        private bool _firstPeersReceived = false;
        private Dictionary<int, string> _instanceToObjectId = new Dictionary<int, string>(); // Unity InstanceID → 元の objectId
        private bool _applyingRemoteTransform;
        private bool _showConnectionSettings = false;
        private bool _showSetup = false;
        private bool _showQuickGuide = false;
        private bool _showManagedUnityObjects = false;
        private bool _showExportSettings = false;
        private bool _showTroubleshooting = false;
        private Vector2 _scrollPosition;
        private bool _isSceneSwitching = false;
        private bool _isManualDisconnect = false;
        private int _remoteImportGeneration;
        private bool _publishInProgress = false;
        private string _envId = null;
        private static bool _rapierBridgeTypeResolved;
        private static Type _rapierBridgeType;
        private static bool _rapierInteractionControllerTypeResolved;
        private static Type _rapierInteractionControllerType;

        private void OnEnable()
        {
            _maxGlbUploadMiB = EditorPrefs.GetFloat(MaxGlbUploadMiBPrefKey, DefaultMaxGlbUploadMiB);
            if (_maxGlbUploadMiB <= 0f)
            {
                _maxGlbUploadMiB = DefaultMaxGlbUploadMiB;
            }
            _applyTransparentNameHintsForExport = EditorPrefs.GetBool(ApplyTransparentNameHintsForExportPrefKey, true);
            GlbExporter.ApplyTransparentNameHintsForExport = _applyTransparentNameHintsForExport;

            SceneSyncUnityGltfInstaller.RefreshUnityGltfPackageStatus();

            _client = new PresenceClient();
            _client.OnConnected += () =>
            {
                _connected = true;
                SyncRoomToSceneSyncManager();
                RebindPublishedUnityObjects();
                Repaint();
            };
            _client.OnDisconnected += () =>
            {
                var wasConnected = _connected;
                _connected = false;
                _sceneReceived = false;
                _firstPeersReceived = false;
                if (wasConnected && !_isSceneSwitching && !_isManualDisconnect)
                {
                    ClearTemporaryObjects();
                }
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
            EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
            EditorSceneManager.sceneClosing += OnSceneClosing;
            EditorSceneManager.sceneOpened += OnSceneOpened;

            SyncRoomFromSceneSyncManager();
        }

        private void OnDisable()
        {
            EditorApplication.update -= EditorUpdate;
            EditorApplication.hierarchyChanged -= OnHierarchyChanged;
            EditorApplication.playModeStateChanged -= OnPlayModeStateChanged;
            EditorSceneManager.sceneClosing -= OnSceneClosing;
            EditorSceneManager.sceneOpened -= OnSceneOpened;
            if (EditorApplication.isPlayingOrWillChangePlaymode && !EditorApplication.isPlaying)
            {
                DisconnectEditorSessionBeforePlayMode();
                return;
            }

            _isManualDisconnect = true;
            _client?.Disconnect();
            _isManualDisconnect = false;
        }

        private void OnPlayModeStateChanged(PlayModeStateChange state)
        {
            if (state == PlayModeStateChange.ExitingEditMode)
            {
                DisconnectEditorSessionBeforePlayMode();
            }
        }

        private void DisconnectEditorSessionBeforePlayMode()
        {
            if (EditorApplication.isPlaying) return;

            var wasConnected = _connected || (_client != null && _client.IsConnected);
            var hadTemporaryObjects = HasRemoteTemporaryObjects();

            InvalidateRemoteImportSession();

            if (!wasConnected && !hadTemporaryObjects)
            {
                return;
            }

            Debug.Log("[SceneSync] Disconnecting edit-mode session before Play Mode; runtime will reload room objects.");

            _connected = false;
            ClearTemporaryObjects();

            _isManualDisconnect = true;
            try
            {
                _client?.Disconnect();
            }
            finally
            {
                _isManualDisconnect = false;
            }

            _peers.Clear();
            _knownObjectIds.Clear();
            _managedObjects.Clear();
            _instanceToObjectId.Clear();
            _meshPaths.Clear();
            _locks.Clear();
            _pendingObjectLoomGraphs.Clear();
            _currentlyLockedObjectId = null;
            _sceneReceived = false;
            _firstPeersReceived = false;
            _lastSnapshots.Clear();
            _envId = null;

            Repaint();
        }

        private void InvalidateRemoteImportSession()
        {
            unchecked
            {
                _remoteImportGeneration++;
            }
        }

        private bool IsRemoteImportSessionCurrent(int generation)
        {
            return generation == _remoteImportGeneration
                && !EditorApplication.isPlayingOrWillChangePlaymode
                && !EditorApplication.isPlaying;
        }

        private static IEnumerable<SceneSyncIdentity> FindRemoteTemporaryIdentities()
        {
#if UNITY_2023_1_OR_NEWER
            var identities = UnityEngine.Object.FindObjectsByType<SceneSyncIdentity>(
                FindObjectsInactive.Include,
                FindObjectsSortMode.None
            );
#else
            var identities = UnityEngine.Object.FindObjectsOfType<SceneSyncIdentity>(true);
#endif

            foreach (var identity in identities)
            {
                if (identity == null) continue;
                if (!identity.Temporary && identity.Origin != SceneSyncOrigin.Remote) continue;
                yield return identity;
            }
        }

        private bool HasRemoteTemporaryObjects()
        {
            var temporaryRoot = FindTemporaryRoot();
            if (temporaryRoot != null && temporaryRoot.transform.childCount > 0) return true;

            foreach (var identity in FindRemoteTemporaryIdentities())
            {
                if (identity != null && identity.gameObject != null) return true;
            }

            return false;
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

        private async System.Threading.Tasks.Task<bool> EnsureConnectedForPublishBroadcast()
        {
            if (_client != null && _client.IsConnected)
            {
                _connected = true;
                return true;
            }

            if (_client == null) return false;

            Debug.LogWarning(
                "[SceneSync] Connection closed before publish broadcast. " +
                "Reconnecting to send the scene update."
            );

            var reconnectRoom = !string.IsNullOrWhiteSpace(_client.Room)
                ? _client.Room
                : _room;
            _room = reconnectRoom ?? "";

            _connected = false;
            await _client.ConnectAsync(_presenceUrl, reconnectRoom, _nickname);

            if (_client.IsConnected)
            {
                _connected = true;
                return true;
            }

            return false;
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

            DrawHeaderSection();
            GUILayout.Space(6);

            DrawSetupPromptSection();
            GUILayout.Space(6);

            DrawConnectionSection();
            GUILayout.Space(8);

            DrawPrimaryActionsSection();
            GUILayout.Space(8);

            DrawSelectionStatusSection();
            GUILayout.Space(8);

            DrawManagedSummarySection();
            GUILayout.Space(10);

            DrawAdvancedSection();

            EditorGUILayout.EndScrollView();
        }

        private void DrawHeaderSection()
        {
            GUILayout.Label("Scene Sync", EditorStyles.boldLabel);
        }

        private void DrawSetupPromptSection()
        {
            var manager = FindSceneSyncManager();
            var temporaryRoot = FindTemporaryRoot();
            if (!IsSceneSyncSetupMissing(manager, temporaryRoot)) return;

            EditorGUILayout.HelpBox(
                "Scene Sync setup is required before publishing Unity objects.",
                MessageType.Warning
            );

            if (GUILayout.Button("Create Scene Sync Setup", GUILayout.Height(28)))
            {
                CreateSceneSyncSetup();
            }
        }

        private void DrawConnectionSection()
        {
            GUILayout.Label("Connection", EditorStyles.boldLabel);

            DrawConnectionStatus();

            EditorGUI.BeginChangeCheck();
            _room = EditorGUILayout.TextField("Room", _room);
            if (EditorGUI.EndChangeCheck())
            {
                SyncRoomToSceneSyncManager();
            }

            GUILayout.Space(4);

            if (!_connected)
            {
                if (GUILayout.Button("Connect", GUILayout.Height(28)))
                {
                    SyncRoomToSceneSyncManager();
                    _ = _client.ConnectAsync(_presenceUrl, _room, _nickname);
                }
            }
            else
            {
                if (GUILayout.Button("Disconnect", GUILayout.Height(24)))
                {
                    ClearTemporaryObjects();
                    _isManualDisconnect = true;
                    _client.Disconnect();
                    _isManualDisconnect = false;
                }
            }

            _showConnectionSettings = EditorGUILayout.Foldout(
                _showConnectionSettings,
                "Connection Settings",
                true
            );
            if (!_showConnectionSettings) return;

            _presenceUrl = EditorGUILayout.TextField("Presence URL", _presenceUrl);
            _blobUrl = EditorGUILayout.TextField("Blob URL", _blobUrl);
            _nickname = EditorGUILayout.TextField("Nickname", _nickname);

            if (_connected && _peers.Count > 0)
            {
                GUILayout.Space(4);
                GUILayout.Label("Peers", EditorStyles.miniLabel);
                foreach (var p in _peers)
                {
                    GUILayout.Label(
                        "  " + p.nickname + " (" + p.device + ")",
                        EditorStyles.miniLabel
                    );
                }
            }
        }

        private void DrawConnectionStatus()
        {
            var connected = _connected && _client != null && _client.IsConnected;
            var previousColor = GUI.color;
            GUI.color = connected ? new Color(0.1f, 0.65f, 0.2f) : new Color(0.85f, 0.15f, 0.12f);

            var activeRoom = connected && _client != null && !string.IsNullOrEmpty(_client.Room)
                ? _client.Room
                : _room;
            GUILayout.Label(
                (connected ? "● Connected" : "● Disconnected") +
                (string.IsNullOrWhiteSpace(activeRoom) ? "" : "  Room: " + activeRoom) +
                (connected ? "  Peers: " + _peers.Count : ""),
                EditorStyles.boldLabel
            );

            GUI.color = previousColor;
            GUILayout.Space(4);
        }

        private void DrawQuickGuide()
        {
            _showQuickGuide = EditorGUILayout.Foldout(_showQuickGuide, "Quick Guide", true);
            if (!_showQuickGuide)
            {
                EditorGUILayout.LabelField(
                    "Unity: Publish Selected -> Move root. Optional: Add Selected to Managed.",
                    EditorStyles.miniLabel
                );
                return;
            }

            EditorGUILayout.HelpBox(
                "Unity objects:\n" +
                "1. Select a GameObject.\n" +
                "2. Click Publish Selected.\n" +
                "3. Move the Scene Sync root to sync transforms.\n" +
                "- Use Add Selected to Managed when you want to keep objects in the managed list before publishing.\n\n" +
                "Remote objects:\n" +
                "- Remote GLB objects are temporary.\n" +
                "- Move the Scene Sync root, not imported children.\n" +
                "- Temporary objects are removed on Disconnect.",
                MessageType.Info
            );
        }

        private struct SelectionPublishSummary
        {
            public int RootCount;
            public int AddableCount;
            public int PublishableCount;
            public int BlockedCount;
            public string Message;
            public MessageType MessageType;

            public bool HasAddableSelection => AddableCount > 0;
            public bool HasPublishableSelection => PublishableCount > 0;
        }

        private SelectionPublishSummary BuildSelectionPublishSummary(SceneSyncManager manager)
        {
            var selected = Selection.gameObjects;
            if (selected == null || selected.Length == 0)
            {
                return new SelectionPublishSummary
                {
                    Message = "Select a GameObject to publish or add to Managed Objects.",
                    MessageType = MessageType.Info
                };
            }

            if (manager == null)
            {
                return new SelectionPublishSummary
                {
                    RootCount = selected.Length,
                    Message = "Create Scene Sync setup before publishing Unity objects.",
                    MessageType = MessageType.Warning
                };
            }

            var roots = new HashSet<GameObject>();
            var firstBlockedReason = "";
            var summary = new SelectionPublishSummary();

            foreach (var selectedObject in selected)
            {
                var root = SceneSyncManager.ResolveSceneSyncRoot(selectedObject);
                if (root == null || !roots.Add(root)) continue;

                summary.RootCount++;

                if (TryGetSelectionBlockReason(root, manager, out var selectionBlockReason))
                {
                    summary.BlockedCount++;
                    if (string.IsNullOrEmpty(firstBlockedReason))
                        firstBlockedReason = selectionBlockReason;
                    continue;
                }

                summary.AddableCount++;

                if (!HasPublishableMesh(root))
                {
                    summary.BlockedCount++;
                    if (string.IsNullOrEmpty(firstBlockedReason))
                        firstBlockedReason = $"{root.name} has no MeshFilter or SkinnedMeshRenderer.";
                    continue;
                }

                summary.PublishableCount++;
            }

            if (summary.RootCount == 0)
            {
                summary.Message = "Select a GameObject to publish or add to Managed Objects.";
                summary.MessageType = MessageType.Info;
            }
            else if (summary.PublishableCount == summary.RootCount)
            {
                summary.Message = summary.PublishableCount == 1
                    ? "Selected object is ready to publish."
                    : $"{summary.PublishableCount} selected objects are ready to publish.";
                summary.MessageType = MessageType.Info;
            }
            else if (summary.PublishableCount > 0)
            {
                summary.Message =
                    $"{summary.PublishableCount} selected object(s) are ready to publish. " +
                    $"{summary.BlockedCount} skipped: {firstBlockedReason}";
                summary.MessageType = MessageType.Warning;
            }
            else if (summary.AddableCount > 0)
            {
                summary.Message =
                    "Selection can be added to Managed Objects, but cannot be published yet: " +
                    firstBlockedReason;
                summary.MessageType = MessageType.Warning;
            }
            else
            {
                summary.Message = "Selection cannot be published: " + firstBlockedReason;
                summary.MessageType = MessageType.Warning;
            }

            return summary;
        }

        private bool TryGetSelectionBlockReason(GameObject root, SceneSyncManager manager, out string reason)
        {
            reason = null;
            if (root == null)
            {
                reason = "No Scene Sync root found.";
                return true;
            }

            if (manager != null && root == manager.gameObject)
            {
                reason = "SceneSyncManager itself cannot be managed or published.";
                return true;
            }

            var temporaryRoot = FindTemporaryRoot();
            if (temporaryRoot != null
                && (root == temporaryRoot || root.transform.IsChildOf(temporaryRoot.transform)))
            {
                reason = "Remote temporary objects cannot be managed from Unity.";
                return true;
            }

            var identity = SceneSyncManager.FindSceneSyncIdentityInParents(root);
            if (identity != null && (identity.Temporary || identity.Origin == SceneSyncOrigin.Remote))
            {
                reason = "Remote temporary objects cannot be managed from Unity.";
                return true;
            }

            return false;
        }

        private static bool HasPublishableMesh(GameObject go)
        {
            return go != null
                && (go.GetComponentInChildren<MeshFilter>() != null
                    || go.GetComponentInChildren<SkinnedMeshRenderer>() != null);
        }

        private void AddSelectedToManagedObjects()
        {
            var manager = FindSceneSyncManager();
            if (manager == null) return;

            var changed = false;
            var roots = new HashSet<GameObject>();
            foreach (var selected in Selection.gameObjects)
            {
                var root = SceneSyncManager.ResolveSceneSyncRoot(selected);
                if (root == null || !roots.Add(root)) continue;
                if (TryGetSelectionBlockReason(root, manager, out _)) continue;

                EnsureManagedUnityIdentity(manager, root, out var identityChanged);
                if (identityChanged)
                {
                    changed = true;
                }
            }

            if (changed)
            {
                MarkManagerDirty(manager);
                Repaint();
            }
        }

        private void DrawManagedUnityObjectsSection()
        {
            _showManagedUnityObjects = EditorGUILayout.Foldout(
                _showManagedUnityObjects,
                "Managed Object Details",
                true
            );
            if (!_showManagedUnityObjects)
            {
                return;
            }

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
            GUILayout.Label($"Object List ({list.Count})", EditorStyles.miniLabel);

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

        private void DrawPrimaryActionsSection()
        {
            GUILayout.Label("Primary Actions", EditorStyles.boldLabel);

            var manager = FindSceneSyncManager();
            var selectionSummary = BuildSelectionPublishSummary(manager);
            var managedCount = manager != null ? manager.GetManagedUnityObjects().Count : 0;

            var canPublishSelected = _connected
                && !_publishInProgress
                && manager != null
                && selectionSummary.HasPublishableSelection;
            var canPublishManaged = _connected
                && !_publishInProgress
                && manager != null
                && managedCount > 0;
            var canAddSelected = manager != null
                && !_publishInProgress
                && selectionSummary.HasAddableSelection;

            using (new EditorGUILayout.HorizontalScope())
            {
                using (new EditorGUI.DisabledScope(!canPublishSelected))
                {
                    if (GUILayout.Button("Publish Selected", GUILayout.Height(32)))
                    {
                        QueuePublishSelectedObjects();
                    }
                }

                using (new EditorGUI.DisabledScope(!canPublishManaged))
                {
                    if (GUILayout.Button("Publish Managed Objects", GUILayout.Height(32)))
                    {
                        QueuePublishManagedObjects();
                    }
                }
            }

            using (new EditorGUI.DisabledScope(!canAddSelected))
            {
                if (GUILayout.Button("Add Selected to Managed", GUILayout.Height(24)))
                {
                    AddSelectedToManagedObjects();
                }
            }

            if (_publishInProgress)
            {
                EditorGUILayout.LabelField("Publishing...", EditorStyles.miniLabel);
            }
            else if (!_connected)
            {
                EditorGUILayout.LabelField("Connect before publishing.", EditorStyles.miniLabel);
            }
            else if (manager == null)
            {
                EditorGUILayout.LabelField("Create setup before publishing.", EditorStyles.miniLabel);
            }
        }

        private void DrawSelectionStatusSection()
        {
            GUILayout.Label("Selection", EditorStyles.boldLabel);
            var summary = BuildSelectionPublishSummary(FindSceneSyncManager());
            EditorGUILayout.HelpBox(summary.Message, summary.MessageType);
            if (!_connected && summary.HasPublishableSelection)
            {
                EditorGUILayout.LabelField("Connect before publishing selected objects.", EditorStyles.miniLabel);
            }
        }

        private void DrawManagedSummarySection()
        {
            GUILayout.Label("Managed Summary", EditorStyles.boldLabel);

            var manager = FindSceneSyncManager();
            if (manager == null)
            {
                EditorGUILayout.LabelField(
                    "No SceneSyncManager found.",
                    EditorStyles.miniLabel
                );
                return;
            }

            var managedUnityObjects = manager.GetManagedUnityObjects();
            var managedCount = managedUnityObjects.Count;
            var identifiedCount = 0;
            var publishedCount = 0;
            var errorCount = 0;
            foreach (var go in managedUnityObjects)
            {
                var identity = go != null ? go.GetComponent<SceneSyncIdentity>() : null;
                if (identity == null || identity.Origin != SceneSyncOrigin.Unity || identity.Temporary)
                    continue;

                identifiedCount++;
                if (!string.IsNullOrWhiteSpace(identity.MeshPath))
                    publishedCount++;
                if (identity.State == SceneSyncState.Error)
                    errorCount++;
            }

            GUILayout.Label(
                $"Managed: {managedCount}    Published: {publishedCount}    With Identity: {identifiedCount}",
                EditorStyles.miniLabel
            );

            if (errorCount > 0)
            {
                EditorGUILayout.HelpBox(
                    $"{errorCount} managed object(s) are in an error state. Check the Console for publish details.",
                    MessageType.Warning
                );
            }
        }

        private void DrawAdvancedSection()
        {
            GUILayout.Label("Details & Advanced", EditorStyles.boldLabel);

            DrawManagedUnityObjectsSection();
            GUILayout.Space(4);

            DrawExportSettingsSection();
            GUILayout.Space(4);

            DrawSetupSection();
            GUILayout.Space(4);

            DrawTroubleshootingSection();
            GUILayout.Space(4);

            DrawQuickGuide();
        }

        private void DrawTroubleshootingSection()
        {
            _showTroubleshooting = EditorGUILayout.Foldout(
                _showTroubleshooting,
                "Troubleshooting",
                true
            );
            if (!_showTroubleshooting) return;

            if (GUILayout.Button("Repair Remote Object Picking", GUILayout.Height(24)))
            {
                ApplyPickingRules();
            }
            EditorGUILayout.LabelField(
                "Use this only if imported GLB child meshes become selectable. Scene Sync normally applies this automatically.",
                EditorStyles.wordWrappedMiniLabel
            );

            var showSceneSyncGizmos = EditorGUILayout.ToggleLeft("Show Scene Sync Gizmos", ShowSceneSyncGizmos);
            if (showSceneSyncGizmos != ShowSceneSyncGizmos)
            {
                ShowSceneSyncGizmos = showSceneSyncGizmos;
                SceneView.RepaintAll();
            }
        }

        private void DrawExportSettingsSection()
        {
            var currentBackend = GlbExporter.ConfiguredBackend;
            _showExportSettings = EditorGUILayout.Foldout(
                _showExportSettings,
                "Export Settings",
                true
            );
            if (!_showExportSettings)
            {
                EditorGUILayout.LabelField(
                    "GLB Export Backend: " + currentBackend,
                    EditorStyles.miniLabel
                );
                return;
            }

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
            var applyTransparentNameHintsForExport = EditorGUILayout.Toggle(
                "Apply Transparent Name Hints",
                _applyTransparentNameHintsForExport
            );
            if (EditorGUI.EndChangeCheck())
            {
                _applyTransparentNameHintsForExport = applyTransparentNameHintsForExport;
                GlbExporter.ApplyTransparentNameHintsForExport = _applyTransparentNameHintsForExport;
                EditorPrefs.SetBool(ApplyTransparentNameHintsForExportPrefKey, _applyTransparentNameHintsForExport);
            }

            EditorGUILayout.HelpBox(
                "Off by default. When enabled, export temporarily treats materials with transparent-looking material or shader names as transparent. " +
                "For safer permanent changes, use Tools > Scene Sync > Support > Apply Transparent Name Hints To Selection.",
                MessageType.Info
            );

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

                if (GUILayout.Button("Check UnityGLTF Status Again", GUILayout.Height(24)))
                {
                    SceneSyncUnityGltfInstaller.RefreshUnityGltfPackageStatus();
                }
            }
        }

        private static void MarkManagerDirty(SceneSyncManager manager)
        {
            EditorUtility.SetDirty(manager);
            if (!Application.isPlaying)
                EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());
        }

        private void DrawSetupSection()
        {
            var manager = FindSceneSyncManager();
            var temporaryRoot = FindTemporaryRoot();
            var setupMissing = IsSceneSyncSetupMissing(manager, temporaryRoot);

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
            GUILayout.Label("Manager Temporary Root: " + (IsManagerTemporaryRootReady(manager, temporaryRoot) ? "Assigned" : "Missing"));
            GUILayout.Label("Rapier Setup: " + GetRapierSetupStatusLabel(manager, temporaryRoot));

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

            if (manager != null && temporaryRoot != null)
            {
                hasChanges |= EnsureManagerTemporaryRoot(manager, temporaryRoot.transform);
                hasChanges |= EnsureOptionalRapierSetup(manager, temporaryRoot.transform);
            }

            if (hasChanges)
            {
                EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());
            }

            if (manager != null)
            {
                manager.ConfiguredRoom = _room;
                MarkManagerDirty(manager);
                Selection.activeGameObject = manager.gameObject;
            }
        }

        private static bool IsSceneSyncSetupMissing(SceneSyncManager manager, GameObject temporaryRoot)
        {
            if (manager == null || temporaryRoot == null) return true;
            if (!IsManagerTemporaryRootReady(manager, temporaryRoot)) return true;
            return IsOptionalRapierSetupMissing(manager, temporaryRoot.transform);
        }

        private static bool IsManagerTemporaryRootReady(SceneSyncManager manager, GameObject temporaryRoot)
        {
            return manager != null
                && temporaryRoot != null
                && manager.TemporaryRoot == temporaryRoot.transform;
        }

        private static bool EnsureManagerTemporaryRoot(SceneSyncManager manager, Transform temporaryRoot)
        {
            if (manager == null || temporaryRoot == null || manager.TemporaryRoot == temporaryRoot)
                return false;

            Undo.RecordObject(manager, "Configure Scene Sync Setup");
            manager.TemporaryRoot = temporaryRoot;
            EditorUtility.SetDirty(manager);
            return true;
        }

        private static bool IsOptionalRapierSetupMissing(SceneSyncManager manager, Transform temporaryRoot)
        {
            var bridgeType = FindRapierBridgeType();
            if (bridgeType == null) return false;
            if (manager == null || temporaryRoot == null) return true;
            if (manager.GetComponent<SceneSyncPhysicsMetadata>() == null) return true;

            var bridge = manager.GetComponent(bridgeType);
            if (bridge == null || GetTransformProperty(bridge, "BodyRoot") != temporaryRoot)
                return true;

            var interactionControllerType = FindRapierInteractionControllerType();
            return interactionControllerType != null && manager.GetComponent(interactionControllerType) == null;
        }

        private static string GetRapierSetupStatusLabel(SceneSyncManager manager, GameObject temporaryRoot)
        {
            var bridgeType = FindRapierBridgeType();
            if (bridgeType == null) return "Package not installed";
            if (manager == null) return "Missing SceneSyncManager";
            if (manager.GetComponent<SceneSyncPhysicsMetadata>() == null) return "Missing Physics Metadata";

            var bridge = manager.GetComponent(bridgeType);
            if (bridge == null) return "Missing";
            if (temporaryRoot == null) return "Missing Temporary Root";
            if (GetTransformProperty(bridge, "BodyRoot") != temporaryRoot.transform)
                return "Body Root Missing";

            var interactionControllerType = FindRapierInteractionControllerType();
            if (interactionControllerType != null && manager.GetComponent(interactionControllerType) == null)
                return "Missing Interaction Controller";

            return "Found";
        }

        private static bool EnsureOptionalRapierSetup(SceneSyncManager manager, Transform temporaryRoot)
        {
            var bridgeType = FindRapierBridgeType();
            if (bridgeType == null || manager == null || temporaryRoot == null)
                return false;

            var changed = false;
            var metadata = manager.GetComponent<SceneSyncPhysicsMetadata>();
            if (metadata == null)
            {
                metadata = Undo.AddComponent<SceneSyncPhysicsMetadata>(manager.gameObject);
                changed = true;
            }
            if (metadata != null && string.IsNullOrWhiteSpace(metadata.ScenePhysicsJson))
            {
                Undo.RecordObject(metadata, "Configure Scene Sync Rapier Physics");
                metadata.ConfigureScenePhysics(DefaultRapierScenePhysicsJson);
                changed = true;
            }

            var bridge = manager.GetComponent(bridgeType);
            if (bridge == null)
            {
                bridge = Undo.AddComponent(manager.gameObject, bridgeType);
                changed = true;
            }

            if (bridge != null)
            {
                Undo.RecordObject(bridge, "Configure Scene Sync Rapier Bridge");
                changed |= SetTransformProperty(bridge, "BodyRoot", temporaryRoot);
                changed |= SetBoolProperty(bridge, "AutoRun", true);
                changed |= SetBoolProperty(bridge, "UseSceneClock", true);
                changed |= SetBoolProperty(bridge, "RequireSceneClock", false);
                changed |= SetBoolProperty(bridge, "PreserveMotionOnRebuild", false);
                EditorUtility.SetDirty(bridge);
            }

            var interactionControllerType = FindRapierInteractionControllerType();
            if (interactionControllerType != null)
            {
                var interactionController = manager.GetComponent(interactionControllerType);
                if (interactionController == null)
                {
                    interactionController = Undo.AddComponent(manager.gameObject, interactionControllerType);
                    changed = true;
                }

                if (interactionController != null)
                {
                    Undo.RecordObject(interactionController, "Configure Scene Sync Rapier Interaction");
                    changed |= SetObjectProperty(interactionController, "Bridge", bridge);
                    var sceneCamera = FindSceneCamera();
                    if (sceneCamera != null)
                        changed |= SetObjectProperty(interactionController, "TargetCamera", sceneCamera);
                    EditorUtility.SetDirty(interactionController);
                }
            }

            if (metadata != null)
                EditorUtility.SetDirty(metadata);

            return changed;
        }

        private static Type FindRapierBridgeType()
        {
            if (_rapierBridgeTypeResolved)
                return _rapierBridgeType;

            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                var type = assembly.GetType(RapierBridgeTypeName);
                if (type == null) continue;
                _rapierBridgeType = type;
                _rapierBridgeTypeResolved = true;
                return _rapierBridgeType;
            }

            _rapierBridgeTypeResolved = true;
            return _rapierBridgeType;
        }

        private static Type FindRapierInteractionControllerType()
        {
            if (_rapierInteractionControllerTypeResolved)
                return _rapierInteractionControllerType;

            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                var type = assembly.GetType(RapierInteractionControllerTypeName);
                if (type == null) continue;
                _rapierInteractionControllerType = type;
                _rapierInteractionControllerTypeResolved = true;
                return _rapierInteractionControllerType;
            }

            _rapierInteractionControllerTypeResolved = true;
            return _rapierInteractionControllerType;
        }

        private static Transform GetTransformProperty(Component component, string propertyName)
        {
            if (component == null) return null;
            var property = component.GetType().GetProperty(propertyName);
            return property != null ? property.GetValue(component, null) as Transform : null;
        }

        private static bool SetTransformProperty(Component component, string propertyName, Transform value)
        {
            if (component == null) return false;
            var property = component.GetType().GetProperty(propertyName);
            if (property == null || !property.CanWrite) return false;
            if (property.GetValue(component, null) as Transform == value) return false;
            property.SetValue(component, value, null);
            return true;
        }

        private static bool SetObjectProperty(Component component, string propertyName, object value)
        {
            if (component == null) return false;
            var property = component.GetType().GetProperty(propertyName);
            if (property == null || !property.CanWrite) return false;
            if (value != null && !property.PropertyType.IsInstanceOfType(value)) return false;
            if (Equals(property.GetValue(component, null), value)) return false;
            property.SetValue(component, value, null);
            return true;
        }

        private static Camera FindSceneCamera()
        {
            return Camera.main != null ? Camera.main : FindFirstObjectByType<Camera>();
        }

        private static bool SetBoolProperty(Component component, string propertyName, bool value)
        {
            if (component == null) return false;
            var property = component.GetType().GetProperty(propertyName);
            if (property == null || !property.CanWrite || property.PropertyType != typeof(bool)) return false;
            if ((bool)property.GetValue(component, null) == value) return false;
            property.SetValue(component, value, null);
            return true;
        }

        private void SyncRoomFromSceneSyncManager()
        {
            if (_connected) return;

            var manager = FindSceneSyncManager();
            if (manager == null) return;

            var managerRoom = manager.ConfiguredRoom ?? "";

            if (_room == managerRoom) return;
            _room = managerRoom;
            Repaint();
        }

        private void SyncRoomToSceneSyncManager()
        {
            var manager = FindSceneSyncManager();
            if (manager == null) return;
            if (manager.ConfiguredRoom == _room) return;

            manager.ConfiguredRoom = _room;
            MarkManagerDirty(manager);
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
            InvalidateRemoteImportSession();

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
            SyncRoomFromSceneSyncManager();
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
            if (!raw.Contains("\"kind\"") && !raw.Contains("\"type\":\"scene-graph-")) return;

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
            SceneSyncMessageBus.PublishReceived(raw, fromId, this);

            if (raw.Contains("\"type\":\"scene-graph-set\""))
            {
                HandleSceneGraphSet(raw);
            }
            else if (raw.Contains("\"type\":\"scene-graph-clear\""))
            {
                HandleSceneGraphClear(raw);
            }
            else if (raw.Contains("\"kind\":\"scene-request\""))
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
            else if (raw.Contains("\"kind\":\"scene-env\""))
            {
                HandleSceneEnv(raw);
            }
            else if (raw.Contains("\"kind\":\"scene-physics\""))
            {
                HandleScenePhysics(raw);
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

            ApplyScenePhysicsMetadata(raw);

            var envId = SceneSyncWireJson.ExtractString(raw, "envId");
            if (!string.IsNullOrWhiteSpace(envId))
                _envId = envId;

            foreach (var entry in SceneSyncWireJson.ExtractObjectMapEntries(raw, "objects"))
            {
                var fakeJson = "{\"kind\":\"scene-add\",\"objectId\":\"" + SceneSyncWireJson.JsonEscape(entry.Key) + "\"," + entry.Value.Trim().TrimStart('{');
                Debug.Log("[SceneSync] Restore scene-state object as scene-add: " + fakeJson);
                HandleSceneAdd(fakeJson);
            }

            RestoreLoomGraphsFromSceneState(raw);
        }

        private void HandleSceneGraphSet(string raw)
        {
            var graphJson = SceneSyncWireJson.ExtractRawObject(raw, "graph");
            if (string.IsNullOrWhiteSpace(graphJson)) return;

            if (TryExtractGraphObjectScope(raw, out var objectId))
            {
                var go = FindManagedObject(objectId);
                if (go == null)
                {
                    _pendingObjectLoomGraphs[objectId] = graphJson;
                    Debug.Log("[SceneSync] Queued Loomlet object graph until target is ready: objectId=" + objectId);
                    return;
                }

                ApplyOrQueueObjectLoomGraph(objectId, graphJson, go);
                return;
            }

            var manager = FindSceneSyncManager();
            if (manager == null)
            {
                Debug.LogWarning("[SceneSync] scene-graph-set scene scope ignored because SceneSyncManager is missing");
                return;
            }

            SceneSyncLoomletBehaviour.SetSceneGraph(manager, graphJson);
            EditorUtility.SetDirty(manager);
            EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());
            Debug.Log("[SceneSync] Bound Loomlet scene graph");
        }

        private void HandleSceneGraphClear(string raw)
        {
            if (TryExtractGraphObjectScope(raw, out var objectId))
            {
                var go = FindManagedObject(objectId);
                SceneSyncLoomletBehaviour.ClearObjectGraph(go);
                _pendingObjectLoomGraphs.Remove(objectId);
                if (go != null) EditorUtility.SetDirty(go);
                EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());
                Debug.Log("[SceneSync] Cleared Loomlet object graph: objectId=" + objectId);
                return;
            }

            var manager = FindSceneSyncManager();
            SceneSyncLoomletBehaviour.ClearSceneGraph(manager);
            if (manager != null) EditorUtility.SetDirty(manager);
            EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());
            Debug.Log("[SceneSync] Cleared Loomlet scene graph");
        }

        private bool TryExtractGraphObjectScope(string raw, out string objectId)
        {
            var scopeJson = SceneSyncWireJson.ExtractRawObject(raw, "scope");
            objectId = SceneSyncWireJson.ExtractString(scopeJson, "object");
            if (!string.IsNullOrWhiteSpace(objectId)) return true;

            var scope = SceneSyncWireJson.ExtractString(raw, "scope");
            if (scope == "object")
            {
                objectId = SceneSyncWireJson.ExtractString(raw, "objectId");
                return !string.IsNullOrWhiteSpace(objectId);
            }

            objectId = null;
            return !string.IsNullOrWhiteSpace(objectId);
        }

        private void RestoreLoomGraphsFromSceneState(string raw)
        {
            var loomGraphsJson = SceneSyncWireJson.ExtractRawObject(raw, "loomGraphs");
            if (string.IsNullOrWhiteSpace(loomGraphsJson)) return;

            var manager = FindSceneSyncManager();
            var sceneGraphJson = SceneSyncWireJson.ExtractRawObject(loomGraphsJson, "scene");
            if (manager != null && !string.IsNullOrWhiteSpace(sceneGraphJson))
                SceneSyncLoomletBehaviour.SetSceneGraph(manager, sceneGraphJson);

            foreach (var entry in SceneSyncWireJson.ExtractObjectMapEntries(loomGraphsJson, "objects"))
            {
                var go = FindManagedObject(entry.Key);
                ApplyOrQueueObjectLoomGraph(entry.Key, entry.Value, go);
            }

            EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());
        }

        private void ApplyOrQueueObjectLoomGraph(string objectId, string graphJson, GameObject go)
        {
            if (string.IsNullOrWhiteSpace(objectId) || string.IsNullOrWhiteSpace(graphJson)) return;

            if (go == null || IsImportPlaceholder(go, objectId))
            {
                _pendingObjectLoomGraphs[objectId] = graphJson;
                Debug.Log("[SceneSync] Queued Loomlet object graph until target is ready: objectId=" + objectId);
                return;
            }

            SceneSyncLoomletBehaviour.SetObjectGraph(go, FindSceneSyncManager(), objectId, graphJson);
            _pendingObjectLoomGraphs.Remove(objectId);
            EditorUtility.SetDirty(go);
            EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());
            Debug.Log("[SceneSync] Bound Loomlet object graph: objectId=" + objectId);
        }

        private bool ApplyPendingObjectLoomGraph(string objectId, GameObject go)
        {
            if (go == null || string.IsNullOrWhiteSpace(objectId)) return false;
            if (!_pendingObjectLoomGraphs.TryGetValue(objectId, out var graphJson) ||
                string.IsNullOrWhiteSpace(graphJson))
                return false;

            SceneSyncLoomletBehaviour.SetObjectGraph(go, FindSceneSyncManager(), objectId, graphJson);
            _pendingObjectLoomGraphs.Remove(objectId);
            EditorUtility.SetDirty(go);
            EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());
            Debug.Log("[SceneSync] Bound pending Loomlet object graph: objectId=" + objectId);
            return true;
        }

        private static bool IsImportPlaceholder(GameObject go, string objectId)
        {
            if (go == null) return false;
            var identity = go.GetComponent<SceneSyncIdentity>();
            return identity != null
                   && identity.Temporary
                   && identity.ObjectId == objectId
                   && go.transform.childCount == 0
                   && go.GetComponentsInChildren<Renderer>(true).Length == 0;
        }

        private void ApplyMetadataBehaviorGraph(GameObject go, string objectId, string metadataJson)
        {
            if (go == null || string.IsNullOrWhiteSpace(objectId) || string.IsNullOrWhiteSpace(metadataJson)) return;

            var graphJson = SceneSyncWireJson.ExtractRawObject(metadataJson, "loomGraph");
            if (string.IsNullOrWhiteSpace(graphJson))
                graphJson = SceneSyncWireJson.ExtractRawObject(metadataJson, "behaviorGraph");
            if (string.IsNullOrWhiteSpace(graphJson)) return;

            SceneSyncLoomletBehaviour.SetObjectGraph(go, FindSceneSyncManager(), objectId, graphJson);
            EditorUtility.SetDirty(go);
            EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());
        }

        private void HandleSceneEnv(string raw)
        {
            var envId = SceneSyncWireJson.ExtractString(raw, "envId");
            if (string.IsNullOrWhiteSpace(envId)) return;
            _envId = envId;
            Debug.Log("[SceneSync] scene-env received: envId=" + envId);
        }

        private void HandleScenePhysics(string raw)
        {
            ApplyScenePhysicsMetadata(raw);
        }

        private void ApplyScenePhysicsMetadata(string raw)
        {
            if (!SceneSyncWireJson.HasTopLevelField(raw, "physics")) return;

            var manager = FindSceneSyncManager();
            if (manager == null) return;

            var physicsJson = SceneSyncWireJson.ExtractTopLevelRawValue(raw, "physics");
            var metadata = manager.GetComponent<SceneSyncPhysicsMetadata>();
            if (metadata == null) metadata = manager.gameObject.AddComponent<SceneSyncPhysicsMetadata>();
            metadata.ConfigureScenePhysics(physicsJson);
            EditorUtility.SetDirty(metadata);
            EditorUtility.SetDirty(manager);
            EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());
        }

        private static string ExtractObjectPhysicsJson(string raw)
        {
            return SceneSyncWireJson.HasTopLevelField(raw, "physics")
                ? SceneSyncWireJson.ExtractTopLevelRawValue(raw, "physics")
                : null;
        }

        private static void ApplyObjectPhysicsMetadata(GameObject go, string physicsJson)
        {
            if (go == null) return;

            var metadata = go.GetComponent<SceneSyncPhysicsMetadata>();
            if (string.IsNullOrWhiteSpace(physicsJson) || physicsJson.Trim() == "null")
            {
                if (metadata != null)
                {
                    metadata.ClearObjectPhysics();
                    EditorUtility.SetDirty(metadata);
                }
                return;
            }

            if (metadata == null) metadata = go.AddComponent<SceneSyncPhysicsMetadata>();
            metadata.ConfigureObjectPhysics(physicsJson);
            EditorUtility.SetDirty(metadata);
        }

        private static string GetObjectPhysicsJson(GameObject go)
        {
            var metadata = go != null ? go.GetComponent<SceneSyncPhysicsMetadata>() : null;
            return metadata != null && !string.IsNullOrWhiteSpace(metadata.ObjectPhysicsJson)
                ? metadata.ObjectPhysicsJson
                : null;
        }

        private void HandleSceneDelta(string raw)
        {
            // 簡易 JSON パース（scene-delta 専用）
            var objectIdMatch = System.Text.RegularExpressions.Regex.Match(raw, "\"objectId\":\"([^\"]+)\"");
            if (!objectIdMatch.Success) return;
            var objectId = objectIdMatch.Groups[1].Value;

            var name = SceneSyncWireJson.ExtractString(raw, "name");
            var visible = SceneSyncWireJson.ExtractBoolean(raw, "visible");
            float[] position = ExtractArray(raw, "\"position\":");
            float[] rotation = ExtractArray(raw, "\"rotation\":");
            float[] scale = ExtractArray(raw, "\"scale\":");
            var assetJson = SceneSyncWireJson.ExtractRawObject(raw, "asset");
            var metadataJson = SceneSyncWireJson.ExtractRawObject(raw, "metadata");
            var hasPhysics = SceneSyncWireJson.HasTopLevelField(raw, "physics");
            var physicsJson = hasPhysics ? ExtractObjectPhysicsJson(raw) : null;

            var go = FindManagedObject(objectId);
            if (go == null) return;

            if (hasPhysics)
                ApplyObjectPhysicsMetadata(go, physicsJson);

            if (!string.IsNullOrWhiteSpace(name))
                go.name = name;

            if (visible.HasValue)
                go.SetActive(visible.Value);

            if (!string.IsNullOrWhiteSpace(assetJson) || !string.IsNullOrWhiteSpace(metadataJson))
            {
                SceneSyncPanelFactory.ConfigureWireMetadata(go, assetJson, metadataJson, preserveMissing: true);
                SceneSyncPanelFactory.ApplyAssetVisualDelta(go, assetJson);
                ApplyMetadataBehaviorGraph(go, objectId, metadataJson);

                if (!string.IsNullOrWhiteSpace(assetJson))
                {
                    var meshPath = SceneSyncWireJson.ExtractString(assetJson, "meshPath");
                    var assetId = SceneSyncWireJson.ExtractString(assetJson, "assetId");
                    var identity = go.GetComponent<SceneSyncIdentity>();

                    if (!string.IsNullOrWhiteSpace(meshPath))
                    {
                        _meshPaths[objectId] = meshPath;
                        if (identity != null) identity.MeshPath = meshPath;
                    }

                    if (!string.IsNullOrWhiteSpace(assetId) && identity != null)
                        identity.AssetId = assetId;

                    if (identity != null) EditorUtility.SetDirty(identity);
                }

                EditorUtility.SetDirty(go);
            }

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

        private static IEnumerable<GameObject> EnumerateSceneGameObjects()
        {
            var rootObjects = UnityEngine.SceneManagement.SceneManager
                .GetActiveScene().GetRootGameObjects();

            foreach (var root in rootObjects)
            {
                if (root == null) continue;
                foreach (var transform in root.GetComponentsInChildren<Transform>(true))
                {
                    if (transform != null) yield return transform.gameObject;
                }
            }
        }

        private GameObject ResolveUnityOriginObject(string objectId, string name, string unityHierarchyPath)
        {
            var candidates = EnumerateSceneGameObjects();

            foreach (var candidate in candidates)
            {
                if (candidate == null) continue;
                var identity = candidate.GetComponent<SceneSyncIdentity>();
                if (identity == null) continue;
                if (identity.Origin != SceneSyncOrigin.Unity) continue;
                if (identity.Temporary) continue;
                if (identity.ObjectId == objectId) return candidate;
            }

            if (int.TryParse(objectId, out var instanceId))
            {
                foreach (var candidate in EnumerateSceneGameObjects())
                {
                    if (candidate != null && candidate.GetInstanceID() == instanceId)
                        return candidate;
                }
            }

            if (!string.IsNullOrWhiteSpace(unityHierarchyPath))
            {
                GameObject match = null;
                foreach (var candidate in EnumerateSceneGameObjects())
                {
                    if (candidate == null) continue;
                    var identity = candidate.GetComponent<SceneSyncIdentity>();
                    if (identity != null && identity.Temporary) continue;
                    if (SceneSyncWireJson.GetUnityHierarchyPath(candidate) != unityHierarchyPath) continue;
                    if (match != null) return null;
                    match = candidate;
                }
                if (match != null) return match;
            }

            if (!string.IsNullOrWhiteSpace(name))
            {
                GameObject match = null;
                foreach (var candidate in EnumerateSceneGameObjects())
                {
                    if (candidate == null) continue;
                    var identity = candidate.GetComponent<SceneSyncIdentity>();
                    if (identity != null && identity.Temporary) continue;
                    if (candidate.name != name) continue;
                    if (match != null) return null;
                    match = candidate;
                }
                return match;
            }

            return null;
        }

        private void BindUnityOriginObject(
            GameObject go,
            string objectId,
            string meshPath,
            string assetId,
            string assetJson,
            string metadataJson,
            bool? visible,
            float[] position,
            float[] rotation,
            float[] scale,
            string physicsJson = null)
        {
            if (go == null) return;

            var identity = EnsureSceneSyncIdentity(go);
            identity.ObjectId = objectId;
            identity.Origin = SceneSyncOrigin.Unity;
            identity.Temporary = false;
            identity.State = SceneSyncState.Synced;
            identity.MeshPath = meshPath;
            identity.AssetId = assetId;
            identity.LockOwner = null;

            if (!string.IsNullOrEmpty(meshPath))
                _meshPaths[objectId] = meshPath;
            SceneSyncPanelFactory.ConfigureWireMetadata(go, assetJson, metadataJson, preserveMissing: true);
            if (physicsJson != null)
                ApplyObjectPhysicsMetadata(go, physicsJson);
            ApplyMetadataBehaviorGraph(go, objectId, metadataJson);
            if (visible.HasValue) go.SetActive(visible.Value);
            ApplyTransform(go, position, rotation, scale);

            _managedObjects[objectId] = go;
            _knownObjectIds.Add(objectId);
            _instanceToObjectId[go.GetInstanceID()] = objectId;
            _lastSnapshots[objectId] = new TransformSnapshot(go.transform);

            EditorUtility.SetDirty(identity);
            EditorUtility.SetDirty(go);
            EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());
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

        private void QueuePublishSelectedObjects()
        {
            QueuePublishOperation(PublishSelectedObjectsAsync);
        }

        private void QueuePublishManagedObjects()
        {
            QueuePublishOperation(PublishManagedObjectsAsync);
        }

        private void QueuePublishOperation(Func<System.Threading.Tasks.Task> operation)
        {
            if (_publishInProgress)
            {
                Debug.LogWarning("[SceneSync] Publish is already in progress.");
                return;
            }

            _publishInProgress = true;
            Repaint();

            EditorApplication.delayCall += async () =>
            {
                try
                {
                    if (operation != null)
                        await operation();
                }
                catch (Exception ex)
                {
                    Debug.LogException(ex);
                }
                finally
                {
                    _publishInProgress = false;
                    Repaint();
                }
            };
        }

        private async System.Threading.Tasks.Task PublishSelectedObjectsAsync()
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

        private async System.Threading.Tasks.Task PublishManagedObjectsAsync()
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
            var assetId = PresenceClientRuntime.ComputeAssetId(glb);

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

            var pos = go.transform.position;
            var rot = go.transform.rotation;
            var scl = go.transform.localScale;
            var preferredAnimationClipName = GlbExporter.LastExportPreferredAnimationClipName;
            if (!string.IsNullOrWhiteSpace(preferredAnimationClipName))
            {
                Debug.Log("[SceneSync] Initial GLB animation clip: " + preferredAnimationClipName);
            }
            var animationPayload = !string.IsNullOrWhiteSpace(preferredAnimationClipName)
                ? ",\"animation\":{\"enabled\":true,\"clipName\":\"" + JsonEscape(preferredAnimationClipName) + "\",\"mode\":\"loop\",\"speed\":1}"
                : "";
            var payload = "{\"kind\":\"scene-add\",\"objectId\":\"" + JsonEscape(objectId) + "\",\"name\":\"" + JsonEscape(go.name) + "\"" +
                ",\"origin\":\"unity\"" +
                ",\"unityHierarchyPath\":\"" + JsonEscape(SceneSyncWireJson.GetUnityHierarchyPath(go)) + "\"" +
                ",\"position\":[" + FormatFloat(pos.x) + "," + FormatFloat(pos.y) + "," + FormatFloat(-pos.z) + "]" +
                ",\"rotation\":[" + FormatFloat(rot.x) + "," + FormatFloat(rot.y) + "," + FormatFloat(-rot.z) + "," + FormatFloat(-rot.w) + "]" +
                ",\"scale\":[" + FormatFloat(scl.x) + "," + FormatFloat(scl.y) + "," + FormatFloat(scl.z) + "]" +
                ",\"meshPath\":\"" + JsonEscape(path) + "\"" +
                (!string.IsNullOrEmpty(assetId) ? ",\"assetId\":\"" + JsonEscape(assetId) + "\"" : "") +
                ",\"asset\":" + SceneSyncWireJson.BuildMeshAssetJson(path, assetId, "unity") +
                animationPayload + "}";

            if (!await EnsureConnectedForPublishBroadcast())
            {
                identity.State = SceneSyncState.Error;
                EditorUtility.SetDirty(identity);
                EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());

                Debug.LogError(
                    $"[SceneSync] Publish aborted because the connection could not be restored before broadcast: " +
                    $"{go.name}, objectId={objectId}, path={path}"
                );
                return;
            }

            var broadcasted = await _client.Broadcast(payload);
            if (!broadcasted)
            {
                identity.State = SceneSyncState.Error;
                EditorUtility.SetDirty(identity);
                EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());

                Debug.LogError(
                    $"[SceneSync] Publish aborted because scene update broadcast failed: " +
                    $"{go.name}, objectId={objectId}, path={path}"
                );
                return;
            }

            _meshPaths[objectId] = path;
            identity.MeshPath = path;
            identity.AssetId = assetId;
            identity.State = SceneSyncState.Synced;
            EditorUtility.SetDirty(identity);
            EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());

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
            var hasPhysics = SceneSyncWireJson.HasTopLevelField(raw, "physics");
            var physicsJson = hasPhysics ? ExtractObjectPhysicsJson(raw) : null;

            if (IsBoundUnityOriginObject(objectId))
            {
                if (hasPhysics)
                    ApplyObjectPhysicsMetadata(FindManagedObject(objectId), physicsJson);
                Debug.Log("[SceneSync] scene-add received: objectId=" + objectId + " → bound Unity object, skipping remote creation");
                return;
            }

            // 既に存在する場合はスキップ
            if (_managedObjects.ContainsKey(objectId))
            {
                var existing = _managedObjects[objectId];
                if (hasPhysics)
                    ApplyObjectPhysicsMetadata(existing, physicsJson);
                Debug.Log("[SceneSync] scene-add received: objectId=" + objectId
                    + " → already managed (name=" + (existing != null ? existing.name : "null")
                    + ", unityOrigin=" + IsBoundUnityOriginObject(objectId) + "), skipping");
                return;
            }

            Debug.Log("[SceneSync] scene-add received: objectId=" + objectId + " → not yet managed");

            var name = SceneSyncWireJson.ExtractString(raw, "name") ?? objectId;
            var origin = SceneSyncWireJson.ExtractString(raw, "origin");
            var unityHierarchyPath = SceneSyncWireJson.ExtractString(raw, "unityHierarchyPath");
            var visible = SceneSyncWireJson.ExtractBoolean(raw, "visible");

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

            var assetJson = SceneSyncWireJson.ExtractRawObject(raw, "asset");
            var metadataJson = SceneSyncWireJson.ExtractRawObject(raw, "metadata");
            if (string.IsNullOrEmpty(meshPath) && !string.IsNullOrEmpty(assetJson))
                meshPath = SceneSyncWireJson.ExtractString(assetJson, "meshPath");
            if (string.IsNullOrEmpty(assetId) && !string.IsNullOrEmpty(assetJson))
                assetId = SceneSyncWireJson.ExtractString(assetJson, "assetId");

            var visualBasis = SceneSyncWireJson.ExtractString(assetJson, "visualBasis");

            // meshPath を保存
            if (!string.IsNullOrEmpty(meshPath))
            {
                _meshPaths[objectId] = meshPath;
            }

            if (origin == "unity")
            {
                var unityObject = ResolveUnityOriginObject(objectId, name, unityHierarchyPath);
                if (unityObject != null)
                {
                    BindUnityOriginObject(
                        unityObject,
                        objectId,
                        meshPath,
                        assetId,
                        assetJson,
                        metadataJson,
                        visible,
                        position,
                        rotation,
                        scale,
                        physicsJson);
                    Debug.Log("[SceneSync] scene-add resolved origin=unity to existing GameObject: objectId=" + objectId + ", name=" + unityObject.name);
                    return;
                }

                Debug.LogWarning("[SceneSync] origin=unity object not found in Hierarchy; ignoring remote creation: objectId=" + objectId + ", name=" + name + ", hierarchyPath=" + unityHierarchyPath);
                return;
            }

            var assetType = SceneSyncWireJson.GetAssetType(assetJson);
            var hasMeshAsset = !string.IsNullOrEmpty(meshPath)
                || (assetType == "mesh"
                    && SceneSyncWireJson.GetAssetSource(assetJson) == "url"
                    && !string.IsNullOrEmpty(SceneSyncWireJson.GetAssetUrl(assetJson)));

            // メッシュがある場合は glB をダウンロードしてインポート
            if (hasMeshAsset)
            {
                _ = DownloadAndCreateObject(objectId, name, meshPath, position, rotation, scale, assetId, visualBasis, assetJson, metadataJson, visible, physicsJson);
            }
            else
            {
                var go = SceneSyncPanelFactory.CreateObjectForAsset(name, assetJson, metadataJson);
                ConfigureRemoteTemporaryIdentity(go, objectId, meshPath, assetId);
                ApplyObjectPhysicsMetadata(go, physicsJson);
                ApplyMetadataBehaviorGraph(go, objectId, metadataJson);
                if (visible.HasValue) go.SetActive(visible.Value);
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

            var assetJson = SceneSyncWireJson.ExtractRawObject(raw, "asset");
            var metadataJson = SceneSyncWireJson.ExtractRawObject(raw, "metadata");
            var hasPhysics = SceneSyncWireJson.HasTopLevelField(raw, "physics");
            var physicsJson = hasPhysics ? ExtractObjectPhysicsJson(raw) : null;
            if (string.IsNullOrEmpty(assetId) && !string.IsNullOrEmpty(assetJson))
                assetId = SceneSyncWireJson.ExtractString(assetJson, "assetId");

            var visualBasis = SceneSyncWireJson.ExtractString(assetJson, "visualBasis");
            var origin = SceneSyncWireJson.ExtractString(raw, "origin");
            var unityHierarchyPath = SceneSyncWireJson.ExtractString(raw, "unityHierarchyPath");

            // meshPath を保存
            _meshPaths[objectId] = meshPath;

            var go = FindManagedObject(objectId);
            var name = SceneSyncWireJson.ExtractString(raw, "name") ?? (go != null ? go.name : objectId);

            if (go == null && origin == "unity")
            {
                go = ResolveUnityOriginObject(objectId, name, unityHierarchyPath);
                if (go != null)
                {
                    BindUnityOriginObject(go, objectId, meshPath, assetId, assetJson, metadataJson, null, null, null, null, physicsJson);
                    Debug.Log("[SceneSync] scene-mesh resolved origin=unity to existing GameObject: objectId=" + objectId + ", name=" + go.name);
                    return;
                }

                Debug.LogWarning("[SceneSync] origin=unity scene-mesh target not found in Hierarchy; ignoring remote creation: objectId=" + objectId + ", hierarchyPath=" + unityHierarchyPath);
                return;
            }

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
                SceneSyncPanelFactory.ConfigureWireMetadata(go, assetJson, metadataJson);
                if (hasPhysics)
                    ApplyObjectPhysicsMetadata(go, physicsJson);
                ApplyMetadataBehaviorGraph(go, objectId, metadataJson);
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
                    assetId, visualBasis, assetJson, metadataJson, null, physicsJson);
            }
            else
            {
                _ = DownloadAndCreateObject(objectId, name, meshPath, null, null, null, assetId, visualBasis, assetJson, metadataJson, null, physicsJson);
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
            var pendingUploads = new List<(string objectId, byte[] glb, string path, string assetId)>();
            var objectData = new Dictionary<string, (GameObject go, string path, Transform transform)>();
            int sceneStateObjectCount = 0;

            foreach (var go in rootObjects)
            {
                if (!IsSyncTarget(go)) continue;

                if (IsUnderSceneSyncInternalHierarchy(go))
                {
                    Debug.Log($"[SceneSync] scene-state skip: internal hierarchy: name={go.name}");
                    continue;
                }

                var identity = go.GetComponent<SceneSyncIdentity>();
                var objectId = identity != null && !string.IsNullOrWhiteSpace(identity.ObjectId)
                    ? identity.ObjectId
                    : go.GetInstanceID().ToString();
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
                    if (glb == null)
                    {
                        Debug.LogWarning(
                            $"[SceneSync] scene-state skipped because GLB export failed: " +
                            $"objectId={objectId}, name={go.name}"
                        );
                        continue;
                    }
                    else
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
                        var assetId = PresenceClientRuntime.ComputeAssetId(glb);
                        pendingUploads.Add((objectId, glb, path, assetId));
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
            foreach (var (objectId, glb, path, assetId) in pendingUploads)
            {
                var uploaded = await PresenceClient.UploadGlb(glb, GetBlobUrl(), path);
                if (uploaded)
                {
                    _meshPaths[objectId] = path;
                    if (objectData.TryGetValue(objectId, out var data))
                    {
                        var identity = data.go.GetComponent<SceneSyncIdentity>();
                        if (identity != null)
                        {
                            identity.MeshPath = path;
                            identity.AssetId = assetId;
                            EditorUtility.SetDirty(identity);
                        }
                    }
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

                var identity = go.GetComponent<SceneSyncIdentity>();
                var isUnityVisualBasis = identity == null || identity.Origin == SceneSyncOrigin.Unity;
                var assetId = identity != null ? identity.AssetId : null;
                var wireMetadata = go.GetComponent<SceneSyncWireMetadata>();
                var rawAssetJson = wireMetadata != null ? wireMetadata.AssetJson : null;
                var rawMetadataJson = wireMetadata != null ? wireMetadata.MetadataJson : null;
                var physicsMetadata = go.GetComponent<SceneSyncPhysicsMetadata>();
                var rawPhysicsJson = physicsMetadata != null ? physicsMetadata.ObjectPhysicsJson : null;
                if (string.IsNullOrWhiteSpace(rawAssetJson) && path != null)
                {
                    rawAssetJson = SceneSyncWireJson.BuildMeshAssetJson(
                        path,
                        assetId,
                        isUnityVisualBasis ? "unity" : null);
                }
                var pos = transform.position;
                var rot = transform.rotation;
                var scl = transform.localScale;

                objectsJson.Append(SceneSyncWireJson.BuildObjectJson(
                    objectId,
                    go.name,
                    pos,
                    rot,
                    scl,
                    go.activeSelf,
                    path,
                    assetId,
                    rawAssetJson,
                    rawMetadataJson,
                    identity != null && identity.Origin == SceneSyncOrigin.Unity ? "unity" : null,
                    identity != null && identity.Origin == SceneSyncOrigin.Unity ? SceneSyncWireJson.GetUnityHierarchyPath(go) : null,
                    rawPhysicsJson));
            }

            objectsJson.Append("}");

            // handoff で 1対1 返信（broadcast ではない）
            var envJson = !string.IsNullOrWhiteSpace(_envId)
                ? ",\"envId\":\"" + SceneSyncWireJson.JsonEscape(_envId) + "\""
                : "";
            var manager = FindSceneSyncManager();
            var scenePhysics = manager != null ? manager.GetComponent<SceneSyncPhysicsMetadata>() : null;
            var physicsJson = scenePhysics != null && !string.IsNullOrWhiteSpace(scenePhysics.ScenePhysicsJson)
                ? ",\"physics\":" + scenePhysics.ScenePhysicsJson
                : "";
            var loomGraphsJson = BuildLoomGraphsStateJson();
            var payload = "{\"kind\":\"scene-state\"" + envJson + physicsJson + ",\"objects\":" + objectsJson
                + (!string.IsNullOrWhiteSpace(loomGraphsJson) ? ",\"loomGraphs\":" + loomGraphsJson : "")
                + "}";
            await _client.SendHandoff(fromId, payload);
        }

        private string BuildLoomGraphsStateJson()
        {
            var manager = FindSceneSyncManager();
            var sceneGraph = manager != null ? manager.GetComponent<SceneSyncLoomletBehaviour>() : null;
            var hasSceneGraph = sceneGraph != null
                && sceneGraph.SceneScope
                && !string.IsNullOrWhiteSpace(sceneGraph.GraphJson);

            var objects = new System.Text.StringBuilder();
            objects.Append("{");
            var hasObjectGraphs = false;
            foreach (var kvp in _managedObjects)
            {
                var go = kvp.Value;
                if (go == null) continue;
                var runner = go.GetComponent<SceneSyncLoomletBehaviour>();
                if (runner == null || runner.SceneScope || string.IsNullOrWhiteSpace(runner.GraphJson)) continue;
                if (hasObjectGraphs) objects.Append(",");
                hasObjectGraphs = true;
                objects.Append("\"").Append(SceneSyncWireJson.JsonEscape(kvp.Key)).Append("\":").Append(runner.GraphJson);
            }
            objects.Append("}");

            if (!hasSceneGraph && !hasObjectGraphs) return null;

            var builder = new System.Text.StringBuilder();
            builder.Append("{\"scene\":");
            builder.Append(hasSceneGraph ? sceneGraph.GraphJson : "null");
            builder.Append(",\"objects\":").Append(objects).Append("}");
            return builder.ToString();
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

        private string GetPersistentGlbCacheDirectory()
        {
            return System.IO.Path.Combine(Application.persistentDataPath, "SceneSyncGlbCache");
        }

        private static string SanitizeCacheKey(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return null;
            var invalid = System.IO.Path.GetInvalidFileNameChars();
            var chars = value.ToCharArray();
            for (var i = 0; i < chars.Length; i++)
            {
                if (Array.IndexOf(invalid, chars[i]) >= 0)
                    chars[i] = '_';
            }
            return new string(chars);
        }

        private string GetPersistentGlbCachePath(string prefix, string key)
        {
            var sanitized = SanitizeCacheKey(key);
            if (string.IsNullOrWhiteSpace(sanitized)) return null;
            return System.IO.Path.Combine(GetPersistentGlbCacheDirectory(), prefix + "-" + sanitized + ".glb");
        }

        private bool TryLoadPersistentCachedGlb(string assetId, string meshPath, out byte[] glbBytes, out string source)
        {
            glbBytes = null;
            source = null;

            var candidates = new List<KeyValuePair<string, string>>();
            if (!string.IsNullOrWhiteSpace(assetId))
                candidates.Add(new KeyValuePair<string, string>("assetId", GetPersistentGlbCachePath("asset", assetId)));
            if (!string.IsNullOrWhiteSpace(meshPath))
                candidates.Add(new KeyValuePair<string, string>("meshPath", GetPersistentGlbCachePath("mesh", meshPath)));

            foreach (var candidate in candidates)
            {
                var path = candidate.Value;
                if (string.IsNullOrWhiteSpace(path) || !System.IO.File.Exists(path)) continue;
                try
                {
                    var bytes = System.IO.File.ReadAllBytes(path);
                    if (bytes == null || bytes.Length == 0 || bytes.Length > MaxPersistentGlbSizeBytes) continue;
                    TouchPersistentGlbCacheFile(path);
                    glbBytes = bytes;
                    source = candidate.Key;
                    return true;
                }
                catch (Exception err)
                {
                    Debug.LogWarning("[SceneSync] Failed to read persistent GLB cache: " + path + "\n" + err.Message);
                }
            }

            return false;
        }

        private void StorePersistentCachedGlb(byte[] glbBytes, string assetId, string meshPath)
        {
            if (glbBytes == null || glbBytes.Length == 0 || glbBytes.Length > MaxPersistentGlbSizeBytes) return;
            if (glbBytes.LongLength > MaxPersistentGlbCacheBytes) return;

            try
            {
                var dir = GetPersistentGlbCacheDirectory();
                System.IO.Directory.CreateDirectory(dir);

                if (!string.IsNullOrWhiteSpace(assetId))
                {
                    var assetPath = GetPersistentGlbCachePath("asset", assetId);
                    if (!string.IsNullOrWhiteSpace(assetPath))
                        System.IO.File.WriteAllBytes(assetPath, glbBytes);
                }

                if (!string.IsNullOrWhiteSpace(meshPath))
                {
                    var meshPathCachePath = GetPersistentGlbCachePath("mesh", meshPath);
                    if (!string.IsNullOrWhiteSpace(meshPathCachePath))
                        System.IO.File.WriteAllBytes(meshPathCachePath, glbBytes);
                }

                PrunePersistentGlbCache(dir);
            }
            catch (Exception err)
            {
                Debug.LogWarning("[SceneSync] Failed to write persistent GLB cache: " + err.Message);
            }
        }

        private void TouchPersistentGlbCacheFile(string path)
        {
            try
            {
                System.IO.File.SetLastWriteTimeUtc(path, DateTime.UtcNow);
            }
            catch
            {
                // Best effort only; cache reads should not fail because metadata updates are unavailable.
            }
        }

        private void PrunePersistentGlbCache(string dir)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(dir) || !System.IO.Directory.Exists(dir)) return;

                var files = new System.IO.DirectoryInfo(dir)
                    .EnumerateFiles("*.glb", System.IO.SearchOption.TopDirectoryOnly)
                    .OrderBy(file => file.LastWriteTimeUtc)
                    .ToList();

                long totalBytes = 0;
                foreach (var file in files)
                    totalBytes += Math.Max(0L, file.Length);

                foreach (var file in files)
                {
                    if (totalBytes <= MaxPersistentGlbCacheBytes) break;

                    var length = Math.Max(0L, file.Length);
                    try
                    {
                        file.Delete();
                        totalBytes -= length;
                    }
                    catch (Exception err)
                    {
                        Debug.LogWarning("[SceneSync] Failed to prune persistent GLB cache file: " +
                                         file.FullName + "\n" + err.Message);
                    }
                }
            }
            catch (Exception err)
            {
                Debug.LogWarning("[SceneSync] Failed to prune persistent GLB cache: " + err.Message);
            }
        }

        private async System.Threading.Tasks.Task DownloadAndCreateObject(
            string objectId, string name, string meshPath,
            float[] position, float[] rotation, float[] scale, string assetId = null, string visualBasis = null,
            string assetJson = null, string metadataJson = null, bool? visible = null, string physicsJson = null)
        {
            var importGeneration = _remoteImportGeneration;
            if (!IsRemoteImportSessionCurrent(importGeneration)) return;

            try
            {
                if (!string.IsNullOrEmpty(meshPath))
                {
                    _meshPaths[objectId] = meshPath;
                }

                var effectivePhysicsJson = physicsJson ?? GetObjectPhysicsJson(FindManagedObject(objectId));
                var assetUrl = SceneSyncWireJson.GetAssetSource(assetJson) == "url"
                    ? SceneSyncWireJson.GetAssetUrl(assetJson)
                    : null;
                var url = !string.IsNullOrWhiteSpace(assetUrl)
                    ? assetUrl
                    : GetBlobUrl() + "/" + meshPath;
                byte[] glbBytes = null;
                if (TryLoadPersistentCachedGlb(assetId, meshPath, out var persistentGlb, out var persistentSource))
                {
                    glbBytes = persistentGlb;
                    Debug.Log("[SceneSync] Using persistent cached GLB by " + persistentSource + ": " +
                              (!string.IsNullOrWhiteSpace(assetId) ? assetId : meshPath));
                }
                else
                {
                    Debug.Log("[SceneSync] Downloading mesh: " + url);

                    var http = new HttpClient();
                    var response = await http.GetAsync(url);
                    if (!IsRemoteImportSessionCurrent(importGeneration)) return;

                    if (!response.IsSuccessStatusCode)
                    {
                        Debug.LogWarning("[SceneSync] Download failed: " + response.StatusCode);
                        if (!IsRemoteImportSessionCurrent(importGeneration)) return;
                        var fallback = SceneSyncPanelFactory.CreateObjectForAsset(name, assetJson, metadataJson);
                        ConfigureRemoteTemporaryIdentity(fallback, objectId, meshPath, assetId);
                        if (effectivePhysicsJson != null)
                            ApplyObjectPhysicsMetadata(fallback, effectivePhysicsJson);
                        ApplyMetadataBehaviorGraph(fallback, objectId, metadataJson);
                        if (visible.HasValue) fallback.SetActive(visible.Value);
                        fallback.transform.SetParent(GetOrCreateTemporaryRoot(), worldPositionStays: false);
                        ApplyTransform(fallback, position, rotation, scale);
                        _managedObjects[objectId] = fallback;
                        _knownObjectIds.Add(objectId);
                        _instanceToObjectId[fallback.GetInstanceID()] = objectId;
                        ApplyPendingObjectLoomGraph(objectId, fallback);
                        return;
                    }

                    glbBytes = await response.Content.ReadAsByteArrayAsync();
                    if (!IsRemoteImportSessionCurrent(importGeneration)) return;
                    StorePersistentCachedGlb(glbBytes, assetId, meshPath);
                }

                if (!IsRemoteImportSessionCurrent(importGeneration)) return;
                var tempFileName = !string.IsNullOrEmpty(meshPath) ? meshPath : objectId;
                var tempPath = System.IO.Path.Combine(
                    Application.temporaryCachePath, tempFileName + ".glb");
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
                if (!IsRemoteImportSessionCurrent(importGeneration)) return;

                if (success)
                {
                    var go = new GameObject(name);
                    ConfigureRemoteTemporaryIdentity(go, objectId, meshPath, assetId);
                    SceneSyncPanelFactory.ConfigureWireMetadata(go, assetJson, metadataJson);
                    if (effectivePhysicsJson != null)
                        ApplyObjectPhysicsMetadata(go, effectivePhysicsJson);
                    ApplyMetadataBehaviorGraph(go, objectId, metadataJson);
                    if (visible.HasValue) go.SetActive(visible.Value);
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
                    if (!IsRemoteImportSessionCurrent(importGeneration) || go == null)
                    {
                        DestroyRemoteImportObject(go);
                        return;
                    }
                    ApplyTransform(go, position, rotation, scale);
                    _managedObjects[objectId] = go;
                    _knownObjectIds.Add(objectId);
                    _instanceToObjectId[go.GetInstanceID()] = objectId;
                    ApplyPendingObjectLoomGraph(objectId, go);
                    Debug.Log("[SceneSync] Imported mesh: " + name);
                }
                else
                {
                    Debug.LogWarning("[SceneSync] glTF import failed for: " + name);
                    if (!IsRemoteImportSessionCurrent(importGeneration)) return;
                    var fallback = SceneSyncPanelFactory.CreateObjectForAsset(name, assetJson, metadataJson);
                    ConfigureRemoteTemporaryIdentity(fallback, objectId, meshPath, assetId);
                    if (effectivePhysicsJson != null)
                        ApplyObjectPhysicsMetadata(fallback, effectivePhysicsJson);
                    ApplyMetadataBehaviorGraph(fallback, objectId, metadataJson);
                    if (visible.HasValue) fallback.SetActive(visible.Value);
                    fallback.transform.SetParent(GetOrCreateTemporaryRoot(), worldPositionStays: false);
                    ApplyTransform(fallback, position, rotation, scale);
                    _managedObjects[objectId] = fallback;
                    _knownObjectIds.Add(objectId);
                    _instanceToObjectId[fallback.GetInstanceID()] = objectId;
                    ApplyPendingObjectLoomGraph(objectId, fallback);
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
            var identities = UnityEngine.Object.FindObjectsByType<SceneSyncIdentity>(FindObjectsSortMode.None);
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
            InvalidateRemoteImportSession();

            var root = FindTemporaryRoot()?.transform;
            var destroyedAny = false;
            var destroyedRootChildren = new HashSet<GameObject>();

            if (root != null)
            {
                for (var i = root.childCount - 1; i >= 0; i--)
                {
                    var child = root.GetChild(i).gameObject;
                    destroyedRootChildren.Add(child);
                    DestroyRemoteImportObject(child);
                    destroyedAny = true;
                }
            }

            foreach (var identity in FindRemoteTemporaryIdentities())
            {
                var go = identity.gameObject;
                if (go == null) continue;
                if (destroyedRootChildren.Contains(go)) continue;
                if (root != null && go.transform.IsChildOf(root)) continue;

                DestroyRemoteImportObject(go);
                destroyedAny = true;
            }

            if (destroyedAny)
            {
                EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());
            }
        }

        private void DestroyRemoteImportObject(GameObject go)
        {
            if (go == null) return;

            ForgetSceneSyncObject(go);

            if (Application.isPlaying)
            {
                Destroy(go);
            }
            else
            {
                DestroyImmediate(go);
            }
        }

        private void ForgetSceneSyncObject(GameObject go)
        {
            var identity = go.GetComponent<SceneSyncIdentity>();
            if (identity == null)
            {
                foreach (var childIdentity in go.GetComponentsInChildren<SceneSyncIdentity>(true))
                {
                    if (childIdentity == null) continue;
                    if (!childIdentity.Temporary && childIdentity.Origin != SceneSyncOrigin.Remote) continue;
                    ForgetObject(childIdentity.ObjectId, childIdentity.gameObject);
                }
                return;
            }

            if (!identity.Temporary && identity.Origin != SceneSyncOrigin.Remote)
            {
                return;
            }

            if (string.IsNullOrEmpty(identity.ObjectId))
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
            SceneSyncLoomletBehaviour.ClearObjectGraph(go);

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
