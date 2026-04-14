using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using Afjk.Pipe.Internal;

namespace Afjk.Pipe
{
    /// <summary>
    /// afjk.jp/pipe クライアントの MonoBehaviour ファサード。
    ///
    /// 転送モード（ファイル送受信）:
    ///   1. WebRTC P2P を先行試行（シグナリングに piping-server を使用）
    ///   2. 失敗またはタイムアウト時は piping-server HTTP 中継へ自動フォールバック
    ///
    /// テキスト送受信は piping-server HTTP のみ。
    /// </summary>
    public class PipeClient : MonoBehaviour
    {
        // ── Inspector ────────────────────────────────────────────────────────────
        [Header("Endpoints")]
        [Tooltip("Presence WebSocket エンドポイント")]
        [SerializeField] private string presenceEndpoint = "wss://afjk.jp/presence";

        [Tooltip("piping-server エンドポイント")]
        [SerializeField] private string pipingEndpoint = "https://pipe.afjk.jp";

        [Header("Device")]
        [Tooltip("同室のほかのデバイスに表示される名前")]
        [SerializeField] private string deviceName = "Unity";

        [Tooltip("デバイス種別の文字列（任意）")]
        [SerializeField] private string deviceType = "Unity";

        [Header("Transfer")]
        [Tooltip("オフにすると常に piping-server HTTP を使用する（デバッグ用）")]
        [SerializeField] private bool useWebRtc = true;

        // ── Events ───────────────────────────────────────────────────────────────

        /// <summary>同室ピアリストが更新されたとき</summary>
        public event Action<IReadOnlyList<PeerInfo>> OnPeersUpdated;

        /// <summary>ファイルを受信したとき（TransferMode で使用経路がわかる）</summary>
        public event Action<FileReceivedArgs> OnFileReceived;

        /// <summary>テキストを受信したとき</summary>
        public event Action<TextReceivedArgs> OnTextReceived;

        /// <summary>Presence に接続したとき</summary>
        public event Action OnConnected;

        /// <summary>Presence が切断されたとき</summary>
        public event Action OnDisconnected;

        // ── Public state ─────────────────────────────────────────────────────────
        public string LocalId => _presence?.LocalId;
        public string RoomId  => _presence?.RoomId;
        public IReadOnlyList<PeerInfo> Peers => _peers;

        // ── Internal ─────────────────────────────────────────────────────────────
        private PresenceClient  _presence;
        private List<PeerInfo>  _peers = new List<PeerInfo>();

        // ── Unity lifecycle ──────────────────────────────────────────────────────

        private void Awake()
        {
            // WebRtcTransport シングルトンを事前に確保（WebRTC.Initialize を実行）
            if (useWebRtc) _ = WebRtcTransport.Instance;
            _ = MainThreadDispatcher.Instance;
        }

        private void OnDestroy() => Disconnect();

        // ── Public API ───────────────────────────────────────────────────────────

        /// <summary>Presence に接続してデバイス検出を開始する。</summary>
        public void Connect(string roomCode = null)
        {
            Disconnect();
            _presence = new PresenceClient(presenceEndpoint, deviceName, deviceType);
            _presence.Connected       += () => OnConnected?.Invoke();
            _presence.Disconnected    += () => OnDisconnected?.Invoke();
            _presence.PeersUpdated    += OnPeersUpdatedInternal;
            _presence.HandoffReceived += OnHandoffReceived;
            _presence.Connect(roomCode);
        }

        /// <summary>Presence を切断する。</summary>
        public void Disconnect()
        {
            _presence?.Dispose();
            _presence = null;
            _peers.Clear();
        }

        // ── Send ─────────────────────────────────────────────────────────────────

        /// <summary>
        /// 特定のピアにファイルを送信する。
        /// P2P を先行試行し、失敗時は HTTP 中継へフォールバックする。
        /// </summary>
        public async Task SendFileAsync(
            string targetPeerId,
            byte[] data,
            string filename,
            string mimeType           = "application/octet-stream",
            IProgress<float> progress = null,
            CancellationToken ct      = default)
        {
            var path = PipeUtils.RandPath();
            await SendHandoffFile(targetPeerId, path, filename, data.LongLength, mimeType);

            if (useWebRtc && WebRtcTransport.Instance != null)
            {
                var ok = await WebRtcTransport.Instance.TrySendAsync(
                    pipingEndpoint, path, data, filename, mimeType, progress, ct);
                if (ok) return;
                Debug.Log("[Pipe] P2P 失敗 → piping-server にフォールバック");
            }

            await PipingServerTransport.SendAsync(pipingEndpoint, path, data, mimeType, progress, ct);
        }

        /// <summary>特定のピアにテキストを送信する（piping-server HTTP）。</summary>
        public async Task SendTextAsync(
            string targetPeerId,
            string text,
            CancellationToken ct = default)
        {
            var path = PipeUtils.RandPath();
            await SendHandoffText(targetPeerId, path);
            await PipingServerTransport.SendTextAsync(pipingEndpoint, path, text, ct);
        }

        /// <summary>ルーム内の全ピアにファイルを送信する（ピアごとに独立パス）。</summary>
        public async Task BroadcastFileAsync(
            byte[] data,
            string filename,
            string mimeType           = "application/octet-stream",
            IProgress<float> progress = null,
            CancellationToken ct      = default)
        {
            var tasks = new List<Task>();
            foreach (var peer in _peers)
                tasks.Add(SendFileAsync(peer.id, data, filename, mimeType, progress, ct));
            await Task.WhenAll(tasks);
        }

        /// <summary>ルーム内の全ピアにテキストを送信する。</summary>
        public async Task BroadcastTextAsync(string text, CancellationToken ct = default)
        {
            var tasks = new List<Task>();
            foreach (var peer in _peers)
                tasks.Add(SendTextAsync(peer.id, text, ct));
            await Task.WhenAll(tasks);
        }

        // ── Manual receive ───────────────────────────────────────────────────────

        /// <summary>パスを指定してファイルを手動受信する（URL またはプレーンパス）。</summary>
        public Task<byte[]> ReceiveFileAsync(
            string pathOrUrl,
            IProgress<float> progress = null,
            CancellationToken ct      = default)
        {
            var path = PipeUtils.ParsePath(pathOrUrl);
            return PipingServerTransport.ReceiveAsync(pipingEndpoint, path, progress, ct);
        }

        /// <summary>パスを指定してテキストを手動受信する。</summary>
        public Task<string> ReceiveTextAsync(
            string pathOrUrl,
            IProgress<float> progress = null,
            CancellationToken ct      = default)
        {
            var path = PipeUtils.ParsePath(pathOrUrl);
            return PipingServerTransport.ReceiveTextAsync(pipingEndpoint, path, progress, ct);
        }

        // ── Internal handlers ────────────────────────────────────────────────────

        private void OnPeersUpdatedInternal(List<PeerInfo> peers)
        {
            _peers = peers ?? new List<PeerInfo>();
            OnPeersUpdated?.Invoke(_peers);
        }

        private void OnHandoffReceived(PeerInfo from, HandoffPayload payload)
        {
            if (payload == null) return;

            switch (payload.kind)
            {
                case "file":
                    _ = ReceiveHandoffFileAsync(from, payload.path, payload.filename, payload.mime, payload.size);
                    break;

                case "files":
                    if (payload.files != null)
                        foreach (var f in payload.files)
                            _ = ReceiveHandoffFileAsync(from, f.path, f.filename, f.mime, f.size);
                    break;

                case "text":
                    _ = ReceiveHandoffTextAsync(from, payload.path);
                    break;
            }
        }

        private async Task ReceiveHandoffFileAsync(
            PeerInfo from, string path, string filename, string mime, long size)
        {
            try
            {
                byte[]          bytes      = null;
                TransferMode    mode       = TransferMode.Relay;

                // P2P 先行試行
                if (useWebRtc && WebRtcTransport.Instance != null)
                {
                    var result = await WebRtcTransport.Instance.TryReceiveAsync(
                        pipingEndpoint, path, null, default);

                    if (result.Success)
                    {
                        bytes    = result.Data;
                        filename = result.Filename ?? filename;
                        mime     = result.MimeType ?? mime;
                        mode     = TransferMode.P2P;
                    }
                    else
                    {
                        Debug.Log("[Pipe] P2P 失敗 → piping-server にフォールバック");
                    }
                }

                // HTTP フォールバック
                if (bytes == null)
                    bytes = await PipingServerTransport.ReceiveAsync(pipingEndpoint, path);

                OnFileReceived?.Invoke(new FileReceivedArgs
                {
                    From     = from,
                    Filename = filename,
                    MimeType = mime,
                    Size     = bytes.LongLength,
                    Data     = bytes,
                    Mode     = mode
                });
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Pipe] File receive error ({filename}): {ex.Message}");
            }
        }

        private async Task ReceiveHandoffTextAsync(PeerInfo from, string path)
        {
            try
            {
                var text = await PipingServerTransport.ReceiveTextAsync(pipingEndpoint, path);
                OnTextReceived?.Invoke(new TextReceivedArgs { From = from, Text = text });
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Pipe] Text receive error: {ex.Message}");
            }
        }

        // ── Handoff helpers ──────────────────────────────────────────────────────

        private Task SendHandoffFile(
            string targetId, string path, string filename, long size, string mime)
        {
            if (_presence == null) return Task.CompletedTask;

            var payload = new HandoffPayload
            {
                kind     = "file",
                path     = path,
                filename = filename,
                size     = size,
                mime     = mime,
                url      = $"https://afjk.jp/pipe/#{path}"
            };
            return _presence.SendHandoff(targetId, payload);
        }

        private Task SendHandoffText(string targetId, string path)
        {
            if (_presence == null) return Task.CompletedTask;
            return _presence.SendHandoff(targetId, new HandoffPayload { kind = "text", path = path });
        }
    }
}
