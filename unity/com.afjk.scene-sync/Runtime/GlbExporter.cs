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
        public static bool ApplyTransparentNameHintsForExport { get; set; } = false;
        private static readonly string[] TransparentNameHints =
        {
            "glass",
            "lens",
            "wing",
            "cheek",
            "shadow",
            "fade",
            "trans",
            "alpha",
            "semi",
        };

#if UNITY_EDITOR
        public static Func<GameObject, byte[]> UnityGltfExportHandler { get; set; }
        public static Func<GameObject, IDisposable> EditorExportPreparationHandler { get; set; }
        public static string LastExportPreferredAnimationClipName { get; set; }

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
#if UNITY_EDITOR
            LastExportPreferredAnimationClipName = null;
#endif
            var originalPos = go.transform.position;
            var originalRot = go.transform.rotation;
            var originalScale = go.transform.localScale;
            var editorExportPreparation = BeginEditorExportPreparation(go, backend);
            var materialRestores = BeginTemporaryTransparentMaterialOverrides(
                go,
                ApplyTransparentNameHintsForExport);

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
                RestoreTemporaryMaterialOverrides(materialRestores);
                editorExportPreparation?.Dispose();
            }
        }

        private static IDisposable BeginEditorExportPreparation(GameObject go, SceneSyncGlbExportBackend backend)
        {
#if UNITY_EDITOR
            if (backend != SceneSyncGlbExportBackend.UnityGltf || EditorExportPreparationHandler == null)
                return null;

            try
            {
                return EditorExportPreparationHandler(go);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[SceneSync] Editor export preparation failed: " + ex.Message);
            }
#endif

            return null;
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
                LastExportPreferredAnimationClipName = null;
                return await ExportWithGltfFast(go);
            }

            try
            {
                var bytes = UnityGltfExportHandler(go);
                if (bytes == null || bytes.Length == 0)
                {
                    LastExportPreferredAnimationClipName = null;
                    return bytes;
                }
                Debug.Log("[SceneSync] Export backend: UnityGLTF with animations.");
                return bytes;
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[SceneSync] UnityGLTF export failed: " + ex.Message);
                LastExportPreferredAnimationClipName = null;
                return await ExportWithGltfFast(go);
            }
        }
#endif

        private struct MaterialRestore
        {
            public Renderer Renderer;
            public Material[] Materials;
        }

        private static List<MaterialRestore> BeginTemporaryTransparentMaterialOverrides(
            GameObject root,
            bool applyNameHints)
        {
            var restores = new List<MaterialRestore>();
            if (root == null) return restores;

            foreach (var renderer in root.GetComponentsInChildren<Renderer>(true))
            {
                if (renderer == null) continue;

                var materials = renderer.sharedMaterials;
                if (materials == null || materials.Length == 0) continue;

                Material[] nextMaterials = null;
                for (var i = 0; i < materials.Length; i++)
                {
                    var material = materials[i];
                    if (!ShouldTreatAsTransparentForExport(material, applyNameHints)) continue;

                    if (nextMaterials == null)
                        nextMaterials = (Material[])materials.Clone();
                    var copy = new Material(material)
                    {
                        name = material.name
                    };
                    ConfigureTransparentMaterialForExport(copy);
                    nextMaterials[i] = copy;
                }

                if (nextMaterials == null) continue;

                restores.Add(new MaterialRestore
                {
                    Renderer = renderer,
                    Materials = materials,
                });
                renderer.sharedMaterials = nextMaterials;
            }

            return restores;
        }

        private static void RestoreTemporaryMaterialOverrides(List<MaterialRestore> restores)
        {
            if (restores == null) return;

            foreach (var restore in restores)
            {
                if (restore.Renderer == null) continue;

                var current = restore.Renderer.sharedMaterials;
                restore.Renderer.sharedMaterials = restore.Materials;

                if (current == null) continue;
                foreach (var material in current)
                {
                    if (material == null) continue;
                    if (restore.Materials != null && Array.IndexOf(restore.Materials, material) >= 0) continue;

                    if (Application.isPlaying)
                    {
                        UnityEngine.Object.Destroy(material);
                    }
                    else
                    {
                        UnityEngine.Object.DestroyImmediate(material);
                    }
                }
            }
        }

        private static bool ShouldTreatAsTransparentForExport(Material material, bool applyNameHints)
        {
            if (material == null) return false;

            var renderType = material.GetTag("RenderType", false, "");
            if (renderType == "Transparent" || renderType == "Fade" || renderType == "TransparentCutout")
                return true;

            if (material.renderQueue >= (int)UnityEngine.Rendering.RenderQueue.Transparent)
                return true;

            var materialName = material.name ?? "";
            var shaderName = material.shader != null ? material.shader.name ?? "" : "";
            var shaderLower = shaderName.ToLowerInvariant();
            if (shaderLower.Contains("transparent") ||
                shaderLower.Contains("fade") ||
                shaderLower.Contains("alpha"))
                return true;

            if (!applyNameHints)
                return false;

            var materialLower = materialName.ToLowerInvariant();

            foreach (var hint in TransparentNameHints)
            {
                if (materialLower.Contains(hint))
                    return true;
            }

            return false;
        }

        private static void ConfigureTransparentMaterialForExport(Material material)
        {
            if (material == null) return;

            material.SetOverrideTag("RenderType", "Transparent");
            material.renderQueue = (int)UnityEngine.Rendering.RenderQueue.Transparent;

            if (material.HasProperty("_Mode"))
                material.SetFloat("_Mode", 3f);
            if (material.HasProperty("_Surface"))
                material.SetFloat("_Surface", 1f);
            if (material.HasProperty("_SrcBlend"))
                material.SetFloat("_SrcBlend", (float)UnityEngine.Rendering.BlendMode.SrcAlpha);
            if (material.HasProperty("_DstBlend"))
                material.SetFloat("_DstBlend", (float)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
            if (material.HasProperty("_ZWrite"))
                material.SetFloat("_ZWrite", 0f);

            material.EnableKeyword("_ALPHABLEND_ON");
            material.DisableKeyword("_ALPHATEST_ON");
            material.DisableKeyword("_ALPHAPREMULTIPLY_ON");
        }
    }
}
