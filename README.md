# afjk.jp
afjk.jp home server & dynamic portfolio monorepo.

## Monorepo Overview

| パス | 説明 |
| --- | --- |
| `apps/web` | Next.js 14 + App Router。新しいポートフォリオ UI、API Routes、Server Components。 |
| `packages/database` | Prisma schema と DB ツール。`pnpm prisma:generate` でクライアント生成。 |
| `html` | 旧来の静的 HTML。必要に応じて `www-service` でホスト。 |
| `verdaccio`, `https-portal-certs`, `docker-compose*.yml` | 既存サービス (UPM Registry / HTTPS Portal / Piping Server) の定義。 |
| `docs` | アーキテクチャドキュメント。 |

### Getting Started (Next.js app)

```bash
pnpm install
cp .env.example .env           # DATABASE_URL を自身の環境に合わせて修正
# Twitter埋め込みは Nitter RSS + oEmbed を使用 (API不要)。必要に応じて NITTER_HOST を変更
pnpm prisma:generate
pnpm dev                       # http://localhost:3000 で新UI確認
```

### Prisma

```bash
# schema の編集後にマイグレーション
pnpm --filter @afjk/database migrate:dev

# スキーマを DB に適用 (local)
pnpm --filter @afjk/database db:push

# Studio
pnpm --filter @afjk/database studio
```

## サービス一覧

### afjk.jp / www.afjk.jp — メインサイト

- 新UI: `apps/web` (Next.js)。BullMQ Worker との連携で動的に更新。
- 旧UI: `html/index.html`。Nginx (`www-service`) での静的配信も継続可能。

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

---

## ローカル開発

### 新UI (Next.js)

`pnpm dev` (上記参照) で `apps/web` を起動。BullMQ/Worker は今後追加予定。

### 既存 docker-compose サービス

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

### 停止

```bash
docker compose down
```
