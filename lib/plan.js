/**
 * Turning a day template into a workout you can actually run.
 *
 * Shared verbatim between the server and the phone. The phone builds its own
 * plans offline from its local history; if this lived in two places they would
 * eventually disagree about what weight to put on the bar.
 */

import { getScheme, buildPrescription } from './scheme.js';
import { roundToLoadable } from './plates.js';
import { suggestNextTopWeight } from './progression.js';
import { topSet } from './strength.js';

export function schemeOf(dayExercise) {
  return dayExercise.customScheme ?? getScheme(dayExercise.schemeId);
}

/**
 * A deliberate step back, taken once.
 *
 * `deloadPct` is set on a day slot by the fortnightly review and honoured here,
 * because the weight is **derived** from history rather than stored — so there is
 * nowhere else a deload could live. Without this the whole deload proposal would
 * be a field nothing reads, which this project has now shipped twice and does not
 * intend to a third time.
 *
 * Rounded to what the equipment can actually make, like every other weight in the
 * app: 10% off 205 lb on a cable stack is not a number that stack can produce.
 * The reason is rewritten rather than appended to, so the screen says a step back
 * was taken on purpose rather than reporting the progression logic that would
 * otherwise have applied.
 */
export function applyDeload(suggestion, deloadPct, equipment = {}) {
  const pct = Number(deloadPct);
  if (!suggestion?.weight || !Number.isFinite(pct) || pct <= 0) return suggestion;

  const target = suggestion.weight * (1 - Math.min(pct, 50) / 100);
  const weight = roundToLoadable(target, {
    barWeight: equipment.barWeight ?? 0,
    loading: equipment.loading ?? 'per-side',
    available: equipment.available,
    increment: equipment.increment,
  });

  // A rounding that cannot go down — a 5 lb stack at its lowest pin — would
  // otherwise report a deload that did not happen.
  if (!(weight > 0) || weight >= suggestion.weight) return suggestion;

  return {
    weight,
    action: 'deload',
    reason: `Stepping back ${Math.round(pct)}% on purpose this session, to ${weight} lb. `
      + `Take every set to failure at that and let the reps climb back through the range.`,
  };
}

/**
 * @param day               a day template with its exercises inlined
 * @param lastSessionFor    (exerciseId) => { date, sets } | null
 * @param historyFor        (exerciseId) => [{ date, sets }] oldest first. Optional:
 *                          without it progression sees one session and can never
 *                          count the streak an increase now has to earn.
 * @param availablePlates   overrides each exercise's plate set, for one gym
 * @param defaultRestSeconds fallback when the template does not say
 */
export function buildDayPlan(day, { lastSessionFor, historyFor = null, availablePlates = null, defaultRestSeconds = 180 }) {
  if (!day) return null;

  return {
    dayId: day.id,
    dayName: day.name,
    programName: day.programName,
    exercises: day.exercises.map((de) => {
      const scheme = schemeOf(de);
      const equipment = availablePlates ? { ...de.equipment, available: availablePlates } : de.equipment;
      const history = historyFor ? historyFor(de.exerciseId) : null;
      const lastSession = lastSessionFor(de.exerciseId);
      const suggestion = applyDeload(
        suggestNextTopWeight({ scheme, history, lastSession, equipment }),
        de.deloadPct,
        equipment,
      );
      const prescription = buildPrescription({ scheme, topWeight: suggestion.weight, equipment });
      const last = topSet(lastSession?.sets ?? []);

      return {
        ...prescription,
        dayExerciseId: de.id,
        exerciseId: de.exerciseId,
        name: de.name,
        schemeId: de.schemeId,
        scheme,
        restSeconds: de.restSeconds ?? defaultRestSeconds,
        equipment,
        muscleGroup: de.muscleGroup ?? null,
        suggestion,
        lastDate: lastSession?.date ?? null,
        lastSets: lastSession?.sets ?? [],
        lastTopWeight: last ? last.weight : null,
      };
    }),
  };
}
