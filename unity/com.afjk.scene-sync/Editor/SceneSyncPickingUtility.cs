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

            sceneVisibilityManager.EnablePicking(root, false);

            foreach (Transform child in root.transform)
            {
                if (child == null) continue;
                sceneVisibilityManager.DisablePicking(child.gameObject, true);
            }
        }

        public static void RestoreImportedChildPicking(SceneSyncIdentity identity)
        {
            if (identity == null) return;

            var root = identity.gameObject;
            if (root == null) return;

            var sceneVisibilityManager = SceneVisibilityManager.instance;
            if (sceneVisibilityManager == null) return;

            foreach (Transform child in root.transform)
            {
                if (child == null) continue;
                sceneVisibilityManager.EnablePicking(child.gameObject, true);
            }

            sceneVisibilityManager.EnablePicking(root, false);
        }
    }
}
