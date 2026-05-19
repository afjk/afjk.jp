# Scene Sync 負荷テスト

このドキュメントは、Scene Sync の presence server / WebSocket 接続負荷を手動で確認するための手順です。

この負荷テストは **CI では実行しません**。
リリース前や不安な変更の後に、必要な時だけ手元から実行します。

## テスト対象

- WebSocket connection pool の安定性
- 複数接続時のメモリ使用量
- 接続タイムアウトや予期しないクローズ
- room_full の拒否動作（ルーム容量制限の確認）

## 実行方法

### 前提条件

```bash
# presence-server のディレクトリ
cd apps/presence-server

# 必要な依存関係をインストール
npm install
```

### 基本的な20接続テスト

```bash
node ../../tools/scenesync/load-test-presence.mjs \
  --url wss://staging.afjk.jp/presence \
  --clients 20 \
  --duration 60
```

出力例:

```
Generated room: load-20260519-203012-k8x4p2
Browser URL:
https://staging.afjk.jp/scenesync/?room=load-20260519-203012-k8x4p2

Scene Sync presence load test

endpoint: wss://staging.afjk.jp/presence
room: load-20260519-203012-k8x4p2
clients requested: 20
clients connected: 20
connect failures: 0
unexpected closes: 0
messages received total: 380
average messages/client: 19
connect latency avg: 42ms
connect latency max: 180ms
duration: 60s

Result: OK
```

### 50接続での負荷テスト

より大きな負荷を確認する場合：

```bash
node ../../tools/scenesync/load-test-presence.mjs \
  --url wss://staging.afjk.jp/presence \
  --clients 50 \
  --duration 120
```

### ローカル環境でのテスト

ローカルの presence server に対して実行:

```bash
# 別のターミナルで server を起動
npm start

# テストを実行
node ../../tools/scenesync/load-test-presence.mjs \
  --url ws://localhost:8787/presence \
  --clients 20 \
  --duration 60
```

## CLI オプション

```
--url             (必須) WebSocket endpoint のベース URL
                  例: wss://staging.afjk.jp/presence
                  例: ws://localhost:8787/presence

--room            ルーム ID。省略した場合は自動生成
                  例: load-20260519-203012-k8x4p2
                  生成形式: load-YYYYMMDD-HHmmss-random6

--clients         シミュレートするクライアント数 (デフォルト: 20)
                  例: --clients 50

--duration        テスト継続時間（秒） (デフォルト: 60)
                  例: --duration 120

--ramp-ms         クライアント接続間隔（ミリ秒） (デフォルト: 100)
                  接続を徐々に増やしたい場合に調整
                  例: --ramp-ms 50

--send-interval   broadcast テスト時のメッセージ送信間隔（ミリ秒） (デフォルト: 5000)
                  --broadcast 有効時のみ有効
                  例: --send-interval 3000

--broadcast       broadcast / mutation テストを有効化
                  (デフォルト: 無効)
                  scene-add/remove を定期的に送信
                  警告: このオプションはルームを変更するため、
                        自動生成されるテスト用ルームを使用
                  例: --broadcast

--verbose         クライアント毎の詳細出力
                  (デフォルト: 無効)
                  例: --verbose

--help            このヘルプを表示
```

## ルーム名の指定

### 自動生成（推奨）

ルーム名を指定しない場合、以下の形式で自動生成されます:

```
load-YYYYMMDD-HHmmss-<random6>
```

例:

```bash
node ../../tools/scenesync/load-test-presence.mjs \
  --url wss://staging.afjk.jp/presence
```

生成されたルーム名が出力されます：

```
Generated room: load-20260519-203012-k8x4p2
```

### カスタムルーム名の指定

```bash
node ../../tools/scenesync/load-test-presence.mjs \
  --url wss://staging.afjk.jp/presence \
  --room my-load-test-20260519
```

### Generic ルーム名は避ける

以下のような generic な名前を使用すると、警告が表示されます：

```
test, demo, room, default, safe-test, load-test, mcp-test
```

```bash
node ../../tools/scenesync/load-test-presence.mjs \
  --url wss://staging.afjk.jp/presence \
  --room test
```

出力:

```
Warning: room name "test" is generic and may collide with real users.
Use a unique room name for release/load testing.
```

実ユーザーや他の検証と衝突する可能性があるため、
自動生成されるルーム名を使用することを推奨します。

## 本番環境での実行

本番環境で実行する場合は、短時間・少数接続から始めます。

### 20接続のみ確認

```bash
node ../../tools/scenesync/load-test-presence.mjs \
  --url wss://afjk.jp/presence \
  --clients 20 \
  --duration 60
```

### 本番での注意点

- 業務時間外に実行
- 小規模な接続数から開始
- 接続終了後、ルームが正常に削除されたことを確認
- CPU / メモリ使用量を監視

## ConoHa でのログ確認

### WebSocket 接続情報の確認

```bash
sudo grep '"event":"ws_connection"' /var/log/scene-sync/scene-sync-$(date +%F).ndjson | grep "load-"
```

### Connection Summary の確認

```bash
sudo grep '"event":"ws_connection_summary"' /var/log/scene-sync/scene-sync-$(date +%F).ndjson | tail -20
```

### Room Full 拒否の確認

```bash
sudo grep '"event":"ws_room_full_reject"' /var/log/scene-sync/scene-sync-$(date +%F).ndjson | tail -20
```

### Heartbeat Terminate の確認

```bash
sudo grep '"event":"ws_heartbeat_terminate"' /var/log/scene-sync/scene-sync-$(date +%F).ndjson | tail -20
```

### 全イベント検索

```bash
sudo grep '"room":"load-' /var/log/scene-sync/scene-sync-$(date +%F).ndjson | jq '.event' | sort | uniq -c
```

## 合格目安

### 20接続 / 60秒

✅ 合格基準:

- 全クライアントが正常に接続できる
- `connect failures: 0`
- `unexpected closes: 0`
- `room_full rejections: 0`
- presence server がクラッシュしない
- CPU / メモリが増え続けない

### 50接続 / 120秒

✅ 合格基準:

- サーバーが稼働し続ける
- 急激な close / heartbeat terminate がない
- 接続終了後に connection summary が出力される
- メモリリークの兆候がない

## トラブルシューティング

### connect failures が多い場合

接続テストを実施:

```bash
node ../../tools/scenesync/load-test-presence.mjs \
  --url wss://staging.afjk.jp/presence \
  --clients 1 \
  --duration 10 \
  --verbose
```

確認事項:

- ネットワーク接続の確認
- WebSocket エンドポイントの接続性確認
- サーバーのポート制限確認
- ファイアウォール設定確認
- DNS 解決確認

### unexpected closes が発生する場合

- テスト中の server ログを確認
- CPU / メモリが枯渇していないか確認
- コネクション数の上限に達していないか確認
- 接続タイムアウト設定の確認

### latency が高い場合

- ネットワーク遅延の確認
- サーバーの負荷状況確認
- --ramp-ms を大きくして接続を緩やかに

```bash
node ../../tools/scenesync/load-test-presence.mjs \
  --url wss://staging.afjk.jp/presence \
  --clients 20 \
  --duration 60 \
  --ramp-ms 200
```

## Broadcast テスト

`--broadcast` オプションを使用すると、定期的に scene mutation を送信します。

```bash
node ../../tools/scenesync/load-test-presence.mjs \
  --url wss://staging.afjk.jp/presence \
  --clients 20 \
  --duration 60 \
  --broadcast \
  --send-interval 3000
```

このオプションを使用する場合:

- 自動生成されるテスト用ルームを使用
- ルーム内にテスト用オブジェクトが一時的に作成される
- テスト終了時に自動クリーンアップされる

⚠️ **注意**: 実ユーザーのルームで --broadcast を使用しないでください。
ルームの内容が変更されます。

## npm script として実行する

`package.json` に以下が設定されている場合:

```json
{
  "scripts": {
    "scenesync:load-test": "node ../../tools/scenesync/load-test-presence.mjs"
  }
}
```

以下のように実行できます:

```bash
cd apps/presence-server
npm run scenesync:load-test -- --url wss://staging.afjk.jp/presence --clients 20 --duration 60
```

## リリースチェックリスト

新規リリース前に確認:

- [ ] 20接続 / 60秒テストが成功 (staging)
- [ ] 50接続 / 120秒テストが成功 (staging)
- [ ] ローカルテストが成功
- [ ] ConoHa ログに異常がない
- [ ] 本番環境で 20接続テストを実施
- [ ] CPU / メモリ使用量が正常範囲

## 参考資料

- Scene Sync spec: `docs/scene-sync-spec.md`
- API protocol: `docs/scene-sync-api-protocol.md`
- Presence server: `apps/presence-server/src/server.mjs`
