using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Unity.WebRTC;
using UnityEngine;
using UnityEngine.Networking;

namespace Afjk.Pipe
{
    /// <summary>
    /// WebRTC DataChannel による P2P ファイル転送。
    /// piping-server を SDP 交換チャンネルとして使用する（ブラウザ実装と同プロトコル）。
    ///
    /// シグナリングフロー:
    ///   送信側: POST {path}.__offer (SDP offer) → GET {path}.__answer (SDP answer)
    ///   受信側: GET  {path}.__offer (SDP offer) → POST {path}.__answer (SDP answer)
    ///
    /// データフレームプロトコル (DataChannel):
    ///   { t:'meta', name, mime, size } → バイナリチャンク × N → { t:'done' }
    /// </summary>
    public class WebRtcTransport : MonoBehaviour
    {
        // ── タイムアウト定数 (JS 実装と同値) ─────────────────────────────────────
        private const float SigTimeoutSec = 8f;
        private const float IceTimeoutSec = 3f;
        private const float DcTimeoutSec  = 5f;

        // ── フロー制御 ────────────────────────────────────────────────────────────
        private const int ChunkSize  = 65536;                    // 64KB (Safari/Unity 安全値)
        private const int FlowHigh   = ChunkSize * 32;          // 送信バッファ上限
        private const int FlowLow    = ChunkSize * 8;           // 再送信開始閾値

        // ── シングルトン ──────────────────────────────────────────────────────────
        private static WebRtcTransport _instance;

        internal static WebRtcTransport Instance
        {
            get
            {
                if (_instance != null) return _instance;
                var go = new GameObject("[Pipe] WebRtcTransport")
                    { hideFlags = HideFlags.HideAndDontSave };
                DontDestroyOnLoad(go);
                _instance = go.AddComponent<WebRtcTransport>();
                return _instance;
            }
        }

        // ── ICE 設定 ──────────────────────────────────────────────────────────────
        private RTCConfiguration _rtcConfig;

        private void Awake()
        {
            if (_instance != null && _instance != this) { Destroy(gameObject); return; }
            _instance = this;

            _rtcConfig = new RTCConfiguration
            {
                iceServers = new[]
                {
                    new RTCIceServer { urls = new[] { "stun:stun.l.google.com:19302" } }
                }
            };
            StartCoroutine(WebRTC.Update());
        }

        private void OnDestroy()
        {
            if (_instance == this) _instance = null;
        }

        // ── Public API ───────────────────────────────────────────────────────────

        /// <summary>
        /// P2P でファイルを送信する。
        /// 返り値が false の場合は piping-server HTTP にフォールバックする。
        /// </summary>
        public Task<bool> TrySendAsync(
            string pipingEndpoint,
            string path,
            byte[] data,
            string filename,
            string mimeType,
            IProgress<float> progress,
            CancellationToken ct)
        {
            var tcs = new TaskCompletionSource<bool>();
            StartCoroutine(SendCoroutine(pipingEndpoint, path, data, filename, mimeType, progress, ct, tcs));
            return tcs.Task;
        }

        /// <summary>
        /// P2P でファイルを受信する。
        /// Success が false の場合は piping-server HTTP にフォールバックする。
        /// </summary>
        public Task<WebRtcReceiveResult> TryReceiveAsync(
            string pipingEndpoint,
            string path,
            IProgress<float> progress,
            CancellationToken ct)
        {
            var tcs = new TaskCompletionSource<WebRtcReceiveResult>();
            StartCoroutine(RecvCoroutine(pipingEndpoint, path, progress, ct, tcs));
            return tcs.Task;
        }

        // ── 送信コルーチン ────────────────────────────────────────────────────────

        private IEnumerator SendCoroutine(
            string pipingEndpoint, string path,
            byte[] data, string filename, string mimeType,
            IProgress<float> progress,
            CancellationToken ct,
            TaskCompletionSource<bool> tcs)
        {
            RTCPeerConnection pc = null;
            RTCDataChannel dc    = null;

            var offerUrl  = $"{pipingEndpoint.TrimEnd('/')}/{path}.__offer";
            var answerUrl = $"{pipingEndpoint.TrimEnd('/')}/{path}.__answer";

            try
            {
                pc = new RTCPeerConnection(ref _rtcConfig);
                dc = pc.CreateDataChannel("pipe", new RTCDataChannelInit { ordered = true });

                // ── offer 生成 ────────────────────────────────────────────────────
                var offerOp = pc.CreateOffer();
                yield return offerOp;
                if (offerOp.IsError || ct.IsCancellationRequested)
                    { tcs.TrySetResult(false); yield break; }

                var offer = offerOp.Desc;
                var setLocalOp = pc.SetLocalDescription(ref offer);
                yield return setLocalOp;
                if (setLocalOp.IsError || ct.IsCancellationRequested)
                    { tcs.TrySetResult(false); yield break; }

                // ── ICE 収集待ち ──────────────────────────────────────────────────
                var iceEnd = Time.realtimeSinceStartup + IceTimeoutSec;
                yield return new WaitUntil(() =>
                    pc.GatheringState == RTCIceGatheringState.Complete
                    || Time.realtimeSinceStartup >= iceEnd
                    || ct.IsCancellationRequested);

                if (ct.IsCancellationRequested) { tcs.TrySetResult(false); yield break; }

                // ── offer を piping-server へ POST (fire and forget) ──────────────
                var offerJson = SerializeSdp(pc.LocalDescription);
                StartCoroutine(PostJson(offerUrl, offerJson));

                // ── answer を GET (SIG_TIMEOUT) ───────────────────────────────────
                string answerJson = null;
                bool   answerErr  = false;
                StartCoroutine(GetJson(answerUrl, SigTimeoutSec,
                    j  => answerJson = j,
                    () => answerErr  = true));

                var sigEnd = Time.realtimeSinceStartup + SigTimeoutSec;
                yield return new WaitUntil(() =>
                    answerJson != null || answerErr
                    || Time.realtimeSinceStartup >= sigEnd
                    || ct.IsCancellationRequested);

                if (answerJson == null || ct.IsCancellationRequested)
                    { tcs.TrySetResult(false); yield break; }

                // ── answer をセット ───────────────────────────────────────────────
                var answer = DeserializeSdp(answerJson, RTCSdpType.Answer);
                var setRemoteOp = pc.SetRemoteDescription(ref answer);
                yield return setRemoteOp;
                if (setRemoteOp.IsError || ct.IsCancellationRequested)
                    { tcs.TrySetResult(false); yield break; }

                // ── DataChannel open 待ち ─────────────────────────────────────────
                bool dcOpen = false;
                dc.OnOpen  = () => dcOpen = true;

                var dcEnd = Time.realtimeSinceStartup + DcTimeoutSec;
                yield return new WaitUntil(() =>
                    dcOpen || Time.realtimeSinceStartup >= dcEnd || ct.IsCancellationRequested);

                if (!dcOpen || ct.IsCancellationRequested)
                    { tcs.TrySetResult(false); yield break; }

                // ── データ送信 ────────────────────────────────────────────────────
                dc.Send(JsonUtility.ToJson(new MetaFrame
                    { t = "meta", name = filename, mime = mimeType, size = data.Length }));

                int sent = 0;
                while (sent < data.Length && !ct.IsCancellationRequested)
                {
                    // フロー制御: バッファが詰まったら待機
                    if (dc.BufferedAmount > FlowHigh)
                    {
                        yield return new WaitUntil(() =>
                            dc.BufferedAmount <= FlowLow || ct.IsCancellationRequested);
                    }

                    int sz    = Math.Min(ChunkSize, data.Length - sent);
                    var chunk = new byte[sz];
                    Buffer.BlockCopy(data, sent, chunk, 0, sz);
                    dc.Send(chunk);
                    sent += sz;
                    progress?.Report((float)sent / data.Length);
                    yield return null;   // 1フレーム譲渡
                }

                if (ct.IsCancellationRequested) { tcs.TrySetResult(false); yield break; }

                dc.Send(JsonUtility.ToJson(new DoneFrame { t = "done" }));
                tcs.TrySetResult(true);
            }
            finally
            {
                try { dc?.Close(); }  catch { }
                try { pc?.Close(); }  catch { }
            }
        }

        // ── 受信コルーチン ────────────────────────────────────────────────────────

        private IEnumerator RecvCoroutine(
            string pipingEndpoint, string path,
            IProgress<float> progress,
            CancellationToken ct,
            TaskCompletionSource<WebRtcReceiveResult> tcs)
        {
            RTCPeerConnection pc = null;

            var offerUrl  = $"{pipingEndpoint.TrimEnd('/')}/{path}.__offer";
            var answerUrl = $"{pipingEndpoint.TrimEnd('/')}/{path}.__answer";

            try
            {
                pc = new RTCPeerConnection(ref _rtcConfig);

                // ── offer を GET (SIG_TIMEOUT) ────────────────────────────────────
                string offerJson = null;
                bool   offerErr  = false;
                StartCoroutine(GetJson(offerUrl, SigTimeoutSec,
                    j  => offerJson = j,
                    () => offerErr  = true));

                var sigEnd = Time.realtimeSinceStartup + SigTimeoutSec;
                yield return new WaitUntil(() =>
                    offerJson != null || offerErr
                    || Time.realtimeSinceStartup >= sigEnd
                    || ct.IsCancellationRequested);

                if (offerJson == null || ct.IsCancellationRequested)
                    { tcs.TrySetResult(new WebRtcReceiveResult { Success = false }); yield break; }

                // ── offer をセット ────────────────────────────────────────────────
                var offer = DeserializeSdp(offerJson, RTCSdpType.Offer);
                var setRemoteOp = pc.SetRemoteDescription(ref offer);
                yield return setRemoteOp;
                if (setRemoteOp.IsError || ct.IsCancellationRequested)
                    { tcs.TrySetResult(new WebRtcReceiveResult { Success = false }); yield break; }

                // ── answer 生成 ───────────────────────────────────────────────────
                var answerOp = pc.CreateAnswer();
                yield return answerOp;
                if (answerOp.IsError || ct.IsCancellationRequested)
                    { tcs.TrySetResult(new WebRtcReceiveResult { Success = false }); yield break; }

                var answer = answerOp.Desc;
                var setLocalOp = pc.SetLocalDescription(ref answer);
                yield return setLocalOp;
                if (setLocalOp.IsError || ct.IsCancellationRequested)
                    { tcs.TrySetResult(new WebRtcReceiveResult { Success = false }); yield break; }

                // ── ICE 収集待ち ──────────────────────────────────────────────────
                var iceEnd = Time.realtimeSinceStartup + IceTimeoutSec;
                yield return new WaitUntil(() =>
                    pc.GatheringState == RTCIceGatheringState.Complete
                    || Time.realtimeSinceStartup >= iceEnd
                    || ct.IsCancellationRequested);

                if (ct.IsCancellationRequested)
                    { tcs.TrySetResult(new WebRtcReceiveResult { Success = false }); yield break; }

                // ── answer を POST (fire and forget) ──────────────────────────────
                StartCoroutine(PostJson(answerUrl, SerializeSdp(pc.LocalDescription)));

                // ── DataChannel 到着待ち ──────────────────────────────────────────
                RTCDataChannel dc = null;
                pc.OnDataChannel = ch => dc = ch;

                var dcEnd = Time.realtimeSinceStartup + DcTimeoutSec;
                yield return new WaitUntil(() =>
                    dc != null || Time.realtimeSinceStartup >= dcEnd || ct.IsCancellationRequested);

                if (dc == null || ct.IsCancellationRequested)
                    { tcs.TrySetResult(new WebRtcReceiveResult { Success = false }); yield break; }

                // ── データ受信 ────────────────────────────────────────────────────
                var chunks   = new List<byte[]>();
                int received = 0;
                string recvFilename = null, recvMime = null;
                int expectedSize    = 0;
                bool done           = false;
                bool dcError        = false;

                dc.OnMessage = bytes =>
                {
                    // JSON 制御フレーム判定: 先頭バイトが '{' ならテキストフレーム
                    if (bytes.Length > 0 && bytes[0] == (byte)'{')
                    {
                        try
                        {
                            var json  = Encoding.UTF8.GetString(bytes);
                            var probe = JsonUtility.FromJson<TypeProbe>(json);
                            if (probe.t == "meta")
                            {
                                var meta    = JsonUtility.FromJson<MetaFrame>(json);
                                recvFilename = meta.name;
                                recvMime     = meta.mime;
                                expectedSize = meta.size;
                            }
                            else if (probe.t == "done")
                            {
                                done = true;
                            }
                            return;
                        }
                        catch { /* 先頭が { でも JSON でなければバイナリとして扱う */ }
                    }
                    chunks.Add(bytes);
                    received += bytes.Length;
                    if (expectedSize > 0)
                        progress?.Report((float)received / expectedSize);
                };
                dc.OnClose = () => dcError = true;

                // done フラグが立つかエラーになるまで待機
                yield return new WaitUntil(() => done || dcError || ct.IsCancellationRequested);

                if (!done || ct.IsCancellationRequested)
                    { tcs.TrySetResult(new WebRtcReceiveResult { Success = false }); yield break; }

                // チャンクを結合
                var result = new byte[received];
                int offset = 0;
                foreach (var chunk in chunks)
                {
                    Buffer.BlockCopy(chunk, 0, result, offset, chunk.Length);
                    offset += chunk.Length;
                }

                tcs.TrySetResult(new WebRtcReceiveResult
                {
                    Success  = true,
                    Data     = result,
                    Filename = recvFilename,
                    MimeType = recvMime
                });
            }
            finally
            {
                try { pc?.Close(); } catch { }
            }
        }

        // ── HTTP ヘルパーコルーチン ───────────────────────────────────────────────

        private static IEnumerator PostJson(string url, string json)
        {
            var data = Encoding.UTF8.GetBytes(json);
            using var req = new UnityWebRequest(url, "PUT")
            {
                uploadHandler   = new UploadHandlerRaw(data) { contentType = "application/json" },
                downloadHandler = new DownloadHandlerBuffer(),
                timeout         = 0
            };
            req.SetRequestHeader("Content-Type", "application/json");
            yield return req.SendWebRequest();
        }

        private static IEnumerator GetJson(string url, float timeoutSec,
            Action<string> onSuccess, Action onError)
        {
            using var req = UnityWebRequest.Get(url);
            req.timeout = Mathf.CeilToInt(timeoutSec);
            yield return req.SendWebRequest();

            if (req.result == UnityWebRequest.Result.Success)
                onSuccess?.Invoke(req.downloadHandler.text);
            else
                onError?.Invoke();
        }

        // ── SDP シリアライズ ──────────────────────────────────────────────────────

        private static string SerializeSdp(RTCSessionDescription desc)
            => JsonUtility.ToJson(new SdpJson
            {
                type = desc.type == RTCSdpType.Offer ? "offer" : "answer",
                sdp  = desc.sdp
            });

        private static RTCSessionDescription DeserializeSdp(string json, RTCSdpType expectedType)
        {
            var sdpJson = JsonUtility.FromJson<SdpJson>(json);
            return new RTCSessionDescription { type = expectedType, sdp = sdpJson.sdp };
        }

        // ── 内部 JSON 型 ─────────────────────────────────────────────────────────

        [Serializable] private class SdpJson  { public string type; public string sdp; }
        [Serializable] private class TypeProbe { public string t; }

        [Serializable]
        private class MetaFrame
        {
            public string t;
            public string name;
            public string mime;
            public int    size;
        }

        [Serializable] private class DoneFrame { public string t; }
    }

    // ── 受信結果 ──────────────────────────────────────────────────────────────────

    public class WebRtcReceiveResult
    {
        public bool   Success;
        public byte[] Data;
        public string Filename;
        public string MimeType;
    }
}
