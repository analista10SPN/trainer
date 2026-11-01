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

import { roundToLoadable, DEFAULT_PLATES, getBarType, platesFor } from './plates.js';
import { topSet } from './strength.js';

const DELOAD_FACTOR = 0.93;
const BLOWOUT_MARGIN = 3;

const label = (v) => String(v ?? '').trim().toLowerCase();

/**
 * Which station a session's top set was done on.
 *
 * The gym comes off the session and the machine off the set, because that is
 * where each one lives: a visit is to one building, a set is on one station.
 */
export function stationOf(entry) {
  return {
    gymId: label(entry?.gymId) || null,
    machine: label(topSet(entry?.sets ?? [])?.machine) || null,
  };
}

/**
 * Two sessions on the same station.
 *
 * **An unknown on either side is silence, not a change.** This is the rule that
 * decides whether putting the station into progression is usable at all: almost
 * none of the existing history carries a gym, because the prompt arrived late,
 * and almost none carries a machine for the same reason. Reading unknown as a
 * change would break the streak on every lift in the app and freeze progression
 * everywhere. It is the same budget `machineChanged` and `aidsChanged` already
 * give their own fields.
 */
export function sameStation(a, b) {
  const x = stationOf(a);
  const y = stationOf(b);
  const gymSame = !x.gymId || !y.gymId || x.gymId === y.gymId;
  const machineSame = !x.machine || !y.machine || x.machine === y.machine;
  return gymSame && machineSame;
}

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
 * session inside the range, a session under it, a session at a different load,
 * or **a session on a different station**. The same-weight condition matters —
 * three top-range sessions at three different weights is a lift already
 * climbing, not evidence that this weight is too light.
 *
 * The station condition matters for the same reason and was missing. 180 on the
 * stack at Naco and 180 on the stack at Bella Vista are two different loads that
 * happen to print the same number, so counting them together earned a real
 * increase on evidence about neither machine. Unlike a wrong verdict, which gets
 * read and discounted, a wrong prescribed weight gets loaded.
 */
export function topRangeStreak(history = [], repMax, weight) {
  let streak = 0;
  const latest = history[history.length - 1] ?? null;

  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    const top = topSet(entry?.sets ?? []);
    if (!top) break;
    if (Number(top.weight) !== Number(weight)) break;
    if (Number(top.reps) < repMax) break;
    if (!sameStation(entry, latest)) break;
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
export function smallestStep(equipment = {}, unit = equipment.unit ?? 'lb') {
  /**
   * The bar table and the plate set both depend on the unit.
   *
   * This read the **pound** tables whatever it was asked for, which made the
   * +/- stepper move 5 lb on a kilo screen — 2.27 kg a tap, where a metric
   * stack steps 2.5 and a metric bar steps 2.5 with its smallest pair. Every
   * figure it reached was a load no kg machine can make: the exact failure the
   * two-grid design in `plates.js` exists to prevent, arriving through the one
   * function nobody had told about it.
   *
   * Last argument and defaulted, so the calls that predate it are unchanged.
   */
  const fixed = equipment.increment ?? getBarType(equipment.barType ?? '', unit).increment;
  if (fixed) return fixed;

  const available = equipment.available?.length ? equipment.available : platesFor(unit);
  const mult = (equipment.loading ?? 'per-side') === 'total' ? 1 : 2;
  return mult * Math.min(...available);
}

/**
 * What to load on the top set next time, given how the last one went.
 * Always returns a weight this equipment can actually hold.
 */
export function suggestNextTopWeight({ scheme, history, lastSession, equipment = {}, station = null }) {
  // Callers that only ever had one session keep working; the streak is then
  // simply a streak of one.
  const all = Array.isArray(history) ? history : lastSession ? [lastSession] : [];

  /**
   * Prefer this station's own history, and say when there is none.
   *
   * Walking into a second gym should not silently pre-fill the first gym's
   * weight — that number was earned on a different machine. But refusing to
   * suggest anything is worse than suggesting the wrong gym's weight *with the
   * provenance attached*, because the fallback is what makes a first session
   * anywhere possible at all.
   *
   * A silently carried number is how the dumbbell unit bug survived months, so
   * the fallback is stated in the reason rather than merely allowed.
   */
  const here = station
    ? all.filter((entry) => sameStation(entry, { gymId: station.gymId, sets: [{ machine: station.machine }] }))
    : all;
  const borrowed = Boolean(station) && here.length === 0 && all.length > 0;
  const sessions = borrowed ? all : here;

  /**
   * Every answer below says so when the number came from somewhere else.
   *
   * Decorating the reasons rather than branching inside each of the six
   * returns: the provenance is one fact about the whole suggestion, and six
   * copies of it is how a sentence falls out of step with the number above it.
   */
  const said = (result) => (borrowed
    ? { ...result, borrowed: true, reason: `${result.reason} This is your weight from elsewhere — first time on this one, so treat it as a guess.` }
    : { ...result, borrowed: false });

  const latest = sessions[sessions.length - 1] ?? null;
  const top = topSet(latest?.sets ?? []);
  if (!top) {
    return { weight: null, action: 'no-history', reason: 'First time on this lift — pick a top weight and take it to failure.', borrowed: false };
  }

  const slot = scheme?.working?.[0] ?? { repMin: 6, repMax: 10 };
  const o = opts(equipment);
  const step = smallestStep(equipment);
  const weight = Number(top.weight);
  const reps = Number(top.reps);

  if (reps >= slot.repMax + BLOWOUT_MARGIN) {
    return said({
      weight: roundToLoadable(weight + 2 * step, o),
      action: 'increase',
      reason: `${reps} reps blew past the ${slot.repMin}–${slot.repMax} target — jump two steps.`,
    });
  }

  if (reps >= slot.repMax) {
    const streak = topRangeStreak(sessions, slot.repMax, weight);

    if (streak >= REQUIRED_STREAK) {
      return said({
        weight: roundToLoadable(weight + step, o),
        action: 'increase',
        reason: `${streak} sessions in a row at the top of the ${slot.repMin}–${slot.repMax} range — you own this weight, add a step.`,
      });
    }

    const left = REQUIRED_STREAK - streak;
    return said({
      weight: roundToLoadable(weight, o),
      action: 'hold',
      reason: `${reps} reps hit the top of the ${slot.repMin}–${slot.repMax} range — ${left} more like that and the weight goes up.`,
    });
  }

  if (reps >= slot.repMin) {
    return said({
      weight: roundToLoadable(weight, o),
      action: 'hold',
      reason: `${reps} reps is inside the ${slot.repMin}–${slot.repMax} range — same weight, chase more reps.`,
    });
  }

  // Under the range: back off, and make sure the rounding actually lands lower.
  let target = roundToLoadable(weight * DELOAD_FACTOR, o);
  let guard = 0;
  while (target >= weight && guard < 50) {
    target = roundToLoadable(target - step, o);
    guard++;
  }

  return said({
    weight: Math.max(0, target),
    action: 'deload',
    reason: `Only ${reps} reps against a ${slot.repMin}-rep floor — drop the load and rebuild.`,
  });
}
