using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Afjk.SceneSync.Editor
{
    [CustomEditor(typeof(SceneSyncIdentity))]
    public class SceneSyncIdentityEditor : UnityEditor.Editor
    {
        public override void OnInspectorGUI()
        {
            var identity = (SceneSyncIdentity)target;

            EditorGUILayout.LabelField("Scene Sync Identity", EditorStyles.boldLabel);
            EditorGUILayout.Space(4);

            EditorGUILayout.LabelField(
                "Object ID",
                string.IsNullOrWhiteSpace(identity.ObjectId) ? "(none)" : identity.ObjectId
            );
            EditorGUILayout.LabelField("Origin", identity.Origin.ToString());
            EditorGUILayout.LabelField("Temporary", identity.Temporary ? "true" : "false");
            EditorGUILayout.LabelField("State", identity.State.ToString());
            EditorGUILayout.LabelField(
                "Lock Owner",
                string.IsNullOrWhiteSpace(identity.LockOwner) ? "(none)" : identity.LockOwner
            );

            EditorGUILayout.Space(8);

            if (string.IsNullOrWhiteSpace(identity.ObjectId))
            {
                EditorGUILayout.HelpBox(
                    "This object has SceneSyncIdentity but no ObjectId. If this is a Unity-managed object, use Add Selected to Managed or Publish Selected from the Scene Sync window.",
                    MessageType.Warning
                );
            }
            else if (identity.Origin == SceneSyncOrigin.Unity && !identity.Temporary)
            {
                EditorGUILayout.HelpBox(
                    "Unity-origin Scene Sync object. This object can be published and transformed from Unity.",
                    MessageType.Info
                );
            }
            else if (identity.Origin == SceneSyncOrigin.Remote && identity.Temporary)
            {
                EditorGUILayout.HelpBox(
                    "Remote temporary Scene Sync object. This object came from Scene Sync and will be removed on manual disconnect. Move the root object, not its imported children.",
                    MessageType.Info
                );
            }
            else
            {
                EditorGUILayout.HelpBox("Scene Sync object with custom state.", MessageType.Info);
            }

            if (HasSelectedChild(identity.gameObject))
            {
                EditorGUILayout.Space(8);
                EditorGUILayout.HelpBox(
                    "A child of this Scene Sync object is selected. Move the root object for Scene Sync transform synchronization.",
                    MessageType.Warning
                );

                if (GUILayout.Button("Select Scene Sync Root"))
                {
                    Selection.activeGameObject = identity.gameObject;
                    EditorGUIUtility.PingObject(identity.gameObject);
                }
            }
        }

        private static bool HasSelectedChild(GameObject root)
        {
            foreach (var selected in Selection.gameObjects)
            {
                if (selected == null) continue;
                if (selected != root && selected.transform.IsChildOf(root.transform))
                {
                    return true;
                }
            }

            return false;
        }
    }

    [InitializeOnLoad]
    public static class SceneSyncIdentitySceneViewOverlay
    {
        private static readonly Color UnityManagedColor = new Color(0.2f, 0.8f, 1.0f, 0.85f);
        private static readonly Color RemoteTemporaryColor = new Color(1.0f, 0.65f, 0.2f, 0.85f);

        static SceneSyncIdentitySceneViewOverlay()
        {
            SceneView.duringSceneGui += OnSceneGui;
        }

        private static void OnSceneGui(SceneView sceneView)
        {
            var activeScene = SceneManager.GetActiveScene();
            var identities = UnityEngine.Object.FindObjectsOfType<SceneSyncIdentity>();

            if (SceneSyncWindow.ShowSceneSyncGizmos)
            {
                DrawSceneSyncWireGizmos(activeScene, identities);
            }

            foreach (var identity in identities)
            {
                if (identity == null) continue;

                var root = identity.gameObject;
                if (!activeScene.IsValid() || root.scene != activeScene) continue;
                if (!IsIdentityRoot(root)) continue;
                if (!IsSelectedOrParentOfSelection(root)) continue;

                var label = BuildLabel(identity);
                if (IsChildSelection(root))
                {
                    label += "\nSelected child. Move root for sync.";
                }

                Handles.Label(GetLabelPosition(root), label);
            }

            var childOwnerRoot = GetSelectedSceneSyncRootChildOwner();
            if (childOwnerRoot != null)
            {
                DrawSelectRootButton(sceneView, childOwnerRoot);
            }
        }

        private static void DrawSceneSyncWireGizmos(Scene scene, SceneSyncIdentity[] identities)
        {
            foreach (var identity in identities)
            {
                if (!ShouldDrawWire(scene, identity)) continue;
                DrawWireForIdentity(identity);
            }
        }

        private static bool ShouldDrawWire(Scene scene, SceneSyncIdentity identity)
        {
            if (identity == null) return false;
            if (identity.gameObject == null) return false;
            if (!scene.IsValid() || identity.gameObject.scene != scene) return false;
            if (!IsIdentityRoot(identity.gameObject)) return false;

            return (identity.Origin == SceneSyncOrigin.Unity && !identity.Temporary)
                || (identity.Origin == SceneSyncOrigin.Remote && identity.Temporary);
        }

        private static void DrawWireForIdentity(SceneSyncIdentity identity)
        {
            var root = identity.gameObject;
            if (root == null) return;

            var color = GetIdentityColor(identity);
            using (new Handles.DrawingScope(color))
            {
                TryGetBounds(root, out var bounds);
                Handles.DrawWireCube(bounds.center, bounds.size);
            }
        }

        private static bool TryGetBounds(GameObject root, out Bounds bounds)
        {
            var renderers = root.GetComponentsInChildren<Renderer>(true);
            bounds = default;

            var hasBounds = false;
            foreach (var renderer in renderers)
            {
                if (renderer == null) continue;
                if (!hasBounds)
                {
                    bounds = renderer.bounds;
                    hasBounds = true;
                }
                else
                {
                    bounds.Encapsulate(renderer.bounds);
                }
            }

            if (hasBounds) return true;

            bounds = new Bounds(root.transform.position, Vector3.one * 0.5f);
            return false;
        }

        private static Color GetIdentityColor(SceneSyncIdentity identity)
        {
            if (identity.Origin == SceneSyncOrigin.Remote && identity.Temporary)
            {
                return RemoteTemporaryColor;
            }

            if (identity.Origin == SceneSyncOrigin.Unity && !identity.Temporary)
            {
                return UnityManagedColor;
            }

            return Color.gray;
        }

        private static bool IsIdentityRoot(GameObject go)
        {
            if (go == null) return false;
            if (go.GetComponent<SceneSyncIdentity>() == null) return false;

            var parent = go.transform.parent;
            if (parent == null) return true;

            return parent.GetComponentInParent<SceneSyncIdentity>() == null;
        }

        private static bool IsSelectedOrParentOfSelection(GameObject root)
        {
            foreach (var selected in Selection.gameObjects)
            {
                if (selected == null) continue;
                if (selected == root) return true;
                if (selected.transform.IsChildOf(root.transform)) return true;
            }

            return false;
        }

        private static bool IsChildSelection(GameObject root)
        {
            foreach (var selected in Selection.gameObjects)
            {
                if (selected == null) continue;
                if (selected != root && selected.transform.IsChildOf(root.transform)) return true;
            }

            return false;
        }

        private static GameObject GetSelectedSceneSyncRootChildOwner()
        {
            foreach (var selected in Selection.gameObjects)
            {
                if (selected == null) continue;

                var identity = selected.GetComponentInParent<SceneSyncIdentity>();
                if (identity == null) continue;

                var root = identity.gameObject;
                if (root == selected) continue;

                return root;
            }

            return null;
        }

        private static void DrawSelectRootButton(SceneView sceneView, GameObject root)
        {
            if (root == null) return;

            Handles.BeginGUI();

            var rect = new Rect(12f, 12f, 240f, 72f);
            GUILayout.BeginArea(rect, EditorStyles.helpBox);
            GUILayout.Label("Scene Sync child selected", EditorStyles.boldLabel);
            GUILayout.Label("Root: " + root.name, EditorStyles.miniLabel);

            if (GUILayout.Button("Select Scene Sync Root"))
            {
                Selection.activeGameObject = root;
                EditorGUIUtility.PingObject(root);
                sceneView.Repaint();
            }

            GUILayout.EndArea();
            Handles.EndGUI();
        }

        private static string BuildLabel(SceneSyncIdentity identity)
        {
            var origin = identity.Origin.ToString();
            var temp = identity.Temporary ? "Temporary" : "Persistent";
            var id = ShortId(identity.ObjectId);
            return "SceneSync\n" + origin + " / " + temp + "\n" + id;
        }

        private static string ShortId(string objectId)
        {
            if (string.IsNullOrWhiteSpace(objectId)) return "(no id)";
            return objectId.Length <= 12 ? objectId : objectId.Substring(0, 12) + "...";
        }

        private static Vector3 GetLabelPosition(GameObject go)
        {
            var renderers = go.GetComponentsInChildren<Renderer>();
            if (renderers.Length > 0)
            {
                var bounds = renderers[0].bounds;
                for (var i = 1; i < renderers.Length; i++)
                {
                    bounds.Encapsulate(renderers[i].bounds);
                }

                return bounds.center + Vector3.up * (bounds.extents.y + 0.25f);
            }

            return go.transform.position + Vector3.up * 0.5f;
        }
    }
}
