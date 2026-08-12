/**
 * Set schemes.
 *
 * A scheme is a list of set slots expressed as a percentage of the day's top
 * weight. Warmups are prescriptions only — they are displayed so you know what
 * to load, and never recorded, so the history contains nothing but real work.
 */

import { roundToLoadable, DEFAULT_PLATES } from './plates.js';

const RP_WARMUPS = [
  { pct: 0.5, reps: '4-8' },
  { pct: 0.75, reps: '3-5' },
];

export const SCHEMES = {
  'rp-2': {
    id: 'rp-2',
    name: 'Reverse pyramid — 2 working sets',
    warmups: RP_WARMUPS,
    working: [
      { pct: 1.0, repMin: 6, repMax: 10, note: 'Top set — to failure' },
      { pct: 0.75, repMin: 8, repMax: 12, note: 'Backoff −25% — to failure' },
    ],
  },
  'rp-3': {
    id: 'rp-3',
    name: 'Reverse pyramid — 3 working sets',
    warmups: RP_WARMUPS,
    working: [
      { pct: 1.0, repMin: 6, repMax: 10, note: 'Top set — to failure' },
      { pct: 1.0, repMin: 4, repMax: 8, note: 'Same weight — to failure' },
      { pct: 0.75, repMin: 8, repMax: 12, note: 'Backoff −25% — to failure' },
    ],
  },
  'rp-3-drop': {
    id: 'rp-3-drop',
    name: 'Reverse pyramid — 3 sets, dropping weight',
    warmups: RP_WARMUPS,
    working: [
      { pct: 1.0, repMin: 6, repMax: 10, note: 'Top set — to failure' },
      { pct: 0.8, repMin: 8, repMax: 12, note: 'Drop −20% — to failure' },
      { pct: 0.7, repMin: 10, repMax: 15, note: 'Drop −30% — to failure' },
    ],
  },
  'straight-3': {
    id: 'straight-3',
    name: 'Straight sets — 3 at one weight',
    warmups: RP_WARMUPS,
    working: [
      { pct: 1.0, repMin: 8, repMax: 12, note: 'To failure' },
      { pct: 1.0, repMin: 8, repMax: 12, note: 'To failure' },
      { pct: 1.0, repMin: 8, repMax: 12, note: 'To failure' },
    ],
  },
  'flat-5': {
    id: 'flat-5',
    name: 'Five straight sets — same weight, reps fall',
    warmups: [{ pct: 0.5, reps: '8-10' }],
    working: Array.from({ length: 5 }, () => ({
      pct: 1.0,
      repMin: 12,
      repMax: 20,
      note: 'Same weight — reps will fall, that is the point',
    })),
  },
  'high-rep-2': {
    id: 'high-rep-2',
    name: 'High rep — 2 working sets',
    warmups: [{ pct: 0.5, reps: '10' }],
    working: [
      { pct: 1.0, repMin: 15, repMax: 25, note: 'To failure' },
      { pct: 0.75, repMin: 15, repMax: 25, note: 'Backoff −25% — to failure' },
    ],
  },
};

export function getScheme(id) {
  return SCHEMES[id] || SCHEMES['rp-2'];
}

export function workingSetCount(scheme) {
  return scheme?.working?.length ?? 0;
}

export function describeScheme(scheme) {
  if (!scheme) return '';
  const top = scheme.working[0];
  const warm = scheme.warmups.length;
  return `${warm} warmup${warm === 1 ? '' : 's'} → ${scheme.working.length} working, top set ${top.repMin}–${top.repMax} reps`;
}

function equipmentOpts(equipment = {}) {
  return {
    barWeight: equipment.barWeight ?? 0,
    available: equipment.available?.length ? equipment.available : DEFAULT_PLATES,
    loading: equipment.loading ?? 'per-side',
  };
}

/**
 * Turn a top weight into a concrete, loadable prescription for the whole
 * exercise. With no top weight yet the shape is still returned so the UI can
 * render the set list and ask for one.
 */
export function buildPrescription({ scheme, topWeight, equipment = {} }) {
  const s = typeof scheme === 'string' ? getScheme(scheme) : scheme;
  const opts = equipmentOpts(equipment);
  const known = topWeight != null && Number(topWeight) > 0;
  const weightFor = (pct) => (known ? roundToLoadable(Number(topWeight) * pct, opts) : null);

  return {
    schemeId: s.id ?? 'custom',
    schemeName: s.name ?? 'Custom',
    topWeight: known ? Number(topWeight) : null,
    needsTopWeight: !known,
    warmups: (s.warmups ?? []).map((w, i) => ({
      index: i + 1,
      pct: w.pct,
      weight: weightFor(w.pct),
      reps: w.reps,
      logged: false,
    })),
    working: (s.working ?? []).map((w, i) => ({
      setIndex: i + 1,
      pct: w.pct,
      weight: weightFor(w.pct),
      repMin: w.repMin,
      repMax: w.repMax,
      note: w.note ?? '',
      logged: true,
    })),
  };
}
