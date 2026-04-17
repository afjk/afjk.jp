# Step 2: presence-server に broadcast 追加

## 目的

presence-server に `type: "broadcast"` メッセージタイプを追加する。
同じルーム内の全クライアント（送信者を除く）に payload を配信する。
Scene Sync のリアルタイム同期基盤として使用する。

## 対象ファイル

- `apps/presence-server/src/server.mjs`

## 変更箇所

### 変更1: `broadcastHandoff` 関数を追加

`deliverHandoff` 関数の直後（`const CORS = {` の直前）に以下の関数を追加する。

    function broadcastHandoff(sender, msg) {
      const room = rooms.get(sender.roomId);
      if (!room) return;
      const payload = {
        type: 'handoff',
        from: {
          id: sender.id,
          nickname: sender.nickname,
          device: sender.device
        },
        payload: msg.payload || {}
      };
      room.forEach(client => {
        if (client.id !== sender.id) {
          safeSend(client.conn, payload);
        }
      });
    }

### 変更2: onMessage の switch 文に `broadcast` case を追加

`conn.onMessage` 内の switch 文で、`case 'handoff':` ブロックの直後、
`case 'ping':` の直前に以下を追加する。

          case 'broadcast':
            if (data.payload) {
              broadcastHandoff(client, data);
            }
            break;

## 既存機能への影響

なし。

- 既存の `type: "handoff"` は `targetId` 必須の 1対1 配信でそのまま残る
- 新しい `type: "broadcast"` は独立した case として追加
- 受信側に届くメッセージ形式は既存の handoff と同一（`type: "handoff"`）
- pipe の既存機能（ファイル転送・テキスト・swarm・映像配信）に影響なし

## 動作確認

### 1. ビルド & 起動

    docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build presence-server

### 2. ブラウザコンソールで確認

タブ1:

    const ws1 = new WebSocket('ws://localhost:8787/?room=test');
    ws1.onmessage = e => console.log('ws1 recv:', e.data);
    ws1.onopen = () => ws1.send(JSON.stringify({
      type: 'hello', nickname: 'A', device: 'Chrome'
    }));

タブ2:

    const ws2 = new WebSocket('ws://localhost:8787/?room=test');
    ws2.onmessage = e => console.log('ws2 recv:', e.data);
    ws2.onopen = () => ws2.send(JSON.stringify({
      type: 'hello', nickname: 'B', device: 'Chrome'
    }));

タブ1 から broadcast 送信:

    ws1.send(JSON.stringify({
      type: 'broadcast',
      payload: { kind: 'scene-delta', objectId: 'obj-001', position: [1, 2, 3] }
    }));

### 3. 期待結果

- ws2 に以下が届く:

      {
        "type": "handoff",
        "from": { "id": "...", "nickname": "A", "device": "Chrome" },
        "payload": { "kind": "scene-delta", "objectId": "obj-001", "position": [1, 2, 3] }
      }

- ws1 には届かない（送信者除外）
- 3台以上接続した場合、送信者以外の全員に届く

## 完了条件

- [ ] `broadcastHandoff` 関数が追加されている
- [ ] switch 文に `case 'broadcast'` が追加されている
- [ ] 動作確認で broadcast メッセージが同室の全員（送信者除く）に届く
- [ ] 既存の handoff（targetId 指定）が引き続き動作する
- [ ] pipe の既存機能（ファイル転送・テキスト送受信）が正常に動作する
