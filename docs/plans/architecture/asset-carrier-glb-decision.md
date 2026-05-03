# Asset Carrier GLB Decision

## 決定

Scene Sync の同期インターフェースは、当面 GLB / carrier GLB を compatibility と placement の共通レイヤとして維持します。  
shader / splat / video / webpage / text / VFX / AssetBundle などの特殊 runtime asset も、可能な限り carrier GLB fallback を持つ方針を優先します。

## なぜこの方向か

- Scene Sync は placement、selection、transform sync を既に 3D object ベースで扱っている
- asset type ごとに sync interface を増やすと protocol、viewer、editor、transfer の複雑さが急増する
- GLB / meshPath を compatibility layer に残すと、非対応 runtime でも fallback 表示しやすい
- runtime-specific renderer は metadata を見て carrier を置き換えるか augment する方式にしやすい

## Preferred Model

- placement layer:
  - object transform
  - object identity
  - fallback geometry
  - default selection target
- carrier layer:
  - GLB or carrier GLB
  - `meshPath` or equivalent asset reference
- runtime augmentation layer:
  - metadata
  - referenced blobs
  - renderer-specific parameters

## Asset Type Guidance

- image:
  - texture plane carrier GLB
  - original image blob reference in metadata
- video:
  - poster plane carrier GLB
  - video URL / blob reference in metadata
- webpage:
  - placeholder plane or proxy mesh carrier
  - URL metadata
- text:
  - text plane carrier
  - text content / style metadata
- shader:
  - carrier mesh or plane
  - shader source / uniforms in metadata or blobs
- Gaussian Splat:
  - carrier GLB fallback
  - splat blob / URL metadata
- VFX / AssetBundle:
  - placeholder or proxy carrier
  - runtime payload references in metadata

## Rejected Direction For Now

- `asset.type: "shader"` のような special type を sync primitive として直接増やし、GLSL source と uniforms を protocol 本体で常に同期する案

### 理由

- sync interface が asset-specialized になりやすい
- fallback が弱くなり、非対応 runtime で placement すら表現しにくい
- blob size、validation、security、compatibility 問題が一気に増える

## Tradeoffs

- carrier GLB 方針は、最短では回り道に見える
- ただし protocol と placement の安定性を保ちやすく、後から runtime-specific renderer を増やしやすい
- perfect fidelity より interoperability と staged rollout を優先する決定

## Open Questions

- carrier metadata の canonical schema をどこまで protocol に含めるか
- browser-side conversion と server-side conversion の境界をどう切るか
- large shader code や splat payload の blob lifecycle をどう管理するか
- metadata 参照の signed URL / assetId strategy をどう security track と接続するか
- carrier replacement と carrier augmentation を runtime ごとにどう分けるか

## Follow-Up

- backlog の Asset Pipeline / Carrier GLB track で asset class matrix を具体化する
- Shader / Generative Runtime track で shader metadata と blob threshold を整理する
- Advanced Rendering track で splat fallback strategy を詰める

