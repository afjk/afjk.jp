using UnityEditor;
using UnityEngine;

namespace Afjk.SceneSync.Editor
{
    public static class SceneSyncPickingUtility
    {
        public static void ApplyImportedChildPicking(SceneSyncIdentity identity)
        {
            if (identity == null) return;
            if (identity.Origin != SceneSyncOrigin.Remote) return;
            if (!identity.Temporary) return;

            var root = identity.gameObject;
            if (root == null) return;

            var sceneVisibilityManager = SceneVisibilityManager.instance;
            if (sceneVisibilityManager == null) return;

            // The Scene Sync root should remain selectable/pickable.
            sceneVisibilityManager.EnablePicking(root, false);

            var transforms = root.GetComponentsInChildren<Transform>(true);
            foreach (var t in transforms)
            {
                if (t == null) continue;
                if (t.gameObject == root) continue;

                // Apply to each descendant explicitly.
                sceneVisibilityManager.DisablePicking(t.gameObject, false);
            }
        }

        public static void RestoreImportedChildPicking(SceneSyncIdentity identity)
        {
            if (identity == null) return;

            var root = identity.gameObject;
            if (root == null) return;

            var sceneVisibilityManager = SceneVisibilityManager.instance;
            if (sceneVisibilityManager == null) return;

            var transforms = root.GetComponentsInChildren<Transform>(true);
            foreach (var t in transforms)
            {
                if (t == null) continue;
                if (t.gameObject == root) continue;

                // Restore each descendant explicitly.
                sceneVisibilityManager.EnablePicking(t.gameObject, false);
            }

            // The Scene Sync root should remain selectable/pickable.
            sceneVisibilityManager.EnablePicking(root, false);
        }
    }
}
