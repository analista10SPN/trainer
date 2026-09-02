/**
 * Double progression.
 *
 * Because every top set is taken to failure, the reps you got *are* the
 * feedback signal: reach the top of the range and the load goes up next time,
 * fall out the bottom and it comes down. No RIR, no percentages of a max you
 * never actually tested.
 *
 * "Next time" is the part that took a correction. Hitting the top of the range
 * *once* is a good session, not proof the weight is too light — reps swing on
 * sleep, food and how the day went. Adding load on that single point pushed the
 * weight up before it was owned, and the session after fell out the bottom of
 * the range. So an increase now has to be earned over consecutive sessions at
 * the same load.
 */

import { roundToLoadable, DEFAULT_PLATES, getBarType } from './plates.js';
import { topSet } from './strength.js';

const DELOAD_FACTOR = 0.93;
const BLOWOUT_MARGIN = 3;

/**
 * How many sessions in a row at the top of the range before the load moves.
 *
 * Three, because two can be a good week and one is noise. This is the single
 * number to change if progression starts feeling slow rather than premature.
 */
export const REQUIRED_STREAK = 3;

/**
 * How many recent sessions in a row topped out at this exact weight.
 *
 * Counted backwards from the latest and stopped by anything that breaks it: a
 * session inside the range, a session under it, or a session at a different
 * load. The same-weight condition matters — three top-range sessions at three
 * different weights is a lift already climbing, not evidence that this weight
 * is too light.
 */
export function topRangeStreak(history = [], repMax, weight) {
  let streak = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const top = topSet(history[i]?.sets ?? []);
    if (!top) break;
    if (Number(top.weight) !== Number(weight)) break;
    if (Number(top.reps) < repMax) break;
    streak++;
  }

  return streak;
}

function opts(equipment = {}) {
  return {
    barWeight: equipment.barWeight ?? 0,
    available: equipment.available?.length ? equipment.available : DEFAULT_PLATES,
    loading: equipment.loading ?? 'per-side',
  };
}

/**
 * The lightest jump this equipment can make. Plate-loaded gear is limited by
 * the smallest plate; a stack or a dumbbell rack has its own fixed step, and
 * pretending otherwise prescribes weights that do not exist.
 */
export function smallestStep(equipment = {}) {
  const fixed = equipment.increment ?? getBarType(equipment.barType ?? '').increment;
  if (fixed) return fixed;

  const available = equipment.available?.length ? equipment.available : DEFAULT_PLATES;
  const mult = (equipment.loading ?? 'per-side') === 'total' ? 1 : 2;
  return mult * Math.min(...available);
}

/**
 * What to load on the top set next time, given how the last one went.
 * Always returns a weight this equipment can actually hold.
 */
export function suggestNextTopWeight({ scheme, history, lastSession, equipment = {} }) {
  // Callers that only ever had one session keep working; the streak is then
  // simply a streak of one.
  const sessions = Array.isArray(history) ? history : lastSession ? [lastSession] : [];
  const latest = sessions[sessions.length - 1] ?? null;
  const top = topSet(latest?.sets ?? []);
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
    const streak = topRangeStreak(sessions, slot.repMax, weight);

    if (streak >= REQUIRED_STREAK) {
      return {
        weight: roundToLoadable(weight + step, o),
        action: 'increase',
        reason: `${streak} sessions in a row at the top of the ${slot.repMin}–${slot.repMax} range — you own this weight, add a step.`,
      };
    }

    const left = REQUIRED_STREAK - streak;
    return {
      weight: roundToLoadable(weight, o),
      action: 'hold',
      reason: `${reps} reps hit the top of the ${slot.repMin}–${slot.repMax} range — ${left} more like that and the weight goes up.`,
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
