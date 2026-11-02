/**
 * Which movement a lift is, so a row can show a figure performing it.
 *
 * The reference for this was Hevy's exercise row: a small figure doing the
 * lift, beside its name. What makes that read at 44px is not anatomy — it is
 * **the equipment and the body's orientation**. A bar overhead, a bar at the
 * shins, a body lying on a bench. Those are drawable; muscles are not.
 *
 * ## Why per movement and not per exercise
 *
 * Ninety-three hand-drawn figures is more bytes than the whole typeface, and a
 * lift invented at the rack mid-workout would have none — which is not an edge
 * case in this app, it is how the library grew. Thirteen movements cover every
 * lift in the library and every lift anybody will add, because a new lift is
 * almost always a new *variant* of a movement that already exists.
 *
 * ## Why derived and not stored
 *
 * `movement_patterns` exists in Postgres and has never reached the phone.
 * Adding a field to every exercise would mean a migration plus an answer for
 * the hundred lifts already logged, and somebody would have to supply those
 * answers by hand. A classifier over the name and the bar type needs neither,
 * and it answers for a lift created thirty seconds ago.
 *
 * ## The one rule
 *
 * **When it cannot tell, it says so.** `null`, not a guess. A wrong figure is
 * worse than no figure: a bench-press mark against a leg curl actively
 * misleads, and at 44px nobody re-reads the name to check. Every fallthrough
 * here returns null rather than reaching for the nearest plausible drawing.
 */

/**
 * The movements, in the order they are tested.
 *
 * Ordered, not a keyword map, and the order is the substance. Three different
 * lifts are called "press" and want three different figures; "split squat" is
 * a lunge; "leg extension" and "tricep extension" share a word and share
 * nothing else. Each of those pairs is a test.
 */
const TABLE = [
  // Legs first: 'leg press', 'leg extension' and 'split squat' all contain a
  // word that a later rule would claim.
  [/\bleg\s*curl|\bham(string)?\s*curl|\bnordic|\bglute\s*ham/i, 'legcurl'],
  [/\bleg\s*ext/i, 'legext'],
  [/\bcalf|\bsoleus|\bheel\s*raise/i, 'calf'],
  [/\blunge|\bsplit\s*squat|\bstep[-\s]*up|\bbulgarian/i, 'lunge'],
  [/\bsquat|\bleg\s*press|\bhack\b/i, 'squat'],
  [/\bdeadlift|\brdl\b|\bromanian|\bgood\s*morning|\bhip\s*thrust|\bback\s*ext|\bhyperext|\brack\s*pull/i, 'hinge'],

  // Standing, weight at the sides, shoulders up. Visibly not a lateral raise,
  // where the arms travel out — so it gets its own figure rather than being
  // folded in with one that would be wrong in an obvious way.
  [/\bshrug/i, 'shrug'],

  // Core before any 'raise', because a hanging leg raise is not a lateral one.
  [/\bcrunch|\bsit[-\s]*up|\bplank|\bab\s|\bleg\s*raise|\bhanging\s*(knee|leg)|\bwoodchop|\brussian\s*twist/i, 'core'],

  // Shoulders in the frontal plane. 'Upright row' and 'face pull' are here and
  // not with the rows, because both are performed standing and pulling wide.
  [/\blateral\s*raise|\bfront\s*raise|\bupright\s*row|\bface\s*pull|\brear[-\s]*delt|\breverse\s*(pec|fly)/i, 'raise'],

  // Chest flies before chest presses: a 'cable chest fly' contains neither
  // 'press' nor anything else, but 'pec deck' needs naming explicitly.
  [/\bfly|\bflye|\bpec\s*deck|\bcross[-\s]*over/i, 'fly'],

  // Arms. Tricep extension after leg extension, which has already matched.
  [/\bcurl/i, 'curl'],
  // `jm press` by name: it is a tricep press and the word "press" would
  // otherwise send it to the bench figure three rules below.
  [/\bpushdown|\bpress[-\s]*down|\bskull\s*crusher|\bskullcrusher|\btricep|\bkickback|\bdip\b|\bextension|\bjm\s*press/i, 'pushdown'],

  // Pulls.
  [/\bpulldown|\bpull[-\s]*up|\bchin[-\s]*up|\bpullover|\blat\s*pull/i, 'pulldown'],
  [/\brow\b|\browing/i, 'row'],

  // Presses last, and vertical before horizontal: 'shoulder press' and
  // 'overhead press' both contain 'press', and so does 'bench press'.
  [/\boverhead\s*press|\bshoulder\s*press|\bmilitary\s*press|\barnold|\bohp\b|\bpush\s*press/i, 'overhead'],
  [/\bbench\s*press|\bchest\s*press|\bincline.*press|\bdecline.*press|\bfloor\s*press|\bpush[-\s]*up/i, 'bench'],
];

/** Every movement a lift can resolve to. One drawing each. */
export const POSES = [...new Set(TABLE.map(([, pose]) => pose))];

/**
 * The movement this lift is, or `null` when it cannot be told.
 *
 * @param exercise a library record or a plan entry — anything with a `name`.
 */
export function poseOf(exercise) {
  const name = String(exercise?.name ?? '').trim();
  if (!name) return null;

  for (const [pattern, pose] of TABLE) {
    if (pattern.test(name)) return pose;
  }

  return null;
}
