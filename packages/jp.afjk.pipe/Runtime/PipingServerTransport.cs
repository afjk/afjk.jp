using System;
using System.Collections;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;
using Afjk.Pipe.Internal;

namespace Afjk.Pipe
{
    /// <summary>
    /// piping-server (https://pipe.afjk.jp) を使った HTTP ストリーミング転送。
    /// - 送信: POST /{path}
    /// - 受信: GET  /{path}  （送信側が POST するまでブロック）
    /// テキスト転送も同じ仕組みでバイト列として扱う。
    /// </summary>
    public static class PipingServerTransport
    {
        // ── Send ────────────────────────────────────────────────────────────────

        /// <summary>バイト配列をパスへ POST する。</summary>
        public static Task SendAsync(
            string pipingEndpoint,
            string path,
            byte[] data,
            string contentType     = "application/octet-stream",
            IProgress<float> progress = null,
            CancellationToken ct   = default)
        {
            var tcs = new TaskCompletionSource<bool>();
            MainThreadDispatcher.Instance.StartCoroutine(
                SendCoroutine(pipingEndpoint, path, data, contentType, progress, ct, tcs));
            return tcs.Task;
        }

        /// <summary>テキストをパスへ送信する。</summary>
        public static Task SendTextAsync(
            string pipingEndpoint,
            string path,
            string text,
            CancellationToken ct = default)
        {
            var data = Encoding.UTF8.GetBytes(text);
            return SendAsync(pipingEndpoint, path, data, "text/plain; charset=utf-8", null, ct);
        }

        private static IEnumerator SendCoroutine(
            string pipingEndpoint,
            string path,
            byte[] data,
            string contentType,
            IProgress<float> progress,
            CancellationToken ct,
            TaskCompletionSource<bool> tcs)
        {
            var url = $"{pipingEndpoint.TrimEnd('/')}/{path}";
            using var req = new UnityWebRequest(url, UnityWebRequest.kHttpVerbPUT)
            {
                uploadHandler   = new UploadHandlerRaw(data),
                downloadHandler = new DownloadHandlerBuffer(),
                timeout         = 0    // 受信側が来るまで待つ（タイムアウトなし）
            };
            req.SetRequestHeader("Content-Type", contentType);

            var op = req.SendWebRequest();
            while (!op.isDone)
            {
                if (ct.IsCancellationRequested)
                {
                    req.Abort();
                    tcs.TrySetCanceled();
                    yield break;
                }
                progress?.Report(op.progress);
                yield return null;
            }

            if (req.result == UnityWebRequest.Result.Success)
            {
                progress?.Report(1f);
                tcs.TrySetResult(true);
            }
            else
            {
                tcs.TrySetException(new Exception($"[Pipe] Send failed: {req.error}"));
            }
        }

        // ── Receive ─────────────────────────────────────────────────────────────

        /// <summary>パスから GET してバイト配列で受け取る。</summary>
        public static Task<byte[]> ReceiveAsync(
            string pipingEndpoint,
            string path,
            IProgress<float> progress = null,
            CancellationToken ct      = default)
        {
            var tcs = new TaskCompletionSource<byte[]>();
            MainThreadDispatcher.Instance.StartCoroutine(
                ReceiveCoroutine(pipingEndpoint, path, progress, ct, tcs));
            return tcs.Task;
        }

        /// <summary>パスから GET してテキストで受け取る。</summary>
        public static async Task<string> ReceiveTextAsync(
            string pipingEndpoint,
            string path,
            IProgress<float> progress = null,
            CancellationToken ct      = default)
        {
            var bytes = await ReceiveAsync(pipingEndpoint, path, progress, ct);
            return Encoding.UTF8.GetString(bytes);
        }

        private static IEnumerator ReceiveCoroutine(
            string pipingEndpoint,
            string path,
            IProgress<float> progress,
            CancellationToken ct,
            TaskCompletionSource<byte[]> tcs)
        {
            var url = $"{pipingEndpoint.TrimEnd('/')}/{path}";
            using var req = UnityWebRequest.Get(url);
            req.timeout = 0;   // 送信側が来るまで待つ

            var op = req.SendWebRequest();
            while (!op.isDone)
            {
                if (ct.IsCancellationRequested)
                {
                    req.Abort();
                    tcs.TrySetCanceled();
                    yield break;
                }
                if (req.downloadedBytes > 0)
                    progress?.Report((float)req.downloadedBytes / Math.Max(1, req.downloadedBytes));
                yield return null;
            }

            if (req.result == UnityWebRequest.Result.Success)
            {
                progress?.Report(1f);
                tcs.TrySetResult(req.downloadHandler.data);
            }
            else
            {
                tcs.TrySetException(new Exception($"[Pipe] Receive failed: {req.error}"));
            }
        }
    }
}
