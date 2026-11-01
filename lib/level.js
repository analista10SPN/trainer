/**
 * How much detail a set records.
 *
 * The set-logging screen has fourteen things on it. That is the right number
 * for somebody who knows what a 4-0-1 tempo is and the wrong number for
 * somebody in their third week, who needs to know that a set is a weight and
 * some reps and nothing else yet.
 *
 * So the profile carries a level and the level decides which inputs appear. It
 * follows `showExerciseVideo` exactly — the same two storage places, the same
 * `profile ?? settings` fallback, and the same role-dependent default — because
 * that pattern already survived a member whose settings went nowhere.
 *
 * ## The hazard, which is not in the UI
 *
 * Hiding the tempo box means those sessions **carry** no tempo. And without a
 * tempo, "same weight, fewer reps" and "same weight, faster reps" are the same
 * row of data, while only the second one is a warning.
 *
 * `tempoDrift` and `aidsChanged` already refuse to fire unless *both* compared
 * sessions recorded the field — the same guard `machineChanged` uses, and for
 * the same reason. So they will not produce a wrong answer at basic level.
 *
 * They will produce **silence**. Which is worse, because silence from this app
 * means "nothing is wrong", and the user has no way to know the check never
 * ran. A coach that quietly stops looking at something is the failure mode this
 * project has already shipped twice: the written coach went two months without
 * being told about sleep, and `clientSummary` existed for a release without
 * being called.
 *
 * Hence `uncheckedBy`. A basic-level verdict is required to be able to say what
 * it could not look at. Turning detail off makes the screen quieter; it must
 * not make the app more confident.
 */

/** Two, and not a third. A middle level is a third set of rules to keep straight. */
export const LEVELS = ['basic', 'full'];

/**
 * What a set is, at any level.
 *
 * Not a level decision — without these there is no set to log. `weight` is
 * listed here rather than left implicit because hiding it is the one change
 * that would make the app useless instead of merely quieter.
 */
export const BASIC_FIELDS = ['exercise', 'machine', 'sets', 'reps', 'weight'];

/**
 * What full adds.
 *
 * Every one of these needs the user to know what it means before the box helps
 * them. `feel` looks like the exception, but a 1-10 number from somebody with
 * no reference for it is noise that the recovery report then reads as signal.
 *
 * **`swap` was here and should not have been.** Swapping a lift mid-session is
 * not a detail somebody records — it is what you do when the machine you wanted
 * is taken, which happens to a beginner more often than to anybody else because
 * they do not yet know the alternatives. Hiding it stranded exactly the person
 * the level exists to help. The browser suite caught it, by failing on eighteen
 * tests that reach for the button.
 *
 * `plates` is likewise absent: the plate calculator answers "what do I hang on
 * this bar", which is a beginner's question before it is anybody else's.
 */
export const FULL_ONLY_FIELDS = ['tempo', 'aids', 'feel', 'superset'];

const ALL_FIELDS = new Set([...BASIC_FIELDS, ...FULL_ONLY_FIELDS]);

/**
 * What each hidden field costs the coach.
 *
 * Written as the sentence the app can show, because the alternative is a field
 * name the user has deliberately never been shown. `tempo` first: it is the
 * only one here that changes a verdict from "fine" to "warning" rather than
 * merely adding a footnote.
 */
const COST_OF_HIDING = {
  tempo: 'Whether a weight held while the negative collapsed — same reps, dropped rather than lifted.',
  aids: 'Whether a jump came from straps or a belt rather than from you.',
  feel: 'How hard the sessions actually were, which is half of the recovery read.',
};

/** A new member starts quiet. The person who built it keeps his tempo box. */
export function defaultLevelFor(role) {
  return role === 'admin' ? 'full' : 'basic';
}

/** Only a value this module recognises. This column arrives over a network. */
const clean = (value) => (LEVELS.includes(value) ? value : null);

/**
 * The level in force.
 *
 * `profile ?? settings`, the fallback `showExerciseVideo` uses: a value synced
 * from the server is the answer, and the local setting is what a phone that has
 * never signed in has. Falls through to the role so a fresh install is never
 * levelless.
 */
export function levelOf(account, settings) {
  return clean(account?.profile?.level)
    ?? clean(settings?.level)
    ?? defaultLevelFor(account?.role);
}

/** Does this level write this field down? Unknown fields are never recorded. */
export function recordsField(level, field) {
  if (!ALL_FIELDS.has(field)) return false;
  if (BASIC_FIELDS.includes(field)) return true;
  return clean(level) === 'full';
}

/** The fields this level is not writing down. Junk reads as basic, not as full. */
export function blindSpots(level) {
  return clean(level) === 'full' ? [] : [...FULL_ONLY_FIELDS];
}

/**
 * What a verdict computed at this level could not check.
 *
 * Only the fields that actually feed an analysis — `superset`, `swap` and
 * `plates` change what the screen offers, not what the coach concludes, so
 * disclosing them would pad the list and get the real two ignored.
 */
export function uncheckedBy(level) {
  return blindSpots(level)
    .filter((field) => COST_OF_HIDING[field])
    .map((field) => ({ field, cannotTell: COST_OF_HIDING[field] }));
}
