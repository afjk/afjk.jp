using System.Collections.Generic;
using System.Text;
using UnityEngine;
using Afjk.Pipe;

/// <summary>
/// PipeClient の使い方を示すサンプル MonoBehaviour。
///
/// セットアップ:
///   1. 空の GameObject に PipeClient と PipeExample を AddComponent する。
///   2. PipeClient の Inspector で DeviceName を設定（任意）。
///   3. Play すると Presence に接続し、同室デバイスが検出されると Console に表示される。
///   4. Inspector の Send ボタン（Context Menu）から手動送信できる。
/// </summary>
public class PipeExample : MonoBehaviour
{
    private PipeClient _client;

    private void Awake()
    {
        _client = GetComponent<PipeClient>();

        _client.OnConnected       += () => Debug.Log("[PipeExample] Presence connected.");
        _client.OnDisconnected    += () => Debug.Log("[PipeExample] Presence disconnected.");
        _client.OnPeersUpdated    += OnPeersUpdated;
        _client.OnFileReceived    += OnFileReceived;
        _client.OnTextReceived    += OnTextReceived;
    }

    private void Start()
    {
        // デフォルトルームで接続
        _client.Connect();

        // ルームコードを使う場合: _client.Connect("myroom");
    }

    private void OnDestroy()
    {
        _client.Disconnect();
    }

    // ── Event handlers ───────────────────────────────────────────────────────────

    private void OnPeersUpdated(IReadOnlyList<PeerInfo> peers)
    {
        Debug.Log($"[PipeExample] Peers: {peers.Count}");
        foreach (var p in peers)
            Debug.Log($"  - {p.id} ({p.nickname} / {p.device})");
    }

    private void OnFileReceived(FileReceivedArgs args)
    {
        Debug.Log($"[PipeExample] File received: {args.Filename} ({args.Size} bytes) from {args.From?.nickname}");

        // 例: テクスチャとして読み込む
        if (args.MimeType != null && args.MimeType.StartsWith("image/"))
        {
            var tex = new Texture2D(1, 1);
            if (tex.LoadImage(args.Data))
                Debug.Log($"[PipeExample] Texture loaded: {tex.width}x{tex.height}");
        }
    }

    private void OnTextReceived(TextReceivedArgs args)
    {
        Debug.Log($"[PipeExample] Text received from {args.From?.nickname}: {args.Text}");
    }

    // ── Manual send (Context Menu for testing) ───────────────────────────────────

    [ContextMenu("Send Hello Text to All")]
    private async void SendHelloToAll()
    {
        if (_client.Peers.Count == 0)
        {
            Debug.LogWarning("[PipeExample] No peers found.");
            return;
        }
        await _client.BroadcastTextAsync("Hello from Unity!");
        Debug.Log("[PipeExample] Text sent to all peers.");
    }

    [ContextMenu("Send Dummy File to First Peer")]
    private async void SendDummyFile()
    {
        if (_client.Peers.Count == 0)
        {
            Debug.LogWarning("[PipeExample] No peers found.");
            return;
        }
        var data     = Encoding.UTF8.GetBytes("This is a dummy file from Unity.");
        var firstId  = _client.Peers[0].id;
        var progress = new Progress<float>(p => Debug.Log($"[PipeExample] Send progress: {p:P0}"));

        await _client.SendFileAsync(firstId, data, "dummy.txt", "text/plain", progress);
        Debug.Log("[PipeExample] Dummy file sent.");
    }

    [ContextMenu("Receive from Path (abc12345)")]
    private async void ReceiveFromPath()
    {
        Debug.Log("[PipeExample] Waiting to receive from abc12345 ...");
        var bytes = await _client.ReceiveFileAsync("abc12345");
        Debug.Log($"[PipeExample] Received {bytes.Length} bytes.");
    }
}
