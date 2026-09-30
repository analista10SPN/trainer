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

/**
 * Bumped whenever the built-in program changes in a way an installed app
 * should pick up. The phone owns its program, so without this a lift added
 * to the seed would never reach a phone that already had a copy.
 */
// Bumped whenever the built-in program or library gains something a phone that
// already has one should receive. 3 carried the demonstration videos.
export const SEED_VERSION = 3;

/** Fill in the equipment details the seed leaves implicit. */
export function hydrateExercise(seed) {
  const bar = getBarType(seed.barType ?? 'olympic');

  // Spread first, then fill in. Returning a fixed shape silently dropped every
  // field this function did not name — machine, handle, bodyweight, variantOf —
  // so a lift created with a machine lost it the moment it was saved, and
  // retiring one un-retired it on the way through.
  return {
    ...seed,
    id: seed.id,
    name: seed.name,
    barType: bar.id,
    barWeight: seed.barWeight ?? bar.weight,
    loading: seed.loading ?? bar.loading,
    available: seed.available ?? DEFAULT_PLATES,
    muscleGroup: seed.muscleGroup ?? null,
    notes: seed.notes ?? '',
    archived: Boolean(seed.archived),
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
    seedVersion: SEED_VERSION,
    local: true,
  };
}

/**
 * Fold a newer built-in program into the copy already on the phone.
 *
 * Additive by default and never destructive: new lifts appear, days the user
 * changed are left exactly as they are, and days they invented are kept. Only
 * untouched days follow the seed forward, and only when it actually moved.
 */
export function mergeSeed(cached, seed = buildLocalBootstrap()) {
  if (!cached?.exercises?.length) return seed;

  // Missing lifts are added, and **fields missing from a lift that is already
  // here are filled in**. The second half was absent, so a new field on an
  // existing seeded lift — a demonstration video, say — had no route onto a phone
  // at all: the library could grow but never improve.
  //
  // Only keys that are `undefined` locally are taken. Additive means filling
  // blanks, never correcting choices: a lift he renamed keeps its name, a video he
  // pinned keeps his, and a field he cleared to `null` stays cleared, because
  // `null` is an answer and `undefined` is the absence of one.
  const bySeedId = new Map(seed.exercises.map((e) => [e.id, e]));

  const exercises = cached.exercises.map((lift) => {
    const fromSeed = bySeedId.get(lift.id);
    if (!fromSeed) return lift;

    let filled = lift;
    for (const [key, value] of Object.entries(fromSeed)) {
      if (filled[key] === undefined && value !== undefined) {
        filled = filled === lift ? { ...lift } : filled;
        filled[key] = value;
      }
    }
    return filled;
  });

  const haveExercise = new Set(exercises.map((e) => e.id));
  for (const lift of seed.exercises) {
    if (!haveExercise.has(lift.id)) exercises.push(lift);
  }
  exercises.sort((a, b) => a.name.localeCompare(b.name));

  // Deleted on purpose, and therefore not "missing".
  const goneDays = new Set(cached.removedDays ?? []);
  const gonePrograms = new Set(cached.removedPrograms ?? []);

  const programs = [...(cached.programs ?? [])];
  const havePrograms = new Set(programs.map((p) => p.id));
  for (const program of seed.programs) {
    if (!havePrograms.has(program.id) && !gonePrograms.has(program.id)) programs.push(program);
  }

  const seedMoved = cached.seedVersion !== seed.seedVersion;
  const mine = new Map((cached.days ?? []).map((d) => [d.id, d]));
  const days = [];

  for (const seedDay of seed.days) {
    const existing = mine.get(seedDay.id);
    mine.delete(seedDay.id);
    if (goneDays.has(seedDay.id) || gonePrograms.has(seedDay.programId)) continue;
    if (!existing) days.push(seedDay);
    else if (seedMoved && !existing.userEdited) days.push(seedDay);
    else days.push(existing);
  }
  for (const invented of mine.values()) days.push(invented);

  const merged = {
    ...cached,
    removedDays: [...goneDays],
    removedPrograms: [...gonePrograms],
    exercises,
    programs,
    days,
    schemes: seed.schemes,
    barTypes: seed.barTypes,
    defaultPlates: seed.defaultPlates,
    seedVersion: seed.seedVersion,
  };

  return { ...merged, days: merged.days.map((d) => hydrateDay(d, merged)) };
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
  // Adding a day back clears its tombstone: changing your mind has to be
  // possible, or a deletion becomes a ban.
  if ((boot.removedDays ?? []).includes(day.id)) {
    boot = { ...boot, removedDays: boot.removedDays.filter((id) => id !== day.id) };
  }
  const days = [...(boot.days ?? [])];
  // Marked so a future seed update leaves this day alone.
  const hydrated = { ...hydrateDay(day, boot), userEdited: true };
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

/**
 * Delete a day, and remember that it was deleted.
 *
 * The tombstone is the whole point. `mergeSeed` re-adds any seed day the phone is
 * missing, which is correct for a phone that installed before the day existed and
 * wrong for one where it was deleted deliberately — and those two look identical
 * without a record. The effect was that deleting a day you never do brought it
 * back the next morning, which is the app overruling you.
 *
 * Recorded for every day, not only seed ones: telling them apart costs a lookup
 * and buys nothing, since an invented day has no seed entry to come back from.
 * `upsertDayIn` clears the tombstone, so changing your mind still works.
 */
export function removeDayFrom(boot, dayId) {
  const removedDays = [...new Set([...(boot.removedDays ?? []), dayId])];
  return {
    ...boot,
    days: (boot.days ?? []).filter((d) => d.id !== dayId),
    removedDays,
  };
}

/** Delete a whole program, its days with it, and remember both. */
export function removeProgramFrom(boot, programId) {
  if (!(boot.programs ?? []).some((p) => p.id === programId)) return boot;

  const doomed = (boot.days ?? []).filter((d) => d.programId === programId).map((d) => d.id);

  return {
    ...boot,
    programs: (boot.programs ?? []).filter((p) => p.id !== programId),
    days: (boot.days ?? []).filter((d) => d.programId !== programId),
    removedDays: [...new Set([...(boot.removedDays ?? []), ...doomed])],
    removedPrograms: [...new Set([...(boot.removedPrograms ?? []), programId])],
  };
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
