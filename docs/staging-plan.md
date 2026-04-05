# ステージング環境 設計計画

## 目的

本番環境（afjk.jp）へのデプロイ前に変更を検証するためのステージング環境を構築する。

---

## デプロイフロー

```
main にマージ
    └─► staging.afjk.jp に自動デプロイ（動作確認）
            └─► GitHub Release 作成
                    └─► afjk.jp（本番）にデプロイ
```

---

## アーキテクチャ

### 基本方針

- サーバー: 本番と同一 VPS（163.44.117.15）
- コードディレクトリ: 本番と同一（`~/github/afjk.jp/`）
- Docker: 本番の https-portal と Docker ネットワークを共有
- staging 専用コンテナは `www-service-staging` のみ

### コンテナ構成

```
[https-portal]  ← ポート 80/443 を管理・SSL 終端
    ├── afjk.jp          → www-service（本番）
    ├── staging.afjk.jp  → www-service-staging（ステージング）※1
    ├── pipe.afjk.jp     → piping-server（共有）
    └── upm.afjk.jp      → verdaccio（共有）

[presence-server]  ← 本番・ステージング共用
```

> ※1 piping-server / presence-server はステージングと本番で共用する。
> ファイル転送・プレゼンス機能のテストは本番サービスに接続して行う。

### Docker ネットワーク

本番スタックのデフォルトネットワーク（`afjkjp_default`）に staging コンテナが参加する。

```
本番スタック (project: afjkjp)
  └─ ネットワーク: afjkjp_default
        ├── https-portal
        ├── www-service
        ├── presence-server
        └── www-service-staging  ← staging コンテナが参加
```

---

## 追加・変更ファイル

### 1. `docker-compose.staging.yml`（新規）

staging 用の www-service のみを定義する。本番ネットワークに external で参加する。

```yaml
services:
  www-service-staging:
    image: nginx:latest
    container_name: www-service-staging
    volumes:
      - ./html:/usr/share/nginx/html
      - ./nginx/default.conf:/etc/nginx/conf.d/default.conf:ro
    networks:
      - proxy
    restart: always

networks:
  proxy:
    name: afjkjp_default
    external: true
```

### 2. `.github/workflows/deploy-staging.yml`（新規）

`main` への push をトリガーに staging へ自動デプロイする。

```yaml
name: Deploy to Staging

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Add host to known_hosts
        run: |
          mkdir -p ~/.ssh
          ssh-keyscan -H ${{ secrets.SERVER_HOST }} >> ~/.ssh/known_hosts

      - name: SSH and deploy to staging
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: ${{ secrets.SERVER_USER }}
          password: ${{ secrets.SERVER_PASSWORD }}
          timeout: 60s
          script: |
            cd ~/github/afjk.jp
            git pull
            docker compose -p afjkjp-staging -f docker-compose.staging.yml up -d
```

### 3. `docker-compose.yml`（変更）

DOMAINS に `staging.afjk.jp` を追加する。
⚠️ **この変更は DNS 設定完了後に別 PR でデプロイすること**（後述）。

```diff
  DOMAINS: |
    afjk.jp -> http://www-service:80,
    www.afjk.jp -> http://www-service:80,
    upm.afjk.jp -> http://verdaccio:4873,
-   pipe.afjk.jp -> http://piping-server:8080
+   pipe.afjk.jp -> http://piping-server:8080,
+   staging.afjk.jp -> http://www-service-staging:80
```

---

## デプロイ手順

### ステップ 1: PR-A をマージ（DNS 設定不要・本番影響なし）

以下のみを含む PR をマージ・リリースする。

- `docker-compose.staging.yml` 追加
- `.github/workflows/deploy-staging.yml` 追加

この時点で `main` push のたびに staging コンテナが起動するが、
DOMAINS に追加されていないため外部からはアクセス不可。

### ステップ 2: DNS レコードを設定

ドメインのDNS管理画面で以下を追加する。

| ホスト名 | タイプ | 値              |
|----------|--------|-----------------|
| staging  | A      | 163.44.117.15   |

DNS の伝播を確認してから次のステップに進む。

```bash
dig staging.afjk.jp +short  # 163.44.117.15 が返ることを確認
```

### ステップ 3: PR-B をマージ（staging.afjk.jp を DOMAINS に追加）

- `docker-compose.yml` の DOMAINS に `staging.afjk.jp` を追加

リリースすると https-portal が再起動し、Let's Encrypt が
`staging.afjk.jp` の証明書を自動発行する。
DNS が正しく設定されていれば本番への影響は数秒程度。

> **本番サーバーでの再起動コマンド**
> ローカル開発用の `docker-compose.local.yml` を本番に混ぜると不要なポートが開放されるため、
> 本番サーバーでは以下のコマンドのみを実行する。
>
> ```bash
> docker compose up -d https-portal
> ```

---

## リスクと対策

| リスク | 対策 |
|--------|------|
| DNS 未設定で DOMAINS 変更 → https-portal クラッシュ | ステップ 2 の DNS 確認を必須とし、PR-B はステップ 2 完了後にマージ |
| staging と本番が同じディレクトリを参照 | `git pull` のタイミングがずれるため問題なし。本番デプロイは Release 時のみ |
| ネットワーク名 `afjkjp_default` が変わった場合 | `docker network ls` で確認してから `docker-compose.staging.yml` を更新 |
