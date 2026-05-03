# Shader / Generative Runtime

## purpose

GLSL / generative content を Scene Sync で扱うための runtime track を、carrier GLB 互換と GPU safety を保ちながら段階導入するための backlog です。

## included ideas

- GLSL / Shadertoy-compatible shader runtime
- `iResolution`
- `iTime`
- `iTimeDelta`
- `iFrame`
- `iMouse`
- `iChannel0..3`
- `iTime` synchronized with existing serverClock
- plane / fullscreen / box / sphere / skybox targets
- Web Three.js `ShaderMaterial` MVP
- Godot future support
- Unity placeholder then staged support
- Loom `shaderSetUniform` sink node
- code size limits
- blob store for large shader code
- warm-up preview for GPU safety

## out of scope

- native renderer parity across all engines
- unbounded user shader execution
- shader editor completion and linting

## near-term implementation tasks

- shader carrier metadata shape を定義する
- Web MVP target surface を plane first で絞る
- `iTime` / serverClock alignment rule を整理する
- code size / blob store threshold の初期方針を決める

## later tasks

- Web `ShaderMaterial` MVP
- uniform editing / transport
- Loom sink node
- Godot support
- Unity staged support

## dependencies

- Asset Pipeline / Carrier GLB
- Advanced Rendering track for fallback comparisons
- AI Integration for code assist later

## risks

- shader source を sync interface に直載せすると互換性と size 管理が崩れる
- GPU warm-up / safety を後回しにすると preview 体験が不安定になる

## parallelization notes

- metadata / timing / safety guideline docs は分離しやすい
- shader source transport と runtime execution は同時に変えない

## suggested first PR

- shader carrier metadata と Web MVP constraints doc

## agent notes

- shader は direct sync primitive ではなく runtime-specific augmentation として扱う
- large code は blob store reference 前提で考える

