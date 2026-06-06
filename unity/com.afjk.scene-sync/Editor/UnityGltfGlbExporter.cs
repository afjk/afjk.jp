#if UNITY_EDITOR && SCENESYNC_USE_UNITYGLTF
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
            var context = new ExportContext();
            var exporter = new GLTFSceneExporter(
                new[] { go.transform },
                context
            );

            return exporter.SaveGLBToByteArray(go.name);
        }
    }
}
#endif
