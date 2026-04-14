using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEngine;
using Afjk.Pipe;

/// <summary>
/// PipeClient の動作確認サンプル。OnGUI でシンプルな UI を表示する。
///
/// セットアップ:
///   1. 空の GameObject に PipeClient と PipeExample を AddComponent する。
///   2. Play するだけで自動的に Presence へ接続する。
///   3. 画面上の UI からテキスト・ファイルの送受信を確認できる。
///   4. 受信ファイルは Application.persistentDataPath に保存される。
/// </summary>
public class PipeExample : MonoBehaviour
{
    // ── State ─────────────────────────────────────────────────────────────────────
    private PipeClient     _client;
    private string         _statusText    = "未接続";
    private string         _textInput     = "Hello from Unity!";
    private string         _roomCodeInput = "";
    private string         _manualPath    = "";
    private List<PeerInfo> _peers         = new List<PeerInfo>();
    private List<string>   _log           = new List<string>();
    private float          _progress      = -1f;
    private string         _progressLabel = "";
    private Vector2        _logScroll;
    private const int      MaxLog         = 60;

    // ── Unity lifecycle ───────────────────────────────────────────────────────────

    private void Awake()
    {
        _client = GetComponent<PipeClient>();

        _client.OnConnected    += () => { _statusText = "接続済み"; AddLog("✓ Presence 接続"); };
        _client.OnDisconnected += () => { _statusText = "切断";    AddLog("✗ Presence 切断"); };
        _client.OnPeersUpdated += peers =>
        {
            _peers = new List<PeerInfo>(peers);
            AddLog($"ピア更新: {peers.Count} 台");
        };
        _client.OnFileReceived += OnFileReceived;
        _client.OnTextReceived += args =>
            AddLog($"💬 テキスト受信 from {args.From?.nickname ?? "?"}: {args.Text}");
    }

    private void Start() => Connect(null);

    private void OnDestroy() => _client.Disconnect();

    // ── File received ─────────────────────────────────────────────────────────────

    private void OnFileReceived(FileReceivedArgs args)
    {
        var modeLabel = args.Mode == TransferMode.P2P ? "P2P" : "中継";
        var saved = SaveFile(args.Filename, args.Data);
        AddLog($"📥 ファイル受信 ({modeLabel}): {args.Filename} ({args.Data.Length:N0} B) from {args.From?.nickname ?? "?"}");
        AddLog($"   保存先: {saved}");
        Debug.Log($"[Pipe] 保存先: {saved}");

        // 画像なら Texture2D で読み込み確認
        if (args.MimeType != null && args.MimeType.StartsWith("image/"))
        {
            var tex = new Texture2D(1, 1);
            if (tex.LoadImage(args.Data))
                AddLog($"   画像サイズ: {tex.width}×{tex.height}");
        }
    }

    // ── GUI ───────────────────────────────────────────────────────────────────────

    private void OnGUI()
    {
        var skin = GUI.skin;

        // フォントサイズを全体的に2倍にする
        skin.label.fontSize  = 24;
        skin.button.fontSize = 24;
        skin.textField.fontSize = 24;
        skin.box.fontSize    = 22;

        GUILayout.BeginArea(new Rect(10, 10, 1100, Screen.height - 20));

        // ヘッダー
        GUILayout.Label("afjk.jp / pipe — Unity Client", new GUIStyle(skin.label)
            { fontSize = 32, fontStyle = FontStyle.Bold });
        GUILayout.Label($"状態: {_statusText}  |  ID: {Clip(_client.LocalId)}  |  Room: {_client.RoomId ?? "-"}");
        GUILayout.Space(4);

        // ルームコード
        GUILayout.BeginHorizontal();
        GUILayout.Label("ルームコード:", GUILayout.Width(150));
        _roomCodeInput = GUILayout.TextField(_roomCodeInput, GUILayout.Width(180));
        if (GUILayout.Button("参加", GUILayout.Width(80)))
            Connect(string.IsNullOrWhiteSpace(_roomCodeInput) ? null : _roomCodeInput.Trim());
        if (GUILayout.Button("退場", GUILayout.Width(80)))
        { _roomCodeInput = ""; Connect(null); }
        GUILayout.EndHorizontal();
        GUILayout.Space(6);

        // ピアリスト
        GUILayout.Label($"ピア ({_peers.Count} 台):");
        if (_peers.Count == 0)
            GUILayout.Label("  （検出なし）");
        else
            foreach (var p in _peers)
                GUILayout.Label($"  • {p.nickname ?? "?"} [{p.device ?? "?"}]  id={Clip(p.id)}");
        GUILayout.Space(6);

        bool busy = _progress >= 0f;

        // ── テキスト送信 ─────────────────────────────────────────────────────────
        DrawSectionLabel("テキスト送信");
        _textInput = GUILayout.TextField(_textInput, GUILayout.Width(480));
        GUILayout.BeginHorizontal();
        GUI.enabled = _peers.Count > 0 && !busy;
        if (GUILayout.Button("全員に送信", GUILayout.Width(150))) DoBroadcastText();
        if (_peers.Count > 0 && GUILayout.Button("1台目へ", GUILayout.Width(120))) DoSendTextToFirst();
        GUI.enabled = true;
        GUILayout.EndHorizontal();
        GUILayout.Space(6);

        // ── ファイル送信 ─────────────────────────────────────────────────────────
        DrawSectionLabel("ファイル送信（テスト）");
        GUILayout.BeginHorizontal();
        GUI.enabled = _peers.Count > 0 && !busy;
        if (GUILayout.Button("テスト PNG を全員へ", GUILayout.Width(230))) DoSendTestPng(toAll: true);
        if (_peers.Count > 0 && GUILayout.Button("1台目へ PNG", GUILayout.Width(170))) DoSendTestPng(toAll: false);
        GUI.enabled = true;
        GUILayout.EndHorizontal();
        GUILayout.BeginHorizontal();
        GUI.enabled = _peers.Count > 0 && !busy;
        if (GUILayout.Button("テスト TXT を全員へ", GUILayout.Width(230))) DoSendTestTxt(toAll: true);
        if (_peers.Count > 0 && GUILayout.Button("1台目へ TXT", GUILayout.Width(170))) DoSendTestTxt(toAll: false);
        GUI.enabled = true;
        GUILayout.EndHorizontal();
        GUILayout.Space(6);

        // ── 手動受信 ─────────────────────────────────────────────────────────────
        DrawSectionLabel("手動受信（パス / URL）");
        GUILayout.BeginHorizontal();
        _manualPath = GUILayout.TextField(_manualPath, GUILayout.Width(400));
        GUI.enabled = !string.IsNullOrWhiteSpace(_manualPath) && !busy;
        if (GUILayout.Button("受信開始", GUILayout.Width(120))) DoManualReceive();
        GUI.enabled = true;
        GUILayout.EndHorizontal();

        // ── プログレスバー ────────────────────────────────────────────────────────
        if (busy)
        {
            GUILayout.Space(4);
            var rect = GUILayoutUtility.GetRect(400, 22);
            GUI.Box(rect, GUIContent.none);
            GUI.Box(new Rect(rect.x, rect.y, rect.width * Mathf.Clamp01(_progress), rect.height),
                    $"{_progressLabel} {_progress:P0}");
        }

        GUILayout.Space(8);

        // ── ログ ─────────────────────────────────────────────────────────────────
        GUILayout.Label("ログ:");
        var logStyle = new GUIStyle(skin.box)
            { alignment = TextAnchor.UpperLeft, wordWrap = true, fontSize = 22 };
        _logScroll = GUILayout.BeginScrollView(_logScroll,
            GUILayout.Height(Mathf.Min(240, Screen.height - 460)));
        GUILayout.Label(string.Join("\n", _log), logStyle, GUILayout.ExpandWidth(true));
        GUILayout.EndScrollView();

        GUILayout.EndArea();
    }

    // ── Actions ───────────────────────────────────────────────────────────────────

    private void Connect(string roomCode)
    {
        _statusText = "接続中…";
        _client.Connect(roomCode);
    }

    // テキスト送信
    private async void DoBroadcastText()
    {
        BeginProgress("送信中");
        try
        {
            await _client.BroadcastTextAsync(_textInput);
            AddLog($"✓ テキストを全 {_peers.Count} 台に送信");
        }
        catch (Exception ex) { AddLog($"✗ 送信エラー: {ex.Message}"); }
        finally { EndProgress(); }
    }

    private async void DoSendTextToFirst()
    {
        BeginProgress("送信中");
        try
        {
            await _client.SendTextAsync(_peers[0].id, _textInput);
            AddLog($"✓ テキストを {_peers[0].nickname ?? _peers[0].id} に送信");
        }
        catch (Exception ex) { AddLog($"✗ 送信エラー: {ex.Message}"); }
        finally { EndProgress(); }
    }

    // テスト PNG 送信
    private async void DoSendTestPng(bool toAll)
    {
        var png = MakeTestPng(64, 64);
        var name = $"test_{DateTime.Now:HHmmss}.png";
        BeginProgress("PNG 送信中");
        try
        {
            var progress = new Progress<float>(p => _progress = p);
            if (toAll)
            {
                await _client.BroadcastFileAsync(png, name, "image/png", progress);
                AddLog($"✓ PNG ({png.Length:N0} B) を全 {_peers.Count} 台に送信");
            }
            else
            {
                await _client.SendFileAsync(_peers[0].id, png, name, "image/png", progress);
                AddLog($"✓ PNG ({png.Length:N0} B) を {_peers[0].nickname ?? _peers[0].id} に送信");
            }
        }
        catch (Exception ex) { AddLog($"✗ 送信エラー: {ex.Message}"); }
        finally { EndProgress(); }
    }

    // テスト TXT 送信
    private async void DoSendTestTxt(bool toAll)
    {
        var text = $"Test file from Unity at {DateTime.Now:yyyy-MM-dd HH:mm:ss}\n" +
                   $"LocalId: {_client.LocalId}\n";
        var data = Encoding.UTF8.GetBytes(text);
        var name = $"test_{DateTime.Now:HHmmss}.txt";
        BeginProgress("TXT 送信中");
        try
        {
            var progress = new Progress<float>(p => _progress = p);
            if (toAll)
            {
                await _client.BroadcastFileAsync(data, name, "text/plain", progress);
                AddLog($"✓ TXT ({data.Length:N0} B) を全 {_peers.Count} 台に送信");
            }
            else
            {
                await _client.SendFileAsync(_peers[0].id, data, name, "text/plain", progress);
                AddLog($"✓ TXT ({data.Length:N0} B) を {_peers[0].nickname ?? _peers[0].id} に送信");
            }
        }
        catch (Exception ex) { AddLog($"✗ 送信エラー: {ex.Message}"); }
        finally { EndProgress(); }
    }

    // 手動受信
    private async void DoManualReceive()
    {
        var path = _manualPath.Trim();
        AddLog($"📡 受信待機: {path}");
        BeginProgress("受信中");
        try
        {
            var progress = new Progress<float>(p => _progress = p);
            var bytes = await _client.ReceiveFileAsync(path, progress);
            var saved = SaveFile("received_" + Path.GetFileName(path), bytes);
            AddLog($"✓ 受信完了: {bytes.Length:N0} B");
            AddLog($"   保存先: {saved}");
            Debug.Log($"[Pipe] 保存先: {saved}");
        }
        catch (Exception ex) { AddLog($"✗ 受信エラー: {ex.Message}"); }
        finally { EndProgress(); }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────

    private static byte[] MakeTestPng(int w, int h)
    {
        var tex = new Texture2D(w, h, TextureFormat.RGB24, false);
        var rng = new System.Random();
        var r   = (float)rng.NextDouble();
        var g   = (float)rng.NextDouble();
        var b   = (float)rng.NextDouble();
        var col = new Color(r, g, b);
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
                tex.SetPixel(x, y, Color.Lerp(col, Color.white, (float)x / w));
        tex.Apply();
        return tex.EncodeToPNG();
    }

    private static string SaveFile(string filename, byte[] data)
    {
        var dir  = Application.persistentDataPath;
        var path = Path.Combine(dir, filename);
        File.WriteAllBytes(path, data);
        return path;
    }

    private void BeginProgress(string label)
    {
        _progressLabel = label;
        _progress      = 0f;
    }

    private void EndProgress() => _progress = -1f;

    private void AddLog(string msg)
    {
        var ts = DateTime.Now.ToString("HH:mm:ss");
        _log.Insert(0, $"[{ts}] {msg}");
        if (_log.Count > MaxLog) _log.RemoveAt(_log.Count - 1);
        _logScroll = Vector2.zero;
    }

    private static void DrawSectionLabel(string text)
        => GUILayout.Label(text, new GUIStyle(GUI.skin.label) { fontStyle = FontStyle.Bold, fontSize = 24 });

    private static string Clip(string s, int len = 8)
        => string.IsNullOrEmpty(s) ? "-" : (s.Length <= len ? s : s.Substring(0, len) + "…");
}
