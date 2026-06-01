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
        private const float DrivenBlendShapeSampleRate = 30f;
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
            var compositeClipCount = 0;
            var appliedEventCount = 0;
            var eventClipCount = 0;
            var preferredClipName = "";
            var preferredClipEventCount = 0;

            foreach (var animator in root.GetComponentsInChildren<Animator>(true))
            {
                if (animator == null || animator.runtimeAnimatorController == null)
                    continue;

                var controller = animator.runtimeAnimatorController;
                var overridePairs = new List<KeyValuePair<AnimationClip, AnimationClip>>();
                var controllerClips = new HashSet<AnimationClip>();
                var controllerClipList = new List<AnimationClip>();
                var eventSourceClips = new List<AnimationClip>();

                foreach (var clip in controller.animationClips)
                {
                    if (clip == null || !controllerClips.Add(clip)) continue;
                    controllerClipList.Add(clip);

                    if (HasNamedEventReferences(clip, context.NamedClips))
                    {
                        eventClipCount++;
                        eventSourceClips.Add(clip);
                    }
                }

                foreach (var clip in controllerClipList)
                {
                    if (TryCreateCompositeEventBakedClip(
                        animator.transform,
                        clip,
                        eventSourceClips,
                        context.NamedClips,
                        context.BlendShapeSamplers,
                        out var compositeClip,
                        out var compositeAppliedEvents))
                    {
                        compositeClip.name = clip.name;
                        overridePairs.Add(new KeyValuePair<AnimationClip, AnimationClip>(clip, compositeClip));
                        scope.AddTemporaryObject(compositeClip);
                        bakedClipCount++;
                        compositeClipCount++;
                        appliedEventCount += compositeAppliedEvents;

                        if (string.IsNullOrEmpty(preferredClipName) || compositeAppliedEvents > preferredClipEventCount)
                        {
                            preferredClipName = clip.name;
                            preferredClipEventCount = compositeAppliedEvents;
                        }

                        continue;
                    }

                    if (!TryCreateBakedEventClip(clip, context.NamedClips, out var bakedClip, out var appliedToClip))
                        continue;

                    bakedClip.name = clip.name;
                    overridePairs.Add(new KeyValuePair<AnimationClip, AnimationClip>(clip, bakedClip));
                    scope.AddTemporaryObject(bakedClip);
                    bakedClipCount++;
                    appliedEventCount += appliedToClip;

                    if (string.IsNullOrEmpty(preferredClipName) && appliedToClip > preferredClipEventCount)
                    {
                        preferredClipName = clip.name;
                        preferredClipEventCount = appliedToClip;
                    }
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
            {
                if (eventClipCount > 0)
                {
                    Debug.LogWarning(
                        $"Scene Sync export support: found {eventClipCount} animation clip(s) with event(s), " +
                        "but no event-referenced clip curves were matched for GLB export.");
                }
                return null;
            }

            GlbExporter.LastExportPreferredAnimationClipName = preferredClipName;

            Debug.Log(
                $"Scene Sync export support: temporarily baked {bakedClipCount} clip(s) from " +
                $"{appliedEventCount} animation event/source application(s) for GLB export " +
                $"({compositeClipCount} motion clip(s) include baked overlay curves).");
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
            CollectComponentBlendShapeSamplers(root, context.BlendShapeSamplers);

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

        private static void CollectComponentBlendShapeSamplers(GameObject root, List<BlendShapeSampler> samplers)
        {
            if (root == null || samplers == null) return;

            var components = new HashSet<Component>();
            foreach (var component in root.GetComponentsInChildren<Component>(true))
            {
                if (component != null)
                    components.Add(component);
            }

            foreach (var component in Resources.FindObjectsOfTypeAll<Component>())
            {
                if (component == null || component.gameObject == null)
                    continue;
                if (!component.gameObject.scene.IsValid() || EditorUtility.IsPersistent(component))
                    continue;

                components.Add(component);
            }

            foreach (var component in components)
            {
                if (component == null) continue;

                var serializedObject = new SerializedObject(component);
                var targetNameProperty = serializedObject.FindProperty("targetName");
                var weightCurveProperty = serializedObject.FindProperty("weightCurve");
                if (targetNameProperty == null ||
                    targetNameProperty.propertyType != SerializedPropertyType.String ||
                    weightCurveProperty == null ||
                    weightCurveProperty.propertyType != SerializedPropertyType.AnimationCurve)
                    continue;

                var targetRenderer = FindSkinnedMeshRenderer(root, targetNameProperty.stringValue);
                if (targetRenderer == null || targetRenderer.sharedMesh == null)
                    continue;

                var sourceAnimator = component.GetComponent<Animator>();
                if (sourceAnimator == null)
                    sourceAnimator = component.GetComponentInChildren<Animator>(true);
                if (sourceAnimator == null || sourceAnimator.runtimeAnimatorController == null)
                    continue;

                var sampler = new BlendShapeSampler
                {
                    SourceRoot = sourceAnimator.transform,
                    TargetRenderer = targetRenderer,
                    WeightCurve = weightCurveProperty.animationCurveValue,
                };

                AddBlendShapeDriver(serializedObject, targetRenderer.sharedMesh, "A", sampler.Drivers);
                AddBlendShapeDriver(serializedObject, targetRenderer.sharedMesh, "I", sampler.Drivers);
                AddBlendShapeDriver(serializedObject, targetRenderer.sharedMesh, "U", sampler.Drivers);
                AddBlendShapeDriver(serializedObject, targetRenderer.sharedMesh, "E", sampler.Drivers);
                AddBlendShapeDriver(serializedObject, targetRenderer.sharedMesh, "O", sampler.Drivers);

                if (sampler.Drivers.Count == 0)
                    continue;

                var sourceClips = new HashSet<AnimationClip>();
                foreach (var clip in sourceAnimator.runtimeAnimatorController.animationClips)
                {
                    if (clip != null && sourceClips.Add(clip))
                        sampler.SourceClips.Add(clip);
                }

                if (sampler.SourceClips.Count > 0)
                    samplers.Add(sampler);
            }
        }

        private static SkinnedMeshRenderer FindSkinnedMeshRenderer(GameObject root, string targetName)
        {
            if (root == null || string.IsNullOrWhiteSpace(targetName)) return null;

            foreach (var renderer in root.GetComponentsInChildren<SkinnedMeshRenderer>(true))
            {
                if (renderer != null && renderer.name == targetName)
                    return renderer;
            }

            return null;
        }

        private static void AddBlendShapeDriver(
            SerializedObject serializedObject,
            Mesh mesh,
            string suffix,
            List<BlendShapeDriver> drivers)
        {
            if (serializedObject == null || mesh == null || string.IsNullOrEmpty(suffix) || drivers == null)
                return;

            var nodeProperty = serializedObject.FindProperty("node" + suffix);
            if (nodeProperty == null || nodeProperty.propertyType != SerializedPropertyType.ObjectReference)
                return;

            var node = nodeProperty.objectReferenceValue as Transform;
            if (node == null) return;

            var blendShapeIndex = FindBlendShapeIndex(mesh, suffix);
            if (blendShapeIndex < 0) return;

            drivers.Add(new BlendShapeDriver
            {
                Node = node,
                BlendShapeIndex = blendShapeIndex,
            });
        }

        private static int FindBlendShapeIndex(Mesh mesh, string suffix)
        {
            if (mesh == null || string.IsNullOrEmpty(suffix)) return -1;

            var exactSuffix = "_" + suffix;
            for (var i = 0; i < mesh.blendShapeCount; i++)
            {
                var name = mesh.GetBlendShapeName(i) ?? "";
                if (name.EndsWith(exactSuffix, StringComparison.OrdinalIgnoreCase))
                    return i;
                if (name.EndsWith("." + suffix, StringComparison.OrdinalIgnoreCase))
                    return i;
                if (string.Equals(name, suffix, StringComparison.OrdinalIgnoreCase))
                    return i;
            }

            return -1;
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

        private static bool HasNamedEventReferences(AnimationClip clip, Dictionary<string, AnimationClip> namedClips)
        {
            if (clip == null) return false;

            var events = AnimationUtility.GetAnimationEvents(clip);
            if (events == null || events.Length == 0) return false;

            foreach (var animationEvent in events)
            {
                if (TryFindNamedClip(animationEvent, namedClips, clip, out _))
                    return true;
            }

            return false;
        }

        private static bool IsLikelyMotionClip(AnimationClip clip, Dictionary<string, AnimationClip> namedClips)
        {
            if (clip == null || clip.name.EndsWith(BakedClipSuffix, StringComparison.OrdinalIgnoreCase))
                return false;

            if (HasNamedEventReferences(clip, namedClips))
                return false;

            return HasNonBlendShapeCurves(clip);
        }

        private static bool HasNonBlendShapeCurves(AnimationClip clip)
        {
            if (clip == null) return false;

            foreach (var binding in AnimationUtility.GetCurveBindings(clip))
            {
                if (!IsBlendShapeBinding(binding))
                    return true;
            }

            return false;
        }

        private static bool IsBlendShapeBinding(EditorCurveBinding binding)
        {
            var propertyName = binding.propertyName ?? "";
            return propertyName.StartsWith("blendShape.", StringComparison.OrdinalIgnoreCase);
        }

        private static bool AreClipDurationsCompatible(AnimationClip motionClip, AnimationClip eventSourceClip)
        {
            if (motionClip == null || eventSourceClip == null) return false;

            var motionLength = Mathf.Max(0f, motionClip.length);
            var eventLength = Mathf.Max(0f, eventSourceClip.length);
            if (motionLength <= StepKeyEpsilon || eventLength <= StepKeyEpsilon)
                return false;

            var tolerance = Mathf.Max(0.5f, motionLength * 0.02f);
            return Mathf.Abs(motionLength - eventLength) <= tolerance;
        }

        private static int CopyCurvesWithOffset(
            AnimationClip sourceClip,
            AnimationClip targetClip,
            float timeOffset,
            Func<EditorCurveBinding, bool> bindingFilter = null)
        {
            var copied = 0;

            foreach (var binding in AnimationUtility.GetCurveBindings(sourceClip))
            {
                if (bindingFilter != null && !bindingFilter(binding))
                    continue;

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

        private static int CopyEventReferencedCurvesToClip(
            AnimationClip eventSourceClip,
            AnimationClip targetClip,
            Dictionary<string, AnimationClip> namedClips,
            out int appliedEventCount)
        {
            appliedEventCount = 0;
            if (eventSourceClip == null || targetClip == null) return 0;

            var events = AnimationUtility.GetAnimationEvents(eventSourceClip);
            if (events == null || events.Length == 0) return 0;

            var copiedCurveCount = 0;
            foreach (var animationEvent in events)
            {
                if (!TryFindNamedClip(animationEvent, namedClips, eventSourceClip, out var eventClip))
                    continue;

                var copied = CopyCurvesWithOffset(
                    eventClip,
                    targetClip,
                    animationEvent.time,
                    IsBlendShapeBinding);
                if (copied == 0) continue;

                copiedCurveCount += copied;
                appliedEventCount++;
            }

            return copiedCurveCount;
        }

        private static bool TryCreateCompositeEventBakedClip(
            Transform targetRoot,
            AnimationClip motionClip,
            List<AnimationClip> eventSourceClips,
            Dictionary<string, AnimationClip> namedClips,
            List<BlendShapeSampler> blendShapeSamplers,
            out AnimationClip bakedClip,
            out int appliedEventCount)
        {
            bakedClip = null;
            appliedEventCount = 0;

            if (!IsLikelyMotionClip(motionClip, namedClips))
                return false;
            if ((eventSourceClips == null || eventSourceClips.Count == 0) &&
                (blendShapeSamplers == null || blendShapeSamplers.Count == 0))
                return false;

            var nextClip = new AnimationClip
            {
                hideFlags = HideFlags.HideAndDontSave,
            };
            EditorUtility.CopySerialized(motionClip, nextClip);
            nextClip.name = motionClip.name + BakedClipSuffix;
            nextClip.hideFlags = HideFlags.HideAndDontSave;
            AnimationUtility.SetAnimationEvents(nextClip, Array.Empty<AnimationEvent>());

            var copiedCurveCount = 0;
            if (eventSourceClips != null)
            {
                foreach (var eventSourceClip in eventSourceClips)
                {
                    if (eventSourceClip == null || eventSourceClip == motionClip)
                        continue;
                    if (!AreClipDurationsCompatible(motionClip, eventSourceClip))
                        continue;

                    var overlayCopied = CopyCurvesWithOffset(
                        eventSourceClip,
                        nextClip,
                        0f,
                        IsEventSourceOverlayBinding);
                    if (overlayCopied > 0)
                    {
                        copiedCurveCount += overlayCopied;
                        appliedEventCount++;
                    }

                    var copied = CopyEventReferencedCurvesToClip(
                        eventSourceClip,
                        nextClip,
                        namedClips,
                        out var sourceAppliedEventCount);
                    if (copied == 0) continue;

                    copiedCurveCount += copied;
                    appliedEventCount += sourceAppliedEventCount;
                }
            }

            var drivenCopied = CopyDrivenBlendShapeCurvesToClip(
                targetRoot,
                motionClip,
                nextClip,
                blendShapeSamplers,
                out var drivenSourceCount);
            if (drivenCopied > 0)
            {
                copiedCurveCount += drivenCopied;
                appliedEventCount += drivenSourceCount;
            }

            if (copiedCurveCount > 0)
            {
                bakedClip = nextClip;
                return true;
            }

            UnityEngine.Object.DestroyImmediate(nextClip);
            return false;
        }

        private static bool IsEventSourceOverlayBinding(EditorCurveBinding binding)
        {
            if (IsBlendShapeBinding(binding))
                return true;

            var text = ((binding.path ?? "") + " " + (binding.propertyName ?? "")).ToLowerInvariant();
            return text.Contains("hand") ||
                text.Contains("finger") ||
                text.Contains("thumb") ||
                text.Contains("index") ||
                text.Contains("middle") ||
                text.Contains("ring") ||
                text.Contains("pinky") ||
                text.Contains("little");
        }

        private static int CopyDrivenBlendShapeCurvesToClip(
            Transform targetRoot,
            AnimationClip motionClip,
            AnimationClip targetClip,
            List<BlendShapeSampler> samplers,
            out int appliedSourceCount)
        {
            appliedSourceCount = 0;
            if (targetRoot == null || motionClip == null || targetClip == null || samplers == null)
                return 0;

            var copiedCurveCount = 0;
            foreach (var sampler in samplers)
            {
                if (sampler == null ||
                    sampler.TargetRenderer == null ||
                    sampler.TargetRenderer.sharedMesh == null ||
                    sampler.SourceRoot == null ||
                    sampler.WeightCurve == null ||
                    sampler.Drivers.Count == 0)
                    continue;
                if (!IsTransformUnder(sampler.TargetRenderer.transform, targetRoot))
                    continue;

                foreach (var sourceClip in sampler.SourceClips)
                {
                    if (sourceClip == null)
                        continue;

                    var copied = CopyDrivenBlendShapeCurvesFromSource(targetRoot, sourceClip, targetClip, sampler);
                    if (copied == 0) continue;

                    copiedCurveCount += copied;
                    appliedSourceCount++;
                }
            }

            return copiedCurveCount;
        }

        private static bool IsTransformUnder(Transform child, Transform root)
        {
            if (child == null || root == null) return false;

            var current = child;
            while (current != null)
            {
                if (current == root)
                    return true;
                current = current.parent;
            }

            return false;
        }

        private static int CopyDrivenBlendShapeCurvesFromSource(
            Transform targetRoot,
            AnimationClip sourceClip,
            AnimationClip targetClip,
            BlendShapeSampler sampler)
        {
            var nodeCurves = new List<AnimationCurve>();
            var sampleTimes = new List<float>
            {
                0f,
                Mathf.Max(0f, sourceClip.length),
            };
            var hasSourceCurve = false;

            foreach (var driver in sampler.Drivers)
            {
                var curve = FindLocalPositionZCurve(sourceClip, sampler.SourceRoot, driver.Node);
                nodeCurves.Add(curve);
                if (curve == null) continue;

                hasSourceCurve = true;
                foreach (var key in curve.keys)
                {
                    AddSampleTime(sampleTimes, key.time);
                }
            }

            if (!hasSourceCurve)
                return 0;

            AddUniformSampleTimes(sampleTimes, sourceClip.length, DrivenBlendShapeSampleRate);

            var targetPath = AnimationUtility.CalculateTransformPath(sampler.TargetRenderer.transform, targetRoot);
            var copied = 0;
            var sourceLength = Mathf.Max(0f, sourceClip.length);
            var targetLength = Mathf.Max(0f, targetClip.length);

            for (var driverIndex = 0; driverIndex < sampler.Drivers.Count; driverIndex++)
            {
                var driver = sampler.Drivers[driverIndex];
                var blendShapeName = sampler.TargetRenderer.sharedMesh.GetBlendShapeName(driver.BlendShapeIndex);
                if (string.IsNullOrEmpty(blendShapeName)) continue;

                var binding = new EditorCurveBinding
                {
                    path = targetPath,
                    type = typeof(SkinnedMeshRenderer),
                    propertyName = "blendShape." + blendShapeName,
                };
                var targetCurve = AnimationUtility.GetEditorCurve(targetClip, binding) ?? new AnimationCurve();

                foreach (var sourceTime in sampleTimes)
                {
                    var targetTime = MapSourceTimeToTargetTime(sourceTime, sourceLength, targetLength);
                    var value = EvaluateDrivenBlendShape(sampler, nodeCurves, driverIndex, sourceTime);
                    SetOrAddKey(targetCurve, new Keyframe(targetTime, value, 0f, 0f));
                }

                AnimationUtility.SetEditorCurve(targetClip, binding, targetCurve);
                copied++;
            }

            return copied;
        }

        private static AnimationCurve FindLocalPositionZCurve(
            AnimationClip clip,
            Transform sourceRoot,
            Transform node)
        {
            if (clip == null || sourceRoot == null || node == null) return null;

            var path = AnimationUtility.CalculateTransformPath(node, sourceRoot);
            foreach (var binding in AnimationUtility.GetCurveBindings(clip))
            {
                if (!IsTransformPathMatch(binding.path, path, node.name)) continue;

                var propertyName = binding.propertyName ?? "";
                if (!propertyName.EndsWith(".z", StringComparison.OrdinalIgnoreCase))
                    continue;
                if (propertyName.IndexOf("position", StringComparison.OrdinalIgnoreCase) < 0)
                    continue;

                return AnimationUtility.GetEditorCurve(clip, binding);
            }

            return null;
        }

        private static bool IsTransformPathMatch(string bindingPath, string expectedPath, string nodeName)
        {
            bindingPath = bindingPath ?? "";
            expectedPath = expectedPath ?? "";
            nodeName = nodeName ?? "";

            if (bindingPath == expectedPath)
                return true;
            if (!string.IsNullOrEmpty(expectedPath) &&
                bindingPath.EndsWith("/" + expectedPath, StringComparison.Ordinal))
                return true;
            if (!string.IsNullOrEmpty(nodeName))
            {
                if (bindingPath == nodeName)
                    return true;
                if (bindingPath.EndsWith("/" + nodeName, StringComparison.Ordinal))
                    return true;
            }

            return false;
        }

        private static float EvaluateDrivenBlendShape(
            BlendShapeSampler sampler,
            List<AnimationCurve> nodeCurves,
            int targetDriverIndex,
            float time)
        {
            var total = 100f;

            for (var i = 0; i < sampler.Drivers.Count; i++)
            {
                var curve = i < nodeCurves.Count ? nodeCurves[i] : null;
                var z = curve != null ? curve.Evaluate(time) : sampler.Drivers[i].Node.localPosition.z;
                var value = total * Mathf.Clamp01(sampler.WeightCurve.Evaluate(z));
                if (i == targetDriverIndex)
                    return value;

                total -= value;
            }

            return 0f;
        }

        private static void AddSampleTime(List<float> sampleTimes, float time)
        {
            if (sampleTimes == null) return;

            for (var i = 0; i < sampleTimes.Count; i++)
            {
                if (Mathf.Abs(sampleTimes[i] - time) <= 0.00001f)
                    return;
            }

            sampleTimes.Add(time);
            sampleTimes.Sort();
        }

        private static void AddUniformSampleTimes(List<float> sampleTimes, float length, float sampleRate)
        {
            if (sampleTimes == null || length <= StepKeyEpsilon || sampleRate <= 0f)
                return;

            var step = 1f / sampleRate;
            for (var time = step; time < length; time += step)
            {
                AddSampleTime(sampleTimes, time);
            }
        }

        private static float MapSourceTimeToTargetTime(float sourceTime, float sourceLength, float targetLength)
        {
            if (sourceLength <= StepKeyEpsilon || targetLength <= StepKeyEpsilon)
                return Mathf.Clamp(sourceTime, 0f, Mathf.Max(0f, targetLength));

            var normalized = Mathf.Clamp01(sourceTime / sourceLength);
            return normalized * targetLength;
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
                var previousKey = new Keyframe(key.time - StepKeyEpsilon, previousValue, 0f, 0f);
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
            public readonly List<BlendShapeSampler> BlendShapeSamplers = new List<BlendShapeSampler>();
        }

        private sealed class BlendShapeSampler
        {
            public Transform SourceRoot;
            public SkinnedMeshRenderer TargetRenderer;
            public AnimationCurve WeightCurve;
            public readonly List<BlendShapeDriver> Drivers = new List<BlendShapeDriver>();
            public readonly List<AnimationClip> SourceClips = new List<AnimationClip>();
        }

        private struct BlendShapeDriver
        {
            public Transform Node;
            public int BlendShapeIndex;
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
