# Scene Sync Unity オーサリングモデル

このドキュメントは、Scene Sync Unity における Unity Editor オーサリングモードと Unity Runtime / Player モードの設計上の違いを記録する。

Scene Sync Unity には、大きく分けて2つの利用モードがある。

1. Unity Editor オーサリングモード
2. Unity Runtime / Player ビューワーモード

この2つのモードでは、オブジェクトの所有権とライフタイムのルールを意図的に分ける。

---

## 概要

| モード | 役割 | オブジェクトのライフタイム | リモート削除時の挙動 |
|---|---|---|---|
| Unity Editor | 制作ツール | Unity Hierarchy 上の GameObject が原本 | Unpublish / disconnect のみ。GameObject は Destroy しない。 |
| Unity Runtime / Player | 一時的な Scene Sync 参加者 | 同期されたオブジェクトは temporary | Scene Sync から削除されたらローカルでも Destroy してよい。 |

---

## Unity Editor オーサリングモード

Unity Editor は制作環境として扱う。

Unity Hierarchy に既に存在する GameObject は、Unity プロジェクトが所有する原本オブジェクトとみなす。その GameObject を Scene Sync に publish すると、Web、VR、AIツール、他の参加者から見えるようになる。ただし、Scene Sync が Unity オブジェクトの所有者になるわけではない。

そのため、以下のルールとする。

- Unity 由来の GameObject は原本である。
- Scene Sync への publish は、そのオブジェクトを他のクライアントから見えるようにする操作である。
- Web / リモート側で削除された場合、Scene Sync 上からは削除されるが、Unity の GameObject は Destroy してはいけない。
- リモート削除後、Unity オブジェクトは unpublished / disconnected 相当の状態に戻る。
- 同じ Unity オブジェクトは、あとから再度 publish できる。

この挙動は、Scene Sync を既存 Unity プロジェクト内の制作ツールとして使うために重要である。特に LBE / MR 制作では、現実空間との位置合わせを確認しながらオブジェクトを調整するため、Unity 上の原本オブジェクトを保護する必要がある。

### Editor における Identity ルール

`SceneSyncIdentity.ObjectId` は、Scene Sync 上で共有されるオブジェクト識別子である。

これは、次のようなワイヤーペイロードで使われる ID である。

```json
{
  "kind": "scene-delta",
  "objectId": "unity-...",
  "position": [0, 0, 0]
}
```

Editor のみで必要な重複検出には、Unity 標準の `GlobalObjectId` を使う。これは、2つの `SceneSyncIdentity` コンポーネントが別々の Unity オブジェクトに付いているかどうかを判定するためである。

`GlobalObjectId` は Scene Sync の `ObjectId` としては使わない。あくまで Editor 側での所有権判定・重複検出の補助として使う。

### Unity Duplicate / Copy-Paste 時の挙動

Unity では、GameObject を複製すると serialized component field もコピーされる。そのため、`SceneSyncIdentity` が付いた GameObject を複製すると、既存の `ObjectId` もコピーされる。

Scene Sync は、publish 前にこの状態を修復する必要がある。

期待する挙動は以下の通り。

1. 元の GameObject は既存の `SceneSyncIdentity.ObjectId` を保持する。
2. 複製された GameObject は、最初はコピーされた `ObjectId` を持つ。
3. 複製された GameObject を publish する前に、EditorWindow が「同じ `ObjectId` が別の Unity オブジェクトで既に使われている」ことを検出する。
4. 複製された GameObject に新しい `unity-<guid>` 形式の ObjectId を割り当てる。
5. その後、両方のオブジェクトを独立して publish / sync できる。

これにより、独自の LocalId を追加せずに済む。Unity Editor には、`GlobalObjectId` という Editor 用のローカル識別機構が既に存在するためである。

---

## Unity Runtime / Player ビューワーモード

Unity Runtime / Player は、Web クライアントと同じような一時的な Scene Sync 参加者として扱う。

Runtime は、Unity プロジェクトシーンの制作元とはみなさない。通常、Runtime で編集された GameObject を Unity シーンとして保存することはなく、Editor と同じように既存プロジェクト内のオブジェクトを保護する必要もない。

そのため、以下のルールとする。

- Runtime で同期されるオブジェクトは temporary である。
- Scene Sync から受信したオブジェクトは、ローカルに生成してよい。
- リモート / Web 側で削除された場合、対応するローカル GameObject を Destroy してよい。
- Runtime では、Editor 専用の `GlobalObjectId` による重複修復は不要である。
- Runtime は `UnityEditor` API に依存してはいけない。

将来、Runtime でも永続的なオーサリング用途を扱う必要が出た場合は、Editor のオーサリングルールを暗黙に流用するのではなく、別の設計として検討する。

---

## Origin と temporary の意味

現在の意図する意味は以下の通りである。

```text
SceneSyncOrigin.Unity:
  Unity Editor で制作された原本オブジェクト。
  Temporary = false。
  リモート削除時は unpublish / disconnect されるが、Destroy はされない。

SceneSyncOrigin.Remote:
  Scene Sync / Web / リモート由来で生成された temporary object。
  Temporary = true。
  リモート削除時はローカルでも Destroy してよい。
```

重要なのは、`Unity` origin が単に「Unity 内で動いている」という意味ではなく、「Unity Editor で制作された原本」という意味であること。

---

## 実装・運用上の方針

### Do

- `SceneSyncIdentity.ObjectId` を Scene Sync で共有されるオブジェクト ID として使う。
- `GlobalObjectId` は、Editor コード内で Unity オブジェクトの重複検出にのみ使う。
- EditorWindow から publish する前に、複製された ObjectId を修復する。
- Unity 由来のオブジェクトがリモート削除されても、Hierarchy 上には残す。
- Runtime / Player のオブジェクトは、将来明示的に永続オーサリング機能を設計するまでは temporary として扱う。

### Do not

- Editor の `GlobalObjectId` で十分に扱える範囲では、独自の LocalId を追加しない。
- `GlobalObjectId` を Scene Sync のワイヤー上の `objectId` として使わない。
- Runtime assembly から `UnityEditor` API を参照しない。
- リモート参加者から `scene-remove` が送られたという理由だけで、Unity Editor 由来の GameObject を Destroy しない。
- Unity 内で動いている全てのオブジェクトを Unity 由来の原本だとみなさない。

---

## なぜこの区別が必要か

Scene Sync は、次の2つの用途を持つ。

- 軽量な共有3Dシーン / WebXR ツール
- 既存 Unity プロジェクトのためのオーサリング支援ツール

Web 風の temporary scene では、削除はそのまま削除を意味する。

一方、Unity Editor オーサリングでは、Scene Sync 上での削除は「この Unity プロジェクト内のオブジェクトの publish を止める」という意味になる。Unity プロジェクトが制作上の source of truth であるため、原本オブジェクトは残す必要がある。

この区別を明示しておくことで、将来 Web 側の操作が誤って Unity プロジェクトのオブジェクトを破壊したり、Runtime 専用の挙動が Editor オーサリングモデルを複雑にしたりすることを防ぐ。
