import { test } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { applySceneDocumentBehaviors } from './apply-scene-behaviors.js';

const validGraph = { nodes: [], edges: [] };
const validGraphWithNodes = {
  nodes: [{ id: 'collisionEnter', type: 'event.exists', params: { type: 'collision.enter' } }],
  edges: [],
};

test('returns empty result for null behaviors', () => {
  const result = applySceneDocumentBehaviors(null, {
    managedObjects: new Map(),
    applySceneGraphOperation: () => true,
    broadcast: () => {},
  });
  deepStrictEqual(result, { applied: 0, skipped: 0, operations: [] });
});

test('returns empty result for array behaviors', () => {
  const result = applySceneDocumentBehaviors([], {
    managedObjects: new Map(),
    applySceneGraphOperation: () => true,
    broadcast: () => {},
  });
  deepStrictEqual(result, { applied: 0, skipped: 0, operations: [] });
});

test('returns empty result when applySceneGraphOperation is not a function', () => {
  const result = applySceneDocumentBehaviors(
    { objects: { ball: validGraph } },
    { managedObjects: new Map([['ball', {}]]), broadcast: () => {} }
  );
  deepStrictEqual(result, { applied: 0, skipped: 0, operations: [] });
});

test('applies object behavior for existing object', () => {
  const calls = { operations: [], broadcasts: [] };
  const managedObjects = new Map([['ball', {}]]);

  const result = applySceneDocumentBehaviors(
    { objects: { ball: validGraph } },
    {
      managedObjects,
      applySceneGraphOperation: (op) => { calls.operations.push(op); return true; },
      broadcast: (op) => calls.broadcasts.push(op),
    }
  );

  strictEqual(result.applied, 1);
  strictEqual(result.skipped, 0);
  strictEqual(calls.operations.length, 1);
  strictEqual(calls.operations[0].type, 'scene-graph-set');
  deepStrictEqual(calls.operations[0].scope, { object: 'ball' });
  deepStrictEqual(calls.operations[0].graph, validGraph);
  strictEqual(calls.broadcasts.length, 1);
  deepStrictEqual(calls.broadcasts[0], calls.operations[0]);
});

test('skips object behavior for missing object', () => {
  const calls = { operations: [] };
  const managedObjects = new Map();

  const result = applySceneDocumentBehaviors(
    { objects: { 'deleted-object': validGraph } },
    {
      managedObjects,
      applySceneGraphOperation: (op) => { calls.operations.push(op); return true; },
      broadcast: () => {},
    }
  );

  strictEqual(result.applied, 0);
  strictEqual(result.skipped, 1);
  strictEqual(calls.operations.length, 0);
});

test('applies scene-scope behavior', () => {
  const calls = { operations: [], broadcasts: [] };

  const result = applySceneDocumentBehaviors(
    { scene: validGraphWithNodes },
    {
      managedObjects: new Map(),
      applySceneGraphOperation: (op) => { calls.operations.push(op); return true; },
      broadcast: (op) => calls.broadcasts.push(op),
    }
  );

  strictEqual(result.applied, 1);
  strictEqual(result.skipped, 0);
  strictEqual(calls.operations[0].type, 'scene-graph-set');
  strictEqual(calls.operations[0].scope, 'scene');
  deepStrictEqual(calls.operations[0].graph, validGraphWithNodes);
  deepStrictEqual(calls.broadcasts[0], calls.operations[0]);
});

test('skips invalid graph (non-object)', () => {
  const calls = { operations: [] };

  const result = applySceneDocumentBehaviors(
    { objects: { ball: 'not-a-graph' } },
    {
      managedObjects: new Map([['ball', {}]]),
      applySceneGraphOperation: (op) => { calls.operations.push(op); return true; },
      broadcast: () => {},
    }
  );

  strictEqual(result.applied, 0);
  strictEqual(result.skipped, 1);
  strictEqual(calls.operations.length, 0);
});

test('skips graph without nodes/edges arrays', () => {
  const calls = { operations: [] };

  const result = applySceneDocumentBehaviors(
    { objects: { ball: { nodes: 'bad', edges: [] } } },
    {
      managedObjects: new Map([['ball', {}]]),
      applySceneGraphOperation: (op) => { calls.operations.push(op); return true; },
      broadcast: () => {},
    }
  );

  strictEqual(result.applied, 0);
  strictEqual(result.skipped, 1);
  strictEqual(calls.operations.length, 0);
});

test('counts skipped when applySceneGraphOperation returns false', () => {
  const result = applySceneDocumentBehaviors(
    { objects: { ball: validGraph } },
    {
      managedObjects: new Map([['ball', {}]]),
      applySceneGraphOperation: () => false,
      broadcast: () => {},
    }
  );

  strictEqual(result.applied, 0);
  strictEqual(result.skipped, 1);
});

test('broadcasts applied operations', () => {
  const broadcasts = [];
  const managedObjects = new Map([['ball', {}], ['cube', {}]]);

  applySceneDocumentBehaviors(
    { objects: { ball: validGraph, cube: validGraphWithNodes } },
    {
      managedObjects,
      applySceneGraphOperation: () => true,
      broadcast: (op) => broadcasts.push(op),
    }
  );

  strictEqual(broadcasts.length, 2);
  deepStrictEqual(broadcasts[0].scope, { object: 'ball' });
  deepStrictEqual(broadcasts[1].scope, { object: 'cube' });
});

test('uses default source in operation', () => {
  const calls = { operations: [] };

  applySceneDocumentBehaviors(
    { objects: { ball: validGraph } },
    {
      managedObjects: new Map([['ball', {}]]),
      applySceneGraphOperation: (op) => { calls.operations.push(op); return true; },
      broadcast: () => {},
    }
  );

  strictEqual(calls.operations[0].source, 'scene-sync-export-import');
});

test('uses custom source when provided', () => {
  const calls = { operations: [] };

  applySceneDocumentBehaviors(
    { objects: { ball: validGraph } },
    {
      managedObjects: new Map([['ball', {}]]),
      applySceneGraphOperation: (op) => { calls.operations.push(op); return true; },
      broadcast: () => {},
      source: 'custom-source',
    }
  );

  strictEqual(calls.operations[0].source, 'custom-source');
});

test('applies both scene and object behaviors', () => {
  const calls = { operations: [] };
  const managedObjects = new Map([['ball', {}]]);

  const result = applySceneDocumentBehaviors(
    { scene: validGraph, objects: { ball: validGraphWithNodes } },
    {
      managedObjects,
      applySceneGraphOperation: (op) => { calls.operations.push(op); return true; },
      broadcast: () => {},
    }
  );

  strictEqual(result.applied, 2);
  strictEqual(calls.operations[0].scope, 'scene');
  deepStrictEqual(calls.operations[1].scope, { object: 'ball' });
});

test('skips non-graph scene value', () => {
  const calls = { operations: [] };

  const result = applySceneDocumentBehaviors(
    { scene: null },
    {
      managedObjects: new Map(),
      applySceneGraphOperation: (op) => { calls.operations.push(op); return true; },
      broadcast: () => {},
    }
  );

  strictEqual(result.applied, 0);
  strictEqual(calls.operations.length, 0);
});

test('does not check managedObjects when it is not a Map', () => {
  const calls = { operations: [] };

  const result = applySceneDocumentBehaviors(
    { objects: { ball: validGraph } },
    {
      applySceneGraphOperation: (op) => { calls.operations.push(op); return true; },
      broadcast: () => {},
    }
  );

  strictEqual(result.applied, 1);
  strictEqual(calls.operations.length, 1);
});

test('includes applied operations in result', () => {
  const managedObjects = new Map([['ball', {}]]);

  const result = applySceneDocumentBehaviors(
    { objects: { ball: validGraph } },
    {
      managedObjects,
      applySceneGraphOperation: () => true,
      broadcast: () => {},
    }
  );

  strictEqual(result.operations.length, 1);
  strictEqual(result.operations[0].type, 'scene-graph-set');
  deepStrictEqual(result.operations[0].scope, { object: 'ball' });
});
