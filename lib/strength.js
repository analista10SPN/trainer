/**
 * Strength math.
 *
 * Every working set is taken to failure, which is what makes estimated 1RM a
 * fair comparison across sessions: each data point is a genuine maximum effort
 * at that load, not a submaximal set with unknown reps left in reserve.
 */

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * A number, or nothing.
 *
 * Number(null), Number('') and Number([]) are all 0, so a missing reading
 * coerces into a measured zero. This has caused three separate bugs here: a
 * night of no sleep, a skewed average, and a point plotted at the axis. Use
 * this anywhere a value arrives from outside.
 */
export function numeric(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Epley. Reps of 1 are the load itself; a failed set is worth nothing. */
export function epley1RM(weight, reps) {
  const w = Number(weight) || 0;
  const r = Number(reps) || 0;
  if (w <= 0 || r < 1) return 0;
  if (r === 1) return round1(w);
  return round1(w * (1 + r / 30));
}

/**
 * The same estimate, unrounded.
 *
 * Rounding to a tenth is right for display and wrong for arithmetic that
 * divides one estimate by another: on a 20 lb lateral raise that tenth is a
 * 0.3% error, which is large next to a trend measured in percent per session.
 */
export function preciseE1RM(weight, reps) {
  const w = Number(weight) || 0;
  const r = Number(reps) || 0;
  if (w <= 0 || r < 1) return 0;
  return r === 1 ? w : w * (1 + r / 30);
}

export function bestPreciseE1RM(sets = []) {
  return sets.reduce((best, s) => Math.max(best, preciseE1RM(s?.weight, s?.reps)), 0);
}

export function setE1RM(set) {
  return epley1RM(set?.weight, set?.reps);
}

/** Epley drifts optimistic past about a dozen reps; flag it rather than hide it. */
export function isE1RMReliable(reps) {
  return Number(reps) > 0 && Number(reps) <= 12;
}

export function bestE1RM(sets = []) {
  return sets.reduce((best, s) => Math.max(best, setE1RM(s)), 0);
}

/**
 * The top set: the lowest-numbered set that actually happened. In a reverse
 * pyramid that is the heaviest one, and it is what progression keys off.
 */
export function topSet(sets = []) {
  const real = sets.filter((s) => Number(s.weight) > 0 && Number(s.reps) > 0);
  if (!real.length) return null;
  return real.reduce((best, s) => (Number(s.setIndex) < Number(best.setIndex) ? s : best));
}

export function totalVolume(sets = []) {
  return sets.reduce((sum, s) => sum + (Number(s.weight) || 0) * (Number(s.reps) || 0), 0);
}

/** Least-squares slope of a series against its index. */
export function linearSlope(values = []) {
  const n = values.length;
  if (n < 2) return 0;

  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (values[i] - meanY);
    den += (i - meanX) ** 2;
  }
  if (den === 0) return 0;

  return Math.round((num / den) * 1e4) / 1e4;
}

/** The same trend expressed as percent-per-session, which is comparable across lifts. */
export function percentSlope(values = []) {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (mean === 0) return 0;
  return round1((linearSlope(values) / mean) * 100);
}
