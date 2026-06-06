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
        private const float LipSyncSampleRate = 30f;
        private static readonly string[] LipSyncNodePropertyNames =
        {
            "nodeA",
            "nodeI",
            "nodeU",
            "nodeE",
            "nodeO",
        };
        private static readonly string[][] LipSyncBlendShapeNameCandidates =
        {
            new[] { "MTH_A", "MOUTH_A", "MOUTH_AA", "VISEME_A", "VISEME_AA", "V_AA", "AA", "A" },
            new[] { "MTH_I", "MOUTH_I", "MOUTH_IH", "VISEME_I", "VISEME_IH", "V_IH", "IH", "I" },
            new[] { "MTH_U", "MOUTH_U", "MOUTH_OU", "VISEME_U", "VISEME_OU", "V_OU", "OU", "U" },
            new[] { "MTH_E", "MOUTH_E", "MOUTH_EE", "VISEME_E", "VISEME_EE", "V_E", "EE", "E" },
            new[] { "MTH_O", "MOUTH_O", "MOUTH_OH", "VISEME_O", "VISEME_OH", "V_OH", "OH", "O" },
        };
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
            var eventClipCount = 0;
            var lipSyncCurveCount = 0;
            var preferredClipName = "";
            CaptureCurrentPrimaryAnimationClipName(root);
            var requestedPrimaryClipName = GlbExporter.LastExportPreferredAnimationClipName;

            foreach (var animator in root.GetComponentsInChildren<Animator>(true))
            {
                if (animator == null || animator.runtimeAnimatorController == null)
                    continue;

                var controller = animator.runtimeAnimatorController;
                var controllerClips = new List<AnimationClip>();
                var seenControllerClips = new HashSet<AnimationClip>();
                var replacements = new Dictionary<AnimationClip, AnimationClip>();

                foreach (var clip in controller.animationClips)
                {
                    if (clip == null || !seenControllerClips.Add(clip)) continue;
                    controllerClips.Add(clip);

                    var events = AnimationUtility.GetAnimationEvents(clip);
                    if (events != null && events.Length > 0)
                        eventClipCount++;

                    if (!TryCreateBakedEventClip(clip, context.NamedClips, out var bakedClip, out var appliedToClip))
                        continue;

                    bakedClip.name = clip.name;
                    replacements[clip] = bakedClip;
                    scope.AddTemporaryObject(bakedClip);
                    bakedClipCount++;
                    appliedEventCount += appliedToClip;
                }

                var primaryClip = SelectPrimaryAnimationClip(controllerClips, requestedPrimaryClipName);
                if (primaryClip != null)
                {
                    var compositeClip = replacements.TryGetValue(primaryClip, out var existingReplacement)
                        ? existingReplacement
                        : CreateTemporaryClipCopy(primaryClip, scope);

                    var copiedCurveCount = 0;
                    foreach (var overlayClip in CollectOverlayClips(controllerClips, replacements, primaryClip))
                    {
                        if (overlayClip == compositeClip) continue;
                        if (!HasCompatibleDuration(primaryClip, overlayClip)) continue;
                        copiedCurveCount += CopySceneSyncOverlayCurvesWithOffset(overlayClip, compositeClip, 0f);
                    }

                    var copiedLipSyncCurves = BakeExternalLipSyncCurves(root, primaryClip, compositeClip);
                    copiedCurveCount += copiedLipSyncCurves;
                    lipSyncCurveCount += copiedLipSyncCurves;

                    if (copiedCurveCount > 0)
                    {
                        replacements[primaryClip] = compositeClip;
                        preferredClipName = primaryClip.name;
                    }
                }

                var overridePairs = new List<KeyValuePair<AnimationClip, AnimationClip>>();
                foreach (var pair in replacements)
                {
                    overridePairs.Add(new KeyValuePair<AnimationClip, AnimationClip>(pair.Key, pair.Value));
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

            if (string.IsNullOrWhiteSpace(GlbExporter.LastExportPreferredAnimationClipName))
                GlbExporter.LastExportPreferredAnimationClipName = preferredClipName;

            Debug.Log(
                $"Scene Sync export support: temporarily baked {bakedClipCount} clip(s) from " +
                $"{appliedEventCount} named animation event(s)" +
                (lipSyncCurveCount > 0 ? $" and {lipSyncCurveCount} lip sync curve(s)" : "") +
                " for GLB export.");
            return scope;
        }

        private static void CaptureCurrentPrimaryAnimationClipName(GameObject root)
        {
            if (root == null) return;

            foreach (var animator in root.GetComponentsInChildren<Animator>(true))
            {
                if (animator == null || animator.runtimeAnimatorController == null || animator.layerCount <= 0)
                    continue;

                var clipInfos = animator.GetCurrentAnimatorClipInfo(0);
                if (clipInfos == null || clipInfos.Length == 0)
                    continue;

                AnimationClip selectedClip = null;
                var selectedWeight = float.MinValue;
                foreach (var clipInfo in clipInfos)
                {
                    if (clipInfo.clip == null) continue;
                    if (selectedClip != null && clipInfo.weight <= selectedWeight) continue;

                    selectedClip = clipInfo.clip;
                    selectedWeight = clipInfo.weight;
                }

                if (selectedClip == null || string.IsNullOrWhiteSpace(selectedClip.name))
                    continue;

                GlbExporter.LastExportPreferredAnimationClipName = selectedClip.name;
                return;
            }
        }

        private static AnimationClip CreateTemporaryClipCopy(AnimationClip sourceClip, AnimationExportOverrideScope scope)
        {
            var clip = new AnimationClip
            {
                hideFlags = HideFlags.HideAndDontSave,
            };
            EditorUtility.CopySerialized(sourceClip, clip);
            clip.name = sourceClip.name;
            clip.hideFlags = HideFlags.HideAndDontSave;
            AnimationUtility.SetAnimationEvents(clip, Array.Empty<AnimationEvent>());
            scope.AddTemporaryObject(clip);
            return clip;
        }

        private static bool HasCompatibleDuration(AnimationClip primaryClip, AnimationClip overlayClip)
        {
            if (primaryClip == null || overlayClip == null) return false;
            return Mathf.Abs(primaryClip.length - overlayClip.length) <= 0.01f;
        }

        private static AnimationClip SelectPrimaryAnimationClip(
            List<AnimationClip> controllerClips,
            string requestedClipName)
        {
            if (controllerClips == null || controllerClips.Count == 0)
                return null;

            if (!string.IsNullOrWhiteSpace(requestedClipName))
            {
                foreach (var clip in controllerClips)
                {
                    if (!string.Equals(clip != null ? clip.name : "", requestedClipName, StringComparison.OrdinalIgnoreCase))
                        continue;
                    if (IsPrimaryAnimationCandidate(clip))
                        return clip;
                }
            }

            foreach (var clip in controllerClips)
            {
                if (IsPrimaryAnimationCandidate(clip))
                    return clip;
            }

            foreach (var clip in controllerClips)
            {
                if (clip != null && clip.length > 0f)
                    return clip;
            }

            return null;
        }

        private static bool IsPrimaryAnimationCandidate(AnimationClip clip)
        {
            if (clip == null || clip.length <= 0f) return false;
            return HasPrimaryAnimationCurves(clip) || !HasSceneSyncOverlayCurves(clip);
        }

        private static bool HasPrimaryAnimationCurves(AnimationClip clip)
        {
            if (clip == null) return false;

            foreach (var binding in AnimationUtility.GetCurveBindings(clip))
            {
                if (!IsSceneSyncOverlayCurveBinding(binding))
                    return true;
            }

            foreach (var binding in AnimationUtility.GetObjectReferenceCurveBindings(clip))
            {
                if (!IsSceneSyncOverlayCurveBinding(binding))
                    return true;
            }

            return false;
        }

        private static bool HasSceneSyncOverlayCurves(AnimationClip clip)
        {
            if (clip == null) return false;
            foreach (var binding in AnimationUtility.GetCurveBindings(clip))
            {
                if (IsSceneSyncOverlayCurveBinding(binding))
                    return true;
            }
            return false;
        }

        private static IEnumerable<AnimationClip> CollectOverlayClips(
            List<AnimationClip> controllerClips,
            Dictionary<AnimationClip, AnimationClip> replacements,
            AnimationClip primaryClip)
        {
            var seen = new HashSet<AnimationClip>();
            foreach (var originalClip in controllerClips)
            {
                if (originalClip == null || originalClip == primaryClip)
                    continue;

                var candidate = replacements != null && replacements.TryGetValue(originalClip, out var replacement)
                    ? replacement
                    : originalClip;
                if (candidate == null || !seen.Add(candidate))
                    continue;
                if (!HasSceneSyncOverlayCurves(candidate))
                    continue;

                yield return candidate;
            }
        }

        private static bool IsMorphCurveBinding(EditorCurveBinding binding)
        {
            var propertyName = binding.propertyName ?? "";
            return propertyName.StartsWith("blendShape.", StringComparison.Ordinal);
        }

        private static bool IsHandCurveBinding(EditorCurveBinding binding)
        {
            var propertyName = binding.propertyName ?? "";
            return propertyName.StartsWith("LeftHand.", StringComparison.Ordinal) ||
                   propertyName.StartsWith("RightHand.", StringComparison.Ordinal) ||
                   propertyName.StartsWith("LeftHandT", StringComparison.Ordinal) ||
                   propertyName.StartsWith("LeftHandQ", StringComparison.Ordinal) ||
                   propertyName.StartsWith("RightHandT", StringComparison.Ordinal) ||
                   propertyName.StartsWith("RightHandQ", StringComparison.Ordinal) ||
                   propertyName.StartsWith("Left Hand ", StringComparison.Ordinal) ||
                   propertyName.StartsWith("Right Hand ", StringComparison.Ordinal);
        }

        private static bool IsSceneSyncOverlayCurveBinding(EditorCurveBinding binding)
        {
            return IsMorphCurveBinding(binding) || IsHandCurveBinding(binding);
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

        private static int CopySceneSyncOverlayCurvesWithOffset(AnimationClip sourceClip, AnimationClip targetClip, float timeOffset)
        {
            return CopyCurvesWithOffset(sourceClip, targetClip, timeOffset, IsSceneSyncOverlayCurveBinding);
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
                    MergeShiftedKeys(targetCurve, keys, timeOffset);
                }

                AnimationUtility.SetEditorCurve(targetClip, binding, targetCurve);
                copied++;
            }

            return copied;
        }

        private static void MergeShiftedKeys(AnimationCurve targetCurve, Keyframe[] sourceKeys, float timeOffset)
        {
            if (targetCurve == null || sourceKeys == null || sourceKeys.Length == 0)
                return;

            var byTime = new Dictionary<int, Keyframe>();
            foreach (var key in targetCurve.keys)
            {
                byTime[GetKeyTimeHash(key.time)] = key;
            }

            foreach (var key in sourceKeys)
            {
                var nextKey = key;
                nextKey.time += timeOffset;
                byTime[GetKeyTimeHash(nextKey.time)] = nextKey;
            }

            var mergedKeys = new List<Keyframe>(byTime.Values);
            mergedKeys.Sort((a, b) => a.time.CompareTo(b.time));
            targetCurve.keys = mergedKeys.ToArray();
        }

        private static int GetKeyTimeHash(float time)
        {
            return Mathf.RoundToInt(time * 100000f);
        }

        private static int BakeExternalLipSyncCurves(GameObject root, AnimationClip primaryClip, AnimationClip targetClip)
        {
            if (root == null || primaryClip == null || targetClip == null)
                return 0;

            var copied = 0;
            foreach (var component in FindSceneComponentsByTypeName("LipSyncController"))
            {
                if (!TryReadLipSyncController(component, out var targetName, out var nodes, out var weightCurve))
                    continue;

                var targetRenderer = FindSkinnedMeshRenderer(root, targetName);
                if (targetRenderer == null)
                    continue;

                if (!IsLipSyncControllerLinkedToRoot(root, component, targetName, targetRenderer))
                    continue;

                var sourceClip = GetPrimaryAnimationClip(
                    component.GetComponent<Animator>(),
                    primaryClip.name,
                    primaryClip.length);
                if (sourceClip == null || sourceClip.length <= 0f)
                    continue;

                copied += BakeLipSyncControllerCurves(
                    component.transform,
                    sourceClip,
                    targetRenderer,
                    root.transform,
                    targetClip,
                    primaryClip.length,
                    nodes,
                    weightCurve
                );
            }

            return copied;
        }

        private static bool IsLipSyncControllerLinkedToRoot(
            GameObject root,
            Component component,
            string targetName,
            SkinnedMeshRenderer targetRenderer)
        {
            if (root == null || component == null || targetRenderer == null)
                return false;

            var rootTransform = root.transform;
            if (component.transform == rootTransform || component.transform.IsChildOf(rootTransform))
                return true;

            return IsUniqueLoadedSceneRendererTarget(targetRenderer, targetName);
        }

        private static bool IsUniqueLoadedSceneRendererTarget(SkinnedMeshRenderer targetRenderer, string targetName)
        {
            if (targetRenderer == null || string.IsNullOrWhiteSpace(targetName))
                return false;

            var matches = 0;
            foreach (var renderer in Resources.FindObjectsOfTypeAll<SkinnedMeshRenderer>())
            {
                if (renderer == null || renderer.gameObject == null) continue;
                var scene = renderer.gameObject.scene;
                if (!scene.IsValid() || !scene.isLoaded) continue;
                if (!string.Equals(renderer.name, targetName, StringComparison.Ordinal)) continue;

                matches++;
                if (renderer != targetRenderer || matches > 1)
                    return false;
            }

            return matches == 1;
        }

        private static IEnumerable<Component> FindSceneComponentsByTypeName(string typeName)
        {
            foreach (var component in Resources.FindObjectsOfTypeAll<Component>())
            {
                if (component == null || component.gameObject == null) continue;
                var scene = component.gameObject.scene;
                if (!scene.IsValid() || !scene.isLoaded) continue;
                if (component.GetType().Name != typeName) continue;

                yield return component;
            }
        }

        private static bool TryReadLipSyncController(
            Component component,
            out string targetName,
            out Transform[] nodes,
            out AnimationCurve weightCurve)
        {
            targetName = null;
            nodes = null;
            weightCurve = null;

            if (component == null)
                return false;

            var serializedObject = new SerializedObject(component);
            targetName = serializedObject.FindProperty("targetName")?.stringValue;
            if (string.IsNullOrWhiteSpace(targetName))
                return false;

            nodes = new Transform[LipSyncNodePropertyNames.Length];
            for (var i = 0; i < LipSyncNodePropertyNames.Length; i++)
            {
                var property = serializedObject.FindProperty(LipSyncNodePropertyNames[i]);
                nodes[i] = property != null ? property.objectReferenceValue as Transform : null;
                if (nodes[i] == null)
                    return false;
            }

            var weightCurveProperty = serializedObject.FindProperty("weightCurve");
            weightCurve = weightCurveProperty != null
                ? weightCurveProperty.animationCurveValue
                : null;

            return weightCurve != null && weightCurve.length > 0;
        }

        private static SkinnedMeshRenderer FindSkinnedMeshRenderer(GameObject root, string targetName)
        {
            if (root == null || string.IsNullOrWhiteSpace(targetName))
                return null;

            foreach (var renderer in root.GetComponentsInChildren<SkinnedMeshRenderer>(true))
            {
                if (renderer == null) continue;
                if (string.Equals(renderer.name, targetName, StringComparison.Ordinal))
                    return renderer;
            }

            return null;
        }

        private static AnimationClip GetPrimaryAnimationClip(
            Animator animator,
            string preferredClipName,
            float targetLength)
        {
            var controller = animator != null ? animator.runtimeAnimatorController : null;
            if (controller == null || controller.animationClips == null)
                return null;

            var clips = new List<AnimationClip>();
            var seen = new HashSet<AnimationClip>();
            foreach (var clip in controller.animationClips)
            {
                if (clip == null || clip.length <= 0f || !seen.Add(clip)) continue;
                clips.Add(clip);
            }

            if (clips.Count == 0)
                return null;

            if (animator.layerCount > 0)
            {
                var clipInfos = animator.GetCurrentAnimatorClipInfo(0);
                AnimationClip currentClip = null;
                var currentWeight = float.MinValue;
                foreach (var clipInfo in clipInfos)
                {
                    if (clipInfo.clip == null || !seen.Contains(clipInfo.clip)) continue;
                    if (currentClip != null && clipInfo.weight <= currentWeight) continue;

                    currentClip = clipInfo.clip;
                    currentWeight = clipInfo.weight;
                }

                if (currentClip != null)
                    return currentClip;
            }

            if (!string.IsNullOrWhiteSpace(preferredClipName))
            {
                foreach (var clip in clips)
                {
                    if (string.Equals(clip.name, preferredClipName, StringComparison.OrdinalIgnoreCase))
                        return clip;
                }
            }

            var closestCompatibleClip = default(AnimationClip);
            var closestLengthDelta = float.MaxValue;
            foreach (var clip in clips)
            {
                var delta = Mathf.Abs(clip.length - targetLength);
                if (delta > 0.05f || delta >= closestLengthDelta)
                    continue;

                closestCompatibleClip = clip;
                closestLengthDelta = delta;
            }

            if (closestCompatibleClip != null)
                return closestCompatibleClip;

            AnimationClip selectedClip = null;
            foreach (var clip in clips)
            {
                if (selectedClip == null || clip.length > selectedClip.length)
                    selectedClip = clip;
            }

            return selectedClip;
        }

        private static int BakeLipSyncControllerCurves(
            Transform lipSyncRoot,
            AnimationClip sourceClip,
            SkinnedMeshRenderer targetRenderer,
            Transform targetRoot,
            AnimationClip targetClip,
            float duration,
            Transform[] nodes,
            AnimationCurve weightCurve)
        {
            var mesh = targetRenderer != null ? targetRenderer.sharedMesh : null;
            if (lipSyncRoot == null || sourceClip == null || targetRenderer == null ||
                targetRoot == null || targetClip == null || mesh == null)
                return 0;

            if (!TryResolveLipSyncBlendShapeNames(mesh, out var blendShapeNames))
            {
                Debug.LogWarning(
                    $"Scene Sync export support: skipped LipSyncController for '{targetRenderer.name}' " +
                    "because A/I/U/E/O blend shape names could not be resolved.");
                return 0;
            }

            var nodeCurves = new AnimationCurve[nodes.Length];
            for (var i = 0; i < nodes.Length; i++)
            {
                var nodePath = GetRelativeTransformPath(lipSyncRoot, nodes[i]);
                if (nodePath == null)
                    return 0;

                nodeCurves[i] = AnimationUtility.GetEditorCurve(
                    sourceClip,
                    EditorCurveBinding.FloatCurve(nodePath, typeof(Transform), "m_LocalPosition.z")
                );

                if (nodeCurves[i] == null)
                    return 0;
            }

            var rendererPath = AnimationUtility.CalculateTransformPath(targetRenderer.transform, targetRoot);
            var sampleRate = Mathf.Max(1f, LipSyncSampleRate);
            var sampleCount = Mathf.Max(2, Mathf.CeilToInt(duration * sampleRate) + 1);
            var keyLists = new List<Keyframe>[blendShapeNames.Length];

            for (var i = 0; i < keyLists.Length; i++)
            {
                keyLists[i] = new List<Keyframe>(sampleCount);
            }

            for (var sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++)
            {
                var time = sampleIndex == sampleCount - 1
                    ? duration
                    : Mathf.Min(duration, sampleIndex / sampleRate);
                var total = 100f;

                for (var visemeIndex = 0; visemeIndex < keyLists.Length; visemeIndex++)
                {
                    var factor = weightCurve.Evaluate(nodeCurves[visemeIndex].Evaluate(time));
                    var weight = total * factor;
                    total -= weight;
                    keyLists[visemeIndex].Add(new Keyframe(time, weight));
                }
            }

            var copied = 0;
            for (var i = 0; i < blendShapeNames.Length; i++)
            {
                var blendShapeName = blendShapeNames[i];
                if (string.IsNullOrWhiteSpace(blendShapeName))
                    continue;

                var binding = EditorCurveBinding.FloatCurve(
                    rendererPath,
                    typeof(SkinnedMeshRenderer),
                    "blendShape." + blendShapeName
                );
                AnimationUtility.SetEditorCurve(targetClip, binding, new AnimationCurve(keyLists[i].ToArray()));
                copied++;
            }

            return copied;
        }

        private static bool TryResolveLipSyncBlendShapeNames(Mesh mesh, out string[] blendShapeNames)
        {
            blendShapeNames = null;
            if (mesh == null || LipSyncBlendShapeNameCandidates == null)
                return false;

            var resolved = new string[LipSyncBlendShapeNameCandidates.Length];
            for (var i = 0; i < LipSyncBlendShapeNameCandidates.Length; i++)
            {
                if (!TryFindBlendShapeName(mesh, LipSyncBlendShapeNameCandidates[i], out resolved[i]))
                    return false;
            }

            blendShapeNames = resolved;
            return true;
        }

        private static bool TryFindBlendShapeName(
            Mesh mesh,
            string[] candidates,
            out string blendShapeName)
        {
            blendShapeName = null;
            if (mesh == null || candidates == null || candidates.Length == 0)
                return false;

            for (var i = 0; i < mesh.blendShapeCount; i++)
            {
                var name = mesh.GetBlendShapeName(i);
                if (string.IsNullOrWhiteSpace(name))
                    continue;

                foreach (var candidate in candidates)
                {
                    if (MatchesBlendShapeName(name, candidate))
                    {
                        blendShapeName = name;
                        return true;
                    }
                }
            }

            return false;
        }

        private static bool MatchesBlendShapeName(string blendShapeName, string candidate)
        {
            if (string.IsNullOrWhiteSpace(blendShapeName) || string.IsNullOrWhiteSpace(candidate))
                return false;

            var candidateKey = NormalizeBlendShapeName(candidate);
            if (string.IsNullOrEmpty(candidateKey))
                return false;

            var fullKey = NormalizeBlendShapeName(blendShapeName);
            if (fullKey == candidateKey)
                return true;

            var leafName = blendShapeName;
            var lastDot = leafName.LastIndexOf('.');
            if (lastDot >= 0 && lastDot < leafName.Length - 1)
                leafName = leafName.Substring(lastDot + 1);

            return NormalizeBlendShapeName(leafName) == candidateKey;
        }

        private static string NormalizeBlendShapeName(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
                return "";

            var chars = new char[value.Length];
            var count = 0;
            foreach (var ch in value)
            {
                if (!char.IsLetterOrDigit(ch)) continue;
                chars[count++] = char.ToUpperInvariant(ch);
            }

            return new string(chars, 0, count);
        }

        private static string GetRelativeTransformPath(Transform root, Transform target)
        {
            if (root == null || target == null)
                return null;
            if (root == target)
                return "";

            var names = new List<string>();
            var current = target;
            while (current != null && current != root)
            {
                names.Add(current.name);
                current = current.parent;
            }

            if (current != root)
                return null;

            names.Reverse();
            return string.Join("/", names);
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
