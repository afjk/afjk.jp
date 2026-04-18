# Fix: ロック表示の改善・Mac Delete 対応・スマホ削除 UI

## 概要

1. ロック表示をバウンディングボックス角線 + 頭上ラベル（🔒 + ニックネーム）に変更
2. ロック表示がオブジェクトの移動・回転・スケールに追従
3. Mac の Delete キー（Backspace）で削除可能にする
4. スマートフォン向けツールバーを追加する

### 対象ファイル

- `html/assets/js/pipe/scene.js`
- `html/pipe/scene.html`（CSS・HTML 追加）

---

## 修正 1: ロック表示（バウンディングボックス角線 + 頭上ラベル）

### 方針

ロックオーバーレイを 2 要素で構成する。

1. **角線**: バウンディングボックスの 8 つの角に短い線分を描く（`LineSegments`）
2. **頭上ラベル**: バウンディングボックス上部に 🔒 + ニックネームの `Sprite` を浮かべる

両方をグループ化して元オブジェクトの子に追加し、自動追従させる。
アニメーションループで毎フレームバウンディングボックスを再計算して更新する。

### addLockOverlay を置き換え

```javascript
// 変更前（バウンディングボックスのワイヤーフレーム全体）
function addLockOverlay(objectId) {
  // ... 既存のコード
}

// 変更後
function addLockOverlay(objectId, fromInfo) {
  removeLockOverlay(objectId); // 既存があれば除去

  const obj = managedObjects.get(objectId);
  if (!obj) return;

  const group = new THREE.Group();
  group.userData._isLockOverlay = true;
  group.raycast = () => {};

  // ── 角線の生成 ──
  const cornerLines = createCornerLines(obj);
  group.add(cornerLines);

  // ── 頭上ラベルの生成 ──
  const nickname = fromInfo?.nickname || fromInfo?.from?.nickname || '?';
  const label = createLockLabel('🔒 ' + nickname);
  group.add(label);

  // バウンディングボックスに基づいて配置
  updateLockOverlayPosition(group, obj);

  scene.add(group);
  lockOverlays.set(objectId, { group, target: obj });
}

function createCornerLines(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const min = box.min;
  const max = box.max;
  const size = box.getSize(new THREE.Vector3());
  // 角線の長さはボックスの最長辺の 20%
  const len = Math.max(size.x, size.y, size.z) * 0.2;

  // 8 つの角 × 3 方向 = 24 本の線分 = 48 頂点
  const corners = [
    [min.x, min.y, min.z],
    [max.x, min.y, min.z],
    [min.x, max.y, min.z],
    [max.x, max.y, min.z],
    [min.x, min.y, max.z],
    [max.x, min.y, max.z],
    [min.x, max.y, max.z],
    [max.x, max.y, max.z],
  ];

  const dirs = [
    // 各角から 3 方向への単位ベクトル
    [[1,0,0],[0,1,0],[0,0,1]],
    [[-1,0,0],[0,1,0],[0,0,1]],
    [[1,0,0],[0,-1,0],[0,0,1]],
    [[-1,0,0],[0,-1,0],[0,0,1]],
    [[1,0,0],[0,1,0],[0,0,-1]],
    [[-1,0,0],[0,1,0],[0,0,-1]],
    [[1,0,0],[0,-1,0],[0,0,-1]],
    [[-1,0,0],[0,-1,0],[0,0,-1]],
  ];

  const points = [];
  for (let i = 0; i < 8; i++) {
    const [cx, cy, cz] = corners[i];
    for (const [dx, dy, dz] of dirs[i]) {
      points.push(cx, cy, cz);
      points.push(cx + dx * len, cy + dy * len, cz + dz * len);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0xff8800,
    linewidth: 2,
    transparent: true,
    opacity: 0.8,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.raycast = () => {};
  return lines;
}

function createLockLabel(text) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 256;
  canvas.height = 64;

  ctx.clearRect(0, 0, 256, 64);

  // 背景（角丸）
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  roundRect(ctx, 4, 4, 248, 56, 12);
  ctx.fill();

  // テキスト
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ff8800';
  ctx.fillText(text, 128, 32);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const mat = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false, // 常に前面に描画
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2, 0.5, 1);
  sprite.raycast = () => {};
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
```

### ロック表示の位置更新関数

```javascript
function updateLockOverlayPosition(group, obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  // 角線を更新（古いのを除去して再生成）
  const oldLines = group.children.find(c => c.isLineSegments);
  if (oldLines) {
    group.remove(oldLines);
    oldLines.geometry.dispose();
    oldLines.material.dispose();
  }
  const newLines = createCornerLines(obj);
  group.add(newLines);

  // ラベルをボックス上部に配置
  const label = group.children.find(c => c.isSprite);
  if (label) {
    label.position.set(center.x, box.max.y + size.y * 0.3 + 0.5, center.z);
  }
}
```

### アニメーションループでの更新

animate 関数内に追加:

```javascript
function animate() {
  requestAnimationFrame(animate);
  orbit.update();

  // ロック表示の追従更新
  for (const [objectId, entry] of lockOverlays) {
    if (entry.target && entry.group) {
      updateLockOverlayPosition(entry.group, entry.target);
    }
  }

  renderer.render(scene, camera);
}
```

### removeLockOverlay を置き換え

```javascript
// 変更後
function removeLockOverlay(objectId) {
  const entry = lockOverlays.get(objectId);
  if (!entry) return;

  const { group } = entry;
  scene.remove(group);
  group.traverse(child => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (child.material.map) child.material.map.dispose();
      child.material.dispose();
    }
  });

  lockOverlays.delete(objectId);
}
```

### scene-lock ハンドラの変更

`fromInfo` を渡すように変更:

```javascript
// 変更前
case 'scene-lock': {
  locks.set(payload.objectId, data.from);
  addLockOverlay(payload.objectId);
  break;
}

// 変更後
case 'scene-lock': {
  locks.set(payload.objectId, data.from);
  addLockOverlay(payload.objectId, data.from);
  break;
}
```

---

## 修正 2: Mac Delete キー対応

### 変更箇所: keydown イベントハンドラ

```javascript
window.addEventListener('keydown', (e) => {
  // テキスト入力中は無視
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  switch (e.key.toLowerCase()) {
    case 'w': transformCtrl.setMode('translate'); break;
    case 'e': transformCtrl.setMode('rotate'); break;
    case 'r': transformCtrl.setMode('scale'); break;
    case 'escape':
      if (transformCtrl.object) {
        broadcast({
          kind: 'scene-unlock',
          objectId: transformCtrl.object.userData.objectId,
        });
      }
      transformCtrl.detach();
      hideToolbar();
      break;
    case 'delete':
    case 'backspace': {
      e.preventDefault(); // Mac のブラウザ「戻る」を防止
      deleteSelectedObject();
      break;
    }
  }
});
```

---

## 修正 3: スマートフォン向けツールバー

### scene.html に HTML 追加

```html
<!-- 既存の add-btn の後に追加 -->
<div id="mobile-toolbar" style="display:none;">
  <button id="btn-move" class="tb-btn active" title="移動">☩</button>
  <button id="btn-rotate" class="tb-btn" title="回転">↻</button>
  <button id="btn-scale" class="tb-btn" title="スケール">⤡</button>
  <button id="btn-delete" class="tb-btn btn-danger" title="削除">🗑</button>
  <button id="btn-deselect" class="tb-btn" title="選択解除">✕</button>
</div>
```

### scene.html に CSS 追加

```css
#mobile-toolbar {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 8px;
  z-index: 50;
}
.tb-btn {
  width: 44px;
  height: 44px;
  border: none;
  border-radius: 10px;
  background: rgba(255,255,255,0.15);
  color: #fff;
  font-size: 18px;
  cursor: pointer;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.tb-btn.active {
  background: rgba(68,136,255,0.6);
}
.tb-btn.btn-danger {
  background: rgba(255,60,60,0.5);
}
.tb-btn:hover {
  background: rgba(255,255,255,0.3);
}
.tb-btn.btn-danger:hover {
  background: rgba(255,60,60,0.7);
}
```

### scene.js にツールバーロジック追加

```javascript
// ── モバイルツールバー ───────────────────────────────────

const toolbar = document.getElementById('mobile-toolbar');
const btnMove = document.getElementById('btn-move');
const btnRotate = document.getElementById('btn-rotate');
const btnScale = document.getElementById('btn-scale');
const btnDelete = document.getElementById('btn-delete');
const btnDeselect = document.getElementById('btn-deselect');

function showToolbar() {
  if (toolbar) toolbar.style.display = 'flex';
}

function hideToolbar() {
  if (toolbar) toolbar.style.display = 'none';
}

function updateToolbarActive(mode) {
  [btnMove, btnRotate, btnScale].forEach(b => b?.classList.remove('active'));
  if (mode === 'translate') btnMove?.classList.add('active');
  if (mode === 'rotate') btnRotate?.classList.add('active');
  if (mode === 'scale') btnScale?.classList.add('active');
}

btnMove?.addEventListener('click', () => {
  transformCtrl.setMode('translate');
  updateToolbarActive('translate');
});

btnRotate?.addEventListener('click', () => {
  transformCtrl.setMode('rotate');
  updateToolbarActive('rotate');
});

btnScale?.addEventListener('click', () => {
  transformCtrl.setMode('scale');
  updateToolbarActive('scale');
});

btnDeselect?.addEventListener('click', () => {
  if (transformCtrl.object) {
    broadcast({
      kind: 'scene-unlock',
      objectId: transformCtrl.object.userData.objectId,
    });
  }
  transformCtrl.detach();
  hideToolbar();
});

btnDelete?.addEventListener('click', () => {
  deleteSelectedObject();
});
```

### 削除ロジックの共通化

```javascript
function deleteSelectedObject() {
  const attached = transformCtrl.object;
  if (!attached) return;

  let deleteId = null;
  for (const [id, obj] of managedObjects) {
    if (obj === attached) {
      deleteId = id;
      break;
    }
  }

  transformCtrl.detach();
  hideToolbar();

  if (deleteId) {
    if (locks.has(deleteId)) {
      showToast('他のユーザーが編集中です');
      return;
    }

    // ロックオーバーレイがあれば除去
    removeLockOverlay(deleteId);

    scene.remove(attached);
    attached.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });
    managedObjects.delete(deleteId);
    broadcast({ kind: 'scene-remove', objectId: deleteId });
  }
}
```

### 選択時にツールバー表示

dblclick ハンドラ内、`transformCtrl.attach(obj)` の後に追加:

```javascript
transformCtrl.attach(obj);
broadcast({ kind: 'scene-lock', objectId: obj.userData.objectId });
showToolbar();
updateToolbarActive(transformCtrl.mode);
```

選択解除時（空クリック）に非表示:

```javascript
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
```

---

## 確認方法

### 修正 1（角線 + ラベル）
1. Unity でオブジェクトを選択
2. ブラウザでそのオブジェクトにオレンジ色の角線が表示されること
3. 角線がオブジェクトの形状ではなくバウンディングボックスの角に表示されること
4. オブジェクト上部に「🔒 Unity」のようなラベルが表示されること

### 修正 1（追従）
1. Unity でオブジェクトを選択した状態で移動・回転・スケール変更
2. ブラウザの角線とラベルがリアルタイムに追従すること

### 修正 2（Mac Delete）
1. Mac でオブジェクトを選択して Delete キーを押す
2. オブジェクトが削除されること
3. Fn + Delete でも削除されること
4. テキスト入力中は Delete で削除が発動しないこと

### 修正 3（スマホ削除）
1. iPhone/Android でオブジェクトをダブルタップして選択
2. 画面下部にツールバー（移動・回転・スケール・削除・選択解除）が表示
3. 削除ボタンをタップしてオブジェクトが削除されること
4. 他のクライアントからも削除が反映されること
5. 選択解除ボタンでツールバーが消えること

## 完了条件

- [ ] ロック表示がバウンディングボックスの角線で表示される
- [ ] ロック者のニックネーム付きラベルがオブジェクト上部に表示される
- [ ] 角線とラベルがオブジェクトの移動・回転・スケールに追従する
- [ ] Mac の Delete キー（Backspace）で削除できる
- [ ] Backspace によるブラウザ「戻る」が防止されている
- [ ] テキスト入力中は削除が発動しない
- [ ] スマートフォンでツールバーが表示・操作できる
- [ ] 削除ロジックが共通関数化されている
- [ ] 既存の同期機能に影響がないこと
