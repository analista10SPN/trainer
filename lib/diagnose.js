/**
 * Two questions the trend line cannot answer on its own.
 *
 *   "At what point should I drop the weight and chase reps instead?"
 *   "Am I ego lifting on any of these?"
 *
 * They turn out to be one measurement seen from two sides: whether the load on
 * the bar is being paid for with strength, or with reps, range and tempo.
 *
 * `percentPerSession` cannot tell them apart, because it is a single number. A
 * lift adding 20 lb a month while its estimated 1RM stands still reads exactly
 * like a lift that is simply flat — and the advice for those two is opposite.
 * So this compares *two* slopes: how fast the weight is climbing, and how much
 * of that climb the strength estimate actually captured.
 *
 * Still no diagnosis of form. This measures what was lifted, and says when the
 * numbers stop supporting the story the weight is telling.
 */

import { bestPreciseE1RM, percentSlope, topSet, numeric } from './strength.js';
import { roundToLoadable, DEFAULT_PLATES } from './plates.js';
import { tempoDrift } from './tempo.js';

export const MIN_SESSIONS = 3;

/** Only the last few sessions matter; a lift changes character over months. */
const WINDOW = 6;

/** Below this the weight is not really climbing and none of this applies. */
const CLIMBING = 1.5;

/**
 * How much of the added load the strength estimate kept.
 *
 * Under 50% means over half the extra weight came out of the reps rather than
 * out of getting stronger. That is the definition being used here, and it is
 * deliberately generous — the honest ambiguity is that adding weight *always*
 * costs some reps, and the question is only ever how many.
 */
const CAPTURE = 0.5;

/** Four sessions on the same load with nothing to show is a stall. */
const STUCK = 4;

const sessionsWith = (history, exerciseId) =>
  (history ?? [])
    .filter((s) => {
      const sets = s?.sets ?? [];
      return sets.length && (!exerciseId || sets.some((x) => x.exerciseId === exerciseId));
    })
    .sort((a, b) => String(a?.date ?? '').localeCompare(String(b?.date ?? '')));

/* ------------------------------- ego lifting ------------------------------ */

/**
 * Is the weight climbing faster than the strength behind it?
 *
 * The core test is two slopes over the same sessions. Everything else here only
 * corroborates: reps dropping under the prescribed floor, and the eccentric
 * getting shorter, are both things that happen when a weight is being moved
 * rather than lifted. Neither can flag on its own, because each has innocent
 * explanations — a deliberate low-rep block, a lift that never had a tempo.
 */
export function egoCheck({ history, scheme, exerciseId = null } = {}) {
  const none = { flagged: false, weightTrend: 0, strengthTrend: 0, captured: 1, reasons: [], message: '' };

  try {
    const sessions = sessionsWith(history, exerciseId).slice(-WINDOW);
    if (sessions.length < MIN_SESSIONS) {
      return { ...none, message: `Needs ${MIN_SESSIONS} sessions before this can mean anything.` };
    }

    const tops = sessions.map((s) => topSet(s.sets ?? [])).filter(Boolean);
    if (tops.length < MIN_SESSIONS) return { ...none, message: `Needs ${MIN_SESSIONS} logged top sets.` };

    const weights = tops.map((t) => numeric(t.weight)).filter((w) => w !== null);
    const strengths = sessions.map((s) => bestPreciseE1RM(s.sets ?? [])).filter((v) => v > 0);
    if (weights.length < MIN_SESSIONS || strengths.length < MIN_SESSIONS) {
      return { ...none, message: `Needs ${MIN_SESSIONS} sessions before this can mean anything.` };
    }

    const weightTrend = percentSlope(weights);
    const strengthTrend = percentSlope(strengths);

    // Not getting heavier: this may be a stall, but it is not this.
    if (weightTrend < CLIMBING) {
      return { ...none, weightTrend, strengthTrend, message: 'The load is not climbing, so this does not apply.' };
    }

    const captured = weightTrend === 0 ? 1 : strengthTrend / weightTrend;

    // Reps must still be bleeding. A deliberate low-rep block looks identical
    // on the two slopes — heavier every session, strength barely moving — but
    // its reps settle at the new level (5, 5, 5) instead of continuing to fall
    // (7, 5, 3). Without this the app calls a planned block ego lifting, which
    // is the kind of wrong that gets a warning ignored for good.
    const recentReps = tops.slice(-3).map((t) => numeric(t.reps)).filter((r) => r !== null);
    const repTrend = percentSlope(recentReps);
    const stillFalling = recentReps.length >= 2 && repTrend < -1;

    const flagged = captured < CAPTURE && stillFalling;

    const reasons = [];
    const floor = scheme?.working?.[0]?.repMin ?? 6;
    const under = tops.filter((t) => (numeric(t.reps) ?? 99) < floor).length;
    if (under >= 2) reasons.push(`${under} of the last ${tops.length} top sets came in below the ${floor}-rep floor.`);

    const drift = exerciseId ? tempoDrift(sessions, exerciseId) : { drifting: false };
    if (drift.drifting) reasons.push(`The negative has shortened from ${drift.from}s to ${drift.to}s over the same stretch.`);

    return {
      flagged,
      weightTrend,
      strengthTrend,
      captured: Math.round(captured * 100) / 100,
      reasons,
      message: flagged
        ? `The bar is getting heavier about ${weightTrend}% a session while your estimated strength moves ${strengthTrend}% — most of the added load is coming out of your reps, not out of getting stronger.`
        : `Weight up ${weightTrend}% a session and strength up ${strengthTrend}% — the load is being earned.`,
    };
  } catch {
    return none;
  }
}

/* ------------------- lighter and more reps, or something else ------------- */

/**
 * What to change, if anything.
 *
 * The order matters and is the whole point. A stalled lift has three very
 * different causes and only one of them is fixed by dropping the weight:
 *
 *   1. The load is not real      -> lighter, and earn it back
 *   2. Reps sit on the floor     -> lighter, the range is above you at this load
 *   3. Mid-range and going nowhere -> the load is fine, the stimulus is stale
 *
 * Getting that order wrong is expensive in both directions: deloading a lift
 * that is simply bored wastes weeks, and changing the movement on a lift that
 * is being ego-lifted just moves the problem to a new exercise.
 */
export function loadAdvice({ history, scheme, exerciseId = null, equipment = {} } = {}) {
  const wait = { action: 'wait', reason: `Needs ${MIN_SESSIONS} sessions before there is anything to say.`, suggestedWeight: null };

  try {
    const sessions = sessionsWith(history, exerciseId).slice(-WINDOW);
    if (sessions.length < MIN_SESSIONS) return wait;

    const tops = sessions.map((s) => topSet(s.sets ?? [])).filter(Boolean);
    if (tops.length < MIN_SESSIONS) return wait;

    const slot = scheme?.working?.[0] ?? { repMin: 6, repMax: 10 };
    const latestWeight = numeric(tops[tops.length - 1].weight) ?? 0;

    const lighter = (factor) =>
      roundToLoadable(latestWeight * factor, {
        barWeight: equipment.barWeight ?? 0,
        available: equipment.available?.length ? equipment.available : DEFAULT_PLATES,
        loading: equipment.loading ?? 'per-side',
      });

    // 1. The load is not real.
    const ego = egoCheck({ history, scheme, exerciseId });
    if (ego.flagged) {
      return {
        action: 'lighter',
        reason: `${ego.message} Drop to something you can hold the whole range at, and earn the weight back — the reps are the evidence, not the number on the bar.`,
        suggestedWeight: lighter(0.85),
      };
    }

    // 2. Reps living on the floor of the range.
    const onFloor = tops.slice(-3).filter((t) => (numeric(t.reps) ?? 99) <= slot.repMin).length;
    if (onFloor >= 2) {
      return {
        action: 'lighter',
        reason: `Your last sets keep landing on ${slot.repMin} reps, the very bottom of the ${slot.repMin}–${slot.repMax} range. That is the weight sitting above the range rather than inside it — go lighter and work the top half, where the reps are.`,
        suggestedWeight: lighter(0.9),
      };
    }

    // 3. Same load, mid-range, going nowhere.
    const sameWeight = tops.filter((t) => numeric(t.weight) === latestWeight).length;
    const strengths = sessions.map((s) => bestPreciseE1RM(s.sets ?? [])).filter((v) => v > 0);
    const flat = Math.abs(percentSlope(strengths)) < 1;

    if (sameWeight >= STUCK && flat) {
      return {
        action: 'change-stimulus',
        reason: `${sameWeight} sessions at ${latestWeight} lb and the reps are inside the range but not moving. The load is not the problem here, so do not deload it — change the stimulus instead: a different rep range, a different machine, or swap the movement for a few weeks.`,
        suggestedWeight: null,
      };
    }

    return {
      action: 'hold',
      reason: 'Weight and strength are moving together. Nothing to change.',
      suggestedWeight: null,
    };
  } catch {
    return wait;
  }
}
