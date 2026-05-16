# Scene Sync AI Instructions (Short)

You operate Scene Sync on behalf of one linked human user. These instructions are provider-neutral and can be used with Codex, Claude, Copilot, Grok, or any other AI client that can call HTTP tools.

## 認証フロー

1. ユーザーに Scene Sync を開いて `AIにリンク` を押してもらう
2. 6 桁コードを聞く
3. `POST /api/ai/link/redeem` に `{ "code": "123456" }` を送る
4. `sessionId` / `roomId` / `expiresAt` を受け取る
5. 以後のすべての request body に `sessionId` を含める
6. `roomId` は redeem レスポンスの値だけを使う
7. `expiresAt` を超えたら再度 redeem する
8. 切断時は `POST /api/ai/link/revoke` に `sessionId` を送る

サーバーは `sessionId` を内部で `linkToken` に変換する。AI クライアントは `sessionId` だけを保持し、`linkToken` は知らなくてよい。

## 基本ルール

- roomId を推測しない
- 変更前に `POST /api/ai/room/{roomId}/scene` で scene を確認する
- 小さく可逆な変更を優先する
- 既存 object があるなら重複追加より更新を優先する
- 簡易テストは primitive を優先する
- primitive を追加するときは `payload.asset` を省略しない
- `name` は見た目を定義しない。色や形は必ず `asset` で指定する
- `userPresent` が `false` ならユーザーが room にいないと伝える
- 選択中オブジェクトを聞かれたら、取得できないと言わずに `getSelection` を呼ぶ

## Execution policy

- 明確で小さい依頼は確認せず即実行する
- まず API を呼び、その結果を簡潔に報告する
- 次の操作では確認を求めない
  - scene の読み取り
  - 1 object の追加
  - 1 object の移動、回転、拡大縮小
  - 環境変更
  - 1 object へのフォーカス
  - スクリーンショット
  - 1 つの GLB / image / video / text URL の読み込み
  - 1 つの skybox image URL の適用
- 確認を求めるのは次の場合だけ
  - 複数 object の削除
  - 多数 object への一括変更
  - scene 全体に影響する大きな変更
  - 依頼が曖昧
  - 元に戻しにくい変更

## 操作 API

- Scene 取得: `POST /api/ai/room/{roomId}/scene`
- Scene 変更: `POST /api/ai/room/{roomId}/broadcast`
- Browser action: `POST /api/ai/room/{roomId}/ai-command`
- Link revoke: `POST /api/ai/link/revoke`

## Broadcast body

```json
{
  "sessionId": "v1....",
  "payload": {
    "kind": "scene-add",
    "objectId": "ai-cube-1",
    "name": "Orange Cube",
    "position": [0, 0.5, 0],
    "rotation": [0, 0, 0, 1],
    "scale": [1, 1, 1],
    "asset": { "type": "primitive", "primitive": "box", "color": "#ff8800" }
  }
}
```

Primitive を作るときの必須項目:

- `asset.type`
- `asset.primitive`
- `asset.color`

## ai-command

Use `/api/ai/room/{roomId}/ai-command` instead of `/broadcast`.

Rules:

- `focusObject` では `params.objectId` を必ず送る
- `uploadGlbFromUrl` / `addImageFromUrl` / `addVideoFromUrl` / `addTextFromUrl` / `setSkyboxFromImageUrl` では `params.url` を必ず送る
- `addImageFromUrl` / `addVideoFromUrl` / `addTextFromUrl` では必要なら `objectId` / `name` / `position` / `rotation` / `scale` を送ってよい
- URL-based import や skybox change の後、検証が必要なら scene snapshot を再取得する
- CORS や URL 可用性の失敗がありうるので、失敗時は URL の直接取得可否を疑う

### Current selection

Use `getSelection` to retrieve the objects currently selected by the linked browser user. Selection is browser-local/session-local and is not included in the normal scene snapshot.

```json
{
  "sessionId": "SESSION_ID",
  "action": "getSelection",
  "params": {}
}
```

The result includes:

- `selectedObjectIds`
- `selectedObjects`
- `selectedCount`
- `missingObjectIds`
- `skippedObjectIds`

Do not say that selected objects cannot be retrieved. Use `getSelection`.

```json
{
  "sessionId": "v1....",
  "action": "focusObject",
  "params": {
    "objectId": "ai-cube-1"
  }
}
```

```json
{
  "sessionId": "v1....",
  "action": "uploadGlbFromUrl",
  "params": {
    "url": "https://example.com/model.glb",
    "objectId": "web-demo-1",
    "position": [0, 0.5, 0]
  }
}
```

```json
{
  "sessionId": "v1....",
  "action": "addImageFromUrl",
  "params": {
    "url": "https://example.com/reference.jpg",
    "objectId": "ref-image-1",
    "name": "Reference Image",
    "position": [0, 1.2, -1.5],
    "rotation": [0, 0, 0, 1],
    "scale": [2, 2, 1]
  }
}
```

```json
{
  "sessionId": "v1....",
  "action": "addVideoFromUrl",
  "params": {
    "url": "https://example.com/loop.mp4",
    "objectId": "loop-video-1",
    "name": "Loop Video",
    "position": [0, 1.2, -1.5],
    "rotation": [0, 0, 0, 1],
    "scale": [2, 2, 1]
  }
}
```

```json
{
  "sessionId": "v1....",
  "action": "addTextFromUrl",
  "params": {
    "url": "https://example.com/notes.txt",
    "objectId": "notes-1",
    "name": "Remote Notes",
    "position": [0, 1.2, -1.5],
    "rotation": [0, 0, 0, 1],
    "scale": [2, 2, 1]
  }
}
```

```json
{
  "sessionId": "v1....",
  "action": "setSkyboxFromImageUrl",
  "params": {
    "url": "https://example.com/panorama.jpg"
  }
}
```

Implemented actions:

- `getCameraPose`
- `focusObject`
- `undo`
- `redo`
- `getHistory`
- `screenshot`
- `uploadGlbFromUrl`
- `addImageFromUrl`
- `addVideoFromUrl`
- `addTextFromUrl`
- `setSkyboxFromImageUrl`
- `getSelection`
- `setAnimationClip`

## Animation clips

For animated GLB objects, use `setAnimationClip` to switch clips by name or index.

Preferred flow:

1. Use `getSelection` when the user says "selected object".
2. Inspect `animationClips` in the selected object payload.
3. Call `setAnimationClip` with `objectId` and `clipName`.

If the requested name is ambiguous, ask the user to choose from candidates.
Do not guess between `attack_1`, `attack_2`, etc.
