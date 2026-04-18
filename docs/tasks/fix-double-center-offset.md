```markdown
# fix-double-center-offset.md

## 概要

後から参加したクライアントでオブジェクトを移動させると、他のクライアントの空間では
原点からの移動になり位置がズレる問題を修正する。

## 原因

「子メッシュの中心合わせ（center offset）」が送信側と受信側で二重に適用されている。

### 詳細な流れ

1. クライアント A が `handleAddMeshFile` で glB を読み込む
2. `Box3.getCenter` で中心を計算し、`child.position.sub(center)` で子をオフセット
3. ルート transform をリセットした clone を `GLTFExporter` でエクスポート
4. この glB には **オフセット済みの子メッシュ位置がベイクされている**
5. blob store にアップロードし、`scene-add` を broadcast

6. クライアント B が `scene-add` または `scene-state` で受信
7. `addOrUpdateObject` → `gltfLoader.load` で glB を読み込む
8. **再度** `Box3.getCenter` → `child.position.sub(center)` を実行
9. 既にオフセット済みの子に対してさらにオフセットがかかる（**二重適用**）

結果:
- B のルート `position` は A と同じ値が `applyTransform` で設定される
- しかし子メッシュの見た目の位置が二重オフセット分ずれている
- B で TransformControls でドラッグすると、ルート `position` は正しく更新される
- しかし A 側ではオフセットが1回分なので、B から送られた position を適用すると
  見た目が異なる位置になる

## 対象ファイル

- `html/assets/js/pipe/scene.js`

## 修正方針

受信側（`addOrUpdateObject` と `scene-mesh` ハンドラ）での中心合わせを**削除**する。

送信側（`handleAddMeshFile`）で既にオフセット済みの glB をエクスポートしており、
`respondToSceneRequest` でも clone 経由でオフセット済みの状態がエクスポートされる。
受信側で再度オフセットする必要はない。

## 修正内容

### 修正 1: `addOrUpdateObject` – 中心合わせを削除

変更前（`gltfLoader.load` コールバック内）:

```js
      const model = gltf.scene;
      model.userData.objectId = objectId;
      model.userData.name = info.name;

      // glB 内の子メッシュを中心基準でオフセット
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      model.children.forEach(child => {
        child.position.sub(center);
      });

      applyTransform(model, info);
```

変更後:

```js
      const model = gltf.scene;
      model.userData.objectId = objectId;
      model.userData.name = info.name;

      // 中心合わせは送信側で実行済み（glB にベイク済み）のため不要
      applyTransform(model, info);
```

### 修正 2: `scene-mesh` ハンドラ – 中心合わせを削除

変更前（`handleHandoff` 内の `scene-mesh` case、`gltfLoader.load` コールバック内）:

```js
        const model = gltf.scene;
        model.userData.objectId = payload.objectId;

        // 中心合わせ
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        model.children.forEach(child => {
          child.position.sub(center);
        });

        if (obj) {
```

変更後:

```js
        const model = gltf.scene;
        model.userData.objectId = payload.objectId;

        // 中心合わせは送信側で実行済み（glB にベイク済み）のため不要

        if (obj) {
```

### 修正 3: `scene-add` 受信時の処理（`addOrUpdateObject` 経由）

`addOrUpdateObject` は `scene-add` と `scene-state` の両方で使用される。
修正 1 で中心合わせを削除すれば、両方のケースで正しく動作する。
追加の変更は不要。

## 変更しない箇所

以下は変更**しない**:

- `handleAddMeshFile` の中心合わせ: 元ファイルの glB を読み込んだ直後に
  中心を揃える処理。これは送信側の正規化であり必要。
- `respondToSceneRequest` の clone → エクスポート: clone には既に
  オフセット済みの子が含まれるため、そのままエクスポートすれば正しい。

## 修正箇所まとめ

| 箇所 | 変更内容 |
|---|---|
| `addOrUpdateObject` 内 `gltfLoader.load` コールバック | `Box3.getCenter` + `child.position.sub(center)` の3行を削除 |
| `scene-mesh` ハンドラ内 `gltfLoader.load` コールバック | `Box3.getCenter` + `child.position.sub(center)` の3行を削除 |

## 確認手順

### 基本確認
1. ブラウザ A で glB を追加する
2. コンソールで `managedObjects.get('web-xxxx').position.toArray()` を記録する
3. ブラウザ B で同じルームに参加する
4. B のコンソールで同じ objectId の position を確認し、A と一致することを確認する

### 移動の同期確認
5. ブラウザ B でオブジェクトをダブルクリックして選択する
6. TransformControls で右に 2m 移動する
7. ブラウザ A で同じオブジェクトが同じ位置に移動していることを**目視で**確認する
8. 両方のコンソールで position を比較し一致することを確認する

### 逆方向確認
9. ブラウザ A でオブジェクトを選択して移動する
10. ブラウザ B で位置が一致することを確認する

### 3人以上の確認
11. ブラウザ C で同じルームに参加する
12. C でオブジェクトを移動し、A と B の両方で位置が一致することを確認する

### scene-mesh の確認
13. ブラウザ A でメッシュを更新する操作（もしあれば）を行う
14. ブラウザ B で更新後のメッシュ位置が正しいことを確認する

## 完了条件

- [ ] `addOrUpdateObject` から中心合わせコードが削除されている
- [ ] `scene-mesh` ハンドラから中心合わせコードが削除されている
- [ ] `handleAddMeshFile` の中心合わせは維持されている
- [ ] `respondToSceneRequest` の clone エクスポートは維持されている
- [ ] 後から参加したクライアントでオブジェクトの初期位置が正しい
- [ ] 後から参加したクライアントでオブジェクトを移動しても他クライアントと一致する
- [ ] 元からいたクライアントでオブジェクトを移動しても後から参加したクライアントと一致する
- [ ] 3人以上の接続で位置の整合性が保たれる
- [ ] 既存の scene-delta / scene-add / scene-remove に影響がない
```
