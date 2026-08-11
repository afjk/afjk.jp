using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using GLTFast.Export;
using UnityEngine;

namespace Afjk.SceneSync
{
    [System.Serializable]
    public class PresenceMessage
    {
        public string type;
        public string id;
        public string room;
        public double serverTime;
        public string nickname;
        public string device;
        public string targetId;
    }

    [System.Serializable]
    public class PeersMessage
    {
        public string type;
        public PeerInfo[] peers;
    }

    [System.Serializable]
    public class PeerInfo
    {
        public string id;
        public string nickname;
        public string device;
        public double lastSeen; // サーバが付与する Unix timestamp
    }

    public class PresenceClientRuntime
    {
        public string Id { get; private set; }
        public string Room { get; private set; }
        public double ServerTimeMilliseconds { get; private set; } = double.NaN;
        public List<PeerInfo> Peers { get; private set; } = new List<PeerInfo>();
        public bool IsConnected => _ws != null && _ws.State == WebSocketState.Open;

        public event Action OnConnected;
        public event Action OnDisconnected;
        public event Action<double> OnWelcomeReceived;
        public event Action<List<PeerInfo>> OnPeersUpdated;
        public event Action<string> OnHandoffReceived; // raw JSON

        private ClientWebSocket _ws;
        private CancellationTokenSource _cts;
        public async Task ConnectAsync(string presenceUrl, string room, string nickname)
        {
            // Initial socket cleanup is not a lifecycle disconnect. A reconnect
            // only notifies listeners when a live connection actually existed.
            DisconnectInternal(IsConnected);

            _cts = new CancellationTokenSource();
            _ws = new ClientWebSocket();

            var url = SceneSyncPresenceUrl.BuildRoomUrl(presenceUrl, room);

            try
            {
                await _ws.ConnectAsync(new Uri(url), _cts.Token);

                var hello = JsonUtility.ToJson(new PresenceMessage
                {
                    type = "hello",
                    nickname = nickname,
                    device = "Unity Runtime"
                });
                await SendRaw(hello);

                OnConnected?.Invoke();
                _ = ReceiveLoop(_ws, _cts.Token);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[SceneSync] Connect failed: " + ex.Message);
                OnDisconnected?.Invoke();
            }
        }

        public void Disconnect()
        {
            DisconnectInternal(true);
        }

        private void DisconnectInternal(bool notifyDisconnected)
        {
            _cts?.Cancel();
            if (_ws != null)
            {
                try { _ws.Dispose(); } catch { }
                _ws = null;
            }
            Id = null;
            Room = null;
            ServerTimeMilliseconds = double.NaN;
            Peers.Clear();
            if (notifyDisconnected) OnDisconnected?.Invoke();
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

        private async Task ReceiveLoop(ClientWebSocket socket, CancellationToken token)
        {
            var buffer = new MemoryStream();
            var receiveBuffer = new byte[131072]; // 128KB, isolated per socket generation
            try
            {
                while (ReferenceEquals(_ws, socket)
                       && socket.State == WebSocketState.Open
                       && !token.IsCancellationRequested)
                {
                    var result = await socket.ReceiveAsync(
                        new ArraySegment<byte>(receiveBuffer), token);
                    if (result.MessageType == WebSocketMessageType.Close) break;

                    buffer.Write(receiveBuffer, 0, result.Count);

                    if (result.EndOfMessage)
                    {
                        if (!ReferenceEquals(_ws, socket)) break;
                        var text = Encoding.UTF8.GetString(
                            buffer.GetBuffer(), 0, (int)buffer.Length);
                        buffer.SetLength(0);
                        HandleMessage(text);
                    }
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                Debug.LogWarning("[SceneSync] Receive error: " + ex.Message);
            }
            finally
            {
                if (ReferenceEquals(_ws, socket))
                {
                    DisconnectInternal(true);
                }
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
                    ServerTimeMilliseconds = baseMsg.serverTime > 0d
                        ? baseMsg.serverTime
                        : double.NaN;
                    OnWelcomeReceived?.Invoke(ServerTimeMilliseconds);
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

        private static string DescribeGameObject(UnityEngine.GameObject go)
        {
            if (go == null) return "null";

            return "name=" + go.name
                + ", instanceId=" + go.GetInstanceID()
                + ", activeSelf=" + go.activeSelf
                + ", activeInHierarchy=" + go.activeInHierarchy
                + ", position=" + go.transform.position
                + ", rotation=" + go.transform.rotation.eulerAngles
                + ", scale=" + go.transform.localScale
                + ", meshFilters=" + go.GetComponentsInChildren<MeshFilter>(true).Length
                + ", skinnedMeshes=" + go.GetComponentsInChildren<SkinnedMeshRenderer>(true).Length
                + ", renderers=" + go.GetComponentsInChildren<Renderer>(true).Length;
        }

        public static async Task<byte[]> ExportGameObjectAsGlb(UnityEngine.GameObject go)
        {
            return await GlbExporter.ExportGameObjectAsGlb(go, SceneSyncGlbExportBackend.GltfFast);
        }

        public static async Task<bool> UploadGlb(byte[] glb, string blobBaseUrl, string path)
        {
            if (glb == null || glb.Length == 0)
            {
                Debug.LogWarning("[SceneSync] Upload skipped: glb is null or empty, path=" + path);
                return false;
            }

            try
            {
                var url = blobBaseUrl + "/" + path;
                Debug.Log("[SceneSync] Upload start: url=" + url + ", bytes=" + glb.Length);
                var content = new ByteArrayContent(glb);
                content.Headers.ContentType = new MediaTypeHeaderValue("model/gltf-binary");
                var response = await _http.PostAsync(url, content);
                if (!response.IsSuccessStatusCode)
                {
                    Debug.LogWarning(
                        "[SceneSync] Upload failed: status=" + (int)response.StatusCode + " " + response.StatusCode
                        + ", url=" + url);
                    return false;
                }
                else
                {
                    Debug.Log(
                        "[SceneSync] Upload success: status=" + (int)response.StatusCode + " " + response.StatusCode
                        + ", url=" + url);
                    return true;
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[SceneSync] Upload failed: path=" + path + ", blobBaseUrl=" + blobBaseUrl + "\n" + ex);
                return false;
            }
        }

        public static string GenerateRandomPath()
        {
            var bytes = new byte[16];
            new System.Random().NextBytes(bytes);
            var s = Convert.ToBase64String(bytes)
                .Replace("+", "").Replace("/", "").Replace("=", "")
                .ToLower();
            return s.Substring(0, System.Math.Min(8, s.Length));
        }

        public static string ComputeAssetId(byte[] data)
        {
            if (data == null || data.Length == 0) return null;
            using (var sha256 = SHA256.Create())
            {
                var hash = sha256.ComputeHash(data);
                var hexString = System.BitConverter.ToString(hash).Replace("-", "").ToLower();
                return "sha256-" + hexString;
            }
        }
    }
}
