# Platform Overview

## 目的

Platform area は、`afjk.jp` の継続開発を支える workflow、deploy、docs、運用基盤を整えるための領域です。

## この area に含めるもの

- GitHub Actions
- staging / production deploy の運用
- branch workflow
- agent workflow docs
- GitHub templates

## この area に含めないもの

- Scene Sync や FileTransfer の product behavior
- `loom/` repo の runtime 実装
- feature 自体の仕様策定

## 今後追加しうる plan 例

- staging 運用ルールの明確化
- release workflow の整理
- PR / issue template の改善
- CI の軽量化や観測性の改善

## Agents 向け注意

- production deploy は release workflow のみで扱う
- staging は experimental branch によって上書きされる前提で考える
- product behavior の変更は、できるだけ別 branch / 別 task に分ける
