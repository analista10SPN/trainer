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
import { equipmentFor } from './exercises.js';
import { scheduledProgramId } from './schedule.js';
import { SCHEMES } from './scheme.js';
import { EXERCISE_SEED, PROGRAM_SEED } from './templates.js';

export const DEFAULT_SETTINGS = {
  availablePlates: DEFAULT_PLATES,
  defaultRestSeconds: 180,
};

/* ------------------------ the person, and the device ---------------------- */

/**
 * Settings that describe **you** and belong on every device you use.
 *
 * They were all phone-only. He typed his height, age and body-fat range into
 * Setup, the resting burn started working, and none of it ever left the device —
 * so a reinstall would have lost the lot *silently*: the estimate simply stops
 * appearing, with nothing to say why. It also meant the cloud held a profile
 * with every one of these fields sitting null while the phone had the answers.
 *
 * The answer is not a new sync channel. `profiles` already exists, already has a
 * column for nearly all of this, and already syncs — registration fills it in for
 * a new member. He never went through registration, which is the only reason his
 * went nowhere. So Setup writes to the same place the registration form does.
 */
export const SHARED_SETTINGS = [
  'heightInches', 'age', 'sex', 'bodyFatLow', 'bodyFatHigh', 'goal', 'maintenanceCalories',
  // Which unit weights are read and typed in. A property of the person, not of
  // the device: somebody who thinks in kilos thinks in kilos on both phones.
  // What is *stamped on the plates* is a separate question and belongs to the
  // building, which is where `availablePlates` already lives.
  'weightUnit',
  /**
   * Whether the weight-finding week was taken up or declined, and how long they
   * have been lifting. Both are facts about the person rather than the handset:
   * being asked again on a second phone would be the app forgetting an answer it
   * already has, and `experience` moves a suggested starting weight by nearly a
   * factor of two, so a phone without it estimates for a different person.
   *
   * **Neither travels yet**, and this list is where that is recorded rather than
   * where it is fixed. `settingsToProfile` carries a fixed set of columns and the
   * Worker's `saveProfile` validates that same set, so there is no transport for
   * these two until both move — a D1 migration, which is a deploy and not a
   * client change. Listing them here is the decision that they *are* the
   * person's, which is what the next person to add the column needs to know.
   */
  'planChoice', 'experience',
  /**
   * Which program the Train tab is for.
   *
   * The person's, not the handset's: somebody who switches from a four-day
   * upper/lower to a push/pull/legs has switched, and a second phone still
   * showing the old split would be the app disagreeing with itself about what
   * is being trained. Carries the same caveat as the two above — there is no
   * column for it yet, so it does not travel. See the note on `planChoice`.
   */
  'activeProgramId',
];

/**
 * Settings that belong to **this phone**, and must not travel.
 *
 * `authToken` above all: it is the credential, and uploading it to the server it
 * authenticates against — and back down to every other device — would be the
 * worst bug in this file. Which is why the split is written as two explicit
 * lists with a test that every setting appears in exactly one of them. A
 * denylist would leak the next secret somebody adds; an allowlist alone would
 * quietly strand the next preference. The pair fails loudly instead.
 */
export const LOCAL_SETTINGS = [
  'authToken', 'serverUrl', 'awaitingSignIn', 'availablePlates', 'availablePlatesKg',
  'defaultRestSeconds',
  // Lives on the profile already, written by its own toggle. Listing it here
  // keeps one writer rather than two racing each other.
  'showExerciseVideo',
  // Same arrangement, same reason. `level` has its own control in Setup that
  // writes the profile directly, so the sync payload must not also carry it and
  // overwrite a change made on the other phone a second later.
  'level',
];

/**
 * Local settings as a profile payload.
 *
 * Age goes up as a **birth year**. An age typed once is wrong within twelve
 * months and wrong by five eventually, and every resting-burn figure drifts with
 * it — so the thing that does not change is what gets stored, and the thing that
 * does is derived on the way back out.
 *
 * A cleared field is sent as `null` rather than omitted: clearing a body-fat
 * range has to clear it on the other device too, and a missing key means "no
 * opinion", which would leave the old value standing forever.
 */
export function settingsToProfile(settings, year = new Date().getUTCFullYear()) {
  const s = settings ?? {};
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

  const age = num(s.age);

  return {
    heightInches: num(s.heightInches),
    birthYear: age === null || !Number.isFinite(age) ? null : year - Math.round(age),
    sex: s.sex ?? null,
    bodyFatLow: num(s.bodyFatLow),
    bodyFatHigh: num(s.bodyFatHigh),
    goal: s.goal || null,
    maintenanceCalories: num(s.maintenanceCalories),
  };
}

/**
 * A profile folded back into local settings.
 *
 * **A remote blank never wipes an answer already on this phone.** It is the rule
 * `fetchAccount` had to learn after a blank profile un-registered somebody: a
 * field nobody has filled in yet is silence, not an instruction to forget. A real
 * remote answer does win, because it is the more recently saved one.
 */
export function profileToSettings(profile, year = new Date().getUTCFullYear(), local = {}) {
  const p = profile ?? {};
  const out = { ...(local ?? {}) };

  const take = (key, value) => {
    if (value === null || value === undefined) return;
    out[key] = value;
  };

  take('heightInches', p.heightInches);
  take('sex', p.sex);
  take('bodyFatLow', p.bodyFatLow);
  take('bodyFatHigh', p.bodyFatHigh);
  take('goal', p.goal);
  take('maintenanceCalories', p.maintenanceCalories);

  if (p.birthYear !== null && p.birthYear !== undefined) out.age = year - Number(p.birthYear);

  return out;
}

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
            equipment: equipmentFor(lift),
            muscleGroup: lift?.muscleGroup ?? null,
            // `entry` and `unilateral` are deliberately NOT copied here. They were,
            // and a lift swapped in mid-session arrived without them — because the
            // swap builds its plan entry by a different route, which nobody
            // remembered to update. Anything that needs to know which unit the box
            // asks for looks the lift up in the library, where it is stored once.
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
/**
 * Fields the seed may never fill in on a lift that already exists.
 *
 * `entry` says whether a weight was typed as one dumbbell or as the pair total, and
 * **it changes what every number already logged against that lift means.** Filling
 * it in from the seed would silently halve, on screen, every dumbbell weight he has
 * recorded — the data untouched and the reading wrong, which is the worst of the two.
 *
 * So these arrive one of two ways: with a brand-new library, where there is no
 * history to misread, or because he answered the question in the library. Never by
 * inference over data somebody already entered.
 */
const NEVER_BACKFILLED = new Set(['entry', 'unilateral']);

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
      if (NEVER_BACKFILLED.has(key)) continue;
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
        equipment: equipmentFor(lift),
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
 * Which program the Train tab is for.
 *
 * Train used to show **every day of every program** — thirteen rows on a fresh
 * install, of which four were the split being trained — and `weekPlan` picked
 * which of them to count by looking at the most recent session. That inference
 * is right nearly always and silently wrong exactly when it matters: the week
 * after a switch, when the last session still belongs to the old program.
 *
 * So the choice is recorded and this resolves it. The inference stays as the
 * fallback, which is what lets every install that predates the setting carry on
 * unchanged — nobody is made to choose before the app will show them anything.
 *
 * A choice pointing at a program that has since been deleted falls through to
 * the same fallback rather than emptying the screen, because a stale id is a
 * question the app can answer itself.
 */
export function activeProgramIn(boot, settings, trainedId = null, now = new Date()) {
  const programs = boot?.programs ?? [];
  if (!programs.length) return null;
  const real = (id) => Boolean(id) && programs.some((p) => p.id === id);

  /**
   * Three answers, strictly ordered by how explicit each one is.
   *
   * A block somebody wrote down beats a program they picked once, which beats
   * whatever their last session happened to belong to. Every layer is absent
   * until it is used, which is the only reason a schedule could be added to a
   * resolver this much of the app already leans on: somebody who has never made
   * one sees no change at all.
   *
   * A week pointing at a deleted program falls through rather than emptying the
   * Train tab. The schedule is still a schedule — this week simply has nothing
   * in it, and an empty screen would be the app punishing somebody for tidying
   * up. `describeSchedule` is what says so out loud.
   */
  const thisWeek = scheduledProgramId(settings?.schedule, now);
  if (real(thisWeek)) return thisWeek;

  if (real(settings?.activeProgramId)) return settings.activeProgramId;
  if (real(trainedId)) return trainedId;
  return programs[0].id;
}

/**
 * Put one program's days in the order given.
 *
 * `position` has always decided which day is "day one" — `week.js` sorts by it
 * and `nextUp` walks that order — and until now nothing could change it. So a
 * push/pull/legs split could never be trained legs first, however much somebody
 * wanted it that way.
 *
 * Days left out of `orderedIds` keep their relative order **after** the ones
 * named, rather than being dropped: a partial list is an instruction about the
 * days it mentions, not a new week. Ids belonging to another program are
 * ignored for the same reason — this is a reorder, never a reassignment.
 *
 * Positions come out contiguous from zero whatever went in, because the seed
 * has handed out duplicates before and two days sharing a position makes "day
 * one" depend on array order.
 */
export function reorderDaysIn(boot, programId, orderedIds = []) {
  if (!boot?.days) return boot;

  const mine = boot.days.filter((d) => d.programId === programId);
  if (!mine.length) return boot;

  const named = (Array.isArray(orderedIds) ? orderedIds : [])
    .map((id) => mine.find((d) => d.id === id))
    .filter((d, i, all) => d && all.indexOf(d) === i);

  const rest = mine
    .filter((d) => !named.includes(d))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const order = new Map([...named, ...rest].map((d, i) => [d.id, i]));

  return {
    ...boot,
    days: boot.days.map((d) => (order.has(d.id) ? { ...d, position: order.get(d.id) } : d)),
  };
}

/**
 * Move one day up or down a place. `step` is -1 for earlier, 1 for later.
 *
 * Built on `reorderDaysIn` rather than beside it, so the two cannot disagree —
 * the buttons and a whole-order rewrite are the same operation with different
 * arguments. Moving off either end is a no-op rather than a wrap.
 */
export function moveDayIn(boot, dayId, step) {
  const day = (boot?.days ?? []).find((d) => d.id === dayId);
  if (!day) return boot;

  const mine = boot.days
    .filter((d) => d.programId === day.programId)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const at = mine.findIndex((d) => d.id === dayId);
  const to = at + (step < 0 ? -1 : 1);
  if (to < 0 || to >= mine.length) return boot;

  const ids = mine.map((d) => d.id);
  ids.splice(to, 0, ids.splice(at, 1)[0]);

  return reorderDaysIn(boot, day.programId, ids);
}

/**
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

  /**
   * Adding it back lifts the tombstone, exactly as `upsertDayIn` does for days.
   *
   * It did not, and the asymmetry was invisible until you looked for it: the
   * program came back, `mergeSeed` saw its id still on `removedPrograms`, and
   * stripped its seed days on the next launch — leaving a program on the Train
   * tab with nothing in it.
   */
  const removedPrograms = boot.removedPrograms
    ? boot.removedPrograms.filter((id) => id !== program.id)
    : undefined;

  const next = { ...boot, programs, ...(removedPrograms ? { removedPrograms } : {}) };
  return { ...next, days: (next.days ?? []).map((d) => hydrateDay(d, next)) };
}
