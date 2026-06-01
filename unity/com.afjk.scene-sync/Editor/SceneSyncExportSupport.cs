using System;
using System.Collections.Generic;
using System.IO;
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

        [MenuItem("Tools/Scene Sync/Support/Bake Event-Named Clip Curves To New Clips")]
        private static void BakeEventNamedClipCurvesToNewClips()
        {
            var context = CollectSelectedAnimationContext();
            var bakedCount = 0;
            var appliedEventCount = 0;

            foreach (var targetClip in context.TargetClips)
            {
                var events = AnimationUtility.GetAnimationEvents(targetClip);
                if (events == null || events.Length == 0) continue;

                var bakedClip = new AnimationClip();
                EditorUtility.CopySerialized(targetClip, bakedClip);
                bakedClip.name = targetClip.name + "_scenesync_baked";
                AnimationUtility.SetAnimationEvents(bakedClip, Array.Empty<AnimationEvent>());

                var appliedToClip = 0;
                foreach (var animationEvent in events)
                {
                    if (!TryFindNamedClip(animationEvent, context.NamedClips, targetClip, out var eventClip))
                        continue;

                    appliedToClip += CopyCurvesWithOffset(eventClip, bakedClip, animationEvent.time);
                    appliedEventCount++;
                }

                if (appliedToClip == 0) continue;

                var outputPath = GetBakedClipPath(targetClip);
                AssetDatabase.CreateAsset(bakedClip, AssetDatabase.GenerateUniqueAssetPath(outputPath));
                bakedCount++;
            }

            if (bakedCount > 0)
            {
                AssetDatabase.SaveAssets();
                AssetDatabase.Refresh();
            }

            Debug.Log(
                $"Scene Sync export support: created {bakedCount} baked clip(s) from {appliedEventCount} named animation event(s). " +
                "Use the baked clips for GLB publishing.");
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

        private static AnimationContext CollectSelectedAnimationContext()
        {
            var context = new AnimationContext();

            foreach (var selected in Selection.objects)
            {
                if (selected is AnimationClip clip)
                {
                    context.TargetClips.Add(clip);
                    AddNamedClip(context, clip);
                    continue;
                }

                if (selected is GameObject go)
                {
                    CollectClipsFromHierarchy(go, context.TargetClips);
                    CollectClipsFromAsset(go, context.TargetClips);
                    CollectSerializedClipsFromHierarchy(go, context.NamedClips);

                    foreach (var collectedClip in context.TargetClips)
                    {
                        AddNamedClip(context.NamedClips, collectedClip);
                    }
                }
            }

            return context;
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

        private static void CollectSerializedClipsFromHierarchy(GameObject root, Dictionary<string, AnimationClip> clips)
        {
            foreach (var component in root.GetComponentsInChildren<Component>(true))
            {
                if (component == null) continue;

                var serializedObject = new SerializedObject(component);
                var property = serializedObject.GetIterator();
                var enterChildren = true;

                while (property.NextVisible(enterChildren))
                {
                    enterChildren = false;
                    if (property.propertyType != SerializedPropertyType.ObjectReference) continue;

                    if (property.objectReferenceValue is AnimationClip clip)
                        AddNamedClip(clips, clip);
                }
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

        private static bool TryFindNamedClip(
            AnimationEvent animationEvent,
            Dictionary<string, AnimationClip> namedClips,
            AnimationClip targetClip,
            out AnimationClip clip)
        {
            clip = null;

            if (animationEvent == null) return false;

            var names = new[]
            {
                animationEvent.stringParameter,
                animationEvent.functionName,
            };

            foreach (var name in names)
            {
                if (string.IsNullOrWhiteSpace(name)) continue;
                if (!namedClips.TryGetValue(name.Trim(), out var candidate)) continue;
                if (candidate == null || candidate == targetClip) continue;

                clip = candidate;
                return true;
            }

            return false;
        }

        private static int CopyCurvesWithOffset(AnimationClip sourceClip, AnimationClip targetClip, float timeOffset)
        {
            var copied = 0;

            foreach (var binding in AnimationUtility.GetCurveBindings(sourceClip))
            {
                var sourceCurve = AnimationUtility.GetEditorCurve(sourceClip, binding);
                if (sourceCurve == null) continue;

                var targetCurve = AnimationUtility.GetEditorCurve(targetClip, binding) ?? new AnimationCurve();
                foreach (var key in sourceCurve.keys)
                {
                    var nextKey = key;
                    nextKey.time += timeOffset;
                    targetCurve.AddKey(nextKey);
                }

                AnimationUtility.SetEditorCurve(targetClip, binding, targetCurve);
                copied++;
            }

            return copied;
        }

        private static string GetBakedClipPath(AnimationClip targetClip)
        {
            var sourcePath = AssetDatabase.GetAssetPath(targetClip);
            var directory = string.IsNullOrEmpty(sourcePath)
                ? "Assets"
                : Path.GetDirectoryName(sourcePath);

            if (string.IsNullOrEmpty(directory))
                directory = "Assets";

            return Path.Combine(directory, targetClip.name + "_scenesync_baked.anim");
        }

        private static void AddNamedClip(AnimationContext context, AnimationClip clip)
        {
            context.TargetClips.Add(clip);
            AddNamedClip(context.NamedClips, clip);
        }

        private static void AddNamedClip(Dictionary<string, AnimationClip> clips, AnimationClip clip)
        {
            if (clip == null || string.IsNullOrWhiteSpace(clip.name)) return;

            var name = clip.name.Trim();
            if (!clips.ContainsKey(name))
                clips.Add(name, clip);
        }

        private sealed class AnimationContext
        {
            public readonly HashSet<AnimationClip> TargetClips = new HashSet<AnimationClip>();
            public readonly Dictionary<string, AnimationClip> NamedClips =
                new Dictionary<string, AnimationClip>(StringComparer.OrdinalIgnoreCase);
        }
    }
}
