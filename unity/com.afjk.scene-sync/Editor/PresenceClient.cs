using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

namespace Afjk.SceneSync.Editor
{
    [Serializable]
    public class PresenceMessage
    {
        public string type;
        public string id;
        public string room;
        public string nickname;
        public string device;
        public string targetId;
    }

    [Serializable]
    public class PeersMessage
    {
        public string type;
        public PeerInfo[] peers;
    }

    [Serializable]
    public class PeerInfo
    {
        public string id;
        public string nickname;
        public string device;
    }

    public class PresenceClient
    {
        public string Id { get; private set; }
        public string Room { get; private set; }
        public List<PeerInfo> Peers { get; private set; } = new List<PeerInfo>();
        public bool IsConnected => _ws != null && _ws.State == WebSocketState.Open;

        public event Action OnConnected;
        public event Action OnDisconnected;
        public event Action<List<PeerInfo>> OnPeersUpdated;
        public event Action<string> OnHandoffReceived; // raw JSON

        private ClientWebSocket _ws;
        private CancellationTokenSource _cts;
        private readonly byte[] _recvBuf = new byte[131072]; // 128KB

        public async Task ConnectAsync(string presenceUrl, string room, string nickname)
        {
            Disconnect();

            _cts = new CancellationTokenSource();
            _ws = new ClientWebSocket();

            var url = string.IsNullOrEmpty(room)
                ? presenceUrl
                : presenceUrl + "/?room=" + room;

            try
            {
                await _ws.ConnectAsync(new Uri(url), _cts.Token);

                var hello = JsonUtility.ToJson(new PresenceMessage
                {
                    type = "hello",
                    nickname = nickname,
                    device = "Unity Editor"
                });
                await SendRaw(hello);

                OnConnected?.Invoke();
                _ = ReceiveLoop();
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[SceneSync] Connect failed: " + ex.Message);
                OnDisconnected?.Invoke();
            }
        }

        public void Disconnect()
        {
            _cts?.Cancel();
            if (_ws != null)
            {
                try { _ws.Dispose(); } catch { }
                _ws = null;
            }
            Id = null;
            Room = null;
            Peers.Clear();
            OnDisconnected?.Invoke();
        }

        public async Task Broadcast(string payloadJson)
        {
            await SendRaw("{\"type\":\"broadcast\",\"payload\":" + payloadJson + "}");
        }

        public async Task SendHandoff(string targetId, string payloadJson)
        {
            await SendRaw("{\"type\":\"handoff\",\"targetId\":\"" + targetId + "\",\"payload\":" + payloadJson + "}");
        }

        private async Task SendRaw(string text)
        {
            if (!IsConnected) return;
            var bytes = Encoding.UTF8.GetBytes(text);
            try
            {
                await _ws.SendAsync(
                    new ArraySegment<byte>(bytes),
                    WebSocketMessageType.Text,
                    true,
                    _cts.Token
                );
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[SceneSync] Send failed: " + ex.Message);
            }
        }

        private async Task ReceiveLoop()
        {
            try
            {
                while (_ws.State == WebSocketState.Open && !_cts.Token.IsCancellationRequested)
                {
                    var result = await _ws.ReceiveAsync(
                        new ArraySegment<byte>(_recvBuf), _cts.Token
                    );
                    if (result.MessageType == WebSocketMessageType.Close) break;

                    var text = Encoding.UTF8.GetString(_recvBuf, 0, result.Count);
                    HandleMessage(text);
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                Debug.LogWarning("[SceneSync] Receive error: " + ex.Message);
            }
            finally
            {
                OnDisconnected?.Invoke();
            }
        }

        private void HandleMessage(string raw)
        {
            var baseMsg = JsonUtility.FromJson<PresenceMessage>(raw);
            if (baseMsg == null) return;

            switch (baseMsg.type)
            {
                case "welcome":
                    Id = baseMsg.id;
                    Room = baseMsg.room;
                    break;

                case "peers":
                    var peersMsg = JsonUtility.FromJson<PeersMessage>(raw);
                    Peers = new List<PeerInfo>(peersMsg.peers ?? System.Array.Empty<PeerInfo>());
                    OnPeersUpdated?.Invoke(Peers);
                    break;

                case "handoff":
                    OnHandoffReceived?.Invoke(raw);
                    break;

                case "ping":
                    _ = SendRaw("{\"type\":\"pong\"}");
                    break;
            }
        }

        // ── glB エクスポート・配信 ────────────────────────────

        private static readonly HttpClient _http = new HttpClient();

        public static async Task<byte[]> ExportGameObjectAsGlb(UnityEngine.GameObject go)
        {
            try
            {
                // TODO: com.unity.cloud.gltfast 使用時はここで実装
                // 暫定実装: null を返す（フォールバック Box を使用）
                return null;
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[SceneSync] Export failed: " + ex.Message);
                return null;
            }
        }

        public static async Task<string> UploadGlb(byte[] glb, string pipingBaseUrl)
        {
            if (glb == null || glb.Length == 0) return null;

            try
            {
                var path = GenerateRandomPath();
                var url = pipingBaseUrl + "/" + path;
                var content = new ByteArrayContent(glb);
                content.Headers.ContentType = new MediaTypeHeaderValue("model/gltf-binary");
                var response = await _http.PutAsync(url, content);
                return response.IsSuccessStatusCode ? path : null;
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[SceneSync] Upload failed: " + ex.Message);
                return null;
            }
        }

        private static string GenerateRandomPath()
        {
            var bytes = new byte[6];
            new System.Random().NextBytes(bytes);
            return Convert.ToBase64String(bytes)
                .Replace("+", "").Replace("/", "").Replace("=", "")
                .Substring(0, 8).ToLower();
        }
    }
}
