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

/** "ELEIKO · Triangle handle", or nothing if neither is set. */
export function qualifier(exercise) {
  return [exercise?.machine, exercise?.handle]
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

/** How a set reads on screen: "bodyweight", "bodyweight +45", or "185". */
export function describeLoad(set, exercise) {
  const weight = Number(set?.weight) || 0;
  if (!exercise?.bodyweight) return `${weight}`;
  if (weight <= 0) return 'bodyweight';
  return `bodyweight +${weight}`;
}
