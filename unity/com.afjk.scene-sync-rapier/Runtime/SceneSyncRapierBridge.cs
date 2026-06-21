using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using AFJK.Rapier;
using Afjk.SceneSync;
using UnityEngine;

namespace Afjk.SceneSync.Rapier
{
    [DisallowMultipleComponent]
    public sealed class SceneSyncRapierBridge : MonoBehaviour
    {
        private const float DefaultTimestep = 1f / 60f;
        private const float GroundHalfExtent = 4096f;
        private const float GroundThickness = 0.1f;
        private const double ZeroTimeEpsilon = 0.000001d;
        private const string GroundStableId = "__scenesync_ground__";
        private const string CanonicalStateHashVersion = "SceneSyncCanonicalPhysicsHashV1";
        private const string PhysicsProfile = "SceneSyncRapierParity-0.30";
        private const string SnapshotVersion = "SceneSyncPhysicsSnapshotV1";

        [SerializeField] private bool autoRun = true;
        [SerializeField] private bool useSceneClock = true;
        [SerializeField] private bool applyDynamicTransforms = true;
        [SerializeField] private bool includeGround = true;
        [SerializeField] private float metadataScanInterval = 0.5f;
        [SerializeField] private float maxFrameStepSeconds = 0.25f;
        [SerializeField] private int maxClockStepsPerUpdate = 600;
        [SerializeField] private int maxCollisionEventsPerDrain = 256;
        [SerializeField] private bool autoApplyRemoteSnapshots = true;
        [SerializeField] private bool requestSnapshotOnHashMismatch = true;
        [SerializeField] private float snapshotRequestCooldownSeconds = 1f;
        [SerializeField] private bool logStateHash;

        private readonly Dictionary<string, string> objectPhysicsJson = new Dictionary<string, string>(StringComparer.Ordinal);
        private readonly Dictionary<string, BodyBinding> bindings = new Dictionary<string, BodyBinding>(StringComparer.Ordinal);
        private readonly Dictionary<RapierColliderHandle, string> colliderObjectIds = new Dictionary<RapierColliderHandle, string>();
        private readonly HashSet<string> currentCollisionPairs = new HashSet<string>(StringComparer.Ordinal);
        private readonly HashSet<string> previousCollisionPairs = new HashSet<string>(StringComparer.Ordinal);
        private readonly List<SceneSyncRapierCollisionEvent> lastCollisionEvents = new List<SceneSyncRapierCollisionEvent>();

        private RapierWorld world;
        private RapierSnapshot initialSnapshot;
        private ScenePhysicsDefinition scenePhysics = ScenePhysicsDefinition.Disabled;
        private SceneClockState sceneClock = SceneClockState.Inactive;
        private bool dirty = true;
        private bool hasInitialSnapshot;
        private bool hasPendingWorldEpochTime;
        private bool lastStepLimited;
        private bool preserveMotionOnNextRebuild = true;
        private float accumulator;
        private float worldEpochTime;
        private float pendingWorldEpochTime;
        private int tick;
        private int latestSceneClockRevision = int.MinValue;
        private float nextMetadataScanAt;
        private string lastStateHash;
        private bool hasRemoteHashReport;
        private SceneSyncRapierHashReport lastRemoteHashReport;
        private bool hasRemoteSnapshotReport;
        private SceneSyncRapierSnapshotReport lastRemoteSnapshotReport;
        private int lastSnapshotRequestTick = int.MinValue;
        private float lastSnapshotRequestTime = float.NegativeInfinity;

        public event Action<SceneSyncRapierCollisionEvent> CollisionEvent;
        public event Action<SceneSyncRapierHashReport> HashReportReceived;
        public event Action<SceneSyncRapierSnapshotReport> SnapshotReceived;

        public string StateHashVersion => CanonicalStateHashVersion;
        public int Tick => tick;
        public string LastStateHash => lastStateHash;
        public bool HasWorld => world != null && world.IsCreated;
        public bool LastStepLimited => lastStepLimited;
        public IReadOnlyList<SceneSyncRapierCollisionEvent> LastCollisionEvents => lastCollisionEvents;
        public bool HasRemoteHashReport => hasRemoteHashReport;
        public SceneSyncRapierHashReport LastRemoteHashReport => lastRemoteHashReport;
        public bool LastRemoteHashMatched => hasRemoteHashReport && lastRemoteHashReport.Matched;
        public bool HasRemoteSnapshotReport => hasRemoteSnapshotReport;
        public SceneSyncRapierSnapshotReport LastRemoteSnapshotReport => lastRemoteSnapshotReport;
        public bool LastRemoteSnapshotApplied => hasRemoteSnapshotReport && lastRemoteSnapshotReport.Applied;

        private void OnEnable()
        {
            SceneSyncMessageBus.MessageReceived += HandleSceneMessage;
            dirty = true;
            RefreshMetadataFromScene();
        }

        private void OnDisable()
        {
            SceneSyncMessageBus.MessageReceived -= HandleSceneMessage;
            DisposeWorld();
        }

        private void Update()
        {
            if (Time.unscaledTime >= nextMetadataScanAt)
            {
                nextMetadataScanAt = Time.unscaledTime + Mathf.Max(0.05f, metadataScanInterval);
                if (RefreshMetadataFromScene())
                    dirty = true;
            }

            if (dirty)
                RebuildWorld();

            if (!autoRun || world == null) return;

            if (useSceneClock && sceneClock.Active)
            {
                UpdateFromSceneClock();
                return;
            }

            StepLocalFrame();
        }

        private void StepLocalFrame()
        {
            lastCollisionEvents.Clear();
            var frameTime = Mathf.Min(Mathf.Max(0f, Time.unscaledDeltaTime), Mathf.Max(0f, maxFrameStepSeconds));
            accumulator += frameTime;
            var timestep = Mathf.Max(0.000001f, scenePhysics.Timestep);
            var maxSteps = Mathf.Max(1, Mathf.CeilToInt(Mathf.Max(0.001f, maxFrameStepSeconds) / timestep));
            var steps = 0;

            while (accumulator + 0.0000001f >= timestep && steps < maxSteps)
            {
                if (!StepWorldOnce()) break;
                accumulator -= timestep;
                steps++;
            }

            if (steps > 0)
            {
                ApplyWorldTransforms();
                FlushCollisionEvents(GetCurrentPhysicsTime());
                UpdateLastStateHash(null);
            }
        }

        private void UpdateFromSceneClock()
        {
            var clockTime = sceneClock.GetTime();
            var timestep = Mathf.Max(0.000001f, scenePhysics.Timestep);
            var targetTick = Mathf.Max(0, Mathf.FloorToInt(Mathf.Max(0f, clockTime - worldEpochTime) / timestep));
            lastStepLimited = false;
            lastCollisionEvents.Clear();

            if (targetTick < tick && hasInitialSnapshot)
            {
                if (world.TryReadSnapshot(initialSnapshot))
                {
                    tick = 0;
                    accumulator = 0f;
                    currentCollisionPairs.Clear();
                    previousCollisionPairs.Clear();
                    lastCollisionEvents.Clear();
                }
            }

            var maxSteps = Mathf.Max(1, maxClockStepsPerUpdate);
            var steps = 0;
            while (tick < targetTick && steps < maxSteps)
            {
                if (!StepWorldOnce()) break;
                steps++;
            }

            if (tick < targetTick)
                lastStepLimited = true;

            if (steps > 0 || targetTick == 0)
            {
                ApplyWorldTransforms();
                FlushCollisionEvents(clockTime);
                if (steps > 0 || string.IsNullOrWhiteSpace(lastStateHash))
                    UpdateLastStateHash("targetTick=" + targetTick.ToString(CultureInfo.InvariantCulture));
            }
        }

        private bool StepWorldOnce()
        {
            if (world == null || !world.Step())
                return false;
            tick++;
            DrainCollisionEventsIntoCurrentPairs();
            return true;
        }

        public void MarkDirty()
        {
            dirty = true;
        }

        public void RebuildWorld()
        {
            var preservedBodyStates = preserveMotionOnNextRebuild
                ? CapturePreservedBodyStates()
                : new Dictionary<string, PreservedBodyState>(StringComparer.Ordinal);
            preserveMotionOnNextRebuild = true;

            dirty = false;
            accumulator = 0f;
            tick = 0;
            lastStateHash = null;
            lastStepLimited = false;
            hasInitialSnapshot = false;
            initialSnapshot = default;
            bindings.Clear();
            colliderObjectIds.Clear();
            currentCollisionPairs.Clear();
            previousCollisionPairs.Clear();
            lastCollisionEvents.Clear();
            DisposeWorld();

            if (!scenePhysics.Enabled)
                return;

            var candidates = CollectBodyCandidates();
            if (candidates.Count == 0)
                return;

            try
            {
                world = RapierWorld.Create();
                world.SetGravity(scenePhysics.Gravity);
                world.SetTimestep(scenePhysics.Timestep);

                if (includeGround && scenePhysics.Ground != null)
                    CreateGround(scenePhysics.Ground.Value);

                foreach (var candidate in candidates.OrderBy(item => item.ObjectId, StringComparer.Ordinal))
                {
                    preservedBodyStates.TryGetValue(candidate.ObjectId, out var preservedState);
                    CreateBody(candidate, preservedState);
                }

                worldEpochTime = hasPendingWorldEpochTime
                    ? pendingWorldEpochTime
                    : (useSceneClock && sceneClock.Active ? sceneClock.GetTime() : 0f);
                hasPendingWorldEpochTime = false;
                pendingWorldEpochTime = 0f;
                hasInitialSnapshot = world.TryCreateSnapshot(out initialSnapshot);
                ApplyWorldTransforms();
                UpdateLastStateHash("rebuilt");
            }
            catch (Exception error)
            {
                Debug.LogWarning("[SceneSyncRapier] Failed to rebuild Rapier world: " + error.Message);
                DisposeWorld();
                bindings.Clear();
                colliderObjectIds.Clear();
                currentCollisionPairs.Clear();
                previousCollisionPairs.Clear();
                lastCollisionEvents.Clear();
                hasInitialSnapshot = false;
            }
        }

        private bool RefreshMetadataFromScene()
        {
            var changed = false;

            var localScenePhysics = GetComponent<SceneSyncPhysicsMetadata>();
            if (localScenePhysics != null && !string.IsNullOrWhiteSpace(localScenePhysics.ScenePhysicsJson))
            {
                var next = ScenePhysicsDefinition.Parse(localScenePhysics.ScenePhysicsJson);
                if (!scenePhysics.Equals(next))
                {
                    scenePhysics = next;
                    changed = true;
                }
            }
            else
            {
                foreach (var metadata in FindObjectsByType<SceneSyncPhysicsMetadata>(FindObjectsSortMode.None))
                {
                    if (metadata == null || string.IsNullOrWhiteSpace(metadata.ScenePhysicsJson)) continue;
                    var next = ScenePhysicsDefinition.Parse(metadata.ScenePhysicsJson);
                    if (!scenePhysics.Equals(next))
                    {
                        scenePhysics = next;
                        changed = true;
                    }
                    break;
                }
            }

            foreach (var identity in FindObjectsByType<SceneSyncIdentity>(FindObjectsSortMode.None))
            {
                if (identity == null || string.IsNullOrWhiteSpace(identity.ObjectId)) continue;
                var metadata = identity.GetComponent<SceneSyncPhysicsMetadata>();
                if (metadata == null) continue;

                var raw = metadata.ObjectPhysicsJson;
                if (string.IsNullOrWhiteSpace(raw)) continue;

                if (!objectPhysicsJson.TryGetValue(identity.ObjectId, out var previous) ||
                    !string.Equals(previous, raw, StringComparison.Ordinal))
                {
                    objectPhysicsJson[identity.ObjectId] = raw;
                    changed = true;
                }
            }

            return changed;
        }

        private List<BodyCandidate> CollectBodyCandidates()
        {
            var identities = FindObjectsByType<SceneSyncIdentity>(FindObjectsSortMode.None);
            var byId = new Dictionary<string, SceneSyncIdentity>(StringComparer.Ordinal);
            foreach (var identity in identities)
            {
                if (identity == null || string.IsNullOrWhiteSpace(identity.ObjectId)) continue;
                if (!byId.ContainsKey(identity.ObjectId))
                    byId.Add(identity.ObjectId, identity);
            }

            var result = new List<BodyCandidate>();
            foreach (var pair in objectPhysicsJson)
            {
                if (!byId.TryGetValue(pair.Key, out var identity) || identity == null) continue;
                var definition = ObjectPhysicsDefinition.Parse(pair.Value, identity.transform);
                if (!definition.Enabled) continue;
                result.Add(new BodyCandidate(pair.Key, identity.gameObject, definition));
            }

            return result;
        }

        private void HandleSceneMessage(SceneSyncRawMessage message)
        {
            var raw = message.RawJson;
            if (string.IsNullOrWhiteSpace(raw)) return;

            if (raw.Contains("\"kind\":\"scene-state\""))
            {
                latestSceneClockRevision = int.MinValue;
                if (SceneSyncWireJson.HasTopLevelField(raw, "physics"))
                    scenePhysics = ScenePhysicsDefinition.Parse(SceneSyncWireJson.ExtractTopLevelRawValue(raw, "physics"));

                foreach (var entry in SceneSyncWireJson.ExtractObjectMapEntries(raw, "objects"))
                {
                    ApplyObjectPhysicsJson(entry.Key, entry.Value);
                }

                dirty = true;
                return;
            }

            if (raw.Contains("\"kind\":\"scene-clock\""))
            {
                ApplySceneClock(raw);
                return;
            }

            if (raw.Contains("\"kind\":\"scene-physics-snapshot\""))
            {
                ApplyScenePhysicsSnapshot(raw, message.FromPeerId);
                return;
            }

            if (raw.Contains("\"kind\":\"scene-physics-hash\""))
            {
                ApplyScenePhysicsHash(raw, message.FromPeerId);
                return;
            }

            if (raw.Contains("\"kind\":\"scene-physics\""))
            {
                scenePhysics = ScenePhysicsDefinition.Parse(SceneSyncWireJson.ExtractTopLevelRawValue(raw, "physics"));
                dirty = true;
                return;
            }

            if (raw.Contains("\"kind\":\"scene-remove\"") || raw.Contains("\"kind\":\"scene-delete\""))
            {
                var objectId = SceneSyncWireJson.ExtractString(raw, "objectId");
                if (!string.IsNullOrWhiteSpace(objectId) && objectPhysicsJson.Remove(objectId))
                    dirty = true;
                return;
            }

            if (!raw.Contains("\"kind\":\"scene-add\"") && !raw.Contains("\"kind\":\"scene-delta\""))
                return;

            var id = SceneSyncWireJson.ExtractString(raw, "objectId");
            if (string.IsNullOrWhiteSpace(id)) return;
            if (ApplyObjectPhysicsJson(id, raw))
                dirty = true;
        }

        private void ApplyScenePhysicsSnapshot(string raw, string fromPeerId)
        {
            var payloadJson = SceneSyncWireJson.ExtractTopLevelRawObject(raw, "payload") ?? raw;
            ScenePhysicsSnapshotPayload payload = null;
            try
            {
                payload = JsonUtility.FromJson<ScenePhysicsSnapshotPayload>(payloadJson);
            }
            catch (Exception error)
            {
                Debug.LogWarning("[SceneSyncRapier] Failed to parse scene-physics-snapshot: " + error.Message);
            }

            var remoteHash = NormalizeHash(payload?.hash);
            var localTickBeforeApply = tick;
            var bodyCount = payload?.bodies != null ? payload.bodies.Length : 0;
            var dynamicBodyCount = 0;
            var appliedBodyCount = 0;
            var missingBodyCount = 0;
            var applied = false;

            var canApply = autoApplyRemoteSnapshots
                && payload != null
                && world != null
                && world.IsCreated
                && string.Equals(payload.snapshotVersion, SnapshotVersion, StringComparison.Ordinal)
                && string.Equals(payload.hashVersion, CanonicalStateHashVersion, StringComparison.Ordinal)
                && string.Equals(payload.profile, PhysicsProfile, StringComparison.Ordinal)
                && payload.tick >= 0
                && payload.bodies != null;

            var bodyStates = new List<SnapshotBodyState>();
            if (canApply)
            {
                foreach (var body in payload.bodies)
                {
                    if (body == null || !IsDynamicSnapshotBody(body))
                        continue;

                    dynamicBodyCount++;
                    if (string.IsNullOrWhiteSpace(body.id) ||
                        !bindings.TryGetValue(body.id, out var binding) ||
                        binding.IsStatic ||
                        !TryCreateSnapshotBodyState(body, binding.Body, out var state))
                    {
                        missingBodyCount++;
                        continue;
                    }

                    bodyStates.Add(state);
                }

                if (missingBodyCount == 0)
                {
                    foreach (var state in bodyStates)
                    {
                        var ok = world.SetTransform(state.Body, new RapierTransform(state.Position, state.Rotation));
                        ok = world.SetLinearVelocity(state.Body, state.LinearVelocity, true) && ok;
                        ok = world.SetAngularVelocity(state.Body, state.AngularVelocity, true) && ok;
                        if (ok) appliedBodyCount++;
                    }

                    applied = appliedBodyCount == dynamicBodyCount;
                    if (applied)
                    {
                        tick = payload.tick;
                        worldEpochTime = IsFinite(payload.worldEpochTime)
                            ? Mathf.Max(0f, payload.worldEpochTime)
                            : Mathf.Max(0f, sceneClock.GetTime() - tick * Mathf.Max(0.000001f, scenePhysics.Timestep));
                        hasPendingWorldEpochTime = false;
                        pendingWorldEpochTime = 0f;
                        accumulator = 0f;
                        lastStepLimited = false;
                        currentCollisionPairs.Clear();
                        previousCollisionPairs.Clear();
                        lastCollisionEvents.Clear();
                        ApplyWorldTransforms();
                        UpdateLastStateHash("snapshot");
                    }
                }
            }

            var localHash = NormalizeHash(ComputeStateHashHex());
            var hashMatched = applied
                && !string.IsNullOrWhiteSpace(remoteHash)
                && !string.IsNullOrWhiteSpace(localHash)
                && string.Equals(remoteHash, localHash, StringComparison.Ordinal);
            lastRemoteSnapshotReport = new SceneSyncRapierSnapshotReport(
                payload?.snapshotVersion,
                remoteHash,
                localHash,
                payload?.hashVersion,
                payload?.profile,
                payload?.rapierCoreVersion,
                payload?.tick ?? -1,
                localTickBeforeApply,
                payload?.timestep ?? 0f,
                payload?.activeTime ?? float.NaN,
                payload?.worldAge ?? float.NaN,
                payload?.worldEpochTime ?? float.NaN,
                payload?.sceneClockRevision ?? int.MinValue,
                fromPeerId,
                bodyCount,
                dynamicBodyCount,
                appliedBodyCount,
                missingBodyCount,
                applied,
                hashMatched);
            hasRemoteSnapshotReport = true;
            SnapshotReceived?.Invoke(lastRemoteSnapshotReport);
        }

        private void ApplyScenePhysicsHash(string raw, string fromPeerId)
        {
            var remoteHash = NormalizeHash(SceneSyncWireJson.ExtractString(raw, "hash"));
            var hashVersion = SceneSyncWireJson.ExtractString(raw, "hashVersion");
            var profile = SceneSyncWireJson.ExtractString(raw, "profile");
            var rapierCoreVersion = SceneSyncWireJson.ExtractString(raw, "rapierCoreVersion");
            var remoteTick = ReadInt(raw, "tick", -1);
            var timestep = ReadFloat(raw, "timestep", scenePhysics.Timestep);
            var activeTime = ReadFloat(raw, "activeTime", float.NaN);
            var worldAge = ReadFloat(raw, "worldAge", float.NaN);
            var reportedWorldEpochTime = ReadFloat(raw, "worldEpochTime", float.NaN);
            var sceneClockRevision = ReadInt(raw, "sceneClockRevision", int.MinValue);

            var localHash = NormalizeHash(ComputeStateHashHex());
            var tickMatched = remoteTick == tick;
            var hashVersionMatched = string.Equals(hashVersion, CanonicalStateHashVersion, StringComparison.Ordinal);
            var matched = tickMatched
                && hashVersionMatched
                && !string.IsNullOrWhiteSpace(remoteHash)
                && !string.IsNullOrWhiteSpace(localHash)
                && string.Equals(remoteHash, localHash, StringComparison.Ordinal);

            lastRemoteHashReport = new SceneSyncRapierHashReport(
                remoteHash,
                localHash,
                hashVersion,
                profile,
                rapierCoreVersion,
                remoteTick,
                tick,
                timestep,
                activeTime,
                worldAge,
                reportedWorldEpochTime,
                sceneClockRevision,
                fromPeerId,
                tickMatched,
                hashVersionMatched,
                matched);
            hasRemoteHashReport = true;
            HashReportReceived?.Invoke(lastRemoteHashReport);
            MaybeRequestSnapshotForHashMismatch(lastRemoteHashReport);

            if (logStateHash && !matched)
            {
                Debug.LogWarning(
                    "[SceneSyncRapier] scene-physics-hash mismatch remoteTick="
                    + remoteTick.ToString(CultureInfo.InvariantCulture)
                    + " localTick="
                    + tick.ToString(CultureInfo.InvariantCulture)
                    + " remoteHash="
                    + (remoteHash ?? "null")
                    + " localHash="
                    + (localHash ?? "null")
                    + " hashVersion="
                    + (hashVersion ?? "null"));
            }
        }

        private void MaybeRequestSnapshotForHashMismatch(SceneSyncRapierHashReport report)
        {
            if (!requestSnapshotOnHashMismatch || report.Matched) return;
            if (!report.TickMatched || !report.HashVersionMatched) return;
            if (report.Tick < 0) return;

            var now = Time.unscaledTime;
            var cooldown = Mathf.Max(0f, snapshotRequestCooldownSeconds);
            if (lastSnapshotRequestTick == report.Tick && now - lastSnapshotRequestTime < cooldown)
                return;

            lastSnapshotRequestTick = report.Tick;
            lastSnapshotRequestTime = now;
            var requestId = Guid.NewGuid().ToString("N");
            var payload =
                "{\"kind\":\"scene-physics-snapshot-request\"" +
                ",\"source\":\"physics\"" +
                ",\"phase\":\"postPhysics\"" +
                ",\"snapshotVersion\":\"" + SnapshotVersion + "\"" +
                ",\"profile\":\"" + PhysicsProfile + "\"" +
                ",\"hashVersion\":\"" + CanonicalStateHashVersion + "\"" +
                ",\"requestId\":\"" + SceneSyncWireJson.JsonEscape(requestId) + "\"" +
                ",\"reason\":\"hash-mismatch\"" +
                ",\"tick\":" + report.Tick.ToString(CultureInfo.InvariantCulture) +
                ",\"localTick\":" + report.LocalTick.ToString(CultureInfo.InvariantCulture) +
                ",\"remoteHash\":\"" + SceneSyncWireJson.JsonEscape(report.Hash) + "\"" +
                ",\"localHash\":\"" + SceneSyncWireJson.JsonEscape(report.LocalHash) + "\"" +
                ",\"sceneClockRevision\":" + report.SceneClockRevision.ToString(CultureInfo.InvariantCulture) +
                "}";
            SceneSyncMessageBus.PublishOutgoing(payload, null, this);
        }

        private void ApplySceneClock(string raw)
        {
            var mode = SceneSyncWireJson.ExtractString(raw, "mode") ?? "shared-playback";
            if (!string.Equals(mode, "shared-playback", StringComparison.OrdinalIgnoreCase))
                return;

            var revisionValue = ReadDouble(raw, "revision", double.NaN);
            if (IsFinite(revisionValue))
            {
                var revision = Mathf.FloorToInt((float)revisionValue);
                if (revision <= latestSceneClockRevision)
                    return;
                latestSceneClockRevision = revision;
            }

            sceneClock = SceneClockState.Parse(raw, sceneClock);
            var activeTime = sceneClock.GetTime();
            if (ShouldResetPhysicsForSceneClockPayload(raw, activeTime))
            {
                ApplyPhysicsResetBaseline(raw, activeTime);
            }
        }

        private void ApplyPhysicsResetBaseline(string raw, double activeTime)
        {
            var baselineJson = SceneSyncWireJson.ExtractTopLevelRawObject(raw, "physicsBaseline");
            var preserveMotion = !string.IsNullOrWhiteSpace(baselineJson)
                && ReadBool(baselineJson, "preserveMotion", false);
            var worldEpoch = !string.IsNullOrWhiteSpace(baselineJson)
                ? ReadDouble(baselineJson, "worldEpochTime", activeTime)
                : activeTime;
            if (!IsFinite(worldEpoch)) worldEpoch = activeTime;

            pendingWorldEpochTime = Mathf.Max(0f, (float)worldEpoch);
            hasPendingWorldEpochTime = true;
            accumulator = 0f;
            lastStepLimited = false;

            if (!preserveMotion && world != null && hasInitialSnapshot && world.TryReadSnapshot(initialSnapshot))
            {
                worldEpochTime = pendingWorldEpochTime;
                hasPendingWorldEpochTime = false;
                pendingWorldEpochTime = 0f;
                tick = 0;
                currentCollisionPairs.Clear();
                previousCollisionPairs.Clear();
                lastCollisionEvents.Clear();
                ApplyWorldTransforms();
                UpdateLastStateHash("reset");
                return;
            }

            preserveMotionOnNextRebuild = preserveMotion;
            dirty = true;
        }

        private static bool ShouldResetPhysicsForSceneClockPayload(string raw, double activeTime)
        {
            if (string.IsNullOrWhiteSpace(raw)) return false;

            var baselineJson = SceneSyncWireJson.ExtractTopLevelRawObject(raw, "physicsBaseline");
            if (!string.IsNullOrWhiteSpace(baselineJson) &&
                string.Equals(SceneSyncWireJson.ExtractString(baselineJson, "kind"), "reset", StringComparison.OrdinalIgnoreCase))
            {
                return IsZeroTime(
                    ReadDouble(baselineJson, "time",
                        ReadDouble(raw, "targetTime",
                            ReadDouble(raw, "time", activeTime))));
            }

            var action = SceneSyncWireJson.ExtractString(raw, "action");
            if (string.Equals(action, "reset", StringComparison.OrdinalIgnoreCase))
                return true;
            if (!string.Equals(action, "seek", StringComparison.OrdinalIgnoreCase))
                return false;

            return IsZeroTime(ReadDouble(raw, "targetTime", double.NaN))
                || IsZeroTime(ReadDouble(raw, "time", double.NaN))
                || IsZeroTime(ReadDouble(raw, "pausedTime", double.NaN))
                || IsZeroTime(activeTime);
        }

        private static bool IsZeroTime(double value)
        {
            return IsFinite(value) && Math.Abs(value) <= ZeroTimeEpsilon;
        }

        private bool ApplyObjectPhysicsJson(string objectId, string rawObjectJson)
        {
            if (!SceneSyncWireJson.HasTopLevelField(rawObjectJson, "physics")) return false;

            var physicsJson = SceneSyncWireJson.ExtractTopLevelRawValue(rawObjectJson, "physics");
            if (string.IsNullOrWhiteSpace(physicsJson) || physicsJson.Trim() == "null")
            {
                return objectPhysicsJson.Remove(objectId);
            }

            if (objectPhysicsJson.TryGetValue(objectId, out var previous) &&
                string.Equals(previous, physicsJson, StringComparison.Ordinal))
                return false;

            objectPhysicsJson[objectId] = physicsJson;
            return true;
        }

        private void CreateGround(GroundDefinition ground)
        {
            var body = world.CreateRigidBody(new RapierBodyDesc
            {
                BodyType = RapierRigidBodyType.Fixed,
                Position = new Vector3(0f, ground.Y - GroundThickness / 2f, 0f),
                Rotation = Quaternion.identity,
                CanSleep = true
            });
            var stableId = RapierWorld.StableIdHash(GroundStableId);
            world.SetRigidBodyStableId(body, stableId);

            var collider = world.CreateBoxCollider(body, new RapierBoxColliderDesc
            {
                HalfExtents = new Vector3(GroundHalfExtent, GroundThickness / 2f, GroundHalfExtent),
                Density = 1f,
                Friction = ground.Friction,
                HasFriction = true,
                Restitution = ground.Restitution,
                LocalRotation = Quaternion.identity
            });
            world.SetColliderStableId(collider, stableId);
        }

        private Dictionary<string, PreservedBodyState> CapturePreservedBodyStates()
        {
            var result = new Dictionary<string, PreservedBodyState>(StringComparer.Ordinal);
            if (world == null || !world.IsCreated || bindings.Count == 0)
                return result;

            foreach (var pair in bindings)
            {
                var binding = pair.Value;
                if (binding.IsStatic) continue;
                if (!world.TryGetRigidBodyState(binding.Body, out var state)) continue;

                result[pair.Key] = new PreservedBodyState(
                    state.Transform.Position,
                    state.Transform.Rotation,
                    state.LinearVelocity,
                    state.AngularVelocity);
            }

            return result;
        }

        private void CreateBody(BodyCandidate candidate, PreservedBodyState preservedState)
        {
            var definition = candidate.Definition;
            var hasPreservedState = !definition.IsStatic && preservedState.HasValue;
            var body = world.CreateRigidBody(new RapierBodyDesc
            {
                BodyType = definition.IsStatic ? RapierRigidBodyType.Fixed : RapierRigidBodyType.Dynamic,
                Position = hasPreservedState ? preservedState.Position : definition.Position,
                Rotation = hasPreservedState ? preservedState.Rotation : definition.Rotation,
                LinearVelocity = definition.IsStatic
                    ? Vector3.zero
                    : (hasPreservedState ? preservedState.LinearVelocity : definition.LinearVelocity),
                AngularVelocity = definition.IsStatic
                    ? Vector3.zero
                    : (hasPreservedState ? preservedState.AngularVelocity : definition.AngularVelocity),
                LinearDamping = definition.LinearDamping,
                AngularDamping = definition.AngularDamping,
                CanSleep = definition.CanSleep,
                CcdEnabled = definition.CcdEnabled
            });

            var stableId = RapierWorld.StableIdHash(candidate.ObjectId);
            world.SetRigidBodyStableId(body, stableId);

            RapierColliderHandle collider;
            if (definition.Shape == PhysicsShape.Sphere)
            {
                collider = world.CreateSphereCollider(body, new RapierSphereColliderDesc
                {
                    Radius = definition.Radius,
                    Density = definition.Density,
                    Friction = definition.Friction,
                    HasFriction = true,
                    Restitution = definition.Restitution,
                    LocalRotation = Quaternion.identity
                });
            }
            else
            {
                collider = world.CreateBoxCollider(body, new RapierBoxColliderDesc
                {
                    HalfExtents = definition.HalfExtents,
                    Density = definition.Density,
                    Friction = definition.Friction,
                    HasFriction = true,
                    Restitution = definition.Restitution,
                    LocalRotation = Quaternion.identity
                });
            }

            world.SetColliderStableId(collider, stableId);
            world.SetColliderActiveEvents(collider, RapierActiveEvents.CollisionEvents);
            colliderObjectIds[collider] = candidate.ObjectId;
            bindings[candidate.ObjectId] = new BodyBinding(candidate.GameObject, body, definition.IsStatic);
        }

        private void ApplyWorldTransforms()
        {
            if (!applyDynamicTransforms || world == null) return;

            foreach (var binding in bindings.Values)
            {
                if (binding.IsStatic || binding.GameObject == null) continue;
                if (!world.TryGetTransform(binding.Body, out var transform)) continue;
                binding.GameObject.transform.SetPositionAndRotation(
                    WireToUnityPosition(transform.Position),
                    WireToUnityRotation(transform.Rotation));
            }
        }

        private void DrainCollisionEventsIntoCurrentPairs()
        {
            if (world == null || colliderObjectIds.Count == 0) return;

            var capacity = Mathf.Max(1, maxCollisionEventsPerDrain);
            var buffer = new RapierCollisionEvent[capacity];
            var count = world.DrainCollisionEvents(buffer);
            for (var i = 0; i < count; i++)
            {
                var collisionEvent = buffer[i];
                if (!colliderObjectIds.TryGetValue(collisionEvent.Collider1, out var objectIdA) ||
                    !colliderObjectIds.TryGetValue(collisionEvent.Collider2, out var objectIdB))
                {
                    continue;
                }

                var pairKey = CreateCollisionPairKey(objectIdA, objectIdB, out _, out _);
                if (string.IsNullOrWhiteSpace(pairKey)) continue;

                if (collisionEvent.Started)
                    currentCollisionPairs.Add(pairKey);
                else
                    currentCollisionPairs.Remove(pairKey);
            }
        }

        private void FlushCollisionEvents(float time)
        {
            lastCollisionEvents.Clear();

            foreach (var pairKey in currentCollisionPairs.OrderBy(value => value, StringComparer.Ordinal))
            {
                if (previousCollisionPairs.Contains(pairKey)) continue;
                AddCollisionEvent("physics.collision.enter", pairKey, time);
            }

            foreach (var pairKey in previousCollisionPairs.OrderBy(value => value, StringComparer.Ordinal))
            {
                if (currentCollisionPairs.Contains(pairKey)) continue;
                AddCollisionEvent("physics.collision.exit", pairKey, time);
            }

            previousCollisionPairs.Clear();
            foreach (var pairKey in currentCollisionPairs)
                previousCollisionPairs.Add(pairKey);
        }

        private void AddCollisionEvent(string type, string pairKey, float time)
        {
            var separator = pairKey.IndexOf('|');
            if (separator <= 0 || separator >= pairKey.Length - 1) return;

            var objectIdA = pairKey.Substring(0, separator);
            var objectIdB = pairKey.Substring(separator + 1);
            var collisionEvent = new SceneSyncRapierCollisionEvent(type, objectIdA, objectIdB, pairKey, tick, time);
            lastCollisionEvents.Add(collisionEvent);
            CollisionEvent?.Invoke(collisionEvent);
        }

        private float GetCurrentPhysicsTime()
        {
            return worldEpochTime + tick * Mathf.Max(0.000001f, scenePhysics.Timestep);
        }

        public string ComputeStateHashHex()
        {
            if (world == null || !world.IsCreated)
                return null;

            return world.StateHash().ToString("x16", CultureInfo.InvariantCulture);
        }

        private void UpdateLastStateHash(string detail)
        {
            lastStateHash = ComputeStateHashHex();
            if (!logStateHash || string.IsNullOrWhiteSpace(lastStateHash))
                return;

            var message = "[SceneSyncRapier] tick=" + tick.ToString(CultureInfo.InvariantCulture);
            if (!string.IsNullOrWhiteSpace(detail))
                message += " " + detail;
            Debug.Log(message + " canonicalStateHash=" + lastStateHash);
        }

        private void DisposeWorld()
        {
            if (world != null)
                world.Dispose();
            world = null;
            initialSnapshot = default;
            hasInitialSnapshot = false;
        }

        private static Vector3 UnityToWirePosition(Vector3 value)
        {
            return new Vector3(value.x, value.y, -value.z);
        }

        private static Quaternion UnityToWireRotation(Quaternion value)
        {
            return new Quaternion(value.x, value.y, -value.z, -value.w);
        }

        private static Vector3 WireToUnityPosition(Vector3 value)
        {
            return new Vector3(value.x, value.y, -value.z);
        }

        private static Quaternion WireToUnityRotation(Quaternion value)
        {
            return new Quaternion(value.x, value.y, -value.z, -value.w);
        }

        private static string CreateCollisionPairKey(string left, string right, out string objectIdA, out string objectIdB)
        {
            objectIdA = null;
            objectIdB = null;
            if (string.IsNullOrWhiteSpace(left) || string.IsNullOrWhiteSpace(right)) return null;

            if (string.CompareOrdinal(left, right) <= 0)
            {
                objectIdA = left;
                objectIdB = right;
            }
            else
            {
                objectIdA = right;
                objectIdB = left;
            }

            return objectIdA + "|" + objectIdB;
        }

        private static Vector3 ReadVector3(string json, string field, Vector3 fallback)
        {
            var raw = SceneSyncWireJson.ExtractArray(json, field);
            if (raw == null || raw.Length < 3) return fallback;
            return new Vector3(raw[0], raw[1], raw[2]);
        }

        private static Quaternion ReadQuaternion(string json, string field, Quaternion fallback)
        {
            var raw = SceneSyncWireJson.ExtractArray(json, field);
            if (raw == null || raw.Length < 4) return fallback;
            var q = new Quaternion(raw[0], raw[1], raw[2], raw[3]);
            return q == default ? fallback : Normalize(q);
        }

        private static Quaternion Normalize(Quaternion q)
        {
            var length = Mathf.Sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
            if (!IsFinite(length) || length <= 0f) return Quaternion.identity;
            return new Quaternion(q.x / length, q.y / length, q.z / length, q.w / length);
        }

        private static float ReadFloat(string json, string field, float fallback)
        {
            var value = SceneSyncWireJson.ExtractFloat(json, field);
            return value.HasValue && IsFinite(value.Value) ? value.Value : fallback;
        }

        private static int ReadInt(string json, string field, int fallback)
        {
            var value = ReadDouble(json, field, double.NaN);
            return IsFinite(value) ? Mathf.FloorToInt((float)value) : fallback;
        }

        private static double ReadDouble(string json, string field, double fallback)
        {
            var raw = SceneSyncWireJson.ExtractTopLevelRawValue(json, field);
            if (string.IsNullOrWhiteSpace(raw))
                raw = SceneSyncWireJson.ExtractRawValue(json, field);
            if (string.IsNullOrWhiteSpace(raw))
                return fallback;

            return double.TryParse(
                raw.Trim(),
                NumberStyles.Float,
                CultureInfo.InvariantCulture,
                out var value) && IsFinite(value)
                ? value
                : fallback;
        }

        private static bool ReadBool(string json, string field, bool fallback)
        {
            var value = SceneSyncWireJson.ExtractBoolean(json, field);
            return value ?? fallback;
        }

        private static string NormalizeHash(string value)
        {
            return string.IsNullOrWhiteSpace(value)
                ? null
                : value.Trim().ToLowerInvariant();
        }

        private static bool IsDynamicSnapshotBody(ScenePhysicsSnapshotBody body)
        {
            return body != null &&
                !string.Equals(body.type, "fixed", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(body.type, "static", StringComparison.OrdinalIgnoreCase);
        }

        private static bool TryCreateSnapshotBodyState(
            ScenePhysicsSnapshotBody body,
            RapierRigidBodyHandle handle,
            out SnapshotBodyState state)
        {
            state = default;
            if (!TryReadVector3(body.position, out var position) ||
                !TryReadQuaternion(body.rotation, out var rotation))
            {
                return false;
            }

            var linearVelocity = Vector3.zero;
            var angularVelocity = Vector3.zero;
            TryReadVector3(body.velocity, out linearVelocity);
            if (body.angularVelocity != null)
                TryReadVector3(body.angularVelocity, out angularVelocity);
            else
                TryReadVector3(body.angvel, out angularVelocity);
            if (body.velocity == null && body.linvel != null)
                TryReadVector3(body.linvel, out linearVelocity);

            state = new SnapshotBodyState(handle, position, rotation, linearVelocity, angularVelocity);
            return true;
        }

        private static bool TryReadVector3(float[] values, out Vector3 vector)
        {
            vector = Vector3.zero;
            if (values == null || values.Length < 3) return false;
            if (!IsFinite(values[0]) || !IsFinite(values[1]) || !IsFinite(values[2])) return false;
            vector = new Vector3(values[0], values[1], values[2]);
            return true;
        }

        private static bool TryReadQuaternion(float[] values, out Quaternion rotation)
        {
            rotation = Quaternion.identity;
            if (values == null || values.Length < 4) return false;
            if (!IsFinite(values[0]) || !IsFinite(values[1]) || !IsFinite(values[2]) || !IsFinite(values[3]))
            {
                return false;
            }

            rotation = Normalize(new Quaternion(values[0], values[1], values[2], values[3]));
            return true;
        }

        private static bool IsFinite(float value)
        {
            return !float.IsNaN(value) && !float.IsInfinity(value);
        }

        private static bool IsFinite(double value)
        {
            return !double.IsNaN(value) && !double.IsInfinity(value);
        }

        [Serializable]
        private sealed class ScenePhysicsSnapshotPayload
        {
            public string snapshotVersion;
            public string profile;
            public string hashVersion;
            public string rapierCoreVersion;
            public int tick;
            public string hash;
            public float timestep;
            public float activeTime;
            public float worldAge;
            public float worldEpochTime;
            public int sceneClockRevision;
            public ScenePhysicsSnapshotBody[] bodies;
        }

        [Serializable]
        private sealed class ScenePhysicsSnapshotBody
        {
            public string id;
            public string type;
            public float[] position;
            public float[] rotation;
            public float[] velocity;
            public float[] angularVelocity;
            public float[] linvel;
            public float[] angvel;
        }

        private readonly struct SnapshotBodyState
        {
            public SnapshotBodyState(
                RapierRigidBodyHandle body,
                Vector3 position,
                Quaternion rotation,
                Vector3 linearVelocity,
                Vector3 angularVelocity)
            {
                Body = body;
                Position = position;
                Rotation = rotation;
                LinearVelocity = linearVelocity;
                AngularVelocity = angularVelocity;
            }

            public RapierRigidBodyHandle Body { get; }
            public Vector3 Position { get; }
            public Quaternion Rotation { get; }
            public Vector3 LinearVelocity { get; }
            public Vector3 AngularVelocity { get; }
        }

        private readonly struct SceneClockState
        {
            private SceneClockState(
                bool active,
                string source,
                double offset,
                bool paused,
                double pausedTime,
                double rate,
                double roomNow,
                double sentAtMilliseconds)
            {
                Active = active;
                Source = string.IsNullOrWhiteSpace(source) ? "room" : source;
                Offset = IsFinite(offset) ? offset : 0d;
                Paused = paused;
                PausedTime = IsFinite(pausedTime) ? pausedTime : double.NaN;
                Rate = IsFinite(rate) && rate >= 0d ? rate : 1d;
                RoomNow = IsFinite(roomNow) ? roomNow : 0d;
                SentAtMilliseconds = IsFinite(sentAtMilliseconds) ? sentAtMilliseconds : 0d;
            }

            public static SceneClockState Inactive => new SceneClockState(false, "room", 0d, false, double.NaN, 1d, 0d, 0d);

            public bool Active { get; }
            private string Source { get; }
            private double Offset { get; }
            private bool Paused { get; }
            private double PausedTime { get; }
            private double Rate { get; }
            private double RoomNow { get; }
            private double SentAtMilliseconds { get; }

            public static SceneClockState Parse(string raw, SceneClockState previous)
            {
                return new SceneClockState(
                    true,
                    SceneSyncWireJson.ExtractString(raw, "source") ?? previous.Source ?? "room",
                    ReadDouble(raw, "offset", previous.Offset),
                    ReadBool(raw, "paused", previous.Paused),
                    ReadDouble(raw, "pausedTime", double.NaN),
                    ReadDouble(raw, "rate", previous.Rate),
                    ReadDouble(raw, "roomNow", previous.RoomNow),
                    ReadDouble(raw, "sentAt", previous.SentAtMilliseconds));
            }

            public float GetTime()
            {
                if (Paused && IsFinite(PausedTime))
                    return Mathf.Max(0f, (float)PausedTime);

                var sourceNow = string.Equals(Source, "room", StringComparison.OrdinalIgnoreCase)
                    ? GetRoomNow()
                    : Time.realtimeSinceStartupAsDouble;
                var time = sourceNow * Rate + Offset;
                return Mathf.Max(0f, (float)(IsFinite(time) ? time : 0d));
            }

            private double GetRoomNow()
            {
                if (!IsFinite(RoomNow) || RoomNow <= 0d)
                    return 0d;
                if (!IsFinite(SentAtMilliseconds) || SentAtMilliseconds <= 0d)
                    return RoomNow;

                var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                var elapsedSeconds = Math.Max(0d, (nowMs - SentAtMilliseconds) / 1000d);
                return RoomNow + elapsedSeconds;
            }
        }

        private readonly struct BodyCandidate
        {
            public BodyCandidate(string objectId, GameObject gameObject, ObjectPhysicsDefinition definition)
            {
                ObjectId = objectId;
                GameObject = gameObject;
                Definition = definition;
            }

            public string ObjectId { get; }
            public GameObject GameObject { get; }
            public ObjectPhysicsDefinition Definition { get; }
        }

        private readonly struct BodyBinding
        {
            public BodyBinding(GameObject gameObject, RapierRigidBodyHandle body, bool isStatic)
            {
                GameObject = gameObject;
                Body = body;
                IsStatic = isStatic;
            }

            public GameObject GameObject { get; }
            public RapierRigidBodyHandle Body { get; }
            public bool IsStatic { get; }
        }

        private readonly struct PreservedBodyState
        {
            public PreservedBodyState(
                Vector3 position,
                Quaternion rotation,
                Vector3 linearVelocity,
                Vector3 angularVelocity)
            {
                Position = position;
                Rotation = rotation;
                LinearVelocity = linearVelocity;
                AngularVelocity = angularVelocity;
                HasValue = true;
            }

            public bool HasValue { get; }
            public Vector3 Position { get; }
            public Quaternion Rotation { get; }
            public Vector3 LinearVelocity { get; }
            public Vector3 AngularVelocity { get; }
        }

        private enum PhysicsShape
        {
            Box,
            Sphere
        }

        private readonly struct ScenePhysicsDefinition : IEquatable<ScenePhysicsDefinition>
        {
            public static readonly ScenePhysicsDefinition Disabled = new ScenePhysicsDefinition(false, new Vector3(0f, -9.81f, 0f), DefaultTimestep, null);

            public ScenePhysicsDefinition(bool enabled, Vector3 gravity, float timestep, GroundDefinition? ground)
            {
                Enabled = enabled;
                Gravity = gravity;
                Timestep = Mathf.Max(0.000001f, timestep);
                Ground = ground;
            }

            public bool Enabled { get; }
            public Vector3 Gravity { get; }
            public float Timestep { get; }
            public GroundDefinition? Ground { get; }

            public static ScenePhysicsDefinition Parse(string json)
            {
                if (string.IsNullOrWhiteSpace(json) || json.Trim() == "null")
                    return Disabled;

                var enabled = ReadBool(json, "enabled", false);
                var options = SceneSyncWireJson.ExtractTopLevelRawObject(json, "worldOptions") ?? json;
                var gravityArray = SceneSyncWireJson.ExtractArray(options, "gravity");
                var gravity = gravityArray != null && gravityArray.Length >= 3
                    ? new Vector3(gravityArray[0], gravityArray[1], gravityArray[2])
                    : new Vector3(0f, ReadFloat(options, "gravity", -9.81f), 0f);
                var timestep = ReadFloat(options, "timestep", DefaultTimestep);
                GroundDefinition? ground = null;
                var groundRaw = SceneSyncWireJson.ExtractTopLevelRawValue(options, "ground");
                if (!string.IsNullOrWhiteSpace(groundRaw) && groundRaw.Trim() != "null" && groundRaw.Trim() != "false")
                {
                    ground = new GroundDefinition(
                        ReadFloat(groundRaw, "y", 0f),
                        Mathf.Clamp(ReadFloat(groundRaw, "restitution", 0.2f), 0f, 1f),
                        Mathf.Clamp(ReadFloat(groundRaw, "friction", 0.5f), 0f, 4f));
                }

                return new ScenePhysicsDefinition(enabled, gravity, timestep, ground);
            }

            public bool Equals(ScenePhysicsDefinition other)
            {
                return Enabled == other.Enabled
                    && Gravity == other.Gravity
                    && Mathf.Approximately(Timestep, other.Timestep)
                    && ((!Ground.HasValue && !other.Ground.HasValue)
                        || (Ground.HasValue && other.Ground.HasValue && Ground.Value.Equals(other.Ground.Value)));
            }
        }

        private readonly struct GroundDefinition : IEquatable<GroundDefinition>
        {
            public GroundDefinition(float y, float restitution, float friction)
            {
                Y = y;
                Restitution = restitution;
                Friction = friction;
            }

            public float Y { get; }
            public float Restitution { get; }
            public float Friction { get; }

            public bool Equals(GroundDefinition other)
            {
                return Mathf.Approximately(Y, other.Y)
                    && Mathf.Approximately(Restitution, other.Restitution)
                    && Mathf.Approximately(Friction, other.Friction);
            }
        }

        private readonly struct ObjectPhysicsDefinition
        {
            public bool Enabled { get; }
            public bool IsStatic { get; }
            public PhysicsShape Shape { get; }
            public Vector3 Position { get; }
            public Quaternion Rotation { get; }
            public Vector3 LinearVelocity { get; }
            public Vector3 AngularVelocity { get; }
            public Vector3 HalfExtents { get; }
            public float Radius { get; }
            public float Density { get; }
            public float Friction { get; }
            public float Restitution { get; }
            public float LinearDamping { get; }
            public float AngularDamping { get; }
            public bool CanSleep { get; }
            public bool CcdEnabled { get; }

            private ObjectPhysicsDefinition(
                bool enabled,
                bool isStatic,
                PhysicsShape shape,
                Vector3 position,
                Quaternion rotation,
                Vector3 linearVelocity,
                Vector3 angularVelocity,
                Vector3 halfExtents,
                float radius,
                float density,
                float friction,
                float restitution,
                float linearDamping,
                float angularDamping,
                bool canSleep,
                bool ccdEnabled)
            {
                Enabled = enabled;
                IsStatic = isStatic;
                Shape = shape;
                Position = position;
                Rotation = rotation;
                LinearVelocity = linearVelocity;
                AngularVelocity = angularVelocity;
                HalfExtents = halfExtents;
                Radius = radius;
                Density = density;
                Friction = friction;
                Restitution = restitution;
                LinearDamping = linearDamping;
                AngularDamping = angularDamping;
                CanSleep = canSleep;
                CcdEnabled = ccdEnabled;
            }

            public static ObjectPhysicsDefinition Parse(string json, Transform transform)
            {
                if (string.IsNullOrWhiteSpace(json) || json.Trim() == "null")
                    return default;

                var enabled = ReadBool(json, "enabled", true);
                var bodyType = SceneSyncWireJson.ExtractString(json, "bodyType")
                    ?? SceneSyncWireJson.ExtractString(json, "type")
                    ?? "dynamic";
                var mass = Mathf.Max(0f, ReadFloat(json, "mass", 1f));
                var explicitStatic = ReadBool(json, "static", false);
                var isStatic = explicitStatic
                    || mass <= 0f
                    || string.Equals(bodyType, "static", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(bodyType, "fixed", StringComparison.OrdinalIgnoreCase);
                var shapeName = SceneSyncWireJson.ExtractString(json, "shape") ?? "box";
                var shape = string.Equals(shapeName, "sphere", StringComparison.OrdinalIgnoreCase)
                    ? PhysicsShape.Sphere
                    : PhysicsShape.Box;

                var initial = SceneSyncWireJson.ExtractTopLevelRawObject(json, "initialTransform");
                var position = !string.IsNullOrWhiteSpace(initial)
                    ? ReadVector3(initial, "position", Vector3.zero)
                    : UnityToWirePosition(transform.position);
                var rotation = !string.IsNullOrWhiteSpace(initial)
                    ? ReadQuaternion(initial, "rotation", Quaternion.identity)
                    : UnityToWireRotation(transform.rotation);
                var scale = !string.IsNullOrWhiteSpace(initial)
                    ? ReadVector3(initial, "scale", transform.localScale)
                    : transform.localScale;
                scale = new Vector3(Mathf.Abs(scale.x), Mathf.Abs(scale.y), Mathf.Abs(scale.z));

                var defaultHalfExtents = new Vector3(
                    Mathf.Max(0.01f, scale.x / 2f),
                    Mathf.Max(0.01f, scale.y / 2f),
                    Mathf.Max(0.01f, scale.z / 2f));
                var halfExtents = ReadVector3(json, "halfExtents", defaultHalfExtents);
                halfExtents = new Vector3(
                    Mathf.Max(0.000001f, halfExtents.x),
                    Mathf.Max(0.000001f, halfExtents.y),
                    Mathf.Max(0.000001f, halfExtents.z));

                var radius = Mathf.Max(
                    0.000001f,
                    ReadFloat(json, "radius", Mathf.Max(scale.x, Mathf.Max(scale.y, scale.z)) / 2f));
                var density = isStatic ? 0f : Mathf.Max(0f, ReadFloat(json, "density", mass));

                return new ObjectPhysicsDefinition(
                    enabled,
                    isStatic,
                    shape,
                    position,
                    rotation,
                    isStatic ? Vector3.zero : ReadVector3(json, "velocity", ReadVector3(json, "linearVelocity", Vector3.zero)),
                    isStatic ? Vector3.zero : ReadVector3(json, "angularVelocity", Vector3.zero),
                    halfExtents,
                    radius,
                    density,
                    Mathf.Clamp(ReadFloat(json, "friction", 0.5f), 0f, 4f),
                    Mathf.Clamp(ReadFloat(json, "restitution", 0.2f), 0f, 1f),
                    Mathf.Max(0f, ReadFloat(json, "linearDamping", 0f)),
                    Mathf.Max(0f, ReadFloat(json, "angularDamping", 0f)),
                    ReadBool(json, "canSleep", true),
                    ReadBool(json, "ccd", ReadBool(json, "ccdEnabled", false)));
            }
        }
    }
}
