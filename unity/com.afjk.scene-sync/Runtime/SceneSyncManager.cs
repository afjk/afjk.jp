using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using GLTFast;
using UnityEngine;

namespace Afjk.SceneSync
{
    public class SceneSyncManager : MonoBehaviour, ISceneSyncPlaybackClockProvider
    {
        [SerializeField] private string _presenceUrl = "wss://afjk.jp/presence";
        [SerializeField] private string _blobUrl = "";
        [SerializeField] private string _room = "";
        [SerializeField] private string _nickname = "Unity";
        [SerializeField] private bool _autoConnect = true;
        [SerializeField] private SceneSyncPlaybackClockMode _playbackClockMode = SceneSyncPlaybackClockMode.Local;
        [SerializeField] private SceneSyncPlaybackClockFollowPolicy _playbackClockFollowPolicy = SceneSyncPlaybackClockFollowPolicy.Manual;
        [SerializeField] private bool _allowPlaybackClockControl = true;
        [SerializeField] private float _sharedPlaybackClockBroadcastInterval = 0.25f;
        [SerializeField] private bool _syncHierarchy = true;
        [SerializeField] private Transform _syncRoot;
        [SerializeField] private bool includeManagerChildren = true;
        [SerializeField] private List<GameObject> managedObjects = new List<GameObject>();
        [SerializeField] private Transform temporaryRoot;
        [SerializeField] private Material _fallbackImportMaterial;

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
        private Material _runtimeFallbackImportMaterial;

        private bool _isShuttingDown = false;
        private bool _isApplicationQuitting = false;

        // Expired GLB recovery caches
        private Dictionary<string, byte[]> _assetIdCache = new Dictionary<string, byte[]>(); // assetId → glb bytes
        private Dictionary<string, byte[]> _meshPathCache = new Dictionary<string, byte[]>(); // meshPath → glb bytes
        private Dictionary<string, ExpiredGlbRecovery> _pendingRecoveries = new Dictionary<string, ExpiredGlbRecovery>();
        private Dictionary<string, string> _pendingObjectLoomGraphs = new Dictionary<string, string>();
        private Dictionary<string, double> _responderCooldowns = new Dictionary<string, double>(); // cacheKey-peerId → timestamp
        private string _activeOutgoingTransferId = null;
        private readonly HashSet<string> _remoteRemovedUnityObjectIds = new HashSet<string>();
        private string _envId = null;
        private SceneSyncPlaybackClockMode _lastAppliedPlaybackClockMode = (SceneSyncPlaybackClockMode)(-1);
        private SceneSyncPlaybackClockMode _lastEffectivePlaybackClockMode = (SceneSyncPlaybackClockMode)(-1);
        private SceneClockState _sharedSceneClock = SceneClockState.Inactive;
        private int _sharedSceneClockRevision;
        private double _lastSharedPlaybackClockBroadcastAt = double.NegativeInfinity;
        private Dictionary<string, double> _sharedObjectEpochTimes = new Dictionary<string, double>();
        private Dictionary<string, double> _localObjectEpochTimes = new Dictionary<string, double>();
        private double _roomTimeAtWelcome = double.NaN;
        private double _roomTimeWelcomeMonotonic = double.NaN;
        private double _localPlaybackAnchorMonotonic;
        private double _localPlaybackAnchorTime;
        private double _localPlaybackRate = 1d;
        private bool _localPlaybackPaused;
        private bool _localPlaybackTransportControlled;

        private const double RECOVERY_TIMEOUT_MS = 30000;
        private const double PEER_RETRY_INTERVAL_MS = 4000;
        private const double COOLDOWN_MS = 30000;
        private const int MAX_GLB_SIZE = 50 * 1024 * 1024;
        private const long MAX_PERSISTENT_GLB_CACHE_BYTES = 512L * 1024L * 1024L;

        private class ExpiredGlbRecovery
        {
            public string requestId;
            public string objectId;
            public string assetId;
            public string meshPath;
            public int? expectedSize;
            public double requestedAt;
            public HashSet<string> requestedPeerIds = new HashSet<string>();
        }

        public bool IsConnected => _connected;
        public string PresenceUrl
        {
            get => _presenceUrl;
            set => _presenceUrl = value ?? "";
        }
        public string Room => _client != null && !string.IsNullOrEmpty(_client.Room) ? _client.Room : _room;
        public string ConfiguredRoom
        {
            get => _room;
            set => _room = value ?? "";
        }
        public string Nickname
        {
            get => _nickname;
            set => _nickname = string.IsNullOrWhiteSpace(value) ? "Unity" : value.Trim();
        }
        public bool AutoConnect
        {
            get => _autoConnect;
            set => _autoConnect = value;
        }
        public SceneSyncPlaybackClockMode PlaybackClockMode
        {
            get => _playbackClockMode;
            set => SetPlaybackClockMode(value);
        }
        public SceneSyncPlaybackClockMode EffectivePlaybackClockMode => GetEffectivePlaybackClockMode(Time.realtimeSinceStartup);
        public SceneSyncPlaybackClockFollowPolicy PlaybackClockFollowPolicy
        {
            get => _playbackClockFollowPolicy;
            set => SetPlaybackClockFollowPolicy(value);
        }
        public bool AllowPlaybackClockControl
        {
            get => SceneSyncPlaybackClockMath.CanSendControllerPayload(
                _allowPlaybackClockControl,
                _playbackClockFollowPolicy);
            set => SetAllowPlaybackClockControl(value);
        }
        public bool IsPlaybackClockPaused => GetPlaybackClockSample().Paused;
        public double PlaybackClockRate => GetPlaybackClockSample().Rate;
        public double ActivePlaybackTime => GetPlaybackClockSample().ActiveTime;
        public string PlaybackClockControllerId => _sharedSceneClock.ControllerId;
        public float SharedPlaybackClockBroadcastInterval
        {
            get => _sharedPlaybackClockBroadcastInterval;
            set => _sharedPlaybackClockBroadcastInterval = Mathf.Max(0.05f, value);
        }
        public bool SyncHierarchy
        {
            get => _syncHierarchy;
            set => _syncHierarchy = value;
        }
        public List<PeerInfo> Peers => _peers;
        public GameObject SelectedObject => _selectedObject;
        public bool IncludeManagerChildren
        {
            get => includeManagerChildren;
            set => includeManagerChildren = value;
        }
        public List<GameObject> ManagedObjects => managedObjects;
        public Transform TemporaryRoot
        {
            get => temporaryRoot;
            set => temporaryRoot = value;
        }

        public event Action OnConnected;
        public event Action OnDisconnected;
        public event Action<List<PeerInfo>> OnPeersUpdated;
        public event Action<string, GameObject> OnObjectAdded;
        public event Action<string> OnObjectRemoved;
        public event Action<SceneSyncPlaybackClockSample> OnPlaybackClockChanged;

        public void SetPlaybackClockMode(SceneSyncPlaybackClockMode mode)
        {
            if (mode == SceneSyncPlaybackClockMode.SharedPlaybackControl && !AllowPlaybackClockControl)
            {
                Debug.LogWarning("[SceneSync] Shared Playback control is disabled by this client's clock policy");
                return;
            }
            if (_playbackClockMode == mode) return;

            _playbackClockMode = mode;
            if (Application.isPlaying && gameObject.activeInHierarchy)
            {
                ApplyPlaybackClockModeChange(Time.realtimeSinceStartup, _lastAppliedPlaybackClockMode);
            }
        }

        public void SetPlaybackClockFollowPolicy(SceneSyncPlaybackClockFollowPolicy policy)
        {
            if (_playbackClockFollowPolicy == policy) return;
            if (policy == SceneSyncPlaybackClockFollowPolicy.FollowerOnly
                && _playbackClockMode == SceneSyncPlaybackClockMode.SharedPlaybackControl)
            {
                ReleaseSharedPlaybackControl();
                _playbackClockMode = SceneSyncPlaybackClockMode.SharedPlaybackFollow;
            }
            _playbackClockFollowPolicy = policy;
            _lastEffectivePlaybackClockMode = (SceneSyncPlaybackClockMode)(-1);
        }

        public void SetAllowPlaybackClockControl(bool allow)
        {
            if (_allowPlaybackClockControl == allow) return;
            if (!allow && _playbackClockMode == SceneSyncPlaybackClockMode.SharedPlaybackControl)
            {
                ReleaseSharedPlaybackControl();
                _playbackClockMode = SceneSyncPlaybackClockMode.SharedPlaybackFollow;
            }
            _allowPlaybackClockControl = allow;
            _lastEffectivePlaybackClockMode = (SceneSyncPlaybackClockMode)(-1);
        }

        public void UseLocalPlaybackClock()
        {
            SetPlaybackClockMode(SceneSyncPlaybackClockMode.Local);
        }

        public void FollowSharedPlaybackClock()
        {
            SetPlaybackClockMode(SceneSyncPlaybackClockMode.SharedPlaybackFollow);
        }

        public void ControlSharedPlaybackClock()
        {
            SetPlaybackClockMode(SceneSyncPlaybackClockMode.SharedPlaybackControl);
        }

        public void UseRoomTimeClock()
        {
            SetPlaybackClockMode(SceneSyncPlaybackClockMode.RoomTime);
        }

        public SceneSyncPlaybackClockSample GetPlaybackClockSample(string objectId = null)
        {
            var currentTime = (double)Time.realtimeSinceStartup;
            var effectiveMode = GetEffectivePlaybackClockMode(currentTime);
            var activeTime = GetPlaybackClockTime(currentTime, effectiveMode);
            var managerDriven = UsesManagerDrivenPlaybackClock(effectiveMode);
            var objectAge = !string.IsNullOrWhiteSpace(objectId) && managerDriven
                ? GetObjectPlaybackRuntimeTime(objectId, activeTime, effectiveMode)
                : activeTime;
            var paused = effectiveMode == SceneSyncPlaybackClockMode.Local
                ? _localPlaybackPaused
                : (effectiveMode == SceneSyncPlaybackClockMode.RoomTime ? false : _sharedSceneClock.Paused);
            var rate = effectiveMode == SceneSyncPlaybackClockMode.Local
                ? _localPlaybackRate
                : (effectiveMode == SceneSyncPlaybackClockMode.RoomTime ? 1d : _sharedSceneClock.Rate);
            var synchronized = effectiveMode == SceneSyncPlaybackClockMode.RoomTime
                || effectiveMode == SceneSyncPlaybackClockMode.SharedPlaybackFollow
                || effectiveMode == SceneSyncPlaybackClockMode.SharedPlaybackControl;

            return new SceneSyncPlaybackClockSample(
                effectiveMode,
                activeTime,
                objectAge,
                GetRoomNow(currentTime),
                paused,
                rate,
                synchronized,
                managerDriven,
                synchronized ? _sharedSceneClock.ControllerId : null,
                _sharedSceneClockRevision);
        }

        public bool PausePlaybackClock()
        {
            var currentTime = (double)Time.realtimeSinceStartup;
            var effectiveMode = GetEffectivePlaybackClockMode(currentTime);
            if (effectiveMode == SceneSyncPlaybackClockMode.RoomTime
                || effectiveMode == SceneSyncPlaybackClockMode.SharedPlaybackFollow)
                return false;

            if (effectiveMode == SceneSyncPlaybackClockMode.SharedPlaybackControl)
            {
                if (_sharedSceneClock.Paused) return false;
                _sharedSceneClock = _sharedSceneClock.Pause(currentTime);
                BroadcastSharedPlaybackClock("pause", currentTime);
            }
            else
            {
                if (_localPlaybackPaused) return false;
                _localPlaybackAnchorTime = GetLocalPlaybackClockTime(currentTime);
                _localPlaybackAnchorMonotonic = currentTime;
                _localPlaybackPaused = true;
                _localPlaybackTransportControlled = true;
            }

            NotifyPlaybackClockChanged();
            return true;
        }

        public bool ResumePlaybackClock()
        {
            var currentTime = (double)Time.realtimeSinceStartup;
            var effectiveMode = GetEffectivePlaybackClockMode(currentTime);
            if (effectiveMode == SceneSyncPlaybackClockMode.RoomTime
                || effectiveMode == SceneSyncPlaybackClockMode.SharedPlaybackFollow)
                return false;

            if (effectiveMode == SceneSyncPlaybackClockMode.SharedPlaybackControl)
            {
                if (!_sharedSceneClock.Paused) return false;
                _sharedSceneClock = _sharedSceneClock.Resume(GetRoomNow(currentTime), currentTime);
                BroadcastSharedPlaybackClock("play", currentTime);
            }
            else
            {
                if (!_localPlaybackPaused) return false;
                _localPlaybackAnchorMonotonic = currentTime;
                _localPlaybackPaused = false;
                _localPlaybackTransportControlled = true;
            }

            NotifyPlaybackClockChanged();
            return true;
        }

        public bool SeekPlaybackClock(double targetTime)
        {
            return SeekPlaybackClockInternal(targetTime, "seek", resetObjectEpochs: false);
        }

        public bool ResetPlaybackClock()
        {
            return SeekPlaybackClockInternal(0d, "reset", resetObjectEpochs: true);
        }

        public bool SetPlaybackClockRate(double rate)
        {
            if (!SceneSyncPlaybackClockMath.IsFinite(rate) || rate < 0d) return false;

            var currentTime = (double)Time.realtimeSinceStartup;
            var effectiveMode = GetEffectivePlaybackClockMode(currentTime);
            if (effectiveMode == SceneSyncPlaybackClockMode.RoomTime
                || effectiveMode == SceneSyncPlaybackClockMode.SharedPlaybackFollow)
                return false;

            if (effectiveMode == SceneSyncPlaybackClockMode.SharedPlaybackControl)
            {
                _sharedSceneClock = _sharedSceneClock.WithRate(rate, GetRoomNow(currentTime), currentTime);
                BroadcastSharedPlaybackClock("rate", currentTime);
            }
            else
            {
                _localPlaybackAnchorTime = GetLocalPlaybackClockTime(currentTime);
                _localPlaybackAnchorMonotonic = currentTime;
                _localPlaybackRate = rate;
                _localPlaybackTransportControlled = true;
            }

            NotifyPlaybackClockChanged();
            return true;
        }

        public void ReleaseSharedPlaybackControl()
        {
            if (_playbackClockMode != SceneSyncPlaybackClockMode.SharedPlaybackControl) return;
            SetPlaybackClockMode(SceneSyncPlaybackClockMode.SharedPlaybackFollow);
        }

        private bool SeekPlaybackClockInternal(double targetTime, string action, bool resetObjectEpochs)
        {
            if (!SceneSyncPlaybackClockMath.IsFinite(targetTime)) return false;
            targetTime = Math.Max(0d, targetTime);

            var currentTime = (double)Time.realtimeSinceStartup;
            var effectiveMode = GetEffectivePlaybackClockMode(currentTime);
            if (effectiveMode == SceneSyncPlaybackClockMode.RoomTime
                || effectiveMode == SceneSyncPlaybackClockMode.SharedPlaybackFollow)
                return false;

            if (resetObjectEpochs)
            {
                _sharedObjectEpochTimes.Clear();
                _localObjectEpochTimes.Clear();
            }
            if (effectiveMode == SceneSyncPlaybackClockMode.SharedPlaybackControl)
            {
                _sharedSceneClock = _sharedSceneClock.Seek(targetTime, GetRoomNow(currentTime), currentTime);
                BroadcastSharedPlaybackClock(action, currentTime);
            }
            else
            {
                _localPlaybackAnchorTime = targetTime;
                _localPlaybackAnchorMonotonic = currentTime;
                _localPlaybackTransportControlled = true;
            }

            NotifyPlaybackClockChanged();
            return true;
        }

        private void NotifyPlaybackClockChanged()
        {
            OnPlaybackClockChanged?.Invoke(GetPlaybackClockSample());
        }

        private void Awake()
        {
            _client = new PresenceClientRuntime();
            _client.OnConnected += () =>
            {
                _connected = true;
                _lastAppliedPlaybackClockMode = (SceneSyncPlaybackClockMode)(-1);
                OnConnected?.Invoke();
                Debug.Log("[SceneSync] Connected");
            };
            _client.OnWelcomeReceived += (serverTimeMilliseconds) =>
            {
                if (!SceneSyncPlaybackClockMath.IsFinite(serverTimeMilliseconds)) return;
                _roomTimeAtWelcome = serverTimeMilliseconds / 1000d;
                _roomTimeWelcomeMonotonic = Time.realtimeSinceStartup;
            };
            _client.OnDisconnected += () =>
            {
                var disconnectTime = (double)Time.realtimeSinceStartup;
                var disconnectMode = GetEffectivePlaybackClockMode(disconnectTime);
                if (SceneSyncPlaybackClockMath.ShouldFallbackOnDisconnect(
                        _connected || _sharedSceneClock.Active,
                        _playbackClockMode,
                        disconnectMode))
                {
                    FallbackFromSharedPlayback(disconnectTime, "disconnect");
                }
                _connected = false;
                _sceneReceived = false;
                _firstPeersReceived = false;
                _sharedSceneClockRevision = 0;
                _peers = new List<PeerInfo>();
                OnDisconnected?.Invoke();
                Debug.Log("[SceneSync] Disconnected");
            };
            _client.OnPeersUpdated += (peers) =>
            {
                _peers = peers;
                OnPeersUpdated?.Invoke(_peers);

                var firstPeersUpdate = !_firstPeersReceived;
                _firstPeersReceived = true;
                ValidateSharedPlaybackController(Time.realtimeSinceStartup, "controller-disconnected");

                // 初回 peers 受信時にシーンリクエストを送信
                if (firstPeersUpdate && peers.Count > 0)
                {
                    if (!_sceneReceived)
                    {
                        _ = RequestSceneFromPeer();
                    }
                }
            };
            _client.OnHandoffReceived += OnHandoff;

            _lastTime = Time.realtimeSinceStartup;
            _localPlaybackAnchorMonotonic = _lastTime;
            _localPlaybackAnchorTime = 0d;
        }

        private void Start()
        {
            if (_autoConnect)
            {
                _ = Connect();
            }
        }

        private void OnEnable()
        {
            if (_isApplicationQuitting) return;

            SceneSyncMessageBus.MessageRequested += HandleSceneSyncOutgoingMessage;

            if (_isShuttingDown)
            {
                _isShuttingDown = false;
                Debug.Log("[SceneSync] Lifecycle reconnect: recovered from disable");

                if (_autoConnect)
                {
                    _ = Connect();
                }
            }
        }

        private void OnDisable()
        {
            SceneSyncMessageBus.MessageRequested -= HandleSceneSyncOutgoingMessage;
            BeginLifecycleDisconnect("OnDisable");
        }

        private void OnDestroy()
        {
            BeginLifecycleDisconnect("OnDestroy");
        }

        private void OnApplicationQuit()
        {
            _isApplicationQuitting = true;
            BeginLifecycleDisconnect("OnApplicationQuit");
        }

        private void BeginLifecycleDisconnect(string reason)
        {
            if (_isShuttingDown) return;
            _isShuttingDown = true;

            Debug.Log("[SceneSync] Lifecycle disconnect: reason=" + reason);

            _connected = false;
            _client?.Disconnect();
        }

        public async System.Threading.Tasks.Task Connect()
        {
            if (_isApplicationQuitting) return;

            _isShuttingDown = false;
            await _client.ConnectAsync(_presenceUrl, _room, _nickname);
        }

        public void Disconnect()
        {
            if (_isShuttingDown) return;

            Debug.Log("[SceneSync] User disconnect requested");
            ClearTemporaryObjects();
            _client?.Disconnect();
        }

        public void SelectObject(GameObject go)
        {
            _selectedObject = ResolveSceneSyncRoot(go);
        }

        public void DeselectObject()
        {
            _selectedObject = null;
        }

        public List<GameObject> GetManagedUnityObjects()
        {
            EnsureManagedObjectsList();

            var result = new List<GameObject>();
            var seen = new HashSet<GameObject>();

            void AddIfValid(GameObject go)
            {
                if (go == null) return;
                if (go == gameObject) return;
                if (IsTemporaryObject(go)) return;
                if (!seen.Add(go)) return;
                result.Add(go);
            }

            if (includeManagerChildren)
            {
                foreach (Transform child in transform)
                {
                    AddIfValid(child.gameObject);
                }
            }

            foreach (var go in managedObjects)
            {
                AddIfValid(go);
            }

            return result;
        }

        public bool AddManagedObject(GameObject go)
        {
            EnsureManagedObjectsList();
            if (go == null) return false;
            if (go == gameObject) return false;
            if (IsTemporaryObject(go)) return false;
            if (managedObjects.Contains(go)) return false;

            managedObjects.Add(go);
            return true;
        }

        public bool RemoveManagedObject(GameObject go)
        {
            EnsureManagedObjectsList();
            if (go == null) return false;

            var removed = false;
            for (var i = managedObjects.Count - 1; i >= 0; i--)
            {
                if (managedObjects[i] == go)
                {
                    managedObjects.RemoveAt(i);
                    removed = true;
                }
            }

            return removed;
        }

        public void RemoveNullManagedObjects()
        {
            EnsureManagedObjectsList();
            managedObjects.RemoveAll(item => item == null);
        }

        public int EnsureManagedUnityObjectIdentities()
        {
            var count = 0;

            foreach (var go in GetManagedUnityObjects())
            {
                if (EnsureUnityManagedIdentity(go) != null)
                {
                    count++;
                }
            }

            return count;
        }

        public SceneSyncIdentity EnsureUnityManagedIdentity(GameObject go)
        {
            if (go == null) return null;
            if (go == gameObject) return null;
            if (IsTemporaryObject(go)) return null;

            var identity = go.GetComponent<SceneSyncIdentity>();
            if (identity == null)
            {
                identity = go.AddComponent<SceneSyncIdentity>();
            }

            if (string.IsNullOrWhiteSpace(identity.ObjectId))
            {
                identity.ObjectId = GenerateUnityObjectId(go);
            }

            identity.Origin = SceneSyncOrigin.Unity;
            identity.Temporary = false;

            if (identity.State == SceneSyncState.Disconnected || identity.State == SceneSyncState.Error)
            {
                identity.State = SceneSyncState.Synced;
            }

            return identity;
        }

        public static SceneSyncIdentity FindSceneSyncIdentityInParents(GameObject go)
        {
            if (go == null) return null;
            return go.GetComponentInParent<SceneSyncIdentity>();
        }

        public static GameObject ResolveSceneSyncRoot(GameObject go)
        {
            if (go == null) return null;
            var identity = FindSceneSyncIdentityInParents(go);
            return identity != null ? identity.gameObject : go;
        }

        public SceneSyncIdentity ResolveIdentity(GameObject go)
        {
            return FindSceneSyncIdentityInParents(go);
        }

        public GameObject ResolveRoot(GameObject go)
        {
            return ResolveSceneSyncRoot(go);
        }

        public GameObject FindSceneSyncObject(string objectId)
        {
            return FindManagedObject(objectId);
        }

        public bool ValidateManagedObjects()
        {
            EnsureManagedObjectsList();

            var changed = false;
            var seen = new HashSet<GameObject>();

            for (var i = managedObjects.Count - 1; i >= 0; i--)
            {
                var go = managedObjects[i];

                if (go == null)
                {
                    continue;
                }

                if (go == gameObject || IsTemporaryObject(go) || !seen.Add(go))
                {
                    managedObjects.RemoveAt(i);
                    changed = true;
                }
            }

            return changed;
        }

        public async System.Threading.Tasks.Task SyncAllMeshes()
        {
            if (_isShuttingDown || !_connected) return;

            var rootObjects = GetAllSyncTargets();

            foreach (var go in rootObjects)
            {
                if (go.hideFlags != HideFlags.None) continue;
                if (go.GetComponentInChildren<MeshFilter>() == null
                    && go.GetComponentInChildren<SkinnedMeshRenderer>() == null)
                    continue;

                EnsureUnityManagedIdentity(go);

                var glb = await PresenceClientRuntime.ExportGameObjectAsGlb(go);
                if (glb == null) continue;

                var objectId = go.GetInstanceID().ToString();
                _remoteRemovedUnityObjectIds.Remove(objectId);

                // blob store に POST（全クライアント共有）
                var path = PresenceClientRuntime.GenerateRandomPath();
                var assetId = PresenceClientRuntime.ComputeAssetId(glb);
                var uploaded = await PresenceClientRuntime.UploadGlb(glb, GetBlobUrl(), path);
                if (!uploaded)
                {
                    Debug.LogWarning("[SceneSync] Skipping scene-mesh broadcast because GLB upload failed: objectId=" + objectId);
                    continue;
                }

                _meshPaths[objectId] = path;
                if (assetId != null)
                    _assetIdCache[assetId] = glb;
                if (path != null)
                    _meshPathCache[path] = glb;
                StorePersistentCachedGlb(glb, assetId, path);

                var assetIdJson = assetId != null ? ",\"assetId\":\"" + SceneSyncWireJson.JsonEscape(assetId) + "\"" : "";
                var payload = "{\"kind\":\"scene-mesh\",\"objectId\":\"" + SceneSyncWireJson.JsonEscape(objectId) + "\",\"name\":\"" + SceneSyncWireJson.JsonEscape(go.name) + "\",\"meshPath\":\"" + SceneSyncWireJson.JsonEscape(path) + "\"" +
                    ",\"origin\":\"unity\"" +
                    ",\"unityHierarchyPath\":\"" + SceneSyncWireJson.JsonEscape(SceneSyncWireJson.GetUnityHierarchyPath(go)) + "\"" +
                    assetIdJson +
                    ",\"asset\":" + SceneSyncWireJson.BuildMeshAssetJson(path, assetId, "unity") + "}";
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

        private string GetPipingServerBase()
        {
            // Derive Piping Server from presence URL
            // wss://afjk.jp/presence → https://pipe.afjk.jp
            // ws://localhost:8787 → http://localhost:8080
            var presenceScheme = _presenceUrl.StartsWith("wss://") ? "https://" : "http://";
            var presenceHost = _presenceUrl
                .Replace("wss://", "").Replace("ws://", "")
                .Split('/')[0];

            if (presenceHost == "localhost:8787" || presenceHost.StartsWith("localhost"))
                return "http://localhost:8080";

            // For afjk.jp, use pipe.afjk.jp
            return "https://pipe.afjk.jp";
        }

        private async System.Threading.Tasks.Task SendGlbToPeer(string targetPeerId, string filename, byte[] glbData)
        {
            if (string.IsNullOrEmpty(targetPeerId) || glbData == null || glbData.Length == 0)
            {
                Debug.LogWarning("[ExpiredGlbRecovery] Invalid arguments for SendGlbToPeer");
                return;
            }

            var path = PresenceClientRuntime.GenerateRandomPath();
            var pipingBase = GetPipingServerBase();
            var displayUrl = GetPipingDisplayUrl();

            // Send file info via handoff
            var fileInfo = "{\"kind\":\"file\",\"path\":\"" + path + "\",\"filename\":\"" + filename +
                "\",\"size\":" + glbData.Length + ",\"mime\":\"model/gltf-binary\",\"url\":\"" + displayUrl + "/#" + path + "\"}";

            Debug.Log("[ExpiredGlbRecovery] Sending file handoff: path=" + path + ", targetPeerId=" + targetPeerId);
            await _client.SendHandoff(targetPeerId, fileInfo);

            // Upload to Piping Server
            try
            {
                var url = pipingBase + "/" + path;
                Debug.Log("[ExpiredGlbRecovery] Uploading to Piping Server: " + url);

                var http = new HttpClient();
                var content = new ByteArrayContent(glbData);
                content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("model/gltf-binary");

                var response = await http.PostAsync(url, content);
                if (!response.IsSuccessStatusCode)
                {
                    Debug.LogWarning("[ExpiredGlbRecovery] Upload failed: status=" + (int)response.StatusCode);
                    throw new System.Exception("HTTP " + (int)response.StatusCode);
                }

                Debug.Log("[ExpiredGlbRecovery] File upload complete: " + path);
            }
            catch (System.Exception err)
            {
                Debug.LogWarning("[ExpiredGlbRecovery] File transfer failed: " + err);
                throw err;
            }
        }

        private string GetPipingDisplayUrl()
        {
            // Derive display URL from presence URL
            try
            {
                var presenceUrl = _presenceUrl
                    .Replace("wss://", "https://")
                    .Replace("ws://", "http://");

                var uri = new System.Uri(presenceUrl);

                if (uri.Host == "localhost" || uri.Host.StartsWith("localhost:"))
                    return "http://localhost";

                // For afjk.jp and other hosts, use https://<host>/pipe
                return "https://" + uri.Host + "/pipe";
            }
            catch
            {
                Debug.LogWarning("[SceneSync] Failed to parse Piping display URL from: " + _presenceUrl);
                return "https://pipe.afjk.jp";
            }
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
                    if (bytes == null || bytes.Length == 0 || bytes.Length > MAX_GLB_SIZE) continue;
                    TouchPersistentGlbCacheFile(path);
                    glbBytes = bytes;
                    source = candidate.Key;
                    if (!string.IsNullOrWhiteSpace(assetId))
                        _assetIdCache[assetId] = bytes;
                    if (!string.IsNullOrWhiteSpace(meshPath))
                        _meshPathCache[meshPath] = bytes;
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
            if (glbBytes == null || glbBytes.Length == 0 || glbBytes.Length > MAX_GLB_SIZE) return;
            if (glbBytes.LongLength > MAX_PERSISTENT_GLB_CACHE_BYTES) return;

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
                {
                    totalBytes += Math.Max(0L, file.Length);
                }

                foreach (var file in files)
                {
                    if (totalBytes <= MAX_PERSISTENT_GLB_CACHE_BYTES) break;

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

        private void Update()
        {
            if (_isShuttingDown || !gameObject.activeInHierarchy) return;

            var currentTime = Time.realtimeSinceStartup;
            var deltaTime = currentTime - _lastTime;
            _lastTime = currentTime;

            UpdatePlaybackClock(currentTime);

            if (!_connected) return;

            if (!_syncHierarchy) return;

            // ロック状態の更新
            string selectionId = null;
            if (_selectedObject != null)
            {
                if (_instanceToObjectId.TryGetValue(_selectedObject.GetInstanceID(), out var origId))
                    selectionId = origId;
                else if (IsSyncTarget(_selectedObject))
                    selectionId = _selectedObject.GetInstanceID().ToString();
            }

            if (selectionId != _currentlyLockedObjectId && _connected)
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
            if (_isShuttingDown || !_connected) return;
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
            if (_isShuttingDown || !_connected || !gameObject.activeInHierarchy) return;
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

                if (_remoteRemovedUnityObjectIds.Contains(id))
                {
                    continue;
                }

                if (!_knownObjectIds.Contains(id))
                {
                    // 新規オブジェクト
                    Debug.Log("[SceneSync] DetectHierarchyChanges: new object detected, publishing: objectId=" + id + ", name=" + go.name);
                    _ = SendSceneAdd(go);
                }
            }

            // Temporary root 配下の Web 由来オブジェクトも存在確認対象に含める
            var tempRoot = temporaryRoot != null ? temporaryRoot : GameObject.Find("SceneSync Temporary")?.transform;
            if (tempRoot != null)
            {
                foreach (Transform child in tempRoot)
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
                    Debug.Log("[SceneSync] DetectHierarchyChanges: object gone from hierarchy, sending scene-remove: objectId=" + id);
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
            if (go.transform.parent == null && go.name == "SceneSync Temporary") return false;
            return go.GetComponentInChildren<MeshFilter>() != null
                || go.GetComponentInChildren<SkinnedMeshRenderer>() != null;
        }

        private async System.Threading.Tasks.Task SendSceneAdd(GameObject go)
        {
            if (_isShuttingDown || !_connected) return;

            var sendObjectId = go.GetInstanceID().ToString();
            Debug.Log("[SceneSync] SendSceneAdd: objectId=" + sendObjectId + ", name=" + go.name
                + ", remoteRemoved=" + _remoteRemovedUnityObjectIds.Contains(sendObjectId)
                + ", known=" + _knownObjectIds.Contains(sendObjectId));
            _remoteRemovedUnityObjectIds.Remove(sendObjectId);
            EnsureUnityManagedIdentity(go);

            var pos = go.transform.position;
            var rot = go.transform.rotation;
            var scl = go.transform.localScale;

            byte[] glb = null;
            string path = null;
            string assetId = null;
            var hasMeshVisual = go.GetComponentInChildren<MeshFilter>() != null
                || go.GetComponentInChildren<SkinnedMeshRenderer>() != null;
            if (hasMeshVisual)
            {
                glb = await PresenceClientRuntime.ExportGameObjectAsGlb(go);
                if (glb == null)
                {
                    Debug.LogWarning("[SceneSync] Skipping scene-add because GLB export failed: objectId=" + sendObjectId);
                    return;
                }
                else
                {
                    path = PresenceClientRuntime.GenerateRandomPath();
                    assetId = PresenceClientRuntime.ComputeAssetId(glb);
                }
            }

            // アップロードを先に完了させてから Broadcast する
            if (glb != null && path != null)
            {
                var objectIdStr = go.GetInstanceID().ToString();
                var uploaded = await PresenceClientRuntime.UploadGlb(glb, GetBlobUrl(), path);
                if (!uploaded)
                {
                    Debug.LogWarning("[SceneSync] Skipping scene-add because GLB upload failed: objectId=" + objectIdStr);
                    return;
                }
                else
                {
                    _meshPaths[objectIdStr] = path;
                    if (assetId != null)
                        _assetIdCache[assetId] = glb;
                    if (path != null)
                        _meshPathCache[path] = glb;
                }
            }

            if (_isShuttingDown || !_connected) return;

            var meshPathJson = path != null ? ",\"meshPath\":\"" + SceneSyncWireJson.JsonEscape(path) + "\"" : "";
            var assetIdJson = assetId != null ? ",\"assetId\":\"" + SceneSyncWireJson.JsonEscape(assetId) + "\"" : "";
            var assetJson = path != null
                ? ",\"asset\":" + SceneSyncWireJson.BuildMeshAssetJson(path, assetId, "unity")
                : "";
            var payload = "{\"kind\":\"scene-add\",\"objectId\":\"" + SceneSyncWireJson.JsonEscape(go.GetInstanceID().ToString()) + "\",\"name\":\"" + SceneSyncWireJson.JsonEscape(go.name) + "\"" +
                ",\"origin\":\"unity\"" +
                ",\"unityHierarchyPath\":\"" + SceneSyncWireJson.JsonEscape(SceneSyncWireJson.GetUnityHierarchyPath(go)) + "\"" +
                ",\"position\":[" + SceneSyncWireJson.FormatFloat(pos.x) + "," + SceneSyncWireJson.FormatFloat(pos.y) + "," + SceneSyncWireJson.FormatFloat(-pos.z) + "]" +
                ",\"rotation\":[" + SceneSyncWireJson.FormatFloat(rot.x) + "," + SceneSyncWireJson.FormatFloat(rot.y) + "," + SceneSyncWireJson.FormatFloat(-rot.z) + "," + SceneSyncWireJson.FormatFloat(-rot.w) + "]" +
                ",\"scale\":[" + SceneSyncWireJson.FormatFloat(scl.x) + "," + SceneSyncWireJson.FormatFloat(scl.y) + "," + SceneSyncWireJson.FormatFloat(scl.z) + "]" +
                meshPathJson + assetIdJson + assetJson + "}";
            await _client.Broadcast(payload);

            _knownObjectIds.Add(go.GetInstanceID().ToString());
            OnObjectAdded?.Invoke(go.GetInstanceID().ToString(), go);
        }

        private async System.Threading.Tasks.Task SendSceneRemove(string objectId)
        {
            if (_isShuttingDown || !_connected) return;

            var payload = "{\"kind\":\"scene-remove\",\"objectId\":\"" + objectId + "\"}";
            await _client.Broadcast(payload);
            OnObjectRemoved?.Invoke(objectId);
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
            else if (raw.Contains("\"kind\":\"scene-asset-request\""))
            {
                _ = HandleAssetRequest(raw, fromId);
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
            else if (raw.Contains("\"kind\":\"scene-clock\""))
            {
                HandleSceneClock(raw, fromId);
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
            else if (raw.Contains("\"kind\":\"file\""))
            {
                _ = HandleFileHandoff(fromId, raw);
            }
        }

        private void HandleSceneSyncOutgoingMessage(SceneSyncOutgoingMessage message)
        {
            if (_isShuttingDown || !_connected || _client == null || string.IsNullOrWhiteSpace(message.PayloadJson))
                return;

            if (message.IsHandoff)
                _ = _client.SendHandoff(message.TargetPeerId, message.PayloadJson);
            else
                _ = _client.Broadcast(message.PayloadJson);
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

        private async System.Threading.Tasks.Task HandleAssetRequest(string raw, string requesterPeerId)
        {
            if (string.IsNullOrEmpty(requesterPeerId))
            {
                Debug.Log("[ExpiredGlbRecovery] scene-asset-request without requesterPeerId");
                return;
            }

            var requestIdMatch = System.Text.RegularExpressions.Regex.Match(raw, "\"requestId\":\"([^\"]+)\"");
            var objectIdMatch = System.Text.RegularExpressions.Regex.Match(raw, "\"objectId\":\"([^\"]+)\"");
            if (!requestIdMatch.Success || !objectIdMatch.Success) return;

            var requestId = requestIdMatch.Groups[1].Value;
            var objectId = objectIdMatch.Groups[1].Value;

            Debug.Log("[ExpiredGlbRecovery] Received asset request: requestId=" + requestId + ", objectId=" + objectId +
                ", requesterPeerId=" + requesterPeerId);

            // Parse optional fields
            var assetIdMatch = System.Text.RegularExpressions.Regex.Match(raw, "\"assetId\":\"([^\"]+)\"");
            var meshPathMatch = System.Text.RegularExpressions.Regex.Match(raw, "\"meshPath\":\"([^\"]+)\"");
            var expectedSizeMatch = System.Text.RegularExpressions.Regex.Match(raw, "\"expectedSize\":(\\d+)");

            var assetId = assetIdMatch.Success ? assetIdMatch.Groups[1].Value : null;
            var meshPath = meshPathMatch.Success ? meshPathMatch.Groups[1].Value : null;
            int? expectedSize = expectedSizeMatch.Success ? int.Parse(expectedSizeMatch.Groups[1].Value) : null;

            var go = FindManagedObject(objectId);
            if (go == null)
            {
                Debug.Log("[ExpiredGlbRecovery] Object not found locally: " + objectId);
                return;
            }

            var cacheKey = assetId ?? meshPath;
            if (string.IsNullOrEmpty(cacheKey))
            {
                Debug.Log("[ExpiredGlbRecovery] No cacheKey for matching");
                return;
            }

            // Check cooldown
            var cooldownKey = cacheKey + "-" + requesterPeerId;
            if (_responderCooldowns.TryGetValue(cooldownKey, out var lastCooldown))
            {
                var timeSinceCooldown = (DateTime.UtcNow.Ticks / 10000.0) - lastCooldown;
                if (timeSinceCooldown < COOLDOWN_MS)
                {
                    Debug.Log("[ExpiredGlbRecovery] Cooldown active for " + cacheKey + " from " + requesterPeerId);
                    return;
                }
            }

            if (_activeOutgoingTransferId != null)
            {
                Debug.Log("[ExpiredGlbRecovery] Already transferring, skipping");
                return;
            }

            // Check cache
            byte[] cachedGlb = null;
            if (!string.IsNullOrEmpty(assetId) && _assetIdCache.TryGetValue(assetId, out var glbByAssetId))
                cachedGlb = glbByAssetId;
            else if (!string.IsNullOrEmpty(meshPath) && _meshPathCache.TryGetValue(meshPath, out var glbByMeshPath))
                cachedGlb = glbByMeshPath;
            else if (TryLoadPersistentCachedGlb(assetId, meshPath, out var persistentGlb, out var persistentSource))
            {
                Debug.Log("[ExpiredGlbRecovery] Using persistent cached GLB by " + persistentSource + ": " + cacheKey);
                cachedGlb = persistentGlb;
            }

            if (cachedGlb == null)
            {
                Debug.Log("[ExpiredGlbRecovery] Asset not in local cache: " + cacheKey);
                return;
            }

            if (cachedGlb.Length > MAX_GLB_SIZE)
            {
                Debug.LogWarning("[ExpiredGlbRecovery] Cached GLB too large, skipping");
                return;
            }

            _responderCooldowns[cooldownKey] = DateTime.UtcNow.Ticks / 10000.0;
            _activeOutgoingTransferId = requestId;

            try
            {
                var fileName = !string.IsNullOrEmpty(assetId) ? assetId + ".glb" : objectId + ".glb";
                Debug.Log("[ExpiredGlbRecovery] Sending GLB to peer: requestId=" + requestId +
                    ", requesterPeerId=" + requesterPeerId + ", fileName=" + fileName + ", size=" + cachedGlb.Length);

                await SendGlbToPeer(requesterPeerId, fileName, cachedGlb);
            }
            catch (System.Exception err)
            {
                Debug.LogWarning("[ExpiredGlbRecovery] Failed to send GLB: " + err);
            }
            finally
            {
                _activeOutgoingTransferId = null;
            }
        }

        private async System.Threading.Tasks.Task HandleFileHandoff(string fromPeerId, string raw)
        {
            // Parse file metadata
            var pathMatch = System.Text.RegularExpressions.Regex.Match(raw, "\"path\":\"([^\"]+)\"");
            var filenameMatch = System.Text.RegularExpressions.Regex.Match(raw, "\"filename\":\"([^\"]+)\"");
            var sizeMatch = System.Text.RegularExpressions.Regex.Match(raw, "\"size\":(\\d+)");
            var mimeMatch = System.Text.RegularExpressions.Regex.Match(raw, "\"mime\":\"([^\"]+)\"");

            if (!pathMatch.Success || !filenameMatch.Success || !sizeMatch.Success || !mimeMatch.Success)
                return;

            var path = pathMatch.Groups[1].Value;
            var filename = filenameMatch.Groups[1].Value;
            var size = int.Parse(sizeMatch.Groups[1].Value);
            var mime = mimeMatch.Groups[1].Value;

            Debug.Log("[ExpiredGlbRecovery] Receiving file from peer: fromPeerId=" + fromPeerId +
                ", filename=" + filename + ", size=" + size + ", mime=" + mime);

            // Check if we can accept this file
            if (!CanAcceptFileHandoff(fromPeerId, filename, size, mime))
            {
                Debug.Log("[ExpiredGlbRecovery] Not accepting file: no matching recovery");
                return;
            }

            try
            {
                // Fetch the file from Piping Server
                var pipingBase = GetPipingServerBase();
                var url = pipingBase + "/" + path;

                Debug.Log("[ExpiredGlbRecovery] Fetching file from Piping Server: " + url);
                var http = new HttpClient();
                var response = await http.GetAsync(url);

                if (!response.IsSuccessStatusCode)
                {
                    Debug.LogWarning("[ExpiredGlbRecovery] Failed to fetch file: status=" +
                        (int)response.StatusCode);
                    return;
                }

                var data = await response.Content.ReadAsByteArrayAsync();
                Debug.Log("[ExpiredGlbRecovery] File fetched: " + data.Length + " bytes");

                await HandleReceivedFile(fromPeerId, filename, data, mime);
            }
            catch (System.Exception err)
            {
                Debug.LogWarning("[ExpiredGlbRecovery] Failed to receive file: " + err);
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

            ApplyScenePhysicsMetadata(raw);

            var envId = SceneSyncWireJson.ExtractString(raw, "envId");
            if (!string.IsNullOrWhiteSpace(envId))
                _envId = envId;

            foreach (var entry in SceneSyncWireJson.ExtractObjectMapEntries(raw, "objects"))
            {
                ApplyObjectClockBaseline(entry.Key, entry.Value);
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

            SceneSyncLoomletBehaviour.SetSceneGraph(this, graphJson);
            Debug.Log("[SceneSync] Bound Loomlet scene graph");
        }

        private void HandleSceneGraphClear(string raw)
        {
            if (TryExtractGraphObjectScope(raw, out var objectId))
            {
                var go = FindManagedObject(objectId);
                SceneSyncLoomletBehaviour.ClearObjectGraph(go);
                _pendingObjectLoomGraphs.Remove(objectId);
                Debug.Log("[SceneSync] Cleared Loomlet object graph: objectId=" + objectId);
                return;
            }

            SceneSyncLoomletBehaviour.ClearSceneGraph(this);
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

            var sceneGraphJson = SceneSyncWireJson.ExtractRawObject(loomGraphsJson, "scene");
            if (!string.IsNullOrWhiteSpace(sceneGraphJson))
                SceneSyncLoomletBehaviour.SetSceneGraph(this, sceneGraphJson);

            foreach (var entry in SceneSyncWireJson.ExtractObjectMapEntries(loomGraphsJson, "objects"))
            {
                var go = FindManagedObject(entry.Key);
                ApplyOrQueueObjectLoomGraph(entry.Key, entry.Value, go);
            }
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

            SceneSyncLoomletBehaviour.SetObjectGraph(go, this, objectId, graphJson);
            _pendingObjectLoomGraphs.Remove(objectId);
            Debug.Log("[SceneSync] Bound Loomlet object graph: objectId=" + objectId);
        }

        private bool ApplyPendingObjectLoomGraph(string objectId, GameObject go)
        {
            if (go == null || string.IsNullOrWhiteSpace(objectId)) return false;
            if (!_pendingObjectLoomGraphs.TryGetValue(objectId, out var graphJson) ||
                string.IsNullOrWhiteSpace(graphJson))
                return false;

            SceneSyncLoomletBehaviour.SetObjectGraph(go, this, objectId, graphJson);
            _pendingObjectLoomGraphs.Remove(objectId);
            Debug.Log("[SceneSync] Bound pending Loomlet object graph: objectId=" + objectId);
            return true;
        }

        private static string GetObjectLoomGraphJson(GameObject go)
        {
            var runner = go != null ? go.GetComponent<SceneSyncLoomletBehaviour>() : null;
            return runner != null && !runner.SceneScope ? runner.GraphJson : null;
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

            SceneSyncLoomletBehaviour.SetObjectGraph(go, this, objectId, graphJson);
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

        private void HandleSceneClock(string raw, string fromId = null)
        {
            var payloadJson = ExtractSceneSyncPayloadJson(raw);
            var mode = SceneSyncWireJson.ExtractString(payloadJson, "mode") ?? "shared-playback";
            if (!string.Equals(mode, "shared-playback", StringComparison.OrdinalIgnoreCase))
                return;

            var currentTime = (double)Time.realtimeSinceStartup;
            var controllerId = GetSceneClockControllerId(payloadJson, fromId);
            var action = SceneSyncWireJson.ExtractString(payloadJson, "action");
            var controllerFieldClearsAuthority = SceneSyncWireJson.HasTopLevelField(payloadJson, "controller")
                && string.IsNullOrWhiteSpace(controllerId);
            var releasePayload = SceneSyncPlaybackClockMath.IsControllerReleaseAction(action)
                || controllerFieldClearsAuthority
                || (SceneSyncWireJson.HasTopLevelField(payloadJson, "active")
                    && !ReadTopLevelBool(payloadJson, "active", true));
            if (releasePayload && !SceneSyncPlaybackClockMath.CanApplyControllerRelease(
                    _sharedSceneClock.ControllerId,
                    fromId))
                return;

            var revisionValue = ReadTopLevelDouble(payloadJson, "revision", double.NaN);
            if (IsFinite(revisionValue))
            {
                var revision = Mathf.FloorToInt((float)revisionValue);
                var canonicalSelfEcho = IsLocalClientId(controllerId) || IsLocalClientId(fromId);
                if (!SceneSyncPlaybackClockMath.ShouldAcceptRevision(
                        _sharedSceneClockRevision,
                        revision,
                        canonicalSelfEcho))
                    return;
                _sharedSceneClockRevision = revision;
            }

            var previousEffectiveMode = GetEffectivePlaybackClockMode(currentTime);
            var previousDisplayedTime = GetPlaybackClockTime(currentTime, previousEffectiveMode);

            if (_playbackClockMode == SceneSyncPlaybackClockMode.SharedPlaybackControl)
            {
                if (!string.IsNullOrWhiteSpace(controllerId) && !IsLocalClientId(controllerId))
                {
                    _playbackClockMode = SceneSyncPlaybackClockMode.SharedPlaybackFollow;
                    _lastAppliedPlaybackClockMode = SceneSyncPlaybackClockMode.SharedPlaybackFollow;
                    Debug.Log("[SceneSync] Shared Playback control transferred to " + controllerId + "; switching to Follow");
                }
            }

            _sharedSceneClock = SceneClockState.Parse(
                payloadJson,
                _sharedSceneClock,
                currentTime,
                GetRoomNow(currentTime),
                controllerId);
            var parsedClockActive = _sharedSceneClock.Active;
            var parsedClockTime = _sharedSceneClock.GetTime(currentTime);
            if (SceneSyncPlaybackClockMath.ShouldRelinquishControl(
                    _playbackClockMode,
                    _sharedSceneClock.Active))
            {
                _playbackClockMode = SceneSyncPlaybackClockMode.SharedPlaybackFollow;
                _lastAppliedPlaybackClockMode = SceneSyncPlaybackClockMode.SharedPlaybackFollow;
            }
            if (SceneSyncPlaybackClockMath.ShouldResetObjectEpochs(action))
                _sharedObjectEpochTimes.Clear();
            ApplyObjectClockBaselines(payloadJson);
            ValidateSharedPlaybackController(currentTime, "scene-clock-invalid");

            var nextEffectiveMode = GetEffectivePlaybackClockMode(currentTime);
            if ((previousEffectiveMode == SceneSyncPlaybackClockMode.SharedPlaybackFollow
                 || previousEffectiveMode == SceneSyncPlaybackClockMode.SharedPlaybackControl)
                && nextEffectiveMode == SceneSyncPlaybackClockMode.Local
                && !parsedClockActive)
            {
                RebaseLocalPlaybackClock(
                    SceneSyncPlaybackClockMath.SelectFallbackRebaseTime(
                        parsedClockActive,
                        parsedClockTime,
                        previousDisplayedTime),
                    currentTime);
            }
            _lastEffectivePlaybackClockMode = (SceneSyncPlaybackClockMode)(-1);
            NotifyPlaybackClockChanged();
        }

        private string GetSceneClockControllerId(string payloadJson, string fromId)
        {
            var action = SceneSyncWireJson.ExtractString(payloadJson, "action");
            if (SceneSyncPlaybackClockMath.IsControllerReleaseAction(action)) return null;

            var hasControllerField = SceneSyncWireJson.HasTopLevelField(payloadJson, "controller");
            var controllerJson = SceneSyncWireJson.ExtractTopLevelRawObject(payloadJson, "controller");
            var controllerId = SceneSyncWireJson.ExtractString(controllerJson, "id");
            if (!string.IsNullOrWhiteSpace(controllerId)) return controllerId;

            if (hasControllerField) return null;

            return !string.IsNullOrWhiteSpace(fromId)
                && !string.Equals(fromId, "server", StringComparison.OrdinalIgnoreCase)
                ? fromId
                : null;
        }

        private bool IsLocalClientId(string clientId)
        {
            return !string.IsNullOrWhiteSpace(clientId)
                && _client != null
                && !string.IsNullOrWhiteSpace(_client.Id)
                && string.Equals(clientId, _client.Id, StringComparison.Ordinal);
        }

        private void ValidateSharedPlaybackController(double currentTime, string reason)
        {
            if (!_sharedSceneClock.Active) return;

            var controllerId = _sharedSceneClock.ControllerId;
            var leaseValid = _sharedSceneClock.IsLeaseValid(currentTime);
            var peerValid = !string.IsNullOrWhiteSpace(controllerId)
                && (IsLocalClientId(controllerId)
                    || !_firstPeersReceived
                    || _peers.Any(peer => peer != null
                        && string.Equals(peer.id, controllerId, StringComparison.Ordinal)));

            if (!leaseValid || !peerValid)
                FallbackFromSharedPlayback(currentTime, leaseValid ? reason : "controller-lease-expired");
        }

        private void FallbackFromSharedPlayback(double currentTime, string reason)
        {
            var displayedTime = _sharedSceneClock.Active
                ? _sharedSceneClock.GetTime(currentTime)
                : GetLocalPlaybackClockTime(currentTime);

            if (_playbackClockMode == SceneSyncPlaybackClockMode.SharedPlaybackControl)
            {
                _playbackClockMode = SceneSyncPlaybackClockMode.SharedPlaybackFollow;
                _lastAppliedPlaybackClockMode = SceneSyncPlaybackClockMode.SharedPlaybackFollow;
            }

            _sharedSceneClock = _sharedSceneClock.Deactivate();
            RebaseLocalPlaybackClock(displayedTime, currentTime);
            _lastEffectivePlaybackClockMode = (SceneSyncPlaybackClockMode)(-1);
            Debug.Log("[SceneSync] Shared Playback switched to continuous Local fallback: " + reason);
            NotifyPlaybackClockChanged();
        }

        private double GetRoomNow(double currentTime)
        {
            if (SceneSyncPlaybackClockMath.IsFinite(_roomTimeAtWelcome)
                && SceneSyncPlaybackClockMath.IsFinite(_roomTimeWelcomeMonotonic))
            {
                return SceneSyncPlaybackClockMath.GetAnchoredTime(
                    _roomTimeAtWelcome,
                    _roomTimeWelcomeMonotonic,
                    currentTime);
            }

            // A pre-serverTime presence implementation is still usable. Remote
            // clocks are anchored at receipt and never extrapolated from this wall clock.
            return GetUnixTimeSeconds();
        }

        private static string ExtractSceneSyncPayloadJson(string raw)
        {
            var payloadJson = SceneSyncWireJson.ExtractTopLevelRawObject(raw, "payload");
            return string.IsNullOrWhiteSpace(payloadJson) ? raw : payloadJson;
        }

        private void BroadcastSharedPlaybackClockIfNeeded(double currentTime)
        {
            var interval = Math.Max(0.05d, _sharedPlaybackClockBroadcastInterval);
            if (currentTime - _lastSharedPlaybackClockBroadcastAt < interval)
                return;

            BroadcastSharedPlaybackClock("mode", currentTime);
        }

        private void BroadcastSharedPlaybackClock(string action, double currentTime)
        {
            if (_client == null || !_client.IsConnected) return;
            if (string.IsNullOrWhiteSpace(_client.Id)) return;
            if (_playbackClockMode != SceneSyncPlaybackClockMode.SharedPlaybackControl) return;
            if (!AllowPlaybackClockControl) return;

            var revision = Math.Max(1, _sharedSceneClockRevision + 1);
            _sharedSceneClockRevision = revision;
            _lastSharedPlaybackClockBroadcastAt = currentTime;

            var roomNow = GetRoomNow(currentTime);
            _sharedSceneClock = _sharedSceneClock.Reanchor(roomNow, currentTime, _client.Id);
            var activeTime = _sharedSceneClock.GetTime(currentTime);
            var sentAt = Math.Round(roomNow * 1000d);

            var controllerId = _client.Id;
            var controllerName = string.IsNullOrWhiteSpace(_nickname) ? "Unity" : _nickname;
            var payload =
                "{\"kind\":\"scene-clock\"" +
                ",\"action\":\"" + SceneSyncWireJson.JsonEscape(action) + "\"" +
                ",\"mode\":\"shared-playback\"" +
                ",\"source\":\"room\"" +
                ",\"active\":true" +
                ",\"offset\":" + FormatDouble(_sharedSceneClock.Offset) +
                ",\"paused\":" + (_sharedSceneClock.Paused ? "true" : "false") +
                (_sharedSceneClock.Paused
                    ? ",\"pausedTime\":" + FormatDouble(_sharedSceneClock.GetTime(currentTime))
                    : "") +
                ",\"rate\":" + FormatDouble(_sharedSceneClock.Rate) +
                ",\"controller\":{\"id\":\"" + SceneSyncWireJson.JsonEscape(controllerId) +
                "\",\"nickname\":\"" + SceneSyncWireJson.JsonEscape(controllerName) + "\"}" +
                ",\"revision\":" + revision +
                ",\"roomNow\":" + FormatDouble(roomNow) +
                ",\"sentAt\":" + sentAt +
                (ShouldIncludeSharedObjectClockPayload(action)
                    ? ",\"time\":" + FormatDouble(activeTime) +
                      ",\"targetTime\":" + FormatDouble(activeTime) +
                      ",\"objectClocks\":" + BuildSharedObjectClockPayload(activeTime, updateEpochs: true)
                    : "") +
                "}";

            _ = _client.Broadcast(payload);
        }

        private void BroadcastSharedPlaybackControlRelease(double currentTime)
        {
            if (_client == null || !_client.IsConnected) return;
            if (string.IsNullOrWhiteSpace(_client.Id)) return;

            var revision = Math.Max(1, _sharedSceneClockRevision + 1);
            _sharedSceneClockRevision = revision;
            _lastSharedPlaybackClockBroadcastAt = currentTime;

            var roomNow = GetRoomNow(currentTime);
            _sharedSceneClock = _sharedSceneClock.Reanchor(roomNow, currentTime, _client.Id);
            var activeTime = _sharedSceneClock.GetTime(currentTime);
            var sentAt = Math.Round(roomNow * 1000d);

            var payload =
                "{\"kind\":\"scene-clock\"" +
                ",\"action\":\"controller-release\"" +
                ",\"mode\":\"shared-playback\"" +
                ",\"source\":\"room\"" +
                ",\"active\":false" +
                ",\"offset\":" + FormatDouble(_sharedSceneClock.Offset) +
                ",\"paused\":" + (_sharedSceneClock.Paused ? "true" : "false") +
                (_sharedSceneClock.Paused
                    ? ",\"pausedTime\":" + FormatDouble(activeTime)
                    : "") +
                ",\"rate\":" + FormatDouble(_sharedSceneClock.Rate) +
                ",\"controller\":null" +
                ",\"revision\":" + revision +
                ",\"roomNow\":" + FormatDouble(roomNow) +
                ",\"sentAt\":" + sentAt +
                "}";

            _ = _client.Broadcast(payload);
            _sharedSceneClock = _sharedSceneClock.Deactivate();
            RebaseLocalPlaybackClock(activeTime, currentTime);
        }

        private static bool ShouldIncludeSharedObjectClockPayload(string action)
        {
            return string.Equals(action, "mode", StringComparison.OrdinalIgnoreCase)
                || string.Equals(action, "controller", StringComparison.OrdinalIgnoreCase)
                || string.Equals(action, "reset", StringComparison.OrdinalIgnoreCase)
                || string.Equals(action, "tick", StringComparison.OrdinalIgnoreCase);
        }

        private string BuildSharedObjectClockPayload(double sharedEpochTime, bool updateEpochs)
        {
            var first = true;
            var result = "{";
            foreach (var objectId in _managedObjects.Keys)
            {
                if (string.IsNullOrWhiteSpace(objectId)) continue;
                if (updateEpochs && !_sharedObjectEpochTimes.ContainsKey(objectId))
                {
                    _sharedObjectEpochTimes[objectId] = sharedEpochTime;
                }

                var epoch = _sharedObjectEpochTimes.TryGetValue(objectId, out var existingEpoch)
                    ? existingEpoch
                    : sharedEpochTime;
                if (!first) result += ",";
                first = false;
                result += "\"" + SceneSyncWireJson.JsonEscape(objectId) +
                    "\":{\"sharedEpochTime\":" + FormatDouble(epoch) + "}";
            }
            result += "}";
            return result;
        }

        private void ApplyObjectClockBaselines(string raw)
        {
            foreach (var entry in SceneSyncWireJson.ExtractObjectMapEntries(raw, "objectClocks"))
            {
                ApplyObjectClockBaseline(entry.Key, entry.Value);
            }
        }

        private void ApplyObjectClockBaseline(string objectId, string objectJson)
        {
            if (string.IsNullOrWhiteSpace(objectId) || string.IsNullOrWhiteSpace(objectJson))
                return;

            var clockJson = SceneSyncWireJson.ExtractRawObject(objectJson, "clock");
            var sharedEpoch = ReadTopLevelDouble(
                !string.IsNullOrWhiteSpace(clockJson) ? clockJson : objectJson,
                "sharedEpochTime",
                double.NaN);
            if (!IsFinite(sharedEpoch))
            {
                sharedEpoch = ReadTopLevelDouble(
                    !string.IsNullOrWhiteSpace(clockJson) ? clockJson : objectJson,
                    "sharedEpoch",
                    double.NaN);
            }

            if (IsFinite(sharedEpoch))
            {
                _sharedObjectEpochTimes[objectId] = sharedEpoch;
            }
        }

        private void ApplyScenePhysicsMetadata(string raw)
        {
            if (!SceneSyncWireJson.HasTopLevelField(raw, "physics")) return;

            var physicsJson = SceneSyncWireJson.ExtractTopLevelRawValue(raw, "physics");
            var metadata = GetComponent<SceneSyncPhysicsMetadata>();
            if (metadata == null) metadata = gameObject.AddComponent<SceneSyncPhysicsMetadata>();
            metadata.ConfigureScenePhysics(physicsJson);
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
                if (metadata != null) metadata.ClearObjectPhysics();
                return;
            }

            if (metadata == null) metadata = go.AddComponent<SceneSyncPhysicsMetadata>();
            metadata.ConfigureObjectPhysics(physicsJson);
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
                }
            }

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
                _localObjectEpochTimes.Remove(objectId);
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
                        EnsureLocalObjectEpoch(objectId);
                        return r;
                    }
                }
            }

            // Web 由来の objectId ("web-xxxxx") は _managedObjects にのみ存在
            return null;
        }

        private void EnsureLocalObjectEpoch(string objectId)
        {
            if (string.IsNullOrWhiteSpace(objectId) || _localObjectEpochTimes.ContainsKey(objectId))
                return;
            _localObjectEpochTimes[objectId] = GetLocalPlaybackClockTime(Time.realtimeSinceStartup);
        }

        private GameObject ResolveUnityOriginObject(string objectId, string name, string unityHierarchyPath)
        {
            var candidates = GetAllSyncTargets();

            foreach (var candidate in candidates)
            {
                if (candidate == null || IsTemporaryObject(candidate)) continue;
                var identity = candidate.GetComponent<SceneSyncIdentity>();
                if (identity == null) continue;
                if (identity.Origin != SceneSyncOrigin.Unity) continue;
                if (identity.Temporary) continue;
                if (identity.ObjectId == objectId) return candidate;
            }

            if (int.TryParse(objectId, out var instanceId))
            {
                foreach (var candidate in candidates)
                {
                    if (candidate != null && candidate.GetInstanceID() == instanceId && !IsTemporaryObject(candidate))
                        return candidate;
                }
            }

            if (!string.IsNullOrWhiteSpace(unityHierarchyPath))
            {
                GameObject match = null;
                foreach (var candidate in candidates)
                {
                    if (candidate == null || IsTemporaryObject(candidate)) continue;
                    if (SceneSyncWireJson.GetUnityHierarchyPath(candidate) != unityHierarchyPath) continue;
                    if (match != null) return null;
                    match = candidate;
                }
                if (match != null) return match;
            }

            if (!string.IsNullOrWhiteSpace(name))
            {
                GameObject match = null;
                foreach (var candidate in candidates)
                {
                    if (candidate == null || IsTemporaryObject(candidate)) continue;
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
            EnsureLocalObjectEpoch(objectId);
            _knownObjectIds.Add(objectId);
            _instanceToObjectId[go.GetInstanceID()] = objectId;
            _remoteRemovedUnityObjectIds.Remove(objectId);
            ApplyPendingObjectLoomGraph(objectId, go);
            OnObjectAdded?.Invoke(objectId, go);
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

        private void HandleSceneAdd(string raw)
        {
            var objectIdMatch = System.Text.RegularExpressions.Regex.Match(
                raw, "\"objectId\":\"([^\"]+)\"");
            if (!objectIdMatch.Success) return;
            var objectId = objectIdMatch.Groups[1].Value;
            var hasPhysics = SceneSyncWireJson.HasTopLevelField(raw, "physics");
            var physicsJson = hasPhysics ? ExtractObjectPhysicsJson(raw) : null;
            ApplyObjectClockBaseline(objectId, raw);

            // 既に存在する場合はスキップ
            if (_managedObjects.ContainsKey(objectId))
            {
                var existing = _managedObjects[objectId];
                if (hasPhysics)
                    ApplyObjectPhysicsMetadata(existing, physicsJson);
                Debug.Log("[SceneSync] scene-add received: objectId=" + objectId
                    + " → already managed (name=" + (existing != null ? existing.name : "null")
                    + ", unityAuthored=" + (existing != null && IsUnityAuthoredObject(existing, objectId))
                    + ", temporary=" + (existing != null && IsTemporaryObject(existing)) + "), skipping");
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

            // Unity 由来の objectId は整数（InstanceID）。
            // ローカルにその instanceId を持つ GO があれば自分自身のブロードキャストなので
            // リモート temporary を作らずそのまま登録して返す。
            if (int.TryParse(objectId, out var parsedInstanceId))
            {
                foreach (var candidate in GetAllSyncTargets())
                {
                    if (candidate.GetInstanceID() == parsedInstanceId && !IsTemporaryObject(candidate))
                    {
                        _managedObjects[objectId] = candidate;
                        EnsureLocalObjectEpoch(objectId);
                        _knownObjectIds.Add(objectId);
                        if (hasPhysics)
                            ApplyObjectPhysicsMetadata(candidate, physicsJson);
                        ApplyPendingObjectLoomGraph(objectId, candidate);
                        Debug.Log("[SceneSync] scene-add received for own Unity-authored object; skipping remote creation: " + objectId);
                        return;
                    }
                }
            }

            var assetType = SceneSyncWireJson.GetAssetType(assetJson);
            var hasMeshAsset = !string.IsNullOrEmpty(meshPath)
                || (assetType == "mesh"
                    && SceneSyncWireJson.GetAssetSource(assetJson) == "url"
                    && !string.IsNullOrEmpty(SceneSyncWireJson.GetAssetUrl(assetJson)));

            // メッシュがある場合は glB をダウンロードしてインポート
            if (hasMeshAsset)
            {
                Debug.Log("[SceneSync] scene-add: creating remote temporary for objectId=" + objectId + ", meshPath=" + meshPath);
                // プレースホルダーを先行登録（同期フェーズで登録を確実にする）
                var placeholder = new GameObject(objectId);
                placeholder.hideFlags = HideFlags.NotEditable;
                ConfigureRemoteTemporaryIdentity(placeholder, objectId, meshPath, assetId);
                SceneSyncPanelFactory.ConfigureWireMetadata(placeholder, assetJson, metadataJson);
                ApplyObjectPhysicsMetadata(placeholder, physicsJson);
                ApplyMetadataBehaviorGraph(placeholder, objectId, metadataJson);
                if (visible.HasValue) placeholder.SetActive(visible.Value);
                placeholder.transform.SetParent(GetOrCreateTemporaryRoot(), worldPositionStays: false);

                _managedObjects[objectId] = placeholder;
                EnsureLocalObjectEpoch(objectId);
                _knownObjectIds.Add(objectId);
                _instanceToObjectId[placeholder.GetInstanceID()] = objectId;

                // 非同期でダウンロード・インポート開始
                _ = DownloadAndCreateObject(objectId, name, meshPath, position, rotation, scale, assetId, visualBasis, assetJson, metadataJson, visible, physicsJson);
            }
            else
            {
                Debug.Log("[SceneSync] scene-add: assetType=" + assetType + " (no meshPath) → panel/primitive object for objectId=" + objectId);

                var go = SceneSyncPanelFactory.CreateObjectForAsset(name, assetJson, metadataJson);
                ConfigureRemoteTemporaryIdentity(go, objectId, meshPath, assetId);
                ApplyObjectPhysicsMetadata(go, physicsJson);
                ApplyMetadataBehaviorGraph(go, objectId, metadataJson);
                if (visible.HasValue) go.SetActive(visible.Value);
                go.transform.SetParent(GetOrCreateTemporaryRoot(), worldPositionStays: false);

                _managedObjects[objectId] = go;
                EnsureLocalObjectEpoch(objectId);
                _knownObjectIds.Add(objectId);
                _instanceToObjectId[go.GetInstanceID()] = objectId;

                // 位置・回転・スケールを設定
                ApplyTransform(go, position, rotation, scale);
                ApplyPendingObjectLoomGraph(objectId, go);

                OnObjectAdded?.Invoke(objectId, go);
            }
        }

        private void HandleSceneRemove(string raw)
        {
            var objectIdMatch = System.Text.RegularExpressions.Regex.Match(raw, "\"objectId\":\"([^\"]+)\"");
            if (!objectIdMatch.Success) return;
            var objectId = objectIdMatch.Groups[1].Value;
            _pendingObjectLoomGraphs.Remove(objectId);

            var go = FindManagedObject(objectId);

            Debug.Log(
                "[SceneSync] scene-remove received: objectId=" + objectId
                + ", found=" + (go != null)
                + ", unityAuthored=" + (go != null && IsUnityAuthoredObject(go, objectId))
                + ", temporary=" + (go != null && IsTemporaryObject(go)));

            if (go != null && IsUnityAuthoredObject(go, objectId))
            {
                RestoreUnityAuthoredObjectAfterRemoteRemove(objectId, go);
            }
            else
            {
                ForgetObject(objectId, go);
                if (go != null)
                {
                    Debug.Log("[SceneSync] Remote removed temporary object; destroying local object: " + objectId);
                    Destroy(go);
                }
            }

            OnObjectRemoved?.Invoke(objectId);
        }

        private bool IsUnityAuthoredObject(GameObject go, string objectId)
        {
            if (go == null) return false;

            var identity = go.GetComponent<SceneSyncIdentity>();
            if (identity != null)
            {
                if (identity.Origin == SceneSyncOrigin.Unity && !identity.Temporary)
                    return true;
            }

            // Fallback: Unity-authored objects use Unity InstanceID as objectId.
            return int.TryParse(objectId, out var instanceId)
                && go.GetInstanceID() == instanceId
                && !IsTemporaryObject(go);
        }

        private void RestoreUnityAuthoredObjectAfterRemoteRemove(string objectId, GameObject go)
        {
            ForgetObject(objectId, go);

            var identity = go.GetComponent<SceneSyncIdentity>();
            if (identity != null)
            {
                identity.State = SceneSyncState.Disconnected;
                identity.Temporary = false;
                identity.Origin = SceneSyncOrigin.Unity;
                identity.MeshPath = null;
                identity.AssetId = null;
                identity.LockOwner = null;
            }

            _lastSnapshots.Remove(objectId);
            _meshPaths.Remove(objectId);
            _locks.Remove(objectId);
            _remoteRemovedUnityObjectIds.Add(objectId);

            Debug.Log("[SceneSync] Remote removed Unity-authored object; restored to unpublished state: " + objectId);
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
                + ", unityAuthored=" + (go != null && IsUnityAuthoredObject(go, objectId))
                + ", temporary=" + (go != null && IsTemporaryObject(go)));

            if (go != null && IsUnityAuthoredObject(go, objectId))
            {
                _meshPaths[objectId] = meshPath;

                var identity = go.GetComponent<SceneSyncIdentity>();
                if (identity != null)
                {
                    identity.Origin = SceneSyncOrigin.Unity;
                    identity.Temporary = false;
                    identity.State = SceneSyncState.Synced;
                    identity.MeshPath = meshPath;
                    identity.AssetId = assetId;
                }
                SceneSyncPanelFactory.ConfigureWireMetadata(go, assetJson, metadataJson);
                if (hasPhysics)
                    ApplyObjectPhysicsMetadata(go, physicsJson);
                ApplyMetadataBehaviorGraph(go, objectId, metadataJson);

                _managedObjects[objectId] = go;
                EnsureLocalObjectEpoch(objectId);
                _knownObjectIds.Add(objectId);
                _remoteRemovedUnityObjectIds.Remove(objectId);

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
                Destroy(go);

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

        private static Dictionary<string, SceneSyncInitialPhysicsPose> CollectInitialPhysicsPoses()
        {
            var poses = new Dictionary<string, SceneSyncInitialPhysicsPose>(StringComparer.Ordinal);
            foreach (var behaviour in FindObjectsByType<MonoBehaviour>(FindObjectsSortMode.None))
            {
                if (!(behaviour is ISceneSyncInitialPhysicsPoseProvider provider)) continue;
                try
                {
                    provider.TryGetInitialPhysicsPoses(poses);
                }
                catch (Exception error)
                {
                    Debug.LogWarning("[SceneSync] Failed to read initial physics poses: " + error.Message);
                }
            }
            return poses;
        }

        private static void ApplyInitialPhysicsPoseIfPresent(
            Dictionary<string, SceneSyncInitialPhysicsPose> initialPhysicsPoses,
            string objectId,
            ref Vector3 position,
            ref Quaternion rotation)
        {
            if (initialPhysicsPoses == null ||
                string.IsNullOrWhiteSpace(objectId) ||
                !initialPhysicsPoses.TryGetValue(objectId, out var pose))
            {
                return;
            }

            position = pose.Position;
            rotation = pose.Rotation;
        }

        private async System.Threading.Tasks.Task HandleSceneRequest(string fromId)
        {
            Debug.Log("[SceneSync] Responding to scene-request for: " + fromId);

            var rootObjects = GetAllSyncTargets();
            var initialPhysicsPoses = CollectInitialPhysicsPoses();

            var objectsJson = new System.Text.StringBuilder();
            objectsJson.Append("{");
            bool first = true;
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
                var isUnityVisualBasis = identity == null || identity.Origin == SceneSyncOrigin.Unity;
                Debug.Log($"[SceneSync] scene-state include: source=rootObjects objectId={objectId} name={go.name} origin={originStr} temporary={temporaryStr} visualBasis={(isUnityVisualBasis ? "unity" : "none")}");

                var pos = go.transform.position;
                var rot = go.transform.rotation;
                var scl = go.transform.localScale;
                ApplyInitialPhysicsPoseIfPresent(initialPhysicsPoses, objectId, ref pos, ref rot);

                // 保存済み meshPath を優先使用
                string path = null;
                string assetId = null;
                if (_meshPaths.TryGetValue(objectId, out var savedPath))
                {
                    path = savedPath;
                    // Try to find assetId if cached
                    if (_meshPathCache.ContainsKey(path))
                    {
                        var glbData = _meshPathCache[path];
                        assetId = PresenceClientRuntime.ComputeAssetId(glbData);
                    }
                }
                else if (go.GetComponentInChildren<MeshFilter>() != null
                    || go.GetComponentInChildren<SkinnedMeshRenderer>() != null)
                {
                    var glb = await PresenceClientRuntime.ExportGameObjectAsGlb(go);
                    if (glb == null)
                    {
                        Debug.LogWarning(
                            "[SceneSync] scene-state skipped because GLB export failed: objectId=" +
                            objectId + ", name=" + go.name);
                        continue;
                    }
                    else
                    {
                        path = PresenceClientRuntime.GenerateRandomPath();
                        assetId = PresenceClientRuntime.ComputeAssetId(glb);
                        var uploaded = await PresenceClientRuntime.UploadGlb(glb, GetBlobUrl(), path);
                        if (!uploaded)
                        {
                            Debug.LogWarning(
                                "[SceneSync] scene-state skipped because GLB upload failed: objectId=" +
                                objectId + ", name=" + go.name);
                            continue;
                        }
                        _meshPaths[objectId] = path;
                        if (assetId != null)
                            _assetIdCache[assetId] = glb;
                        _meshPathCache[path] = glb;
                    }
                }

                if (!first) objectsJson.Append(",");
                first = false;
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

                var originStr2 = identity != null ? identity.Origin.ToString() : "None";
                var temporaryStr2 = identity != null ? identity.Temporary.ToString() : "None";
                var isUnityVisualBasis = identity == null || identity.Origin == SceneSyncOrigin.Unity;
                Debug.Log($"[SceneSync] scene-state include: source=managedObjects objectId={kvp.Key} name={go.name} origin={originStr2} temporary={temporaryStr2} visualBasis={(isUnityVisualBasis ? "unity" : "none")}");

                var pos = go.transform.position;
                var rot = go.transform.rotation;
                var scl = go.transform.localScale;
                ApplyInitialPhysicsPoseIfPresent(initialPhysicsPoses, kvp.Key, ref pos, ref rot);

                string path = null;
                _meshPaths.TryGetValue(kvp.Key, out path);

                string assetId = null;
                if (path != null && _meshPathCache.TryGetValue(path, out var glbData))
                {
                    assetId = PresenceClientRuntime.ComputeAssetId(glbData);
                }

                if (!first) objectsJson.Append(",");
                first = false;
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
                objectsJson.Append(SceneSyncWireJson.BuildObjectJson(
                    kvp.Key,
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
                sceneStateObjectCount++;
            }

            objectsJson.Append("}");

            Debug.Log($"[SceneSync] Building scene-state. count={sceneStateObjectCount}");

            // handoff で 1対1 返信（broadcast ではない）
            var envJson = !string.IsNullOrWhiteSpace(_envId)
                ? ",\"envId\":\"" + SceneSyncWireJson.JsonEscape(_envId) + "\""
                : "";
            var scenePhysics = GetComponent<SceneSyncPhysicsMetadata>();
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
            var sceneGraph = GetComponent<SceneSyncLoomletBehaviour>();
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

        private Material GetFallbackImportMaterial()
        {
            if (_fallbackImportMaterial != null)
                return _fallbackImportMaterial;

            if (_runtimeFallbackImportMaterial != null)
                return _runtimeFallbackImportMaterial;

            Shader shader = null;
            if (UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline == null)
            {
                shader = Shader.Find("Standard");
            }
            else
            {
                shader = Shader.Find("Universal Render Pipeline/Lit");
                if (shader == null)
                    shader = Shader.Find("URP/Lit");
            }
            if (shader == null)
                shader = Shader.Find("Standard");

            if (shader == null)
            {
                Debug.LogWarning("[SceneSync] Fallback material creation failed: no compatible shader found.");
                return null;
            }

            _runtimeFallbackImportMaterial = new Material(shader)
            {
                name = "SceneSync Fallback Import Material"
            };

            return _runtimeFallbackImportMaterial;
        }

        private int ApplyFallbackMaterialToRenderers(GameObject target, bool replaceAll, string reason)
        {
            if (target == null)
                return 0;

            var fallbackMaterial = GetFallbackImportMaterial();
            if (fallbackMaterial == null)
                return 0;

            var replacements = 0;
            var renderers = target.GetComponentsInChildren<Renderer>(true);
            foreach (var renderer in renderers)
            {
                var materials = renderer.sharedMaterials;
                if (materials == null || materials.Length == 0)
                {
                    renderer.sharedMaterial = fallbackMaterial;
                    replacements++;
                    continue;
                }

                var changed = false;
                for (var index = 0; index < materials.Length; index++)
                {
                    var material = materials[index];
                    var isBroken = material == null
                        || material.shader == null
                        || material.shader.name == "Hidden/InternalErrorShader";

                    if (replaceAll || isBroken)
                    {
                        materials[index] = fallbackMaterial;
                        replacements++;
                        changed = true;
                    }
                }

                if (changed)
                    renderer.sharedMaterials = materials;
            }

            if (replacements > 0)
            {
                Debug.Log(
                    "[SceneSync] Applied fallback material: target=" + DescribeGameObject(target)
                    + ", replaceAll=" + replaceAll
                    + ", replacements=" + replacements
                    + ", reason=" + reason
                    + ", fallbackShader=" + fallbackMaterial.shader.name);
            }

            return replacements;
        }

        private GameObject ReplaceWithFallbackPrimitive(
            string objectId,
            string name,
            string meshPath,
            float[] position,
            float[] rotation,
            float[] scale,
            string assetId = null,
            string assetJson = null,
            string metadataJson = null,
            bool? visible = null,
            string physicsJson = null)
        {
            var placeholder = _managedObjects[objectId];
            var placeholderInstanceId = placeholder.GetInstanceID();
            var placeholderGraphJson = GetObjectLoomGraphJson(placeholder);
            var effectivePhysicsJson = physicsJson ?? GetObjectPhysicsJson(placeholder);
            if (!string.IsNullOrWhiteSpace(placeholderGraphJson))
                _pendingObjectLoomGraphs[objectId] = placeholderGraphJson;

            var fallback = SceneSyncPanelFactory.CreateObjectForAsset(name, assetJson, metadataJson);
            ConfigureRemoteTemporaryIdentity(fallback, objectId, meshPath, assetId);
            if (effectivePhysicsJson != null)
                ApplyObjectPhysicsMetadata(fallback, effectivePhysicsJson);
            ApplyMetadataBehaviorGraph(fallback, objectId, metadataJson);
            if (visible.HasValue) fallback.SetActive(visible.Value);
            fallback.transform.SetParent(GetOrCreateTemporaryRoot(), worldPositionStays: false);

            var fallbackMaterial = GetFallbackImportMaterial();
            var fallbackRenderer = fallback.GetComponent<Renderer>();
            if (fallbackMaterial != null && fallbackRenderer != null)
                fallbackRenderer.sharedMaterial = fallbackMaterial;

            _instanceToObjectId.Remove(placeholderInstanceId);
            _instanceToObjectId[fallback.GetInstanceID()] = objectId;
            _managedObjects[objectId] = fallback;
            EnsureLocalObjectEpoch(objectId);

            ApplyTransform(fallback, position, rotation, scale);
            ApplyPendingObjectLoomGraph(objectId, fallback);

            Destroy(placeholder);
            return fallback;
        }

        /// <summary>
        /// KHR_gaussian_splatting GLB を Gaussian Splat バックエンドで読み込み、
        /// 通常 GLB と同じ Scene Sync オブジェクトとして配置する。
        /// 読み込めなかった場合は null を返す（呼び出し側が fallback primitive へ落とす）。
        /// </summary>
        private GameObject TryCreateGaussianSplatObject(
            string objectId,
            string name,
            byte[] glbBytes,
            SceneSyncGaussianSplatGlbInfo splatInfo,
            string meshPath,
            string assetId,
            string visualBasis,
            string assetJson,
            string metadataJson,
            float[] position,
            float[] rotation,
            float[] scale,
            bool? visible,
            string physicsJson)
        {
            Debug.Log(
                "[SceneSync] KHR_gaussian_splatting detected: objectId=" + objectId
                + ", meshPath=" + meshPath
                + ", " + splatInfo);

            if (splatInfo.HasRegularMeshPrimitive)
            {
                Debug.LogWarning(
                    "[SceneSync] Mixed mesh / Gaussian Splat GLB; only the splat primitives are rendered: objectId="
                    + objectId);
            }

            var visual = SceneSyncGaussianSplatBackend.CreateVisual(glbBytes, splatInfo);
            if (!visual.Ok)
            {
                Debug.LogWarning(
                    "[SceneSync] Gaussian Splat import failed: objectId=" + objectId
                    + ", meshPath=" + meshPath
                    + ", reason=" + visual.Reason);
                return null;
            }

            var placeholder = _managedObjects[objectId];
            var placeholderInstanceId = placeholder.GetInstanceID();
            var placeholderGraphJson = GetObjectLoomGraphJson(placeholder);
            var effectivePhysicsJson = physicsJson ?? GetObjectPhysicsJson(placeholder);
            if (!string.IsNullOrWhiteSpace(placeholderGraphJson))
                _pendingObjectLoomGraphs[objectId] = placeholderGraphJson;

            var go = new GameObject(name);
            ConfigureRemoteTemporaryIdentity(go, objectId, meshPath, assetId);
            SceneSyncPanelFactory.ConfigureWireMetadata(go, assetJson, metadataJson);
            if (effectivePhysicsJson != null)
                ApplyObjectPhysicsMetadata(go, effectivePhysicsJson);
            ApplyMetadataBehaviorGraph(go, objectId, metadataJson);
            if (visible.HasValue) go.SetActive(visible.Value);
            go.transform.SetParent(GetOrCreateTemporaryRoot(), worldPositionStays: false);

            // 通常 GLB と同じ ImportedGlbRoot 構造にそろえる。Gaussian Splat バックエンドも
            // glTFast と同じ規則で Unity 空間へ変換して返す約束なので、補正も同じでよい。
            var importedGlbRoot = new GameObject("ImportedGlbRoot");
            importedGlbRoot.transform.SetParent(go.transform, worldPositionStays: false);
            importedGlbRoot.transform.localPosition = Vector3.zero;
            importedGlbRoot.transform.localRotation = visualBasis != "unity"
                ? Quaternion.Euler(0f, 180f, 0f)
                : Quaternion.identity;
            importedGlbRoot.transform.localScale = Vector3.one;

            visual.Visual.transform.SetParent(importedGlbRoot.transform, worldPositionStays: false);

            // プレースホルダーのマッピングを新オブジェクトに移動
            _instanceToObjectId.Remove(placeholderInstanceId);
            _instanceToObjectId[go.GetInstanceID()] = objectId;
            _managedObjects[objectId] = go;
            EnsureLocalObjectEpoch(objectId);

            ApplyTransform(go, position, rotation, scale);
            ApplyPendingObjectLoomGraph(objectId, go);

            Destroy(placeholder);

            Debug.Log(
                "[SceneSync] Imported Gaussian Splat: name=" + name
                + ", objectId=" + objectId
                + ", meshPath=" + meshPath
                + ", source=" + visual.Source
                + ", backend=" + visual.BackendName
                + ", points=" + visual.PointCount);
            return go;
        }

        private async System.Threading.Tasks.Task DownloadAndCreateObject(
            string objectId, string name, string meshPath,
            float[] position, float[] rotation, float[] scale, string assetId = null, string visualBasis = null,
            string assetJson = null, string metadataJson = null, bool? visible = null, string physicsJson = null)
        {
            _knownObjectIds.Add(objectId);

            if (!string.IsNullOrEmpty(meshPath))
            {
                _meshPaths[objectId] = meshPath;
            }

            byte[] glbBytes = null;

            // Check cache first
            if (!string.IsNullOrEmpty(assetId) && _assetIdCache.TryGetValue(assetId, out var cachedByAssetId))
            {
                Debug.Log("[SceneSync] Using cached GLB by assetId: " + assetId);
                glbBytes = cachedByAssetId;
            }
            else if (!string.IsNullOrEmpty(meshPath) && _meshPathCache.TryGetValue(meshPath, out var cachedByMeshPath))
            {
                Debug.Log("[SceneSync] Using cached GLB by meshPath: " + meshPath);
                glbBytes = cachedByMeshPath;
            }
            else if (TryLoadPersistentCachedGlb(assetId, meshPath, out var persistentGlb, out var persistentSource))
            {
                Debug.Log("[SceneSync] Using persistent cached GLB by " + persistentSource + ": " +
                    (persistentSource == "assetId" ? assetId : meshPath));
                glbBytes = persistentGlb;
            }

            // Download if not in cache
            if (glbBytes == null)
            {
                var assetUrl = SceneSyncWireJson.GetAssetSource(assetJson) == "url"
                    ? SceneSyncWireJson.GetAssetUrl(assetJson)
                    : null;
                var url = !string.IsNullOrWhiteSpace(assetUrl)
                    ? assetUrl
                    : GetBlobUrl() + "/" + meshPath;
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

                    // Trigger recovery on 404
                    if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
                    {
                        Debug.Log("[SceneSync] Blob expired, attempting recovery");
                        HandleMissingGlb(objectId, meshPath, null, assetId);
                    }

                    var fallback = ReplaceWithFallbackPrimitive(objectId, name, meshPath, position, rotation, scale, assetId, assetJson, metadataJson, visible, physicsJson);
                    OnObjectAdded?.Invoke(objectId, fallback);
                    return;
                }

                glbBytes = await response.Content.ReadAsByteArrayAsync();

                // Cache the downloaded GLB
                if (!string.IsNullOrEmpty(assetId))
                    _assetIdCache[assetId] = glbBytes;
                if (!string.IsNullOrEmpty(meshPath))
                    _meshPathCache[meshPath] = glbBytes;
                StorePersistentCachedGlb(glbBytes, assetId, meshPath);
            }

            // Scene Sync の 3DGS 交換形式は KHR_gaussian_splatting GLB。
            // glTFast はこの拡張を知らないため、Gaussian Splat primitive を含む GLB は
            // 専用バックエンドへ振り分ける。通常 GLB は従来どおり glTFast へ。
            SceneSyncGaussianSplatGlbInfo gaussianSplatInfo;
            if (SceneSyncGaussianSplatBackend.IsGaussianSplatGlb(glbBytes, out gaussianSplatInfo))
            {
                if (!_managedObjects.ContainsKey(objectId))
                {
                    // ダウンロード中にオブジェクトが消えた場合。何もしないのが正しい。
                    Debug.LogWarning(
                        "[SceneSync] Gaussian Splat GLB arrived for an object that is no longer managed: objectId="
                        + objectId);
                    return;
                }

                var splatObject = TryCreateGaussianSplatObject(
                    objectId, name, glbBytes, gaussianSplatInfo, meshPath, assetId, visualBasis,
                    assetJson, metadataJson, position, rotation, scale, visible, physicsJson);
                if (splatObject == null)
                {
                    splatObject = ReplaceWithFallbackPrimitive(
                        objectId, name, meshPath, position, rotation, scale, assetId, assetJson,
                        metadataJson, visible, physicsJson);
                }

                OnObjectAdded?.Invoke(objectId, splatObject);
                return;
            }

            try
            {
                var tempFileName = !string.IsNullOrEmpty(meshPath) ? meshPath : objectId;
                var tempPath = System.IO.Path.Combine(
                    Application.temporaryCachePath, tempFileName + ".glb");
                System.IO.File.WriteAllBytes(tempPath, glbBytes);

                Debug.Log(
                    "[SceneSync] Mesh bytes saved: bytes=" + glbBytes.Length
                    + ", tempPath=" + tempPath
                    + ", fileExists=" + System.IO.File.Exists(tempPath));

                // Runtime 用: フレーム時間を考慮した非同期読み込み
                var deferAgent = gameObject.AddComponent<TimeBudgetPerFrameDeferAgent>();
                var importSettings = new ImportSettings
                {
                    // glTFast runtime Mecanim import creates clips and an Animator, but no
                    // runtime AnimatorController. Legacy attaches clips to an Animation
                    // component, which Scene Sync can immediately play for remote GLBs.
                    AnimationMethod = AnimationMethod.Legacy,
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
                    var placeholderGraphJson = GetObjectLoomGraphJson(placeholder);
                    var effectivePhysicsJson = physicsJson ?? GetObjectPhysicsJson(placeholder);
                    if (!string.IsNullOrWhiteSpace(placeholderGraphJson))
                        _pendingObjectLoomGraphs[objectId] = placeholderGraphJson;

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

                    // Scene Sync stores object rotation in wire space.
                    // GLB assets are authored in glTF/Web space, but Unity imports them into Unity space.
                    // Keep the synchronized object transform on the parent and apply this asset-local
                    // correction only to the imported visual root.
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

                    // プレースホルダーのマッピングを新オブジェクトに移動
                    _instanceToObjectId.Remove(placeholderInstanceId);
                    _instanceToObjectId[go.GetInstanceID()] = objectId;
                    _managedObjects[objectId] = go;
                    EnsureLocalObjectEpoch(objectId);

                    Debug.Log(
                        "[SceneSync] Instantiating glTF main scene: parent=" + DescribeGameObject(importedGlbRoot)
                        + ", placeholder=" + DescribeGameObject(placeholder));
                    await gltf.InstantiateMainSceneAsync(importedGlbRoot.transform);
                    ApplyFallbackMaterialToRenderers(go, replaceAll: false, reason: "post-import broken materials");
                    PlayImportedAnimations(go);

                    // 位置・回転・スケールを設定
                    ApplyTransform(go, position, rotation, scale);
                    ApplyPendingObjectLoomGraph(objectId, go);

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
                    var fallback = ReplaceWithFallbackPrimitive(objectId, name, meshPath, position, rotation, scale, assetId, assetJson, metadataJson, visible, physicsJson);
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

                if (_managedObjects.TryGetValue(objectId, out var currentObject) && currentObject != null)
                {
                    var replacements = ApplyFallbackMaterialToRenderers(
                        currentObject,
                        replaceAll: true,
                        reason: "exception during import");

                    if (replacements > 0)
                    {
                        currentObject.transform.SetParent(GetOrCreateTemporaryRoot(), worldPositionStays: false);
                        if (physicsJson != null)
                            ApplyObjectPhysicsMetadata(currentObject, physicsJson);
                        ApplyTransform(currentObject, position, rotation, scale);

                        OnObjectAdded?.Invoke(objectId, currentObject);
                        return;
                    }
                }

                if (_managedObjects.ContainsKey(objectId))
                {
                    var fallback = ReplaceWithFallbackPrimitive(objectId, name, meshPath, position, rotation, scale, assetId, assetJson, metadataJson, visible, physicsJson);
                    OnObjectAdded?.Invoke(objectId, fallback);
                    return;
                }

                if (!_managedObjects.ContainsKey(objectId))
                    _knownObjectIds.Remove(objectId);
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
        }

        private void PlayImportedAnimations(GameObject go)
        {
            if (go == null) return;

            var effectiveMode = GetEffectivePlaybackClockMode(Time.realtimeSinceStartup);
            if (UsesManagerDrivenPlaybackClock(effectiveMode))
            {
                var identity = go.GetComponent<SceneSyncIdentity>();
                var objectId = identity != null ? identity.ObjectId : null;
                var activeTime = GetPlaybackClockTime(Time.realtimeSinceStartup, effectiveMode);
                SampleImportedAnimations(go, GetObjectPlaybackRuntimeTime(objectId, activeTime, effectiveMode));
                return;
            }

            PlayImportedAnimationsLocally(go);
        }

        private bool UsesSharedPlaybackClock()
        {
            var mode = GetEffectivePlaybackClockMode(Time.realtimeSinceStartup);
            return mode == SceneSyncPlaybackClockMode.SharedPlaybackFollow
                || mode == SceneSyncPlaybackClockMode.SharedPlaybackControl;
        }

        private bool UsesSharedObjectEpochClock(SceneSyncPlaybackClockMode effectiveMode)
        {
            return UsesSharedObjectEpochClock(_playbackClockMode, effectiveMode);
        }

        private bool UsesSharedObjectEpochClock(
            SceneSyncPlaybackClockMode requestedMode,
            SceneSyncPlaybackClockMode effectiveMode)
        {
            return effectiveMode != SceneSyncPlaybackClockMode.Local
                || _playbackClockFollowPolicy != SceneSyncPlaybackClockFollowPolicy.Manual
                || requestedMode == SceneSyncPlaybackClockMode.SharedPlaybackFollow;
        }

        private void UpdatePlaybackClock(double currentTime)
        {
            if (_lastAppliedPlaybackClockMode != _playbackClockMode)
            {
                ApplyPlaybackClockModeChange(currentTime, _lastAppliedPlaybackClockMode);
            }

            ValidateSharedPlaybackController(currentTime, "controller-unavailable");

            var effectiveMode = GetEffectivePlaybackClockMode(currentTime);
            if (_lastEffectivePlaybackClockMode != effectiveMode)
            {
                var previousEffectiveMode = _lastEffectivePlaybackClockMode;
                _lastEffectivePlaybackClockMode = effectiveMode;
                if (effectiveMode == SceneSyncPlaybackClockMode.Local
                    && previousEffectiveMode != (SceneSyncPlaybackClockMode)(-1)
                    && !UsesManagerDrivenPlaybackClock(effectiveMode))
                {
                    PlayAllRemoteImportedAnimationsLocally();
                }
                NotifyPlaybackClockChanged();
            }

            if (effectiveMode == SceneSyncPlaybackClockMode.SharedPlaybackControl)
            {
                BroadcastSharedPlaybackClockIfNeeded(currentTime);
            }

            if (UsesManagerDrivenPlaybackClock(effectiveMode))
            {
                SampleAllRemoteImportedAnimations(GetPlaybackClockTime(currentTime, effectiveMode), effectiveMode);
            }
        }

        private void ApplyPlaybackClockModeChange(double currentTime, SceneSyncPlaybackClockMode previousMode)
        {
            var hasPreviousMode = previousMode != (SceneSyncPlaybackClockMode)(-1);
            var previousEffectiveMode = hasPreviousMode
                ? GetEffectivePlaybackClockMode(previousMode, currentTime)
                : SceneSyncPlaybackClockMode.Local;
            var previousActiveTime = hasPreviousMode
                ? GetPlaybackClockTime(currentTime, previousEffectiveMode)
                : 0d;
            var previousObjectAges = hasPreviousMode
                ? CaptureObjectAges(previousActiveTime, previousMode, previousEffectiveMode)
                : null;
            var resetForFreshSharedControl = _playbackClockMode == SceneSyncPlaybackClockMode.SharedPlaybackControl
                && previousEffectiveMode != SceneSyncPlaybackClockMode.SharedPlaybackFollow
                && previousEffectiveMode != SceneSyncPlaybackClockMode.SharedPlaybackControl;

            _lastAppliedPlaybackClockMode = _playbackClockMode;

            if (previousMode == SceneSyncPlaybackClockMode.SharedPlaybackControl
                && _playbackClockMode != SceneSyncPlaybackClockMode.SharedPlaybackControl)
            {
                BroadcastSharedPlaybackControlRelease(currentTime);
            }

            if (hasPreviousMode
                && previousEffectiveMode != SceneSyncPlaybackClockMode.Local
                && _playbackClockMode == SceneSyncPlaybackClockMode.Local)
            {
                // Keep using the manager clock after a synchronized-domain exit
                // so Animation/Loomlet preserve the visible ObjectAge.
                _localPlaybackTransportControlled = true;
            }

            if (_playbackClockMode == SceneSyncPlaybackClockMode.SharedPlaybackControl)
            {
                var roomNow = GetRoomNow(currentTime);
                var startTime = SceneSyncPlaybackClockMath.GetSharedControlStartTime(
                    previousEffectiveMode,
                    previousActiveTime);
                _sharedSceneClock = SceneClockState.CreateController(
                    startTime,
                    roomNow,
                    currentTime,
                    _client != null ? _client.Id : null);
                _lastSharedPlaybackClockBroadcastAt = double.NegativeInfinity;
                if (resetForFreshSharedControl)
                    _sharedObjectEpochTimes.Clear();
                BroadcastSharedPlaybackClock("controller", currentTime);
            }
            else if (_playbackClockMode == SceneSyncPlaybackClockMode.Local)
            {
                if (_playbackClockFollowPolicy == SceneSyncPlaybackClockFollowPolicy.Manual
                    && !_localPlaybackTransportControlled)
                {
                    PlayAllRemoteImportedAnimationsLocally();
                }
            }

            if (hasPreviousMode && previousObjectAges != null && !resetForFreshSharedControl)
            {
                var nextEffectiveMode = GetEffectivePlaybackClockMode(_playbackClockMode, currentTime);
                var nextActiveTime = GetPlaybackClockTime(currentTime, nextEffectiveMode);
                RebaseObjectEpochsPreservingAges(
                    previousObjectAges,
                    nextActiveTime,
                    _playbackClockMode,
                    nextEffectiveMode);
            }

            _lastEffectivePlaybackClockMode = (SceneSyncPlaybackClockMode)(-1);
            NotifyPlaybackClockChanged();
        }

        private double GetPlaybackClockTime(double currentTime)
        {
            return GetPlaybackClockTime(currentTime, GetEffectivePlaybackClockMode(currentTime));
        }

        private double GetPlaybackClockTime(double currentTime, SceneSyncPlaybackClockMode effectiveMode)
        {
            if (effectiveMode == SceneSyncPlaybackClockMode.SharedPlaybackControl
                || effectiveMode == SceneSyncPlaybackClockMode.SharedPlaybackFollow)
            {
                return _sharedSceneClock.GetTime(currentTime);
            }

            if (effectiveMode == SceneSyncPlaybackClockMode.RoomTime)
                return GetRoomNow(currentTime);

            return GetLocalPlaybackClockTime(currentTime);
        }

        private SceneSyncPlaybackClockMode GetEffectivePlaybackClockMode(double currentTime)
        {
            return GetEffectivePlaybackClockMode(_playbackClockMode, currentTime);
        }

        private SceneSyncPlaybackClockMode GetEffectivePlaybackClockMode(
            SceneSyncPlaybackClockMode requestedMode,
            double currentTime)
        {
            return SceneSyncPlaybackClockMath.ResolveEffectiveMode(
                requestedMode,
                _playbackClockFollowPolicy,
                _allowPlaybackClockControl,
                HasValidRemotePlaybackController(currentTime));
        }

        private Dictionary<string, double> CaptureObjectAges(
            double activeTime,
            SceneSyncPlaybackClockMode requestedMode,
            SceneSyncPlaybackClockMode effectiveMode)
        {
            var useSharedEpoch = UsesSharedObjectEpochClock(requestedMode, effectiveMode);
            var source = useSharedEpoch ? _sharedObjectEpochTimes : _localObjectEpochTimes;
            var objectIds = new HashSet<string>(_managedObjects.Keys);
            objectIds.UnionWith(_sharedObjectEpochTimes.Keys);
            objectIds.UnionWith(_localObjectEpochTimes.Keys);
            var ages = new Dictionary<string, double>();

            foreach (var objectId in objectIds)
            {
                if (string.IsNullOrWhiteSpace(objectId)) continue;
                if (!source.TryGetValue(objectId, out var epoch) || !IsFinite(epoch))
                {
                    epoch = activeTime;
                    source[objectId] = epoch;
                }
                ages[objectId] = SceneSyncPlaybackClockMath.GetObjectAge(activeTime, epoch);
            }
            return ages;
        }

        private void RebaseObjectEpochsPreservingAges(
            Dictionary<string, double> previousObjectAges,
            double nextActiveTime,
            SceneSyncPlaybackClockMode requestedMode,
            SceneSyncPlaybackClockMode effectiveMode)
        {
            var target = UsesSharedObjectEpochClock(requestedMode, effectiveMode)
                ? _sharedObjectEpochTimes
                : _localObjectEpochTimes;
            foreach (var entry in previousObjectAges)
            {
                target[entry.Key] = nextActiveTime - Math.Max(0d, entry.Value);
            }
        }

        private bool HasValidRemotePlaybackController(double currentTime)
        {
            if (!_sharedSceneClock.Active
                || string.IsNullOrWhiteSpace(_sharedSceneClock.ControllerId)
                || IsLocalClientId(_sharedSceneClock.ControllerId)
                || !_sharedSceneClock.IsLeaseValid(currentTime))
                return false;

            return !_firstPeersReceived || _peers.Any(peer => peer != null
                && string.Equals(peer.id, _sharedSceneClock.ControllerId, StringComparison.Ordinal));
        }

        private bool UsesManagerDrivenPlaybackClock(SceneSyncPlaybackClockMode effectiveMode)
        {
            return effectiveMode != SceneSyncPlaybackClockMode.Local
                || _localPlaybackTransportControlled
                || _playbackClockFollowPolicy != SceneSyncPlaybackClockFollowPolicy.Manual
                || _playbackClockMode == SceneSyncPlaybackClockMode.SharedPlaybackFollow;
        }

        private double GetLocalPlaybackClockTime(double currentTime)
        {
            if (_localPlaybackPaused) return SceneSyncPlaybackClockMath.ClampTime(_localPlaybackAnchorTime);
            return SceneSyncPlaybackClockMath.ClampTime(
                _localPlaybackAnchorTime
                + Math.Max(0d, currentTime - _localPlaybackAnchorMonotonic) * _localPlaybackRate);
        }

        private void RebaseLocalPlaybackClock(double activeTime, double currentTime)
        {
            _localPlaybackAnchorTime = SceneSyncPlaybackClockMath.ClampTime(activeTime);
            _localPlaybackAnchorMonotonic = currentTime;
            _localPlaybackRate = 1d;
            _localPlaybackPaused = false;
        }

        private void PlayAllRemoteImportedAnimationsLocally()
        {
            foreach (var go in GetRemoteManagedObjects())
            {
                PlayImportedAnimationsLocally(go);
            }
        }

        private void SampleAllRemoteImportedAnimations(double time, SceneSyncPlaybackClockMode effectiveMode)
        {
            foreach (var entry in GetRemoteManagedObjectEntries())
            {
                SampleImportedAnimations(entry.Value, GetObjectPlaybackRuntimeTime(entry.Key, time, effectiveMode));
            }
        }

        private IEnumerable<GameObject> GetRemoteManagedObjects()
        {
            foreach (var entry in GetRemoteManagedObjectEntries())
            {
                yield return entry.Value;
            }
        }

        private IEnumerable<KeyValuePair<string, GameObject>> GetRemoteManagedObjectEntries()
        {
            foreach (var entry in _managedObjects)
            {
                var go = entry.Value;
                if (go == null) continue;
                if (!IsTemporaryObject(go)) continue;
                yield return entry;
            }
        }

        private double GetObjectPlaybackRuntimeTime(
            string objectId,
            double activeTime,
            SceneSyncPlaybackClockMode effectiveMode)
        {
            if (!string.IsNullOrWhiteSpace(objectId))
            {
                var epochs = UsesSharedObjectEpochClock(effectiveMode)
                    ? _sharedObjectEpochTimes
                    : _localObjectEpochTimes;
                if (epochs.TryGetValue(objectId, out var epoch) && IsFinite(epoch))
                {
                    return SceneSyncPlaybackClockMath.GetObjectAge(activeTime, epoch);
                }

                epochs[objectId] = activeTime;
                return 0d;
            }

            return Math.Max(0d, activeTime);
        }

        private static void PlayImportedAnimationsLocally(GameObject go)
        {
            if (go == null) return;

            foreach (var animator in go.GetComponentsInChildren<Animator>(true))
            {
                animator.enabled = true;
                if (animator.runtimeAnimatorController != null)
                    animator.Play(0, 0, 0f);
            }

            foreach (var animation in go.GetComponentsInChildren<Animation>(true))
            {
                animation.enabled = true;
                animation.playAutomatically = true;
                animation.cullingType = AnimationCullingType.AlwaysAnimate;
                foreach (AnimationState state in animation)
                {
                    if (state != null) state.speed = 1f;
                }
                animation.Play();
            }
        }

        private static void SampleImportedAnimations(GameObject go, double time)
        {
            if (go == null) return;

            foreach (var animator in go.GetComponentsInChildren<Animator>(true))
            {
                animator.enabled = false;
            }

            foreach (var animation in go.GetComponentsInChildren<Animation>(true))
            {
                SampleAnimation(animation, time);
            }
        }

        private static void SampleAnimation(Animation animation, double time)
        {
            if (animation == null) return;

            var primary = GetPrimaryAnimationState(animation);
            if (primary == null) return;

            animation.enabled = true;
            animation.playAutomatically = false;
            animation.cullingType = AnimationCullingType.AlwaysAnimate;
            if (animation.clip == null && primary.clip != null)
            {
                animation.clip = primary.clip;
            }

            var clipName = primary.clip != null ? primary.clip.name : null;
            if (!string.IsNullOrEmpty(clipName) && animation.GetClip(clipName) != null)
            {
                animation.Play(clipName);
            }
            else
            {
                animation.Play();
            }

            foreach (AnimationState state in animation)
            {
                if (state == null) continue;
                var isPrimary = state == primary;
                state.enabled = isPrimary;
                state.weight = isPrimary ? 1f : 0f;
                state.speed = 0f;
            }

            var wrappedTime = WrapAnimationTime(time, primary.length);
            primary.time = wrappedTime;
            if (primary.clip != null)
                primary.clip.SampleAnimation(animation.gameObject, wrappedTime);
            else
                animation.Sample();
        }

        private static AnimationState GetPrimaryAnimationState(Animation animation)
        {
            if (animation == null) return null;
            if (animation.clip != null)
            {
                var state = animation[animation.clip.name];
                if (state != null) return state;
            }

            foreach (AnimationState state in animation)
            {
                if (state != null) return state;
            }

            return null;
        }

        private static float WrapAnimationTime(double time, float length)
        {
            if (length <= 0f) return 0f;
            var wrapped = time % length;
            if (wrapped < 0d) wrapped += length;
            return (float)wrapped;
        }

        private void EnsureManagedObjectsList()
        {
            if (managedObjects == null)
            {
                managedObjects = new List<GameObject>();
            }
        }

        private static string GenerateUnityObjectId(GameObject go)
        {
            var namePart = SanitizeObjectIdPart(go != null ? go.name : "unity-object");
            var randomPart = Guid.NewGuid().ToString("N").Substring(0, 8);
            return string.IsNullOrEmpty(namePart)
                ? "unity-" + randomPart
                : namePart + "-" + randomPart;
        }

        private static string SanitizeObjectIdPart(string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return "unity-object";

            var builder = new System.Text.StringBuilder(value.Length);

            foreach (var c in value.ToLowerInvariant())
            {
                if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))
                {
                    builder.Append(c);
                }
                else if (c == '-' || c == '_' || c == ' ')
                {
                    builder.Append('-');
                }
            }

            var result = builder.ToString().Trim('-');

            while (result.Contains("--"))
            {
                result = result.Replace("--", "-");
            }

            return string.IsNullOrEmpty(result) ? "unity-object" : result;
        }

        private bool IsTemporaryObject(GameObject go)
        {
            if (go == null) return false;

            var identity = go.GetComponent<SceneSyncIdentity>();
            if (identity != null && identity.Temporary) return true;

            var root = temporaryRoot != null ? temporaryRoot : GameObject.Find("SceneSync Temporary")?.transform;
            if (root == null) return false;

            return go == root.gameObject || go.transform.IsChildOf(root);
        }

        private Transform GetOrCreateTemporaryRoot()
        {
            if (temporaryRoot != null)
            {
                return temporaryRoot;
            }

            var existing = GameObject.Find("SceneSync Temporary");
            if (existing != null)
            {
                temporaryRoot = existing.transform;
                return temporaryRoot;
            }

            var go = new GameObject("SceneSync Temporary");
            go.transform.SetPositionAndRotation(Vector3.zero, Quaternion.identity);
            go.transform.localScale = Vector3.one;
            temporaryRoot = go.transform;
            return temporaryRoot;
        }

        private void ClearTemporaryObjects()
        {
            var root = temporaryRoot != null ? temporaryRoot : GameObject.Find("SceneSync Temporary")?.transform;
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
        }

        private List<PeerInfo> GetOtherPeers()
        {
            var result = new List<PeerInfo>();
            if (_peers == null) return result;
            foreach (var peer in _peers)
            {
                if (peer.id != _client?.Id)
                    result.Add(peer);
            }
            return result;
        }

        private void HandleMissingGlb(string objectId, string meshPath, int? expectedSize, string assetId)
        {
            var requestId = DateTime.Now.Ticks.ToString() + "-" + UnityEngine.Random.Range(0, 1000000).ToString("D6");

            Debug.Log("[ExpiredGlbRecovery] Missing GLB detected: objectId=" + objectId + ", meshPath=" + meshPath +
                ", assetId=" + assetId + ", requestId=" + requestId);

            var recovery = new ExpiredGlbRecovery
            {
                requestId = requestId,
                objectId = objectId,
                assetId = assetId,
                meshPath = meshPath,
                expectedSize = expectedSize,
                requestedAt = DateTime.UtcNow.Ticks / 10000.0,
                requestedPeerIds = new HashSet<string>()
            };

            _pendingRecoveries[requestId] = recovery;

            var peers = GetOtherPeers();
            if (peers.Count == 0)
            {
                Debug.Log("[ExpiredGlbRecovery] No other peers available");
                _ = RemoveRecoveryAfterTimeout(requestId);
                return;
            }

            var peerIndex = 0;
            System.Action<System.Action> scheduleNextPeer = null;
            scheduleNextPeer = (onComplete) =>
            {
                if (!_pendingRecoveries.ContainsKey(requestId))
                {
                    onComplete?.Invoke();
                    return;
                }

                if (peerIndex >= peers.Count)
                {
                    Debug.Log("[ExpiredGlbRecovery] All peers requested for requestId: " + requestId +
                        "; waiting for file handoff or timeout");
                    onComplete?.Invoke();
                    return;
                }

                var peer = peers[peerIndex];
                peerIndex++;

                if (_pendingRecoveries.TryGetValue(requestId, out var rec))
                    rec.requestedPeerIds.Add(peer.id);

                Debug.Log("[ExpiredGlbRecovery] Sending request to peer " + (peerIndex - 1) + ": " + peer.id);
                var request = "{\"kind\":\"scene-asset-request\",\"requestId\":\"" + requestId +
                    "\",\"objectId\":\"" + objectId +
                    "\",\"assetId\":" + (assetId != null ? "\"" + assetId + "\"" : "null") +
                    ",\"meshPath\":" + (meshPath != null ? "\"" + meshPath + "\"" : "null") +
                    ",\"expectedSize\":" + (expectedSize.HasValue ? expectedSize.Value.ToString() : "null") + "}";
                _ = _client.SendHandoff(peer.id, request);

                // Schedule next peer retry after PEER_RETRY_INTERVAL_MS
                _ = System.Threading.Tasks.Task.Delay((int)PEER_RETRY_INTERVAL_MS).ContinueWith(_ =>
                {
                    scheduleNextPeer(onComplete);
                });
            };

            scheduleNextPeer(null);

            // Overall timeout
            _ = RemoveRecoveryAfterTimeout(requestId);
        }

        private async System.Threading.Tasks.Task RemoveRecoveryAfterTimeout(string requestId)
        {
            await System.Threading.Tasks.Task.Delay((int)RECOVERY_TIMEOUT_MS);
            if (_pendingRecoveries.ContainsKey(requestId))
            {
                Debug.Log("[ExpiredGlbRecovery] Recovery timeout for requestId: " + requestId);
                _pendingRecoveries.Remove(requestId);
            }
        }

        private bool CanAcceptFileHandoff(string fromPeerId, string filename, int size, string mime)
        {
            if (string.IsNullOrEmpty(fromPeerId) || string.IsNullOrEmpty(filename) || size <= 0 || string.IsNullOrEmpty(mime))
                return false;

            var isGlb = mime == "model/gltf-binary" || filename.ToLower().EndsWith(".glb");
            if (!isGlb) return false;

            // Find matching pending recovery
            foreach (var kvp in _pendingRecoveries)
            {
                var rec = kvp.Value;
                if (!rec.requestedPeerIds.Contains(fromPeerId))
                    continue;

                if (rec.expectedSize.HasValue && rec.expectedSize.Value != size)
                    continue;

                return true;
            }

            return false;
        }

        private ExpiredGlbRecovery FindMatchingRecovery(string fromPeerId, string filename, int size, string assetId = null)
        {
            ExpiredGlbRecovery fallback = null;

            foreach (var kvp in _pendingRecoveries)
            {
                var rec = kvp.Value;
                if (!rec.requestedPeerIds.Contains(fromPeerId))
                    continue;

                if (rec.expectedSize.HasValue && rec.expectedSize.Value != size)
                    continue;

                if (!string.IsNullOrEmpty(assetId) && !string.IsNullOrEmpty(rec.assetId))
                {
                    if (rec.assetId == assetId)
                        return rec;
                    continue;
                }

                if (!string.IsNullOrEmpty(rec.assetId) &&
                    !string.IsNullOrEmpty(filename) &&
                    filename.StartsWith(rec.assetId, StringComparison.Ordinal))
                {
                    return rec;
                }

                if (fallback == null)
                    fallback = rec;
            }

            return fallback;
        }

        private async System.Threading.Tasks.Task HandleReceivedFile(string fromPeerId, string filename, byte[] data, string mime)
        {
            if (data == null || data.Length == 0)
            {
                Debug.Log("[ExpiredGlbRecovery] File received but data is empty");
                return;
            }

            Debug.Log("[ExpiredGlbRecovery] File received from peer: fromPeerId=" + fromPeerId +
                ", filename=" + filename + ", size=" + data.Length);

            if (data.Length > MAX_GLB_SIZE)
            {
                Debug.LogWarning("[ExpiredGlbRecovery] Received file too large, ignoring");
                return;
            }

            var isGlb = mime == "model/gltf-binary" || filename.ToLower().EndsWith(".glb");
            if (!isGlb)
            {
                Debug.Log("[ExpiredGlbRecovery] File is not GLB, ignoring");
                return;
            }

            string computedAssetId = null;
            try
            {
                computedAssetId = PresenceClientRuntime.ComputeAssetId(data);
            }
            catch (Exception err)
            {
                Debug.LogWarning("[ExpiredGlbRecovery] Failed to compute asset ID: " + err);
            }

            var recovery = FindMatchingRecovery(fromPeerId, filename, data.Length, computedAssetId);
            if (recovery == null)
            {
                Debug.Log("[ExpiredGlbRecovery] No matching pending recovery for this file from requestedPeerIds");
                return;
            }

            Debug.Log("[ExpiredGlbRecovery] Matching recovered file to pending recovery: " + recovery.requestId);

            if (recovery.assetId != null)
            {
                if (string.IsNullOrEmpty(computedAssetId))
                {
                    Debug.LogWarning("[ExpiredGlbRecovery] Expected assetId but computation failed, ignoring file");
                    return;
                }

                if (recovery.assetId != computedAssetId)
                {
                    Debug.LogWarning("[ExpiredGlbRecovery] Asset ID mismatch, ignoring file. Expected: " + recovery.assetId +
                        ", got: " + computedAssetId);
                    return;
                }
            }

            _pendingRecoveries.Remove(recovery.requestId);

            try
            {
                // Cache the GLB bytes
                if (computedAssetId != null)
                    _assetIdCache[computedAssetId] = data;
                if (recovery.meshPath != null)
                    _meshPathCache[recovery.meshPath] = data;
                StorePersistentCachedGlb(data, computedAssetId ?? recovery.assetId, recovery.meshPath);

                Debug.Log("[ExpiredGlbRecovery] Loading recovered GLB into object: " + recovery.objectId);
                await LoadGlbFromBytes(recovery.objectId, data, computedAssetId ?? recovery.assetId);
                Debug.Log("[ExpiredGlbRecovery] Recovered GLB loaded successfully");
            }
            catch (Exception err)
            {
                Debug.LogWarning("[ExpiredGlbRecovery] Failed to load recovered GLB: " + err);
            }
        }

        private async System.Threading.Tasks.Task LoadGlbFromBytes(string objectId, byte[] glbBytes, string assetId = null)
        {
            var go = FindManagedObject(objectId);
            if (go == null)
            {
                Debug.LogWarning("[ExpiredGlbRecovery] Object not found: " + objectId);
                return;
            }

            var name = go.name;
            var pos = go.transform.position;
            var rot = go.transform.rotation;
            var scl = go.transform.localScale;

            // Save position/rotation/scale
            var position = new float[] { pos.x, pos.y, -pos.z };
            var rotation = new float[] { rot.x, rot.y, -rot.z, -rot.w };
            var scale = new float[] { scl.x, scl.y, scl.z };

            var meshPath = null as string;
            if (_meshPaths.TryGetValue(objectId, out var mp))
                meshPath = mp;

            // Gaussian Splat GLB は glTFast を通さず専用バックエンドで復元する。
            SceneSyncGaussianSplatGlbInfo gaussianSplatInfo;
            if (SceneSyncGaussianSplatBackend.IsGaussianSplatGlb(glbBytes, out gaussianSplatInfo))
            {
                var visual = SceneSyncGaussianSplatBackend.CreateVisual(glbBytes, gaussianSplatInfo);
                if (!visual.Ok)
                {
                    Debug.LogWarning("[ExpiredGlbRecovery] Gaussian Splat import failed: " + visual.Reason);
                    return;
                }

                var recoveredGraphJson = GetObjectLoomGraphJson(go);
                if (!string.IsNullOrWhiteSpace(recoveredGraphJson))
                    _pendingObjectLoomGraphs[objectId] = recoveredGraphJson;

                ForgetObject(objectId, go);
                Destroy(go);

                var splatGo = new GameObject(name);
                ConfigureRemoteTemporaryIdentity(splatGo, objectId, meshPath, assetId);
                splatGo.transform.SetParent(GetOrCreateTemporaryRoot(), worldPositionStays: false);

                var splatRoot = new GameObject("ImportedGlbRoot");
                splatRoot.transform.SetParent(splatGo.transform, worldPositionStays: false);
                splatRoot.transform.localPosition = Vector3.zero;
                splatRoot.transform.localRotation = Quaternion.Euler(0f, 180f, 0f);
                splatRoot.transform.localScale = Vector3.one;
                visual.Visual.transform.SetParent(splatRoot.transform, worldPositionStays: false);

                _instanceToObjectId[splatGo.GetInstanceID()] = objectId;
                _managedObjects[objectId] = splatGo;
                EnsureLocalObjectEpoch(objectId);

                ApplyTransform(splatGo, position, rotation, scale);
                ApplyPendingObjectLoomGraph(objectId, splatGo);

                Debug.Log(
                    "[ExpiredGlbRecovery] Recovered Gaussian Splat: objectId=" + objectId
                    + ", source=" + visual.Source
                    + ", points=" + visual.PointCount);
                OnObjectAdded?.Invoke(objectId, splatGo);
                return;
            }

            // Reuse the existing load logic but with bytes instead of download
            var tempPath = System.IO.Path.Combine(Application.temporaryCachePath, objectId + ".glb");
            System.IO.File.WriteAllBytes(tempPath, glbBytes);

            try
            {
                var deferAgent = gameObject.AddComponent<TimeBudgetPerFrameDeferAgent>();
                var importSettings = new ImportSettings
                {
                    // Match normal runtime imports so recovered GLBs auto-play animations.
                    AnimationMethod = AnimationMethod.Legacy,
                };
                var gltf = new GltfImport(downloadProvider: null, deferAgent: deferAgent);
                var success = await gltf.Load("file://" + tempPath, importSettings);

                if (success)
                {
                    var existingGraphJson = GetObjectLoomGraphJson(go);
                    if (!string.IsNullOrWhiteSpace(existingGraphJson))
                        _pendingObjectLoomGraphs[objectId] = existingGraphJson;

                    ForgetObject(objectId, go);
                    Destroy(go);

                    var newGo = new GameObject(name);
                    ConfigureRemoteTemporaryIdentity(newGo, objectId, meshPath, assetId);
                    newGo.transform.SetParent(GetOrCreateTemporaryRoot(), worldPositionStays: false);

                    var importedGlbRoot = new GameObject("ImportedGlbRoot");
                    importedGlbRoot.transform.SetParent(newGo.transform, worldPositionStays: false);
                    importedGlbRoot.transform.localPosition = Vector3.zero;
                    importedGlbRoot.transform.localRotation = Quaternion.Euler(0f, 180f, 0f);
                    importedGlbRoot.transform.localScale = Vector3.one;

                    _instanceToObjectId[newGo.GetInstanceID()] = objectId;
                    _managedObjects[objectId] = newGo;
                    EnsureLocalObjectEpoch(objectId);

                    await gltf.InstantiateMainSceneAsync(importedGlbRoot.transform);
                    ApplyFallbackMaterialToRenderers(newGo, replaceAll: false, reason: "post-recovery import");
                    PlayImportedAnimations(newGo);
                    ApplyTransform(newGo, position, rotation, scale);
                    ApplyPendingObjectLoomGraph(objectId, newGo);

                    OnObjectAdded?.Invoke(objectId, newGo);
                }
                else
                {
                    Debug.LogWarning("[ExpiredGlbRecovery] glTF import failed");
                }

                if (deferAgent != null)
                    Destroy(deferAgent);
            }
            finally
            {
                try { System.IO.File.Delete(tempPath); } catch { }
            }
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
            _knownObjectIds.Remove(objectId);
            _lastSnapshots.Remove(objectId);
            _meshPaths.Remove(objectId);
            _locks.Remove(objectId);
            _sharedObjectEpochTimes.Remove(objectId);
            _localObjectEpochTimes.Remove(objectId);
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
            {
                _instanceToObjectId.Remove(key);
            }
        }

        private static double ReadTopLevelDouble(string raw, string fieldName, double fallback)
        {
            var value = SceneSyncWireJson.ExtractTopLevelRawValue(raw, fieldName);
            if (string.IsNullOrWhiteSpace(value)) return fallback;

            value = value.Trim().Trim('"');
            return double.TryParse(
                value,
                System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture,
                out var parsed)
                ? parsed
                : fallback;
        }

        private static bool ReadTopLevelBool(string raw, string fieldName, bool fallback)
        {
            var value = SceneSyncWireJson.ExtractTopLevelRawValue(raw, fieldName);
            if (string.IsNullOrWhiteSpace(value)) return fallback;

            value = value.Trim();
            if (string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(value, "false", StringComparison.OrdinalIgnoreCase)) return false;
            return fallback;
        }

        private static bool IsFinite(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value);
        }

        private static double GetUnixTimeSeconds()
        {
            return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000d;
        }

        private static string FormatDouble(double value)
        {
            return value.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        private struct SceneClockState
        {
            private SceneClockState(
                bool active,
                string source,
                double offset,
                bool paused,
                double pausedTime,
                double rate,
                double roomNowAtReceipt,
                double receiptMonotonicTime,
                double sentAtMilliseconds,
                string controllerId,
                double leaseExpiresAtMilliseconds,
                double leaseDurationMilliseconds)
            {
                Active = active;
                Source = string.IsNullOrWhiteSpace(source) ? "room" : source;
                Offset = IsFinite(offset) ? offset : 0d;
                Paused = paused;
                PausedTime = IsFinite(pausedTime) ? pausedTime : double.NaN;
                Rate = IsFinite(rate) && rate >= 0d ? rate : 1d;
                RoomNowAtReceipt = IsFinite(roomNowAtReceipt) ? roomNowAtReceipt : 0d;
                ReceiptMonotonicTime = IsFinite(receiptMonotonicTime) ? receiptMonotonicTime : 0d;
                SentAtMilliseconds = IsFinite(sentAtMilliseconds) ? sentAtMilliseconds : 0d;
                ControllerId = string.IsNullOrWhiteSpace(controllerId) ? null : controllerId;
                LeaseExpiresAtMilliseconds = IsFinite(leaseExpiresAtMilliseconds)
                    ? leaseExpiresAtMilliseconds
                    : 0d;
                LeaseDurationMilliseconds = IsFinite(leaseDurationMilliseconds)
                    ? leaseDurationMilliseconds
                    : 0d;
            }

            public bool Active { get; }
            private string Source { get; }
            public double Offset { get; }
            public bool Paused { get; }
            private double PausedTime { get; }
            public double Rate { get; }
            public string ControllerId { get; }
            private double RoomNowAtReceipt { get; }
            private double ReceiptMonotonicTime { get; }
            private double SentAtMilliseconds { get; }
            private double LeaseExpiresAtMilliseconds { get; }
            private double LeaseDurationMilliseconds { get; }

            public static SceneClockState Inactive => new SceneClockState(
                false, "room", 0d, false, double.NaN, 1d,
                0d, 0d, 0d, null, 0d, 0d);

            public static SceneClockState CreateController(
                double activeTime,
                double roomNow,
                double localMonotonicTime,
                string controllerId)
            {
                return new SceneClockState(
                    true,
                    "room",
                    SceneSyncPlaybackClockMath.RebaseOffset(activeTime, roomNow, 1d),
                    false,
                    double.NaN,
                    1d,
                    roomNow,
                    localMonotonicTime,
                    roomNow * 1000d,
                    controllerId,
                    0d,
                    0d);
            }

            public static SceneClockState Parse(
                string raw,
                SceneClockState previous,
                double receiptMonotonicTime,
                double serverRoomNowAtReceipt,
                string controllerId)
            {
                var hasActive = SceneSyncWireJson.HasTopLevelField(raw, "active");
                var hasController = SceneSyncWireJson.HasTopLevelField(raw, "controller");
                var active = SceneSyncPlaybackClockMath.ResolveActive(
                    hasActive,
                    ReadTopLevelBool(raw, "active", previous.Active),
                    hasController,
                    !string.IsNullOrWhiteSpace(controllerId));
                if (!hasActive && SceneSyncPlaybackClockMath.IsControllerReleaseAction(
                        SceneSyncWireJson.ExtractString(raw, "action")))
                    active = false;
                var paused = ReadTopLevelBool(raw, "paused", previous.Paused);
                var pausedTime = ReadTopLevelDouble(
                    raw,
                    "pausedTime",
                    paused ? previous.PausedTime : double.NaN);
                var payloadRoomNow = ReadTopLevelDouble(raw, "roomNow", serverRoomNowAtReceipt);
                var leaseExpiresAt = ReadTopLevelDouble(raw, "leaseExpiresAt", 0d);
                var leaseDuration = ReadTopLevelDouble(raw, "leaseDurationMs", 0d);

                // Lease fields identify a server-canonical payload. Only those
                // payloads may use server RoomNow to account for receipt latency;
                // legacy controller roomNow can contain arbitrary wall-clock skew.
                var canonicalRoomTime = leaseExpiresAt > 0d || leaseDuration > 0d;
                var roomNowAtReceipt = SceneSyncPlaybackClockMath.GetRoomTimeAtReceipt(
                    payloadRoomNow,
                    serverRoomNowAtReceipt,
                    canonicalRoomTime);

                return new SceneClockState(
                    active,
                    SceneSyncWireJson.ExtractString(raw, "source") ?? previous.Source ?? "room",
                    ReadTopLevelDouble(raw, "offset", previous.Offset),
                    paused,
                    pausedTime,
                    ReadTopLevelDouble(raw, "rate", previous.Rate),
                    roomNowAtReceipt,
                    receiptMonotonicTime,
                    ReadTopLevelDouble(raw, "sentAt", previous.SentAtMilliseconds),
                    controllerId,
                    leaseExpiresAt,
                    leaseDuration);
            }

            public double GetTime(double localMonotonicTime)
            {
                var sourceNow = string.Equals(Source, "room", StringComparison.OrdinalIgnoreCase)
                    ? GetRoomNow(localMonotonicTime)
                    : localMonotonicTime;
                return SceneSyncPlaybackClockMath.GetActiveTime(
                    sourceNow,
                    Rate,
                    Offset,
                    Paused,
                    PausedTime);
            }

            public bool IsLeaseValid(double localMonotonicTime)
            {
                if (LeaseExpiresAtMilliseconds > 0d)
                {
                    return SceneSyncPlaybackClockMath.IsLeaseValid(
                        LeaseExpiresAtMilliseconds,
                        GetRoomNow(localMonotonicTime));
                }
                return SceneSyncPlaybackClockMath.IsReceiptLeaseValid(
                    LeaseDurationMilliseconds,
                    ReceiptMonotonicTime,
                    localMonotonicTime);
            }

            public SceneClockState Reanchor(double roomNow, double localMonotonicTime, string controllerId)
            {
                var activeTime = GetTime(localMonotonicTime);
                return new SceneClockState(
                    true,
                    "room",
                    SceneSyncPlaybackClockMath.RebaseOffset(activeTime, roomNow, Rate),
                    Paused,
                    Paused ? activeTime : double.NaN,
                    Rate,
                    roomNow,
                    localMonotonicTime,
                    roomNow * 1000d,
                    controllerId,
                    LeaseExpiresAtMilliseconds,
                    LeaseDurationMilliseconds);
            }

            public SceneClockState Pause(double localMonotonicTime)
            {
                var activeTime = GetTime(localMonotonicTime);
                return new SceneClockState(
                    Active, Source, Offset, true, activeTime, Rate,
                    GetRoomNow(localMonotonicTime), localMonotonicTime,
                    SentAtMilliseconds, ControllerId,
                    LeaseExpiresAtMilliseconds, LeaseDurationMilliseconds);
            }

            public SceneClockState Resume(double roomNow, double localMonotonicTime)
            {
                var activeTime = GetTime(localMonotonicTime);
                return new SceneClockState(
                    Active, "room",
                    SceneSyncPlaybackClockMath.RebaseOffset(activeTime, roomNow, Rate),
                    false, double.NaN, Rate,
                    roomNow, localMonotonicTime, roomNow * 1000d, ControllerId,
                    LeaseExpiresAtMilliseconds, LeaseDurationMilliseconds);
            }

            public SceneClockState Seek(double targetTime, double roomNow, double localMonotonicTime)
            {
                targetTime = SceneSyncPlaybackClockMath.ClampTime(targetTime);
                return new SceneClockState(
                    Active, "room",
                    SceneSyncPlaybackClockMath.RebaseOffset(targetTime, roomNow, Rate),
                    Paused, Paused ? targetTime : double.NaN, Rate,
                    roomNow, localMonotonicTime, roomNow * 1000d, ControllerId,
                    LeaseExpiresAtMilliseconds, LeaseDurationMilliseconds);
            }

            public SceneClockState WithRate(double rate, double roomNow, double localMonotonicTime)
            {
                var activeTime = GetTime(localMonotonicTime);
                rate = SceneSyncPlaybackClockMath.NormalizeRate(rate);
                return new SceneClockState(
                    Active, "room",
                    SceneSyncPlaybackClockMath.RebaseOffset(activeTime, roomNow, rate),
                    Paused, Paused ? activeTime : double.NaN, rate,
                    roomNow, localMonotonicTime, roomNow * 1000d, ControllerId,
                    LeaseExpiresAtMilliseconds, LeaseDurationMilliseconds);
            }

            public SceneClockState Deactivate()
            {
                return new SceneClockState(
                    false, Source, Offset, Paused, PausedTime, Rate,
                    RoomNowAtReceipt, ReceiptMonotonicTime, SentAtMilliseconds,
                    null, LeaseExpiresAtMilliseconds, LeaseDurationMilliseconds);
            }

            private double GetRoomNow(double localMonotonicTime)
            {
                return SceneSyncPlaybackClockMath.GetAnchoredTime(
                    RoomNowAtReceipt,
                    ReceiptMonotonicTime,
                    localMonotonicTime);
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
