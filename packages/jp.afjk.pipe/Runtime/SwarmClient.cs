using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Unity.WebRTC;
using UnityEngine;
using Afjk.Pipe.Internal;

namespace Afjk.Pipe
{
    /// <summary>
    /// swarm-* / torrent / wt-signal ハンドオフを処理し、
    /// ルーム内で共有されているトレントの一覧管理とダウンロードを担う。
    ///
    /// ダウンロードフロー:
    ///   1. DownloadAsync(entry) 呼び出し
    ///   2. シーダーに swarm-join を送信
    ///   3. シーダーから wt-signal (offer) を受信
    ///   4. AcceptOfferAsync で WebRTC 接続を確立
    ///   5. DataChannel 上で BitTorrent ワイヤープロトコルを実行
    ///   6. ファイルデータを受信して返す
    /// </summary>
    public class SwarmClient
    {
        // ── 依存注入 ──────────────────────────────────────────────────────────────
        private readonly Func<string, HandoffPayload, Task> _sendHandoff;   // (targetId, payload)
        private readonly Func<string, Task>                 _broadcastHandoff; // (kind) 全員へ
        private readonly string                             _localId;
        private readonly string                             _localNickname;

        // ── スウォームテーブル ─────────────────────────────────────────────────────
        private readonly Dictionary<string, SwarmEntry> _entries = new Dictionary<string, SwarmEntry>();
        private bool _syncReceived = false;

        // ── 進行中ダウンロード (infoHash → pending signal queue) ─────────────────
        private readonly Dictionary<string, Queue<string>> _pendingSignals
            = new Dictionary<string, Queue<string>>();

        // ── 進行中ダウンロードの TCS (infoHash → tcs) ────────────────────────────
        private readonly Dictionary<string, TaskCompletionSource<byte[][]>> _downloadTcs
            = new Dictionary<string, TaskCompletionSource<byte[][]>>();

        // ── イベント ──────────────────────────────────────────────────────────────
        public event Action<IReadOnlyList<SwarmEntry>> OnSwarmUpdated;

        public SwarmClient(
            string localId,
            string localNickname,
            Func<string, HandoffPayload, Task> sendHandoff,
            Func<string, Task> broadcastHandoffKind)
        {
            _localId        = localId;
            _localNickname  = localNickname;
            _sendHandoff    = sendHandoff;
            _broadcastHandoff = broadcastHandoffKind;
        }

        // ── 入室時処理 ────────────────────────────────────────────────────────────

        /// <summary>ルーム参加直後に全ピアへ swarm-request を送信する。</summary>
        public void RequestSync(IReadOnlyList<PeerInfo> peers)
        {
            _syncReceived = false;
            var payload = new HandoffPayload { kind = "swarm-request" };
            foreach (var p in peers)
                _ = _sendHandoff(p.id, payload);
        }

        // ── ハンドオフ受信 ────────────────────────────────────────────────────────

        public void HandleHandoff(PeerInfo from, HandoffPayload payload)
        {
            if (payload == null) return;
            switch (payload.kind)
            {
                case "torrent":
                case "swarm-publish":
                    AddOrUpdate(from, payload);
                    break;

                case "swarm-request":
                    _ = SendSync(from.id);
                    break;

                case "swarm-sync":
                case "swarm-catalog":
                    if (!_syncReceived)
                    {
                        _syncReceived = true;
                        ApplySync(from, payload.entries);
                    }
                    break;

                case "swarm-seeder":
                    UpdateSeeder(payload.infoHash, payload.active);
                    break;

                case "wt-signal":
                    DispatchSignal(from, payload);
                    break;
            }
        }

        // ── ダウンロード ──────────────────────────────────────────────────────────

        /// <summary>
        /// 指定エントリのファイルデータをダウンロードする。
        /// 戻り値: ファイルごとの byte[][] (エントリのファイル順)
        /// </summary>
        public Task<byte[][]> DownloadAsync(SwarmEntry entry, IProgress<float> progress = null,
            CancellationToken ct = default)
        {
            var tcs = new TaskCompletionSource<byte[][]>();
            _downloadTcs[entry.InfoHash] = tcs;

            if (!_pendingSignals.ContainsKey(entry.InfoHash))
                _pendingSignals[entry.InfoHash] = new Queue<string>();

            // シーダーに接続要求
            var payload = new HandoffPayload
            {
                kind     = "swarm-join",
                infoHash = entry.InfoHash,
                peerId   = _localId
            };
            _ = _sendHandoff(entry.SenderId, payload);

            // キャンセル時のクリーンアップ
            ct.Register(() =>
            {
                if (_downloadTcs.TryGetValue(entry.InfoHash, out var t) && t == tcs)
                {
                    _downloadTcs.Remove(entry.InfoHash);
                    tcs.TrySetCanceled();
                }
            });

            // シグナルが既にキューに積まれていれば処理開始
            ProcessPendingSignal(entry, progress, ct);

            return tcs.Task;
        }

        // ── 内部: シグナル配送 ────────────────────────────────────────────────────

        private void DispatchSignal(PeerInfo from, HandoffPayload payload)
        {
            var signalJson = payload.signal;
            var infoHash   = payload.infoHash;

            if (string.IsNullOrEmpty(infoHash) || string.IsNullOrEmpty(signalJson)) return;

            // ダウンロード待機中かチェック
            if (_downloadTcs.TryGetValue(infoHash, out var tcs) && !tcs.Task.IsCompleted)
            {
                if (!_pendingSignals.ContainsKey(infoHash))
                    _pendingSignals[infoHash] = new Queue<string>();

                _pendingSignals[infoHash].Enqueue(signalJson);

                // エントリを特定して接続
                if (_entries.TryGetValue(infoHash, out var entry))
                    ProcessPendingSignal(entry, null, CancellationToken.None);
            }
        }

        private void ProcessPendingSignal(SwarmEntry entry, IProgress<float> progress,
            CancellationToken ct)
        {
            if (!_pendingSignals.TryGetValue(entry.InfoHash, out var queue)) return;
            if (queue.Count == 0) return;
            if (!_downloadTcs.TryGetValue(entry.InfoHash, out var tcs)) return;
            if (tcs.Task.IsCompleted) return;

            var signalJson = queue.Dequeue();

            // WebRtcTransport でオファーを受け入れ、DataChannel 上で受信
            _ = ConnectAndReceiveAsync(entry, signalJson, progress, ct, tcs);
        }

        private async Task ConnectAndReceiveAsync(
            SwarmEntry entry,
            string offerSdp,
            IProgress<float> progress,
            CancellationToken ct,
            TaskCompletionSource<byte[][]> tcs)
        {
            try
            {
                RTCDataChannel dc = null;

                // AcceptOfferAsync: answer を相手 (senderId) へ wt-signal で返す
                dc = await WebRtcTransport.Instance.AcceptOfferAsync(
                    offerSdp,
                    answerJson =>
                    {
                        _ = _sendHandoff(entry.SenderId, new HandoffPayload
                        {
                            kind     = "wt-signal",
                            infoHash = entry.InfoHash,
                            signal   = answerJson
                        });
                    },
                    ct);

                if (dc == null)
                {
                    tcs.TrySetException(new Exception("WebRTC 接続失敗"));
                    return;
                }

                // DataChannel 上で BitTorrent ライクな受信
                var files = await ReceiveFilesOverDc(dc, entry.FileCount, progress, ct);
                tcs.TrySetResult(files);
            }
            catch (Exception ex)
            {
                tcs.TrySetException(ex);
            }
            finally
            {
                _downloadTcs.Remove(entry.InfoHash);
                _pendingSignals.Remove(entry.InfoHash);
            }
        }

        /// <summary>
        /// DataChannel 上でファイルを受信する。
        /// 送信側は meta → chunks... → done を各ファイルごとに繰り返し、
        /// 最後に all-done を送る。
        /// </summary>
        private Task<byte[][]> ReceiveFilesOverDc(
            RTCDataChannel dc,
            int fileCount,
            IProgress<float> progress,
            CancellationToken ct)
        {
            var tcs     = new TaskCompletionSource<byte[][]>();
            var results = new List<byte[]>();

            var chunks       = new List<byte[]>();
            int received     = 0;
            int expectedSize = 0;
            int filesDone    = 0;

            dc.OnMessage = bytes =>
            {
                if (tcs.Task.IsCompleted) return;

                // JSON 制御フレーム判定
                if (bytes.Length > 0 && bytes[0] == (byte)'{')
                {
                    try
                    {
                        var json  = Encoding.UTF8.GetString(bytes);
                        var probe = JsonUtility.FromJson<TypeProbe>(json);

                        if (probe.t == "meta")
                        {
                            var meta     = JsonUtility.FromJson<MetaFrame>(json);
                            expectedSize = meta.size;
                            chunks.Clear();
                            received = 0;
                        }
                        else if (probe.t == "done")
                        {
                            var data   = Combine(chunks, received);
                            results.Add(data);
                            chunks.Clear();
                            received = 0;
                            filesDone++;
                            progress?.Report((float)filesDone / Mathf.Max(1, fileCount));
                        }
                        else if (probe.t == "all-done")
                        {
                            tcs.TrySetResult(results.ToArray());
                        }
                        return;
                    }
                    catch { /* バイナリとして扱う */ }
                }

                chunks.Add(bytes);
                received += bytes.Length;
                if (expectedSize > 0)
                    progress?.Report((float)received / expectedSize / Mathf.Max(1, fileCount));
            };

            dc.OnClose = () =>
            {
                if (!tcs.Task.IsCompleted)
                    tcs.TrySetException(new Exception("DataChannel が予期せず閉じられた"));
            };

            ct.Register(() => tcs.TrySetCanceled());

            return tcs.Task;
        }

        // ── 内部: エントリ管理 ────────────────────────────────────────────────────

        private void AddOrUpdate(PeerInfo from, HandoffPayload p)
        {
            if (string.IsNullOrEmpty(p.magnetURI)) return;

            var infoHash = ExtractInfoHash(p.magnetURI);
            if (string.IsNullOrEmpty(infoHash)) return;

            if (!_entries.ContainsKey(infoHash))
            {
                _entries[infoHash] = new SwarmEntry
                {
                    InfoHash     = infoHash,
                    MagnetURI    = p.magnetURI,
                    FileNames    = p.fileNames?.Split(new[]{','}, StringSplitOptions.RemoveEmptyEntries) ?? Array.Empty<string>(),
                    FileCount    = p.fileCount,
                    TotalBytes   = p.totalBytes,
                    FromNickname = from?.nickname ?? "?",
                    SenderId     = from?.id ?? "",
                    IsSeeding    = true
                };
                FireUpdated();
            }
        }

        private Task SendSync(string targetId)
        {
            var list = new List<SwarmEntryData>();
            foreach (var e in _entries.Values)
                list.Add(new SwarmEntryData
                {
                    infoHash     = e.InfoHash,
                    magnetURI    = e.MagnetURI,
                    fileNames    = string.Join(",", e.FileNames),
                    fileCount    = e.FileCount,
                    totalBytes   = e.TotalBytes,
                    fromNickname = e.FromNickname,
                    senderId     = e.SenderId
                });

            return _sendHandoff(targetId, new HandoffPayload
            {
                kind    = "swarm-sync",
                entries = list
            });
        }

        private void ApplySync(PeerInfo from, List<SwarmEntryData> entries)
        {
            if (entries == null) return;
            foreach (var d in entries)
            {
                if (string.IsNullOrEmpty(d.infoHash) || _entries.ContainsKey(d.infoHash)) continue;
                _entries[d.infoHash] = new SwarmEntry
                {
                    InfoHash     = d.infoHash,
                    MagnetURI    = d.magnetURI,
                    FileNames    = d.fileNames?.Split(new[]{','}, StringSplitOptions.RemoveEmptyEntries) ?? Array.Empty<string>(),
                    FileCount    = d.fileCount,
                    TotalBytes   = d.totalBytes,
                    FromNickname = d.fromNickname ?? from?.nickname ?? "?",
                    SenderId     = d.senderId ?? from?.id ?? "",
                    IsSeeding    = true
                };
            }
            FireUpdated();
        }

        private void UpdateSeeder(string infoHash, bool active)
        {
            if (string.IsNullOrEmpty(infoHash)) return;
            if (!_entries.TryGetValue(infoHash, out var e)) return;
            e.IsSeeding = active;
            if (!active)
                _entries.Remove(infoHash);
            FireUpdated();
        }

        private void FireUpdated()
        {
            var list = new List<SwarmEntry>(_entries.Values);
            OnSwarmUpdated?.Invoke(list);
        }

        // ── ユーティリティ ────────────────────────────────────────────────────────

        private static string ExtractInfoHash(string magnetURI)
        {
            if (string.IsNullOrEmpty(magnetURI)) return null;
            const string prefix = "urn:btih:";
            int idx = magnetURI.IndexOf(prefix, StringComparison.OrdinalIgnoreCase);
            if (idx < 0) return null;
            idx += prefix.Length;
            int end = magnetURI.IndexOf('&', idx);
            return end < 0 ? magnetURI.Substring(idx) : magnetURI.Substring(idx, end - idx);
        }

        private static byte[] Combine(List<byte[]> chunks, int total)
        {
            var buf = new byte[total];
            int off = 0;
            foreach (var c in chunks) { Buffer.BlockCopy(c, 0, buf, off, c.Length); off += c.Length; }
            return buf;
        }

        // ── 内部 JSON 型 ──────────────────────────────────────────────────────────
        [Serializable] private class TypeProbe { public string t; }
        [Serializable] private class MetaFrame  { public string t; public string name; public string mime; public int size; }
    }
}
