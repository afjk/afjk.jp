# Fix: Web ビューア UX 改善

## 概要

Web ビューア（scene.js）の操作性を改善する 3 件の修正。

## 問題一覧

| # | 内容 | 重要度 |
|---|------|--------|
| 1 | glB 読み込み時の表示位置が不定 | 高 |
| 2 | Del キーで選択中オブジェクトを削除できない | 中 |
| 3 | ロック中オブジェクトを選択できない理由が分からない | 中 |

### 対象ファイル

- `html/assets/js/pipe/scene.js`
- `html/pipe/scene.html`（CSS 追加のみ）

---

## 修正 1: glB の表示位置をカメラ前方に固定

### 原因

glB モデル自体に原点からオフセットされたジオメトリが含まれている場合、
読み込み後の位置がモデル内部の座標に依存して不定になる。

### 方針

読み込み後にバウンディングボックスを計算し、モデルの中心を原点に補正した上で
カメラの前方 5m に配置する。

### 変更箇所: handleAddMeshFile 関数

```javascript
// 変更前（カメラ前方に配置しているが、モデル内部のオフセットが残る）
const dir = new THREE.Vector3();
camera.getWorldDirection(dir);
root.position.copy(camera.position).addScaledVector(dir, 5);

// 変更後
// 1. バウンディングボックスでモデルの中心を算出
const box = new THREE.Box3().setFromObject(root);
const center = box.getCenter(new THREE.Vector3());

// 2. 子メッシュをオフセットして中心を原点に揃える
root.children.forEach(child => {
  child.position.sub(center);
});

// 3. カメラ前方 5m に配置
const dir = new THREE.Vector3();
camera.getWorldDirection(dir);
root.position.copy(camera.position).addScaledVector(dir, 5);
```

---

## 修正 2: Del キーでオブジェクト削除

### 原因

現在のキーボードイベントで Del / Backspace が TransformControls の
detach のみを行っており、オブジェクト自体の削除を行っていない。

### 方針

TransformControls がオブジェクトにアタッチされている状態で
Del キーを押すと、ローカル削除 + scene-remove ブロードキャストを行う。

### 変更箇所: keydown イベントハンドラ

```javascript
// 変更前
case 'Delete':
case 'Backspace':
  transformControls.detach();
  break;

// 変更後
case 'Delete':
case 'Backspace': {
  const attached = transformControls.object;
  if (!attached) break;

  // objectId を探す
  let deleteId = null;
  for (const [id, obj] of managedObjects) {
    if (obj === attached) {
      deleteId = id;
      break;
    }
  }

  // TransformControls を外す
  transformControls.detach();

  if (deleteId) {
    // ロック中なら削除不可
    if (locks.has(deleteId)) {
      showToast('他のユーザーが編集中です');
      break;
    }

    // シーンから削除
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

    // ブロードキャスト
    broadcast({ kind: 'scene-remove', objectId: deleteId });
  }
  break;
}
```

---

## 修正 3: ロック状態の視覚フィードバック

### 方針

3 つのフィードバックを追加する。

1. ロック中のオブジェクトにオレンジ色のアウトライン（半透明ワイヤーフレーム）を表示
2. ダブルクリックでロック中オブジェクトを選択しようとした時にトースト通知
3. ロック者のニックネームをトーストに表示

### 3-A: ロックオブジェクトのハイライト表示

scene-lock / scene-unlock 受信時にワイヤーフレームを追加・除去する。

```javascript
const lockOverlays = new Map(); // objectId → wireframe mesh

function addLockOverlay(objectId) {
  const obj = managedObjects.get(objectId);
  if (!obj) return;

  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xff8800,
    wireframe: true,
    transparent: true,
    opacity: 0.5,
  });
  const wire = new THREE.Mesh(geo, mat);
  wire.position.copy(center);
  wire.raycast = () => {}; // レイキャストから除外
  scene.add(wire);
  lockOverlays.set(objectId, wire);
}

function removeLockOverlay(objectId) {
  const wire = lockOverlays.get(objectId);
  if (!wire) return;
  scene.remove(wire);
  wire.geometry.dispose();
  wire.material.dispose();
  lockOverlays.delete(objectId);
}
```

scene-lock / scene-unlock のハンドラに組み込む:

```javascript
// scene-lock 受信時（既存の locks.set の後に追加）
locks.set(p.objectId, p);
addLockOverlay(p.objectId);

// scene-unlock 受信時（既存の locks.delete の後に追加）
locks.delete(p.objectId);
removeLockOverlay(p.objectId);
```

### 3-B: ダブルクリック時のトースト通知

```javascript
// ダブルクリックのレイキャスト後、ロックチェック部分を変更

// 変更前
if (locks.has(objectId)) return; // 無言でスキップ

// 変更後
if (locks.has(objectId)) {
  const lockInfo = locks.get(objectId);
  const who = lockInfo.nickname || lockInfo.from?.nickname || '他のユーザー';
  showToast(`${who} が編集中です`);
  return;
}
```

### 3-C: トースト通知の実装

scene.html に CSS を追加:

```css
#toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.8);
  color: #fff;
  padding: 8px 20px;
  border-radius: 8px;
  font-size: 14px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.3s;
  z-index: 100;
}
#toast.show {
  opacity: 1;
}
```

scene.html の body に追加:

```html
<div id="toast"></div>
```

scene.js にトースト関数を追加:

```javascript
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}
```

---

## 確認方法

### 修正 1
1. ブラウザで scene.html を開く
2. 大きなモデル（原点からオフセットされた glB）を追加
3. モデルがカメラ前方の見える位置に表示されることを確認

### 修正 2
1. オブジェクトをダブルクリックで選択
2. Del キーを押す
3. オブジェクトがシーンから削除されることを確認
4. 他のクライアントからも消えることを確認

### 修正 3
1. Unity でオブジェクトを選択（ロック送信）
2. ブラウザでそのオブジェクトにオレンジのワイヤーフレームが表示されることを確認
3. ブラウザでロック中のオブジェクトをダブルクリック
4. 「Unity が編集中です」のトーストが表示されることを確認
5. Unity で選択解除後、ワイヤーフレームが消えることを確認

## 完了条件

- [ ] glB がカメラ前方の予測可能な位置に配置される
- [ ] Del キーで選択中オブジェクトが削除・ブロードキャストされる
- [ ] ロック中オブジェクトに Del を押しても削除されない
- [ ] ロック中オブジェクトにオレンジワイヤーフレームが表示される
- [ ] ロック中オブジェクトのダブルクリックでトースト通知が出る
- [ ] ロック解除でワイヤーフレームが消える
- [ ] 既存の同期機能に影響がないこと
