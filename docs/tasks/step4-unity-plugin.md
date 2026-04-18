# Step 4: Unity Editor プラグイン雛形

## 目的

Unity Editor 上で動作する EditorWindow を作成し、presence-server に WebSocket 接続する。
この Step ではシーン同期はまだ行わない。以下が動くことをゴールとする。

- EditorWindow からルームコードを入力して接続できる
- presence-server に WebSocket 接続し、welcome / peers を受信できる
- 接続状態（ルーム名・ピア数）が EditorWindow に表示される
- broadcast 送信のヘルパーメソッドが用意されている

---

## リポジトリ構成

UPM パッケージとして別リポジトリに作成する。

    com.afjk.scene-sync/
    ├── package.json
    ├── Editor/
    │   ├── SceneSyncWindow.cs       # EditorWindow UI
    │   ├── PresenceClient.cs        # WebSocket 接続・メッセージ処理
    │   └── SceneSyncEditor.asmdef   # Assembly Definition
    └── README.md

---

## package.json

    {
      "name": "com.afjk.scene-sync",
      "version": "0.1.0",
      "displayName": "Scene Sync",
      "description": "Real-time 3D scene sync between Unity Editor and web browsers via afjk.jp/pipe presence-server.",
      "unity": "2021.3",
      "author": {
        "name": "afjk"
      },
      "keywords": ["scene", "sync", "collaboration", "websocket"]
    }

---

## Editor/SceneSyncEditor.asmdef

    {
      "name": "SceneSyncEditor",
      "rootNamespace": "Afjk.SceneSync.Editor",
      "references": [],
      "includePlatforms": ["Editor"],
      "excludePlatforms": [],
      "allowUnsafeCode": false,
      "overrideReferences": false,
      "precompiledReferences": [],
      "autoReferenced": true,
      "defineConstraints": [],
      "versionDefines": [],
      "noEngineReferences": false
    }

---

## Editor/PresenceClient.cs

WebSocket 接続と presence プロトコルを処理するクラス。
Unity の ClientWebSocket を使用する（外部ライブラリ不要）。

    using System;
    using System.Collections.Generic;
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
            public string kind;
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

        [Serializable]
        public class HandoffMessage
        {
            public string type;
            public PeerInfo from;
            public string payload; // JSON string, parsed by caller
        }

        [Serializable]
        public class HandoffPayload
        {
            public string kind;
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
            public event Action<string, string> OnHandoffReceived; // (fromJson, payloadJson)

            private ClientWebSocket _ws;
            private CancellationTokenSource _cts;
            private readonly byte[] _recvBuf = new byte[131072]; // 128KB, matches server limit

            public async Task ConnectAsync(string presenceUrl, string room, string nickname)
            {
                Disconnect();

                _cts = new CancellationTokenSource();
                _ws = new ClientWebSocket();

                var url = string.IsNullOrEmpty(room)
                    ? presenceUrl
                    : $"{presenceUrl}/?room={room}";

                try
                {
                    await _ws.ConnectAsync(new Uri(url), _cts.Token);

                    // Send hello
                    var hello = JsonUtility.ToJson(new PresenceMessage
                    {
                        type = "hello",
                        nickname = nickname,
                        device = "Unity Editor"
                    });
                    await SendRaw(hello);

                    OnConnected?.Invoke();

                    // Start receive loop
                    _ = ReceiveLoop();
                }
                catch (Exception ex)
                {
                    Debug.LogWarning($"[SceneSync] Connect failed: {ex.Message}");
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
                var msg = $"{{\"type\":\"broadcast\",\"payload\":{payloadJson}}}";
                await SendRaw(msg);
            }

            public async Task SendHandoff(string targetId, string payloadJson)
            {
                var msg = $"{{\"type\":\"handoff\",\"targetId\":\"{targetId}\",\"payload\":{payloadJson}}}";
                await SendRaw(msg);
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
                    Debug.LogWarning($"[SceneSync] Send failed: {ex.Message}");
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

                        if (result.MessageType == WebSocketMessageType.Close)
                        {
                            break;
                        }

                        var text = Encoding.UTF8.GetString(_recvBuf, 0, result.Count);
                        HandleMessage(text);
                    }
                }
                catch (OperationCanceledException) { }
                catch (Exception ex)
                {
                    Debug.LogWarning($"[SceneSync] Receive error: {ex.Message}");
                }
                finally
                {
                    OnDisconnected?.Invoke();
                }
            }

            private void HandleMessage(string raw)
            {
                // Minimal parse to get type
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
                        Peers = new List<PeerInfo>(peersMsg.peers ?? Array.Empty<PeerInfo>());
                        OnPeersUpdated?.Invoke(Peers);
                        break;

                    case "handoff":
                        // Extract from and payload as raw JSON for flexible handling
                        OnHandoffReceived?.Invoke(raw, raw);
                        break;

                    case "ping":
                        _ = SendRaw("{\"type\":\"pong\"}");
                        break;
                }
            }
        }
    }

---

## Editor/SceneSyncWindow.cs

EditorWindow UI。接続・切断・状態表示を行う。

    using System.Collections.Generic;
    using UnityEditor;
    using UnityEngine;

    namespace Afjk.SceneSync.Editor
    {
        public class SceneSyncWindow : EditorWindow
        {
            [MenuItem("Window/Scene Sync")]
            public static void ShowWindow()
            {
                GetWindow<SceneSyncWindow>("Scene Sync");
            }

            private PresenceClient _client;
            private string _presenceUrl = "wss://afjk.jp/presence";
            private string _room = "";
            private string _nickname = "Unity";
            private bool _connected;
            private List<PeerInfo> _peers = new List<PeerInfo>();

            private void OnEnable()
            {
                _client = new PresenceClient();
                _client.OnConnected += () =>
                {
                    _connected = true;
                    Repaint();
                };
                _client.OnDisconnected += () =>
                {
                    _connected = false;
                    Repaint();
                };
                _client.OnPeersUpdated += (peers) =>
                {
                    _peers = peers;
                    Repaint();
                };
                _client.OnHandoffReceived += OnHandoff;

                EditorApplication.update += EditorUpdate;
            }

            private void OnDisable()
            {
                EditorApplication.update -= EditorUpdate;
                _client?.Disconnect();
            }

            private void EditorUpdate()
            {
                // Keep editor responsive to async callbacks
            }

            private void OnGUI()
            {
                GUILayout.Label("Scene Sync", EditorStyles.boldLabel);
                GUILayout.Space(4);

                _presenceUrl = EditorGUILayout.TextField("Presence URL", _presenceUrl);
                _room = EditorGUILayout.TextField("Room", _room);
                _nickname = EditorGUILayout.TextField("Nickname", _nickname);

                GUILayout.Space(8);

                if (!_connected)
                {
                    if (GUILayout.Button("Connect"))
                    {
                        _ = _client.ConnectAsync(_presenceUrl, _room, _nickname);
                    }
                }
                else
                {
                    EditorGUILayout.HelpBox(
                        $"Connected — Room: {_client.Room} / Peers: {_peers.Count}",
                        MessageType.Info
                    );

                    if (_peers.Count > 0)
                    {
                        GUILayout.Label("Peers:", EditorStyles.miniLabel);
                        foreach (var p in _peers)
                        {
                            GUILayout.Label($"  {p.nickname} ({p.device})", EditorStyles.miniLabel);
                        }
                    }

                    if (GUILayout.Button("Disconnect"))
                    {
                        _client.Disconnect();
                    }
                }
            }

            private void OnHandoff(string raw, string payloadRaw)
            {
                // 次の Step で scene-state, scene-delta 等を実装
            }
        }
    }

---

## Unity プロジェクトへの導入

### ローカル開発（パス参照）

Packages/manifest.json に追加:

    {
      "dependencies": {
        "com.afjk.scene-sync": "file:../../com.afjk.scene-sync"
      }
    }

### UPM レジストリ経由（公開後）

    {
      "scopedRegistries": [
        {
          "name": "afjk",
          "url": "https://upm.afjk.jp",
          "scopes": ["com.afjk"]
        }
      ],
      "dependencies": {
        "com.afjk.scene-sync": "0.1.0"
      }
    }

---

## 動作確認

### 1. Unity Editor で Window > Scene Sync を開く

### 2. 接続情報を入力

- Presence URL: `wss://afjk.jp/presence`（またはローカル: `ws://localhost:8787`）
- Room: `test`
- Nickname: 任意

### 3. Connect ボタンを押す

### 4. 確認項目

- [ ] EditorWindow が開く
- [ ] Connect 押下で presence-server に接続できる
- [ ] Room 名とピア数が表示される
- [ ] ブラウザで同じルームに入るとピア数が増える
- [ ] Disconnect で切断できる
- [ ] Console にエラーが出ない

---

## 完了条件

- [ ] UPM パッケージ構成でリポジトリが作成されている
- [ ] PresenceClient.cs が WebSocket 接続・hello・peers・handoff を処理する
- [ ] SceneSyncWindow.cs が EditorWindow で接続 UI を提供する
- [ ] Broadcast メソッドが用意されている
- [ ] presence-server に接続しルーム参加できる
