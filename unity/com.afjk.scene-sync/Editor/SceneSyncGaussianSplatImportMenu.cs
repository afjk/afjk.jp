using System.IO;
using UnityEditor;
using UnityEngine;

namespace Afjk.SceneSync.Editor
{
    /// <summary>
    /// KHR_gaussian_splatting GLB を編集中のシーンへ配置する Editor メニュー。
    ///
    /// Unity 標準の glTF importer（glTFast）は KHR_gaussian_splatting を解釈できないため、
    /// .glb を Project へ入れる通常の import 経路ではなく、GLB を参照する
    /// <see cref="SceneSyncGaussianSplatSource"/> を追加する。
    /// 表示は <c>[ExecuteAlways]</c> のコンポーネントが Editor 上で組み立てるので、
    /// 確認のために Play モードへ入る必要はない。
    /// </summary>
    public static class SceneSyncGaussianSplatImportMenu
    {
        private const string LastDirectoryKey = "SceneSync.GaussianSplat.LastImportDirectory";

        [MenuItem("GameObject/Scene Sync/Import Gaussian Splat GLB...", false, 21)]
        public static void ImportGaussianSplatGlb()
        {
            var directory = EditorPrefs.GetString(LastDirectoryKey, "");
            var path = EditorUtility.OpenFilePanel("Gaussian Splat GLB を選択", directory, "glb");
            if (string.IsNullOrEmpty(path)) return;

            EditorPrefs.SetString(LastDirectoryKey, Path.GetDirectoryName(path));

            byte[] glb;
            try
            {
                glb = File.ReadAllBytes(path);
            }
            catch (IOException err)
            {
                EditorUtility.DisplayDialog(
                    "Scene Sync",
                    "GLB を読めませんでした:\n" + path + "\n\n" + err.Message,
                    "OK");
                return;
            }

            var info = SceneSyncGaussianSplatGlb.Inspect(glb);
            if (!info.HasGaussianSplatting)
            {
                EditorUtility.DisplayDialog(
                    "Scene Sync",
                    Path.GetFileName(path) + " は KHR_gaussian_splatting GLB ではありません。\n"
                    + "通常の GLB は Project へ import して配置してください。",
                    "OK");
                return;
            }

            if (!info.Valid)
            {
                EditorUtility.DisplayDialog(
                    "Scene Sync",
                    Path.GetFileName(path) + " は KHR_gaussian_splatting GLB として不正です:\n\n"
                    + string.Join("\n", info.Errors.ToArray()),
                    "OK");
                return;
            }

            var go = new GameObject(Path.GetFileNameWithoutExtension(path));
            var source = go.AddComponent<SceneSyncGaussianSplatSource>();
            source.GlbPath = path;
            source.Reload();

            var selected = Selection.activeGameObject;
            if (selected != null)
                GameObjectUtility.SetParentAndAlign(go, selected);

            Undo.RegisterCreatedObjectUndo(go, "Import Gaussian Splat GLB");
            Selection.activeGameObject = go;

            Debug.Log("[SceneSync] Gaussian Splat GLB added: " + path + " (" + info + ")", go);

            if (source.VisualSource == SceneSyncGaussianSplatBackend.SourcePreview
                && !SceneSyncGaussianSplatBackend.IsAvailable
                && EditorUtility.DisplayDialog(
                    "Scene Sync",
                    "The GLB is visible as a point preview because the real Gaussian Splat renderer is not installed.\n\n"
                    + "Install pinned UnitySplats v1.2.0 now?",
                    "Install UnitySplats",
                    "Keep Preview"))
            {
                SceneSyncUnitySplatsInstaller.InstallUnitySplats();
            }
        }
    }
}
