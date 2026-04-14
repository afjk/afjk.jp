using UnityEngine;

namespace Afjk.Pipe.Internal
{
    /// <summary>
    /// UnityWebRequest のコルーチンをバックグラウンドから起動するための
    /// MonoBehaviour シングルトン。PipeClient によって自動生成される。
    /// </summary>
    internal class MainThreadDispatcher : MonoBehaviour
    {
        private static MainThreadDispatcher _instance;

        internal static MainThreadDispatcher Instance
        {
            get
            {
                if (_instance != null) return _instance;
                var go = new GameObject("[Pipe] MainThreadDispatcher")
                {
                    hideFlags = HideFlags.HideAndDontSave
                };
                DontDestroyOnLoad(go);
                _instance = go.AddComponent<MainThreadDispatcher>();
                return _instance;
            }
        }

        private void OnDestroy()
        {
            if (_instance == this) _instance = null;
        }
    }
}
