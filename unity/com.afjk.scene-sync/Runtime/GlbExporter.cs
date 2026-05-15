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
#if UNITY_EDITOR && SCENESYNC_USE_UNITYGLTF
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
#if UNITY_EDITOR && SCENESYNC_USE_UNITYGLTF
                return SceneSyncGlbExportBackend.UnityGltf;
#else
                Debug.LogWarning(
                    "[SceneSync] UnityGLTF exporter is not enabled. " +
                    "Falling back to glTFast; animations will not be exported."
                );
                return SceneSyncGlbExportBackend.GltfFast;
#endif
            }

            if (ConfiguredBackend != SceneSyncGlbExportBackend.Auto)
            {
#if !UNITY_EDITOR
                if (ConfiguredBackend == SceneSyncGlbExportBackend.UnityGltf)
                {
                    Debug.LogWarning(
                        "[SceneSync] UnityGLTF export is Editor-only. " +
                        "Falling back to glTFast in runtime/player builds."
                    );
                    return SceneSyncGlbExportBackend.GltfFast;
                }
#endif
                return ConfiguredBackend;
            }

#if UNITY_EDITOR && SCENESYNC_USE_UNITYGLTF
            if (HasExportableAnimation(root))
            {
                Debug.Log("[SceneSync] Animation detected. Using UnityGLTF exporter.");
                return SceneSyncGlbExportBackend.UnityGltf;
            }
#else
            if (HasExportableAnimation(root))
            {
                Debug.LogWarning(
                    "[SceneSync] Animation detected, but animated GLB export is Editor-only " +
                    "and requires UnityGLTF. Falling back to glTFast; animations will not be exported."
                );
            }
#endif

            return SceneSyncGlbExportBackend.GltfFast;
        }

        private static bool HasExportableAnimation(GameObject root)
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

#if UNITY_EDITOR && SCENESYNC_USE_UNITYGLTF
        private static Task<byte[]> ExportWithUnityGltf(GameObject go)
        {
            try
            {
                var context = new UnityGLTF.ExportContext();
                var exporter = new UnityGLTF.GLTFSceneExporter(
                    new[] { go.transform },
                    context
                );

                var bytes = exporter.SaveGLBToByteArray(go.name);

                Debug.Log("[SceneSync] Export backend: UnityGLTF with animations.");
                return Task.FromResult(bytes);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[SceneSync] UnityGLTF export failed: " + ex.Message);
                return Task.FromResult<byte[]>(null);
            }
        }
#endif
    }
}

