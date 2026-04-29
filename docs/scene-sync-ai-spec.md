# Scene Sync AI 連携・履歴管理 仕様

## 目的

Scene Sync に Undo/Redo 履歴管理と AI からの代理操作機構を追加する。
REST API 経由で GPTs などの外部 AI が、ユーザーの代理として 3D シーンを操作できるようにする。

## 核心原則

**人の継続性は AI エージェント側が保持する。**

サーバーはステートレスを維持し、AI が `linkToken` によってユーザーを代理する。
ブラウザ・タブ・WSS 接続は短命なリソースとして扱い、人（userId）を識別する役割を AI に委ねる。

## 用語

- **peer**: WSS 接続単位。WS 切断で消失する一時的な存在。`peer-{uuid}` 形式。
- **user**: ブラウザ単位の永続 ID。`scenesync.userId` として localStorage に保存。`usr-{uuid}` 形式。
  タブ・リロード・ブラウザ再起動を跨いで同一性を保つ。
- **link**: 特定の userId と特定の room を結ぶ AI の代理権限。`linkToken` で表現。
- **linkToken**: HMAC 署名付きの代理権限トークン。Bearer として broadcast に添付。
- **onBehalfOf**: broadcast の `from` フィールドに付与される代理表明。値は userId。

## アーキテクチャ概要

```
GPT (or any AI)
   │ HTTPS + Authorization: Bearer <linkToken>
   ▼
afjk.jp presence-server
   ├ /api/link/initiate     (ペアリング開始)
   ├ /api/link/redeem       (コード→token 交換)
   ├ /api/link/revoke       (失効)
   ├ /api/room/{roomId}/broadcast   (linkToken 検証 + onBehalfOf 自動付与)
   └ /api/room/{roomId}/scene       (シーン取得、既存)
   │
   │ WSS broadcast
   ▼
ルーム参加者 (Web / Unity / Godot クライアント)
   │
   └ HistoryManager (各クライアントが own/proxy 操作のみ履歴化)
```

## linkToken 設計

### 形式

HMAC-SHA256 による署名付きトークン。サーバー側にセッション保存不要（ステートレス）。

```
linkToken = base64url(payload) + "." + base64url(hmac_sha256(payload, SECRET))

payload = {
  linkId: "lnk-{uuid}",
  userId: "usr-{uuid}",
  roomId: "abc123",
  exp: 1735689600000,
  iat: 1733097600000
}
```

### TTL（初期値）

- 30日（`exp = iat + 30 * 24 * 3600 * 1000`）
- 自動延長は行わない（Phase 5 以降で検討）
- 失効条件:
  - 期限到来による自動失効
  - `/api/link/revoke` 呼び出しによる明示的失効
  - サーバー側失効リスト（Phase 3 初期はメモリ保持、token 期限まで）

### 短命にしない理由

ブラウザではなく GPT の会話コンテキストが人の継続性を保持するため、
都度ペアリングは UX を損なう。AI 側のセッション切れ時にのみ再ペアリングが必要。

## ペアリングコード

- 6桁数字（例: `482915`）
- TTL 5分
- 1回限り使用（redeem 後は破棄）
- サーバー内部のメモリマップで管理: `code → { roomId, userId, expiresAt }`

## REST API

### POST /api/link/initiate

ブラウザがペアリングコード発行を要求する。

リクエスト:

```json
{
  "roomId": "abc123",
  "userId": "usr-xxxx-xxxx"
}
```

レスポンス（200）:

```json
{
  "code": "482915",
  "expiresAt": 1733097900000
}
```

エラー: 400（パラメータ不正）

### POST /api/link/redeem

AI がペアリングコードを linkToken に交換する。

リクエスト:

```json
{ "code": "482915" }
```

レスポンス（200）:

```json
{
  "linkToken": "eyJsaW5rSWQ...xxxx.yyyy",
  "linkId": "lnk-xxxx-xxxx",
  "userId": "usr-xxxx-xxxx",
  "roomId": "abc123",
  "expiresAt": 1735689600000
}
```

エラー: 400（コード不正）、404（コード未発行 or 期限切れ）、410（既に使用済み）

### POST /api/link/revoke

リンクを明示的に失効する。

リクエスト（どちらか）:

```json
{ "linkId": "lnk-xxxx-xxxx" }
```

```
Authorization: Bearer <linkToken>
```

レスポンス（200）:

```json
{ "ok": true }
```

副作用: ルーム内に `ai-link-revoked` を broadcast。

### POST /api/room/{roomId}/broadcast（拡張）

既存エンドポイントに linkToken 検証を追加。

リクエストヘッダ:

```
Authorization: Bearer <linkToken>
```

サーバー側処理:

1. linkToken の HMAC 検証
2. payload.roomId と URL の roomId が一致することを確認
3. payload.exp が未来であることを確認
4. 失効リストに含まれていないことを確認
5. broadcast payload に `onBehalfOf: payload.userId` を自動付与

エラー: 401（token 不正・期限切れ・失効済み）、403（roomId 不一致）

レスポンス（200）に `userPresent` を追加:

```json
{
  "ok": true,
  "room": "abc123",
  "peers": 3,
  "userPresent": true
}
```

`userPresent` は対象 userId の peer がルームに 1 つ以上接続中なら true。
GPT が「ユーザーが今いるか」を判断するために利用。

### GET /api/room/{roomId}/scene

既存仕様のまま。linkToken 認証は任意（不要）。

## 新規 Handoff Kind

### ai-link-established

リンク確立時にルーム全体に通知。

```json
{
  "kind": "ai-link-established",
  "linkId": "lnk-xxxx-xxxx",
  "userId": "usr-xxxx-xxxx",
  "roomId": "abc123",
  "expiresAt": 1735689600000
}
```

### ai-link-revoked

リンク失効時にルーム全体に通知。

```json
{
  "kind": "ai-link-revoked",
  "linkId": "lnk-xxxx-xxxx",
  "reason": "user-revoked" | "expired" | "ai-revoked"
}
```

### scene-batch

複数の操作を 1 つのトランザクションとしてまとめる。Undo/Redo の最小単位として扱う。

```json
{
  "kind": "scene-batch",
  "batchId": "batch-xxxx",
  "actions": [
    { "kind": "scene-add", "objectId": "...", ... },
    { "kind": "scene-delta", "objectId": "...", ... }
  ]
}
```

### ai-command（Web 専用）

ブラウザ固有の操作を AI が依頼する場合に使用。

```json
{
  "kind": "ai-command",
  "requestId": "req-xxxx",
  "action": "uploadGlbFromUrl" | "screenshot" | "getCameraPose" | "focusObject" | "undo" | "redo" | "getHistory",
  "params": { ... },
  "targetPeerId": "peer-xxxx"
}
```

`targetPeerId` 未指定時、サーバーが対象 userId の最新接続 peer を補完する。

現在の実装では `ai-command` は通常 broadcast と異なり、対象 peer へ handoff された後、
ブラウザが `ai-result` を返し、その結果が HTTP レスポンスにも含まれる。

### ai-result

ブラウザが `ai-command` の実行結果を返す。

```json
{
  "kind": "ai-result",
  "requestId": "req-xxxx",
  "ok": true,
  "...": "action-specific result"
}
```

実装済み action:

- `getCameraPose`
- `focusObject`
- `undo`
- `redo`
- `getHistory`
- `screenshot`
- `uploadGlbFromUrl`

## curl 運用例

staging での手動確認は以下で行える。

前提:

- Scene Sync ブラウザで `AIにリンク` を押し、6桁コードを表示する
- ブラウザが参加している room は `redeem` レスポンスの `roomId` を正とする
- staging URL は `https://staging.afjk.jp/presence/api`

### 1. code を linkToken に交換

```bash
curl -sS -X POST https://staging.afjk.jp/presence/api/link/redeem \
  -H 'Content-Type: application/json' \
  --data '{"code":"482915"}'
```

成功すると `linkToken`, `linkId`, `userId`, `roomId`, `expiresAt` が返る。
この時点でブラウザ側には `ai-link-established` が broadcast され、UI は `AIリンク中` になる。

### 2. AI 代理で scene-add を送る

実装は次の 2 形式を受け付ける:

- 直接 payload を POST
- `{ "payload": ... }` で包んで POST

直接 POST の例:

```bash
curl -sS -X POST https://staging.afjk.jp/presence/api/room/abc123/broadcast \
  -H "Authorization: Bearer <linkToken>" \
  -H 'Content-Type: application/json' \
  --data '{
    "kind": "scene-add",
    "objectId": "ai-test-1",
    "name": "AI Test",
    "position": [1, 0.5, 0],
    "rotation": [0, 0, 0, 1],
    "scale": [1, 1, 1],
    "asset": {
      "type": "primitive",
      "primitive": "box",
      "color": "#ff8800"
    }
  }'
```

wrapped payload の例:

```bash
curl -sS -X POST https://staging.afjk.jp/presence/api/room/abc123/broadcast \
  -H "Authorization: Bearer <linkToken>" \
  -H 'Content-Type: application/json' \
  --data '{
    "payload": {
      "kind": "scene-add",
      "objectId": "ai-test-1",
      "name": "AI Test",
      "position": [1, 0.5, 0],
      "rotation": [0, 0, 0, 1],
      "scale": [1, 1, 1],
      "asset": {
        "type": "primitive",
        "primitive": "box",
        "color": "#ff8800"
      }
    }
  }'
```

レスポンス例:

```json
{
  "ok": true,
  "room": "abc123",
  "peers": 2,
  "userPresent": true
}
```

### 2.5. ai-command を送る

例: `getCameraPose`

```bash
curl -sS -X POST https://staging.afjk.jp/presence/api/room/abc123/broadcast \
  -H "Authorization: Bearer <linkToken>" \
  -H 'Content-Type: application/json' \
  --data '{
    "kind": "ai-command",
    "requestId": "req-camera-1",
    "action": "getCameraPose",
    "params": {}
  }'
```

レスポンス例:

```json
{
  "ok": true,
  "room": "abc123",
  "peers": 1,
  "userPresent": true,
  "targetPeerId": "peer-xxxx",
  "result": {
    "kind": "ai-result",
    "requestId": "req-camera-1",
    "ok": true,
    "pose": {
      "position": [5, 5, 5],
      "quaternion": [0, 0, 0, 1]
    }
  }
}
```

例: `getHistory`

```bash
curl -sS -X POST https://staging.afjk.jp/presence/api/room/abc123/broadcast \
  -H "Authorization: Bearer <linkToken>" \
  -H 'Content-Type: application/json' \
  --data '{
    "kind": "ai-command",
    "requestId": "req-history-1",
    "action": "getHistory",
    "params": { "count": 5 }
  }'
```

`ai-command` のレスポンスは action ごとに `result` の形が変わる。

### 3. リンク解除

Bearer 付きの例:

```bash
curl -sS -X POST https://staging.afjk.jp/presence/api/link/revoke \
  -H "Authorization: Bearer <linkToken>" \
  -H 'Content-Type: application/json' \
  --data '{"linkId":"lnk-xxxx-xxxx"}'
```

`linkId` のみでも解除できる:

```bash
curl -sS -X POST https://staging.afjk.jp/presence/api/link/revoke \
  -H 'Content-Type: application/json' \
  --data '{"linkId":"lnk-xxxx-xxxx"}'
```

解除時はブラウザ側に `ai-link-revoked` が broadcast される。

## 履歴管理

### データ構造

```javascript
class HistoryManager {
  undoStack: HistoryEntry[]   // max 100
  redoStack: HistoryEntry[]   // max 100
  onChange: (state) => void   // UI 同期コールバック
}

HistoryEntry = {
  id: "hist-{timestamp}-{rand}",
  timestamp: 1733097600000,
  summary: "Added Cube",      // 表示用
  forward: BroadcastMessage,  // やり直し時に送信
  backward: BroadcastMessage  // 取り消し時に送信
}
```

### 履歴記録条件

クライアントは以下の broadcast のみ自身の undoStack に push する:

```
msg.from.id === myPeerId   ||   msg.from.onBehalfOf === myUserId
```

これにより:

- 自分の操作は履歴に積まれる
- 自分の代理 AI による操作も履歴に積まれる（ユーザーが自分で Undo できる）
- 他人の操作は履歴に積まれない（他人の Undo に巻き込まれない）

### 操作と逆操作の対応

| forward | backward |
|---------|----------|
| scene-add | scene-remove |
| scene-remove | scene-add（元データを backward に保存） |
| scene-delta | scene-delta（変更前 transform を backward に保存） |
| scene-env | scene-env（変更前 envId を backward に保存） |
| scene-batch | scene-batch（actions を逆順かつ各要素を逆操作化） |

### redoStack のクリア

新規操作が push されたとき redoStack をクリア。
他者の broadcast 受信ではクリアしない（自分の redo は他者の操作で無効化されない）。

### 履歴サイズ制限

`MAX_HISTORY = 100`。超過時は最古エントリを shift で破棄。

### 削除済みオブジェクトの Undo 復元

blob store の TTL は 10 分。10 分経過後の `scene-add` Undo（= 削除の取り消し）は
mesh の再取得に失敗する可能性がある。

Phase 1 の方針: ユーザーに Toast で通知するのみ（オブジェクトは復元失敗）。
将来的にローカルキャッシュ機構の検討余地あり。

## クライアント実装要件

### Web クライアント

1. `scenesync.userId` を localStorage で永続管理
2. AI リンク UI:
   - 「🔗 AIにリンク」ボタンを設定パネルに配置
   - ボタン押下で `/api/link/initiate` 呼び出し
   - 6桁コードを画面に表示（5分カウントダウン付き）
   - リンク中は「✓ AIリンク中」表示と「解除」ボタン
3. HistoryManager の組み込み（実装済み）
4. キーバインド: Ctrl+Z / Cmd+Z / Ctrl+Y / Cmd+Shift+Z（実装済み）
5. モバイルツールバー: ↶ / ↷ ボタン（実装済み）
6. `ai-command` ハンドラ:
   - `uploadGlbFromUrl`: 指定 URL から glB を fetch → blob store に POST → scene-add broadcast
   - `screenshot`: canvas から JPEG エンコード → blob store に POST → URL 返却
   - `getCameraPose`: 現在のカメラ position/quaternion を返却
   - `focusObject`: 指定 objectId にカメラを向ける
   - `undo` / `redo`: HistoryManager 経由で実行
   - `getHistory`: 直近 N エントリの summary 配列を返却

### Unity / Godot クライアント

- `scenesync.userId` 相当の永続管理（PlayerPrefs / config file）
- HistoryManager 相当の実装
- AI リンク UI（簡易でよい）
- `ai-command` 受信は省略可能（Web 専用機能のため）

## 実装フェーズ

### Phase 1: ローカル Undo/Redo（実装済み）

- HistoryManager クラス実装
- scene-add / scene-remove / scene-delta / scene-env の履歴記録
- キーバインドとモバイル UI
- userId 永続化

### Phase 2: scene-batch 対応（実装済み）

- HistoryManager.createBatchEntry に forward/backward 引数
- scene-batch の forward/backward 実行ロジック

### Phase 3: ペアリング & onBehalfOf

- presence-server に `/api/link/*` エンドポイント追加
- broadcast の Bearer 検証と onBehalfOf 自動付与
- peer-info に userId を含める
- 受信側で `from.onBehalfOf === myUserId` を履歴条件に追加
- Web クライアントの AI リンク UI

### Phase 4: GPTs 統合（進行中）

- OpenAPI 3.x スキーマ作成
  - 既存 Bearer API: `docs/scene-sync-openapi.yaml`
  - GPT wrapper API: `docs/scene-sync-gpt-openapi.yaml`
- GPT Instructions 作成
  - 詳細版: `docs/scene-sync-gpt-instructions.md`
  - 短縮版: `docs/scene-sync-gpt-instructions-short.md`
- GPT 用ラッパー API `/api/gpt/*`
  - `POST /api/gpt/link/redeem`
  - `POST /api/gpt/link/revoke`
  - `POST /api/gpt/room/{roomId}/scene`
  - `POST /api/gpt/room/{roomId}/broadcast`
  - `POST /api/gpt/room/{roomId}/ai-command`
- `sessionId` は `linkToken` を AES-256-GCM で暗号化した opaque token
  - 形式: `v1.<base64url(iv|ciphertext|tag)>`
  - TTL: `min(linkToken.exp, now + 24h)`
  - 復号後は既存 `verifyLinkToken()` を通すため revoke / expiry が連動
- scene 取得は POST に統一し、query string へ token を露出しない
- 既存 `/api/link/*` `/api/room/*/broadcast` は変更なし

### Phase 5: ai-command 拡充

- uploadGlbFromUrl, screenshot, getCameraPose, focusObject 等の実装
- 結果取得用エンドポイント or ai-result kind の検討

### Phase 6: Unity / Godot 移植

- 各クライアントへ HistoryManager と userId 永続化を移植
- ai-command は不要（Web 専用）

## 合意済み原則

- 履歴は自分と自分が代理された AI のみ。他人の操作は積まない。
- ピア切断で履歴消失（リロード復元は将来検討）。
- リンクはユーザー主導のコード発行方式。
- linkToken は長期（30日）、AI 側がユーザー継続性を保持。
- 部屋一覧 API は提供しない（プライバシー優先）。
- マジックリンクや QR ペアリングは Phase 5 以降の検討事項。

## 未決定・保留項目

- linkToken の HMAC 署名検証実装詳細（SECRET 管理、ローテーション）
- 削除オブジェクトの Undo 復元（blob TTL 超過時の挙動）
- ブラウザリロード時の履歴復元（localStorage 一時保存）
- 公開 GPTs 化に向けたレートリミットと認可強化
- room 一覧 API（公開フラグ方式）
- スナップショット / 名前付き保存機能
- 自動延長機構（操作ごとに linkToken 期限を延長）

## 関連ドキュメント

- [`docs/scene-sync-spec.md`](./scene-sync-spec.md) — Scene Sync 本体仕様
- [`docs/pipe-spec.md`](./pipe-spec.md) — Pipe（P2P 通信）仕様
