using System;
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

                default:
                    Debug.LogWarning($"[Swarm] 未知の kind: '{payload.kind}' from={from?.nickname ?? "?"}");
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
            Debug.Log($"[Swarm] swarm-join 送信 → seeder={entry.SenderId} infoHash={entry.InfoHash}");
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
            var infoHash = payload.infoHash;
            Debug.Log($"[Swarm] wt-signal 受信 from={from?.nickname ?? "?"} infoHash={infoHash ?? "null"} signal={(payload.signal == null ? "NULL ← JSON パース失敗の可能性" : $"type={payload.signal.type}")}");

            if (payload.signal == null)
            {
                Debug.LogWarning("[Swarm] wt-signal スキップ: signal=null (WtSignalData のデシリアライズ失敗)");
                return;
            }

            // infoHash が省略されている場合（ブラウザ実装によっては含まれない）は
            // 唯一の保留ダウンロードへフォールバック
            if (string.IsNullOrEmpty(infoHash))
            {
                if (_downloadTcs.Count == 1)
                {
                    foreach (var kv in _downloadTcs)
                        infoHash = kv.Key;
                    Debug.Log($"[Swarm] infoHash 省略 → 保留ダウンロードへフォールバック: {infoHash}");
                }
                else
                {
                    Debug.LogWarning($"[Swarm] wt-signal スキップ: infoHash=null かつ保留ダウンロード={_downloadTcs.Count} 件 (特定不能)");
                    return;
                }
            }

            // WtSignalData → JSON 文字列に変換して AcceptOfferAsync へ渡す
            var signalJson = JsonUtility.ToJson(payload.signal);
            Debug.Log($"[Swarm] signal JSON (先頭120文字): {signalJson.Substring(0, Mathf.Min(120, signalJson.Length))}");

            // 常にキューへ追加（DL 開始前の先行受信にも対応）
            if (!_pendingSignals.ContainsKey(infoHash))
                _pendingSignals[infoHash] = new Queue<string>();
            _pendingSignals[infoHash].Enqueue(signalJson);

            // ダウンロード待機中なら即座に接続開始
            if (_downloadTcs.TryGetValue(infoHash, out var tcs) && !tcs.Task.IsCompleted)
            {
                Debug.Log($"[Swarm] signal キューイング → 即処理 (infoHash={infoHash} queueSize={_pendingSignals[infoHash].Count})");
                if (_entries.TryGetValue(infoHash, out var entry))
                    ProcessPendingSignal(entry, null, CancellationToken.None);
                else
                    Debug.LogWarning($"[Swarm] エントリが見つからない: infoHash={infoHash}");
            }
            else
            {
                Debug.Log($"[Swarm] signal を先行キャッシュ (infoHash={infoHash} queueSize={_pendingSignals[infoHash].Count}) — DL 開始時に使用");
            }
        }

        private void ProcessPendingSignal(SwarmEntry entry, IProgress<float> progress,
            CancellationToken ct)
        {
            if (!_pendingSignals.TryGetValue(entry.InfoHash, out var queue)) return;
            if (queue.Count == 0) { Debug.Log($"[Swarm] ProcessPendingSignal: キュー空 (infoHash={entry.InfoHash})"); return; }
            if (!_downloadTcs.TryGetValue(entry.InfoHash, out var tcs)) return;
            if (tcs.Task.IsCompleted) return;

            var signalJson = queue.Dequeue();
            Debug.Log($"[Swarm] WebRTC 接続開始 (infoHash={entry.InfoHash})");

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
                Debug.Log($"[Swarm] AcceptOfferAsync 呼び出し (infoHash={entry.InfoHash} seeder={entry.SenderId})");

                // AcceptOfferAsync: answer を相手 (senderId) へ wt-signal で返す
                var dc = await WebRtcTransport.Instance.AcceptOfferAsync(
                    offerSdp,
                    answerJson =>
                    {
                        Debug.Log($"[Swarm] answer 送信 → {entry.SenderId} (先頭80文字: {answerJson.Substring(0, Mathf.Min(80, answerJson.Length))})");
                        // answer JSON 文字列 → WtSignalData オブジェクトに変換して送信
                        var answerSignal = JsonUtility.FromJson<WtSignalData>(answerJson);
                        _ = _sendHandoff(entry.SenderId, new HandoffPayload
                        {
                            kind     = "wt-signal",
                            infoHash = entry.InfoHash,
                            signal   = answerSignal
                        });
                    },
                    ct);

                if (dc == null)
                {
                    Debug.LogWarning($"[Swarm] AcceptOfferAsync 失敗: DataChannel = null (infoHash={entry.InfoHash})");
                    tcs.TrySetException(new Exception("WebRTC 接続失敗"));
                    return;
                }

                Debug.Log($"[Swarm] DataChannel 確立 (infoHash={entry.InfoHash}) → ファイル受信開始");

                if (entry.TotalBytes <= 0)
                {
                    tcs.TrySetException(new Exception($"TotalBytes 不明 (infoHash={entry.InfoHash}) — ブラウザが totalBytes を送っていない可能性"));
                    return;
                }

                var files = await ReceiveViaWire(dc, entry.InfoHash, entry.TotalBytes, progress, ct);
                Debug.Log($"[Swarm] ファイル受信完了: {files.Length} 件");
                tcs.TrySetResult(files);
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[Swarm] ConnectAndReceiveAsync 例外: {ex.Message}");
                tcs.TrySetException(ex);
            }
            finally
            {
                _downloadTcs.Remove(entry.InfoHash);
                _pendingSignals.Remove(entry.InfoHash);
            }
        }

        /// <summary>
        /// DataChannel 上で BitTorrent ワイヤープロトコルを使ってファイルを受信する。
        /// WebTorrent (SimplePeer 経由) との互換プロトコル。
        ///
        /// フロー: 送 handshake → 受 handshake → 受 bitfield → 送 interested →
        ///         受 unchoke → 送 request × N → 受 piece × N → 完了
        /// </summary>
        private Task<byte[][]> ReceiveViaWire(
            RTCDataChannel dc,
            string infoHashHex,
            long totalBytes,
            IProgress<float> progress,
            CancellationToken ct)
        {
            var tcs = new TaskCompletionSource<byte[][]>();

            int pieceLen  = CalcPieceLength(totalBytes);
            var assembled = new byte[totalBytes];
            long receivedBytes = 0;

            var infoHashBytes = HexToBytes(infoHashHex);
            // ピアID: "-UN0001-" + 12桁ランダム (20バイト)
            var myPeerId = System.Text.Encoding.ASCII.GetBytes(
                "-UN0001-" + System.Guid.NewGuid().ToString("N").Substring(0, 12));

            // 受信バッファ（DataChannel から来るチャンクを蓄積）
            var buf      = new List<byte>(64 * 1024);
            bool hsRecv  = false;
            bool interested = false;
            bool unchoked   = false;

            // リクエスト管理（絶対バイトオフセットで追跡）
            long nextReqOff  = 0;
            int  pendingReqs = 0;
            const int BlockSize   = 16384;   // WebTorrent 標準ブロックサイズ
            const int MaxPipeline = 8;

            void SendRequests()
            {
                while (unchoked && pendingReqs < MaxPipeline
                       && nextReqOff < totalBytes && !tcs.Task.IsCompleted)
                {
                    int pIdx  = (int)(nextReqOff / pieceLen);
                    int bOff  = (int)(nextReqOff % pieceLen);
                    long pStart = (long)pIdx * pieceLen;
                    int pSize = (int)Math.Min(pieceLen, totalBytes - pStart);
                    int bLen  = Math.Min(BlockSize, Math.Min(pSize - bOff,
                                    (int)(totalBytes - nextReqOff)));
                    if (bLen <= 0) break;

                    dc.Send(BtWire.Request(pIdx, bOff, bLen));
                    nextReqOff += bLen;
                    pendingReqs++;
                }
            }

            void ProcessBuf()
            {
                while (!tcs.Task.IsCompleted)
                {
                    // ── handshake (68 bytes 固定) ─────────────────────────────────
                    if (!hsRecv)
                    {
                        if (buf.Count < 68) return;
                        buf.RemoveRange(0, 68);
                        hsRecv = true;
                        Debug.Log("[Wire] handshake 受信完了");
                        continue;
                    }

                    // ── 通常メッセージ: [4バイト長][1バイトID][ペイロード] ─────────
                    if (buf.Count < 4) return;
                    int msgLen = BtWire.I32(buf, 0);

                    if (msgLen == 0)           // keep-alive
                    { buf.RemoveRange(0, 4); continue; }

                    if (buf.Count < 4 + msgLen) return;

                    byte id      = buf[4];
                    int  payLen  = msgLen - 1;
                    var  payload = payLen > 0 ? buf.GetRange(5, payLen).ToArray() : Array.Empty<byte>();
                    buf.RemoveRange(0, 4 + msgLen);

                    switch (id)
                    {
                        case 0:  // choke
                            unchoked = false;
                            Debug.Log("[Wire] choked");
                            break;

                        case 1:  // unchoke
                            unchoked = true;
                            Debug.Log("[Wire] unchoked → request 送信開始");
                            SendRequests();
                            break;

                        case 5:  // bitfield — シーダーが持つピース情報
                            Debug.Log($"[Wire] bitfield ({payload.Length}B)");
                            if (!interested)
                            {
                                interested = true;
                                dc.Send(BtWire.Interested());
                                Debug.Log("[Wire] interested 送信");
                            }
                            break;

                        case 4:  // have — 個別ピース通知（interested 送信のトリガーにも使う）
                            if (!interested)
                            {
                                interested = true;
                                dc.Send(BtWire.Interested());
                                Debug.Log("[Wire] interested 送信 (have 受信後)");
                            }
                            break;

                        case 7:  // piece
                            if (payload.Length < 8) break;
                            int pIdx  = BtWire.I32(payload, 0);
                            int bOff  = BtWire.I32(payload, 4);
                            int dLen  = payload.Length - 8;
                            long absOff = (long)pIdx * pieceLen + bOff;

                            if (absOff + dLen > totalBytes)
                                dLen = (int)(totalBytes - absOff);
                            if (dLen > 0)
                                Buffer.BlockCopy(payload, 8, assembled, (int)absOff, dLen);

                            receivedBytes += dLen;
                            pendingReqs--;
                            progress?.Report((float)receivedBytes / totalBytes);
                            Debug.Log($"[Wire] piece[{pIdx}+{bOff}] {dLen}B ({receivedBytes}/{totalBytes})");

                            if (receivedBytes >= totalBytes)
                            {
                                Debug.Log("[Wire] ダウンロード完了");
                                tcs.TrySetResult(new[] { assembled });
                                return;
                            }
                            SendRequests();
                            break;

                        // ID 20 など不明なメッセージは無視
                        default:
                            Debug.Log($"[Wire] 未知メッセージ ID={id} len={msgLen}");
                            break;
                    }
                }
            }

            dc.OnMessage = bytes =>
            {
                buf.AddRange(bytes);
                ProcessBuf();
            };

            dc.OnClose = () =>
            {
                if (!tcs.Task.IsCompleted)
                    tcs.TrySetException(new Exception("[Wire] DataChannel が受信完了前に閉じた"));
            };

            ct.Register(() => tcs.TrySetCanceled());

            // こちらから handshake を送信
            dc.Send(BtWire.Handshake(infoHashBytes, myPeerId));
            Debug.Log($"[Wire] handshake 送信 (infoHash={infoHashHex} pieceLen={pieceLen} " +
                      $"numPieces={((totalBytes + pieceLen - 1) / pieceLen)} totalBytes={totalBytes})");

            return tcs.Task;
        }

        // ── BitTorrent ワイヤープロトコルヘルパー ─────────────────────────────────

        private static int CalcPieceLength(long n)
        {
            if (n < 64L * 1024)           return 1024;
            if (n < 1024L * 1024)         return 16384;
            if (n < 2L * 1024 * 1024)     return 32768;
            if (n < 16L * 1024 * 1024)    return 262144;
            if (n < 512L * 1024 * 1024)   return 524288;
            return 1048576;
        }

        private static byte[] HexToBytes(string hex)
        {
            hex = hex.ToLowerInvariant();
            var bytes = new byte[hex.Length / 2];
            for (int i = 0; i < bytes.Length; i++)
                bytes[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
            return bytes;
        }

        private static class BtWire
        {
            static readonly byte[] Proto = Encoding.ASCII.GetBytes("BitTorrent protocol");

            public static byte[] Handshake(byte[] infoHash, byte[] peerId)
            {
                var m = new byte[68];
                m[0] = 0x13;
                Array.Copy(Proto, 0, m, 1, 19);
                // bytes 20-27: reserved (all zero)
                Array.Copy(infoHash, 0, m, 28, 20);
                Array.Copy(peerId,   0, m, 48, 20);
                return m;
            }

            public static byte[] Interested() => new byte[] { 0, 0, 0, 1, 2 };

            public static byte[] Request(int piece, int begin, int length)
            {
                var m = new byte[17];
                Wi32(m, 0, 13); m[4] = 6;
                Wi32(m, 5, piece); Wi32(m, 9, begin); Wi32(m, 13, length);
                return m;
            }

            public static int I32(IList<byte> b, int i)
                => (b[i] << 24) | (b[i+1] << 16) | (b[i+2] << 8) | b[i+3];

            static void Wi32(byte[] b, int i, int v)
            {
                b[i] = (byte)(v >> 24); b[i+1] = (byte)(v >> 16);
                b[i+2] = (byte)(v >> 8);  b[i+3] = (byte)v;
            }
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

    }
}
