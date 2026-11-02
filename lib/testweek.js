/**
 * The week that finds out what somebody can lift.
 *
 * A beginner has no history, so `suggestNextTopWeight` has nothing to read and
 * the first session would have to prescribe a number from nothing. The way out
 * is not a better guess. It is to spend the first week finding out: train the
 * prescribed split, work up on each lift until the target rep range is honestly
 * hard, write down what happened. Week two then starts from a measurement.
 *
 * Which is why the test week is **the prescribed week**, not a separate
 * program. Somebody new does not need a special protocol to learn before they
 * have learned the lifts; they need to do their week and record it. It also
 * means nothing has to be installed, taught or undone afterwards.
 *
 * ## Why this inverts Epley instead of choosing a better equation
 *
 * `strength.js` estimates 1RM with Epley, and every trend in this app is built
 * on it. If the test week estimated with Epley and prescribed with Brzycki the
 * round trip would not close — the weight handed back would not be the weight
 * that produced the estimate, and a person doing the arithmetic on paper would
 * find the app contradicting itself.
 *
 * Consistency between the two directions matters more here than either
 * equation's absolute accuracy, because what this module is actually asked for
 * is *a load that lands in the target rep range*. Both directions are wrong by
 * the same amount in the same direction, so the error largely cancels, and the
 * first real session corrects whatever is left.
 *
 * ## The safeguard this closes
 *
 * `isE1RMReliable` has sat in `strength.js` since the beginning with no
 * callers — a guard that never runs, which `CONTEXT.md` lists as an open
 * thread. Here it earns its keep. Epley drifts optimistic past about a dozen
 * reps, and this is the one place in the app where an over-estimate
 * **compounds** rather than correcting itself: a test set taken for twenty reps
 * would set every subsequent weight on that lift too high, and the progression
 * would then try to add to it. So an unusable test is reported as unusable
 * rather than quietly used.
 */

import { preciseE1RM, isE1RMReliable, numeric } from './strength.js';
import { getScheme } from './scheme.js';

/** The range to test in. Low enough that Epley holds, high enough to be safe. */
export const TEST_REPS = { min: 5, max: 10 };

/**
 * What to do in the test week, day by day, lift by lift.
 *
 * The rep target per lift comes from its own scheme's top set rather than being
 * fixed here, so a lift prescribed at 8-12 is tested at 8-12 and the number
 * that comes back is the number week two needs. It is clamped into the range
 * Epley can be trusted over, because a test is worthless outside it.
 */
export function testWeekPlan(program, { rirTarget = null } = {}) {
  if (!program?.days?.length) return null;

  const rir = rirTarget ?? program.rirTarget ?? { low: 2, high: 3 };

  return {
    rirTarget: rir,
    says:
      'Train the week as written. On each lift, work up until the target reps are honestly hard, '
      + `stopping ${rir.low}-${rir.high} reps short of failure, and log what you did. `
      + 'Next week starts from those numbers rather than from a guess.',
    days: program.days.map((day) => ({
      id: day.id,
      name: day.name,
      lifts: day.exercises.map((x) => {
        const top = getScheme(x.schemeId)?.working?.[0] ?? {};
        const min = Math.max(TEST_REPS.min, Number(top.repMin) || TEST_REPS.min);
        const max = Math.min(12, Math.max(min, Number(top.repMax) || TEST_REPS.max));
        return {
          exerciseId: x.exerciseId,
          targetReps: { min, max },
          rir,
          says: `Work up to ${min}-${max} reps, stopping ${rir.low}-${rir.high} short of failure.`,
        };
      }),
    })),
  };
}

/**
 * The load for `targetReps` reps with `rir` left, given a set that happened.
 *
 * Epley forwards to an estimated max, then Epley backwards to the load that
 * allows `targetReps + rir` reps to failure — because leaving two reps in
 * reserve on a set of eight is the same load as a ten-rep maximum.
 */
export function workingWeightFor({ weight, reps, targetReps, rir = 0 }) {
  const w = numeric(weight);
  const r = numeric(reps);
  const target = numeric(targetReps);
  const reserve = numeric(rir) ?? 0;

  if (!w || !r || !target || w <= 0 || r < 1 || target < 1) return null;

  const e1RM = preciseE1RM(w, r);
  if (!e1RM) return null;

  return e1RM / (1 + (target + Math.max(0, reserve)) / 30);
}

/** A test set is only a test if it happened and Epley can be trusted over it. */
export function isUsableTest(set) {
  const w = numeric(set?.weight);
  const r = numeric(set?.reps);
  return Boolean(w && w > 0 && r && isE1RMReliable(r));
}

/**
 * Every lift in the program, with the weight its test earned — or none.
 *
 * An untested lift gets `null` rather than a weight borrowed from a similar
 * movement. The app does not know that a hack squat and a leg press load the
 * same, and inventing a number here would be indistinguishable, on screen, from
 * one that was measured. `source` is what lets the screen tell the person which
 * of their weights are theirs.
 */
export function startingWeights(program, results = [], { rirTarget = { low: 2, high: 3 } } = {}) {
  if (!program?.days?.length) return [];

  const tested = new Map();
  for (const r of Array.isArray(results) ? results : []) {
    if (r?.exerciseId) tested.set(r.exerciseId, r);
  }

  // The reserve to aim for is the cautious end of the range: landing at three
  // reps in reserve and finding it easy costs one session, landing at zero and
  // finding it too heavy costs the set.
  const reserve = Math.max(rirTarget?.low ?? 0, rirTarget?.high ?? 0);

  const seen = new Set();
  const out = [];

  for (const day of program.days) {
    for (const x of day.exercises) {
      if (seen.has(x.exerciseId)) continue;
      seen.add(x.exerciseId);

      const result = tested.get(x.exerciseId);
      const top = getScheme(x.schemeId)?.working?.[0] ?? {};
      const target = Number(top.repMin) || TEST_REPS.min;

      if (!result) {
        out.push({
          exerciseId: x.exerciseId,
          weight: null,
          source: 'untested',
          says: 'Not tested yet — work up to a hard set and it will have a number next week.',
        });
        continue;
      }

      if (!isUsableTest(result)) {
        out.push({
          exerciseId: x.exerciseId,
          weight: null,
          source: 'unusable',
          says: `${result.reps} reps is too many to estimate a max from — retest at ${TEST_REPS.min}-${TEST_REPS.max} reps.`,
        });
        continue;
      }

      out.push({
        exerciseId: x.exerciseId,
        weight: workingWeightFor({ weight: result.weight, reps: result.reps, targetReps: target, rir: reserve }),
        source: 'tested',
        says: `From ${result.weight} for ${result.reps} reps, aiming for ${target} with ${reserve} left.`,
      });
    }
  }

  return out;
}
