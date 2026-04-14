using System;
using System.Collections.Generic;
using System.Text;
using UnityEngine;
using Afjk.Pipe;

/// <summary>
/// PipeClient の動作確認サンプル。OnGUI でシンプルな UI を表示する。
///
/// セットアップ:
///   1. 空の GameObject に PipeClient と PipeExample を AddComponent する。
///   2. Play するだけで自動的に Presence へ接続する。
///   3. 画面上の UI からテキスト送受信・Presence 状態を確認できる。
/// </summary>
public class PipeExample : MonoBehaviour
{
    // ── State ─────────────────────────────────────────────────────────────────────
    private PipeClient      _client;
    private string          _statusText     = "未接続";
    private string          _roomText       = "";
    private string          _textInput      = "Hello from Unity!";
    private string          _roomCodeInput  = "";
    private string          _manualPath     = "";
    private List<PeerInfo>  _peers          = new List<PeerInfo>();
    private List<string>    _log            = new List<string>();
    private float           _sendProgress   = -1f;
    private Vector2         _logScroll;
    private const int       MaxLog          = 50;

    // ── Unity lifecycle ───────────────────────────────────────────────────────────

    private void Awake()
    {
        _client = GetComponent<PipeClient>();

        _client.OnConnected    += () => { _statusText = "接続済み"; AddLog("✓ Presence 接続"); };
        _client.OnDisconnected += () => { _statusText = "切断"; AddLog("✗ Presence 切断"); };
        _client.OnPeersUpdated += peers =>
        {
            _peers = new List<PeerInfo>(peers);
            AddLog($"ピア更新: {peers.Count} 台");
        };
        _client.OnFileReceived += args =>
        {
            AddLog($"📥 ファイル受信: {args.Filename} ({args.Size:N0} B) from {args.From?.nickname ?? "?"}");
        };
        _client.OnTextReceived += args =>
        {
            AddLog($"💬 テキスト受信 from {args.From?.nickname ?? "?"}: {args.Text}");
        };
    }

    private void Start()
    {
        Connect(null);
    }

    private void OnDestroy()
    {
        _client.Disconnect();
    }

    // ── GUI ───────────────────────────────────────────────────────────────────────

    private void OnGUI()
    {
        var skin = GUI.skin;
        GUILayout.BeginArea(new Rect(10, 10, 420, Screen.height - 20));

        // ── ヘッダー ─────────────────────────────────────────────────────────────
        GUILayout.Label("afjk.jp / pipe — Unity Client", new GUIStyle(skin.label)
        {
            fontSize  = 16,
            fontStyle = FontStyle.Bold
        });

        GUILayout.Label($"状態: {_statusText}  |  LocalId: {Clip(_client.LocalId)}  |  Room: {_client.RoomId ?? "-"}");

        GUILayout.Space(4);

        // ── ルームコード ──────────────────────────────────────────────────────────
        GUILayout.BeginHorizontal();
        GUILayout.Label("ルームコード:", GUILayout.Width(90));
        _roomCodeInput = GUILayout.TextField(_roomCodeInput, GUILayout.Width(120));
        if (GUILayout.Button("参加", GUILayout.Width(50)))
            Connect(string.IsNullOrWhiteSpace(_roomCodeInput) ? null : _roomCodeInput.Trim());
        if (GUILayout.Button("退場", GUILayout.Width(50)))
        {
            _roomCodeInput = "";
            Connect(null);
        }
        GUILayout.EndHorizontal();

        GUILayout.Space(6);

        // ── ピアリスト ────────────────────────────────────────────────────────────
        GUILayout.Label($"ピア ({_peers.Count} 台):");
        if (_peers.Count == 0)
        {
            GUILayout.Label("  （検出なし）");
        }
        else
        {
            foreach (var p in _peers)
                GUILayout.Label($"  • {p.nickname ?? "?"} [{p.device ?? "?"}]  id={Clip(p.id)}");
        }

        GUILayout.Space(6);

        // ── テキスト送信 ──────────────────────────────────────────────────────────
        GUILayout.Label("テキスト送信:");
        _textInput = GUILayout.TextField(_textInput, GUILayout.Width(310));
        GUILayout.BeginHorizontal();
        GUI.enabled = _peers.Count > 0 && _sendProgress < 0f;
        if (GUILayout.Button("全員に送信", GUILayout.Width(100)))
            DoBroadcastText();
        if (_peers.Count > 0 && GUILayout.Button($"1台目へ送信", GUILayout.Width(100)))
            DoSendTextToFirst();
        GUI.enabled = true;
        GUILayout.EndHorizontal();

        GUILayout.Space(6);

        // ── 手動受信 ──────────────────────────────────────────────────────────────
        GUILayout.Label("手動受信（パス / URL）:");
        GUILayout.BeginHorizontal();
        _manualPath = GUILayout.TextField(_manualPath, GUILayout.Width(220));
        GUI.enabled = !string.IsNullOrWhiteSpace(_manualPath) && _sendProgress < 0f;
        if (GUILayout.Button("受信開始", GUILayout.Width(80)))
            DoManualReceive();
        GUI.enabled = true;
        GUILayout.EndHorizontal();

        // ── プログレス ────────────────────────────────────────────────────────────
        if (_sendProgress >= 0f)
        {
            GUILayout.Space(4);
            var rect = GUILayoutUtility.GetRect(200, 20);
            GUI.Box(rect, GUIContent.none);
            var fill = new Rect(rect.x, rect.y, rect.width * _sendProgress, rect.height);
            GUI.Box(fill, $"{_sendProgress:P0}");
        }

        GUILayout.Space(8);

        // ── ログ ─────────────────────────────────────────────────────────────────
        GUILayout.Label("ログ:");
        var logStyle = new GUIStyle(skin.box)
        {
            alignment = TextAnchor.UpperLeft,
            wordWrap  = true,
            fontSize  = 11
        };
        _logScroll = GUILayout.BeginScrollView(_logScroll,
            GUILayout.Height(Mathf.Min(200, Screen.height - 400)));
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

    private async void DoBroadcastText()
    {
        _sendProgress = 0f;
        try
        {
            var progress = new Progress<float>(p => _sendProgress = p);
            await _client.BroadcastTextAsync(_textInput);
            AddLog($"✓ テキストを全 {_peers.Count} 台に送信");
        }
        catch (System.Exception ex)
        {
            AddLog($"✗ 送信エラー: {ex.Message}");
        }
        finally { _sendProgress = -1f; }
    }

    private async void DoSendTextToFirst()
    {
        _sendProgress = 0f;
        try
        {
            await _client.SendTextAsync(_peers[0].id, _textInput);
            AddLog($"✓ テキストを {_peers[0].nickname ?? _peers[0].id} に送信");
        }
        catch (System.Exception ex)
        {
            AddLog($"✗ 送信エラー: {ex.Message}");
        }
        finally { _sendProgress = -1f; }
    }

    private async void DoManualReceive()
    {
        var path = _manualPath.Trim();
        AddLog($"📡 受信待機: {path}");
        _sendProgress = 0f;
        try
        {
            var progress = new Progress<float>(p => _sendProgress = p);
            var bytes = await _client.ReceiveFileAsync(path, progress);
            AddLog($"✓ 受信完了: {bytes.Length:N0} B");
        }
        catch (System.Exception ex)
        {
            AddLog($"✗ 受信エラー: {ex.Message}");
        }
        finally { _sendProgress = -1f; }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────

    private void AddLog(string msg)
    {
        var ts = System.DateTime.Now.ToString("HH:mm:ss");
        _log.Insert(0, $"[{ts}] {msg}");
        if (_log.Count > MaxLog) _log.RemoveAt(_log.Count - 1);
        _logScroll = Vector2.zero;   // 最新行へスクロール
    }

    private static string Clip(string s, int len = 8)
        => string.IsNullOrEmpty(s) ? "-" : (s.Length <= len ? s : s.Substring(0, len) + "…");
}
