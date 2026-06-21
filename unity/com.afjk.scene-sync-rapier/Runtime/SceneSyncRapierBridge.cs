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
        private const string GroundStableId = "__scenesync_ground__";

        [SerializeField] private bool autoRun = true;
        [SerializeField] private bool applyDynamicTransforms = true;
        [SerializeField] private bool includeGround = true;
        [SerializeField] private float metadataScanInterval = 0.5f;
        [SerializeField] private float maxFrameStepSeconds = 0.25f;
        [SerializeField] private bool logStateHash;

        private readonly Dictionary<string, string> objectPhysicsJson = new Dictionary<string, string>(StringComparer.Ordinal);
        private readonly Dictionary<string, BodyBinding> bindings = new Dictionary<string, BodyBinding>(StringComparer.Ordinal);

        private RapierWorld world;
        private ScenePhysicsDefinition scenePhysics = ScenePhysicsDefinition.Disabled;
        private bool dirty = true;
        private float accumulator;
        private int tick;
        private float nextMetadataScanAt;
        private string lastStateHash;

        public int Tick => tick;
        public string LastStateHash => lastStateHash;
        public bool HasWorld => world != null && world.IsCreated;

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

            var frameTime = Mathf.Min(Mathf.Max(0f, Time.unscaledDeltaTime), Mathf.Max(0f, maxFrameStepSeconds));
            accumulator += frameTime;
            var timestep = Mathf.Max(0.000001f, scenePhysics.Timestep);
            var maxSteps = Mathf.Max(1, Mathf.CeilToInt(Mathf.Max(0.001f, maxFrameStepSeconds) / timestep));
            var steps = 0;

            while (accumulator + 0.0000001f >= timestep && steps < maxSteps)
            {
                if (!world.Step()) break;
                accumulator -= timestep;
                tick++;
                steps++;
            }

            if (steps > 0)
            {
                ApplyWorldTransforms();
                if (logStateHash)
                {
                    lastStateHash = world.StateHash().ToString("x16", CultureInfo.InvariantCulture);
                    Debug.Log("[SceneSyncRapier] tick=" + tick + " stateHash=" + lastStateHash);
                }
            }
        }

        public void MarkDirty()
        {
            dirty = true;
        }

        public void RebuildWorld()
        {
            dirty = false;
            accumulator = 0f;
            tick = 0;
            lastStateHash = null;
            bindings.Clear();
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
                    CreateBody(candidate);
                }

                ApplyWorldTransforms();
            }
            catch (Exception error)
            {
                Debug.LogWarning("[SceneSyncRapier] Failed to rebuild Rapier world: " + error.Message);
                DisposeWorld();
                bindings.Clear();
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
                if (SceneSyncWireJson.HasTopLevelField(raw, "physics"))
                    scenePhysics = ScenePhysicsDefinition.Parse(SceneSyncWireJson.ExtractTopLevelRawValue(raw, "physics"));

                foreach (var entry in SceneSyncWireJson.ExtractObjectMapEntries(raw, "objects"))
                {
                    ApplyObjectPhysicsJson(entry.Key, entry.Value);
                }

                dirty = true;
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

        private void CreateBody(BodyCandidate candidate)
        {
            var definition = candidate.Definition;
            var body = world.CreateRigidBody(new RapierBodyDesc
            {
                BodyType = definition.IsStatic ? RapierRigidBodyType.Fixed : RapierRigidBodyType.Dynamic,
                Position = definition.Position,
                Rotation = definition.Rotation,
                LinearVelocity = definition.IsStatic ? Vector3.zero : definition.LinearVelocity,
                AngularVelocity = definition.IsStatic ? Vector3.zero : definition.AngularVelocity,
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

        private void DisposeWorld()
        {
            if (world == null) return;
            world.Dispose();
            world = null;
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

        private static bool ReadBool(string json, string field, bool fallback)
        {
            var value = SceneSyncWireJson.ExtractBoolean(json, field);
            return value ?? fallback;
        }

        private static bool IsFinite(float value)
        {
            return !float.IsNaN(value) && !float.IsInfinity(value);
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
