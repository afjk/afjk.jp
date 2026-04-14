using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using Afjk.Pipe.Internal;

namespace Afjk.Pipe
{
    /// <summary>
    /// afjk.jp/pipe クライアントの MonoBehaviour ファサード（Stage 1: piping-server HTTP）。
    ///
    /// 使い方:
    ///   1. GameObject に AddComponent する。
    ///   2. Inspector で PresenceEndpoint / PipingEndpoint / DeviceName を設定。
    ///   3. Connect() を呼ぶと Presence WebSocket に接続し、同室デバイスを検出する。
    ///   4. SendFileAsync / SendTextAsync で特定ピアへ転送通知 + データ送信。
    ///   5. OnFileReceived / OnTextReceived イベントで受信データを取得。
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

        // ── Events ───────────────────────────────────────────────────────────────

        /// <summary>同室ピアリストが更新されたとき</summary>
        public event Action<IReadOnlyList<PeerInfo>> OnPeersUpdated;

        /// <summary>ファイルを受信したとき</summary>
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
        private PresenceClient _presence;
        private List<PeerInfo> _peers = new List<PeerInfo>();

        // ── Unity lifecycle ──────────────────────────────────────────────────────

        private void OnDestroy() => Disconnect();

        // ── Public API ───────────────────────────────────────────────────────────

        /// <summary>Presence に接続してデバイス検出を開始する。</summary>
        public void Connect(string roomCode = null)
        {
            Disconnect();

            // MainThreadDispatcher を事前に確保（コルーチン用）
            _ = MainThreadDispatcher.Instance;

            _presence = new PresenceClient(presenceEndpoint, deviceName, deviceType);
            _presence.Connected      += () => OnConnected?.Invoke();
            _presence.Disconnected   += () => OnDisconnected?.Invoke();
            _presence.PeersUpdated   += OnPeersUpdatedInternal;
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
        /// Presence 経由で handoff 通知を送り、同時に piping-server へ POST する。
        /// </summary>
        public async Task SendFileAsync(
            string targetPeerId,
            byte[] data,
            string filename,
            string mimeType          = "application/octet-stream",
            IProgress<float> progress = null,
            CancellationToken ct     = default)
        {
            var path = PipeUtils.RandPath();
            await SendHandoffFile(targetPeerId, path, filename, data.LongLength, mimeType);
            await PipingServerTransport.SendAsync(pipingEndpoint, path, data, mimeType, progress, ct);
        }

        /// <summary>
        /// 特定のピアにテキストを送信する。
        /// </summary>
        public async Task SendTextAsync(
            string targetPeerId,
            string text,
            CancellationToken ct = default)
        {
            var path = PipeUtils.RandPath();
            await SendHandoffText(targetPeerId, path);
            await PipingServerTransport.SendTextAsync(pipingEndpoint, path, text, ct);
        }

        /// <summary>
        /// ルーム内の全ピアにファイルを送信する（ピアごとに独立したパスを生成）。
        /// </summary>
        public async Task BroadcastFileAsync(
            byte[] data,
            string filename,
            string mimeType          = "application/octet-stream",
            IProgress<float> progress = null,
            CancellationToken ct     = default)
        {
            var tasks = new List<Task>();
            foreach (var peer in _peers)
                tasks.Add(SendFileAsync(peer.id, data, filename, mimeType, progress, ct));
            await Task.WhenAll(tasks);
        }

        /// <summary>
        /// ルーム内の全ピアにテキストを送信する。
        /// </summary>
        public async Task BroadcastTextAsync(string text, CancellationToken ct = default)
        {
            var tasks = new List<Task>();
            foreach (var peer in _peers)
                tasks.Add(SendTextAsync(peer.id, text, ct));
            await Task.WhenAll(tasks);
        }

        // ── Manual receive ───────────────────────────────────────────────────────

        /// <summary>
        /// パスを指定してファイルを手動受信する（URL またはプレーンパス）。
        /// </summary>
        public Task<byte[]> ReceiveFileAsync(
            string pathOrUrl,
            IProgress<float> progress = null,
            CancellationToken ct      = default)
        {
            var path = PipeUtils.ParsePath(pathOrUrl);
            return PipingServerTransport.ReceiveAsync(pipingEndpoint, path, progress, ct);
        }

        /// <summary>
        /// パスを指定してテキストを手動受信する。
        /// </summary>
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
                    ReceiveHandoffFile(from, payload);
                    break;

                case "files":
                    if (payload.files != null)
                        foreach (var f in payload.files)
                            ReceiveHandoffFile(from, f);
                    break;

                case "text":
                    ReceiveHandoffText(from, payload.path);
                    break;
            }
        }

        private void ReceiveHandoffFile(PeerInfo from, FileEntry entry)
        {
            _ = ReceiveHandoffFileAsync(from, entry.path, entry.filename, entry.mime, entry.size);
        }

        private void ReceiveHandoffFile(PeerInfo from, HandoffPayload payload)
        {
            _ = ReceiveHandoffFileAsync(from, payload.path, payload.filename, payload.mime, payload.size);
        }

        private async Task ReceiveHandoffFileAsync(
            PeerInfo from, string path, string filename, string mime, long size)
        {
            try
            {
                var bytes = await PipingServerTransport.ReceiveAsync(pipingEndpoint, path);
                OnFileReceived?.Invoke(new FileReceivedArgs
                {
                    From     = from,
                    Filename = filename,
                    MimeType = mime,
                    Size     = size,
                    Data     = bytes
                });
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Pipe] File receive error ({filename}): {ex.Message}");
            }
        }

        private void ReceiveHandoffText(PeerInfo from, string path)
        {
            _ = ReceiveHandoffTextAsync(from, path);
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

            var url = $"https://afjk.jp/pipe/#{path}";
            var payload = new HandoffPayload
            {
                kind     = "file",
                path     = path,
                filename = filename,
                size     = size,
                mime     = mime,
                url      = url
            };
            return _presence.SendHandoff(targetId, payload);
        }

        private Task SendHandoffText(string targetId, string path)
        {
            if (_presence == null) return Task.CompletedTask;

            var payload = new HandoffPayload { kind = "text", path = path };
            return _presence.SendHandoff(targetId, payload);
        }
    }

}
