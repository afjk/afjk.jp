# Step 10: 競合解決 & 編集ロック

## 目的

同一オブジェクトを複数ユーザーが同時操作した場合の競合を防ぐ。
オブジェクト選択時に scene-lock を broadcast し、
他のクライアントはロック中のオブジェクトを操作不可にする。

---

## ロック管理

### データ構造

    // objectId → lockOwnerId
    const locks = new Map();

### ルール

- オブジェクトを選択（TransformControls にアタッチ）した時点で scene-lock を送信
- 選択解除（detach / 別オブジェクト選択）した時点で scene-unlock を送信
- ロック中のオブジェクトは他クライアントが選択できない
- ロック保持者が切断した場合は自動でロック解除（peers 更新時にチェック）

---

## ブラウザ側の実装（scene.js に追加）

### ロック送信

    renderer.domElement.addEventListener('dblclick', (e) => {
      // 既存のレイキャスト処理

      if (hits.length > 0) {
        // ... obj の特定
        if (locks.has(obj.userData.objectId)
            && locks.get(obj.userData.objectId) !== presenceState.id) {
          // 他者がロック中 → 選択不可
          return;
        }
        transformCtrl.attach(obj);
        broadcast({ kind: 'scene-lock', objectId: obj.userData.objectId });
      } else {
        if (transformCtrl.object) {
          broadcast({
            kind: 'scene-unlock',
            objectId: transformCtrl.object.userData.objectId
          });
        }
        transformCtrl.detach();
      }
    });

### ロック受信

    case 'scene-lock': {
      locks.set(payload.objectId, data.from.id);
      // ロックされたオブジェクトの見た目変更（任意: 半透明化など）
      break;
    }

    case 'scene-unlock': {
      locks.delete(payload.objectId);
      break;
    }

### 切断時の自動ロック解除

    case 'peers': {
      presenceState.peers = data.peers || [];
      updateStatus(true);
      // 切断したピアのロックを解除
      const peerIds = new Set(data.peers.map(p => p.id));
      for (const [objId, ownerId] of locks) {
        if (!peerIds.has(ownerId) && ownerId !== presenceState.id) {
          locks.delete(objId);
        }
      }
      break;
    }

---

## Unity 側の実装

同様にロック管理の Dictionary を持ち、Selection 変更時に lock/unlock を送信する。
受信した lock のオブジェクトは Selection で選択しても操作を反映しない。

---

## 視覚的フィードバック（任意）

- ロック中のオブジェクトにアウトラインや半透明エフェクトを付ける
- ロック保持者の名前をラベル表示する

---

## 動作確認

### 1. 2つのクライアント（Unity + ブラウザ、またはブラウザ2つ）を接続
### 2. クライアントAで Cube を選択 → scene-lock 送信
### 3. クライアントBで同じ Cube をダブルクリック → 選択できない
### 4. クライアントAが選択解除 → scene-unlock 送信
### 5. クライアントBで Cube を選択できるようになる
### 6. クライアントAが切断 → ロックが自動解除される

---

## 完了条件

- [ ] オブジェクト選択時に scene-lock が broadcast される
- [ ] 選択解除時に scene-unlock が broadcast される
- [ ] ロック中のオブジェクトは他クライアントが選択できない
- [ ] 切断時にロックが自動解除される
- [ ] ロック管理がブラウザ・Unity の両方で動作する
