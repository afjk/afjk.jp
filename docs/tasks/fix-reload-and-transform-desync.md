```markdown
# fix-reload-and-transform-desync.md

## 概要

2つの問題を修正する:
1. 複数参加者がいる状態で一人がリロードすると、応答側クライアントのオブジェクトが一瞬原点に飛ぶ（表示がちらつく）
2. 後から参加したクライアントでオブジェクトを移動させると、原点からの移動になり位置がズレる

## 原因分析

### 問題 1: リロード時の表示ちらつき

`respondToSceneRequest` で各オブジェクトの transform をリセット（position を (0,0,0) に設定）してからエクスポートし、完了後に復元する。エクスポートは `async` で時間がかかるため、リセット中のフレームがレンダリングされてしまい、オブジェクトが一瞬原点に飛ぶ。

### 問題 2: 移動時の原点ズレ

`handleAddMeshFile` で子メッシュを `center` 分オフセットし、再エクスポートしてアップロードしている。この glB には子メッシュのオフセットがベイクされている。

後から参加したクライアントが `addOrUpdateObject` → `gltfLoader.load` で読み込むと、`gltf.scene` 内の子メッシュはオフセット済み。`applyTransform` で `gltf.scene.position` を設定するが、子のローカル位置がオフセット込みのため、見た目の中心とルートの position が一致しない。

TransformControls はルートの `position` を操作するが、メッシュの見た目の中心はオフセット分ずれているため、ドラッグ結果が他のクライアントと一致しない。

## 対象ファイル

- `html/assets/js/pipe/scene.js`

## 修正内容

### 修正 1: respondToSceneRequest – clone を使いレンダリングに影響を与えない

オブジェクト本体の transform をリセットする代わりに、エクスポート用の一時クローンを作成する。クローンの transform をリセットしてエクスポートし、本体には一切触れない。

変更前（`respondToSceneRequest` 内の `if (hasMesh)` ブロック全体）:

```js
    if (hasMesh) {
      // エクスポート前にルート transform をリセット
      const savedPos = obj.position.clone();
      const savedQuat = obj.quaternion.clone();
      const savedScale = obj.scale.clone();

      obj.position.set(0, 0, 0);
      obj.quaternion.identity();
      obj.scale.set(1, 1, 1);

      try {
        const glbBuffer = await exportObjectAsGlb(obj);
        if (glbBuffer) {
          const meshPath = generateRandomPath();
          uploads.push({ meshPath, buffer: glbBuffer });
          entry.meshPath = meshPath;
        }
      } catch (err) {
        console.warn('[SceneSync] Export failed for', objectId, err);
      }

      // ルート transform を復元
      obj.position.copy(savedPos);
      obj.quaternion.copy(savedQuat);
      obj.scale.copy(savedScale);
    }
```

変更後:

```js
    if (hasMesh) {
      try {
        // エクスポート用クローンを作成（本体の transform を変更しない）
        const clone = obj.clone(true);
        clone.position.set(0, 0, 0);
        clone.quaternion.identity();
        clone.scale.set(1, 1, 1);

        const glbBuffer = await exportObjectAsGlb(clone);
        if (glbBuffer) {
          const meshPath = generateRandomPath();
          uploads.push({ meshPath, buffer: glbBuffer });
          entry.meshPath = meshPath;
        }
      } catch (err) {
        console.warn('[SceneSync] Export failed for', objectId, err);
      }
    }
```

### 修正 2: handleAddMeshFile – 再エクスポートでも clone を使用

変更前（`handleAddMeshFile` 内の再エクスポート部分）:

```js
    // オフセット済みモデルを再エクスポートしてアップロード
    // ルート transform を一時リセットしてエクスポート
    const savedPos = model.position.clone();
    const savedQuat = model.quaternion.clone();
    const savedScale = model.scale.clone();

    model.position.set(0, 0, 0);
    model.quaternion.identity();
    model.scale.set(1, 1, 1);

    let reExportedBuffer = null;
    try {
      reExportedBuffer = await exportObjectAsGlb(model);
    } catch (err) {
      console.warn('[SceneSync] Re-export failed:', err);
    }

    // ルート transform を復元
    model.position.copy(savedPos);
    model.quaternion.copy(savedQuat);
    model.scale.copy(savedScale);

    uploadAndBroadcast(
      objectId,
      file.name,
      model,
      reExportedBuffer || arrayBuffer
    );
```

変更後:

```js
    // オフセット済みモデルを再エクスポートしてアップロード
    // クローンを作成し transform をリセット（本体には触れない）
    let reExportedBuffer = null;
    try {
      const clone = model.clone(true);
      clone.position.set(0, 0, 0);
      clone.quaternion.identity();
      clone.scale.set(1, 1, 1);
      reExportedBuffer = await exportObjectAsGlb(clone);
    } catch (err) {
      console.warn('[SceneSync] Re-export failed:', err);
    }

    uploadAndBroadcast(
      objectId,
      file.name,
      model,
      reExportedBuffer || arrayBuffer
    );
```

### 修正 3: addOrUpdateObject – 読み込んだモデルの子をフラット化して位置の一貫性を保つ

`gltfLoader.load` で取得した `gltf.scene` は `THREE.Scene` または `THREE.Group` で、その子にモデルのルートノードが入る。この入れ子構造のまま `managedObjects` に登録すると、子のローカル transform とルートの transform が分離し、TransformControls のドラッグ結果がずれる。

これを修正するため、読み込んだモデルの BoundingBox 中心を計算し、子を中心基準でオフセットし直す。これにより、どのクライアントでも「ルートの position = オブジェクトの見た目の中心」が成り立つ。

変更前（`addOrUpdateObject` 全体）:

```js
function addOrUpdateObject(objectId, info) {
  let obj = managedObjects.get(objectId);

  if (info.meshPath) {
    const url = BLOB_BASE + '/' + info.meshPath;
    gltfLoader.load(url, (gltf) => {
      if (obj) scene.remove(obj);
      const model = gltf.scene;
      model.userData.objectId = objectId;
      model.userData.name = info.name;
      applyTransform(model, info);
      scene.add(model);
      managedObjects.set(objectId, model);
    }, undefined, (err) => {
      console.warn('Failed to load mesh for', objectId, ':', err);
      if (!obj) {
        const geo = new THREE.BoxGeometry(1, 1, 1);
        const mat = new THREE.MeshStandardMaterial({ color: 0xff4444 });
        obj = new THREE.Mesh(geo, mat);
        obj.userData.objectId = objectId;
        obj.userData.name = info.name;
        applyTransform(obj, info);
        scene.add(obj);
        managedObjects.set(objectId, obj);
      }
    });
  } else {
    if (!obj) {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const mat = new THREE.MeshStandardMaterial({ color: 0x4488ff });
      obj = new THREE.Mesh(geo, mat);
      obj.userData.objectId = objectId;
      obj.userData.name = info.name;
      scene.add(obj);
      managedObjects.set(objectId, obj);
    }
    applyTransform(obj, info);
  }
}
```

変更後:

```js
function addOrUpdateObject(objectId, info) {
  const existing = managedObjects.get(objectId);

  if (info.meshPath) {
    const url = BLOB_BASE + '/' + info.meshPath;
    gltfLoader.load(url, (gltf) => {
      // 既存オブジェクトを削除（非同期なので再取得）
      const current = managedObjects.get(objectId);
      if (current) {
        if (transformCtrl.object === current) transformCtrl.detach();
        scene.remove(current);
      }

      const model = gltf.scene;
      model.userData.objectId = objectId;
      model.userData.name = info.name;

      // glB 内の子メッシュを中心基準でオフセットし直す
      // （送信側と同じ中心合わせを行い、ルート position = 見た目の中心にする）
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      model.children.forEach(child => {
        child.position.sub(center);
      });

      applyTransform(model, info);
      scene.add(model);
      managedObjects.set(objectId, model);
    }, undefined, (err) => {
      console.warn('Failed to load mesh for', objectId, ':', err);
      if (!existing) {
        const geo = new THREE.BoxGeometry(1, 1, 1);
        const mat = new THREE.MeshStandardMaterial({ color: 0xff4444 });
        const fallback = new THREE.Mesh(geo, mat);
        fallback.userData.objectId = objectId;
        fallback.userData.name = info.name;
        applyTransform(fallback, info);
        scene.add(fallback);
        managedObjects.set(objectId, fallback);
      }
    });
  } else {
    if (!existing) {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      const mat = new THREE.MeshStandardMaterial({ color: 0x4488ff });
      const obj = new THREE.Mesh(geo, mat);
      obj.userData.objectId = objectId;
      obj.userData.name = info.name;
      scene.add(obj);
      managedObjects.set(objectId, obj);
    }
    applyTransform(managedObjects.get(objectId), info);
  }
}
```

### 修正 4: scene-mesh ハンドラも同様に中心合わせを追加

変更前（`handleHandoff` 内の `scene-mesh` case）:

```js
    case 'scene-mesh': {
      const obj = managedObjects.get(payload.objectId);
      const url = BLOB_BASE + '/' + payload.meshPath;
      gltfLoader.load(url, (gltf) => {
        const model = gltf.scene;
        model.userData.objectId = payload.objectId;
        if (obj) {
          model.position.copy(obj.position);
          model.quaternion.copy(obj.quaternion);
          model.scale.copy(obj.scale);
          if (transformCtrl.object === obj) transformCtrl.detach();
          scene.remove(obj);
        }
        scene.add(model);
        managedObjects.set(payload.objectId, model);
      }, undefined, (err) => {
        console.warn('Failed to load mesh:', err);
        if (!obj) {
          const geo = new THREE.BoxGeometry(1, 1, 1);
          const mat = new THREE.MeshStandardMaterial({ color: 0xff4444 });
          const fallback = new THREE.Mesh(geo, mat);
          fallback.userData.objectId = payload.objectId;
          scene.add(fallback);
          managedObjects.set(payload.objectId, fallback);
        }
      });
      break;
    }
```

変更後:

```js
    case 'scene-mesh': {
      const obj = managedObjects.get(payload.objectId);
      const url = BLOB_BASE + '/' + payload.meshPath;
      gltfLoader.load(url, (gltf) => {
        const model = gltf.scene;
        model.userData.objectId = payload.objectId;

        // 中心合わせ
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        model.children.forEach(child => {
          child.position.sub(center);
        });

        if (obj) {
          model.position.copy(obj.position);
          model.quaternion.copy(obj.quaternion);
          model.scale.copy(obj.scale);
          if (transformCtrl.object === obj) transformCtrl.detach();
          scene.remove(obj);
        }
        scene.add(model);
        managedObjects.set(payload.objectId, model);
      }, undefined, (err) => {
        console.warn('Failed to load mesh:', err);
        if (!obj) {
          const geo = new THREE.BoxGeometry(1, 1, 1);
          const mat = new THREE.MeshStandardMaterial({ color: 0xff4444 });
          const fallback = new THREE.Mesh(geo, mat);
          fallback.userData.objectId = payload.objectId;
          scene.add(fallback);
          managedObjects.set(payload.objectId, fallback);
        }
      });
      break;
    }
```

## 修正箇所まとめ

| 箇所 | 問題 | 修正 |
|---|---|---|
| `respondToSceneRequest` | 本体の transform をリセットするため一瞬ちらつく | clone を使い本体に触れない |
| `handleAddMeshFile` | 同上（再エクスポート時） | clone を使い本体に触れない |
| `addOrUpdateObject` | 読み込んだモデルの子オフセットとルート position がずれる | 読み込み後に中心合わせを実行 |
| `scene-mesh` ハンドラ | 同上 | 読み込み後に中心合わせを実行 |

## 確認手順

### 問題 1（リロード時のちらつき）の確認
1. ブラウザ A と B で同じルームに接続し、複数の glB を配置する
2. ブラウザ A をリロードする
3. ブラウザ B の表示で**オブジェクトが一瞬原点に飛ばない**ことを確認する
4. ブラウザ A にシーンが正しく同期されることを確認する

### 問題 2（移動時の原点ズレ）の確認
1. ブラウザ A で glB を配置する（例: 位置 [3, 0, 2]）
2. ブラウザ B で同じルームに参加する
3. ブラウザ B でそのオブジェクトをダブルクリックして選択する
4. TransformControls で移動させる
5. ブラウザ A で**移動後の位置が B と一致する**ことを確認する
6. 逆方向（A で移動 → B で確認）も検証する

### 追加検証
7. 3人以上で接続し、1人がリロードしても他の全員の表示が安定していることを確認する
8. sample-cube も含めて全オブジェクトが正しく同期されることを確認する

## 完了条件

- [ ] `respondToSceneRequest` でオブジェクト本体の transform を変更していない（clone 使用）
- [ ] `handleAddMeshFile` でオブジェクト本体の transform を変更していない（clone 使用）
- [ ] `addOrUpdateObject` で読み込んだモデルに中心合わせを実行している
- [ ] `scene-mesh` ハンドラで読み込んだモデルに中心合わせを実行している
- [ ] リロード時に応答側クライアントでちらつきが発生しない
- [ ] 後から参加したクライアントでオブジェクトの位置が正しい
- [ ] 後から参加したクライアントでオブジェクトを移動しても他クライアントと位置が一致する
- [ ] 既存の scene-delta によるリアルタイム同期に影響がない
- [ ] 既存の scene-add による即時同期に影響がない
- [ ] sample-cube を含む全オブジェクトが正しく同期される
```
