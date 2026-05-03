# Scene Sync Overview

## 目的

Scene Sync area は、同期体験そのものと、それを使う開発者体験を前に進めるための領域です。

## この area に含めるもの

- Scene Sync の runtime / protocol に関わる計画
- Unity / Unreal / Godot / web 連携の方針
- Scene Sync に紐づく examples や docs
- Scene Sync に近い developer tooling

## この area に含めないもの

- release / deploy / CI などの platform workflow
- FileTransfer 主体の体験設計
- Loom runtime そのものの実装計画

## 今後追加しうる plan 例

- Unity SDK の onboarding 改善
- Scene Sync web demo の同期検証フロー
- protocol 互換性チェックの整理
- examples と docs の導線改善

## Agents 向け注意

- product behavior の変更と platform workflow の変更を同じ branch に混ぜすぎない
- runtime / SDK / examples のどこを触るかを最初に明示する
- staging で確認したい変更は `codex/**` branch で先に回してよい
