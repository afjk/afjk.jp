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

ブラウザ完結型のファイル・テキスト転送ページ（`html/pipe/index.html`）。

- **近くのデバイス**: 同一ネットワーク内のデバイスが自動検出され、タップするだけで転送開始
- **ルームコード**: 6文字コードを生成して URL 共有すれば、リモートの相手とも接続可能。参加/退場時に URL の `?room=` を自動更新するためリロードで再入場・退場状態を維持
- **全員に送信**: ルーム内の全デバイスへファイル・テキストを並列一斉送信
- **送信元表示**: presence 経由で届いたファイル・テキストに送信元端末名を表示。テキスト受信履歴にも送信元を記録
- **複数ファイル一括送信**: ドロップゾーンに複数ファイルをドロップして一括転送
- **テキスト送受信**: テキストや URL を直接送受信。受信履歴を localStorage に保存
- **転送モード**: WebRTC P2P を優先試行し、失敗時は piping-server 中継にフォールバック
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

詳細な技術仕様は [`docs/pipe-spec.md`](docs/pipe-spec.md) を参照。

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

### TURN サーバー (coturn) — オプション

企業ネットワークや 4G など Symmetric NAT 環境での WebRTC 接続を中継するリレーサーバー。通常の起動には含まれないため、`--profile turn` で明示的に有効化する。

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

### TURN サーバーの有効化

Symmetric NAT 環境（4G・企業ネットワーク）でも WebRTC が繋がるようになる。
`.env` に認証情報を設定するだけで有効になり、未設定でも他のサービスには影響しない。

**1. `.env` を作成（省略可）**

デフォルトでは `pipe` / `pipe` で動作する。変更したい場合のみ `.env` を作成する。

```bash
# 変更したい場合のみ設定（省略時はデフォルト値 pipe/pipe が使われる）
TURN_USERNAME=任意のユーザー名
TURN_CREDENTIAL=任意のパスワード

# Docker の NAT 越えで公開 IP を自動検出できない場合のみ設定
# COTURN_EXTERNAL_IP=サーバーの公開IPアドレス
```

**2. ファイアウォール設定**

| ポート | プロトコル |
|---|---|
| 3478 | UDP + TCP |
| 5349 | TCP |
| 49152–49200 | UDP |

**3. 起動・確認**

```bash
docker compose up -d          # coturn も含めて起動
docker compose logs -f coturn # ログ確認
```

`/presence/api/ice-config` のレスポンスに TURN エントリが含まれていれば有効。

> **Note:** `.env` に認証情報が未設定の場合、coturn は即座に正常終了し TURN なしで動作する。
