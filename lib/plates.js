/**
 * Plate math.
 *
 * Everything is computed in half-pound integer units so 2.5 lb plates never
 * drift through floating point. Works for barbells, for plate-loaded machines
 * with no bar at all (leg press), and for machines where the plates you hang
 * are the whole load rather than one side of it.
 */

const UNITS_PER_LB = 2;
const MAX_SIDE_LB = 700;

const toUnits = (lb) => Math.round(lb * UNITS_PER_LB);
const toLb = (u) => u / UNITS_PER_LB;

export const DEFAULT_PLATES = [45, 35, 25, 10, 5, 2.5];

export const BAR_TYPES = [
  { id: 'olympic', name: 'Olympic bar', weight: 45, loading: 'per-side' },
  { id: 'womens', name: "Women's bar", weight: 35, loading: 'per-side' },
  { id: 'ez', name: 'EZ curl bar', weight: 25, loading: 'per-side' },
  { id: 'trap', name: 'Trap bar', weight: 60, loading: 'per-side' },
  { id: 'ssb', name: 'Safety squat bar', weight: 65, loading: 'per-side' },
  { id: 'none', name: 'No bar — plates per side', weight: 0, loading: 'per-side' },
  { id: 'none-total', name: 'No bar — plates are total', weight: 0, loading: 'total' },
  { id: 'stack', name: 'Weight stack / dumbbell', weight: 0, loading: 'total' },
];

export function getBarType(id) {
  return BAR_TYPES.find((b) => b.id === id) || BAR_TYPES[0];
}

/** How many plates hang on one side vs. how many make up the whole load. */
function sideMultiplier(loading) {
  return loading === 'total' ? 1 : 2;
}

/* ------------------------------------------------------------------ *
 * Reachable-load table: an unbounded coin problem over the plate set. *
 * ------------------------------------------------------------------ */

const tableCache = new Map();

function loadTable(available) {
  const units = [...new Set(available.map(toUnits))].filter((u) => u > 0).sort((a, b) => b - a);
  const key = units.join(',');
  const cached = tableCache.get(key);
  if (cached) return cached;

  const maxU = toUnits(MAX_SIDE_LB);
  const count = new Int32Array(maxU + 1).fill(-1);
  const pick = new Int32Array(maxU + 1).fill(-1);
  count[0] = 0;

  for (let u = 1; u <= maxU; u++) {
    for (let i = 0; i < units.length; i++) {
      const p = units[i];
      if (p > u) continue;
      const prev = count[u - p];
      if (prev >= 0 && (count[u] < 0 || prev + 1 < count[u])) {
        count[u] = prev + 1;
        pick[u] = i;
      }
    }
  }

  const table = { units, count, pick, maxU };
  tableCache.set(key, table);
  return table;
}

/**
 * Nearest reachable per-side load, in units. Searching outward and testing the
 * heavier candidate first makes ties round up, so a warmup never lands short.
 */
function nearestReachable(table, targetU) {
  const clamped = Math.max(0, Math.min(targetU, table.maxU));
  for (let d = 0; d <= table.maxU; d++) {
    const up = clamped + d;
    if (up <= table.maxU && table.count[up] >= 0) return up;
    const down = clamped - d;
    if (down >= 0 && table.count[down] >= 0) return down;
  }
  return 0;
}

function decompose(table, targetU) {
  const plates = {};
  let u = targetU;
  while (u > 0 && table.pick[u] >= 0) {
    const i = table.pick[u];
    const p = table.units[i];
    const lb = toLb(p);
    plates[lb] = (plates[lb] || 0) + 1;
    u -= p;
  }
  return plates;
}

/* ---------------------------- public API ---------------------------- */

/** Total weight on the machine given the plates hung and the bar underneath. */
export function totalFromPlates({ barWeight = 0, plates = {}, loading = 'per-side' }) {
  let sideU = 0;
  for (const [lb, n] of Object.entries(plates)) {
    sideU += toUnits(Number(lb)) * Number(n || 0);
  }
  return toLb(toUnits(barWeight) + sideMultiplier(loading) * sideU);
}

/**
 * Break a target total down into the plates to hang, using as few as possible.
 * Returns what it actually achieves, which may not be the target on a sparse
 * plate set (a leg press stocked only with 45s jumps 90 lb at a time).
 */
export function platesForTotal(target, { barWeight = 0, available = DEFAULT_PLATES, loading = 'per-side' } = {}) {
  const table = loadTable(available);
  const mult = sideMultiplier(loading);
  const sideTargetU = (toUnits(target) - toUnits(barWeight)) / mult;

  if (sideTargetU <= 0) {
    return { plates: {}, achieved: toLb(toUnits(barWeight)), exact: toUnits(target) === toUnits(barWeight) };
  }

  const bestU = nearestReachable(table, Math.round(sideTargetU));
  const achieved = toLb(toUnits(barWeight) + mult * bestU);

  return { plates: decompose(table, bestU), achieved, exact: achieved === toLb(toUnits(target)) };
}

/** Snap an arbitrary weight to the nearest load this equipment can actually hold. */
export function roundToLoadable(target, opts = {}) {
  return platesForTotal(target, opts).achieved;
}

export function isLoadable(target, opts = {}) {
  return platesForTotal(target, opts).exact;
}

/** Compact per-side summary for the UI, heaviest plate first. */
export function describePlates(plates = {}) {
  const entries = Object.entries(plates)
    .map(([lb, n]) => [Number(lb), Number(n)])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[0] - a[0]);

  if (!entries.length) return 'bar only';
  return entries.map(([lb, n]) => `${lb}x${n}`).join(', ');
}
