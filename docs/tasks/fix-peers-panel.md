# Fix: 参加者一覧の表示

## 概要

画面左上に参加者一覧パネルを表示する。
自分と他の参加者のニックネームを表示し、
誰がオブジェクトを編集中かも分かるようにする。

### 対象ファイル

- `html/pipe/scene.html`（HTML・CSS 追加）
- `html/assets/js/pipe/scene.js`（更新ロジック追加）

---

## 変更 1: HTML 追加

### 対象ファイル: `html/pipe/scene.html`

status の下に追加:

```html
<div id="peers-panel">
  <div id="peers-list"></div>
</div>
```

---

## 変更 2: CSS 追加

### 対象ファイル: `html/pipe/scene.html`

```css
#peers-panel {
  position: fixed;
  top: 48px;
  right: 12px;
  background: rgba(0, 0, 0, 0.6);
  border-radius: 8px;
  padding: 8px 12px;
  color: #fff;
  font-size: 13px;
  z-index: 50;
  min-width: 120px;
  max-height: 40vh;
  overflow-y: auto;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.peer-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  white-space: nowrap;
}
.peer-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #4f4;
  flex-shrink: 0;
}
.peer-dot.self {
  background: #48f;
}
.peer-name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.peer-editing {
  font-size: 11px;
  color: #ff8800;
  margin-left: auto;
  flex-shrink: 0;
}
```

---

## 変更 3: 参加者一覧の更新ロジック

### 対象ファイル: `html/assets/js/pipe/scene.js`

```javascript
// ── 参加者一覧 ──────────────────────────────────────────

const peersListEl = document.getElementById('peers-list');

function updatePeersList() {
  if (!peersListEl) return;

  // 編集中オブジェクトの逆引き: userId → objectId
  const editingMap = new Map();
  for (const [objectId, owner] of locks) {
    const ownerId = owner.id || owner;
    editingMap.set(ownerId, objectId);
  }

  let html = '';

  // 自分
  const selfEditing = transformCtrl.object
    ? transformCtrl.object.userData.objectId || ''
    : '';
  html += renderPeerItem(presenceState.nickname || '自分', true, selfEditing);

  // 他の参加者
  for (const peer of presenceState.peers) {
    if (peer.id === presenceState.id) continue;
    const editing = editingMap.get(peer.id) || '';
    html += renderPeerItem(peer.nickname || peer.device || '?', false, editing);
  }

  peersListEl.innerHTML = html;
}

function renderPeerItem(name, isSelf, editingObjectId) {
  const dotClass = isSelf ? 'peer-dot self' : 'peer-dot';
  const editLabel = editingObjectId ? '✏️' : '';
  const selfLabel = isSelf ? ' (自分)' : '';
  return `<div class="peer-item">`
    + `<span class="${dotClass}"></span>`
    + `<span class="peer-name">${escapeHtml(name)}${selfLabel}</span>`
    + `${editLabel ? `<span class="peer-editing">${editLabel}</span>` : ''}`
    + `</div>`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```

### 更新タイミング

以下の箇所で `updatePeersList()` を呼ぶ:

```javascript
// 1. peers 受信時（既存の peers ハンドラ内、updateStatus の後）
case 'peers': {
  // ... 既存の処理 ...
  updateStatus(true);
  updatePeersList();  // ← 追加
  break;
}

// 2. welcome 受信時
case 'welcome':
  // ... 既存の処理 ...
  updatePeersList();  // ← 追加
  break;

// 3. scene-lock 受信時
case 'scene-lock': {
  locks.set(payload.objectId, data.from);
  addLockOverlay(payload.objectId, data.from);
  updatePeersList();  // ← 追加
  break;
}

// 4. scene-unlock 受信時
case 'scene-unlock': {
  locks.delete(payload.objectId);
  removeLockOverlay(payload.objectId);
  updatePeersList();  // ← 追加
  break;
}

// 5. 自分がオブジェクトを選択/選択解除した時
//    selectObjectAt 関数内の transformCtrl.attach / detach の後
transformCtrl.attach(obj);
// ...
updatePeersList();  // ← 追加

// detach 時も
transformCtrl.detach();
hideToolbar();
updatePeersList();  // ← 追加

// 6. 切断時
ws.onclose = () => {
  updateStatus(false);
  updatePeersList();  // ← 追加
  // ...
};
```

---

## 確認方法

1. ブラウザ A で scene.html?room=test を開く
2. 画面右上に自分の名前（青い丸）が表示されること
3. ブラウザ B で同じルームに参加
4. ブラウザ A のパネルにブラウザ B の名前（緑の丸）が追加されること
5. ブラウザ B でオブジェクトを選択 → ブラウザ A のパネルに ✏️ が表示
6. ブラウザ B が選択解除 → ✏️ が消えること
7. Unity で参加した場合も「Unity」が一覧に表示されること
8. 参加者が切断するとリストから消えること

## 完了条件

- [ ] 画面右上に参加者パネルが表示される
- [ ] 自分は青丸 + "(自分)" で区別できる
- [ ] 他の参加者は緑丸で表示される
- [ ] 編集中の参加者に ✏️ マークが表示される
- [ ] ピアの接続/切断でリストが更新される
- [ ] ロック/アンロック時にリストが更新される
- [ ] 既存の同期機能に影響がないこと
