/**
 * One-off repairs to data already logged.
 *
 * This runs on the phone, not against the cloud, because the phone owns the
 * program: a server-side fix would be overwritten by the next sync.
 *
 * Versioned and idempotent. Each repair describes what it did, so a migration
 * that guesses wrong can be seen rather than discovered months later in a
 * trend line.
 */

import { normaliseMuscleGroup, splitLegacyName } from './exercises.js';

export const CLEANUP_VERSION = 1;

/**
 * Variants that were created as separate lifts because there was nowhere else
 * to put the machine and the handle. Linking them lets the coach read the
 * movement as a whole while keeping the loads apart, which is the point: two
 * cable stacks are not comparable numbers.
 *
 * Only movements that are plainly the same are linked. A machine press and a
 * dumbbell press are left alone — different implement, different exercise.
 */
const VARIANT_OF = {
  'overhead-cable-tricep-extension-eleiko-t-dbb6': 'overhead-tricep-ext',
  'overhead-cable-tricep-extension-straight-6234': 'overhead-tricep-ext',
  'overhead-dumbbell-tricep-extension-80dc': 'overhead-tricep-ext',
  'cable-tricep-pushdown-eleiko-semi-triang-8589': 'tricep-pushdown',
  'seated-cable-tricep-pushdown-4c24': 'tricep-pushdown',
  'leg-extension-plated-version-c09c': 'leg-extension',
  'unilateral-dumbbell-lateral-raise-6c98': 'lateral-raise',
  'bench-lateral-raise': 'lateral-raise',
  'lying-cable-lateral': 'lateral-raise',
  'cable-lateral': 'lateral-raise',
  'machine-lateral': 'lateral-raise',
  'seated-leg-curl': 'leg-curl',
  'rope-pushdown': 'tricep-pushdown',
};

/** Lifts that can legitimately be performed with nothing added. */
const BODYWEIGHT = new Set([
  'weighted-pullup', 'weighted-dip', 'chin-up', 'push-up',
  'hanging-leg-raise', 'assisted-pullup', 'nordic-curl', 'dip-machine',
]);

/**
 * Equipment recorded wrongly when the lift was created on a phone mid-workout.
 * A plate-loaded leg extension marked as a weight stack gets plate maths that
 * cannot make the numbers actually being lifted.
 */
const EQUIPMENT_FIXES = {
  'leg-extension-plated-version-c09c': { barType: 'none', loading: 'per-side', barWeight: 0 },
};

/** A stand-in weight is not a weight. */
const PLACEHOLDER_MAX = 1;

export function cleanExercise(exercise) {
  const changes = [];
  let next = { ...exercise };

  const group = normaliseMuscleGroup(next.muscleGroup);
  if (group !== (next.muscleGroup ?? null)) {
    changes.push(`group ${next.muscleGroup ?? 'none'} -> ${group ?? 'none'}`);
    next.muscleGroup = group;
  }

  // Machine and handle typed into the name move into their own fields, but
  // only if nothing is there yet — a hand-set value always wins.
  if (!next.machine && !next.handle) {
    const parsed = splitLegacyName(next.name);
    if (parsed.machine || parsed.handle) {
      changes.push(`name "${next.name}" -> "${parsed.name}" + ${[parsed.machine, parsed.handle].filter(Boolean).join(' / ')}`);
      next = { ...next, name: parsed.name, machine: parsed.machine, handle: parsed.handle };
    }
  }

  const base = VARIANT_OF[next.id];
  if (base && !next.variantOf && base !== next.id) {
    changes.push(`variant of ${base}`);
    next.variantOf = base;
  }

  if (BODYWEIGHT.has(next.id) && !next.bodyweight) {
    changes.push('marked bodyweight');
    next.bodyweight = true;
  }

  const equipment = EQUIPMENT_FIXES[next.id];
  if (equipment && next.barType !== equipment.barType) {
    changes.push(`equipment ${next.barType} -> ${equipment.barType}`);
    next = { ...next, ...equipment };
  }

  if (next.notes === undefined) next.notes = exercise.notes ?? '';

  return { exercise: next, changes };
}

export function cleanLibrary(exercises = []) {
  const report = [];
  const cleaned = exercises.map((exercise) => {
    const { exercise: next, changes } = cleanExercise(exercise);
    if (changes.length) report.push({ id: exercise.id, name: exercise.name, changes });
    return next;
  });

  // A variant must point at something that exists, or it vanishes from every
  // family view without explanation.
  const ids = new Set(cleaned.map((e) => e.id));
  for (const exercise of cleaned) {
    if (exercise.variantOf && !ids.has(exercise.variantOf)) delete exercise.variantOf;
  }

  return { exercises: cleaned, report };
}

/**
 * Weights that were never weights.
 *
 * Zero was rejected when these were logged, so a bodyweight pull-up went in as
 * 0.05 or 0.1. Left alone they are a fake load in every average built from them.
 */
export function cleanSessions(sessions = [], exercises = []) {
  const bodyweight = new Set(exercises.filter((e) => e.bodyweight).map((e) => e.id));
  const report = [];

  const cleaned = sessions.map((session) => {
    let touched = false;
    const sets = (session.sets ?? []).map((set) => {
      const weight = Number(set.weight);
      if (!bodyweight.has(set.exerciseId) || !(weight > 0) || weight >= PLACEHOLDER_MAX) return set;

      touched = true;
      report.push({
        date: String(session.startedAt).slice(0, 10),
        exerciseId: set.exerciseId,
        from: weight,
        setIndex: set.setIndex,
      });
      return { ...set, weight: 0 };
    });

    return touched ? { ...session, sets, _dirty: true } : session;
  });

  return { sessions: cleaned, report };
}

/** Everything, once. Returns the repaired data and what it did. */
export function runCleanup({ boot, sessions = [] }) {
  if (!boot?.exercises) return { boot, sessions, report: null };
  if (boot.cleanupVersion >= CLEANUP_VERSION) return { boot, sessions, report: null };

  const library = cleanLibrary(boot.exercises);
  const nextBoot = { ...boot, exercises: library.exercises, cleanupVersion: CLEANUP_VERSION };
  const fixed = cleanSessions(sessions, library.exercises);

  return {
    boot: nextBoot,
    sessions: fixed.sessions,
    report: { exercises: library.report, sets: fixed.report },
  };
}
