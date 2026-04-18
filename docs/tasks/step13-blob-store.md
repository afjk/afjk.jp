# Step 13: presence-server に blob store 追加

## 目的

glB メッシュデータの一時保存・配信エンドポイントを presence-server に追加する。
piping-server の 1:1 / 順序依存の制約を解消し、
複数クライアントが何度でも取得できるようにする。

---

## 方針

サイズに応じてメモリ / ディスクを使い分ける。

| ファイルサイズ | 保存先 | 理由 |
|--------------|--------|------|
| 1MB 以下 | メモリ（Map） | 高速、大半の glB はここに収まる |
| 1MB 超 〜 50MB | ディスク（/data/blobs/） | メモリ圧迫を防ぐ |
| 50MB 超 | 拒否（413） | サーバー保護 |

共通仕様:
- TTL: 10分（アップロードから自動削除）
- 60秒ごとに期限切れを掃除
- パスはクライアントが生成したランダム文字列

---

## API

### POST /blob/:id

glB バイナリをアップロードする。

リクエスト:

    POST /blob/abc12345
    Content-Type: model/gltf-binary
    Body: <glB バイナリ>

レスポンス:

    201 Created
    Content-Type: application/json
    { "id": "abc12345", "size": 102400, "expiresAt": 1713500000000 }

エラー:

    413 Payload Too Large  — 50MB 超
    409 Conflict           — 同じ id が既に存在

### GET /blob/:id

保存済みの glB を取得する。何度でも取得可能。

レスポンス:

    200 OK
    Content-Type: model/gltf-binary
    Body: <glB バイナリ>

エラー:

    404 Not Found — 存在しないか期限切れ

### DELETE /blob/:id（任意）

明示的に削除する。TTL 前にクリーンアップしたい場合に使用。

    204 No Content

---

## 実装（server.mjs に追加）

### 定数・データ構造

    const BLOB_MAX_SIZE = 50 * 1024 * 1024;       // 50MB
    const BLOB_MEMORY_THRESHOLD = 1 * 1024 * 1024; // 1MB
    const BLOB_TTL_MS = 10 * 60 * 1000;            // 10分
    const BLOB_CLEANUP_INTERVAL = 60 * 1000;        // 60秒
    const BLOB_DIR = process.env.BLOB_DIR || '/data/blobs';

    // id → { buffer: Buffer|null, file: string|null, size: number, createdAt: number }
    const blobs = new Map();

### POST /blob/:id

    if (req.method === 'POST' && path.startsWith('/blob/')) {
      const id = path.slice(6).replace(/[^a-z0-9\-]/gi, '').slice(0, 32);
      if (!id) {
        res.writeHead(400, CORS).end('invalid id');
        return;
      }
      if (blobs.has(id)) {
        res.writeHead(409, CORS).end('conflict');
        return;
      }

      const chunks = [];
      let totalSize = 0;

      req.on('data', chunk => {
        totalSize += chunk.length;
        if (totalSize > BLOB_MAX_SIZE) {
          res.writeHead(413, CORS).end('too large');
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (res.writableEnded) return;
        const buffer = Buffer.concat(chunks);
        const entry = {
          size: buffer.length,
          createdAt: Date.now(),
          buffer: null,
          file: null,
        };

        if (buffer.length <= BLOB_MEMORY_THRESHOLD) {
          // メモリ保存
          entry.buffer = buffer;
        } else {
          // ディスク保存
          try {
            mkdirSync(BLOB_DIR, { recursive: true });
            const filePath = BLOB_DIR + '/' + id + '.glb';
            writeFileSync(filePath, buffer);
            entry.file = filePath;
          } catch (err) {
            log('blob write error', err.message);
            res.writeHead(500, CORS).end('write error');
            return;
          }
        }

        blobs.set(id, entry);
        log('blob stored', id, entry.size, entry.buffer ? 'memory' : 'disk');

        res.writeHead(201, { 'content-type': 'application/json', ...CORS })
           .end(JSON.stringify({
             id,
             size: entry.size,
             expiresAt: entry.createdAt + BLOB_TTL_MS,
           }));
      });
      return;
    }

### GET /blob/:id

    if (req.method === 'GET' && path.startsWith('/blob/')) {
      const id = path.slice(6).replace(/[^a-z0-9\-]/gi, '').slice(0, 32);
      const entry = blobs.get(id);
      if (!entry) {
        res.writeHead(404, CORS).end('not found');
        return;
      }

      let data;
      if (entry.buffer) {
        data = entry.buffer;
      } else if (entry.file) {
        try {
          data = readFileSync(entry.file);
        } catch {
          res.writeHead(404, CORS).end('file missing');
          blobs.delete(id);
          return;
        }
      }

      res.writeHead(200, {
        'content-type': 'model/gltf-binary',
        'content-length': data.length,
        'cache-control': 'no-store',
        ...CORS,
      }).end(data);
      return;
    }

### DELETE /blob/:id

    if (req.method === 'DELETE' && path.startsWith('/blob/')) {
      const id = path.slice(6).replace(/[^a-z0-9\-]/gi, '').slice(0, 32);
      deleteBlob(id);
      res.writeHead(204, CORS).end();
      return;
    }

### 削除ヘルパー & TTL クリーンアップ

    function deleteBlob(id) {
      const entry = blobs.get(id);
      if (!entry) return;
      if (entry.file) {
        try { require('node:fs').unlinkSync(entry.file); } catch {}
      }
      blobs.delete(id);
    }

    setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of blobs) {
        if (now - entry.createdAt > BLOB_TTL_MS) {
          log('blob expired', id);
          deleteBlob(id);
        }
      }
    }, BLOB_CLEANUP_INTERVAL);

---

## https-portal の設定変更

presence-server の /blob/ パスに外部からアクセスできるようにする。
現在の /presence プロキシ設定で既にカバーされている。

    wss://afjk.jp/presence  → presence-server:8787/
    https://afjk.jp/presence/blob/xxx → presence-server:8787/blob/xxx

既存の nginx 設定:

    location /presence {
      proxy_pass http://presence-server:8787/;
      ...
    }

`/presence/blob/xxx` は `http://presence-server:8787/blob/xxx` に転送されるため、
追加設定は不要。

---

## クライアント側の変更

### blob store の URL

    ブラウザ:  https://afjk.jp/presence/blob/
    ローカル:  http://localhost:8787/blob/
    Unity:     同上

### Unity (PresenceClient.cs) — UploadGlb 修正

    public static async Task UploadGlb(byte[] glb, string blobBaseUrl, string path)
    {
        if (glb == null || glb.Length == 0) return;

        try
        {
            var url = blobBaseUrl + "/" + path;
            var content = new ByteArrayContent(glb);
            content.Headers.ContentType = new MediaTypeHeaderValue("model/gltf-binary");
            var response = await _http.PostAsync(url, content);
            if (!response.IsSuccessStatusCode)
            {
                Debug.LogWarning("[SceneSync] Upload failed: " + response.StatusCode);
            }
        }
        catch (Exception ex)
        {
            Debug.LogWarning("[SceneSync] Upload failed: " + ex.Message);
        }
    }

PUT → POST に変更。piping-server の URL → blob store の URL に変更。

### Unity (SceneSyncWindow.cs) — URL の変更

piping-server URL の入力欄をそのまま blob store の URL に読み替える。
ラベルを「Blob URL」に変更するか、内部で /presence/blob を使う。

    // 例: blobBaseUrl = "https://afjk.jp/presence/blob"
    // または presenceUrl から自動導出:
    //   "wss://afjk.jp/presence" → "https://afjk.jp/presence/blob"

### ブラウザ (scene.js) — URL の変更

    const BLOB_BASE = location.hostname === 'localhost'
      ? 'http://localhost:8787/blob'
      : 'https://afjk.jp/presence/blob';

piping-server の fetch を blob store に差し替え:

    // アップロード
    await fetch(BLOB_BASE + '/' + meshPath, {
      method: 'POST',
      headers: { 'Content-Type': 'model/gltf-binary' },
      body: arrayBuffer,
    });

    // ダウンロード（GLTFLoader に URL を渡すだけ）
    gltfLoader.load(BLOB_BASE + '/' + meshPath, ...);

### 最大の変更点: broadcast で meshPath を共有可能に

piping-server では 1:1 のため peer ごとに個別 handoff が必要だったが、
blob store なら N 人が同じ URL から GET できる。

    // 旧: peer ごとにループして個別 handoff
    for (const peer of peers) { ... }

    // 新: 1回 POST して broadcast するだけ
    await fetch(BLOB_BASE + '/' + meshPath, { method: 'POST', body: glb });
    broadcast({
      kind: 'scene-add',
      objectId,
      name,
      position: [...],
      rotation: [...],
      scale: [...],
      meshPath,
    });

Unity 側も同様にシンプルになる。

---

## 動作確認

### 1. presence-server を再ビルド

    docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build presence-server

### 2. blob store の動作確認（curl）

    # アップロード
    curl -X POST -H "Content-Type: model/gltf-binary" \
      --data-binary @test.glb \
      http://localhost:8787/blob/test001

    # ダウンロード（何度でも OK）
    curl -o out.glb http://localhost:8787/blob/test001

    # 2回目のダウンロード
    curl -o out2.glb http://localhost:8787/blob/test001

    # 削除
    curl -X DELETE http://localhost:8787/blob/test001

### 3. Unity → ブラウザの同期確認

    Unity で Connect → ブラウザで scene.html?room=test
    Unity でオブジェクトが配置されたシーンを同期
    ブラウザに glB モデルが表示される

### 4. ブラウザ → Unity の同期確認

    ブラウザで glB ファイルを追加
    Unity 側にオブジェクト追加の通知が届く

---

## 完了条件

- [ ] presence-server に POST /blob/:id が追加されている
- [ ] presence-server に GET /blob/:id が追加されている
- [ ] 1MB 以下はメモリ保存、1MB 超はディスク保存される
- [ ] 50MB 超は 413 で拒否される
- [ ] 10分で自動削除される
- [ ] 複数クライアントが同じ id で何度でも GET できる
- [ ] Unity の UploadGlb が blob store を使うように変更されている
- [ ] ブラウザの scene.js が blob store を使うように変更されている
- [ ] broadcast で meshPath を共有する方式に簡略化されている
- [ ] piping-server への依存がメッシュ転送から除去されている
