/**
 * Data that contradicts itself, found and shown — never silently corrected.
 *
 * Every lift in this library was either seeded or typed on a phone between
 * sets, and the muscle group is the field that suffers for it: it is one tap in
 * a hurry, it is optional, and nothing downstream complains when it is wrong.
 * The live library carried a **Cable Pullover filed under chest** while the
 * **Dumbbell PullOver** beside it was filed under back. Same movement, two
 * groups, and `groupTrends` reading one of them into the wrong rollup —
 * invisible, because a group total is plausible whatever went into it.
 *
 * Two rules this module is built on, both learned the hard way here:
 *
 * **It flags, it does not fix.** `cleanup.js` already carries the scar: an
 * automatic pass over these names would read "Leg Extension (10x10)" as a
 * machine called 10x10. A suggestion he taps is worth more than a correction he
 * never sees, and it is the same call the session-length fix made.
 *
 * **Silence is a real answer, and the common one.** A movement the table cannot
 * read gets no opinion — not a guess, and not a flag he can only dismiss. A
 * movement with two honest primaries (a dip is chest or triceps depending on
 * how you lean) accepts either, because a flag that fires on a correct answer
 * is the fastest way to teach someone to ignore flags. This app has now made
 * that call four times about prompts; this is the fifth.
 */

import { normaliseMuscleGroup } from './exercises.js';
import { numeric } from './strength.js';

/**
 * Name patterns and the groups that movement can honestly be filed under.
 *
 * **Order is load-bearing: the first match wins.** Nearly every entry here
 * contains a word that a later, looser entry also matches — a "Chest Supported
 * Row" is not a chest lift, a "Lying Leg Curl" is not a biceps lift, and a
 * "Machine Squat Calf Raise" is not a quad lift. So the specific movement is
 * listed above the general word inside it, and a change to this table means
 * checking what sits below the line being touched.
 *
 * More than one group means the movement genuinely has more than one primary,
 * and both are accepted. It is not a hedge against an unclear name: where the
 * name is unclear the right answer is to leave it out of the table entirely.
 */
export const MOVEMENT_GROUPS = [
  // --- pulls. "Chest Supported" and "Face Pull" have to clear first. -------
  [/chest[\s-]*support/i, ['back']],
  [/face pull/i, ['shoulders']],
  [/upright row/i, ['shoulders']],
  [/rear[\s-]*delt/i, ['shoulders']],

  // A straight-arm pullover is shoulder extension, which is lats. The chest
  // role of the bent-arm version is real but secondary, and both of his live
  // on pull days — so one group, and he can keep chest in one tap if he
  // disagrees.
  [/pull[\s-]*over/i, ['back']],
  [/pull[\s-]*down/i, ['back']],
  [/pull[\s-]*ups?\b|pullups?\b|chin[\s-]*ups?\b|chinups?\b/i, ['back']],
  [/shrug/i, ['back']],
  [/rack pull/i, ['back']],

  // Conventional, sumo and trap-bar deadlifts are all three at once, and
  // arguing about which is the primary is not worth a flag on his data.
  [/romanian|\brdl\b|stiff[\s-]*leg|good morning/i, ['hamstrings', 'glutes']],
  [/dead[\s-]*lift/i, ['back', 'hamstrings', 'glutes']],
  [/back extension|hyper[\s-]*extension/i, ['hamstrings', 'glutes', 'back']],
  [/glute[\s-]*ham/i, ['hamstrings', 'glutes']],

  // --- calves and core, before the leg words below can claim them. ---------
  [/\bcalf\b|calves/i, ['calves']],
  [/crunch|\bplank\b|hanging leg raise|\bab(s|dominal)\b/i, ['core']],

  // --- legs ----------------------------------------------------------------
  [/leg curl|prone curl|nordic/i, ['hamstrings']],
  [/hip thrust|glute bridge|glute kickback|\bglute\b/i, ['glutes']],
  [/abduct|adduct/i, ['glutes']],
  // A leg extension is the one squat-adjacent movement that is purely quad: the
  // hip never moves, so there is nothing for the glutes to do. Everything else
  // in this family involves hip extension under load, and `pattern_muscles` in
  // the database already says `squat -> quads, glutes`. The two had disagreed,
  // which is precisely the drift this table exists to avoid — and it mattered:
  // a Bulgarian split squat reading as quads alone made a glute-focused day look
  // like it was not one.
  [/leg extension/i, ['quads']],
  [/squat|leg press|\blunge\b|hack\b|step[\s-]*up|sled/i, ['quads', 'glutes']],

  // --- arms. Forearm and leg curls are both out of the way by here. --------
  // A reverse curl loads the brachioradialis and the extensors, and the
  // brachialis under them — honestly both, so neither answer is flagged.
  [/reverse curl/i, ['forearms', 'biceps']],
  [/wrist|forearm/i, ['forearms']],
  [/tricep|skull|\bjm press\b|pushdown|push[\s-]*down/i, ['triceps']],
  [/overhead[\s-]*(cable|dumbbell|db|ez|barbell)?[\s-]*extension/i, ['triceps']],
  [/\bcurl/i, ['biceps']],

  // --- shoulders -----------------------------------------------------------
  [/lateral raise|shoulder press|overhead press|arnold|\bpress[\s-]*behind/i, ['shoulders']],

  // --- chest. Close-grip and dips are both honestly two-way. ---------------
  [/close[\s-]*grip bench/i, ['chest', 'triceps']],
  [/\bdip\b|\bdips\b/i, ['chest', 'triceps']],
  [/bench press|chest press|pec deck|\bfly\b|\bflye\b|push[\s-]*ups?\b/i, ['chest']],
  [/incline[a-z\s-]*press|decline[a-z\s-]*press/i, ['chest']],

  // --- rows, last: every more specific pull is already handled. ------------
  [/\brow\b|\brows\b/i, ['back']],
];

/**
 * The groups this name can honestly be filed under, or nothing.
 *
 * Nothing is not a failure. It means the table has never been taught this
 * movement, and a group invented from a name it cannot parse is worse data than
 * the blank it replaces.
 */
export function plausibleGroups(name) {
  const text = String(name ?? '').trim();
  if (!text) return [];

  for (const [pattern, groups] of MOVEMENT_GROUPS) {
    if (pattern.test(text)) return [...groups];
  }
  return [];
}

/**
 * Lifts whose group contradicts their name, or is missing where it need not be.
 *
 * Retired lifts are skipped: they are out of every picker, so correcting one
 * changes nothing he will ever see, and listing them buries the rows that
 * matter. `groupConfirmed` is how a disagreement is recorded — he looked, he
 * kept chest, and the row does not come back. Without that the only way to
 * silence a suggestion he rejects is to accept it.
 */
export function groupSuspects(exercises = []) {
  const found = [];

  for (const exercise of Array.isArray(exercises) ? exercises : []) {
    if (!exercise?.id || exercise.archived || exercise.groupConfirmed) continue;

    const groups = plausibleGroups(exercise.name);
    if (!groups.length) continue;

    const recorded = normaliseMuscleGroup(exercise.muscleGroup);
    if (recorded && groups.includes(recorded)) continue;

    found.push({
      id: exercise.id,
      name: String(exercise.name ?? exercise.id),
      recorded: recorded ?? null,
      suggested: groups[0],
      alternatives: groups.slice(1),
      reason: recorded ? 'contradicted' : 'missing',
    });
  }

  return found;
}

/* ------------------------- what the weight meant -------------------------- */

/**
 * Dumbbell lifts whose logged numbers were probably one bell, not the pair.
 *
 * The problem, from the live log: lateral raises recorded as 15, 17.5, 25, 30, 35 —
 * one dumbbell, which is the number painted on the thing you pick up. Incline
 * dumbbell press recorded as 140, 150, 170, 200 — the pair total, because no 200 lb
 * dumbbell exists. Same app, same week, two units, nothing recording which.
 *
 * This is deliberately **not** a guess that gets applied. It reads the numbers and
 * says which it thinks they are, and the conversion is a tap. `cleanup.js` already
 * carries the scar for inferring over data somebody entered: an automatic pass read
 * "Leg Extension (10x10)" as a machine called 10x10.
 *
 * The evidence it uses is what a human would use:
 *
 *   * **A number no dumbbell reaches.** Racks top out around 150 lb, so a logged
 *     200 is the pair, flatly. This is the strong signal and it goes first.
 *   * **A half-pound figure.** 17.5 and 27.5 are dumbbell markings; a pair total
 *     would be 35 or 55. Nobody loads a bar to 17.5.
 *   * **A number too light to be a pair** for the lift in question — 15 lb across
 *     two hands on a lateral raise is not a working set for somebody pressing 200.
 */

/** Above this, it cannot be one dumbbell. Commercial racks stop well short. */
const MAX_DUMBBELL = 150;

/** Lifts where the kit is a pair of dumbbells, by name. */
const PAIRED_DUMBBELL = /\b(dumbbell|dumbell|\bdb\b)\b/i;

/** ...except these, which are one bell held in both hands, or not dumbbells. */
const NOT_A_PAIR = /\bcable\b|goblet|overhead (dumbbell|db) tricep|pullover|\brdl\b.*smith/i;

export function looksPaired(exercise) {
  const name = String(exercise?.name ?? '');
  if (!PAIRED_DUMBBELL.test(name)) return false;
  if (NOT_A_PAIR.test(name)) return false;
  return true;
}

/**
 * Which lifts need the question asked, and what the numbers suggest.
 *
 * Only lifts with history: a lift with nothing logged has no numbers to misread,
 * and its unit is just a setting in the library.
 */
export function loadUnitSuspects(exercises = [], sessions = []) {
  const weights = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    for (const set of session?.sets ?? []) {
      const w = numeric(set?.weight);
      if (w === null || w <= 0) continue;
      if (!weights.has(set.exerciseId)) weights.set(set.exerciseId, []);
      weights.get(set.exerciseId).push(w);
    }
  }

  const found = [];

  for (const exercise of Array.isArray(exercises) ? exercises : []) {
    if (!exercise?.id || exercise.archived) continue;
    // Already answered, either way.
    if (exercise.entry === 'per-hand' || exercise.unitConfirmed) continue;
    if (!looksPaired(exercise)) continue;

    const logged = weights.get(exercise.id) ?? [];
    if (!logged.length) continue;

    const max = Math.max(...logged);
    const half = logged.some((w) => Math.abs(w * 2 - Math.round(w * 2)) < 1e-9 && !Number.isInteger(w));

    // Strongest first: a number no dumbbell reaches settles it on its own.
    if (max > MAX_DUMBBELL) {
      found.push({
        id: exercise.id,
        name: exercise.name,
        suggested: 'total',
        reason: `The heaviest set logged is ${max} lb, and no dumbbell goes that high — `
          + `so these were already the pair added together. Nothing needs changing.`,
        weights: logged,
      });
      continue;
    }

    if (half) {
      found.push({
        id: exercise.id,
        name: exercise.name,
        suggested: 'per-hand',
        reason: `Weights like ${logged.filter((w) => !Number.isInteger(w))[0]} lb are dumbbell `
          + `markings — a pair would come to a whole number, and nobody loads a bar to that. `
          + `These look like one bell, so the real load was double.`,
        weights: logged,
      });
      continue;
    }

    /**
     * No strong signal, so no recommendation.
     *
     * The first version guessed "one bell" whenever the numbers were under 150, and
     * got the incline dumbbell curl wrong: 70 lb is far likelier a pair at 35 each
     * than 70 in each hand. Knowing which needs a sense of how strong he is on that
     * particular movement, which is exactly the thing he has and this does not.
     *
     * A confident coin flip is worse than an honest question — he would have to
     * check each one anyway, and the wrong recommendation makes that harder, not
     * easier.
     */
    found.push({
      id: exercise.id,
      name: exercise.name,
      suggested: null,
      reason: `Logged at ${[...new Set(logged)].sort((a, b) => a - b).join(', ')} lb. `
        + `Nothing in the numbers settles whether that was one dumbbell or the pair — `
        + `you will know, and it changes what the trend is worth.`,
      weights: logged,
    });
  }

  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Rewrite one lift's history from per-bell numbers to totals.
 *
 * Only that lift's sets, and only the ones with a real weight: a bodyweight set
 * logged at 0 stays 0, because doubling nothing is still nothing and 0 is a real
 * load here. Sessions that change are marked dirty so the correction rides up on
 * the next sync, and untouched ones come back by identity so nothing is re-uploaded
 * for no reason.
 */
export function doubleLoggedWeights(sessions, exerciseId) {
  if (!Array.isArray(sessions) || !exerciseId) return sessions ?? [];

  return sessions.map((session) => {
    if (!Array.isArray(session?.sets)) return session;

    let touched = false;
    const sets = session.sets.map((set) => {
      if (set?.exerciseId !== exerciseId) return set;
      const w = numeric(set.weight);
      if (w === null || w <= 0) return set;
      touched = true;
      return { ...set, weight: Math.round(w * 2 * 100) / 100 };
    });

    return touched ? { ...session, sets, _dirty: true } : session;
  });
}

/* -------------------------------- machines -------------------------------- */

/** Words that say nothing about which machine it is. */
const FILLER = /^(the|a|machine|no|name|none|unnamed|gym)$/i;

/** How much of two labels has to agree before they are probably one machine. */
const SAME_MACHINE = 0.6;

const words = (label) =>
  new Set(
    String(label ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );

/**
 * Machine labels at one gym that look like two names for one machine.
 *
 * `rememberMachine` already folds case and spacing, but only **within one
 * lift's tally** — so the nameless machine at Naco became "Naco Machine (no
 * name)" against the calf raise and "Naco No name" against the abductor. Two
 * entries, one machine, and every count `predictMachine` reads split in half.
 *
 * Compared on shared words rather than edit distance, because the labels that
 * actually collide here are descriptions rather than typos. Filler is dropped
 * first, or every "... Machine" at a gym would match every other. This only
 * flags: merging two machines that are genuinely different would silently
 * average two stacks into one trend, which is the thing profiles exist to stop.
 */
export function machineSuspects(gym) {
  const labels = new Map();
  for (const tally of Object.values(gym?.machines ?? {})) {
    for (const label of Object.keys(tally ?? {})) {
      const clean = String(label ?? '').trim();
      if (clean) labels.set(clean.toLowerCase(), clean);
    }
  }

  const all = [...labels.values()];
  const found = [];

  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = [...words(all[i])].filter((w) => !FILLER.test(w));
      const b = [...words(all[j])].filter((w) => !FILLER.test(w));
      if (!a.length || !b.length) continue;

      const shared = a.filter((w) => b.includes(w)).length;
      const union = new Set([...a, ...b]).size;
      if (shared && shared / union >= SAME_MACHINE) {
        found.push({ names: [all[i], all[j]], overlap: Math.round((shared / union) * 100) / 100 });
      }
    }
  }

  return found;
}
