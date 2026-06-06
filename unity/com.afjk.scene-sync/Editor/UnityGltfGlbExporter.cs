#if UNITY_EDITOR && SCENESYNC_USE_UNITYGLTF
using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityGLTF;

namespace Afjk.SceneSync
{
    [InitializeOnLoad]
    internal static class UnityGltfGlbExporter
    {
        static UnityGltfGlbExporter()
        {
            GlbExporter.UnityGltfExportHandler = Export;
        }

        public static byte[] Export(GameObject go)
        {
            var progress = new UnityGltfExportProgress(go);
            var context = new ExportContext();
            context.BeforeSceneExport = (_, __) => progress.ReportPreparing();
            context.AfterNodeExport = (_, __, transform, ___) => progress.ReportNode(transform);
            context.AfterMeshExport = (_, mesh, __, ___) => progress.ReportMesh(mesh);
            context.AfterMaterialExport = (_, __, material, ___) => progress.ReportMaterial(material);
            context.AfterSceneExport = (_, __) => progress.ReportSerializing();

            var exporter = new GLTFSceneExporter(
                new[] { go.transform },
                context
            );

            progress.ReportStarting();
            var bytes = exporter.SaveGLBToByteArray(go.name);
            progress.ReportComplete();
            return bytes;
        }

        private sealed class UnityGltfExportProgress
        {
            private const double MinReportIntervalSeconds = 0.15;
            private readonly string _objectName;
            private readonly int _totalNodes;
            private readonly int _totalMeshes;
            private readonly int _totalMaterials;
            private int _exportedNodes;
            private int _exportedMeshes;
            private int _exportedMaterials;
            private float _lastProgress;
            private double _lastReportTime;

            public UnityGltfExportProgress(GameObject root)
            {
                _objectName = root != null ? root.name : "Object";
                _totalNodes = Mathf.Max(1, root != null ? root.GetComponentsInChildren<Transform>(true).Length : 1);
                _totalMeshes = Mathf.Max(1, CountUniqueMeshes(root));
                _totalMaterials = Mathf.Max(1, CountUniqueMaterials(root));
                _lastReportTime = -MinReportIntervalSeconds;
            }

            public void ReportStarting()
            {
                Report("Starting UnityGLTF export: " + _objectName, 0.08f, true);
            }

            public void ReportPreparing()
            {
                Report("Preparing UnityGLTF export: " + _objectName, 0.12f, true);
            }

            public void ReportNode(Transform transform)
            {
                _exportedNodes++;
                var name = transform != null ? transform.name : _objectName;
                Report(
                    $"Exporting nodes {_exportedNodes}/{_totalNodes}: {name}",
                    Mathf.Lerp(0.12f, 0.42f, Mathf.Clamp01(_exportedNodes / (float)_totalNodes))
                );
            }

            public void ReportMesh(Mesh mesh)
            {
                _exportedMeshes++;
                var name = mesh != null ? mesh.name : _objectName;
                Report(
                    $"Exporting meshes {_exportedMeshes}/{_totalMeshes}: {name}",
                    Mathf.Lerp(0.42f, 0.68f, Mathf.Clamp01(_exportedMeshes / (float)_totalMeshes))
                );
            }

            public void ReportMaterial(Material material)
            {
                _exportedMaterials++;
                var name = material != null ? material.name : _objectName;
                Report(
                    $"Exporting materials {_exportedMaterials}/{_totalMaterials}: {name}",
                    Mathf.Lerp(0.68f, 0.78f, Mathf.Clamp01(_exportedMaterials / (float)_totalMaterials))
                );
            }

            public void ReportSerializing()
            {
                Report("Serializing GLB: " + _objectName, 0.86f, true);
            }

            public void ReportComplete()
            {
                Report("UnityGLTF export complete: " + _objectName, 1f, true);
            }

            private void Report(string message, float progress, bool force = false)
            {
                ThrowIfCanceled();

                var now = EditorApplication.timeSinceStartup;
                progress = Mathf.Clamp01(Mathf.Max(_lastProgress, progress));
                if (!force && now - _lastReportTime < MinReportIntervalSeconds)
                {
                    return;
                }

                _lastProgress = progress;
                _lastReportTime = now;
                GlbExporter.ReportEditorExportProgress(message, progress);
                ThrowIfCanceled();
            }

            private static void ThrowIfCanceled()
            {
                if (GlbExporter.IsEditorExportCancellationRequested())
                {
                    throw new OperationCanceledException("Scene Sync UnityGLTF export canceled.");
                }
            }

            private static int CountUniqueMeshes(GameObject root)
            {
                if (root == null) return 0;

                var meshes = new HashSet<Mesh>();
                foreach (var meshFilter in root.GetComponentsInChildren<MeshFilter>(true))
                {
                    if (meshFilter != null && meshFilter.sharedMesh != null)
                        meshes.Add(meshFilter.sharedMesh);
                }

                foreach (var skinnedMeshRenderer in root.GetComponentsInChildren<SkinnedMeshRenderer>(true))
                {
                    if (skinnedMeshRenderer != null && skinnedMeshRenderer.sharedMesh != null)
                        meshes.Add(skinnedMeshRenderer.sharedMesh);
                }

                return meshes.Count;
            }

            private static int CountUniqueMaterials(GameObject root)
            {
                if (root == null) return 0;

                var materials = new HashSet<Material>();
                foreach (var renderer in root.GetComponentsInChildren<Renderer>(true))
                {
                    if (renderer == null || renderer.sharedMaterials == null) continue;
                    foreach (var material in renderer.sharedMaterials)
                    {
                        if (material != null)
                            materials.Add(material);
                    }
                }

                return materials.Count;
            }
        }
    }
}
#endif
