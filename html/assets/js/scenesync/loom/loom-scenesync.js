// Loom SceneSync アダプタ
// SceneSync メッセージプロトコルを処理し、複数グラフの独立評価をサポート

import { LoomError } from "./loom.js";

// グローバル registry でアダプタインスタンスを管理
const adapterRegistry = new Map();
let nextAdapterId = 0;

// ノード登録済み状態を LoomClass ごとに管理
const registeredLoomClasses = new WeakSet();

// Phase 1 で許可する SceneSync node type whitelist
// Remote Behavior Graph では serverClock を使う（local clock は時刻ドリフトの原因になるため）
const SCENESYNC_ALLOWED_NODE_TYPES = new Set([
  'constant',
  'sine',
  'cosine',
  'add',
  'multiply',
  'serverClock',
  'sceneSetPosition',
  'sceneOffsetPosition',
  'sceneSetRotation',
  'sceneSetScale',
  'sceneSetColor',
  'sceneSetVisible',
]);

export class LoomSceneSync {
  constructor({ LoomClass, send, getServerTime, getObjectRuntimeTime, resolveTarget, isObjectBeingEdited }) {
    this.LoomClass = LoomClass;
    this.send = send;
    this.getServerTime = getServerTime;
    this.getObjectRuntimeTime = getObjectRuntimeTime;
    this.resolveTarget = resolveTarget;
    this.isObjectBeingEdited = isObjectBeingEdited;

    // このアダプタの一意ID
    this.adapterId = `adapter-${nextAdapterId++}`;
    adapterRegistry.set(this.adapterId, this);

    // グラフ管理
    this._sceneGraph = new LoomClass({ nodes: [], edges: [] });
    this._objectGraphs = new Map();

    // 実行状態
    this._started = false;

    // Export 用 graph definition の保持
    this._sceneGraphDefinition = null;
    this._objectGraphDefinitions = new Map();

    // sceneOffsetPosition の base position 管理
    this.behaviorBases = new Map();

    // Evaluation context for tracking the current evaluation
    this._evaluationContext = null;

    // ノード型登録（冪等性を保証）
    this._registerNodeTypes();
  }

  _createScopeKey(scope) {
    if (scope === 'scene') return 'scene';
    if (scope && typeof scope === 'object' && scope.object) {
      return `object:${scope.object}`;
    }
    return 'unknown';
  }

  _createBehaviorBaseKey(scopeKey, target) {
    return `${scopeKey}:${target}`;
  }

  _getOrCaptureBehaviorBase(scopeKey, target, obj) {
    const key = this._createBehaviorBaseKey(scopeKey, target);

    if (!this.behaviorBases.has(key)) {
      if (obj && obj.position && typeof obj.position.clone === 'function') {
        this.behaviorBases.set(key, {
          scopeKey,
          target,
          position: obj.position.clone()
        });
      }
    }

    const base = this.behaviorBases.get(key);
    return base ? base.position : null;
  }

  _restoreBehaviorBasesForScope(scope) {
    const scopeKey = this._createScopeKey(scope);
    const keysToDelete = [];

    for (const [key, base] of this.behaviorBases.entries()) {
      if (!key.startsWith(`${scopeKey}:`)) continue;

      const obj = this.resolveTarget(base.target);
      if (obj && obj.position && base.position) {
        if (typeof obj.position.copy === 'function') {
          obj.position.copy(base.position);
        } else if (typeof obj.position.set === 'function') {
          obj.position.set(base.position.x, base.position.y, base.position.z);
        }
      }

      keysToDelete.push(key);
    }

    for (const key of keysToDelete) {
      this.behaviorBases.delete(key);
    }
  }

  _resolveTargetWithEditGuard(targetId) {
    if (!targetId) return null;

    const allowEditedTarget = this._evaluationContext?.allowEditedTarget === true;

    if (!allowEditedTarget && this.isObjectBeingEdited?.(targetId)) {
      return null;
    }

    return this.resolveTarget(targetId);
  }

  evaluateObjectGraphAt(objectId, time, options = {}) {
    const engine = this._objectGraphs.get(objectId);
    if (!engine) return;

    this._evaluationContext = {
      scope: { object: objectId },
      allowEditedTarget: Boolean(options.allowEditedTarget),
      reason: options.reason || 'manual',
    };

    try {
      engine.evaluateAt(time);
    } finally {
      this._evaluationContext = null;
    }
  }

  tickObjectGraphs(now = performance.now()) {
    if (!this._started) return;

    for (const [objectId, engine] of this._objectGraphs.entries()) {
      const t = this.getObjectRuntimeTime
        ? this.getObjectRuntimeTime(objectId, now)
        : 0;

      this.evaluateObjectGraphAt(objectId, t, {
        reason: 'runtime-tick',
        allowEditedTarget: false,
      });
    }
  }

  resetBehaviorBasesForObject(objectId) {
    const scopeKey = `object:${objectId}`;
    for (const key of Array.from(this.behaviorBases.keys())) {
      if (key.startsWith(`${scopeKey}:`)) {
        this.behaviorBases.delete(key);
      }
    }
  }

  onObjectSelected(objectId) {
    if (!objectId) return;

    this.evaluateObjectGraphAt(objectId, 0, {
      reason: 'selected-reset',
      allowEditedTarget: true,
    });
  }

  onObjectDeselected(objectId) {
    if (!objectId) return;

    this.resetBehaviorBasesForObject(objectId);
  }

  _registerNodeTypes() {
    // 既にこの LoomClass で登録済みならスキップ
    if (registeredLoomClasses.has(this.LoomClass)) {
      return;
    }

    const LoomClass = this.LoomClass;

    // serverClock ノード
    LoomClass.registerNodeType("serverClock", {
      category: "source",
      inputs: [],
      outputs: [{ name: "t", type: "number", kind: "behavior" }],
      params: [{ name: "adapterId", type: "string", default: "" }],
      evaluate: (inputs, params) => {
        const adapter = adapterRegistry.get(params.adapterId);
        const t = adapter ? adapter.getServerTime() : 0;
        return { t };
      }
    });

    // SceneSync sink ノード：setPosition
    LoomClass.registerNodeType("sceneSetPosition", {
      category: "sink",
      inputs: [
        { name: "x", type: "number", default: 0, kind: "behavior" },
        { name: "y", type: "number", default: 0, kind: "behavior" },
        { name: "z", type: "number", default: 0, kind: "behavior" }
      ],
      outputs: [],
      params: [
        { name: "target", type: "string", default: "" },
        { name: "adapterId", type: "string", default: "" }
      ],
      evaluate: (inputs, params) => {
        const adapter = adapterRegistry.get(params.adapterId);
        if (!adapter) return {};
        const obj = adapter._resolveTargetWithEditGuard(params.target);
        if (obj && obj.position && typeof obj.position.set === "function") {
          obj.position.set(inputs.x, inputs.y, inputs.z);
        }
        return {};
      }
    });

    // SceneSync sink ノード：offsetPosition
    LoomClass.registerNodeType("sceneOffsetPosition", {
      category: "sink",
      inputs: [
        { name: "x", type: "number", default: 0, kind: "behavior" },
        { name: "y", type: "number", default: 0, kind: "behavior" },
        { name: "z", type: "number", default: 0, kind: "behavior" }
      ],
      outputs: [],
      params: [
        { name: "target", type: "string", default: "" },
        { name: "adapterId", type: "string", default: "" },
        { name: "scopeKey", type: "string", default: "" }
      ],
      evaluate: (inputs, params) => {
        const adapter = adapterRegistry.get(params.adapterId);
        if (!adapter) return {};
        const obj = adapter._resolveTargetWithEditGuard(params.target);
        if (!obj || !obj.position) return {};

        const basePosition = adapter._getOrCaptureBehaviorBase(params.scopeKey, params.target, obj);
        if (basePosition) {
          obj.position.set(
            basePosition.x + inputs.x,
            basePosition.y + inputs.y,
            basePosition.z + inputs.z
          );
        }
        return {};
      }
    });

    // SceneSync sink ノード：setRotation
    LoomClass.registerNodeType("sceneSetRotation", {
      category: "sink",
      inputs: [
        { name: "x", type: "number", default: 0, kind: "behavior" },
        { name: "y", type: "number", default: 0, kind: "behavior" },
        { name: "z", type: "number", default: 0, kind: "behavior" }
      ],
      outputs: [],
      params: [
        { name: "target", type: "string", default: "" },
        { name: "adapterId", type: "string", default: "" }
      ],
      evaluate: (inputs, params) => {
        const adapter = adapterRegistry.get(params.adapterId);
        if (!adapter) return {};
        const obj = adapter._resolveTargetWithEditGuard(params.target);
        if (obj && obj.rotation && typeof obj.rotation.set === "function") {
          obj.rotation.set(inputs.x, inputs.y, inputs.z);
        }
        return {};
      }
    });

    // SceneSync sink ノード：setScale
    LoomClass.registerNodeType("sceneSetScale", {
      category: "sink",
      inputs: [
        { name: "x", type: "number", default: 1, kind: "behavior" },
        { name: "y", type: "number", default: 1, kind: "behavior" },
        { name: "z", type: "number", default: 1, kind: "behavior" }
      ],
      outputs: [],
      params: [
        { name: "target", type: "string", default: "" },
        { name: "adapterId", type: "string", default: "" }
      ],
      evaluate: (inputs, params) => {
        const adapter = adapterRegistry.get(params.adapterId);
        if (!adapter) return {};
        const obj = adapter._resolveTargetWithEditGuard(params.target);
        if (obj && obj.scale && typeof obj.scale.set === "function") {
          obj.scale.set(inputs.x, inputs.y, inputs.z);
        }
        return {};
      }
    });

    // SceneSync sink ノード：setColor
    LoomClass.registerNodeType("sceneSetColor", {
      category: "sink",
      inputs: [
        { name: "r", type: "number", default: 1, kind: "behavior" },
        { name: "g", type: "number", default: 1, kind: "behavior" },
        { name: "b", type: "number", default: 1, kind: "behavior" }
      ],
      outputs: [],
      params: [
        { name: "target", type: "string", default: "" },
        { name: "adapterId", type: "string", default: "" }
      ],
      evaluate: (inputs, params) => {
        const adapter = adapterRegistry.get(params.adapterId);
        if (!adapter) return {};
        const obj = adapter._resolveTargetWithEditGuard(params.target);

        // Helper function to apply color to material (handles arrays and nested materials)
        const applyColorToMaterial = (material, r, g, b) => {
          if (Array.isArray(material)) {
            for (const m of material) {
              applyColorToMaterial(m, r, g, b);
            }
            return;
          }
          if (material?.color && typeof material.color.setRGB === "function") {
            material.color.setRGB(r, g, b);
          }
        };

        if (obj) {
          // Apply color to root object's material
          applyColorToMaterial(obj.material, inputs.r, inputs.g, inputs.b);

          // For Group objects, traverse children and apply color
          if (typeof obj.traverse === "function") {
            obj.traverse((child) => {
              if (child !== obj) {
                applyColorToMaterial(child.material, inputs.r, inputs.g, inputs.b);
              }
            });
          }
        }
        return {};
      }
    });

    // SceneSync sink ノード：setVisible
    LoomClass.registerNodeType("sceneSetVisible", {
      category: "sink",
      inputs: [
        { name: "visible", type: "boolean", default: true, kind: "behavior" }
      ],
      outputs: [],
      params: [
        { name: "target", type: "string", default: "" },
        { name: "adapterId", type: "string", default: "" }
      ],
      evaluate: (inputs, params) => {
        const adapter = adapterRegistry.get(params.adapterId);
        if (!adapter) return {};
        const obj = adapter._resolveTargetWithEditGuard(params.target);
        if (obj) {
          obj.visible = Boolean(inputs.visible);
        }
        return {};
      }
    });

    registeredLoomClasses.add(LoomClass);
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== "object") {
      throw new LoomError("INVALID_MESSAGE", "Message must be an object", { reason: "not an object" });
    }

    switch (msg.type) {
      case "scene-graph-set":
        this._handleGraphSet(msg);
        break;
      case "scene-graph-clear":
        this._handleGraphClear(msg);
        break;
      case "scene-graph-patch":
        this._handleGraphPatch(msg);
        break;
      case "scene-graph-input":
        this._handleGraphInput(msg);
        break;
      default:
        throw new LoomError("INVALID_MESSAGE", `Unknown message type: ${msg.type}`, { type: msg.type });
    }
  }

  _validateScope(scope) {
    if (typeof scope === "string" && scope === "scene") {
      return;
    }
    if (typeof scope === "object" && scope !== null && typeof scope.object === "string") {
      return;
    }
    throw new LoomError("INVALID_SCOPE", "scope must be 'scene' or { object: targetId }", { scope });
  }

  _validateSceneSyncGraphNodeTypes(graph) {
    for (const node of graph.nodes || []) {
      if (!SCENESYNC_ALLOWED_NODE_TYPES.has(node.type)) {
        throw new LoomError(
          'DISALLOWED_NODE_TYPE',
          `Node type is not allowed in SceneSync graph: ${node.type}`,
          { nodeId: node.id, type: node.type }
        );
      }
    }
  }

  _injectAdapterId(graph, scope) {
    if (!graph || typeof graph !== "object" || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      throw new LoomError("INVALID_GRAPH", "graph must have nodes and edges arrays", { reason: "invalid graph" });
    }

    const sceneSetNodeTypes = new Set([
      "sceneSetPosition", "sceneSetRotation", "sceneSetScale", "sceneSetColor", "sceneSetVisible"
    ]);
    const sceneOffsetNodeTypes = new Set(["sceneOffsetPosition"]);
    const objectScopeTarget = typeof scope === "object" && scope !== null ? scope.object : null;
    const scopeKey = this._createScopeKey(scope);

    // グラフをコピー（元を破壊しない）
    const nodes = graph.nodes.map(node => {
      const newNode = { ...node };
      newNode.params = { ...(node.params || {}) };

      // adapterId を注入
      if (["serverClock", "sceneSetPosition", "sceneSetRotation", "sceneSetScale", "sceneSetColor", "sceneSetVisible", "sceneOffsetPosition"].includes(node.type)) {
        newNode.params.adapterId = this.adapterId;
      }

      // sceneOffsetPosition に scopeKey を注入
      if (sceneOffsetNodeTypes.has(node.type)) {
        newNode.params.scopeKey = scopeKey;
        // object scope の場合、target を自動注入
        if (objectScopeTarget && !newNode.params.target) {
          newNode.params.target = objectScopeTarget;
        }
      }

      // object scope の場合、SceneSync sink node の target を自動注入
      if (objectScopeTarget && sceneSetNodeTypes.has(node.type) && !newNode.params.target) {
        newNode.params.target = objectScopeTarget;
      }

      return newNode;
    });

    return { nodes, edges: graph.edges };
  }

  _handleGraphSet(msg) {
    this._validateScope(msg.scope);

    if (!msg.graph || typeof msg.graph !== "object") {
      throw new LoomError("INVALID_GRAPH", "graph field is required", { reason: "missing graph" });
    }

    this._validateSceneSyncGraphNodeTypes(msg.graph);

    // Export 用に元の graph を保存（deep clone）
    const graphDefinition = JSON.parse(JSON.stringify(msg.graph));

    const injectedGraph = this._injectAdapterId(msg.graph, msg.scope);

    if (typeof msg.scope === "string" && msg.scope === "scene") {
      // シーングラフの置き換え前に offset base を restore
      this._restoreBehaviorBasesForScope(msg.scope);
      // シーングラフの置き換え
      this._sceneGraph.stop();
      this._sceneGraph = new this.LoomClass(injectedGraph);
      this._sceneGraphDefinition = graphDefinition;
      if (this._started) {
        this._sceneGraph.start();
      }
    } else {
      // オブジェクト単位グラフの置き換え前に offset base を restore
      this._restoreBehaviorBasesForScope(msg.scope);
      // オブジェクト単位グラフ
      const targetId = msg.scope.object;
      if (this._objectGraphs.has(targetId)) {
        this._objectGraphs.get(targetId).stop();
      }
      const engine = new this.LoomClass(injectedGraph);
      this._objectGraphs.set(targetId, engine);
      this._objectGraphDefinitions.set(targetId, graphDefinition);

      if (this._started) {
        const t = this.getObjectRuntimeTime
          ? this.getObjectRuntimeTime(targetId, performance.now())
          : 0;
        engine.evaluateAt(t);
      }
    }
  }

  _handleGraphClear(msg) {
    this._validateScope(msg.scope);

    // offset base を restore
    this._restoreBehaviorBasesForScope(msg.scope);

    if (typeof msg.scope === "string" && msg.scope === "scene") {
      // シーングラフをクリア
      this._sceneGraph.stop();
      this._sceneGraph = new this.LoomClass({ nodes: [], edges: [] });
      this._sceneGraphDefinition = null;
      if (this._started) {
        this._sceneGraph.start();
      }
    } else {
      // オブジェクト単位グラフをクリア
      const targetId = msg.scope.object;
      if (this._objectGraphs.has(targetId)) {
        this._objectGraphs.get(targetId).stop();
        this._objectGraphs.delete(targetId);
      }
      this._objectGraphDefinitions.delete(targetId);
    }
  }

  _handleGraphPatch(msg) {
    this._validateScope(msg.scope);

    // Phase 1 では graph フィールドがあれば scene-graph-set と等価に処理
    if (msg.graph) {
      this._handleGraphSet({
        type: "scene-graph-set",
        scope: msg.scope,
        graph: msg.graph
      });
    } else {
      throw new LoomError("INVALID_GRAPH", "graph field is required for scene-graph-patch", { reason: "missing graph" });
    }
  }

  _handleGraphInput(msg) {
    // Phase 1 では no-op。入力は各クライアントでローカル評価
    console.warn("scene-graph-input is not yet supported. Phase 2 での実装予定です。");
  }

  start() {
    this._started = true;
    this._sceneGraph.start();

    // Do not call engine.start() for object graphs.
    // Object graphs are manually ticked by Scene Sync runtime time.
  }

  stop() {
    this._started = false;
    this._sceneGraph.stop();

    for (const engine of this._objectGraphs.values()) {
      engine.stop();
    }
  }

  dispose() {
    this.stop();
    this._objectGraphs.clear();
    this._objectGraphDefinitions.clear();
    this._sceneGraphDefinition = null;
    this.behaviorBases.clear();
    adapterRegistry.delete(this.adapterId);
  }

  exportState() {
    const state = {
      scene: this._sceneGraphDefinition ? JSON.parse(JSON.stringify(this._sceneGraphDefinition)) : null,
      objects: {}
    };

    for (const [objectId, definition] of this._objectGraphDefinitions) {
      if (definition) {
        state.objects[objectId] = JSON.parse(JSON.stringify(definition));
      }
    }

    return state;
  }

  importState(state) {
    if (!state || typeof state !== 'object') return;

    if (state.scene) {
      try {
        this.handleMessage({
          type: 'scene-graph-set',
          scope: 'scene',
          graph: JSON.parse(JSON.stringify(state.scene)),
        });
      } catch (err) {
        console.warn('[loom] failed to import scene graph:', err);
      }
    }

    if (state.objects && typeof state.objects === 'object') {
      for (const [objectId, graph] of Object.entries(state.objects)) {
        if (!graph) continue;
        try {
          this.handleMessage({
            type: 'scene-graph-set',
            scope: { object: objectId },
            graph: JSON.parse(JSON.stringify(graph)),
          });
        } catch (err) {
          console.warn(`[loom] failed to import object graph for ${objectId}:`, err);
        }
      }
    }
  }

  clearObjectGraph(objectId) {
    if (!objectId) return;

    const graph = this._objectGraphs.get(objectId);
    if (graph) {
      graph.stop();
      this._objectGraphs.delete(objectId);
    }

    this._objectGraphDefinitions.delete(objectId);
  }

  sendGraph(scope, graph) {
    this.send({
      type: "scene-graph-set",
      scope,
      graph
    });
  }

  clearGraph(scope) {
    this.send({
      type: "scene-graph-clear",
      scope
    });
  }
}
