/**
 * Turning a day template into a workout you can actually run.
 *
 * Shared verbatim between the server and the phone. The phone builds its own
 * plans offline from its local history; if this lived in two places they would
 * eventually disagree about what weight to put on the bar.
 */

import { getScheme, buildPrescription } from './scheme.js';
import { suggestNextTopWeight } from './progression.js';
import { topSet } from './strength.js';

export function schemeOf(dayExercise) {
  return dayExercise.customScheme ?? getScheme(dayExercise.schemeId);
}

/**
 * @param day               a day template with its exercises inlined
 * @param lastSessionFor    (exerciseId) => { date, sets } | null
 * @param availablePlates   overrides each exercise's plate set, for one gym
 * @param defaultRestSeconds fallback when the template does not say
 */
export function buildDayPlan(day, { lastSessionFor, availablePlates = null, defaultRestSeconds = 180 }) {
  if (!day) return null;

  return {
    dayId: day.id,
    dayName: day.name,
    programName: day.programName,
    exercises: day.exercises.map((de) => {
      const scheme = schemeOf(de);
      const equipment = availablePlates ? { ...de.equipment, available: availablePlates } : de.equipment;
      const lastSession = lastSessionFor(de.exerciseId);
      const suggestion = suggestNextTopWeight({ scheme, lastSession, equipment });
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
