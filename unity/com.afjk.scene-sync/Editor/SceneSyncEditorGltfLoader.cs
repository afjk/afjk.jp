using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using GLTFast;
using UnityEngine;

namespace Afjk.SceneSync.Editor
{
    internal static class SceneSyncEditorGltfLoader
    {
        internal const string TempFilePrefix = "scenesync-editor-import-";

        private sealed class ActiveImport
        {
            internal GameObject Root { get; }
            internal GltfImport Import { get; }

            internal ActiveImport(GameObject root, GltfImport import)
            {
                Root = root;
                Import = import;
            }
        }

        private static readonly Dictionary<int, ActiveImport> ActiveImports =
            new Dictionary<int, ActiveImport>();

        internal static async Task<GameObject> LoadAsync(
            byte[] glbBytes,
            string name,
            bool applyUnityImportYawCorrection)
        {
            if (glbBytes == null || glbBytes.Length == 0)
            {
                throw new ArgumentException("GLB data is empty.", nameof(glbBytes));
            }

            PruneDestroyedImports();

            var tempPath = Path.Combine(
                Application.temporaryCachePath,
                TempFilePrefix + Guid.NewGuid().ToString("N") + ".glb");
            GltfImport gltf = null;
            GameObject pendingObject = null;

            try
            {
                File.WriteAllBytes(tempPath, glbBytes);

                var importSettings = new ImportSettings
                {
                    AnimationMethod = AnimationMethod.None,
                };
                gltf = new GltfImport(
                    downloadProvider: null,
                    deferAgent: new UninterruptedDeferAgent());

                var loaded = await gltf.Load(new Uri(tempPath).AbsoluteUri, importSettings);
                if (!loaded)
                {
                    return null;
                }

                pendingObject = new GameObject(name);
                var importedGlbRoot = new GameObject("ImportedGlbRoot");
                importedGlbRoot.transform.SetParent(pendingObject.transform, worldPositionStays: false);
                importedGlbRoot.transform.localPosition = Vector3.zero;
                importedGlbRoot.transform.localRotation = applyUnityImportYawCorrection
                    ? Quaternion.Euler(0f, 180f, 0f)
                    : Quaternion.identity;
                importedGlbRoot.transform.localScale = Vector3.one;

                // A default scene is optional in glTF. Prefer it when present and fall
                // back to scene 0 so otherwise valid files still instantiate.
                var sceneIndex = gltf.DefaultSceneIndex ?? (gltf.SceneCount > 0 ? 0 : (int?)null);
                if (!sceneIndex.HasValue ||
                    !await gltf.InstantiateSceneAsync(importedGlbRoot.transform, sceneIndex.Value))
                {
                    return null;
                }

                // Instantiated renderers reference meshes and materials owned by GltfImport.
                // Keep it alive until the corresponding temporary object is destroyed.
                ActiveImports[pendingObject.GetInstanceID()] = new ActiveImport(pendingObject, gltf);
                gltf = null;

                var result = pendingObject;
                pendingObject = null;
                return result;
            }
            finally
            {
                try
                {
                    if (pendingObject != null)
                    {
                        UnityEngine.Object.DestroyImmediate(pendingObject);
                    }
                }
                catch (Exception ex)
                {
                    Debug.LogWarning("[SceneSync] Failed to destroy partial GLB object: " + ex.Message);
                }

                TryDispose(gltf);

                try
                {
                    if (File.Exists(tempPath))
                    {
                        File.Delete(tempPath);
                    }
                }
                catch (Exception ex)
                {
                    Debug.LogWarning("[SceneSync] Failed to delete temporary GLB: " + ex.Message);
                }
            }
        }

        internal static void Release(GameObject root)
        {
            if (root == null) return;

            var instanceId = root.GetInstanceID();
            if (!ActiveImports.TryGetValue(instanceId, out var activeImport)) return;

            ActiveImports.Remove(instanceId);
            TryDispose(activeImport.Import);
        }

        private static void PruneDestroyedImports()
        {
            if (ActiveImports.Count == 0) return;

            var destroyedInstanceIds = new List<int>();
            foreach (var entry in ActiveImports)
            {
                if (entry.Value.Root == null)
                {
                    TryDispose(entry.Value.Import);
                    destroyedInstanceIds.Add(entry.Key);
                }
            }

            foreach (var instanceId in destroyedInstanceIds)
            {
                ActiveImports.Remove(instanceId);
            }
        }

        private static void TryDispose(GltfImport gltf)
        {
            if (gltf == null) return;

            try
            {
                gltf.Dispose();
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[SceneSync] Failed to dispose GLB import resources: " + ex.Message);
            }
        }
    }
}
