# afjk.jp
afjk.jp home server

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

### 停止

```bash
docker compose down
```
