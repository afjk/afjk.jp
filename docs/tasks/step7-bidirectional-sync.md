# Step 7: 全方向同期

## 目的

ブラウザの TransformControls で操作した結果が Unity 側にも反映される
双方向同期を実現する。Browser → Unity、Unity → Unity の全方向で動作する。

---

## 処理フロー

    1. ブラウザで TransformControls によりオブジェクトを操作する
    2. scene-delta を broadcast で送信する
    3. Unity が scene-delta を受信して Transform を更新する

---

## ブラウザ側の実装（scene.js に追加）

### TransformControls の操作を broadcast

    let isDragging = false;
    let dragIntervalId = null;

    transformCtrl.addEventListener('dragging-changed', (e) => {
      orbit.enabled = !e.value;
      isDragging = e.value;

      if (isDragging) {
        dragIntervalId = setInterval(() => {
          sendSelectedDelta();
        }, 50); // 20fps スロットリング
      } else {
        clearInterval(dragIntervalId);
        dragIntervalId = null;
        sendSelectedDelta(); // 最終値を確実に送信
      }
    });

    function sendSelectedDelta() {
      const obj = transformCtrl.object;
      if (!obj || !obj.userData.objectId) return;

      broadcast({
        kind: 'scene-delta',
        objectId: obj.userData.objectId,
        position: obj.position.toArray(),
        rotation: obj.quaternion.toArray(),
        scale: obj.scale.toArray(),
      });
    }

### 自分の送信した delta を無視する

scene-delta 受信時、from.id が自分と同じなら無視する。

    case 'scene-delta': {
      if (data.from.id === presenceState.id) break; // 自分の echo は無視
      const obj = managedObjects.get(payload.objectId);
      if (!obj) break;
      if (payload.position) obj.position.fromArray(payload.position);
      if (payload.rotation) obj.quaternion.fromArray(payload.rotation);
      if (payload.scale) obj.scale.fromArray(payload.scale);
      break;
    }

---

## Unity 受信側の実装

### scene-delta 受信 → Transform 更新

    private void HandleSceneDelta(string objectId, float[] pos, float[] rot, float[] scl)
    {
        // objectId → GameObject のマッピング（managedObjects Dictionary）
        var go = FindManagedObject(objectId);
        if (go == null) return;

        // ワイヤー（Three.js 座標系）→ Unity 座標系に逆変換
        if (pos != null && pos.Length >= 3)
            go.transform.position = new Vector3(pos[0], pos[1], -pos[2]);

        if (rot != null && rot.Length >= 4)
            go.transform.rotation = new Quaternion(-rot[0], -rot[1], rot[2], rot[3]);

        if (scl != null && scl.Length >= 3)
            go.transform.localScale = new Vector3(scl[0], scl[1], scl[2]);
    }

### 自分が送信した delta との衝突を防ぐ

受信した delta が自分の操作中のオブジェクトと同一の場合、
自分が現在そのオブジェクトを Selection で選択して操作中でなければ反映する。
操作中の場合は無視して Last-Writer-Wins を維持する。

---

## 動作確認

### 1. Unity と ブラウザ を同じルームに接続して初回同期を完了する
### 2. ブラウザで Cube をダブルクリック → TransformControls で移動
### 3. Unity 側で Cube の位置が追従する
### 4. Unity 側で Cube を移動 → ブラウザ側で追従する
### 5. 2つの Unity Editor を接続し、一方で移動 → 他方で追従する

---

## 完了条件

- [ ] ブラウザから操作すると scene-delta が broadcast される
- [ ] Unity が scene-delta を受信して Transform を更新する
- [ ] Unity → ブラウザ、ブラウザ → Unity の双方向で動作する
- [ ] Unity → Unity の同期が動作する
- [ ] 自分自身の echo は無視される
- [ ] 50ms スロットリングが動作する
