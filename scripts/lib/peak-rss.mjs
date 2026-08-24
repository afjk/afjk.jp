// Peak resident set size, for benchmarks.
//
// `process.memoryUsage().rss` is an instantaneous reading, so a conversion's
// high-water mark can pass entirely between two samples. Linux keeps the real
// peak in /proc/self/status as VmHWM, and lets it be reset by writing to
// clear_refs — which is exactly what a per-case measurement needs.

import fs from 'node:fs/promises';

const STATUS = '/proc/self/status';
const CLEAR_REFS = '/proc/self/clear_refs';

let baseline = 0;

async function readVmHwm() {
  const status = await fs.readFile(STATUS, 'utf8');
  const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
  return match ? Number(match[1]) * 1024 : null;
}

/**
 * Reset the high-water mark so the next {@link peakRss} covers only what comes
 * after. Falls back to sampling where /proc is unavailable.
 */
export async function resetPeakRss() {
  try {
    await fs.writeFile(CLEAR_REFS, '5');
  } catch {
    // Not Linux, or not permitted: peakRss falls back to a sample.
  }
  baseline = process.memoryUsage().rss;
}

/**
 * Peak RSS since the last {@link resetPeakRss}.
 *
 * `growth` is the number to read: a long-lived process never returns freed
 * pages to the OS, so `peak` carries whatever the caller allocated earlier
 * (building a synthetic capture, say) even after that memory is collected.
 *
 * @returns {Promise<{ peak: number, baseline: number, growth: number }>}
 */
export async function peakRss() {
  let peak = process.memoryUsage().rss;
  try {
    const hwm = await readVmHwm();
    if (hwm !== null) peak = hwm;
  } catch {
    // fall through to the sampled value
  }
  peak = Math.max(peak, baseline);
  return { peak, baseline, growth: peak - baseline };
}
