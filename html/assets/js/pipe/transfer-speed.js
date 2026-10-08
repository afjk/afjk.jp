// Application-payload rates. Send callbacks count queued/uploaded bytes;
// receive callbacks count bytes received. No transport or delivery inference.
export const SPEED_INTERVAL_MS = 250;
export const SPEED_WINDOW_MS = 2000;

export function formatTransferSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return '—';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let value = bytesPerSecond, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value.toFixed(unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function createTransferRate({ now = () => performance.now(), windowMs = SPEED_WINDOW_MS,
  minSampleMs = SPEED_INTERVAL_MS } = {}) {
  let firstTime = 0, firstBytes = 0, latestBytes = 0, points = [];
  const valid = value => Number.isFinite(value) && value >= 0;
  function reset(offset = 0, at = now()) {
    firstTime = Number.isFinite(at) ? at : now();
    firstBytes = latestBytes = valid(offset) ? offset : 0;
    points = [{ at: firstTime, bytes: firstBytes }];
  }
  function update(bytes) {
    if (!valid(bytes)) return;
    // A decreasing counter denotes a different file/attempt, never negative speed.
    if (bytes < latestBytes) reset(bytes);
    latestBytes = bytes;
  }
  function rate(at = now()) {
    if (!Number.isFinite(at) || at < firstTime) { reset(latestBytes); return null; }
    const last = points.at(-1);
    if (last?.at === at) { if (points.length > 1) last.bytes = latestBytes; }
    else points.push({ at, bytes: latestBytes });
    const cutoff = at - windowMs;
    while (points.length > 2 && points[1].at <= cutoff) points.shift();
    // Bound samples even if a caller reads faster than the UI's 250 ms cadence.
    if (points.length > 32) points.splice(1, points.length - 32);
    let base = points[0];
    if (base.at < cutoff && points.length > 1) {
      const next = points[1], ratio = (cutoff - base.at) / (next.at - base.at);
      base = { at: cutoff, bytes: base.bytes + (next.bytes - base.bytes) * ratio };
    }
    const elapsed = at - base.at;
    return elapsed >= minSampleMs ? Math.max(0, latestBytes - base.bytes) * 1000 / elapsed : null;
  }
  function average(at = now()) {
    const bytes = latestBytes - firstBytes, elapsed = at - firstTime;
    if (bytes === 0) return 0;
    return Number.isFinite(elapsed) && elapsed >= minSampleMs ? bytes * 1000 / elapsed : null;
  }
  reset();
  return { reset, update, rate, average };
}

// One owner per UI readout, one token per user attempt, and one rate per file.
// Updates only store counters; the bounded timer does all live DOM rendering.
export function createSpeedReadout(render, { now = () => performance.now(),
  schedule = fn => setInterval(fn, SPEED_INTERVAL_MS), unschedule = clearInterval } = {}) {
  let generation = 0, suppressed = -1, timer = null, state = { visible: false };
  const clear = () => { if (timer !== null) { unschedule(timer); timer = null; } };
  const publish = next => { state = next; render(state); };
  function cancel() { generation++; clear(); publish({ visible: false }); }
  function hide() { suppressed = generation; clear(); publish({ visible: false }); }
  function begin(mode) {
    generation++; clear(); const token = generation;
    const meter = createTransferRate({ now });
    let terminal = false;
    const owned = () => token === generation;
    const current = () => owned() && !terminal && suppressed !== token;
    publish({ visible: true, phase: 'waiting', mode, rate: null });
    return {
      isCurrent: owned,
      startFile(offset = 0, nextMode = mode) {
        if (!current()) return;
        clear(); mode = nextMode; meter.reset(offset);
        publish({ visible: true, phase: 'live', mode, rate: null });
        timer = schedule(() => { if (current()) publish({ visible: true, phase: 'live', mode, rate: meter.rate() }); });
      },
      update(bytes) { if (current()) meter.update(bytes); },
      finish() {
        if (!current() || state.phase === 'complete') return;
        clear(); publish({ visible: true, phase: 'complete', mode, rate: meter.average() });
      },
      unavailable(nextMode = mode) {
        if (!current()) return;
        clear(); mode = nextMode; publish({ visible: true, phase: 'unavailable', mode, rate: null });
        terminal = true; // Terminal handoff: late P2P callbacks must not restart this readout.
      },
      cancel() { if (owned()) cancel(); },
    };
  }
  return { begin, cancel, hide, refresh: () => render(state) };
}
