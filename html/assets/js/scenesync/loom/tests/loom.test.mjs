import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Loom } from '../loom.js';

describe('Loom Runtime - Cosine Node', () => {
  it('should evaluate cosine node with params', () => {
    const graph = {
      nodes: [
        {
          id: 'c',
          type: 'cosine',
          params: {
            freq: 1,
            amplitude: 2,
            phase: 0,
            offset: 3
          }
        }
      ],
      edges: []
    };

    const loom = new Loom(graph);
    loom.evaluateAt(0);

    const result = loom.getValue('c.out');
    assert.equal(result, 5, 'cos(0) * 2 + 3 = 5');
  });

  it('should evaluate cosine at t=0.25 (quarter period)', () => {
    const graph = {
      nodes: [
        {
          id: 'clock',
          type: 'clock',
          params: {}
        },
        {
          id: 'c',
          type: 'cosine',
          params: {
            freq: 1,
            amplitude: 1,
            phase: 0,
            offset: 0
          }
        }
      ],
      edges: [
        { from: 'clock.t', to: 'c.t' }
      ]
    };

    const loom = new Loom(graph);
    loom.evaluateAt(0.25);

    const result = loom.getValue('c.out');
    assert.ok(Math.abs(result) < 0.001, 'cos(π/2) ≈ 0');
  });

  it('should evaluate cosine at t=0.5 (half period)', () => {
    const graph = {
      nodes: [
        {
          id: 'clock',
          type: 'clock',
          params: {}
        },
        {
          id: 'c',
          type: 'cosine',
          params: {
            freq: 1,
            amplitude: 1,
            phase: 0,
            offset: 0
          }
        }
      ],
      edges: [
        { from: 'clock.t', to: 'c.t' }
      ]
    };

    const loom = new Loom(graph);
    loom.evaluateAt(0.5);

    const result = loom.getValue('c.out');
    assert.equal(result, -1, 'cos(π) = -1');
  });

  it('should evaluate cosine with frequency', () => {
    const graph = {
      nodes: [
        {
          id: 'clock',
          type: 'clock',
          params: {}
        },
        {
          id: 'c',
          type: 'cosine',
          params: {
            freq: 2,
            amplitude: 1,
            phase: 0,
            offset: 0
          }
        }
      ],
      edges: [
        { from: 'clock.t', to: 'c.t' }
      ]
    };

    const loom = new Loom(graph);
    loom.evaluateAt(0.25);

    const result = loom.getValue('c.out');
    assert.equal(result, -1, 'cos(2 * 0.25 * 2π) = cos(π) = -1');
  });

  it('should evaluate cosine with phase offset', () => {
    const graph = {
      nodes: [
        {
          id: 'clock',
          type: 'clock',
          params: {}
        },
        {
          id: 'c',
          type: 'cosine',
          params: {
            freq: 1,
            amplitude: 1,
            phase: Math.PI / 2,
            offset: 0
          }
        }
      ],
      edges: [
        { from: 'clock.t', to: 'c.t' }
      ]
    };

    const loom = new Loom(graph);
    loom.evaluateAt(0);

    const result = loom.getValue('c.out');
    assert.ok(Math.abs(result) < 0.001, 'cos(π/2) ≈ 0');
  });

  it('should evaluate cosine with input edge from constant', () => {
    const graph = {
      nodes: [
        {
          id: 'const',
          type: 'constant',
          params: { value: 0 }
        },
        {
          id: 'c',
          type: 'cosine',
          params: {
            freq: 1,
            amplitude: 2,
            phase: 0,
            offset: 3
          }
        }
      ],
      edges: [
        { from: 'const.out', to: 'c.t' }
      ]
    };

    const loom = new Loom(graph);
    loom.evaluateAt(0);

    const result = loom.getValue('c.out');
    assert.equal(result, 5, 'cos(0) * 2 + 3 = 5');
  });
});

describe('Loom Runtime - Sine vs Cosine', () => {
  it('should show cosine leads sine by 90 degrees', () => {
    const sineGraph = {
      nodes: [
        {
          id: 'clock',
          type: 'clock',
          params: {}
        },
        {
          id: 's',
          type: 'sine',
          params: { freq: 1, amplitude: 1, phase: 0, offset: 0 }
        }
      ],
      edges: [
        { from: 'clock.t', to: 's.t' }
      ]
    };

    const cosineGraph = {
      nodes: [
        {
          id: 'clock',
          type: 'clock',
          params: {}
        },
        {
          id: 'c',
          type: 'cosine',
          params: { freq: 1, amplitude: 1, phase: 0, offset: 0 }
        }
      ],
      edges: [
        { from: 'clock.t', to: 'c.t' }
      ]
    };

    const sineLoom = new Loom(sineGraph);
    const cosineLoom = new Loom(cosineGraph);

    // At t=0: sin(0)=0, cos(0)=1
    sineLoom.evaluateAt(0);
    cosineLoom.evaluateAt(0);
    assert.equal(sineLoom.getValue('s.out'), 0);
    assert.equal(cosineLoom.getValue('c.out'), 1);

    // At t=0.25 (π/2): sin(π/2)=1, cos(π/2)≈0
    sineLoom.evaluateAt(0.25);
    cosineLoom.evaluateAt(0.25);
    assert.equal(sineLoom.getValue('s.out'), 1);
    assert.ok(Math.abs(cosineLoom.getValue('c.out')) < 0.001);
  });
});

describe('Loom Runtime - Circular Motion (Cosine + Sine)', () => {
  it('should create circular motion pattern', () => {
    const graph = {
      nodes: [
        {
          id: 'clock',
          type: 'clock',
          params: {}
        },
        {
          id: 'x',
          type: 'cosine',
          params: { freq: 0.2, amplitude: 2, offset: 0 }
        },
        {
          id: 'z',
          type: 'sine',
          params: { freq: 0.2, amplitude: 2, offset: 0 }
        }
      ],
      edges: [
        { from: 'clock.t', to: 'x.t' },
        { from: 'clock.t', to: 'z.t' }
      ]
    };

    const loom = new Loom(graph);

    // At t=0: x should be at radius, z at 0
    loom.evaluateAt(0);
    assert.equal(loom.getValue('x.out'), 2);
    assert.equal(loom.getValue('z.out'), 0);

    // At t=0.25 (quarter turn): x and z should both be around radius/√2
    loom.evaluateAt(0.25);
    const x = loom.getValue('x.out');
    const z = loom.getValue('z.out');
    const expectedVal = 2 * Math.cos(0.25 * 0.2 * 2 * Math.PI);
    assert.ok(Math.abs(x - expectedVal) < 0.001);
  });
});
