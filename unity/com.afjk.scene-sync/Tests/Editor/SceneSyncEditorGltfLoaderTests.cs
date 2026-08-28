using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using Afjk.SceneSync.Editor;
using NUnit.Framework;
using UnityEngine;

namespace Afjk.SceneSync.Tests
{
    public class SceneSyncEditorGltfLoaderTests
    {
        // Minimal GLB with one skin and two mesh primitives. glTFast versions before
        // 6.15.0 throw from SortAndNormalizeBoneWeightsJob while importing this shape.
        private const string MultiPrimitiveSkinnedGlbBase64 =
            "Z2xURgIAAABoCQAA3AcAAEpTT057ImFzc2V0Ijp7ImdlbmVyYXRvciI6ImdsVEYtVHJhbnNmb3JtIHY0LjMuMCIsInZlcnNpb24iOiIyLjAifSwiYWNjZXNzb3JzIjpbeyJuYW1lIjoibGVmdCBwb3NpdGlvbnMiLCJ0eXBlIjoiVkVDMyIsImNvbXBvbmVudFR5cGUiOjUxMjYsImNvdW50IjozLCJtYXgiOlswLDEsMF0sIm1pbiI6Wy0xLDAsMF0sImJ1ZmZlclZpZXciOjAsImJ5dGVPZmZzZXQiOjB9LHsibmFtZSI6ImxlZnQgbm9ybWFscyIsInR5cGUiOiJWRUMzIiwiY29tcG9uZW50VHlwZSI6NTEyNiwiY291bnQiOjMsImJ1ZmZlclZpZXciOjAsImJ5dGVPZmZzZXQiOjEyfSx7Im5hbWUiOiJsZWZ0IGpvaW50cyIsInR5cGUiOiJWRUM0IiwiY29tcG9uZW50VHlwZSI6NTEyMywiY291bnQiOjMsImJ1ZmZlclZpZXciOjAsImJ5dGVPZmZzZXQiOjI0fSx7Im5hbWUiOiJsZWZ0IHdlaWdodHMiLCJ0eXBlIjoiVkVDNCIsImNvbXBvbmVudFR5cGUiOjUxMjYsImNvdW50IjozLCJidWZmZXJWaWV3IjowLCJieXRlT2Zmc2V0IjozMn0seyJuYW1lIjoibGVmdCBpbmRpY2VzIiwidHlwZSI6IlNDQUxBUiIsImNvbXBvbmVudFR5cGUiOjUxMjMsImNvdW50IjozLCJidWZmZXJWaWV3IjoxLCJieXRlT2Zmc2V0IjowfSx7Im5hbWUiOiJyaWdodCBpbmRpY2VzIiwidHlwZSI6IlNDQUxBUiIsImNvbXBvbmVudFR5cGUiOjUxMjMsImNvdW50IjozLCJidWZmZXJWaWV3IjoxLCJieXRlT2Zmc2V0Ijo4fSx7Im5hbWUiOiJyaWdodCBwb3NpdGlvbnMiLCJ0eXBlIjoiVkVDMyIsImNvbXBvbmVudFR5cGUiOjUxMjYsImNvdW50IjozLCJtYXgiOlsxLDEsMF0sIm1pbiI6WzAsMCwwXSwiYnVmZmVyVmlldyI6MiwiYnl0ZU9mZnNldCI6MH0seyJuYW1lIjoicmlnaHQgbm9ybWFscyIsInR5cGUiOiJWRUMzIiwiY29tcG9uZW50VHlwZSI6NTEyNiwiY291bnQiOjMsImJ1ZmZlclZpZXciOjIsImJ5dGVPZmZzZXQiOjEyfSx7Im5hbWUiOiJyaWdodCBqb2ludHMiLCJ0eXBlIjoiVkVDNCIsImNvbXBvbmVudFR5cGUiOjUxMjMsImNvdW50IjozLCJidWZmZXJWaWV3IjoyLCJieXRlT2Zmc2V0IjoyNH0seyJuYW1lIjoicmlnaHQgd2VpZ2h0cyIsInR5cGUiOiJWRUM0IiwiY29tcG9uZW50VHlwZSI6NTEyNiwiY291bnQiOjMsImJ1ZmZlclZpZXciOjIsImJ5dGVPZmZzZXQiOjMyfSx7Im5hbWUiOiJpbnZlcnNlIGJpbmQgbWF0cmljZXMiLCJ0eXBlIjoiTUFUNCIsImNvbXBvbmVudFR5cGUiOjUxMjYsImNvdW50IjoxLCJidWZmZXJWaWV3IjozLCJieXRlT2Zmc2V0IjowfV0sImJ1ZmZlclZpZXdzIjpbeyJidWZmZXIiOjAsImJ5dGVPZmZzZXQiOjAsImJ5dGVMZW5ndGgiOjE0NCwiYnl0ZVN0cmlkZSI6NDgsInRhcmdldCI6MzQ5NjJ9LHsiYnVmZmVyIjowLCJieXRlT2Zmc2V0IjoxNDQsImJ5dGVMZW5ndGgiOjE2LCJ0YXJnZXQiOjM0OTYzfSx7ImJ1ZmZlciI6MCwiYnl0ZU9mZnNldCI6MTYwLCJieXRlTGVuZ3RoIjoxNDQsImJ5dGVTdHJpZGUiOjQ4LCJ0YXJnZXQiOjM0OTYyfSx7ImJ1ZmZlciI6MCwiYnl0ZU9mZnNldCI6MzA0LCJieXRlTGVuZ3RoIjo2NH1dLCJidWZmZXJzIjpbeyJieXRlTGVuZ3RoIjozNjh9XSwibWVzaGVzIjpbeyJuYW1lIjoidHdvIHByaW1pdGl2ZSBza2lubmVkIG1lc2giLCJwcmltaXRpdmVzIjpbeyJhdHRyaWJ1dGVzIjp7IlBPU0lUSU9OIjowLCJOT1JNQUwiOjEsIkpPSU5UU18wIjoyLCJXRUlHSFRTXzAiOjN9LCJtb2RlIjo0LCJpbmRpY2VzIjo0fSx7ImF0dHJpYnV0ZXMiOnsiUE9TSVRJT04iOjYsIk5PUk1BTCI6NywiSk9JTlRTXzAiOjgsIldFSUdIVFNfMCI6OX0sIm1vZGUiOjQsImluZGljZXMiOjV9XX1dLCJub2RlcyI6W3sibmFtZSI6InJvb3QiLCJjaGlsZHJlbiI6WzEsMl19LHsibmFtZSI6ImpvaW50In0seyJuYW1lIjoibW9kZWwiLCJtZXNoIjowLCJza2luIjowfV0sInNraW5zIjpbeyJuYW1lIjoic2tpbiIsImludmVyc2VCaW5kTWF0cmljZXMiOjEwLCJza2VsZXRvbiI6MSwiam9pbnRzIjpbMV19XSwic2NlbmVzIjpbeyJuYW1lIjoic2NlbmUiLCJub2RlcyI6WzBdfV19IHABAABCSU4AAACAvwAAAAAAAAAAAAAAAAAAAAAAAIA/AAAAAAAAAAAAAIA/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIA/AAAAAAAAAAAAAIA/AAAAAAAAAAAAAAAAAACAvwAAgD8AAAAAAAAAAAAAAAAAAIA/AAAAAAAAAAAAAIA/AAAAAAAAAAAAAAAAAAABAAIAAAAAAAEAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAPwAAAAAAAAAAAACAPwAAAAAAAAAAAAAAAAAAgD8AAAAAAAAAAAAAAAAAAAAAAACAPwAAAAAAAAAAAACAPwAAAAAAAAAAAAAAAAAAgD8AAIA/AAAAAAAAAAAAAAAAAACAPwAAAAAAAAAAAACAPwAAAAAAAAAAAAAAAAAAgD8AAAAAAAAAAAAAAAAAAAAAAACAPwAAAAAAAAAAAAAAAAAAAAAAAIA/AAAAAAAAAAAAAAAAAAAAAAAAgD8=";

        [Test]
        public async Task LoadAsync_MultiPrimitiveSkinnedGlb_CreatesSkinnedMeshAndDeletesTempFile()
        {
            var existingTempFiles = new HashSet<string>(Directory.GetFiles(
                Application.temporaryCachePath,
                SceneSyncEditorGltfLoader.TempFilePrefix + "*.glb"));
            GameObject importedObject = null;

            try
            {
                importedObject = await SceneSyncEditorGltfLoader.LoadAsync(
                    Convert.FromBase64String(MultiPrimitiveSkinnedGlbBase64),
                    "MultiPrimitiveSkinned",
                    applyUnityImportYawCorrection: false);

                Assert.That(importedObject, Is.Not.Null);
                var skinnedRenderer = importedObject.GetComponentInChildren<SkinnedMeshRenderer>(true);
                Assert.That(skinnedRenderer, Is.Not.Null);
                Assert.That(skinnedRenderer.sharedMesh, Is.Not.Null);
                Assert.That(skinnedRenderer.sharedMesh.subMeshCount, Is.EqualTo(2));
            }
            finally
            {
                if (importedObject != null)
                {
                    SceneSyncEditorGltfLoader.Release(importedObject);
                    UnityEngine.Object.DestroyImmediate(importedObject);
                }
            }

            var remainingTempFiles = new HashSet<string>(Directory.GetFiles(
                Application.temporaryCachePath,
                SceneSyncEditorGltfLoader.TempFilePrefix + "*.glb"));
            CollectionAssert.AreEquivalent(existingTempFiles, remainingTempFiles);
        }
    }
}
