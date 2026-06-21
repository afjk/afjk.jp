using UnityEngine;

namespace Afjk.SceneSync
{
    [DisallowMultipleComponent]
    public sealed class SceneSyncPhysicsMetadata : MonoBehaviour
    {
        [SerializeField] private string scenePhysicsJson;
        [SerializeField] private string objectPhysicsJson;

        public string ScenePhysicsJson
        {
            get => scenePhysicsJson;
            set => scenePhysicsJson = Normalize(value);
        }

        public string ObjectPhysicsJson
        {
            get => objectPhysicsJson;
            set => objectPhysicsJson = Normalize(value);
        }

        public bool HasScenePhysics => !string.IsNullOrWhiteSpace(scenePhysicsJson);
        public bool HasObjectPhysics => !string.IsNullOrWhiteSpace(objectPhysicsJson);

        public void ConfigureScenePhysics(string rawJson)
        {
            scenePhysicsJson = Normalize(rawJson);
        }

        public void ConfigureObjectPhysics(string rawJson)
        {
            objectPhysicsJson = Normalize(rawJson);
        }

        public void ClearObjectPhysics()
        {
            objectPhysicsJson = null;
        }

        private static string Normalize(string rawJson)
        {
            if (string.IsNullOrWhiteSpace(rawJson)) return null;
            var trimmed = rawJson.Trim();
            return trimmed == "null" ? null : trimmed;
        }
    }
}
