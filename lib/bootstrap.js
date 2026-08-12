/**
 * Building the whole program client-side.
 *
 * The app has to run with no server at all — installed on a phone, opened on
 * a hotel wifi, hosted as static files. That means the seed program cannot
 * live only in a database on a PC; the browser needs to be able to construct
 * the same payload the server would have sent.
 *
 * This produces exactly the shape of GET /api/bootstrap, so the rest of the
 * app cannot tell which one it got.
 */

import { getBarType, DEFAULT_PLATES, BAR_TYPES } from './plates.js';
import { SCHEMES } from './scheme.js';
import { EXERCISE_SEED, PROGRAM_SEED } from './templates.js';

export const DEFAULT_SETTINGS = {
  availablePlates: DEFAULT_PLATES,
  defaultRestSeconds: 180,
};

/** Fill in the equipment details the seed leaves implicit. */
export function hydrateExercise(seed) {
  const bar = getBarType(seed.barType ?? 'olympic');
  return {
    id: seed.id,
    name: seed.name,
    barType: bar.id,
    barWeight: seed.barWeight ?? bar.weight,
    loading: seed.loading ?? bar.loading,
    available: seed.available ?? DEFAULT_PLATES,
    muscleGroup: seed.muscleGroup ?? null,
    notes: seed.notes ?? '',
    archived: false,
  };
}

export function buildLocalBootstrap({ exercises = EXERCISE_SEED, programs = PROGRAM_SEED } = {}) {
  const library = exercises.map(hydrateExercise).sort((a, b) => a.name.localeCompare(b.name));
  const byId = new Map(library.map((e) => [e.id, e]));

  const days = [];
  programs.forEach((program) => {
    program.days.forEach((day, dayIndex) => {
      days.push({
        id: day.id,
        programId: program.id,
        programName: program.name,
        name: day.name,
        position: dayIndex,
        exercises: (day.exercises ?? []).map((slot, i) => {
          const lift = byId.get(slot.exerciseId);
          return {
            id: `${day.id}-${slot.exerciseId}-${i}`,
            dayId: day.id,
            exerciseId: slot.exerciseId,
            name: lift?.name ?? slot.exerciseId,
            schemeId: slot.schemeId ?? 'rp-2',
            customScheme: slot.customScheme ?? null,
            restSeconds: slot.restSeconds ?? DEFAULT_SETTINGS.defaultRestSeconds,
            position: i,
            equipment: {
              barType: lift?.barType ?? 'olympic',
              barWeight: lift?.barWeight ?? 45,
              loading: lift?.loading ?? 'per-side',
              available: lift?.available ?? DEFAULT_PLATES,
            },
            muscleGroup: lift?.muscleGroup ?? null,
          };
        }),
      });
    });
  });

  return {
    programs: programs.map((p, i) => ({
      id: p.id,
      name: p.name,
      daysPerWeek: p.daysPerWeek,
      position: i,
    })),
    days,
    exercises: library,
    schemes: SCHEMES,
    barTypes: BAR_TYPES,
    defaultPlates: DEFAULT_PLATES,
    settings: { ...DEFAULT_SETTINGS },
    local: true,
  };
}

/* ------------------------- local template editing ------------------------- */

/** Re-derive the denormalised fields a day carries, after an edit. */
export function hydrateDay(day, boot) {
  const byId = new Map((boot.exercises ?? []).map((e) => [e.id, e]));
  const program = (boot.programs ?? []).find((p) => p.id === day.programId);

  return {
    ...day,
    programName: program?.name ?? day.programName ?? '',
    exercises: (day.exercises ?? []).map((slot, i) => {
      const lift = byId.get(slot.exerciseId);
      return {
        ...slot,
        id: slot.id ?? `${day.id}-${slot.exerciseId}-${i}`,
        dayId: day.id,
        name: lift?.name ?? slot.exerciseId,
        position: i,
        equipment: {
          barType: lift?.barType ?? 'olympic',
          barWeight: lift?.barWeight ?? 45,
          loading: lift?.loading ?? 'per-side',
          available: lift?.available ?? DEFAULT_PLATES,
        },
        muscleGroup: lift?.muscleGroup ?? null,
      };
    }),
  };
}

/** Insert or replace a day, appending new ones at the end of their program. */
export function upsertDayIn(boot, day) {
  const days = [...(boot.days ?? [])];
  const hydrated = hydrateDay(day, boot);
  const at = days.findIndex((d) => d.id === day.id);

  if (at === -1) {
    hydrated.position = days.filter((d) => d.programId === day.programId).length;
    days.push(hydrated);
  } else {
    hydrated.position = day.position ?? days[at].position;
    days[at] = hydrated;
  }

  return { ...boot, days };
}

export function removeDayFrom(boot, dayId) {
  return { ...boot, days: (boot.days ?? []).filter((d) => d.id !== dayId) };
}

export function upsertExerciseIn(boot, exercise) {
  const hydrated = hydrateExercise(exercise);
  const exercises = [...(boot.exercises ?? [])];
  const at = exercises.findIndex((e) => e.id === hydrated.id);
  if (at === -1) exercises.push(hydrated);
  else exercises[at] = { ...exercises[at], ...hydrated };
  exercises.sort((a, b) => a.name.localeCompare(b.name));

  // A rename has to reach the day slots that quote the old name.
  const next = { ...boot, exercises };
  return { ...next, days: (next.days ?? []).map((d) => hydrateDay(d, next)) };
}

export function upsertProgramIn(boot, program) {
  const programs = [...(boot.programs ?? [])];
  const at = programs.findIndex((p) => p.id === program.id);
  if (at === -1) programs.push({ position: programs.length, daysPerWeek: 4, ...program });
  else programs[at] = { ...programs[at], ...program };

  const next = { ...boot, programs };
  return { ...next, days: (next.days ?? []).map((d) => hydrateDay(d, next)) };
}
