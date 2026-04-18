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
            _client.OnConnected += () => { _connected = true; Repaint(); };
            _client.OnDisconnected += () => { _connected = false; Repaint(); };
            _client.OnPeersUpdated += (peers) => { _peers = peers; Repaint(); };
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
                    "Connected\nRoom: " + _client.Room + "\nPeers: " + _peers.Count,
                    MessageType.Info
                );

                if (_peers.Count > 0)
                {
                    GUILayout.Label("Peers:", EditorStyles.miniLabel);
                    foreach (var p in _peers)
                    {
                        GUILayout.Label("  " + p.nickname + " (" + p.device + ")",
                            EditorStyles.miniLabel);
                    }
                }

                if (GUILayout.Button("Disconnect"))
                {
                    _client.Disconnect();
                }
            }
        }

        private void OnHandoff(string raw)
        {
            // 次の Step で scene-state, scene-delta 等を実装
        }
    }
}
