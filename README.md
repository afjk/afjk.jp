# afjk.jp
afjk.jp home server

## サービス一覧

### afjk.jp / www.afjk.jp — メインサイト

静的HTMLサイト。`html/index.html` を編集してデプロイ。

---

### upm.afjk.jp — Unity Package Manager レジストリ (Verdaccio)

プライベートnpmレジストリ。Unityパッケージの配布に使用。

**パッケージの参照** (認証不要)

```
https://upm.afjk.jp
```

**パッケージの公開** (要認証)

```bash
# ログイン
npm login --registry https://upm.afjk.jp

# 公開
npm publish --registry https://upm.afjk.jp
```

**Unity での設定** (`Packages/manifest.json`)

```json
{
  "scopedRegistries": [
    {
      "name": "afjk",
      "url": "https://upm.afjk.jp",
      "scopes": ["com.afjk", "jp.afjk"]
    }
  ]
}
```

---

### afjk.jp/pipe — File Transfer

ブラウザ完結型のファイル・テキスト転送・映像配信ページ（`html/pipe/index.html` + `html/assets/js/pipe/` 以下の JS モジュール群）。

- **近くのデバイス**: 同一ネットワーク内のデバイスが自動検出され、タップするだけで転送開始
- **ルームコード**: 6文字コードを生成して URL 共有すれば、リモートの相手とも接続可能。参加/退場時に URL の `?room=` を自動更新するためリロードで再入場・退場状態を維持
- **全員に送信**: ルーム内の全デバイスへファイル・テキストを並列一斉送信
- **送信元表示**: presence 経由で届いたファイル・テキストに送信元端末名を表示。テキスト受信履歴にも送信元を記録
- **複数ファイル一括送信**: ドロップゾーンに複数ファイルをドロップして一括転送
- **Google Drive 連携**: Google Drive のファイルを Picker API で選択してそのまま送信可能
- **テキスト送受信**: テキストや URL を直接送受信。受信履歴を localStorage に保存
- **転送モード**: WebRTC P2P を優先試行し、失敗時は piping-server 中継にフォールバック
- **映像配信**: 「配信」タブからカメラ映像または画面共有をルーム内にリアルタイム配信（WHIP/WHEP、MediaMTX）。カメラ選択・インカメ/アウトカメ切替・画面共有に対応
- **ルームに共有**: WebTorrent + SimplePeer による BitTorrent 方式の実験的転送。「ルームに共有」ボタンでトレントをルーム内に公開し、受信タブの「ルームで保持中のファイル」リストから任意のタイミングでダウンロード可能。プレゼンスサーバーをシグナリングに使ったトラッカー不要の P2P 転送
- **デバイスピン留め**: よく使うデバイスを IndexedDB に保存して優先表示
- **ファイルプレビュー**: 送受信ファイルを 👁 ボタンでモーダルプレビュー。対応フォーマット:
  - 画像 (`jpg` / `jpeg` / `png` / `gif` / `webp` / `avif` / `svg` / `bmp` / `ico`)
  - 動画 (`mp4` / `webm` / `ogg` / `ogv` / `mov` / `avi` / `mkv`)
  - 音声 (`mp3` / `wav` / `ogg` / `oga` / `flac` / `aac` / `m4a` / `opus`)
  - PDF
  - 3D モデル (`glb` / `gltf`、model-viewer によるインタラクティブ表示)
  - Markdown (レンダリング表示)
  - CSV (テーブル表示)
  - テキスト / コード (`txt` / `log` / `json` / `xml` / `yaml` / `yml` / `toml` / `ini` / `sh` / `py` / `js` / `ts` / `html` / `css` / `rs` / `go` / `java` / `c` / `cpp` / `h`)
- **画像編集（背景削除）**: 画像プレビュー中に「✂ 背景を削除」ボタンで背景を自動除去。処理後はモバイルで「フォトに保存」(Web Share API)、デスクトップで「ダウンロード」として保存可能。「➤ 送信」ボタンで結果画像をそのまま送信タブに渡すことも可能
- **計測ダッシュボード**: `/pipe/stats.html` で P2P / Pipe / Torrent 転送の件数・バイト数、握手時間・チャンクサイズ・フォールバック状況などをリアルタイムに可視化。CSV ダウンロードとオートリフレッシュ付き

詳細な技術仕様は [`docs/pipe-spec.md`](docs/pipe-spec.md) を参照。

### afjk.jp/scenesync/ — 3D Scene Sync ビューア

Unity Editor / Unity Runtime と Web ブラウザ間で 3D シーンをリアルタイム共有するビューア。同じルームコードで参加することで、Unity 上のシーン編集が即座にブラウザに反映される。

- **リアルタイム同期**: Transform（位置・回転・スケール）の変更を 50ms ごとにブロードキャスト
- **glB メッシュ転送**: presence-server の blob store 経由で glB ファイルを共有（最大 50MB、TTL 10分）
- **後参加対応**: 参加時に既存クライアントから `scene-state` を受信してシーン全体を再現
- **編集ロック**: オブジェクト選択時に自動ロック。他クライアントはバウンディングボックス + ラベルで視覚表示
- **参加者一覧**: 接続中のクライアント名・編集中オブジェクトをリアルタイム表示
- **モバイル対応**: iPhone Safari タッチ操作（ダブルタップ選択、スワイプカメラ）対応
- **Unity パッケージ**: `com.afjk.scene-sync`（upm.afjk.jp）で配布。Editor 拡張と Runtime（MonoBehaviour）の両方を提供

URL 例: `https://afjk.jp/scenesync/?room=abc123`

詳細な技術仕様は [`docs/scene-sync-spec.md`](docs/scene-sync-spec.md) を参照。

### pipe.afjk.jp — Piping Server

ブラウザ・curl間でファイルやテキストを転送できる HTTP 中継サービス。パスは任意の文字列でOK。

**テキストの送受信**

```bash
# 送信
echo "hello" | curl -T - https://pipe.afjk.jp/mypath

# 受信
curl https://pipe.afjk.jp/mypath
```

**ファイルの送受信**

```bash
# 送信
curl -T ./file.zip https://pipe.afjk.jp/mypath

# 受信
curl -o file.zip https://pipe.afjk.jp/mypath
```

送信側と受信側が同じパスにアクセスすることでデータが転送される。送信側は受信側が接続するまで待機する。

### Presence Server (WebSocket)

`html/pipe/index.html` から利用するプレゼンス兼シグナリング通知用の WebSocket。クライアントは接続元 IP もしくは `?room=` パラメータで同じルームに入り、端末一覧やハンドオフメッセージ（受信パスの自動共有）をやり取りする。ブラウザ側で `?presence=ws://localhost:8787` のようにクエリを指定すると任意のエンドポイントを強制できる。`wss://afjk.jp/presence` にプロキシされるため、追加ドメインは不要。

ICE サーバー設定（STUN / TURN）は `GET /presence/api/ice-config` で配信される。

### TURN サーバー (coturn)

企業ネットワークや 4G など Symmetric NAT 環境での WebRTC 接続を中継するリレーサーバー。通常起動（`docker compose up -d`）に含まれており、常時起動する。

| ポート | プロトコル | 用途 |
|---|---|---|
| 3478 UDP/TCP | TURN | 標準 TURN |
| 5349 TCP | TURNS (TLS) | ファイアウォール越え |
| 49152–49200 UDP | リレー | WebRTC データ中継 |

TLS 証明書は https-portal が取得した `afjk.jp` の証明書を共有する。

---

## セットアップ

リポジトリをクローンしたら最初に一度実行してください。

```bash
git config core.hooksPath .githooks
```

これにより、コミット時に機密情報（パスワード・トークン・秘密鍵など）が含まれていないか自動チェックされます。
検出された場合はコミットが中断されます。意図的なものであれば `git commit --no-verify` で無視できます。

---

## ローカル開発

### 起動

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

`https-portal` サービスは `production` プロファイルに含めているため、80/443 経由で `afjk.jp` / `upm.afjk.jp` を確認したい場合は以下のコマンドでプロファイルを明示して起動する。

```bash
docker compose --profile production -f docker-compose.yml -f docker-compose.local.yml up -d
```

### アクセス先

| サービス | URL |
|---|---|
| メインサイト (afjk.jp) | http://localhost:8888 |
| Verdaccio (upm.afjk.jp) | http://localhost:4873 |
| Piping Server (pipe.afjk.jp) | http://localhost:8080 |
| Presence Server (afjk.jp/presence) | ws://localhost:8787 |
| MediaMTX WHIP/WHEP | http://localhost:8889 |

### 停止

```bash
docker compose down
```

---

## 本番環境

### 通常起動

```bash
docker compose up -d
```

### 映像配信の設定 (MediaMTX)

`afjk.jp/pipe` の「配信」タブで WebRTC ライブ配信を行うためのサーバー設定。

**`.env` に追記（任意）**

```bash
# MediaMTX が ICE 候補として広告する公開 IP
# NIC に直接グローバル IP が付いている VPS では不要
# NAT 越し（AWS EIP / 自宅ルーター等）の場合は設定する
# MEDIAMTX_EXTERNAL_IP=203.0.113.1

# 公開 IP の確認方法
# curl ifconfig.me
```

**ファイアウォール設定**

| ポート | プロトコル | 用途 |
|---|---|---|
| 8189 | UDP | MediaMTX WebRTC ICE メディア |

設定方法はサーバー環境によって異なる:

```bash
# Ubuntu / Debian (UFW)
sudo ufw allow 8189/udp

# CentOS / AlmaLinux (firewalld)
sudo firewall-cmd --permanent --add-port=8189/udp
sudo firewall-cmd --reload

# iptables
sudo iptables -A INPUT -p udp --dport 8189 -j ACCEPT
```

AWS EC2 の場合は **セキュリティグループ** でインバウンドルールに `UDP 8189` を追加。  
GCP の場合は **VPC ファイアウォールルール** から追加。  
さくらVPS / ConoHa 等は **コントロールパネルのパケットフィルター** または上記 UFW で設定。

**動作確認**

```bash
docker compose logs -f mediamtx   # 起動ログ確認
```

ブラウザで `afjk.jp/pipe` を開き、ルームに入室 → 「配信」タブ → 「配信開始」で映像が届けば完了。

---

### TURN の広告設定

coturn は常時起動しているが、クライアントへの ICE 候補として広告するには `TURN_URL` の設定が必要。未設定の場合は STUN のみで動作する。

**`.env` を作成（任意）**

```bash
# TURN サーバーの URL（設定すると ICE 候補に含まれる）
TURN_URL=turns:afjk.jp:5349

# 認証情報（省略時は pipe/pipe が使われる）
# TURN_USERNAME=pipe
# TURN_CREDENTIAL=pipe

# Docker の NAT 越えで公開 IP を自動検出できない場合のみ設定
# COTURN_EXTERNAL_IP=サーバーの公開IPアドレス
```

**ファイアウォール設定**

| ポート | プロトコル | 用途 |
|---|---|---|
| 3478 | UDP + TCP | TURN |
| 5349 | TCP | TURNS (TLS) |
| 49152–49200 | UDP | リレー |

**確認**

```bash
docker compose logs -f coturn # ログ確認
```

`/presence/api/ice-config` のレスポンスに TURN エントリが含まれていれば有効。
