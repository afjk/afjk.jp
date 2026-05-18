using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using GLTFast.Export;
using UnityEngine;

namespace Afjk.SceneSync
{
    public enum SceneSyncGlbExportBackend
    {
        Auto,
        GltfFast,
        UnityGltf
    }

    public static class GlbExporter
    {
        public static SceneSyncGlbExportBackend ConfiguredBackend { get; set; } = SceneSyncGlbExportBackend.Auto;

#if UNITY_EDITOR
        public static Func<GameObject, byte[]> UnityGltfExportHandler { get; set; }

        public static bool IsUnityGltfExportAvailable => UnityGltfExportHandler != null;

        public static bool ShouldRecommendUnityGltf(GameObject root)
        {
            return HasExportableAnimation(root) && UnityGltfExportHandler == null;
        }
#endif

        public static async Task<byte[]> ExportGameObjectAsGlb(GameObject go)
        {
            var backend = ResolveExportBackend(go);
            return await ExportGameObjectAsGlb(go, backend);
        }

        public static async Task<byte[]> ExportGameObjectAsGlb(GameObject go, SceneSyncGlbExportBackend backend)
        {
            var originalPos = go.transform.position;
            var originalRot = go.transform.rotation;
            var originalScale = go.transform.localScale;

            try
            {
                go.transform.position = Vector3.zero;
                go.transform.rotation = Quaternion.identity;
                go.transform.localScale = Vector3.one;

                if (backend == SceneSyncGlbExportBackend.GltfFast)
                {
                    return await ExportWithGltfFast(go);
                }
#if UNITY_EDITOR
                else if (backend == SceneSyncGlbExportBackend.UnityGltf)
                {
                    return await ExportWithUnityGltf(go);
                }
#endif

                Debug.LogWarning("[SceneSync] Invalid export backend: " + backend);
                return null;
            }
            finally
            {
                go.transform.position = originalPos;
                go.transform.rotation = originalRot;
                go.transform.localScale = originalScale;
            }
        }

        private static SceneSyncGlbExportBackend ResolveExportBackend(GameObject root)
        {
            if (ConfiguredBackend == SceneSyncGlbExportBackend.UnityGltf)
            {
#if UNITY_EDITOR
                if (UnityGltfExportHandler != null)
                    return SceneSyncGlbExportBackend.UnityGltf;

                Debug.LogWarning(
                    "[SceneSync] UnityGLTF exporter handler is not registered. " +
                    "Falling back to glTFast; animations will not be exported."
                );
#else
                Debug.LogWarning(
                    "[SceneSync] UnityGLTF export is Editor-only. " +
                    "Falling back to glTFast in runtime/player builds."
                );
#endif
                return SceneSyncGlbExportBackend.GltfFast;
            }

            if (ConfiguredBackend != SceneSyncGlbExportBackend.Auto)
                return ConfiguredBackend;

#if UNITY_EDITOR
            if (HasExportableAnimation(root))
            {
                if (UnityGltfExportHandler != null)
                {
                    Debug.Log("[SceneSync] Animation detected. Using UnityGLTF exporter.");
                    return SceneSyncGlbExportBackend.UnityGltf;
                }

                Debug.LogWarning(
                    "[SceneSync] Animation detected, but UnityGLTF exporter handler is not registered. " +
                    "Falling back to glTFast; animations will not be exported."
                );
            }
#else
            if (HasExportableAnimation(root))
            {
                Debug.LogWarning(
                    "[SceneSync] Animation detected, but animated GLB export is Editor-only. " +
                    "Falling back to glTFast; animations will not be exported."
                );
            }
#endif

            return SceneSyncGlbExportBackend.GltfFast;
        }

        public static bool HasExportableAnimation(GameObject root)
        {
            if (!root) return false;

            foreach (var animator in root.GetComponentsInChildren<Animator>(true))
            {
                var controller = animator.runtimeAnimatorController;
                if (controller?.animationClips != null && controller.animationClips.Length > 0)
                    return true;
            }

            foreach (var animation in root.GetComponentsInChildren<Animation>(true))
            {
                foreach (AnimationState state in animation)
                {
                    if (state?.clip != null)
                        return true;
                }
            }

#if UNITY_EDITOR
            foreach (var director in root.GetComponentsInChildren<UnityEngine.Playables.PlayableDirector>(true))
            {
                if (director.playableAsset != null)
                    return true;
            }
#endif

            return false;
        }

        private static async Task<byte[]> ExportWithGltfFast(GameObject go)
        {
            try
            {
                var exportSettings = new ExportSettings
                {
                    Format = GltfFormat.Binary,
                    FileConflictResolution = FileConflictResolution.Overwrite,
                };
                var goSettings = new GameObjectExportSettings
                {
                    OnlyActiveInHierarchy = false,
                };
                var export = new GameObjectExport(exportSettings, goSettings);
                export.AddScene(new[] { go }, go.name);

                using var stream = new MemoryStream();
                var success = await export.SaveToStreamAndDispose(stream);
                if (!success)
                {
                    Debug.LogWarning("[SceneSync] glTFast export returned false for: " + go.name);
                    return null;
                }
                Debug.Log("[SceneSync] Export backend: glTFast.");
                return stream.ToArray();
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[SceneSync] glTFast export failed: " + ex.Message);
                return null;
            }
        }

#if UNITY_EDITOR
        private static async Task<byte[]> ExportWithUnityGltf(GameObject go)
        {
            if (UnityGltfExportHandler == null)
            {
                Debug.LogWarning(
                    "[SceneSync] UnityGLTF exporter handler is not registered. " +
                    "Falling back to glTFast; animations will not be exported."
                );
                return await ExportWithGltfFast(go);
            }

            try
            {
                var bytes = UnityGltfExportHandler(go);
                Debug.Log("[SceneSync] Export backend: UnityGLTF with animations.");
                return bytes;
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[SceneSync] UnityGLTF export failed: " + ex.Message);
                return await ExportWithGltfFast(go);
            }
        }
#endif
    }
}
