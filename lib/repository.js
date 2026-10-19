/**
 * Every read the app does over logged sessions.
 *
 * These lived in `app.js`, closing over `state`, with no Node test anywhere near
 * them — covered only by Playwright, and only incidentally, through whichever
 * screen happened to render their output. They were always pure functions of
 * (sessions, boot); the only thing holding them in the UI file was that they
 * reached for a global instead of taking an argument.
 *
 * `historyFor` is the most-called domain function in the app: every coach
 * verdict, every plan, every trend reads it. It is an ORM query written as three
 * array methods, and naming it as one is the first step toward it being one.
 */

import { sameWorkout } from './plan.js';

/**
 * Every session containing this lift, oldest first, with just that lift's sets.
 *
 * Ordered forwards because every trend fitted downstream assumes time runs that
 * way, and sessions come off IndexedDB in no particular order. `reps > 0` is the
 * test for "this actually happened" — a slot opened and never filled is not a
 * session with the lift in it.
 */
export function historyFor(sessions, exerciseId) {
  if (!Array.isArray(sessions) || !exerciseId) return [];

  return sessions
    .filter((s) => (s?.sets ?? []).some((x) => x.exerciseId === exerciseId && Number(x.reps) > 0))
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
    .map((s) => ({
      sessionId: s.id,
      date: s.startedAt,
      sets: s.sets
        .filter((x) => x.exerciseId === exerciseId)
        .sort((a, b) => a.setIndex - b.setIndex),
    }));
}

/** The most recent session containing this lift, or null. */
export function lastSessionFor(sessions, exerciseId) {
  const history = historyFor(sessions, exerciseId);
  return history.length ? history[history.length - 1] : null;
}

/**
 * When this workout was last done — by any name it goes under.
 *
 * Two programs ship days with identical lifts (`Legs 1` and `Lower 1`), and the
 * Train tab lists both programs at once. Matching only on the day id meant
 * training one left the other showing `new` the next day, and that pill is the
 * only guidance on that screen for anybody who does not already know their split.
 */
export function lastPerformed(sessions, boot, dayId) {
  if (!Array.isArray(sessions)) return null;

  const days = boot?.days ?? [];
  const day = days.find((d) => d.id === dayId);
  const twins = new Set(
    days.filter((d) => d.id === dayId || sameWorkout(day, d)).map((d) => d.id),
  );
  twins.add(dayId);

  const done = sessions
    .filter((s) => twins.has(s?.dayId))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));

  return done.length ? done[0].startedAt : null;
}

/**
 * Every lift that has ever been logged, with its name and its history.
 *
 * A lift logged and since deleted from the library keeps its id as its name,
 * rather than rendering blank — it stays identifiable, and it says plainly that
 * something is missing.
 */
export function loggedExerciseList(sessions, boot) {
  if (!Array.isArray(sessions)) return [];

  const ids = new Set();
  for (const session of sessions) {
    for (const set of session?.sets ?? []) if (set?.exerciseId) ids.add(set.exerciseId);
  }

  return [...ids].map((id) => ({
    exerciseId: id,
    name: boot?.exercises?.find((e) => e.id === id)?.name ?? id,
    history: historyFor(sessions, id),
  }));
}

/**
 * The library record behind an id or a plan entry.
 *
 * Takes either, because the logger holds a plan entry rather than a library row.
 * A plan entry denormalises a few library fields onto itself, and reading the
 * *unit* off it rather than looking the lift up is how a dumbbell lift swapped in
 * mid-session silently asked for the pair instead of one bell.
 */
export function liftFor(boot, ref) {
  const id = typeof ref === 'string' ? ref : ref?.exerciseId;
  if (!id) return null;
  return boot?.exercises?.find((e) => e.id === id) ?? null;
}
