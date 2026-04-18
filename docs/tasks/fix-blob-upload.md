# Fix: Blob アップロード不具合修正

## 概要

コミット `0b970642` で追加した blob store に対して、Unity 側の HTTP メソッド不一致と
CORS ヘッダー欠落、ディスク blob の読み取り効率の問題を修正する。

## 問題一覧

| # | 内容 | 重要度 | 対象ファイル |
|---|------|--------|-------------|
| 1 | Unity の UploadGlb が PUT を使用しているがサーバは POST を期待 | 高 | `unity/com.afjk.scene-sync/Editor/PresenceClient.cs` |
| 2 | blob エンドポイントに CORS ヘッダーがない | 中 | `apps/presence-server/src/server.mjs` |
| 3 | Unity の Blob URL デフォルト値がローカル固定 | 中 | `unity/com.afjk.scene-sync/Editor/SceneSyncWindow.cs` |
| 4 | ディスク blob を readFileSync で全量読み込み | 低 | `apps/presence-server/src/server.mjs` |

---

## 修正 1: HTTP メソッド不一致（高）

### 対象ファイル

`unity/com.afjk.scene-sync/Editor/PresenceClient.cs`

### 変更内容

`UploadGlb` メソッド内の `PutAsync` を `PostAsync` に変更する。

### 変更前

```csharp
var resp = await _http.PutAsync(url, content);
```

### 変更後

```csharp
var resp = await _http.PostAsync(url, content);
```

### 確認方法

1. Unity で SceneSyncWindow を開き Connect する
2. Sync Meshes をクリック
3. Console に `[SceneSync] Upload failed` が出ないことを確認
4. ブラウザ側でメッシュが表示されることを確認

---

## 修正 2: CORS ヘッダー追加（中）

### 対象ファイル

`apps/presence-server/src/server.mjs`

### 変更内容

blob エンドポイント（POST / GET / DELETE `/blob/:id`）のレスポンスと
OPTIONS プリフライトに CORS ヘッダーを付与する。

### 追加するヘルパー関数

既存の `handleCors` の近くに以下を追加する。

```javascript
function setBlobCors(req, res) {
  const origin = req.headers['origin'] || '';
  const allowed = [
    'https://afjk.jp',
    'https://staging.afjk.jp',
    'http://localhost:8888',
    'http://localhost:3000',
  ];
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
```

### blob ルーティング部分の変更

```javascript
// OPTIONS プリフライト（blob パスの先頭で処理）
if (method === 'OPTIONS' && pathname.startsWith('/blob/')) {
  setBlobCors(req, res);
  res.writeHead(204);
  res.end();
  return;
}

// POST /blob/:id
if (method === 'POST' && blobMatch) {
  setBlobCors(req, res);
  // ... 既存の処理
}

// GET /blob/:id
if (method === 'GET' && blobMatch) {
  setBlobCors(req, res);
  // ... 既存の処理
}

// DELETE /blob/:id
if (method === 'DELETE' && blobMatch) {
  setBlobCors(req, res);
  // ... 既存の処理
}
```

### 確認方法

1. ブラウザの DevTools Network タブを開く
2. scene.html から glB ファイルをアップロード
3. POST リクエストのレスポンスヘッダーに `Access-Control-Allow-Origin` があることを確認
4. CORS エラーが出ないことを確認

---

## 修正 3: Blob URL デフォルト値の改善（中）

### 対象ファイル

`unity/com.afjk.scene-sync/Editor/SceneSyncWindow.cs`

### 変更内容

`_blobUrl` のデフォルト値を空にし、Connect 時に Presence URL から自動導出する。
手動入力された場合はそちらを優先する。

### 変更前

```csharp
private string _blobUrl = "http://localhost:8787/blob";
```

### 変更後

```csharp
private string _blobUrl = "";
```

### DeriveUrls メソッドの確認と修正

Connect ボタン押下時、WebSocket 接続前に以下のロジックが実行されることを確認する。
存在しない場合は追加する。

```csharp
private string GetBlobUrl()
{
    if (!string.IsNullOrEmpty(_blobUrl)) return _blobUrl;

    // wss://staging.afjk.jp/presence → https://staging.afjk.jp/presence/blob
    // ws://localhost:8787 → http://localhost:8787/blob
    var url = _presenceUrl
        .Replace("wss://", "https://")
        .Replace("ws://", "http://");
    if (url.EndsWith("/")) url = url.TrimEnd('/');
    return url + "/blob";
}
```

### UploadGlb 呼び出し側の変更

```csharp
// 変更前
var path = await PresenceClient.UploadGlb(glb, _blobUrl);

// 変更後
var path = await PresenceClient.UploadGlb(glb, GetBlobUrl());
```

### 確認方法

1. Blob URL 欄を空のまま、Presence URL に `wss://staging.afjk.jp/presence` を入力
2. Connect → Sync Meshes
3. アップロードが `https://staging.afjk.jp/presence/blob/` に送信されることを確認
4. Blob URL を手動入力した場合はそちらが優先されることを確認

---

## 修正 4: ディスク blob のストリーミング読み取り（低）

### 対象ファイル

`apps/presence-server/src/server.mjs`

### 変更内容

GET `/blob/:id` でディスク保存された blob を返す際、
`readFileSync` を `createReadStream` に変更する。

### 変更前

```javascript
const data = readFileSync(entry.filePath);
res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': entry.size });
res.end(data);
```

### 変更後

```javascript
const { createReadStream } = await import('fs');
// ファイル先頭の import に追加: import { ..., createReadStream } from 'fs';

const stream = createReadStream(entry.filePath);
res.writeHead(200, {
  'Content-Type': 'model/gltf-binary',
  'Content-Length': entry.size,
});
stream.pipe(res);
stream.on('error', (err) => {
  console.error(`[blob] read error ${id}:`, err.message);
  if (!res.headersSent) res.writeHead(500);
  res.end();
});
```

※ ファイル先頭の import 文に `createReadStream` を追加すること。

```javascript
// 既存
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, unlinkSync } from 'fs';

// 変更後
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, unlinkSync, createReadStream } from 'fs';
```

### 確認方法

1. 1 MB 以上の glB ファイルをアップロード
2. ブラウザ側で正常にダウンロード・表示されることを確認
3. presence-server のメモリ使用量が大幅に増加しないことを確認

---

## 完了条件

- [ ] 修正 1: `PostAsync` に変更、Unity からのアップロードが成功する
- [ ] 修正 2: CORS ヘッダー追加、ブラウザから CORS エラーなくアップロード可能
- [ ] 修正 3: Blob URL が Presence URL から自動導出される
- [ ] 修正 4: ディスク blob がストリーミングで返される
- [ ] 既存機能（ピア管理、handoff、stats）に影響がないこと
- [ ] staging 環境で Unity ↔ ブラウザ間のメッシュ同期が動作すること
