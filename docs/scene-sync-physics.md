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
4. **プロトコルは raw int** — float→固定小数点変換はコマンド発行クライアントで 1 回だけ行い、wire には固定小数点 raw int を流す。受信側は決定論的なサニタイズ(safe int 化 + クランプ)のみ行う
5. **コマンドの canonical 化** — 発行・受信時に正規化 + deep freeze してから log に入れる。呼び出し側が保持した参照を後から変更しても log は変わらない
6. **フルステートハッシュ(FNV-1a 32bit)** — 将来の挙動に影響する全フィールド(world 設定 + tick + 全 body の形状・質量・材質・sleepCounter 含む)を hash。分岐検出時は snapshot で再同期

## 固定小数点の演算規則(移植ルール)

Unity (C#) / Godot (GDScript) に移植する場合、以下の規則を 64bit 整数で厳密に実装すれば JS 実装とビット一致する。

```txt
FP_ONE = 65536 (16.16)

fmul(a, b) = floor((a * b) / 2^16)      # C#: (a * b) >> 16  (long, 算術シフト)
fdiv(a, b) = floor((a * 2^16) / b)      # 注意: floor 除算。C# の / は 0 方向切り捨てなので負数は補正が必要
fsqrt(a)   = floor(sqrt(a * 2^16))      # 64bit 整数 sqrt(Newton 法等)で厳密に
toFp(x)    = floor(x * 2^16 + 0.5)      # IEEE754 double で評価。2 のべき乗倍と floor は厳密なので移植可能
```

`toFp` を `Math.round` / C# `Math.Round` で実装してはいけない(0.5 の丸め規則が処理系で異なる)。
ただし `toFp` が必要になるのはコマンド発行クライアントと world 生成時(`physics-start` の float options)のみで、コマンド payload は raw int で broadcast されるため、通常の同期経路に float 変換は乗らない。

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
// payload の float はここで一度だけ固定小数点 raw int へ変換され、
// canonical 化 + freeze 済みのコマンドが返る(log にも同じものが入る)
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
// applyResyncState は復元状態を rollback 起点 snapshot として seed し、
// state 内に自分の peerId のコマンドがあれば seq をその先から再開する
```

コマンド種別: `add-body` / `remove-body` / `impulse` / `set-velocity` / `teleport`。
canonical なコマンド payload は raw int(`body`(raw record) / `impulseFp` / `velocityFp` / `positionFp`)。
未知の type・不正な payload は **全クライアントで同一に無視** する(前方互換)。

`stateHash()` は world 設定(gravity / timestep / ground)も hash に含めるため、
`physics-start` の `worldOptions` が一致しないクライアントは即座にハッシュ不一致として検出される。

## Scene Sync 組み込み

Web 版 Scene Sync では、まず object component と Export/Import 対応として physics を組み込む。

- object state: `objects.<id>.physics`
- scene state / SceneDocument root: `physics`
- Editor 再生: 既存の Scene Clock / Player UI が供給する `time.t` を入力にして評価する
- seek / pause / reset: 物理 world を初期 snapshot から対象 tick まで再計算する
- Export Viewer: `scene.json` の `physics` と object physics を読み込み、Player Shell と共通の transport UI で再生する

現在の object physics は以下の形を想定する。

```json
{
  "enabled": true,
  "bodyType": "dynamic",
  "shape": "sphere",
  "mass": 1,
  "restitution": 0.2,
  "friction": 0.5,
  "velocity": [0, 0, 0]
}
```

`bodyType` は `dynamic` / `static`、`shape` は `sphere` / `box`。
`radius` / `halfExtents` が省略された場合は Scene object の scale から推定する。

Editor の通常表示中は host-follow の wall-clock 秒を物理に直接使わない。
Player transport が local timeline を所有している間だけ、Scene Clock の `t` から物理 tick を計算する。

## broadcast メッセージ(案)

Scene Sync の broadcast に以下の kind を載せる。シミュレーションは tick のみに依存するため、`hostTime` はペーシング(進行速度合わせ)にだけ使い、結果には影響しない。

```json
{ "kind": "physics-start", "sessionId": "phys-1", "startHostTime": 1770000000000,
  "worldOptions": { "gravity": -9.81, "ground": { "y": 0 } } }

{ "kind": "physics-command", "sessionId": "phys-1",
  "command": { "tick": 126, "seq": 3, "peerId": "peer-abc", "type": "impulse",
               "bodyId": "ball-1", "impulseFp": [131072, 262144, 0] } }

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
