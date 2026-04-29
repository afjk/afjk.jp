function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('sessionId is required');
  }
}

export function assertRoomId(roomId) {
  if (typeof roomId !== 'string' || !roomId.trim()) {
    throw new Error('roomId is required');
  }
}

export function assertCode(code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    throw new Error('code must be a 6-digit string');
  }
}

export function assertScenePayload(payload) {
  if (!isPlainObject(payload) || typeof payload.kind !== 'string' || !payload.kind.trim()) {
    throw new Error('payload.kind is required');
  }
}

export function assertAiCommand(action, params = {}) {
  if (typeof action !== 'string' || !action.trim()) {
    throw new Error('action is required');
  }

  if (!isPlainObject(params)) {
    throw new Error('params must be an object');
  }

  if (action === 'focusObject' && typeof params.objectId !== 'string') {
    throw new Error('focusObject requires params.objectId');
  }

  if (action === 'uploadGlbFromUrl' && typeof params.url !== 'string') {
    throw new Error('uploadGlbFromUrl requires params.url');
  }
}

export function assertPrimitiveAsset(payload) {
  if (payload?.kind !== 'scene-add') return;
  const asset = payload.asset;
  if (!asset || asset.type !== 'primitive') return;

  if (typeof asset.primitive !== 'string' || !asset.primitive) {
    throw new Error('primitive scene-add requires payload.asset.primitive');
  }
  if (typeof asset.color !== 'string' || !asset.color) {
    throw new Error('primitive scene-add requires payload.asset.color');
  }
}
