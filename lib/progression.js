/**
 * Double progression.
 *
 * Because every top set is taken to failure, the reps you got *are* the
 * feedback signal: reach the top of the range and the load goes up next time,
 * fall out the bottom and it comes down. No RIR, no percentages of a max you
 * never actually tested.
 */

import { roundToLoadable, DEFAULT_PLATES } from './plates.js';
import { topSet } from './strength.js';

const DELOAD_FACTOR = 0.93;
const BLOWOUT_MARGIN = 3;

function opts(equipment = {}) {
  return {
    barWeight: equipment.barWeight ?? 0,
    available: equipment.available?.length ? equipment.available : DEFAULT_PLATES,
    loading: equipment.loading ?? 'per-side',
  };
}

/** The lightest total jump this equipment can make. */
export function smallestStep(equipment = {}) {
  const available = equipment.available?.length ? equipment.available : DEFAULT_PLATES;
  const mult = (equipment.loading ?? 'per-side') === 'total' ? 1 : 2;
  return mult * Math.min(...available);
}

/**
 * What to load on the top set next time, given how the last one went.
 * Always returns a weight this equipment can actually hold.
 */
export function suggestNextTopWeight({ scheme, lastSession, equipment = {} }) {
  const top = topSet(lastSession?.sets ?? []);
  if (!top) {
    return { weight: null, action: 'no-history', reason: 'First time on this lift — pick a top weight and take it to failure.' };
  }

  const slot = scheme?.working?.[0] ?? { repMin: 6, repMax: 10 };
  const o = opts(equipment);
  const step = smallestStep(equipment);
  const weight = Number(top.weight);
  const reps = Number(top.reps);

  if (reps >= slot.repMax + BLOWOUT_MARGIN) {
    return {
      weight: roundToLoadable(weight + 2 * step, o),
      action: 'increase',
      reason: `${reps} reps blew past the ${slot.repMin}–${slot.repMax} target — jump two steps.`,
    };
  }

  if (reps >= slot.repMax) {
    return {
      weight: roundToLoadable(weight + step, o),
      action: 'increase',
      reason: `${reps} reps hit the top of the ${slot.repMin}–${slot.repMax} range — add weight.`,
    };
  }

  if (reps >= slot.repMin) {
    return {
      weight: roundToLoadable(weight, o),
      action: 'hold',
      reason: `${reps} reps is inside the ${slot.repMin}–${slot.repMax} range — same weight, chase more reps.`,
    };
  }

  // Under the range: back off, and make sure the rounding actually lands lower.
  let target = roundToLoadable(weight * DELOAD_FACTOR, o);
  let guard = 0;
  while (target >= weight && guard < 50) {
    target = roundToLoadable(target - step, o);
    guard++;
  }

  return {
    weight: Math.max(0, target),
    action: 'deload',
    reason: `Only ${reps} reps against a ${slot.repMin}-rep floor — drop the load and rebuild.`,
  };
}
