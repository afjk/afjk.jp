using System;
using System.Collections.Generic;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using Afjk.Pipe.Internal;

namespace Afjk.Pipe
{
    /// <summary>
    /// afjk.jp presence-server との WebSocket 接続を管理する。
    /// デバイス検出・handoff 送受信を担当。
    /// スレッドセーフ: 受信ループはバックグラウンドスレッドで動作し、
    /// イベント発火は Unity メインスレッドで行う。
    /// </summary>
    public class PresenceClient : IDisposable
    {
        // ── Events ──────────────────────────────────────────────────────────────
        public event Action Connected;
        public event Action Disconnected;
        public event Action<List<PeerInfo>> PeersUpdated;
        public event Action<PeerInfo, HandoffPayload> HandoffReceived;

        // ── Public state ────────────────────────────────────────────────────────
        public string LocalId { get; private set; }
        public string RoomId  { get; private set; }
        public bool   IsConnected => _ws?.State == WebSocketState.Open;

        // ── Config ───────────────────────────────────────────────────────────────
        private readonly string _endpoint;
        private readonly string _deviceName;
        private readonly string _deviceType;

        // ── Internal ─────────────────────────────────────────────────────────────
        private ClientWebSocket      _ws;
        private CancellationTokenSource _cts;
        private readonly SynchronizationContext _mainThread;

        private int  _retries;
        private bool _disposed;

        private const int HeartbeatMs  = 30_000;
        private const int MaxRetries   = 3;

        public PresenceClient(string endpoint, string deviceName, string deviceType = "Unity")
        {
            _endpoint   = endpoint;
            _deviceName = deviceName;
            _deviceType = deviceType;
            _mainThread = SynchronizationContext.Current
                          ?? new SynchronizationContext();
        }

        // ── Connect / Disconnect ────────────────────────────────────────────────

        public void Connect(string roomCode = null)
        {
            if (_disposed) return;
            _retries = 0;
            _ = ConnectAsync(roomCode);
        }

        public void Disconnect()
        {
            _cts?.Cancel();
        }

        private async Task ConnectAsync(string roomCode)
        {
            while (!_disposed && _retries <= MaxRetries)
            {
                _cts?.Dispose();
                _cts = new CancellationTokenSource();
                var token = _cts.Token;

                try
                {
                    _ws?.Dispose();
                    _ws = new ClientWebSocket();

                    var url = BuildUrl(roomCode);
                    await _ws.ConnectAsync(url, token);

                    _retries = 0;
                    Post(() => Connected?.Invoke());

                    await SendHello(token);
                    await ReceiveLoop(token);
                }
                catch (OperationCanceledException)
                {
                    break;   // 意図的切断
                }
                catch (Exception ex)
                {
                    Debug.LogWarning($"[Pipe] Presence disconnected: {ex.Message}");
                }
                finally
                {
                    Post(() => Disconnected?.Invoke());
                }

                _retries++;
                if (_retries > MaxRetries || _disposed) break;

                int delay = Math.Min(3000 * (int)Math.Pow(2, _retries - 1), 30_000);
                await Task.Delay(delay);
            }
        }

        private Uri BuildUrl(string roomCode)
        {
            var url = _endpoint;
            if (!string.IsNullOrEmpty(roomCode))
                url += (url.Contains('?') ? "&" : "?") + "room=" + Uri.EscapeDataString(roomCode);
            return new Uri(url);
        }

        // ── Receive loop ────────────────────────────────────────────────────────

        private async Task ReceiveLoop(CancellationToken token)
        {
            var buf = new byte[64 * 1024];

            while (_ws.State == WebSocketState.Open && !token.IsCancellationRequested)
            {
                var sb     = new StringBuilder();
                WebSocketReceiveResult result;

                do
                {
                    result = await _ws.ReceiveAsync(new ArraySegment<byte>(buf), token);
                    if (result.MessageType == WebSocketMessageType.Close)
                        return;
                    sb.Append(Encoding.UTF8.GetString(buf, 0, result.Count));
                }
                while (!result.EndOfMessage);

                HandleMessage(sb.ToString());
            }
        }

        private void HandleMessage(string json)
        {
            try
            {
                // type フィールドだけ先読みして分岐
                if (!TryGetType(json, out string type)) return;

                switch (type)
                {
                    case "welcome":
                        var welcome = JsonUtility.FromJson<WelcomeMessage>(json);
                        LocalId = welcome.id;
                        RoomId  = welcome.room;
                        break;

                    case "peers":
                        var msg = JsonUtility.FromJson<PeersMessage>(json);
                        Post(() => PeersUpdated?.Invoke(msg.peers ?? new List<PeerInfo>()));
                        break;

                    case "ping":
                        _ = SendPong();
                        break;

                    case "handoff":
                        var handoff = JsonUtility.FromJson<IncomingHandoffMessage>(json);
                        Post(() => HandoffReceived?.Invoke(handoff.from, handoff.payload));
                        break;
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Pipe] Presence message parse error: {ex.Message}");
            }
        }

        // ── Send helpers ────────────────────────────────────────────────────────

        private Task SendHello(CancellationToken token)
        {
            var msg = new HelloMessage
            {
                nickname = _deviceName,
                device   = _deviceType
            };
            return SendJson(JsonUtility.ToJson(msg), token);
        }

        private Task SendPong()
            => SendJson(JsonUtility.ToJson(new PongMessage()), _cts?.Token ?? default);

        public Task SendHandoff(string targetId, HandoffPayload payload,
                                CancellationToken token = default)
        {
            var msg = new HandoffMessage { targetId = targetId, payload = payload };
            return SendJson(JsonUtility.ToJson(msg), token);
        }

        private async Task SendJson(string json, CancellationToken token)
        {
            if (_ws?.State != WebSocketState.Open) return;
            var data = Encoding.UTF8.GetBytes(json);
            await _ws.SendAsync(new ArraySegment<byte>(data),
                                WebSocketMessageType.Text,
                                true, token);
        }

        // ── Utilities ────────────────────────────────────────────────────────────

        private static bool TryGetType(string json, out string type)
        {
            // JsonUtility は type フィールドだけのオブジェクトを扱えるシンプルな型で読む
            var probe = JsonUtility.FromJson<TypeProbe>(json);
            type = probe?.type;
            return !string.IsNullOrEmpty(type);
        }

        private void Post(Action action)
            => _mainThread.Post(_ => action?.Invoke(), null);

        // ── IDisposable ──────────────────────────────────────────────────────────

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _cts?.Cancel();
            _cts?.Dispose();
            _ws?.Dispose();
        }

        [Serializable]
        private class TypeProbe { public string type; }
    }
}
