```markdown
# fix-late-join-transform.md

## 概要

後から参加したクライアントにシーンを同期する際、オブジェクトの位置・サイズにズレが発生する問題を修正する。

## 原因

1. `respondToSceneRequest` で GLTFExporter がオブジェクトをエクスポートする際、ルートの position/rotation/scale が glB にベイクされる。受信側で `applyTransform` により同じ transform を再適用するため、二重適用になる。
2. `handleAddMeshFile` で子メッシュを `center` 分オフセットしているが、アップロードには元ファイルの `arrayBuffer` を使用しているため、受信側ではオフセット前のモデルが読み込まれ位置がズレる。

## 対象ファイル

- `html/assets/js/pipe/scene.js`

## 修正内容

### 修正 1: `respondToSceneRequest` – エクスポート前にルート transform をリセット

`respondToSceneRequest` 関数内の `if (hasMesh)` ブロックを以下のように置き換える。

変更前:

```js
    if (hasMesh) {
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
    }
```

変更後:

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

### 修正 2: `handleAddMeshFile` – オフセット済みモデルを再エクスポートしてアップロード

`handleAddMeshFile` 関数全体を以下に置き換える。

```js
async function handleAddMeshFile(file) {
  const objectId = generateObjectId();
  const arrayBuffer = await file.arrayBuffer();

  const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });
  const blobUrl = URL.createObjectURL(blob);

  gltfLoader.load(blobUrl, async (gltf) => {
    const model = gltf.scene;
    model.userData.objectId = objectId;
    model.userData.name = file.name;

    // バウンディングボックスでモデルの中心を算出
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());

    // 子メッシュをオフセットして中心を原点に揃える
    model.children.forEach(child => {
      child.position.sub(center);
    });

    // カメラ前方 5m に配置
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    model.position.copy(camera.position).addScaledVector(dir, 5);
    model.position.y = 0;

    scene.add(model);
    managedObjects.set(objectId, model);

    URL.revokeObjectURL(blobUrl);

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
      reExportedBuffer || arrayBuffer  // 再エクスポート失敗時は元ファイルを使用
    );
  }, undefined, (err) => {
    console.error('Failed to load glB:', err);
    URL.revokeObjectURL(blobUrl);
  });
}
```

### 修正 3: `addOrUpdateObject` – 変更不要

エクスポート側がルート transform をリセット済みのため、受信側の `applyTransform` でそのまま正しい位置・回転・スケールが適用される。変更不要。

## 修正箇所まとめ

| 箇所 | 問題 | 修正 |
|---|---|---|
| `respondToSceneRequest` | ルート transform が glB にベイクされ受信側で二重適用 | エクスポート前にリセット、完了後に復元 |
| `handleAddMeshFile` | 子メッシュのオフセットが元ファイルに含まれず受信側でズレ | オフセット後に再エクスポートしたバイナリをアップロード |
| `addOrUpdateObject` | 変更不要 | — |

## 確認手順

1. ブラウザ A で glB を追加する（例: カメラ前方に配置される）
2. ブラウザ A でオブジェクトの位置・スケールをメモする（コンソールで `managedObjects.get('web-xxxx').position.toArray()` 等）
3. ブラウザ B で同じルームに参加する
4. ブラウザ B に表示されたモデルの位置・スケールが A と一致することを確認する
5. ブラウザ A でオブジェクトを移動・拡大し、B が追従することを確認する
6. ブラウザ B を閉じて再参加し、再度位置・スケールが正しいことを確認する

## 完了条件

- [ ] `respondToSceneRequest` でエクスポート前にルート transform をリセットしている
- [ ] `respondToSceneRequest` でエクスポート後にルート transform を復元している
- [ ] `handleAddMeshFile` でオフセット済みモデルを再エクスポートしてアップロードしている
- [ ] 再エクスポート失敗時は元ファイルにフォールバックしている
- [ ] 後から参加したクライアントでオブジェクトの位置が一致する
- [ ] 後から参加したクライアントでオブジェクトのスケールが一致する
- [ ] 既存の scene-delta によるリアルタイム同期に影響がない
- [ ] 既存の scene-add による即時同期に影響がない
```
