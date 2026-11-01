/**
 * Plate math, in two grids.
 *
 * Pounds are computed in half-pound integer units so 2.5 lb plates never drift
 * through floating point. Works for barbells, for plate-loaded machines with no
 * bar at all (leg press), and for machines where the plates you hang are the
 * whole load rather than one side of it.
 *
 * ## Why kilograms need a second grid rather than a conversion
 *
 * Standard kg plates are 25/20/15/10/5/2.5/1.25 and **not one of them is a whole
 * number of half pounds**. 20 kg is 44.0925 lb, which the pound grid's
 * `Math.round(lb * 2)` turns into 44 lb before the reachable-load table is even
 * built -- so four of them plus a 20 kg bar reads 220 lb, which is 99.79 kg
 * rather than 100.
 *
 * That error is not a display artefact. `roundToLoadable` would return a
 * *target* that is not a real load, and that target is what gets prescribed and
 * then loaded onto a bar next session. Snapping a kilogram figure on a pound
 * grid prescribes weights that do not exist.
 *
 * So each unit gets its own integer grid -- halves for pounds, quarters for
 * kilos, in which all seven kg plates are exact -- and its own plate set and bar
 * list. `unit` on the options picks one; it defaults to pounds, so every
 * existing caller and every logged row is untouched.
 *
 * Everything here works **in the unit it is given**. The conversion to and from
 * the canonical stored pounds happens once, in `units.js`, at the display
 * boundary -- not in here.
 */

const GRIDS = {
  // Halves of a pound. 700 lb a side is more than any plate tree holds.
  lb: { per: 2, maxSide: 700 },
  // Quarters of a kilo: 1.25 kg, the lightest standard plate, is 5 of them.
  // 320 kg a side is the same kind of ceiling.
  kg: { per: 4, maxSide: 320 },
};

const gridFor = (unit) => GRIDS[unit] ?? GRIDS.lb;

export const DEFAULT_PLATES = [45, 35, 25, 10, 5, 2.5];
export const DEFAULT_PLATES_KG = [25, 20, 15, 10, 5, 2.5, 1.25];

export const BAR_TYPES = [
  { id: 'olympic', name: 'Olympic bar', weight: 45, loading: 'per-side' },
  { id: 'womens', name: "Women's bar", weight: 35, loading: 'per-side' },
  { id: 'ez', name: 'EZ curl bar', weight: 25, loading: 'per-side' },
  { id: 'trap', name: 'Trap bar', weight: 60, loading: 'per-side' },
  { id: 'ssb', name: 'Safety squat bar', weight: 65, loading: 'per-side' },
  { id: 'none', name: 'No bar — plates per side', weight: 0, loading: 'per-side' },
  { id: 'none-total', name: 'No bar — plates are total', weight: 0, loading: 'total' },
  // A pin-loaded stack or a dumbbell rack has no plates to count, and it jumps
  // in fixed steps rather than whatever the plate set allows.
  { id: 'stack', name: 'Weight stack / dumbbell', weight: 0, loading: 'total', increment: 5 },
];

/**
 * The same bars as they are actually stamped in a metric gym.
 *
 * Not conversions of the pound figures -- a 20 kg Olympic bar is 20 kg, not
 * 44.0925. And the stack increments by **2.5 kg, not 5**: `smallestStep` reads
 * `increment` before it looks at the plate set, so a 5 here would make every
 * progression step on a cable machine an 11 lb jump.
 */
export const BAR_TYPES_KG = [
  { id: 'olympic', name: 'Olympic bar', weight: 20, loading: 'per-side' },
  { id: 'womens', name: "Women's bar", weight: 15, loading: 'per-side' },
  { id: 'ez', name: 'EZ curl bar', weight: 10, loading: 'per-side' },
  { id: 'trap', name: 'Trap bar', weight: 25, loading: 'per-side' },
  { id: 'ssb', name: 'Safety squat bar', weight: 30, loading: 'per-side' },
  { id: 'none', name: 'No bar -- plates per side', weight: 0, loading: 'per-side' },
  { id: 'none-total', name: 'No bar -- plates are total', weight: 0, loading: 'total' },
  { id: 'stack', name: 'Weight stack / dumbbell', weight: 0, loading: 'total', increment: 2.5 },
];

export const barTypesFor = (unit) => (unit === 'kg' ? BAR_TYPES_KG : BAR_TYPES);
export const platesFor = (unit) => (unit === 'kg' ? DEFAULT_PLATES_KG : DEFAULT_PLATES);

export function getBarType(id, unit = 'lb') {
  const list = barTypesFor(unit);
  return list.find((b) => b.id === id) || list[0];
}

/** How many plates hang on one side vs. how many make up the whole load. */
function sideMultiplier(loading) {
  return loading === 'total' ? 1 : 2;
}

/* ------------------------------------------------------------------ *
 * Reachable-load table: an unbounded coin problem over the plate set. *
 * ------------------------------------------------------------------ */

const tableCache = new Map();

function loadTable(available, unit = 'lb') {
  const grid = gridFor(unit);
  const toUnits = (w) => Math.round(w * grid.per);

  const units = [...new Set(available.map(toUnits))].filter((u) => u > 0).sort((a, b) => b - a);
  // The unit is part of the key. 2.5 appears in both plate sets, so a key over
  // denominations alone would hand a kilogram query the pound table.
  const key = `${unit}:${units.join(',')}`;
  const cached = tableCache.get(key);
  if (cached) return cached;

  const maxU = toUnits(grid.maxSide);
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

  const table = { units, count, pick, maxU, per: grid.per };
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
    const face = p / table.per;
    plates[face] = (plates[face] || 0) + 1;
    u -= p;
  }
  return plates;
}

/* ---------------------------- public API ---------------------------- */

/** Total weight on the machine given the plates hung and the bar underneath. */
export function totalFromPlates({ barWeight = 0, plates = {}, loading = 'per-side', unit = 'lb' }) {
  const per = gridFor(unit).per;
  const toUnits = (w) => Math.round(w * per);

  let sideU = 0;
  for (const [face, n] of Object.entries(plates)) {
    sideU += toUnits(Number(face)) * Number(n || 0);
  }
  return (toUnits(barWeight) + sideMultiplier(loading) * sideU) / per;
}

/**
 * Break a target total down into the plates to hang, using as few as possible.
 * Returns what it actually achieves, which may not be the target on a sparse
 * plate set (a leg press stocked only with 45s jumps 90 lb at a time).
 */
export function platesForTotal(target, { barWeight = 0, available = null, loading = 'per-side', unit = 'lb' } = {}) {
  const per = gridFor(unit).per;
  const toUnits = (w) => Math.round(w * per);
  const set = available?.length ? available : platesFor(unit);

  const table = loadTable(set, unit);
  const mult = sideMultiplier(loading);
  const sideTargetU = (toUnits(target) - toUnits(barWeight)) / mult;

  if (sideTargetU <= 0) {
    return { plates: {}, achieved: toUnits(barWeight) / per, exact: toUnits(target) === toUnits(barWeight) };
  }

  const bestU = nearestReachable(table, Math.round(sideTargetU));
  const achieved = (toUnits(barWeight) + mult * bestU) / per;

  return { plates: decompose(table, bestU), achieved, exact: achieved === toUnits(target) / per };
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
