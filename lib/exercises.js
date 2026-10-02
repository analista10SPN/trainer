/**
 * What identifies an exercise.
 *
 * A cable machine's pulley profile and the handle on the end of it change what
 * the same movement feels like and what load it takes. Two "overhead tricep
 * extensions" on different machines are not comparable numbers, so they are
 * tracked apart — but they are still the same movement, and a coach that
 * cannot see that has nothing to say about either.
 *
 * So: machine and handle are fields, not name text. Variants point at a base
 * movement, which keeps their numbers separate while letting them be read
 * together.
 */

import { numeric } from './strength.js';

/** The canonical set. Anything else gets folded into one of these. */
export const MUSCLE_GROUPS = [
  'chest', 'back', 'shoulders', 'triceps', 'biceps', 'forearms',
  'quads', 'hamstrings', 'glutes', 'calves', 'core',
];

/**
 * Singular and loose spellings creep in whenever a lift is added on a phone
 * mid-workout, and split a group in two without anything complaining.
 */
const GROUP_ALIASES = {
  tricep: 'triceps', tris: 'triceps',
  bicep: 'biceps', bis: 'biceps',
  shoulder: 'shoulders', delt: 'shoulders', delts: 'shoulders',
  leg: 'quads', legs: 'quads', quad: 'quads',
  hamstring: 'hamstrings', hams: 'hamstrings',
  glute: 'glutes', calf: 'calves', ab: 'core', abs: 'core',
  lats: 'back', trap: 'back', traps: 'back', forearm: 'forearms',
};

export function normaliseMuscleGroup(group) {
  const key = String(group ?? '').trim().toLowerCase();
  if (!key) return null;
  if (MUSCLE_GROUPS.includes(key)) return key;
  return GROUP_ALIASES[key] ?? key;
}

/* ------------------------------- naming ---------------------------------- */

/**
 * "ELEIKO · Triangle handle", or nothing if none of it is set.
 *
 * "one side at a time" belongs here with the machine and the handle: all three
 * are conditions under which the same movement is performed, and all three make
 * the loads incomparable. Carrying it as a qualifier is what lets the word come
 * out of the name — "Unilateral Dumbbell Lateral Raise" and "Dumbbell Lateral
 * Raise" were two names for one movement, and nothing but the name said so.
 */
export function qualifier(exercise) {
  return [exercise?.machine, exercise?.handle, exercise?.unilateral ? 'one side at a time' : null]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(' · ');
}

/** The one-line name: base movement plus what distinguishes this version. */
export function fullName(exercise) {
  const base = String(exercise?.name ?? '').trim();
  const extra = qualifier(exercise);
  return extra ? `${base} (${extra})` : base;
}

/**
 * Pull a machine and handle out of a name someone typed by hand.
 *
 * Written to clean up names entered before these fields existed, in the shapes
 * actually used: "Movement (ELEIKO - TRIANGLE)", "Movement (Straight Handle)".
 */
/**
 * Words that appear in brackets but name neither a machine nor a handle.
 * "Push-Up (weighted)" describes what the lift can carry, which is a flag, not
 * a piece of equipment.
 */
const NOT_A_QUALIFIER = /^(weighted|bodyweight|bw|optional)$/i;

export function splitLegacyName(name) {
  const match = String(name ?? '').match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!match) return { name: String(name ?? '').trim(), machine: null, handle: null };

  const [, base, inside] = match;
  const parts = inside.split(/\s*[-–—]\s*/).map((p) => p.trim()).filter(Boolean);

  const titled = (s) =>
    s.replace(/\s+/g, ' ')
      .toLowerCase()
      .replace(/\b[a-z]/g, (c) => c.toUpperCase());

  // Two parts reads as machine then handle. One part naming a handle is a
  // handle; anything else is the machine.
  if (parts.length >= 2) {
    return { name: base.trim(), machine: titled(parts[0]), handle: titled(parts.slice(1).join(' ')) };
  }
  const only = parts[0] ?? '';
  if (NOT_A_QUALIFIER.test(only)) return { name: base.trim(), machine: null, handle: null };

  return /handle|grip|bar|rope|triangle|d.handle/i.test(only)
    ? { name: base.trim(), machine: null, handle: titled(only) }
    : { name: base.trim(), machine: titled(only), handle: null };
}

/* ------------------------------- families -------------------------------- */

/** The movement an exercise belongs to: its base, or itself. */
export function familyOf(exercise) {
  return exercise?.variantOf || exercise?.id;
}

/**
 * Group exercises by movement.
 *
 * The point is the coach: one lift done on three machines has three sparse
 * histories and nothing can be said about any of them, while the movement as a
 * whole may have plenty.
 */
export function familiesOf(exercises = []) {
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const families = new Map();

  for (const exercise of exercises) {
    const rootId = familyOf(exercise);
    const root = byId.get(rootId) ?? exercise;
    if (!families.has(rootId)) {
      families.set(rootId, { id: rootId, name: String(root.name ?? rootId).trim(), members: [] });
    }
    families.get(rootId).members.push(exercise);
  }

  return [...families.values()];
}

/* --------------------------- what a weight means --------------------------- */

/**
 * One invariant: **`set.weight` is the total load moved.**
 *
 * He logged lateral raises as the weight of *one* dumbbell — 15, 17.5, 25, 30, 35 —
 * which is the natural thing to do, because that is the number painted on the thing
 * you pick up. He logged incline dumbbell press as 140, 150, 170, 200, which is the
 * *pair total*, because no 200 lb dumbbell exists. Same app, same week, two units,
 * and nothing anywhere recording which was which. There is then no honest answer to
 * "is this lift getting stronger", because the series is in two units.
 *
 * So the stored number always means the whole load. `entry` says how the **input
 * box** is labelled, which is a different question, and keeping those two apart is
 * the entire design: the gym asks "what is on the dumbbell", the data asks "how much
 * moved", and only one of them should be stored.
 */

/** How many of the thing are being lifted at once. */
export function handsOf(exercise) {
  if (exercise?.entry !== 'per-hand') return 1;
  // One arm at a time is one load, whatever the kit.
  return exercise.unilateral ? 1 : 2;
}

/** Does the keypad ask for one dumbbell rather than the whole load? */
export function asksPerHand(exercise) {
  return exercise?.entry === 'per-hand';
}

/**
 * What he typed, as a total.
 *
 * `null` rather than 0 for anything unreadable: `Number(null)` is 0, and a 0 lb top
 * set would be stored as a real measurement and read as one for ever.
 */
export function enteredToTotal(entered, exercise) {
  const n = numeric(entered);
  if (n === null) return null;
  return n * handsOf(exercise);
}

/** The total, as the number he would type. Rounded to the half pound plates come in. */
export function totalToEntered(total, exercise) {
  const n = numeric(total);
  if (n === null) return null;
  return Math.round((n / handsOf(exercise)) * 2) / 2;
}

/* ------------------------------ bodyweight -------------------------------- */

/**
 * Zero is a real load on a pull-up.
 *
 * Rejecting it forced 0.05 and 0.1 into the log as stand-ins, which are not
 * weights and quietly poison any average built from them.
 */
export function allowsZeroLoad(exercise) {
  return Boolean(exercise?.bodyweight);
}

/** The load a set actually moved, counting bodyweight where it applies. */
export function effectiveLoad(set, exercise, bodyWeight = null) {
  const added = Number(set?.weight) || 0;
  if (!exercise?.bodyweight || !Number.isFinite(Number(bodyWeight))) return added;
  return Number(bodyWeight) + added;
}

/**
 * How a set reads on screen: "bodyweight", "bodyweight +45", "185", or "35 × 2".
 *
 * A pair of dumbbells shows **both** numbers, because each alone is wrong in a
 * different way: "70" is unrecognisable standing in front of the rack, and "35" is
 * not comparable to anything else in the log. Showing the pair is the only version
 * that is never misleading.
 */
export function describeLoad(set, exercise) {
  const total = Number(set?.weight) || 0;

  /**
   * A pair reads as "35 ea", not "35 × 2".
   *
   * Every caller puts the reps after this with a `×` between — "35 × 2 × 12" is
   * three numbers and one separator, and there is no way to tell which `×` means
   * what. "ea" is also what the rack is called in a gym.
   */
  const hands = handsOf(exercise);
  const shown = hands > 1 && total > 0
    ? `${totalToEntered(total, exercise)} ea`
    : `${total}`;

  if (!exercise?.bodyweight) return shown;
  if (total <= 0) return 'bodyweight';
  return `bodyweight +${shown}`;
}
