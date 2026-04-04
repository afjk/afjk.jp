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

### pipe.afjk.jp — Piping Server

ブラウザ・curl間でファイルやテキストを転送できるサービス。パスは任意の文字列でOK。

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

### presence.afjk.jp — Presence Server (WebSocket)

`html/pipe/index.html` から利用するプレゼンス兼シグナリング通知用の WebSocket。クライアントは接続元 IP もしくは `?room=` パラメータで同じルームに入り、端末一覧やハンドオフメッセージ（受信パスの自動共有）をやり取りする。ブラウザ側で `?presence=ws://localhost:8787` のようにクエリを指定すると任意のエンドポイントを強制できる。DNS で `presence.afjk.jp` をサーバーの IP に向けておくと、`https-portal` が自動で証明書を発行してくれる。

---

## ローカル開発

### 起動

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

### アクセス先

| サービス | URL |
|---|---|
| メインサイト (afjk.jp) | http://localhost:8888 |
| Verdaccio (upm.afjk.jp) | http://localhost:4873 |
| Piping Server (pipe.afjk.jp) | http://localhost:8080 |
| Presence Server (presence.afjk.jp) | ws://localhost:8787 |

### 停止

```bash
docker compose down
```
