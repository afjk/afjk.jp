const KNOWN_KINDS = new Set([
  'scene-add',
  'scene-delta',
  'scene-remove',
  'scene-mesh',
  'scene-env',
  'scene-bgm',
  'scene-physics',
  'scene-state',
  'scene-request',
  'scene-clock',
  'scene-avatar',
  'scene-lock',
  'scene-unlock',
  'scene-physics-hash',
  'scene-event',
  'scene-event-log',
  'scene-event-log-request',
  'scene-physics-input',
  'scene-physics-input-log-clear',
  'scene-physics-input-log',
  'scene-physics-input-log-request',
  'scene-physics-snapshot',
  'scene-physics-snapshot-request',
  'scene-asset-request',
  'scene-inspector',
  'scene-batch',
  'ai-command',
  'ai-link-established',
  'ai-link-revoked',
  'ai-result',
  'file',
]);

const ENV_IDS = new Set(['studio', 'outdoor_day', 'outdoor_sunset', 'outdoor_night', 'indoor_warm']);

function isReasonableString(value, maxLength = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function hasFiniteNumberArray(value, size) {
  return Array.isArray(value)
    && value.length === size
    && value.every(item => typeof item === 'number' && Number.isFinite(item));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateScenePhysicsPayload(physics) {
  if (!physics || typeof physics !== 'object' || Array.isArray(physics)) {
    return { ok: false, reason: 'physics must be an object' };
  }

  if (physics.version !== undefined && (!Number.isInteger(physics.version) || physics.version < 1)) {
    return { ok: false, reason: 'physics.version must be a positive integer' };
  }
  if (physics.enabled !== undefined && typeof physics.enabled !== 'boolean') {
    return { ok: false, reason: 'physics.enabled must be a boolean' };
  }
  if (physics.duration !== undefined && (!isFiniteNumber(physics.duration) || physics.duration <= 0)) {
    return { ok: false, reason: 'physics.duration must be a positive finite number' };
  }

  const worldOptions = physics.worldOptions;
  if (worldOptions !== undefined) {
    if (!worldOptions || typeof worldOptions !== 'object' || Array.isArray(worldOptions)) {
      return { ok: false, reason: 'physics.worldOptions must be an object' };
    }

    if (
      worldOptions.gravity !== undefined
      && !isFiniteNumber(worldOptions.gravity)
      && !hasFiniteNumberArray(worldOptions.gravity, 3)
    ) {
      return { ok: false, reason: 'physics.worldOptions.gravity must be a finite number or [x,y,z]' };
    }

    if (
      worldOptions.timestep !== undefined
      && (!isFiniteNumber(worldOptions.timestep) || worldOptions.timestep <= 0)
    ) {
      return { ok: false, reason: 'physics.worldOptions.timestep must be a positive finite number' };
    }

    const ground = worldOptions.ground;
    if (ground !== undefined && ground !== null && ground !== false) {
      if (typeof ground !== 'object' || Array.isArray(ground)) {
        return { ok: false, reason: 'physics.worldOptions.ground must be an object, null, or false' };
      }
      for (const field of ['y', 'restitution', 'friction']) {
        if (ground[field] !== undefined && !isFiniteNumber(ground[field])) {
          return { ok: false, reason: `physics.worldOptions.ground.${field} must be finite` };
        }
      }
    }
  }

  return { ok: true };
}

function validateOptionalReasonableString(payload, key, maxLength = 128) {
  if (payload[key] === undefined || payload[key] === null) return { ok: true };
  if (!isReasonableString(payload[key], maxLength)) {
    return { ok: false, reason: `${key} must be a reasonable string` };
  }
  return { ok: true };
}

function validateOptionalFiniteNumber(payload, key) {
  if (payload[key] === undefined || payload[key] === null) return { ok: true };
  if (!isFiniteNumber(payload[key])) {
    return { ok: false, reason: `${key} must be finite` };
  }
  return { ok: true };
}

function validateOptionalNonNegativeInteger(payload, key) {
  if (payload[key] === undefined || payload[key] === null) return { ok: true };
  if (!Number.isInteger(payload[key]) || payload[key] < 0) {
    return { ok: false, reason: `${key} must be a non-negative integer` };
  }
  return { ok: true };
}

function validateOptionalTimelineVersion(payload, key, maxStringLength = 128) {
  if (payload[key] === undefined || payload[key] === null) return { ok: true };
  if (isReasonableString(payload[key], maxStringLength)) return { ok: true };
  if (Number.isInteger(payload[key]) && payload[key] >= 0) return { ok: true };
  return { ok: false, reason: `${key} must be a reasonable string or non-negative integer` };
}

function validateOptionalObject(payload, key) {
  if (payload[key] === undefined || payload[key] === null) return { ok: true };
  if (typeof payload[key] !== 'object' || Array.isArray(payload[key])) {
    return { ok: false, reason: `${key} must be an object` };
  }
  return { ok: true };
}

function validateSceneEventTimelineMetadata(payload, maxStringLength, prefix = '') {
  const key = name => `${prefix}${name}`;
  for (const field of ['eventLogKind', 'source', 'phase', 'timelineId', 'requestId', 'reason', 'requestKind', 'requestReason', 'requestTimelineId']) {
    const result = validateOptionalReasonableString(payload, field, maxStringLength);
    if (!result.ok) return { ok: false, reason: `${key(field)} must be a reasonable string` };
  }
  const timelineVersionResult = validateOptionalTimelineVersion(payload, 'timelineVersion', maxStringLength);
  if (!timelineVersionResult.ok) {
    return { ok: false, reason: `${key('timelineVersion')} must be a reasonable string or non-negative integer` };
  }
  for (const field of [
    'timelineRevision',
    'timelineForkTick',
    'timelineClearRevision',
    'lastEventRevision',
    'eventCount',
    'inputCount',
    'requestTimelineRevision',
    'requestTimelineClearRevision',
  ]) {
    const result = validateOptionalNonNegativeInteger(payload, field);
    if (!result.ok) return { ok: false, reason: `${key(field)} must be a non-negative integer` };
  }
  for (const field of ['sceneClockRevision', 'sentAt']) {
    const result = validateOptionalFiniteNumber(payload, field);
    if (!result.ok) return { ok: false, reason: `${key(field)} must be finite` };
  }
  return { ok: true };
}

function validateSceneEventPayload(payload, maxStringLength) {
  const channel = payload.channel ?? payload.type;
  if (!isReasonableString(channel, maxStringLength)) {
    return { ok: false, reason: 'scene-event.channel must be a reasonable string' };
  }
  for (const field of ['timelineId', 'eventId', 'inputId', 'interactionId', 'channel', 'type', 'source', 'phase', 'target', 'objectId', 'sourcePeerId', 'sourceUserId']) {
    const result = validateOptionalReasonableString(payload, field, maxStringLength);
    if (!result.ok) return result;
  }
  const timelineVersionResult = validateOptionalTimelineVersion(payload, 'timelineVersion', maxStringLength);
  if (!timelineVersionResult.ok) return timelineVersionResult;
  for (const field of ['timelineRevision', 'timelineClearRevision', 'eventRevision', 'sequence', 'applyTick', 'branchTick']) {
    const result = validateOptionalNonNegativeInteger(payload, field);
    if (!result.ok) return result;
  }
  for (const field of ['timestamp', 'time', 'sentAt']) {
    const result = validateOptionalFiniteNumber(payload, field);
    if (!result.ok) return result;
  }
  if (payload.position !== undefined && !hasFiniteNumberArray(payload.position, 3)) {
    return { ok: false, reason: 'scene-event.position must be finite [x,y,z]' };
  }
  if (payload.rotation !== undefined && !hasFiniteNumberArray(payload.rotation, 4)) {
    return { ok: false, reason: 'scene-event.rotation must be finite quaternion [x,y,z,w]' };
  }
  for (const field of ['velocity', 'linearVelocity', 'angularVelocity', 'angvel']) {
    if (payload[field] !== undefined && !hasFiniteNumberArray(payload[field], 3)) {
      return { ok: false, reason: `scene-event.${field} must be finite [x,y,z]` };
    }
  }
  const payloadResult = validateOptionalObject(payload, 'payload');
  if (!payloadResult.ok) return payloadResult;
  return { ok: true };
}

function validateSceneEventLogPayload(payload, maxStringLength) {
  const metadataResult = validateSceneEventTimelineMetadata(payload, maxStringLength);
  if (!metadataResult.ok) return metadataResult;

  if (payload.events !== undefined) {
    if (!Array.isArray(payload.events)) {
      return { ok: false, reason: 'scene-event-log.events must be an array' };
    }
    if (payload.events.length > 2000) {
      return { ok: false, reason: 'scene-event-log.events is too large' };
    }
    for (const event of payload.events) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        return { ok: false, reason: 'scene-event-log.events entries must be objects' };
      }
      const result = validateSceneEventPayload(event, maxStringLength);
      if (!result.ok) return { ok: false, reason: `invalid scene-event-log event: ${result.reason}` };
    }
  }

  if (payload.inputs !== undefined) {
    if (!Array.isArray(payload.inputs)) {
      return { ok: false, reason: 'scene-event-log.inputs must be an array' };
    }
    if (payload.inputs.length > 2000) {
      return { ok: false, reason: 'scene-event-log.inputs is too large' };
    }
    for (const input of payload.inputs) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: false, reason: 'scene-event-log.inputs entries must be objects' };
      }
      const result = validateScenePhysicsInputPayload(input, maxStringLength);
      if (!result.ok) return { ok: false, reason: `invalid scene-event-log input: ${result.reason}` };
    }
  }

  const controllerValidation = validatePhysicsController(payload.controller, maxStringLength);
  if (!controllerValidation.ok) return controllerValidation;
  const clockValidation = validateObjectClock(payload.clock, 'scene-event-log.clock');
  if (!clockValidation.ok) return clockValidation;

  if (payload.snapshot !== undefined && payload.snapshot !== null) {
    if (typeof payload.snapshot !== 'object' || Array.isArray(payload.snapshot)) {
      return { ok: false, reason: 'scene-event-log.snapshot must be an object' };
    }
    const snapshotValidation = validateScenePhysicsSyncPayload(
      { ...payload.snapshot, kind: 'scene-physics-snapshot' },
      maxStringLength,
    );
    if (!snapshotValidation.ok) {
      return { ok: false, reason: `invalid scene-event-log snapshot: ${snapshotValidation.reason}` };
    }
  }

  return { ok: true };
}

function validateSceneEventLogRequestPayload(payload, maxStringLength) {
  const metadataResult = validateSceneEventTimelineMetadata(payload, maxStringLength);
  if (!metadataResult.ok) return metadataResult;
  if (payload.timelines !== undefined) {
    if (!Array.isArray(payload.timelines)) {
      return { ok: false, reason: 'scene-event-log-request.timelines must be an array' };
    }
    if (payload.timelines.length > 32) {
      return { ok: false, reason: 'scene-event-log-request.timelines is too large' };
    }
    for (let index = 0; index < payload.timelines.length; index += 1) {
      const timeline = payload.timelines[index];
      if (!timeline || typeof timeline !== 'object' || Array.isArray(timeline)) {
        return { ok: false, reason: 'scene-event-log-request.timelines entries must be objects' };
      }
      const result = validateSceneEventTimelineMetadata(timeline, maxStringLength, `scene-event-log-request.timelines[${index}].`);
      if (!result.ok) return result;
    }
  }
  return { ok: true };
}

function validatePhysicsController(controller, maxStringLength) {
  if (controller === undefined || controller === null) return { ok: true };
  if (typeof controller !== 'object' || Array.isArray(controller)) {
    return { ok: false, reason: 'controller must be an object or null' };
  }
  for (const key of ['id', 'nickname']) {
    const result = validateOptionalReasonableString(controller, key, maxStringLength);
    if (!result.ok) return { ok: false, reason: `controller.${result.reason}` };
  }
  return { ok: true };
}

function validatePhysicsSnapshotBody(body, maxStringLength) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'snapshot body must be an object' };
  }
  if (!isReasonableString(body.id, maxStringLength)) {
    return { ok: false, reason: 'snapshot body.id must be a reasonable string' };
  }
  const typeResult = validateOptionalReasonableString(body, 'type', maxStringLength);
  if (!typeResult.ok) return { ok: false, reason: `snapshot body.${typeResult.reason}` };
  if (body.position !== undefined && !hasFiniteNumberArray(body.position, 3)) {
    return { ok: false, reason: 'snapshot body.position must be finite [x,y,z]' };
  }
  if (body.rotation !== undefined && !hasFiniteNumberArray(body.rotation, 4)) {
    return { ok: false, reason: 'snapshot body.rotation must be finite quaternion [x,y,z,w]' };
  }
  if (body.velocity !== undefined && !hasFiniteNumberArray(body.velocity, 3)) {
    return { ok: false, reason: 'snapshot body.velocity must be finite [x,y,z]' };
  }
  if (body.angularVelocity !== undefined && !hasFiniteNumberArray(body.angularVelocity, 3)) {
    return { ok: false, reason: 'snapshot body.angularVelocity must be finite [x,y,z]' };
  }
  return { ok: true };
}

function validateScenePhysicsInputPayload(payload, maxStringLength) {
  if (payload.inputType !== 'set-body-state') {
    return { ok: false, reason: 'scene-physics-input.inputType is invalid' };
  }
  if (!isReasonableString(payload.objectId, maxStringLength)) {
    return { ok: false, reason: 'scene-physics-input.objectId must be a reasonable string' };
  }
  for (const key of ['inputId', 'timelineVersion', 'timelineId', 'interactionId', 'phase', 'controlMode']) {
    const result = validateOptionalReasonableString(payload, key, maxStringLength);
    if (!result.ok) return result;
  }
  if (payload.hold !== undefined && payload.hold !== null && typeof payload.hold !== 'boolean') {
    return { ok: false, reason: 'scene-physics-input.hold must be a boolean' };
  }
  for (const key of ['timelineRevision', 'timelineClearRevision', 'eventRevision', 'sequence', 'branchTick']) {
    const result = validateOptionalNonNegativeInteger(payload, key);
    if (!result.ok) return result;
  }
  if (!Number.isInteger(payload.applyTick) || payload.applyTick < 0) {
    return { ok: false, reason: 'scene-physics-input.applyTick must be a non-negative integer' };
  }
  if (!hasFiniteNumberArray(payload.position, 3)) {
    return { ok: false, reason: 'scene-physics-input.position must be finite [x,y,z]' };
  }
  if (!hasFiniteNumberArray(payload.rotation, 4)) {
    return { ok: false, reason: 'scene-physics-input.rotation must be finite quaternion [x,y,z,w]' };
  }
  for (const key of ['velocity', 'linearVelocity', 'angularVelocity', 'angvel']) {
    if (payload[key] !== undefined && !hasFiniteNumberArray(payload[key], 3)) {
      return { ok: false, reason: `scene-physics-input.${key} must be finite [x,y,z]` };
    }
  }
  const sentAtResult = validateOptionalFiniteNumber(payload, 'sentAt');
  if (!sentAtResult.ok) return sentAtResult;
  return { ok: true };
}

function validateScenePhysicsSyncPayload(payload, maxStringLength) {
  for (const key of [
    'source',
    'phase',
    'profile',
    'hashVersion',
    'rapierCoreVersion',
    'hash',
    'timelineVersion',
    'timelineId',
  ]) {
    const result = validateOptionalReasonableString(payload, key, maxStringLength);
    if (!result.ok) return result;
  }

  for (const key of [
    'tick',
    'localTick',
    'requestTick',
    'bodyCount',
    'timelineRevision',
    'timelineForkTick',
    'timelineClearRevision',
    'lastEventRevision',
  ]) {
    const result = validateOptionalNonNegativeInteger(payload, key);
    if (!result.ok) return result;
  }

  for (const key of [
    'timestep',
    'activeTime',
    'worldAge',
    'worldEpochTime',
    'sceneClockRevision',
    'sentAt',
  ]) {
    const result = validateOptionalFiniteNumber(payload, key);
    if (!result.ok) return result;
  }

  const controllerValidation = validatePhysicsController(payload.controller, maxStringLength);
  if (!controllerValidation.ok) return controllerValidation;

  if (payload.kind === 'scene-physics-hash') {
    if (payload.hash !== undefined && !isReasonableString(payload.hash, maxStringLength)) {
      return { ok: false, reason: 'scene-physics-hash.hash must be a reasonable string' };
    }
    return { ok: true };
  }

  if (payload.kind === 'scene-physics-snapshot-request') {
    for (const key of ['snapshotVersion', 'requestId', 'reason', 'remoteHash', 'localHash']) {
      const result = validateOptionalReasonableString(payload, key, maxStringLength);
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  if (payload.kind === 'scene-physics-snapshot') {
    for (const key of ['snapshotVersion', 'requestId', 'requestReason']) {
      const result = validateOptionalReasonableString(payload, key, maxStringLength);
      if (!result.ok) return result;
    }
    if (payload.bodies !== undefined) {
      if (!Array.isArray(payload.bodies)) {
        return { ok: false, reason: 'scene-physics-snapshot.bodies must be an array' };
      }
      if (payload.bodies.length > 1000) {
        return { ok: false, reason: 'scene-physics-snapshot.bodies is too large' };
      }
      for (const body of payload.bodies) {
        const result = validatePhysicsSnapshotBody(body, maxStringLength);
        if (!result.ok) return result;
      }
    }
    return { ok: true };
  }

  return { ok: true };
}

function validateObjectClock(clock, path = 'clock') {
  if (clock === undefined) return { ok: true };
  if (!clock || typeof clock !== 'object' || Array.isArray(clock)) {
    return { ok: false, reason: `${path} must be an object` };
  }
  for (const key of ['epochTime', 'sharedEpochTime', 'sharedEpoch']) {
    if (clock[key] !== undefined && (typeof clock[key] !== 'number' || !Number.isFinite(clock[key]))) {
      return { ok: false, reason: `${path}.${key} must be a finite number` };
    }
  }
  return { ok: true };
}

// AudioSource component map（audioSources）のバリデーション。
// value が null のキーは「その AudioSource を削除する」patch を意味する。
// 完全な型の正規化は html/assets/js/scenesync/audio/audio-source.js が担当する。
function validateAudioSourcesMap(map, maxStringLength, maxUrlLength = 2048) {
  if (map === null) return { ok: true };
  if (typeof map !== 'object' || Array.isArray(map)) {
    return { ok: false, reason: 'audioSources must be an object map or null' };
  }
  for (const [name, source] of Object.entries(map)) {
    if (!isReasonableString(name, maxStringLength)) {
      return { ok: false, reason: 'audioSources keys must be reasonable strings' };
    }
    if (source === null) continue;
    if (typeof source !== 'object' || Array.isArray(source)) {
      return { ok: false, reason: `audioSources.${name} must be an object or null` };
    }
    if (!isReasonableString(source.url, maxUrlLength)) {
      return { ok: false, reason: `audioSources.${name}.url must be a reasonable string` };
    }
    if (source.volume !== undefined && (typeof source.volume !== 'number' || !Number.isFinite(source.volume))) {
      return { ok: false, reason: `audioSources.${name}.volume must be a finite number` };
    }
    if (source.loop !== undefined && typeof source.loop !== 'boolean') {
      return { ok: false, reason: `audioSources.${name}.loop must be a boolean` };
    }
    if (source.playOnAwake !== undefined && typeof source.playOnAwake !== 'boolean') {
      return { ok: false, reason: `audioSources.${name}.playOnAwake must be a boolean` };
    }
    if (source.offset !== undefined && (typeof source.offset !== 'number' || !Number.isFinite(source.offset))) {
      return { ok: false, reason: `audioSources.${name}.offset must be a finite number` };
    }
    if (source.playbackRate !== undefined && (typeof source.playbackRate !== 'number' || !Number.isFinite(source.playbackRate))) {
      return { ok: false, reason: `audioSources.${name}.playbackRate must be a finite number` };
    }
    if (source.spatial !== undefined && typeof source.spatial !== 'boolean') {
      return { ok: false, reason: `audioSources.${name}.spatial must be a boolean` };
    }
  }
  return { ok: true };
}

export function validateSceneSyncPayload(payload, options = {}) {
  const {
    maxStringLength = 128,
    batchLimit = 100,
    depth = 0,
    maxDepth = 3,
  } = options;

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'payload must be an object' };
  }

  if (!isReasonableString(payload.kind, maxStringLength) || !KNOWN_KINDS.has(payload.kind)) {
    return { ok: false, reason: 'kind must be a known string kind' };
  }

  if (payload.objectId !== undefined && !isReasonableString(payload.objectId, maxStringLength)) {
    return { ok: false, reason: 'objectId must be a reasonable string' };
  }

  if (payload.roomId !== undefined && !isReasonableString(payload.roomId, maxStringLength)) {
    return { ok: false, reason: 'roomId must be a reasonable string' };
  }

  if (payload.position !== undefined && !hasFiniteNumberArray(payload.position, 3)) {
    return { ok: false, reason: 'position must be finite [x,y,z]' };
  }

  if (payload.rotation !== undefined && !hasFiniteNumberArray(payload.rotation, 4)) {
    return { ok: false, reason: 'rotation must be finite quaternion [x,y,z,w]' };
  }

  if (payload.scale !== undefined && !hasFiniteNumberArray(payload.scale, 3)) {
    return { ok: false, reason: 'scale must be finite [x,y,z]' };
  }

  const clockValidation = validateObjectClock(payload.clock, 'clock');
  if (!clockValidation.ok) {
    return clockValidation;
  }

  if (payload.kind === 'scene-env' && !ENV_IDS.has(payload.envId)) {
    return { ok: false, reason: 'envId is invalid' };
  }

  if (payload.kind === 'scene-clock') {
    const allowedModes = new Set(['local-preview', 'shared-playback', 'room-time']);
    const allowedSources = new Set(['local', 'room']);
    if (payload.mode !== undefined && !allowedModes.has(payload.mode)) {
      return { ok: false, reason: 'scene-clock.mode is invalid' };
    }
    if (payload.source !== undefined && !allowedSources.has(payload.source)) {
      return { ok: false, reason: 'scene-clock.source is invalid' };
    }
    for (const key of ['offset', 'pausedTime', 'rate', 'roomNow', 'sentAt', 'revision']) {
      if (payload[key] !== undefined && (typeof payload[key] !== 'number' || !Number.isFinite(payload[key]))) {
        return { ok: false, reason: `scene-clock.${key} must be a finite number` };
      }
    }
    if (payload.paused !== undefined && typeof payload.paused !== 'boolean') {
      return { ok: false, reason: 'scene-clock.paused must be a boolean' };
    }
    if (payload.controller !== undefined && payload.controller !== null) {
      if (typeof payload.controller !== 'object' || Array.isArray(payload.controller)) {
        return { ok: false, reason: 'scene-clock.controller must be an object or null' };
      }
      if (payload.controller.id !== undefined && !isReasonableString(payload.controller.id, maxStringLength)) {
        return { ok: false, reason: 'scene-clock.controller.id must be a reasonable string' };
      }
      if (payload.controller.nickname !== undefined && !isReasonableString(payload.controller.nickname, maxStringLength)) {
        return { ok: false, reason: 'scene-clock.controller.nickname must be a reasonable string' };
      }
    }
    if (payload.objectClocks !== undefined) {
      if (!payload.objectClocks || typeof payload.objectClocks !== 'object' || Array.isArray(payload.objectClocks)) {
        return { ok: false, reason: 'scene-clock.objectClocks must be an object map' };
      }
      for (const [objectId, clock] of Object.entries(payload.objectClocks)) {
        if (!isReasonableString(objectId, maxStringLength)) {
          return { ok: false, reason: 'scene-clock.objectClocks keys must be reasonable strings' };
        }
        const objectClockValidation = validateObjectClock(clock, `scene-clock.objectClocks.${objectId}`);
        if (!objectClockValidation.ok) {
          return objectClockValidation;
        }
      }
    }
  }

  // audioSources は scene-add / scene-delta などでオブジェクトに AudioSource を付与する。
  if (payload.audioSources !== undefined) {
    const audioValidation = validateAudioSourcesMap(payload.audioSources, maxStringLength);
    if (!audioValidation.ok) {
      return audioValidation;
    }
  }

  if (payload.kind === 'scene-bgm') {
    if (payload.bgm === null) {
      // bgm: null is valid (clears BGM)
      return { ok: true };
    }
    if (typeof payload.bgm !== 'object' || !payload.bgm) {
      return { ok: false, reason: 'bgm must be null or an object' };
    }
    if (!isReasonableString(payload.bgm.url)) {
      return { ok: false, reason: 'bgm.url must be a reasonable string' };
    }
  }

  if (payload.kind === 'scene-physics') {
    return validateScenePhysicsPayload(payload.physics);
  }

  if (payload.kind === 'scene-event') {
    return validateSceneEventPayload(payload, maxStringLength);
  }

  if (payload.kind === 'scene-event-log' || payload.kind === 'scene-physics-input-log') {
    return validateSceneEventLogPayload(payload, maxStringLength);
  }

  if (payload.kind === 'scene-event-log-request' || payload.kind === 'scene-physics-input-log-request') {
    return validateSceneEventLogRequestPayload(payload, maxStringLength);
  }

  if (payload.kind === 'scene-physics-input') {
    return validateScenePhysicsInputPayload(payload, maxStringLength);
  }

  if (payload.kind === 'scene-physics-input-log-clear') {
    for (const key of ['timelineVersion', 'timelineId', 'reason']) {
      const result = validateOptionalReasonableString(payload, key, maxStringLength);
      if (!result.ok) return result;
    }
    for (const key of ['timelineRevision', 'timelineForkTick', 'timelineClearRevision', 'lastEventRevision']) {
      const result = validateOptionalNonNegativeInteger(payload, key);
      if (!result.ok) return result;
    }
    const sentAtResult = validateOptionalFiniteNumber(payload, 'sentAt');
    if (!sentAtResult.ok) return sentAtResult;
    return { ok: true };
  }

  if (
    payload.kind === 'scene-physics-hash' ||
    payload.kind === 'scene-physics-snapshot' ||
    payload.kind === 'scene-physics-snapshot-request'
  ) {
    return validateScenePhysicsSyncPayload(payload, maxStringLength);
  }

  if (payload.kind === 'scene-batch') {
    if (depth >= maxDepth) {
      return { ok: false, reason: 'batch nesting depth exceeded' };
    }
    const operations = Array.isArray(payload.ops)
      ? payload.ops
      : (Array.isArray(payload.actions) ? payload.actions : null);
    if (!operations) {
      return { ok: false, reason: 'batch ops/actions must be an array' };
    }
    if (operations.length > batchLimit) {
      return { ok: false, reason: `batch ops must be <= ${batchLimit}` };
    }
    for (const operation of operations) {
      const nestedValidation = validateSceneSyncPayload(operation, {
        maxStringLength,
        batchLimit,
        depth: depth + 1,
        maxDepth,
      });
      if (!nestedValidation.ok) {
        return { ok: false, reason: `invalid batch op: ${nestedValidation.reason}` };
      }
    }
  }

  return { ok: true };
}
