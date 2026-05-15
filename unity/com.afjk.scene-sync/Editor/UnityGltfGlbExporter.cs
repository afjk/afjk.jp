#if UNITY_EDITOR && SCENESYNC_USE_UNITYGLTF
using UnityEngine;
using UnityGLTF;

namespace Afjk.SceneSync
{
    internal static class UnityGltfGlbExporter
    {
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
