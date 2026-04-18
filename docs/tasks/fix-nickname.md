# Fix: Web ビューアのユーザー名設定

## 概要

Web ビューアの nickname が全員 "SceneViewer" になる問題を修正。
既存の pipe 機能で使われている `localStorage` の `pipe.deviceName` を
そのまま利用する。

### 対象ファイル

- `html/assets/js/pipe/scene.js`

---

## 原因

`connectPresence` 内で nickname が `'SceneViewer'` にハードコードされている。
同じオリジンの `/pipe/index.html` で設定された `pipe.deviceName` が
localStorage に保存されているが、scene.js はそれを参照していない。

---

## 変更内容

### ニックネーム解決関数を追加

```javascript
function resolveNickname() {
  // 1. URL パラメータ ?name=Taro（上書き用）
  const params = new URLSearchParams(location.search);
  const nameParam = params.get('name');
  if (nameParam) return nameParam;

  // 2. pipe の既存デバイス名を利用
  const deviceName = localStorage.getItem('pipe.deviceName');
  if (deviceName) return deviceName;

  // 3. フォールバック: ランダム生成
  return 'User-' + Math.random().toString(36).slice(2, 6);
}
```

### connectPresence 内の hello メッセージを変更

```javascript
// 変更前
ws.send(JSON.stringify({
  type: 'hello',
  nickname: 'SceneViewer',
  device: navigator.userAgent.slice(0, 60),
}));

// 変更後
const nickname = resolveNickname();
presenceState.nickname = nickname;
ws.send(JSON.stringify({
  type: 'hello',
  nickname: nickname,
  device: navigator.userAgent.slice(0, 60),
}));
```

### ステータス表示にニックネームを追加

```javascript
// 変更前
statusEl.innerHTML = `<span class="dot on"></span>${presenceState.room || '—'} · ${n} peer${n !== 1 ? 's' : ''}`;

// 変更後
statusEl.innerHTML = `<span class="dot on"></span>${presenceState.nickname} · ${presenceState.room || '—'} · ${n} peer${n !== 1 ? 's' : ''}`;
```

---

## 使い方

1. 先に `/pipe/` にアクセスしてデバイス名を設定済み → その名前が使われる
2. `?name=Taro` で URL パラメータ指定 → パラメータが優先
3. どちらもない → `User-xxxx` が自動生成

---

## 確認方法

1. `/pipe/` でデバイス名を "MyPC" に設定
2. `/pipe/scene.html?room=test` にアクセス
3. ステータスバーに "MyPC" と表示されること
4. 別デバイスからロックしたオブジェクトに "🔒 MyPC" と表示されること
5. `?name=Alice` でアクセス → "Alice" が優先されること
6. pipe でデバイス名未設定・name パラメータなし → "User-xxxx" が表示

## 完了条件

- [ ] `pipe.deviceName` から nickname を取得している
- [ ] URL パラメータ `?name=` で上書きできる
- [ ] 未設定時はランダム名が生成される
- [ ] ステータスバーに自分の名前が表示される
- [ ] ロックラベルに相手の名前が正しく表示される
- [ ] 既存の pipe 機能に影響がないこと
