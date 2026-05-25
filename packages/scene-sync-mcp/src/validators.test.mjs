import test from 'node:test'
import assert from 'node:assert/strict'
import { computeAlignedPosition, computeFitScale, ValidationError } from './validators.mjs'

test('computeAlignedPosition aligns source minY to world Y=0', () => {
  const nextPosition = computeAlignedPosition({
    sourcePosition: [1, 2, 3],
    sourceBounds: {
      min: [0.5, 1.25, 2.5],
      center: [1, 2, 3],
      max: [1.5, 2.75, 3.5],
      size: [1, 1.5, 1]
    },
    axes: {
      y: {
        source: 'min',
        value: 0
      }
    }
  })

  assert.deepEqual(nextPosition, [1, 0.75, 3])
})

test('computeAlignedPosition aligns source to target bounds with offsets on multiple axes', () => {
  const nextPosition = computeAlignedPosition({
    sourcePosition: [0, 0, 0],
    sourceBounds: {
      min: [-1, -2, -0.5],
      center: [0, 0, 0],
      max: [1, 2, 0.5],
      size: [2, 4, 1]
    },
    targetBounds: {
      min: [9, 3, 4],
      center: [10, 5, 6],
      max: [11, 7, 8],
      size: [2, 4, 4]
    },
    axes: {
      x: {
        source: 'center',
        target: 'center'
      },
      z: {
        source: 'min',
        target: 'max',
        offset: 0.25
      }
    }
  })

  assert.deepEqual(nextPosition, [10, 0, 8.75])
})

test('computeFitScale preserves aspect ratio from the first specified axis', () => {
  const nextScale = computeFitScale({
    currentScale: [2, 2, 2],
    currentBoundsSize: [4, 2, 6],
    targetSize: { y: 1 },
    preserveAspect: true
  })

  assert.deepEqual(nextScale, [1, 1, 1])
})

test('computeFitScale supports non-uniform fit per axis', () => {
  const nextScale = computeFitScale({
    currentScale: [1, 1, 1],
    currentBoundsSize: [2, 4, 8],
    targetSize: { x: 3, y: 10 },
    preserveAspect: false
  })

  assert.deepEqual(nextScale, [1.5, 2.5, 1])
})

test('computeFitScale rejects zero-sized current bounds on a fitted axis', () => {
  assert.throws(() => {
    computeFitScale({
      currentScale: [1, 1, 1],
      currentBoundsSize: [2, 0, 8],
      targetSize: { y: 1 },
      preserveAspect: true
    })
  }, ValidationError)
})
