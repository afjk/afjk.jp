using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace Afjk.SceneSync.Editor
{
    [InitializeOnLoad]
    public static class SceneSyncExportSupport
    {
        private const string BakedClipSuffix = "_scenesync_baked";
        private const float StepKeyEpsilon = 1f / 1200f;
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

        static SceneSyncExportSupport()
        {
            GlbExporter.EditorExportPreparationHandler = BeginTemporaryBakedEventClipOverridesForExport;
        }

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
                if (!TryCreateBakedEventClip(targetClip, context.NamedClips, out var bakedClip, out var appliedToClip))
                    continue;

                var outputPath = GetBakedClipPath(targetClip);
                AssetDatabase.CreateAsset(bakedClip, AssetDatabase.GenerateUniqueAssetPath(outputPath));
                bakedCount++;
                appliedEventCount += appliedToClip;
            }

            if (bakedCount > 0)
            {
                AssetDatabase.SaveAssets();
                AssetDatabase.Refresh();
            }

            Debug.Log(
                $"Scene Sync export support: created {bakedCount} baked clip(s) from {appliedEventCount} named animation event(s). " +
                "Scene Sync publish also applies this baking in memory during UnityGLTF export.");
        }

        private static IDisposable BeginTemporaryBakedEventClipOverridesForExport(GameObject root)
        {
            if (root == null) return null;

            var context = CollectAnimationContext(root);
            var scope = new AnimationExportOverrideScope();
            var bakedClipCount = 0;
            var appliedEventCount = 0;

            foreach (var animator in root.GetComponentsInChildren<Animator>(true))
            {
                if (animator == null || animator.runtimeAnimatorController == null)
                    continue;

                var controller = animator.runtimeAnimatorController;
                var overridePairs = new List<KeyValuePair<AnimationClip, AnimationClip>>();
                var controllerClips = new HashSet<AnimationClip>();

                foreach (var clip in controller.animationClips)
                {
                    if (clip == null || !controllerClips.Add(clip)) continue;

                    if (!TryCreateBakedEventClip(clip, context.NamedClips, out var bakedClip, out var appliedToClip))
                        continue;

                    overridePairs.Add(new KeyValuePair<AnimationClip, AnimationClip>(clip, bakedClip));
                    scope.AddTemporaryObject(bakedClip);
                    bakedClipCount++;
                    appliedEventCount += appliedToClip;
                }

                if (overridePairs.Count == 0) continue;

                var overrideController = new AnimatorOverrideController(controller)
                {
                    name = controller.name + "_SceneSyncExportOverride",
                    hideFlags = HideFlags.HideAndDontSave,
                };
                overrideController.ApplyOverrides(overridePairs);
                scope.AddAnimator(animator, controller, overrideController);
                animator.runtimeAnimatorController = overrideController;
            }

            if (!scope.HasChanges)
                return null;

            Debug.Log(
                $"Scene Sync export support: temporarily baked {bakedClipCount} clip(s) from " +
                $"{appliedEventCount} named animation event(s) for GLB export.");
            return scope;
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

        private static AnimationContext CollectAnimationContext(GameObject root)
        {
            var context = new AnimationContext();
            if (root == null) return context;

            CollectClipsFromHierarchy(root, context.TargetClips);
            CollectClipsFromAsset(root, context.TargetClips);
            CollectSerializedClipsFromHierarchy(root, context.NamedClips);

            foreach (var clip in context.TargetClips)
            {
                AddNamedClip(context.NamedClips, clip);
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

            if (animationEvent.objectReferenceParameter is AnimationClip referencedClip &&
                referencedClip != targetClip)
            {
                clip = referencedClip;
                return true;
            }

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
                var keys = sourceCurve.keys;
                if (keys.Length == 0)
                    continue;

                if (IsPoseCurve(keys))
                {
                    var nextKey = keys[keys.Length - 1];
                    nextKey.time = timeOffset;
                    AddSteppedKey(targetCurve, nextKey);
                }
                else
                {
                    foreach (var key in keys)
                    {
                        var nextKey = key;
                        nextKey.time += timeOffset;
                        SetOrAddKey(targetCurve, nextKey);
                    }
                }

                AnimationUtility.SetEditorCurve(targetClip, binding, targetCurve);
                copied++;
            }

            return copied;
        }

        private static bool TryCreateBakedEventClip(
            AnimationClip targetClip,
            Dictionary<string, AnimationClip> namedClips,
            out AnimationClip bakedClip,
            out int appliedEventCount)
        {
            bakedClip = null;
            appliedEventCount = 0;

            if (targetClip == null || targetClip.name.EndsWith(BakedClipSuffix, StringComparison.OrdinalIgnoreCase))
                return false;

            var events = AnimationUtility.GetAnimationEvents(targetClip);
            if (events == null || events.Length == 0) return false;

            var nextClip = new AnimationClip
            {
                hideFlags = HideFlags.HideAndDontSave,
            };
            EditorUtility.CopySerialized(targetClip, nextClip);
            nextClip.name = targetClip.name + BakedClipSuffix;
            nextClip.hideFlags = HideFlags.HideAndDontSave;
            AnimationUtility.SetAnimationEvents(nextClip, Array.Empty<AnimationEvent>());

            var copiedCurveCount = 0;
            foreach (var animationEvent in events)
            {
                if (!TryFindNamedClip(animationEvent, namedClips, targetClip, out var eventClip))
                    continue;

                var copied = CopyCurvesWithOffset(eventClip, nextClip, animationEvent.time);
                if (copied == 0) continue;

                copiedCurveCount += copied;
                appliedEventCount++;
            }

            if (copiedCurveCount > 0)
            {
                bakedClip = nextClip;
                return true;
            }

            UnityEngine.Object.DestroyImmediate(nextClip);
            return false;
        }

        private static bool IsPoseCurve(Keyframe[] keys)
        {
            if (keys == null || keys.Length == 0) return false;

            for (var i = 0; i < keys.Length; i++)
            {
                if (keys[i].time > StepKeyEpsilon)
                    return false;
            }

            return true;
        }

        private static void AddSteppedKey(AnimationCurve curve, Keyframe key)
        {
            if (curve == null) return;

            if (key.time > StepKeyEpsilon)
            {
                var previousValue = curve.length > 0 ? curve.Evaluate(key.time - StepKeyEpsilon) : 0f;
                var previousKey = new Keyframe(key.time - StepKeyEpsilon, previousValue)
                {
                    inSlope = 0f,
                    outSlope = 0f,
                };
                SetOrAddKey(curve, previousKey);
            }

            SetOrAddKey(curve, key);
        }

        private static void SetOrAddKey(AnimationCurve curve, Keyframe key)
        {
            var keys = new List<Keyframe>(curve.keys);
            for (var i = 0; i < keys.Count; i++)
            {
                if (Mathf.Abs(keys[i].time - key.time) > 0.00001f) continue;

                keys[i] = key;
                curve.keys = keys.ToArray();
                return;
            }

            keys.Add(key);
            keys.Sort((a, b) => a.time.CompareTo(b.time));
            curve.keys = keys.ToArray();
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

        private sealed class AnimationExportOverrideScope : IDisposable
        {
            private readonly List<AnimatorRestore> _animators = new List<AnimatorRestore>();
            private readonly List<UnityEngine.Object> _temporaryObjects = new List<UnityEngine.Object>();

            public bool HasChanges => _animators.Count > 0;

            public void AddAnimator(
                Animator animator,
                RuntimeAnimatorController originalController,
                RuntimeAnimatorController temporaryController)
            {
                _animators.Add(new AnimatorRestore
                {
                    Animator = animator,
                    OriginalController = originalController,
                });
                AddTemporaryObject(temporaryController);
            }

            public void AddTemporaryObject(UnityEngine.Object temporaryObject)
            {
                if (temporaryObject != null)
                    _temporaryObjects.Add(temporaryObject);
            }

            public void Dispose()
            {
                foreach (var restore in _animators)
                {
                    if (restore.Animator != null)
                        restore.Animator.runtimeAnimatorController = restore.OriginalController;
                }

                foreach (var temporaryObject in _temporaryObjects)
                {
                    if (temporaryObject != null)
                        UnityEngine.Object.DestroyImmediate(temporaryObject);
                }
            }

            private struct AnimatorRestore
            {
                public Animator Animator;
                public RuntimeAnimatorController OriginalController;
            }
        }
    }
}
