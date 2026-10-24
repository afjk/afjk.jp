import { registerHooks } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';

// Only the GPU boundary is fake: exercise app construction, state and loop
// ownership with constructor failures as well as asynchronous backend failures.
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'three' ? { url: 'test:three', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    if (url !== 'test:three') return next(url, context);
    return { format: 'module', shortCircuit: true, source: `
      class Object3D {
        children = []; userData = {}; rotation = {}; layers = {enable() {}};
        position = {set() {}};
        add(child) { this.children.push(child); }
        updateProjectionMatrix() {}
      }
      export class Scene extends Object3D {}
      export class PerspectiveCamera extends Object3D {}
      export class AmbientLight extends Object3D {}
      export class DirectionalLight extends Object3D {}
      export class GridHelper extends Object3D {}
      export class Mesh extends Object3D {}
      export class Color {}
      export class PlaneGeometry {}
      export class MeshBasicMaterial {}
      export class WebGPURenderer {
        constructor(options) {
          if (globalThis.gpuFailure === 'constructor') throw Error('constructor unavailable');
          this.options = options;
          this.domElement = document.createElement('canvas');
          this.xr = {enabled: false, setReferenceSpaceType() {}};
          globalThis.lastRenderer = this;
        }
        setPixelRatio() {}
        setSize() { this.sizes = (this.sizes || 0) + 1; }
        async init() { if (globalThis.gpuFailure === 'init') throw Error('backend unavailable'); }
        setAnimationLoop(callback) { this.loop = callback; }
        dispose() {
          this.disposals = (this.disposals || 0) + 1;
          if (globalThis.gpuFailure === 'dispose') throw Error('partial backend disposal');
        }
      }
      export class PMREMGenerator {
        constructor() { if (globalThis.gpuFailure === 'dispose') throw Error('PMREM unavailable'); }
        dispose() { this.disposals = (this.disposals || 0) + 1; }
      }
    ` };
  },
});
const { createThreeApp } = await import('./three-app.js');

function setup(failure) {
  globalThis.gpuFailure = failure;
  const nodes = new Set(), listeners = new Map(), frames = new Map();
  let frameId = 0;
  globalThis.document = {
    createElement: () => ({ hidden: false, remove() { nodes.delete(this); } }),
    body: { appendChild: node => nodes.add(node) },
  };
  globalThis.window = {
    innerWidth: 800, innerHeight: 600, devicePixelRatio: 1,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: type => listeners.delete(type),
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
  };
  function tick(time) {
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(time);
  }
  return { nodes, listeners, frames, tick };
}

for (const failure of ['constructor', 'init', 'dispose']) {
  test(`${failure} failure keeps scene state and a single replaceable runtime loop`, async () => {
    const env = setup(failure);
    const app = await createThreeApp();
    assert.equal(app.renderer, null);
    assert.equal(app.pmremGenerator, null);
    assert.match(app.renderingError.message, /unavailable/);
    assert.equal(app.viewport.hidden, true);
    if (failure === 'init') assert.equal(globalThis.lastRenderer.disposals, undefined);
    if (failure === 'dispose') assert.equal(globalThis.lastRenderer.disposals, 1);
    assert.ok(app.scene.children.some(node => node.userData.role === 'placement-floor'));
    const state = { name: 'retained object' }; app.scene.add(state);
    env.listeners.get('resize')();
    let oldTicks = 0, ticks = 0;
    app.setAnimationLoop(() => oldTicks++);
    app.setAnimationLoop((time, frame) => { ticks++; assert.equal(time, 200); assert.equal(frame, null); });
    assert.equal(env.frames.size, 1);
    env.tick(200);
    assert.equal(oldTicks, 0); assert.equal(ticks, 1);
    assert.ok(app.scene.children.includes(state));
    app.setAnimationLoop(null); assert.equal(env.frames.size, 0);
    app.setAnimationLoop(() => ticks++);
    app.dispose(); app.dispose();
    app.setAnimationLoop(() => ticks++);
    assert.equal(env.frames.size, 0);
    assert.equal(env.listeners.size, 0); assert.equal(env.nodes.size, 0);
    // A later initialization can succeed without retaining a failed canvas/loop.
    globalThis.gpuFailure = null;
    const next = await createThreeApp();
    assert.ok(next.renderer); assert.equal(env.nodes.size, 1);
    next.dispose(); assert.equal(env.nodes.size, 0);
  });
}

test('healthy renderer keeps its backend options, XR, PMREM and animation loop', async () => {
  const env = setup(null);
  const app = await createThreeApp();
  assert.equal(app.renderingError, null);
  assert.equal(app.viewport, app.renderer.domElement);
  assert.equal(app.viewport.hidden, false);
  assert.equal(app.renderer.options.forceWebGL, true);
  assert.equal(app.renderer.xr.enabled, true);
  assert.ok(app.pmremGenerator);
  const callback = () => {};
  app.setAnimationLoop(callback);
  assert.equal(app.renderer.loop, callback); assert.equal(env.frames.size, 0);
  env.listeners.get('resize')(); assert.equal(app.renderer.sizes, 2);
  app.dispose(); app.dispose();
  assert.equal(app.renderer.loop, null);
  assert.equal(app.renderer.disposals, 1); assert.equal(app.pmremGenerator.disposals, 1);
  assert.equal(env.nodes.size, 0); assert.equal(env.listeners.size, 0);
});
