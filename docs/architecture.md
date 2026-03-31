# 新アーキテクチャ提案 — afjk.jp

## 背景と制約

- 静的 HTML のままでは Twitter / GitHub / 制作ログなどの外部データをリアルタイム反映できない。変更のたびに `html/index.html` を書き換える必要があり、拡張が困難。
- 実験的なウィジェットやセンサー連携などを増やしたいが、現行の Nginx + 静的ファイル構成ではバックエンドを追加する土台がない。
- 既存の Verdaccio と Piping Server も含めて 1 つのホストで docker-compose 運用を続けたい。

## ゴール

1. ポートフォリオのコンテンツを「ビルド時生成 + リアルタイム API」で柔軟に更新できる。
2. Twitter などのアクティビティを安全に取得し、キャッシュした上で低レイテンシに表示。
3. 実験用 API やセンサー連携を増やせる拡張性。
4. 既存サービス (Verdaccio / Piping Server) と同じ compose で扱える。

## 現在の進捗 (2024-04)

- Turborepo + PNPM ワークスペースを導入 (`package.json`, `pnpm-workspace.yaml`, `turbo.json`)。
- Next.js 14 App Router の骨組みを `apps/web` に追加し、API Route と UI プレビューを提供。
- Prisma schema を `packages/database/prisma/schema.prisma` として定義し、今後の Worker / API が利用できるよう整備。

## システム構成

```
apps/
  web/            # Next.js 14 App Router (SSR/RSC)
  worker/         # データ収集・同期ワーカー (Node.js + BullMQ)
packages/
  config/         # 環境変数や共有型定義
  ui/             # React UI ライブラリ (Storybook optional)
infra/
  docker/         # compose ファイル・env サンプル
  migrations/     # Prisma (PostgreSQL) マイグレーション
```

### Frontend (apps/web)

- Next.js 14 + App Router。プロフィールやプロダクト一覧は静的生成 (SSG)。アクティビティ部分は Route Handler API (`/api/activity`, `/api/twitter`) を通じて動的取得。
- Server Components で API から直接フェッチし、Revalidate Tag でバックエンドからの更新通知に追従。
- Edge Runtime で軽量な公開 API へ対応 (例: `/api/badge` でバッジ画像を返す)。
- Analytics/Monitoring 用に Vercel Analytics or Tinybird を接続。

### BFF / API

- Next.js Route Handlers を BFF として活用。PostgreSQL への読み取りや Redis キャッシュを担当。
- 認証が必要な API (例: 管理用ダッシュボード) は Clerk/Supabase Auth などの OAuth 連携を想定。
- 追加の長期タスクが必要になった場合は `apps/api` (Fastify or NestJS) を分離できるよう monorepo 化。

### Activity Ingestion Worker (apps/worker)

- Node.js + BullMQ。Redis をジョブキューとして利用。
- ソース: Twitter/X API v2、GitHub GraphQL、Qiita/Zenn RSS、Mastodon、YouTube、Notion Database、HomeLab センサー (InfluxDB/ESP32 など)。
- 各ソースごとに `fetch -> normalize -> upsert(PostgreSQL)` のパイプラインを持ち、Webhook 受信時は即時ジョブを enqueue。
- 定期実行は `cron` あるいは [BullMQ repeatable jobs](https://docs.bullmq.io/guide/jobs/repeatable) で 5〜15 分間隔を想定。

### データストア

- PostgreSQL (12+) を単一のトランザクション DB として採用。TimescaleDB 拡張を入れると活動ログの集計が容易。
- 主要テーブル案:
  - `profiles` (自己紹介・メタデータ)
  - `projects` (SSG 用コンテンツ。Prisma で seed)
  - `activity_events` (GitHub/ブログ/登壇など)
  - `social_posts` (Twitter, Bluesky, Mastodon 等を共通スキーマで保持)
  - `metrics_snapshots` (稼働状況やセンサー値)
- Prisma ORM で型安全に操作し、Zod で API 出力スキーマを定義。

### キャッシュ & 設定

- Redis (Upstash などマネージド可) で
  - ユーザー向け API のレスポンスキャッシュ
  - BullMQ の job/queue
  - Revalidate タグに紐づくインバリデーション状態
- Secrets は Doppler / 1Password CLI / AWS SSM から取得し、`packages/config` で型付き管理。

### 監視・テレメトリ

- OpenTelemetry Collector をサイドカーとして追加。web/API/worker から traces + metrics を一元化。
- Grafana Cloud や Better Stack へ送信し、Twitter 取得失敗などを PagerDuty / Slack 通知。

## データフロー

1. Worker が外部 API から JSON を取得し、`social_posts` または `activity_events` に upsert。完了時に Redis Pub/Sub で `activity.updated` を publish。
2. Web の Route Handler が Redis キャッシュを確認し、なければ PostgreSQL を参照。レスポンスに `Cache-Control` と Revalidate Tag を付与。
3. フロントの Server Component が API をストリーミングレンダリング。クライアント側は `SWR` で 15〜30 秒毎に軽量ポーリング。
4. Worker が publish したイベントを Next.js の `/api/revalidate` が受け取り、`res.revalidateTag('activity')` で静的セクションも更新。

## ローカル開発 / デプロイ

- 新しい compose 例 (`infra/docker/docker-compose.app.yml`):

```yaml
services:
  web:
    build: ../..
    command: pnpm turbo dev --filter=web
    env_file: ../../.env.local
    ports: ["8888:3000"]
    volumes: ["../..:/repo"]
    depends_on: [postgres, redis]

  worker:
    build: ../..
    command: pnpm turbo dev --filter=worker
    env_file: ../../.env.local
    depends_on: [postgres, redis]

  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: afjk
      POSTGRES_USER: afjk
      POSTGRES_PASSWORD: localdev
    volumes:
      - ./pg_data:/var/lib/postgresql/data

  redis:
    image: redis/redis-stack:latest
    ports: ["6379:6379"]
```

- 本番は
  - Web: Vercel or Fly.io (Next.js SSR)
  - Worker: Fly.io / Railway / AWS Fargate（1 インスタンス常駐）
  - Postgres: Neon/PlanetScale (PG) + read replica
  - Redis: Upstash
  - 既存の `https-portal`, `verdaccio`, `piping-server` はホスト上の docker-compose で継続運用し、Web/Worker は別途デプロイでも可。

## 段階的な移行ステップ

1. Turborepo + PNPM ワークスペースを追加し、Next.js アプリ骨格と Prisma schema を作成。
2. 既存の静的 HTML を Next.js ページに段階的に移植 (まずは `projects`, `about` セクション)。
3. PostgreSQL をセットアップし、種データを `prisma/seed.ts` で投入。
4. Twitter など取得用の Worker を実装し、API キーを Vault で管理。まずは GitHub Activity → 次に Twitter。
5. 新 UI で `ActivityFeed` を SSR、段階的に SSG セクションを置き換え。
6. 旧 `www-service (nginx)` を停止し、Next.js SSR を HTTPS Portal 経由で配信。
7. 観測・アラートを Grafana に接続、動作を確認後にリリース。

## 今後追加しやすい機能例

- `/status` で家庭ラボのセンサー値を streaming 表示 (Server Sent Events)。
- `/api/now` で現在着手中のタスクを返し、Notion → Worker → Web で同期。
- Web Components 化したウィジェットを他サイトへ埋め込めるよう `/embed/*` で SSR + hydration。
