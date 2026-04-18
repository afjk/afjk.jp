# Fix: iPhone Safari タッチ操作対応

## 概要

iPhone Safari で 3D シーンのタッチ操作を可能にする。
- ダブルタップでオブジェクト選択
- タッチドラッグで TransformControls 操作
- シングルタップで選択解除
- ピンチズームはそのまま OrbitControls が処理

### 対象ファイル

- `html/pipe/scene.html`（CSS 追加）
- `html/assets/js/pipe/scene.js`（タッチイベント追加）

---

## 修正 1: CSS でダブルタップズームを無効化

### 対象ファイル: `html/pipe/scene.html`

canvas にタッチ操作の CSS を追加する。

```css
/* 既存の body スタイルに追加 */
body {
  margin: 0;
  overflow: hidden;
  background: #222;
  touch-action: none;       /* ← 追加: ブラウザのタッチジェスチャーを無効化 */
}

/* canvas にも明示的に指定 */
canvas {
  display: block;
  touch-action: none;       /* ← 追加 */
  cursor: pointer;          /* ← 追加: iOS Safari でクリック可能にする */
  -webkit-user-select: none;
  user-select: none;
}
```

### ポイント

- `touch-action: none` でダブルタップズーム・スワイプスクロールを無効化
  （OrbitControls と TransformControls が自前でタッチを処理する）
- `cursor: pointer` で iOS Safari がタッチイベントを正しく発火する
- `user-select: none` で長押し時のテキスト選択を防止

---

## 修正 2: タッチによるダブルタップ検出

iOS Safari は `dblclick` を canvas 上で発火しない場合があるため、
`touchend` イベントでダブルタップを自前検出する。

### scene.js に追加

```javascript
// ── タッチ操作（iOS Safari 対応） ───────────────────────

let lastTapTime = 0;
let lastTapX = 0;
let lastTapY = 0;
const DOUBLE_TAP_DELAY = 300;  // ms
const DOUBLE_TAP_DISTANCE = 30; // px

renderer.domElement.addEventListener('touchend', (e) => {
  // マルチタッチ（ピンチ等）は無視
  if (e.touches.length > 0) return;

  const touch = e.changedTouches[0];
  if (!touch) return;

  const now = Date.now();
  const dx = touch.clientX - lastTapX;
  const dy = touch.clientY - lastTapY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (now - lastTapTime < DOUBLE_TAP_DELAY && dist < DOUBLE_TAP_DISTANCE) {
    // ダブルタップ検出
    e.preventDefault();
    handleDoubleTap(touch.clientX, touch.clientY);
    lastTapTime = 0; // リセット（トリプルタップ防止）
  } else {
    lastTapTime = now;
    lastTapX = touch.clientX;
    lastTapY = touch.clientY;
  }
}, { passive: false });
```

---

## 修正 3: 選択ロジックの共通化

既存の `dblclick` ハンドラと新しい `handleDoubleTap` で同じ処理を使う。

### 共通関数を作成

```javascript
function selectObjectAt(clientX, clientY) {
  pointer.x = (clientX / innerWidth) * 2 - 1;
  pointer.y = -(clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const targets = Array.from(managedObjects.values());
  const hits = raycaster.intersectObjects(targets, true);
  if (hits.length > 0) {
    let obj = hits[0].object;
    while (obj.parent && !obj.userData.objectId) obj = obj.parent;
    // ロックオーバーレイは除外
    if (obj.userData._isLockOverlay) return;
    if (obj.userData.objectId) {
      if (locks.has(obj.userData.objectId)) {
        const lockInfo = locks.get(obj.userData.objectId);
        const who = lockInfo.nickname || lockInfo.from?.nickname || '他のユーザー';
        showToast(`${who} が編集中です`);
        return;
      }
      transformCtrl.attach(obj);
      broadcast({ kind: 'scene-lock', objectId: obj.userData.objectId });
      showToolbar();
      updateToolbarActive(transformCtrl.mode);
    }
  } else {
    if (transformCtrl.object) {
      broadcast({
        kind: 'scene-unlock',
        objectId: transformCtrl.object.userData.objectId,
      });
    }
    transformCtrl.detach();
    hideToolbar();
  }
}
```

### 既存の dblclick ハンドラを変更

```javascript
// 変更前
renderer.domElement.addEventListener('dblclick', (e) => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  // ... 長いロジック
});

// 変更後
renderer.domElement.addEventListener('dblclick', (e) => {
  selectObjectAt(e.clientX, e.clientY);
});
```

### handleDoubleTap 関数

```javascript
function handleDoubleTap(clientX, clientY) {
  selectObjectAt(clientX, clientY);
}
```

---

## 修正 4: シングルタップで選択解除

ダブルタップではないシングルタップで空白をタップした場合に選択を解除する。
ただし、TransformControls のドラッグ操作と区別する必要がある。

```javascript
let touchMoved = false;

renderer.domElement.addEventListener('touchstart', (e) => {
  touchMoved = false;
}, { passive: true });

renderer.domElement.addEventListener('touchmove', (e) => {
  touchMoved = true;
}, { passive: true });

// 既存の touchend ハンドラ内に追加
// ダブルタップでない場合のシングルタップ処理
// → タイマーで遅延実行し、ダブルタップ時はキャンセル
let singleTapTimer = null;

renderer.domElement.addEventListener('touchend', (e) => {
  if (e.touches.length > 0) return;
  const touch = e.changedTouches[0];
  if (!touch) return;

  const now = Date.now();
  const dx = touch.clientX - lastTapX;
  const dy = touch.clientY - lastTapY;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // シングルタップタイマーをクリア
  clearTimeout(singleTapTimer);

  if (now - lastTapTime < DOUBLE_TAP_DELAY && dist < DOUBLE_TAP_DISTANCE) {
    // ダブルタップ
    e.preventDefault();
    handleDoubleTap(touch.clientX, touch.clientY);
    lastTapTime = 0;
  } else {
    lastTapTime = now;
    lastTapX = touch.clientX;
    lastTapY = touch.clientY;

    // シングルタップ（遅延実行 → ダブルタップの2タップ目で上書きされる）
    const tapX = touch.clientX;
    const tapY = touch.clientY;
    singleTapTimer = setTimeout(() => {
      if (!touchMoved && transformCtrl.object) {
        // 空白タップで選択解除
        pointer.x = (tapX / innerWidth) * 2 - 1;
        pointer.y = -(tapY / innerHeight) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const targets = Array.from(managedObjects.values());
        const hits = raycaster.intersectObjects(targets, true);
        if (hits.length === 0) {
          broadcast({
            kind: 'scene-unlock',
            objectId: transformCtrl.object.userData.objectId,
          });
          transformCtrl.detach();
          hideToolbar();
        }
      }
    }, DOUBLE_TAP_DELAY + 50);
  }
}, { passive: false });
```

---

## 修正 5: viewport meta タグの確認

### 対象ファイル: `html/pipe/scene.html`

head 内に以下があることを確認（なければ追加）:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
```

`user-scalable=no` と `maximum-scale=1.0` でピンチズームによる
ページ拡大を防止（3D シーン内の OrbitControls ズームは影響しない）。

---

## 確認方法

### ダブルタップ選択
1. iPhone Safari で scene.html を開く
2. オブジェクトをダブルタップ
3. TransformControls が表示されること
4. ツールバーが表示されること

### タッチドラッグ操作
1. 選択状態で TransformControls の軸をドラッグ
2. オブジェクトが移動すること
3. ツールバーで回転・スケールに切り替えて操作できること

### シングルタップ選択解除
1. オブジェクト選択状態で空白部分をタップ
2. 選択が解除されツールバーが消えること

### ピンチ・スワイプ
1. 2 本指ピンチでズームできること（OrbitControls）
2. 1 本指スワイプでカメラ回転できること
3. ページ自体がズームされないこと

### 削除
1. オブジェクトを選択してツールバーの 🗑 ボタンをタップ
2. オブジェクトが削除され他クライアントに反映されること

## 完了条件

- [ ] `touch-action: none` と `cursor: pointer` が CSS に追加されている
- [ ] ダブルタップでオブジェクト選択できる
- [ ] タッチドラッグで TransformControls が操作できる
- [ ] シングルタップで選択解除できる
- [ ] ツールバーのボタンが全て動作する
- [ ] ピンチズーム・スワイプ回転が正常に動作する
- [ ] ページ自体のズーム・スクロールが発生しない
- [ ] viewport meta タグが正しく設定されている
- [ ] PC ブラウザの既存操作に影響がないこと
