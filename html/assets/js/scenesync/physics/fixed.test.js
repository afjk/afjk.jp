import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FP_ONE,
  toFp,
  fromFp,
  floorDiv,
  fmul,
  fdiv,
  fsqrt,
  fclamp,
  vadd,
  vsub,
  vscale,
  vdot,
  vlen,
  createXorShift32,
  hashInit,
  hashInt,
  hashString,
  hashHex,
} from './fixed.js';

// Independent 64-bit integer references the ports (C# / GDScript) must match.
function bigFloorDiv(n, d) {
  let q = n / d;
  if (q * d !== n && (n < 0n) !== (d < 0n)) q -= 1n;
  return q;
}

function bigIsqrt(n) {
  let remainder = n;
  let result = 0n;
  let bit = 1n << 62n;
  while (bit > remainder) bit >>= 2n;
  while (bit > 0n) {
    if (remainder >= result + bit) {
      remainder -= result + bit;
      result = (result >> 1n) + bit;
    } else {
      result >>= 1n;
    }
    bit >>= 2n;
  }
  return result;
}

const SAMPLE_VALUES = [
  0, 1, -1, 7, -7, 255, -256, 65535, 65536, -65536, 65537,
  12345, -98765, 1000000, -1000003, 2 ** 20, -(2 ** 20) + 1,
  2 ** 28, -(2 ** 28), 999999937, -999999937,
];

test('toFp / fromFp round numbers symmetrically', () => {
  assert.equal(toFp(1), FP_ONE);
  assert.equal(toFp(-9.81), -642908); // round(-9.81 * 65536)
  assert.equal(toFp(Number.NaN), 0);
  assert.equal(fromFp(FP_ONE), 1);
  assert.equal(fromFp(toFp(0.5)), 0.5);
});

test('floorDiv floors toward negative infinity', () => {
  assert.equal(floorDiv(7, 2), 3);
  assert.equal(floorDiv(-7, 2), -4);
  assert.equal(floorDiv(7, -2), -4);
  assert.equal(floorDiv(-7, -2), 3);
  assert.equal(floorDiv(6, 3), 2);
  assert.equal(floorDiv(-6, 3), -2);
  assert.throws(() => floorDiv(1, 0), RangeError);
});

test('fmul matches the 64-bit (a*b)>>16 reference', () => {
  for (const a of SAMPLE_VALUES) {
    for (const b of SAMPLE_VALUES) {
      const expected = Number((BigInt(a) * BigInt(b)) >> 16n);
      assert.equal(fmul(a, b), expected, `fmul(${a}, ${b})`);
    }
  }
});

test('fdiv matches the 64-bit floored division reference', () => {
  for (const a of SAMPLE_VALUES) {
    for (const b of SAMPLE_VALUES) {
      if (b === 0) continue;
      const expected = Number(bigFloorDiv(BigInt(a) << 16n, BigInt(b)));
      assert.equal(fdiv(a, b), expected, `fdiv(${a}, ${b})`);
    }
  }
});

test('fsqrt matches the 64-bit integer sqrt reference', () => {
  const values = [0, 1, 2, 3, 4, 65536, 65537, 164, 5898, 2 ** 30, 2 ** 40, 3 * 2 ** 42];
  for (const a of values) {
    const expected = Number(bigIsqrt(BigInt(a) << 16n));
    assert.equal(fsqrt(a), expected, `fsqrt(${a})`);
  }
  assert.equal(fsqrt(-5), 0);
  // sqrt(4.0) = 2.0, sqrt(2.0) = floor(1.41421... * 65536) = 92681
  assert.equal(fsqrt(toFp(4)), toFp(2));
  assert.equal(fsqrt(toFp(2)), 92681);
});

test('vector helpers operate component-wise in fixed point', () => {
  const a = [toFp(1), toFp(2), toFp(-3)];
  const b = [toFp(0.5), toFp(-1), toFp(4)];
  assert.deepEqual(vadd(a, b), [toFp(1.5), toFp(1), toFp(1)]);
  assert.deepEqual(vsub(a, b), [toFp(0.5), toFp(3), toFp(-7)]);
  assert.deepEqual(vscale(a, toFp(2)), [toFp(2), toFp(4), toFp(-6)]);
  // 1*0.5 + 2*(-1) + (-3)*4 = -13.5
  assert.equal(vdot(a, b), toFp(-13.5));
  // |(3,4,0)| = 5
  assert.equal(vlen([toFp(3), toFp(4), 0]), toFp(5));
});

test('fclamp limits values to the range', () => {
  assert.equal(fclamp(5, 0, 10), 5);
  assert.equal(fclamp(-5, 0, 10), 0);
  assert.equal(fclamp(15, 0, 10), 10);
});

test('xorshift32 produces a stable deterministic sequence', () => {
  const rng = createXorShift32(1);
  assert.equal(rng.nextUint32(), 270369);
  const a = createXorShift32(12345);
  const b = createXorShift32(12345);
  for (let i = 0; i < 100; i += 1) {
    assert.equal(a.nextUint32(), b.nextUint32());
  }
  const fp = a.nextFp();
  assert.ok(fp >= 0 && fp < FP_ONE);
});

test('hash is stable and sensitive to changes', () => {
  let h1 = hashInit();
  h1 = hashString(h1, 'ball-1');
  h1 = hashInt(h1, 65536);
  h1 = hashInt(h1, -642998);

  let h2 = hashInit();
  h2 = hashString(h2, 'ball-1');
  h2 = hashInt(h2, 65536);
  h2 = hashInt(h2, -642998);
  assert.equal(h1, h2);

  let h3 = hashInit();
  h3 = hashString(h3, 'ball-1');
  h3 = hashInt(h3, 65537);
  h3 = hashInt(h3, -642998);
  assert.notEqual(h1, h3);

  assert.match(hashHex(h1), /^[0-9a-f]{8}$/);
});
