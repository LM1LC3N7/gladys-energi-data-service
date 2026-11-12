// -----------------------------------------------------------------------------
// A real clock sped up (the timers divided by `speed`, `now` and `monotonic`
// in simulated ms), for the tests that measure a real period: the gaps
// between the calls of a spied method must stay within 0.9..1.5 x the period
// (late under load, never early).
// -----------------------------------------------------------------------------

export function realClock({ speed = 1000, start = Date.now() } = {}) {
  const t0 = performance.now();
  const ids = new Set();
  const clock = {
    now: () => start + (performance.now() - t0) * speed,
    monotonic: () => (performance.now() - t0) * speed,
    timers: {
      setTimeout(fn, ms) {
        const id = setTimeout(
          () => {
            ids.delete(id);
            fn();
          },
          Math.max(0, ms) / speed,
        );
        ids.add(id);
        return id;
      },
      clearTimeout(id) {
        ids.delete(id);
        clearTimeout(id);
      },
    },
    get pending() {
      return ids.size;
    },
    close() {
      for (const id of ids) clearTimeout(id);
      ids.clear();
    },
  };
  return clock;
}

/** Records the simulated instant of every call of `obj[method]`. */
export function spyOn(obj, method, clock) {
  const calls = [];
  const original = obj[method].bind(obj);
  obj[method] = (...args) => {
    calls.push(clock.monotonic());
    return original(...args);
  };
  return calls;
}

/** Waits (bounded) for `count` gaps after `skip` calls, then checks each against the period. */
export async function measurePeriod(
  calls,
  { count, period, min = 0.9, max = 1.5, speed, skip = 0 },
) {
  const deadline = Date.now() + ((count + 2 + skip) * period * max) / speed + 5000;
  while (calls.length < count + 1 + skip) {
    if (Date.now() > deadline) throw new Error(`only ${calls.length} calls before the deadline`);
    await new Promise((r) => setTimeout(r, 20));
  }
  const kept = calls.slice(skip);
  const gaps = kept.slice(1, count + 1).map((t, i) => t - kept[i]);
  for (const gap of gaps) {
    if (gap < min * period || gap > max * period) {
      throw new Error(`gaps ${gaps.map((g) => Math.round(g)).join(', ')} ms, period ${period}`);
    }
  }
  return gaps;
}
