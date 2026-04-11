# Pipe Performance Improvement Plan

最終更新: 2026-04-11

## 目的
- ファイル送受信の体感速度を改善し、WAN/モバイル環境でも安定した転送を実現する。
- HTTP フォールバック頻度を抑えつつ、フォールバック時のスループットも底上げする。
- 効果計測の仕組みを整備し、改善前後のレイテンシ/成功率を定量化できるようにする。

## ワークストリーム

### 1. WebRTC セッション再利用
- `startSendToPeer`/`trySendWebRTC*` で毎回生成している `RTCPeerConnection` を、ルーム内ピアごとに 1 本の長生きセッションへ変更。
- `presenceState.peers` の更新や `pairedIds` をトリガーに、アイドル時点で `RTCPeerConnection + DataChannel` を事前確立しておき、送信要求時は既存 DataChannel に `meta`/`chunk` を流すだけにする。
- セッションが長時間アイドルになった際の自動クローズ（例: 30s）と、端末切断時のクリーンアップ処理を追加。
- 期待効果: 握手 1〜2 秒の削減、モバイルでの接続成功率向上。

### 2. 事前シグナリングと UI フロー調整
- ファイル選択やピア選択時点で `randPath` を確保し、presence 経由で「接続準備中」のハンドオフを送って受信側を待機状態へ。
- 送信ボタン押下時には既に offer/answer の片側が準備済みとなるよう、`trySendWebRTC*` の `fetch(...__offer)`/`fetch(...__answer)` を分割。
- UI に「接続を準備中 → 送信中 → 完了」ステートを追加してユーザーの待機ストレスを軽減。

### 3. DataChannel スループット最適化
- `resolveChunking()` で使用している固定チャンク (64–256KB) と高水位制御を、ブラウザ種別や `pc.sctp.maxMessageSize` 実測値に応じた可変設定へ変更。
- `dc.bufferedAmount` が一定時間減らない場合の自動縮退、Chrome/Edge では 512KB〜1MB まで拡大、Safari/iOS では 64KB に固定など端末別プロファイルを導入。
- `ReadableStream` → `TransformStream` 経由で複数チャンクをまとめて `dc.send()` し CPU オーバーヘッドを削減。

### 4. TURN/ICE と HTTP フォールバック強化
- presence サーバーの `fetchIceServers()` 応答に coturn 資格情報を常備し、STUN 1 台のみになるケースを排除。
- HTTP フォールバック中は `ReadableStream` によるストリーミングアップロードを利用し、複数ファイル時は `Promise.all` で多重化する。
- WebTorrent 共有を自動キックして、P2P による追加経路を確保（特にローカルルームで有効）。

## 計測・検証
- `reportTransfer()` の payload に `phaseDurations`（握手時間、送信時間、総時間）、`chunkSize`、`transport`（P2P/HTTP/WebTorrent）を追加して presence 経由で収集。
- ブラウザ側では `performance.mark/measure` を埋め込み、ランダムサンプリングで `sendBeacon` へ送信し A/B 比較を可能にする。
- `plan/` 配下にベンチスクリプトを追加し、CI で headless Chrome 同士の WebRTC 転送を実行。1GB 単体/100MB×5 のシナリオでレイテンシと成功率を記録。

## マイルストン例
1. Week 1: セッション再利用のベータ実装と feature flag 導入。
2. Week 2: 事前シグナリング + UI 更新、TURN 設定の改善。
3. Week 3: DataChannel 最適化と HTTP ストリーミングフォールバック実装。
4. Week 4: 計測ダッシュボード整備、A/B テスト、ベンチ自動化。

## リスクと対策
- 長寿命 RTCPeerConnection のメモリリーク → デバイスごとの上限と heartbeat を設置し、状態不一致時は再ネゴシエート。
- chunk サイズ拡大による Safari クラッシュ → UA 判定 + 実際の `pc.sctp.maxMessageSize` を測定し、安全値を下回る場合は自動的に縮退。
- TURN コスト増 → 帯域課金を想定し、まずは特定ルーム/端末のみで試験導入してトラフィックを計測。
