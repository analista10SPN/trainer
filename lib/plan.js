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

/**
 * Are these two days the same workout under different names?
 *
 * `Legs 1` in Push/Pull/Legs and `Lower 1` in Upper/Lower hold byte-identical
 * exercise lists, because they are the same session offered by two programs. The
 * Train tab shows both programs at once, and its recency pill — the only guidance
 * on that screen — called one `new` the day after the other was trained. For
 * somebody who does not already know their split that is the single piece of
 * information available, saying the opposite of the truth.
 *
 * Compared as a set, because the order a day lists its lifts in is a prescription
 * and not an identity. An empty day matches nothing, including another empty one:
 * two days with no lifts yet are not evidence of anything.
 */
export function sameWorkout(a, b) {
  const lifts = (day) => {
    const ids = (day?.exercises ?? []).map((e) => e?.exerciseId).filter(Boolean);
    return new Set(ids);
  };

  const left = lifts(a);
  const right = lifts(b);
  if (!left.size || left.size !== right.size) return false;

  for (const id of left) if (!right.has(id)) return false;
  return true;
}

/**
 * A plan entry for a lift that was never in today's template.
 *
 * Swapping a lift in mid-session must not hand you a blank slate: it reads that
 * lift's own history and arrives pre-filled and progressing, exactly as a planned
 * one does. That is the same promise `buildDayPlan` makes, kept by a different
 * route — and the difference between those two routes is a real hazard. This one
 * silently dropped `entry` once, so a dumbbell lift swapped in asked for the pair
 * instead of one bell. Anything denormalised onto a plan entry has to be copied
 * in **both** places, which is the argument for denormalising as little as
 * possible onto it.
 *
 * A lift the library has never heard of still produces a usable entry. Mid-
 * workout, in a gym, with no signal, a missing row must not be a dead end.
 */
export function planAdHocExercise({
  exerciseId,
  exercises = [],
  // The history is passed in rather than queried, exactly as `buildDayPlan` takes
  // `historyFor` as a callback — `repository.js` already imports `sameWorkout`
  // from here, and a module importing back would be a cycle.
  history = [],
  schemeId = 'rp-2',
  availablePlates,
  defaultRestSeconds,
  uid = () => Math.random().toString(36).slice(2, 6),
} = {}) {
  const lift = exercises.find((e) => e.id === exerciseId);
  const scheme = getScheme(schemeId);

  const equipment = {
    barType: lift?.barType ?? 'olympic',
    barWeight: lift?.barWeight ?? 45,
    loading: lift?.loading ?? 'per-side',
    available: availablePlates,
  };

  const lastSession = history.length ? history[history.length - 1] : null;
  const suggestion = suggestNextTopWeight({ scheme, history, lastSession, equipment });
  const prescription = buildPrescription({ scheme, topWeight: suggestion.weight, equipment });

  return {
    ...prescription,
    // Unique per add, because the same lift can legitimately appear twice in one
    // session — the leg curl at 270 and then at 130 ten minutes later.
    dayExerciseId: `adhoc-${exerciseId}-${uid()}`,
    exerciseId,
    name: lift?.name ?? exerciseId,
    schemeId,
    scheme,
    restSeconds: defaultRestSeconds,
    equipment,
    suggestion,
    lastDate: lastSession?.date ?? null,
    lastSets: lastSession?.sets ?? [],
    lastTopWeight: lastSession ? (lastSession.sets?.[0]?.weight ?? null) : null,
  };
}
