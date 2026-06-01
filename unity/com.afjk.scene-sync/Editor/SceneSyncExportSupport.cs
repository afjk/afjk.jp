using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace Afjk.SceneSync.Editor
{
    public static class SceneSyncExportSupport
    {
        private static readonly string[] TransparentNameHints =
        {
            "glass",
            "lens",
            "wing",
            "cheek",
            "shadow",
            "fade",
            "trans",
            "transparent",
            "alpha",
            "semi",
        };

        [MenuItem("Tools/Scene Sync/Support/Apply Transparent Name Hints To Selection")]
        private static void ApplyTransparentNameHintsToSelection()
        {
            var materials = CollectSelectedMaterials();
            var changed = 0;

            foreach (var material in materials)
            {
                if (!ShouldTreatAsTransparent(material)) continue;

                Undo.RecordObject(material, "Apply Transparent Name Hints");
                ConfigureTransparentMaterial(material);
                EditorUtility.SetDirty(material);
                changed++;
            }

            if (changed > 0)
            {
                AssetDatabase.SaveAssets();
            }

            Debug.Log($"Scene Sync export support: updated {changed} material(s) from {materials.Count} selected material candidate(s).");
        }

        [MenuItem("Tools/Scene Sync/Support/Report Animation Events In Selection")]
        private static void ReportAnimationEventsInSelection()
        {
            var clips = CollectSelectedAnimationClips();
            var eventCount = 0;

            foreach (var clip in clips)
            {
                var events = AnimationUtility.GetAnimationEvents(clip);
                if (events == null || events.Length == 0) continue;

                eventCount += events.Length;
                Debug.LogWarning(
                    $"Scene Sync export support: animation clip '{clip.name}' contains {events.Length} event(s). " +
                    "GLB export does not preserve Unity animation events or MonoBehaviour callbacks. " +
                    "Bake the resulting transform, material, or blend shape changes into animation curves before publishing.",
                    clip);
            }

            Debug.Log($"Scene Sync export support: scanned {clips.Count} animation clip(s), found {eventCount} event(s).");
        }

        private static HashSet<Material> CollectSelectedMaterials()
        {
            var materials = new HashSet<Material>();

            foreach (var selected in Selection.objects)
            {
                if (selected is Material material)
                {
                    materials.Add(material);
                    continue;
                }

                if (selected is GameObject go)
                {
                    foreach (var renderer in go.GetComponentsInChildren<Renderer>(true))
                    {
                        if (renderer == null) continue;

                        foreach (var rendererMaterial in renderer.sharedMaterials)
                        {
                            if (rendererMaterial != null)
                                materials.Add(rendererMaterial);
                        }
                    }
                }
            }

            return materials;
        }

        private static HashSet<AnimationClip> CollectSelectedAnimationClips()
        {
            var clips = new HashSet<AnimationClip>();

            foreach (var selected in Selection.objects)
            {
                if (selected is AnimationClip clip)
                {
                    clips.Add(clip);
                    continue;
                }

                if (selected is GameObject go)
                {
                    CollectClipsFromHierarchy(go, clips);
                    CollectClipsFromAsset(go, clips);
                }
            }

            return clips;
        }

        private static void CollectClipsFromHierarchy(GameObject root, HashSet<AnimationClip> clips)
        {
            foreach (var animation in root.GetComponentsInChildren<Animation>(true))
            {
                if (animation == null) continue;

                foreach (AnimationState state in animation)
                {
                    if (state != null && state.clip != null)
                        clips.Add(state.clip);
                }
            }

            foreach (var animator in root.GetComponentsInChildren<Animator>(true))
            {
                var controller = animator != null ? animator.runtimeAnimatorController : null;
                if (controller == null) continue;

                foreach (var clip in controller.animationClips)
                {
                    if (clip != null)
                        clips.Add(clip);
                }
            }
        }

        private static void CollectClipsFromAsset(GameObject go, HashSet<AnimationClip> clips)
        {
            var path = AssetDatabase.GetAssetPath(go);
            if (string.IsNullOrEmpty(path)) return;

            foreach (var asset in AssetDatabase.LoadAllAssetsAtPath(path))
            {
                if (asset is AnimationClip clip)
                    clips.Add(clip);
            }
        }

        private static bool ShouldTreatAsTransparent(Material material)
        {
            if (material == null) return false;

            var renderType = material.GetTag("RenderType", false, "");
            if (renderType == "Transparent" || renderType == "Fade" || renderType == "TransparentCutout")
                return false;

            var materialName = material.name ?? "";
            var shaderName = material.shader != null ? material.shader.name ?? "" : "";
            var combined = (materialName + " " + shaderName).ToLowerInvariant();

            foreach (var hint in TransparentNameHints)
            {
                if (combined.Contains(hint))
                    return true;
            }

            return false;
        }

        private static void ConfigureTransparentMaterial(Material material)
        {
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
