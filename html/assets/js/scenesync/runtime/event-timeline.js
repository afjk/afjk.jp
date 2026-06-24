export const SCENE_SYNC_EVENT_TIMELINE_VERSION = 1;
export const DEFAULT_SCENE_EVENT_TIMELINE_ID = 'default';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeString(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeOptionalString(value) {
  const normalized = normalizeString(value, '');
  return normalized || null;
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.floor(number));
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function compareStrings(left, right) {
  return String(left || '').localeCompare(String(right || ''));
}

const CANONICAL_EVENT_FIELDS = new Set([
  'kind',
  'timelineVersion',
  'timelineId',
  'timelineRevision',
  'timelineClearRevision',
  'branchTick',
  'eventId',
  'inputId',
  'eventRevision',
  'interactionId',
  'sequence',
  'applyTick',
  'channel',
  'type',
  'target',
  'source',
  'timestamp',
  'time',
  'payload',
  'sourcePeerId',
  'sourceUserId',
  'phase',
  'sentAt',
]);

export function normalizeSceneEventTimelineId(value) {
  return normalizeString(value, DEFAULT_SCENE_EVENT_TIMELINE_ID);
}

export function compareSceneEvents(left, right) {
  return nonNegativeInteger(left?.applyTick) - nonNegativeInteger(right?.applyTick)
    || nonNegativeInteger(left?.timelineRevision) - nonNegativeInteger(right?.timelineRevision)
    || nonNegativeInteger(left?.eventRevision) - nonNegativeInteger(right?.eventRevision)
    || compareStrings(left?.interactionId, right?.interactionId)
    || nonNegativeInteger(left?.sequence) - nonNegativeInteger(right?.sequence)
    || compareStrings(left?.channel, right?.channel)
    || compareStrings(left?.eventId, right?.eventId);
}

export function normalizeSceneEventEnvelope(payload = {}, defaults = {}) {
  if (!isObject(payload)) return null;

  const channel = normalizeString(payload.channel ?? payload.type, '');
  if (!channel) return null;

  const target = normalizeOptionalString(payload.target ?? payload.objectId);
  const applyTick = nonNegativeInteger(payload.applyTick, nonNegativeInteger(defaults.applyTick, 0));
  const sequence = nonNegativeInteger(payload.sequence, nonNegativeInteger(defaults.sequence, 0));
  const eventRevision = nonNegativeInteger(
    payload.eventRevision,
    nonNegativeInteger(defaults.eventRevision, 0),
  );
  const interactionId = normalizeOptionalString(payload.interactionId ?? defaults.interactionId);
  const eventId = normalizeString(
    payload.eventId ?? payload.inputId,
    interactionId
      ? `${interactionId}:${String(sequence).padStart(6, '0')}`
      : `${channel}:${target || 'scene'}:${applyTick}:${eventRevision}:${sequence}`,
  );
  if (!eventId) return null;

  const timestamp = Number.isFinite(Number(payload.timestamp))
    ? Number(payload.timestamp)
    : finiteNumber(payload.time, finiteNumber(defaults.timestamp, 0));

  const envelope = {
    kind: normalizeString(payload.kind, 'scene-event'),
    timelineVersion: nonNegativeInteger(
      payload.timelineVersion,
      nonNegativeInteger(defaults.timelineVersion, SCENE_SYNC_EVENT_TIMELINE_VERSION),
    ),
    timelineId: normalizeSceneEventTimelineId(payload.timelineId ?? defaults.timelineId),
    timelineRevision: nonNegativeInteger(payload.timelineRevision, defaults.timelineRevision ?? 0),
    timelineClearRevision: nonNegativeInteger(
      payload.timelineClearRevision,
      defaults.timelineClearRevision ?? 0,
    ),
    eventId,
    eventRevision,
    interactionId,
    sequence,
    applyTick,
    channel,
    source: normalizeString(payload.source, normalizeString(defaults.source, 'interaction')),
    timestamp,
    payload: cloneJson(payload.payload || {}),
  };

  if (target) envelope.target = target;
  for (const key of ['sourcePeerId', 'sourceUserId', 'phase']) {
    const value = normalizeOptionalString(payload[key] ?? defaults[key]);
    if (value) envelope[key] = value;
  }
  if (payload.sentAt !== undefined) envelope.sentAt = payload.sentAt;
  for (const [key, value] of Object.entries(payload)) {
    if (CANONICAL_EVENT_FIELDS.has(key) || value === undefined) continue;
    envelope[key] = cloneJson(value);
  }
  return envelope;
}

export function sceneEventToRuntimeEvent(event) {
  const normalized = normalizeSceneEventEnvelope(event);
  if (!normalized) return null;
  const runtimeEvent = {
    ...cloneJson(normalized),
    type: normalized.channel,
    channel: normalized.channel,
    timestamp: normalized.timestamp,
    time: normalized.timestamp,
    ...(normalized.target ? { target: normalized.target } : {}),
  };
  delete runtimeEvent.kind;
  delete runtimeEvent.timelineVersion;
  if (normalized.target && runtimeEvent.objectId === undefined) {
    runtimeEvent.objectId = normalized.target;
  }
  return runtimeEvent;
}

export function createSceneEventTimeline(options = {}) {
  const maxHistory = nonNegativeInteger(options.maxHistory, 1000);
  const maxPending = nonNegativeInteger(options.maxPending, 1000);
  let timelineId = normalizeSceneEventTimelineId(options.timelineId);
  let timelineRevision = nonNegativeInteger(options.timelineRevision, 0);
  let timelineForkTick = nonNegativeInteger(options.timelineForkTick, 0);
  let timelineClearRevision = nonNegativeInteger(options.timelineClearRevision, 0);
  let lastEventRevision = nonNegativeInteger(options.lastEventRevision, 0);
  let pendingEvents = [];
  let eventHistory = [];
  const appliedEventIds = new Set();

  function defaults() {
    return {
      timelineVersion: SCENE_SYNC_EVENT_TIMELINE_VERSION,
      timelineId,
      timelineRevision,
      timelineClearRevision,
      eventRevision: lastEventRevision,
    };
  }

  function getTimelineState() {
    return {
      timelineVersion: SCENE_SYNC_EVENT_TIMELINE_VERSION,
      timelineId,
      timelineRevision,
      timelineForkTick,
      timelineClearRevision,
      lastEventRevision,
    };
  }

  function replaceById(list, event) {
    const index = list.findIndex(item => item.eventId === event.eventId);
    if (index < 0) return false;
    list[index] = event;
    list.sort(compareSceneEvents);
    return true;
  }

  function addHistory(event) {
    replaceById(eventHistory, event) || eventHistory.push(event);
    eventHistory.sort(compareSceneEvents);
    while (eventHistory.length > maxHistory) {
      const dropped = eventHistory.shift();
      if (dropped?.eventId) appliedEventIds.delete(dropped.eventId);
    }
  }

  function addPending(event) {
    replaceById(pendingEvents, event) || pendingEvents.push(event);
    pendingEvents.sort(compareSceneEvents);
    while (pendingEvents.length > maxPending) {
      pendingEvents.shift();
    }
  }

  function resetAppliedFromHistory() {
    appliedEventIds.clear();
    pendingEvents = [];
    for (const event of eventHistory) {
      addPending(event);
    }
  }

  function advanceTimelineRevision(nextRevision, branchTick) {
    if (!Number.isInteger(nextRevision) || nextRevision <= timelineRevision) {
      return false;
    }
    const forkTick = nonNegativeInteger(branchTick, 0);
    const dropsAppliedEvent = eventHistory.some(event => (
      event.timelineRevision !== nextRevision &&
      event.applyTick > forkTick &&
      appliedEventIds.has(event.eventId)
    ));
    timelineRevision = nextRevision;
    timelineForkTick = forkTick;

    const keepEvent = event => event.timelineRevision === timelineRevision || event.applyTick <= timelineForkTick;
    eventHistory = eventHistory.filter(keepEvent);
    pendingEvents = pendingEvents.filter(keepEvent);
    appliedEventIds.clear();
    lastEventRevision = eventHistory.reduce(
      (max, event) => Math.max(max, event.eventRevision || 0),
      0,
    );
    return dropsAppliedEvent;
  }

  function queueEvent(payload = {}, optionsForQueue = {}) {
    const event = normalizeSceneEventEnvelope(payload, defaults());
    if (!event) return { ok: false, reason: 'invalid-event' };
    if (event.timelineId !== timelineId) return { ok: false, reason: 'timeline-mismatch' };
    if (
      event.timelineClearRevision !== timelineClearRevision ||
      (event.timelineRevision < timelineRevision && event.applyTick > timelineForkTick)
    ) {
      return { ok: false, reason: 'stale-event' };
    }

    const existingEvent = eventHistory.find(item => item.eventId === event.eventId)
      || pendingEvents.find(item => item.eventId === event.eventId)
      || null;
    const changed = !existingEvent || JSON.stringify(existingEvent) !== JSON.stringify(event);
    let replayRequired = false;
    if (event.timelineRevision > timelineRevision) {
      replayRequired = advanceTimelineRevision(event.timelineRevision, payload.branchTick ?? event.applyTick);
    }

    const alreadyApplied = appliedEventIds.has(event.eventId);
    const currentTick = Number.isFinite(optionsForQueue.currentTick)
      ? nonNegativeInteger(optionsForQueue.currentTick, 0)
      : null;
    if (alreadyApplied && !changed) {
      lastEventRevision = Math.max(lastEventRevision, event.eventRevision || 0);
      return { ok: true, event, replayRequired: false, unchanged: true };
    }
    addHistory(event);
    lastEventRevision = Math.max(lastEventRevision, event.eventRevision || 0);

    const replayRelevantChange = typeof optionsForQueue.isReplayRelevantChange === 'function'
      ? optionsForQueue.isReplayRelevantChange(existingEvent, event, {
        alreadyApplied,
        changed,
        currentTick,
      }) === true
      : changed;
    if (
      changed &&
      replayRelevantChange &&
      (alreadyApplied || (currentTick !== null && event.applyTick < currentTick))
    ) {
      replayRequired = true;
    }
    if (alreadyApplied && !replayRequired && !replayRelevantChange) {
      return { ok: true, event, replayRequired: false, replayRelevantChange };
    }
    addPending(event);
    return { ok: true, event, replayRequired, replayRelevantChange };
  }

  function consumeDueEvents(currentTick = 0) {
    const tick = nonNegativeInteger(currentTick, 0);
    const due = [];
    for (let index = 0; index < pendingEvents.length;) {
      const event = pendingEvents[index];
      if (event.applyTick > tick) break;
      due.push(event);
      appliedEventIds.add(event.eventId);
      pendingEvents.splice(index, 1);
    }
    return due;
  }

  function processDueEvents(currentTick = 0, handler = () => true) {
    const tick = nonNegativeInteger(currentTick, 0);
    let applied = false;
    let replayRequired = false;
    for (let index = 0; index < pendingEvents.length;) {
      const event = pendingEvents[index];
      if (event.applyTick > tick) break;
      const decision = handler(event);
      if (decision?.replayRequired === true) {
        replayRequired = true;
        break;
      }
      const shouldApply = decision === true || decision?.applied === true;
      if (shouldApply) {
        appliedEventIds.add(event.eventId);
        pendingEvents.splice(index, 1);
        applied = true;
        continue;
      }
      index += 1;
    }
    return { applied, replayRequired };
  }

  function removeEvents(predicate = () => false, optionsForRemove = {}) {
    const removedById = new Map();
    const shouldRemove = (event) => {
      const remove = predicate(event) === true;
      if (remove) {
        if (!removedById.has(event.eventId)) {
          removedById.set(event.eventId, event);
        }
        if (optionsForRemove.markApplied === true) {
          appliedEventIds.add(event.eventId);
        } else {
          appliedEventIds.delete(event.eventId);
        }
      }
      return remove;
    };
    eventHistory = eventHistory.filter(event => !shouldRemove(event));
    pendingEvents = pendingEvents.filter(event => !shouldRemove(event));
    return Array.from(removedById.values()).map(cloneJson);
  }

  function setTimelineState(nextState = {}, optionsForState = {}) {
    const nextTimelineId = normalizeSceneEventTimelineId(nextState.timelineId ?? timelineId);
    timelineId = nextTimelineId;
    timelineRevision = nonNegativeInteger(nextState.timelineRevision, timelineRevision);
    timelineForkTick = nonNegativeInteger(nextState.timelineForkTick, timelineForkTick);
    timelineClearRevision = nonNegativeInteger(nextState.timelineClearRevision, timelineClearRevision);
    lastEventRevision = nonNegativeInteger(nextState.lastEventRevision, lastEventRevision);
    if (optionsForState.resetApplied !== false) {
      appliedEventIds.clear();
    }
    if (optionsForState.requeueHistory === true) {
      pendingEvents = [];
      for (const event of eventHistory) addPending(event);
    }
  }

  function reset(nextState = {}) {
    timelineId = normalizeSceneEventTimelineId(nextState.timelineId);
    timelineRevision = nonNegativeInteger(nextState.timelineRevision, 0);
    timelineForkTick = nonNegativeInteger(nextState.timelineForkTick, 0);
    timelineClearRevision = nonNegativeInteger(nextState.timelineClearRevision, 0);
    lastEventRevision = nonNegativeInteger(nextState.lastEventRevision, 0);
    pendingEvents = [];
    eventHistory = [];
    appliedEventIds.clear();
  }

    function clearEventHistory(payload = {}, optionsForClear = {}) {
      const payloadTimelineId = normalizeSceneEventTimelineId(payload.timelineId);
      if (payloadTimelineId !== timelineId) return false;

      const hasCanonicalRevision = payload.timelineRevision !== undefined && payload.timelineRevision !== null;
      const canonicalRevision = hasCanonicalRevision
        ? nonNegativeInteger(payload.timelineRevision, timelineRevision)
        : null;
      const nextClearRevision = nonNegativeInteger(
        payload.timelineClearRevision,
        canonicalRevision ?? timelineClearRevision + 1,
      );
      if (nextClearRevision <= timelineClearRevision) return false;
      if (
        hasCanonicalRevision &&
        optionsForClear.allowRevisionRegression !== true &&
        canonicalRevision < timelineRevision
      ) {
        return false;
      }

      timelineRevision = hasCanonicalRevision
        ? canonicalRevision
        : timelineRevision + 1;
    timelineForkTick = nonNegativeInteger(payload.timelineForkTick, 0);
    timelineClearRevision = nextClearRevision;
    lastEventRevision = 0;
    pendingEvents = [];
    eventHistory = [];
    appliedEventIds.clear();
    return true;
  }

  function getPendingEvents() {
    return pendingEvents.map(cloneJson);
  }

  function getEventHistory() {
    return eventHistory.map(cloneJson);
  }

  return {
    queueEvent,
    consumeDueEvents,
    processDueEvents,
    removeEvents,
    clearEventHistory,
    resetAppliedFromHistory,
    setTimelineState,
    reset,
    getTimelineState,
    getPendingEvents,
    getEventHistory,
  };
}
