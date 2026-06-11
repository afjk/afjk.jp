// Deterministic rigid-body world for Scene Sync physics.
//
// Linear dynamics only (no rotation): dynamic spheres and axis-aligned boxes
// against each other, static bodies, and an optional ground plane. Every
// computation uses 16.16 fixed-point integer math (see fixed.js) with a fixed
// timestep, so identical command sequences yield bit-identical states on all
// clients. Iteration order is the body insertion order; clients must apply
// world mutations in the same order (the lockstep layer guarantees this).

import {
  FP_ONE,
  toFp,
  fromFp,
  fromFpVec,
  fmul,
  fdiv,
  fsqrt,
  fclamp,
  toSafeInt,
  sanitizeFpVec,
  vadd,
  vsub,
  vneg,
  vscale,
  vdot,
  vclampComponents,
  hashInit,
  hashInt,
  hashString,
} from './fixed.js';

export const DEFAULT_TIMESTEP_FP = 1092; // ≈ 1/60 s
export const DEFAULT_GRAVITY_FP = -642908; // -9.81 m/s²

export const MAX_POSITION_FP = 1 << 28; // ±4096 m
export const MAX_VELOCITY_FP = 1 << 24; // ±256 m/s
export const MAX_EXTENT_FP = 1 << 24;
export const MAX_IMPULSE_FP = 2 ** 36;

const MIN_MASS = 0.01;
const MAX_MASS = 1000;

const SOLVER_ITERATIONS = 4;
const PENETRATION_SLOP_FP = 655; // 0.01 m
const CORRECTION_PERCENT_FP = 13107; // 0.2
const RESTITUTION_MIN_SPEED_FP = 32768; // bounces below 0.5 m/s are absorbed
const FRICTION_MIN_TANGENT_SQ_FP = 16;
const SLEEP_SPEED_SQ_FP = 164; // ≈ (0.05 m/s)²
const SLEEP_TICKS = 60;

function clampNumber(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function toFpVecSafe(value) {
  const v = Array.isArray(value) && value.length >= 3 ? value : [0, 0, 0];
  return [toFp(Number(v[0])), toFp(Number(v[1])), toFp(Number(v[2]))];
}

function normalizeGravity(gravity) {
  if (Array.isArray(gravity)) {
    return vclampComponents(toFpVecSafe(gravity), MAX_VELOCITY_FP);
  }
  if (Number.isFinite(gravity)) {
    return [0, fclamp(toFp(gravity), -MAX_VELOCITY_FP, MAX_VELOCITY_FP), 0];
  }
  return [0, DEFAULT_GRAVITY_FP, 0];
}

function normalizeGround(ground) {
  if (ground === null || ground === false) return null;
  const def = typeof ground === 'object' && ground !== null ? ground : {};
  return {
    yFp: fclamp(toFp(Number.isFinite(def.y) ? def.y : 0), -MAX_POSITION_FP, MAX_POSITION_FP),
    restitutionFp: fclamp(toFp(Number.isFinite(def.restitution) ? def.restitution : 0.2), 0, FP_ONE),
    frictionFp: fclamp(toFp(Number.isFinite(def.friction) ? def.friction : 0.5), 0, FP_ONE),
  };
}

const MAX_INV_MASS_FP = 6553600; // fdiv(FP_ONE, toFp(MIN_MASS))

// Converts a float body definition into a raw fixed-point body record.
// Conversion happens once on the issuing client; the record (not the float
// def) is what travels over the wire and feeds the simulation.
export function normalizeBodyDef(def) {
  if (!def || typeof def.id !== 'string' || def.id.length === 0) {
    throw new TypeError('normalizeBodyDef: body def requires a non-empty string id');
  }
  const shape = def.shape === 'box' ? 'box' : 'sphere';
  const halfSource = Array.isArray(def.halfExtents) && def.halfExtents.length >= 3
    ? def.halfExtents
    : [0.5, 0.5, 0.5];
  const mass = Number.isFinite(def.mass) ? def.mass : 1;
  const isStatic = def.static === true || mass <= 0;
  return {
    id: def.id,
    shape,
    radiusFp: shape === 'sphere'
      ? fclamp(toFp(Number.isFinite(def.radius) ? def.radius : 0.5), 1, MAX_EXTENT_FP)
      : 0,
    halfFp: shape === 'box'
      ? [
        fclamp(toFp(Number(halfSource[0])), 1, MAX_EXTENT_FP),
        fclamp(toFp(Number(halfSource[1])), 1, MAX_EXTENT_FP),
        fclamp(toFp(Number(halfSource[2])), 1, MAX_EXTENT_FP),
      ]
      : [0, 0, 0],
    positionFp: sanitizeFpVec(toFpVecSafe(def.position), MAX_POSITION_FP),
    velocityFp: sanitizeFpVec(toFpVecSafe(def.velocity), MAX_VELOCITY_FP),
    invMassFp: isStatic ? 0 : fdiv(FP_ONE, toFp(clampNumber(mass, MIN_MASS, MAX_MASS))),
    restitutionFp: fclamp(toFp(Number.isFinite(def.restitution) ? def.restitution : 0.2), 0, FP_ONE),
    frictionFp: fclamp(toFp(Number.isFinite(def.friction) ? def.friction : 0.5), 0, FP_ONE),
    sleepCounter: 0,
    sleeping: false,
  };
}

// Deterministically coerces a raw body record received from the network
// (command payload or snapshot) back into safe bounds. Returns null when the
// record has no usable id, which every client treats the same way.
export function sanitizeBodyRecord(record) {
  if (!record || typeof record.id !== 'string' || record.id.length === 0) return null;
  const shape = record.shape === 'box' ? 'box' : 'sphere';
  return {
    id: record.id,
    shape,
    radiusFp: shape === 'sphere'
      ? fclamp(toSafeInt(record.radiusFp, FP_ONE >> 1), 1, MAX_EXTENT_FP)
      : 0,
    halfFp: shape === 'box'
      ? sanitizeFpVec(record.halfFp, MAX_EXTENT_FP).map((v) => fclamp(v, 1, MAX_EXTENT_FP))
      : [0, 0, 0],
    positionFp: sanitizeFpVec(record.positionFp, MAX_POSITION_FP),
    velocityFp: sanitizeFpVec(record.velocityFp, MAX_VELOCITY_FP),
    invMassFp: fclamp(toSafeInt(record.invMassFp, FP_ONE), 0, MAX_INV_MASS_FP),
    restitutionFp: fclamp(toSafeInt(record.restitutionFp), 0, FP_ONE),
    frictionFp: fclamp(toSafeInt(record.frictionFp), 0, FP_ONE),
    sleepCounter: fclamp(toSafeInt(record.sleepCounter), 0, SLEEP_TICKS),
    sleeping: record.sleeping === true,
  };
}

export function createWorld(options = {}) {
  const gravityFp = normalizeGravity(options.gravity);
  const timestepFp = Number.isInteger(options.timestepFp) && options.timestepFp > 0
    ? options.timestepFp
    : DEFAULT_TIMESTEP_FP;
  const ground = normalizeGround(options.ground);
  const groundBody = ground
    ? {
      id: '__ground__',
      invMassFp: 0,
      velocityFp: [0, 0, 0],
      restitutionFp: ground.restitutionFp,
      frictionFp: ground.frictionFp,
      sleeping: false,
    }
    : null;

  const bodies = [];
  const bodyIndex = new Map();
  let tick = 0;

  function rebuildIndex() {
    bodyIndex.clear();
    for (let i = 0; i < bodies.length; i += 1) {
      bodyIndex.set(bodies[i].id, i);
    }
  }

  function getRecord(id) {
    const index = bodyIndex.get(id);
    return index === undefined ? null : bodies[index];
  }

  function wake(body) {
    body.sleeping = false;
    body.sleepCounter = 0;
  }

  function wakeAll() {
    for (const body of bodies) {
      if (body.invMassFp !== 0) wake(body);
    }
  }

  function isAwakeDynamic(body) {
    return body.invMassFp !== 0 && !body.sleeping;
  }

  function clampPosition(v) {
    return vclampComponents(v, MAX_POSITION_FP);
  }

  function clampVelocity(v) {
    return vclampComponents(v, MAX_VELOCITY_FP);
  }

  function addBody(def) {
    return addBodyRecord(normalizeBodyDef(def));
  }

  // Raw fixed-point entry point used by the lockstep command log.
  function addBodyRecord(record) {
    const body = sanitizeBodyRecord(record);
    if (!body) return null;
    if (bodyIndex.has(body.id)) removeBody(body.id);
    bodyIndex.set(body.id, bodies.length);
    bodies.push(body);
    return exportBody(body);
  }

  function removeBody(id) {
    const index = bodyIndex.get(id);
    if (index === undefined) return false;
    bodies.splice(index, 1);
    rebuildIndex();
    // 支えを失った body が眠ったまま浮かないように全員起こす
    wakeAll();
    return true;
  }

  function hasBody(id) {
    return bodyIndex.has(id);
  }

  function applyImpulseFp(id, impulseFpInput) {
    const body = getRecord(id);
    if (!body || body.invMassFp === 0) return false;
    wake(body);
    const impulseFp = sanitizeFpVec(impulseFpInput, MAX_IMPULSE_FP);
    body.velocityFp = clampVelocity([
      body.velocityFp[0] + fmul(body.invMassFp, impulseFp[0]),
      body.velocityFp[1] + fmul(body.invMassFp, impulseFp[1]),
      body.velocityFp[2] + fmul(body.invMassFp, impulseFp[2]),
    ]);
    return true;
  }

  function applyImpulse(id, impulse) {
    return applyImpulseFp(id, toFpVecSafe(impulse));
  }

  function setVelocityFp(id, velocityFpInput) {
    const body = getRecord(id);
    if (!body || body.invMassFp === 0) return false;
    wake(body);
    body.velocityFp = sanitizeFpVec(velocityFpInput, MAX_VELOCITY_FP);
    return true;
  }

  function setVelocity(id, velocity) {
    return setVelocityFp(id, toFpVecSafe(velocity));
  }

  function teleportFp(id, positionFpInput) {
    const body = getRecord(id);
    if (!body) return false;
    if (body.invMassFp !== 0) wake(body);
    body.positionFp = sanitizeFpVec(positionFpInput, MAX_POSITION_FP);
    return true;
  }

  function teleport(id, position) {
    return teleportFp(id, toFpVecSafe(position));
  }

  // --- contact generation ---
  // Contacts store { a, b, normalFp, penetrationFp } with the unit normal
  // pointing from a toward b.

  function sphereSphere(a, b) {
    const delta = vsub(b.positionFp, a.positionFp);
    const distSq = vdot(delta, delta);
    const radiusSum = a.radiusFp + b.radiusFp;
    if (distSq >= fmul(radiusSum, radiusSum)) return null;
    const dist = fsqrt(distSq);
    const normalFp = dist === 0
      ? [0, FP_ONE, 0]
      : [fdiv(delta[0], dist), fdiv(delta[1], dist), fdiv(delta[2], dist)];
    return { a, b, normalFp, penetrationFp: radiusSum - dist };
  }

  function sphereBox(sphere, box, flipped) {
    const minB = vsub(box.positionFp, box.halfFp);
    const maxB = vadd(box.positionFp, box.halfFp);
    const closest = [
      fclamp(sphere.positionFp[0], minB[0], maxB[0]),
      fclamp(sphere.positionFp[1], minB[1], maxB[1]),
      fclamp(sphere.positionFp[2], minB[2], maxB[2]),
    ];
    const delta = vsub(closest, sphere.positionFp);
    const distSq = vdot(delta, delta);
    let normalFp;
    let penetrationFp;
    if (distSq > 0) {
      if (distSq >= fmul(sphere.radiusFp, sphere.radiusFp)) return null;
      const dist = fsqrt(distSq);
      if (dist === 0) return null;
      normalFp = [fdiv(delta[0], dist), fdiv(delta[1], dist), fdiv(delta[2], dist)];
      penetrationFp = sphere.radiusFp - dist;
    } else {
      // Sphere center inside the box: push out through the nearest face.
      // Deterministic tie-break: -x, +x, -y, +y, -z, +z with strict <.
      let bestAxis = 0;
      let bestSign = -1;
      let bestDepth = Number.MAX_SAFE_INTEGER;
      for (let axis = 0; axis < 3; axis += 1) {
        const toMin = sphere.positionFp[axis] - minB[axis];
        if (toMin < bestDepth) {
          bestDepth = toMin;
          bestAxis = axis;
          bestSign = -1;
        }
        const toMax = maxB[axis] - sphere.positionFp[axis];
        if (toMax < bestDepth) {
          bestDepth = toMax;
          bestAxis = axis;
          bestSign = 1;
        }
      }
      normalFp = [0, 0, 0];
      // normal は a(sphere)→b(box) 向きなので、押し出し方向の逆を指す
      normalFp[bestAxis] = -bestSign * FP_ONE;
      penetrationFp = bestDepth + sphere.radiusFp;
    }
    if (flipped) {
      return { a: box, b: sphere, normalFp: vneg(normalFp), penetrationFp };
    }
    return { a: sphere, b: box, normalFp, penetrationFp };
  }

  function boxBox(a, b) {
    const delta = vsub(b.positionFp, a.positionFp);
    let bestAxis = -1;
    let bestOverlap = Number.MAX_SAFE_INTEGER;
    for (let axis = 0; axis < 3; axis += 1) {
      const overlap = a.halfFp[axis] + b.halfFp[axis] - Math.abs(delta[axis]);
      if (overlap <= 0) return null;
      if (overlap < bestOverlap) {
        bestOverlap = overlap;
        bestAxis = axis;
      }
    }
    const normalFp = [0, 0, 0];
    normalFp[bestAxis] = delta[bestAxis] >= 0 ? FP_ONE : -FP_ONE;
    return { a, b, normalFp, penetrationFp: bestOverlap };
  }

  function detectContact(a, b) {
    if (a.shape === 'sphere' && b.shape === 'sphere') return sphereSphere(a, b);
    if (a.shape === 'sphere' && b.shape === 'box') return sphereBox(a, b, false);
    if (a.shape === 'box' && b.shape === 'sphere') return sphereBox(b, a, true);
    return boxBox(a, b);
  }

  function detectGroundContact(body) {
    const bottom = body.shape === 'sphere'
      ? body.positionFp[1] - body.radiusFp
      : body.positionFp[1] - body.halfFp[1];
    const penetrationFp = ground.yFp - bottom;
    if (penetrationFp <= 0) return null;
    return { a: groundBody, b: body, normalFp: [0, FP_ONE, 0], penetrationFp };
  }

  // --- contact solving ---

  function applyBodyImpulse(body, impulseFp) {
    if (body.invMassFp === 0) return;
    body.velocityFp = clampVelocity([
      body.velocityFp[0] + fmul(body.invMassFp, impulseFp[0]),
      body.velocityFp[1] + fmul(body.invMassFp, impulseFp[1]),
      body.velocityFp[2] + fmul(body.invMassFp, impulseFp[2]),
    ]);
  }

  function resolveContactVelocity(contact) {
    const { a, b, normalFp: n } = contact;
    const invMassSum = a.invMassFp + b.invMassFp;
    if (invMassSum === 0) return;
    let relVel = vsub(b.velocityFp, a.velocityFp);
    const vn = vdot(relVel, n);
    if (vn >= 0) return;
    const restitution = -vn > RESTITUTION_MIN_SPEED_FP
      ? Math.min(a.restitutionFp, b.restitutionFp)
      : 0;
    const jn = fclamp(
      fdiv(fmul(-(FP_ONE + restitution), vn), invMassSum),
      0,
      MAX_IMPULSE_FP,
    );
    applyBodyImpulse(a, vscale(n, -jn));
    applyBodyImpulse(b, vscale(n, jn));

    // Coulomb friction clamped by the normal impulse
    relVel = vsub(b.velocityFp, a.velocityFp);
    const tangent = vsub(relVel, vscale(n, vdot(relVel, n)));
    const tangentLenSq = vdot(tangent, tangent);
    if (tangentLenSq <= FRICTION_MIN_TANGENT_SQ_FP) return;
    const tangentLen = fsqrt(tangentLenSq);
    if (tangentLen === 0) return;
    const t = [
      fdiv(tangent[0], tangentLen),
      fdiv(tangent[1], tangentLen),
      fdiv(tangent[2], tangentLen),
    ];
    const friction = Math.min(a.frictionFp, b.frictionFp);
    const maxFriction = fmul(friction, jn);
    const jt = fclamp(fdiv(-vdot(relVel, t), invMassSum), -maxFriction, maxFriction);
    applyBodyImpulse(a, vscale(t, -jt));
    applyBodyImpulse(b, vscale(t, jt));
  }

  function correctPositions(contact) {
    const { a, b, normalFp: n, penetrationFp } = contact;
    const invMassSum = a.invMassFp + b.invMassFp;
    if (invMassSum === 0) return;
    const depth = penetrationFp - PENETRATION_SLOP_FP;
    if (depth <= 0) return;
    const correction = fdiv(fmul(depth, CORRECTION_PERCENT_FP), invMassSum);
    if (a.invMassFp !== 0) {
      a.positionFp = clampPosition(vsub(a.positionFp, vscale(n, fmul(a.invMassFp, correction))));
    }
    if (b.invMassFp !== 0) {
      b.positionFp = clampPosition(vadd(b.positionFp, vscale(n, fmul(b.invMassFp, correction))));
    }
  }

  function step() {
    for (const body of bodies) {
      if (!isAwakeDynamic(body)) continue;
      body.velocityFp = clampVelocity(vadd(body.velocityFp, vscale(gravityFp, timestepFp)));
      body.positionFp = clampPosition(vadd(body.positionFp, vscale(body.velocityFp, timestepFp)));
    }

    const contacts = [];
    for (let i = 0; i < bodies.length; i += 1) {
      const a = bodies[i];
      for (let j = i + 1; j < bodies.length; j += 1) {
        const b = bodies[j];
        if (!isAwakeDynamic(a) && !isAwakeDynamic(b)) continue;
        const contact = detectContact(a, b);
        if (!contact) continue;
        if (a.sleeping) wake(a);
        if (b.sleeping) wake(b);
        contacts.push(contact);
      }
    }
    if (groundBody) {
      for (const body of bodies) {
        if (!isAwakeDynamic(body)) continue;
        const contact = detectGroundContact(body);
        if (contact) contacts.push(contact);
      }
    }

    for (let iteration = 0; iteration < SOLVER_ITERATIONS; iteration += 1) {
      for (const contact of contacts) resolveContactVelocity(contact);
    }
    for (const contact of contacts) correctPositions(contact);

    for (const body of bodies) {
      if (!isAwakeDynamic(body)) continue;
      if (vdot(body.velocityFp, body.velocityFp) < SLEEP_SPEED_SQ_FP) {
        body.sleepCounter += 1;
        if (body.sleepCounter >= SLEEP_TICKS) {
          body.sleeping = true;
          body.velocityFp = [0, 0, 0];
        }
      } else {
        body.sleepCounter = 0;
      }
    }

    tick += 1;
  }

  function stepTo(targetTick) {
    while (Number.isInteger(targetTick) && tick < targetTick) step();
  }

  // --- state access ---

  function exportBody(body) {
    const result = {
      id: body.id,
      shape: body.shape,
      position: fromFpVec(body.positionFp),
      velocity: fromFpVec(body.velocityFp),
      static: body.invMassFp === 0,
      sleeping: body.sleeping,
    };
    if (body.shape === 'sphere') result.radius = fromFp(body.radiusFp);
    else result.halfExtents = fromFpVec(body.halfFp);
    return result;
  }

  function getBody(id) {
    const body = getRecord(id);
    return body ? exportBody(body) : null;
  }

  function getBodies() {
    return bodies.map(exportBody);
  }

  function snapshot() {
    return {
      tick,
      bodies: bodies.map((body) => ({
        id: body.id,
        shape: body.shape,
        radiusFp: body.radiusFp,
        halfFp: [...body.halfFp],
        positionFp: [...body.positionFp],
        velocityFp: [...body.velocityFp],
        invMassFp: body.invMassFp,
        restitutionFp: body.restitutionFp,
        frictionFp: body.frictionFp,
        sleepCounter: body.sleepCounter,
        sleeping: body.sleeping,
      })),
    };
  }

  function restore(snap) {
    tick = Number.isInteger(snap?.tick) && snap.tick >= 0 ? snap.tick : 0;
    bodies.length = 0;
    bodyIndex.clear();
    for (const record of snap?.bodies ?? []) {
      const body = sanitizeBodyRecord(record);
      if (!body || bodyIndex.has(body.id)) continue;
      bodyIndex.set(body.id, bodies.length);
      bodies.push(body);
    }
  }

  // Hashes every value that can influence future simulation steps — the same
  // set of fields a snapshot carries, plus the world configuration. Two
  // worlds must only compare hashes when they agree on all of this.
  function stateHash() {
    let h = hashInit();
    h = hashInt(h, timestepFp);
    for (const component of gravityFp) h = hashInt(h, component);
    h = hashInt(h, ground ? 1 : 0);
    if (ground) {
      h = hashInt(h, ground.yFp);
      h = hashInt(h, ground.restitutionFp);
      h = hashInt(h, ground.frictionFp);
    }
    h = hashInt(h, tick);
    for (const body of bodies) {
      h = hashString(h, body.id);
      h = hashString(h, body.shape);
      h = hashInt(h, body.radiusFp);
      for (const component of body.halfFp) h = hashInt(h, component);
      for (const component of body.positionFp) h = hashInt(h, component);
      for (const component of body.velocityFp) h = hashInt(h, component);
      h = hashInt(h, body.invMassFp);
      h = hashInt(h, body.restitutionFp);
      h = hashInt(h, body.frictionFp);
      h = hashInt(h, body.sleepCounter);
      h = hashInt(h, body.sleeping ? 1 : 0);
    }
    return h >>> 0;
  }

  return {
    get tick() { return tick; },
    timestepFp,
    addBody,
    addBodyRecord,
    removeBody,
    hasBody,
    applyImpulse,
    applyImpulseFp,
    setVelocity,
    setVelocityFp,
    teleport,
    teleportFp,
    step,
    stepTo,
    getBody,
    getBodies,
    snapshot,
    restore,
    stateHash,
  };
}
