# Enterprise / Security

## purpose

asset protection、permission control、auditability を後付けで崩さないように、Scene Sync / asset pipeline / AI integration に横断する security backlog を整理する track です。

## included ideas

- authentication / authorization
- short-lived URLs
- blob encryption
- client-side decrypt
- watermark
- audit log
- AssetBundle protection
- assetId / blobId-based references
- scene-lock and edit permissions

## out of scope

- production IAM rollout
- billing / seat management
- legal policy text

## near-term implementation tasks

- threat surface inventory
- asset URL lifetime policy draft
- edit permission / scene-lock permission matrix draft
- audit log minimum fields definition

## later tasks

- signed asset delivery
- encrypted blob flow
- watermark / asset ownership markers
- per-role edit permissions
- enterprise audit export

## dependencies

- Asset Pipeline / Carrier GLB
- AI Integration
- Refactoring / Packages

## risks

- signed URL / assetId strategyを後回しにすると asset pipeline と API が手戻りしやすい
- scene-lock permission を曖昧にすると multi-user edit が壊れやすい

## parallelization notes

- threat model、URL policy、audit field list は分離しやすい
- auth / permission implementation は producer / consumer 両側を同時変更しやすいので慎重に進める

## suggested first PR

- asset URL lifetime policy and minimum audit log fields doc

## agent notes

- direct push to security-sensitive runtime code を複数 agent で同時に進めない
- permission model は Dev Tool / AI / Scene Sync core と接続点を先に洗い出す

