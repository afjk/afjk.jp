# Scene Sync Deterministic Physics

Scene Sync で物理演算を複数クライアント間で同期するための決定論的物理エンジンライブラリの仕様です。

- 実装: `html/assets/js/scenesync/physics/`
  - `fixed.js` — 16.16 固定小数点数学(乗除算・平方根・vec3・PRNG・状態ハッシュ)
  - `world.js` — 決定論的物理ワールド(重力・衝突・スリープ・snapshot)
  - `lockstep.js` — コマンド同期(tick 固定・順序保証・rollback・再同期)
  - `index.js` — エントリポイント
- テスト: `npm run test:physics`

## 設計方針

物理の「状態」をネットワークでストリーミングするのではなく、**コマンド(入力)だけを broadcast** し、各クライアントが同一のシミュレーションを実行する lockstep 方式を採用する。

これが成立する条件は「全クライアントで演算結果がビット単位で一致する」ことであり、本ライブラリは以下で決定論を保証する。

1. **16.16 固定小数点整数演算のみ** — 浮動小数点の実行系差を排除
2. **固定タイムステップ** — シミュレーションは tick 数のみに依存し、実時間に依存しない
3. **決定論的な反復順序** — body は挿入順、コマンドは `(tick, peerId, seq)` で全クライアント同一順に適用
4. **状態ハッシュ(FNV-1a 32bit)** — 分岐検出。不一致時は snapshot で再同期

## 固定小数点の演算規則(移植ルール)

Unity (C#) / Godot (GDScript) に移植する場合、以下の規則を 64bit 整数で厳密に実装すれば JS 実装とビット一致する。

```txt
FP_ONE = 65536 (16.16)

fmul(a, b) = floor((a * b) / 2^16)      # C#: (a * b) >> 16  (long, 算術シフト)
fdiv(a, b) = floor((a * 2^16) / b)      # 注意: floor 除算。C# の / は 0 方向切り捨てなので負数は補正が必要
fsqrt(a)   = floor(sqrt(a * 2^16))      # 64bit 整数 sqrt(Newton 法等)で厳密に
toFp(x)    = round(x * 65536)           # float→固定小数点は body 定義の取り込み時のみ
```

- 乱数は xorshift32(32bit 演算)、状態ハッシュは FNV-1a 32bit。
- JS 実装は Number(倍精度)の整数演算が 2^53 まで厳密であることを利用する。
  `fmul` は乗数を上位/下位 16bit に分割して計算しており、**絶対値が小さい方のオペランドを第1引数に渡す**規約で厳密性を保つ。
- world 側で position ±4096m / velocity ±256m/s / mass 0.01〜1000kg / impulse をクランプしているため、すべての中間値が JS の厳密整数範囲(および 64bit 整数範囲)に収まる。

## World API

```js
import { createWorld } from './html/assets/js/scenesync/physics/index.js';

const world = createWorld({
  gravity: -9.81,                     // 数値(Y軸) or [x,y,z]
  ground: { y: 0, restitution: 0.2, friction: 0.5 },  // null で無効化(デフォルトは y=0 に床)
  timestepFp: 1092,                   // ≈1/60s。省略可
});

world.addBody({
  id: 'ball-1',
  shape: 'sphere',                    // 'sphere' | 'box'
  radius: 0.5,                        // box の場合は halfExtents: [x,y,z]
  position: [0, 3, 0],
  velocity: [0, 0, 0],
  mass: 1,                            // 0 または static: true で固定
  restitution: 0.6,
  friction: 0.5,
});

world.step();                         // 1 tick 進める
world.stepTo(120);                    // tick 120 まで進める
world.applyImpulse('ball-1', [2, 4, 0]);
world.setVelocity('ball-1', [0, 5, 0]);
world.teleport('ball-1', [0, 3, 0]);
world.removeBody('ball-1');

world.getBody('ball-1');              // { position, velocity, sleeping, ... }(float、描画用)
world.getBodies();
world.snapshot();                     // 生の固定小数点整数を含む JSON-safe な状態
world.restore(snapshot);
world.stateHash();                    // uint32。分岐検出用
```

挙動:

- 並進運動のみ(回転なし)。dynamic は sphere / AABB box、static は両形状 + 床平面
- 衝突解決は逐次インパルス(4 iteration)+ 位置補正(Baumgarte 20%, slop 0.01m)
- restitution は `min(a, b)`、friction は `min(a, b)`、0.5m/s 未満の衝突は反発しない
- 速度が 0.05m/s 未満の状態が 60 tick 続くと sleep(完全凍結)。接触・インパルス・body 削除で wake
- 同一 id の `addBody` は置き換え

## Lockstep API

```js
import { createLockstepSession, tickForElapsedMs } from './html/assets/js/scenesync/physics/index.js';

const session = createLockstepSession({
  peerId: 'peer-abc',                 // クライアント毎に一意(コマンド順序のタイブレークに使用)
  worldOptions: { ground: { y: 0 } },
  commandDelayTicks: 6,               // 発行コマンドは 6 tick 先に予約(伝搬猶予)
  snapshotIntervalTicks: 30,          // rollback 用 snapshot の間隔
  maxSnapshots: 8,
});

// ローカル操作 → コマンド発行 → broadcast
const command = session.issueCommand('add-body', {
  body: { id: 'ball-1', shape: 'sphere', position: [0, 3, 0] },
});
broadcast({ kind: 'physics-command', command });

// 受信側
const result = session.receiveCommand(message.command);
// { applied: true, rolledBack: false }
// { applied: true, rolledBack: true }   … 遅延到着 → snapshot へ巻き戻して再実行済み
// { applied: false, reason: 'too-old' } … 巻き戻し限界超過 → 再同期を要求する

// 毎フレーム: 共有開始時刻から目標 tick を計算して進める
session.advanceTo(tickForElapsedMs(hostNow - startHostTime));
render(session.getBodies());

// 途中参加 / ハッシュ不一致時の再同期
const state = session.createResyncState();   // { tick, hash, snapshot, commands }
newSession.applyResyncState(state);
```

コマンド種別: `add-body` / `remove-body` / `impulse` / `set-velocity` / `teleport`。
未知の type・不正な payload は **全クライアントで同一に無視** する(前方互換)。

## broadcast メッセージ(案)

Scene Sync の broadcast に以下の kind を載せる。シミュレーションは tick のみに依存するため、`hostTime` はペーシング(進行速度合わせ)にだけ使い、結果には影響しない。

```json
{ "kind": "physics-start", "sessionId": "phys-1", "startHostTime": 1770000000000,
  "worldOptions": { "gravity": -9.81, "ground": { "y": 0 } } }

{ "kind": "physics-command", "sessionId": "phys-1",
  "command": { "tick": 126, "seq": 3, "peerId": "peer-abc", "type": "impulse",
               "bodyId": "ball-1", "impulse": [2, 4, 0] } }

{ "kind": "physics-state", "sessionId": "phys-1",
  "tick": 600, "hash": "3fa2c81b", "snapshot": { }, "commands": [] }

{ "kind": "physics-stop", "sessionId": "phys-1" }
```

- `physics-state` は途中参加者への配布と定期的なハッシュ照合に使う(`createResyncState()` の出力)
- ハッシュ不一致を検出したクライアントは host に `physics-state` を要求して `applyResyncState()` する
- 描画への反映はローカルで行う。物理 body と scene object の対応付けは `objectId == bodyId` を推奨

## 制限事項

- 回転の動力学なし(必要になったら固定小数点 quaternion を拡張)
- 衝突形状は sphere / AABB / 床平面のみ。ペア総当たり(数十 body 規模を想定)
- 座標 ±4096m、速度 ±256m/s、質量 0.01〜1000kg にクランプされる
- `advanceTo` の引数は単調増加を想定(過去 tick への巻き戻しは receiveCommand 内部のみ)

## 関連ドキュメント

- [Scene Sync Spec Index](./scene-sync-spec.md)
- [Runtime Time Model](./scene-sync-runtime-time-model.md) — `f(t)` モデルとの関係。物理は tick ベースの逐次シミュレーションなのでコマンド同期 + 決定論で扱う
- [API / Protocol](./scene-sync-api-protocol.md)
