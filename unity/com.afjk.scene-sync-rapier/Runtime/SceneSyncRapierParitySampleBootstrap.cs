using System.Threading.Tasks;
using Afjk.SceneSync;
using UnityEngine;

namespace Afjk.SceneSync.Rapier
{
    [DisallowMultipleComponent]
    public sealed class SceneSyncRapierParitySampleBootstrap : MonoBehaviour
    {
        private const string ScenePhysicsJson =
            "{\"version\":1,\"enabled\":true,\"duration\":10,\"worldOptions\":{\"gravity\":[0,-9.81,0],\"ground\":null,\"timestep\":0.016666666666666666}}";

        private const string FloorPhysicsJson =
            "{\"version\":1,\"enabled\":true,\"bodyType\":\"static\",\"shape\":\"box\",\"halfExtents\":[6,0.5,6],\"density\":0,\"friction\":0.5,\"restitution\":0.2,\"initialTransform\":{\"position\":[0,-0.5,0],\"rotation\":[0,0,0,1],\"scale\":[12,1,12]}}";

        private const string BoxPhysicsJson =
            "{\"version\":1,\"enabled\":true,\"bodyType\":\"dynamic\",\"shape\":\"box\",\"halfExtents\":[0.5,0.5,0.5],\"density\":1,\"friction\":0.5,\"restitution\":0.2,\"velocity\":[0.75,0,0.15],\"angularVelocity\":[0.35,1.25,0.55],\"linearDamping\":0.02,\"angularDamping\":0.02,\"canSleep\":false,\"ccd\":false,\"initialTransform\":{\"position\":[-0.75,5,0],\"rotation\":[0,0,0,1],\"scale\":[1,1,1]}}";

        [SerializeField] private string presenceUrl = "wss://afjk.jp/presence";
        [SerializeField] private string room = "rapier-parity";
        [SerializeField] private string nickname = "Unity Rapier Sample";
        [SerializeField] private bool autoConnect = true;
        [SerializeField] private bool buildOnStart = true;
        [SerializeField] private bool requireSceneClock = true;
        [SerializeField] private bool showHud = true;

        private SceneSyncManager manager;
        private SceneSyncRapierBridge bridge;
        private GameObject floorObject;
        private GameObject boxObject;

        public string PresenceUrl
        {
            get => presenceUrl;
            set => presenceUrl = value ?? "";
        }

        public string Room
        {
            get => room;
            set => room = value ?? "";
        }

        public string Nickname
        {
            get => nickname;
            set => nickname = string.IsNullOrWhiteSpace(value) ? "Unity Rapier Sample" : value.Trim();
        }

        public bool AutoConnect
        {
            get => autoConnect;
            set => autoConnect = value;
        }

        public bool BuildOnStart
        {
            get => buildOnStart;
            set => buildOnStart = value;
        }

        public bool RequireSceneClock
        {
            get => requireSceneClock;
            set => requireSceneClock = value;
        }

        public SceneSyncManager Manager => manager;
        public SceneSyncRapierBridge Bridge => bridge;

        private async void Start()
        {
            if (buildOnStart)
                BuildSampleScene();

            if (autoConnect)
                await Connect();
        }

        public void BuildSampleScene()
        {
            manager = EnsureComponent<SceneSyncManager>();
            manager.PresenceUrl = presenceUrl;
            manager.ConfiguredRoom = room;
            manager.Nickname = nickname;
            manager.AutoConnect = false;
            manager.SyncHierarchy = false;
            manager.IncludeManagerChildren = true;

            var sceneMetadata = EnsureComponent<SceneSyncPhysicsMetadata>();
            sceneMetadata.ConfigureScenePhysics(ScenePhysicsJson);

            bridge = EnsureComponent<SceneSyncRapierBridge>();
            bridge.BodyRoot = transform;
            bridge.AutoRun = true;
            bridge.UseSceneClock = true;
            bridge.RequireSceneClock = requireSceneClock;
            bridge.PreserveMotionOnRebuild = false;

            floorObject = CreateOrUpdateBody(
                "floor",
                "Rapier Sample Floor",
                PrimitiveType.Cube,
                new Vector3(0f, -0.5f, 0f),
                Quaternion.identity,
                new Vector3(12f, 1f, 12f),
                FloorPhysicsJson,
                new Color(0.42f, 0.46f, 0.48f));

            boxObject = CreateOrUpdateBody(
                "box-1",
                "Rapier Sample Box",
                PrimitiveType.Cube,
                new Vector3(-0.75f, 5f, 0f),
                Quaternion.identity,
                Vector3.one,
                BoxPhysicsJson,
                new Color(0.16f, 0.42f, 0.88f));

            AddManagedObject(floorObject);
            AddManagedObject(boxObject);
            bridge.RebuildWorld();
        }

        public async Task Connect()
        {
            if (manager == null)
                BuildSampleScene();

            await manager.Connect();
        }

        public void Disconnect()
        {
            manager?.Disconnect();
        }

        private T EnsureComponent<T>() where T : Component
        {
            var component = GetComponent<T>();
            return component != null ? component : gameObject.AddComponent<T>();
        }

        private GameObject CreateOrUpdateBody(
            string objectId,
            string objectName,
            PrimitiveType primitiveType,
            Vector3 position,
            Quaternion rotation,
            Vector3 scale,
            string physicsJson,
            Color color)
        {
            var body = FindChildByObjectId(objectId);
            if (body == null)
            {
                body = GameObject.CreatePrimitive(primitiveType);
                body.transform.SetParent(transform, false);
            }

            body.name = objectName;
            body.transform.SetPositionAndRotation(position, rotation);
            body.transform.localScale = scale;

            var unityCollider = body.GetComponent<Collider>();
            if (unityCollider != null)
                DestroyComponent(unityCollider);

            var renderer = body.GetComponent<Renderer>();
            if (renderer != null)
            {
                var material = renderer.sharedMaterial;
                if (material == null || material.name.StartsWith("Default-", System.StringComparison.Ordinal))
                {
                    var shader = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
                    material = shader != null ? new Material(shader) : new Material(Shader.Find("Sprites/Default"));
                    renderer.sharedMaterial = material;
                }

                material.color = color;
            }

            var identity = body.GetComponent<SceneSyncIdentity>();
            if (identity == null)
                identity = body.AddComponent<SceneSyncIdentity>();
            identity.ConfigureUnityManaged(objectId);

            var metadata = body.GetComponent<SceneSyncPhysicsMetadata>();
            if (metadata == null)
                metadata = body.AddComponent<SceneSyncPhysicsMetadata>();
            metadata.ConfigureObjectPhysics(physicsJson);

            return body;
        }

        private GameObject FindChildByObjectId(string objectId)
        {
            foreach (var identity in GetComponentsInChildren<SceneSyncIdentity>(true))
            {
                if (identity != null && identity.ObjectId == objectId)
                    return identity.gameObject;
            }

            return null;
        }

        private void AddManagedObject(GameObject body)
        {
            if (body == null || manager == null || manager.ManagedObjects.Contains(body))
                return;

            manager.ManagedObjects.Add(body);
        }

        private static void DestroyComponent(Component component)
        {
            if (Application.isPlaying)
                Destroy(component);
            else
                DestroyImmediate(component);
        }

        private void OnGUI()
        {
            if (!showHud || bridge == null)
                return;

            GUILayout.BeginArea(new Rect(12f, 12f, 520f, 140f), GUI.skin.box);
            GUILayout.Label("SceneSync Rapier Parity Sample");
            GUILayout.Label("Room: " + room);
            GUILayout.Label("Connected: " + (manager != null && manager.IsConnected));
            GUILayout.Label("Tick: " + bridge.Tick);
            GUILayout.Label("Hash: " + (bridge.LastStateHash ?? "(none)"));
            GUILayout.Label("Remote hash matched: " + bridge.LastRemoteHashMatched);
            GUILayout.EndArea();
        }
    }
}
