/**
 * Turning the answers into a week.
 *
 * This was going to be an LLM call, and it is not one. The reason is worth
 * writing down, because the instinct to reach for a model here is a good one:
 * the questions are about *preference*, which is what models are for.
 *
 * But the question space is small and bounded — seven day counts, four
 * experience buckets, eleven muscle groups, and a list of movements somebody
 * would rather not do. Every combination can be enumerated, and a table that
 * can be enumerated can be **tested**: `prescribe.test.js` walks all 336 and
 * checks each produces a week somebody could actually train. A model call can
 * only be sampled. It also costs money per new user and needs a network on the
 * one screen where a person has least patience for one — and this app's first
 * rule is that it works with no signal.
 *
 * ## The slots are movement patterns, not exercise ids
 *
 * A day is a list of slots like "a horizontal press for chest, heavy", and the
 * concrete lift is chosen from the library at prescription time. That is what
 * makes "I would rather not deadlift" a **substitution** rather than a hole:
 * the hinge slot stays, and a Romanian deadlift fills it. `PROGRAM_SEED` names
 * exercise ids directly, which is right for a program somebody wrote by hand
 * and gives no way to do this.
 *
 * The slot vocabulary is `poses.js` — the same sixteen movements it already
 * classifies all 93 lifts into so a row can draw a figure doing it. One
 * taxonomy of movement in this app, reused, rather than two that drift apart.
 *
 * ## What the experience bucket changes
 *
 * Two things, and they follow from `experience.js` rather than being decided
 * again here. A beginner trains **fewer lifts per day**, because the first
 * month is about showing up and learning the movements rather than accumulating
 * volume. And a beginner gets **straight sets instead of reverse pyramid**: a
 * top set taken to failure is the whole premise of this app, and it is also the
 * one instruction somebody in their third month cannot follow safely, for
 * exactly the reason `experience.js` holds them at 2-3 reps in reserve.
 */

import { poseOf } from './poses.js';
import { MUSCLE_GROUPS } from './exercises.js';
import { intakeGaps } from './intake.js';
import { isBeginner, rirTargetFor, testWeekFor, bucketOf } from './experience.js';
import { PROGRAM_SEED } from './templates.js';

/**
 * The lifts a person who knows the difference already chose.
 *
 * Library order is not preference order, and the first draft of this module
 * discovered that the hard way: among hinges for hamstrings the library lists
 * the **good morning** first, so that is what got prescribed — as a heavy top
 * set taken to failure, which is a good way to hurt somebody. Nothing in the
 * schema was wrong, and no test caught it. Reading the prescription did.
 *
 * The fix is not a hand-written list of favourites in this file, which is the
 * hard-coding the rest of the module exists to avoid. `PROGRAM_SEED` is a week
 * written by hand for a real person, so the lifts it names *are* the staples,
 * and deriving the set keeps it in step with the seed instead of drifting from
 * it. Anything the seed does not mention falls back to library order, which is
 * fine for the accessory slots where it mostly happens.
 */
const STAPLES = new Set(
  PROGRAM_SEED.flatMap((program) => program.days ?? [])
    .flatMap((day) => day.exercises ?? [])
    .map((exercise) => exercise.exerciseId),
);

/** A day of fewer than this many lifts is not a training day. */
const MIN_PER_DAY = 3;

/**
 * The only answers a week actually depends on.
 *
 * Bodyweight, height, age and sex are what `norms.js` needs to estimate a
 * starting load. A *split* needs none of them, and refusing to hand over a
 * program until they are filled in would make the prescription unreachable for
 * anybody using the app without an account — which is how it has always been
 * usable. A module should refuse on the fields it reads and no others.
 */
export const PRESCRIPTION_NEEDS = ['experience', 'daysPerWeek'];

/**
 * [pose, muscle group, role, and optionally a muscle it must also hit].
 *
 * The group disambiguates a pose that two groups share — `pushdown` covers both
 * a tricep pushdown and a weighted dip, and only one of those belongs in a
 * triceps slot.
 *
 * `alsoHits` disambiguates *within* a group, and it exists for exactly one
 * case: `poses.js` classifies every lateral, front and rear raise as `raise`,
 * because they are the same shape to draw. They are not the same exercise. A
 * pull day wants rear delts, and the library already says which raises reach
 * them — `rear-delt-fly` and `face-pull` carry `secondary: ['back']` where a
 * lateral raise carries nothing. So the constraint reads existing data rather
 * than adding a second taxonomy or matching on names.
 */
const s = (pose, group, role, alsoHits = null) => ({ pose, group, role, alsoHits });

/**
 * What each kind of day asks for, in order.
 *
 * The order is the prescription: the first slots are the ones to be fresh for.
 * `role` drives both the scheme and the rest, and nothing downstream re-derives
 * it from position — a day template can put a light slot first if it ever needs
 * to without anything else having to agree.
 */
export const DAY_TEMPLATES = {
  full: {
    name: 'Full body',
    slots: [
      s('squat', 'quads', 'heavy'),
      s('bench', 'chest', 'heavy'),
      s('row', 'back', 'secondary'),
      s('hinge', 'hamstrings', 'secondary'),
      s('overhead', 'shoulders', 'light'),
      s('curl', 'biceps', 'light'),
    ],
  },
  'full-lite': {
    name: 'Full body',
    slots: [
      s('squat', 'quads', 'heavy'),
      s('bench', 'chest', 'heavy'),
      s('row', 'back', 'secondary'),
      s('hinge', 'hamstrings', 'secondary'),
    ],
  },
  upper: {
    name: 'Upper',
    slots: [
      s('bench', 'chest', 'heavy'),
      s('row', 'back', 'heavy'),
      s('overhead', 'shoulders', 'secondary'),
      s('pulldown', 'back', 'secondary'),
      s('curl', 'biceps', 'light'),
      s('pushdown', 'triceps', 'light'),
    ],
  },
  'upper-lite': {
    name: 'Upper',
    slots: [
      s('bench', 'chest', 'heavy'),
      s('row', 'back', 'heavy'),
      s('overhead', 'shoulders', 'secondary'),
      s('curl', 'biceps', 'light'),
    ],
  },
  lower: {
    name: 'Lower',
    slots: [
      s('squat', 'quads', 'heavy'),
      s('hinge', 'hamstrings', 'heavy'),
      s('legext', 'quads', 'secondary'),
      s('legcurl', 'hamstrings', 'secondary'),
      s('calf', 'calves', 'light'),
      s('core', 'core', 'light'),
    ],
  },
  'lower-lite': {
    name: 'Lower',
    slots: [
      s('squat', 'quads', 'heavy'),
      s('hinge', 'hamstrings', 'heavy'),
      s('legcurl', 'hamstrings', 'secondary'),
      s('calf', 'calves', 'light'),
    ],
  },
  push: {
    name: 'Push',
    slots: [
      s('bench', 'chest', 'heavy'),
      s('overhead', 'shoulders', 'heavy'),
      s('fly', 'chest', 'secondary'),
      s('raise', 'shoulders', 'light'),
      s('pushdown', 'triceps', 'light'),
    ],
  },
  pull: {
    name: 'Pull',
    slots: [
      s('row', 'back', 'heavy'),
      s('pulldown', 'back', 'heavy'),
      s('shrug', 'back', 'secondary'),
      // Rear delts, which a push day's lateral raise does not reach and which
      // nothing else in the week trains directly. `alsoHits` is what keeps this
      // from being filled by another lateral raise.
      s('raise', 'shoulders', 'light', 'back'),
      s('curl', 'biceps', 'light'),
    ],
  },
  legs: {
    name: 'Legs',
    slots: [
      s('squat', 'quads', 'heavy'),
      s('hinge', 'hamstrings', 'heavy'),
      s('legext', 'quads', 'secondary'),
      s('legcurl', 'hamstrings', 'secondary'),
      s('calf', 'calves', 'light'),
    ],
  },
  'arms-core': {
    name: 'Arms & core',
    slots: [
      s('curl', 'biceps', 'secondary'),
      s('pushdown', 'triceps', 'secondary'),
      s('raise', 'shoulders', 'light'),
      s('core', 'core', 'light'),
      s('calf', 'calves', 'light'),
    ],
  },
};

/**
 * Every week this app will prescribe, one row per (day count, beginner or not).
 *
 * A beginner is never given push/pull/legs. Not because it does not work, but
 * because it trains each movement once a week, and somebody learning the
 * movements needs the repetitions more than they need the volume per session.
 * So beginners get full body up to three days and an upper/lower alternation
 * above that, which keeps every pattern at twice a week.
 */
export const SPLITS = [
  { id: 'beginner-full-1', daysPerWeek: 1, forBeginner: true, name: 'Full body', days: ['full-lite'] },
  { id: 'beginner-full-2', daysPerWeek: 2, forBeginner: true, name: 'Full body twice', days: ['full-lite', 'full-lite'] },
  { id: 'beginner-full-3', daysPerWeek: 3, forBeginner: true, name: 'Full body three times', days: ['full-lite', 'full-lite', 'full-lite'] },
  {
    id: 'beginner-ul-4',
    daysPerWeek: 4,
    forBeginner: true,
    name: 'Upper / lower',
    days: ['upper-lite', 'lower-lite', 'upper-lite', 'lower-lite'],
  },
  {
    id: 'beginner-ul-5',
    daysPerWeek: 5,
    forBeginner: true,
    name: 'Upper / lower, plus a full day',
    days: ['upper-lite', 'lower-lite', 'upper-lite', 'lower-lite', 'full-lite'],
  },
  {
    id: 'beginner-ul-6',
    daysPerWeek: 6,
    forBeginner: true,
    name: 'Upper / lower, three times each',
    days: ['upper-lite', 'lower-lite', 'upper-lite', 'lower-lite', 'upper-lite', 'lower-lite'],
  },
  {
    id: 'beginner-ul-7',
    daysPerWeek: 7,
    forBeginner: true,
    name: 'Upper / lower, and one easy day',
    days: ['upper-lite', 'lower-lite', 'upper-lite', 'lower-lite', 'upper-lite', 'lower-lite', 'arms-core'],
  },

  { id: 'full-1', daysPerWeek: 1, forBeginner: false, name: 'Full body', days: ['full'] },
  { id: 'ul-2', daysPerWeek: 2, forBeginner: false, name: 'Upper / lower', days: ['upper', 'lower'] },
  { id: 'ppl-3', daysPerWeek: 3, forBeginner: false, name: 'Push / pull / legs', days: ['push', 'pull', 'legs'] },
  {
    id: 'ul-4',
    daysPerWeek: 4,
    forBeginner: false,
    name: 'Upper / lower, twice each',
    days: ['upper', 'lower', 'upper', 'lower'],
  },
  {
    id: 'ppl-ul-5',
    daysPerWeek: 5,
    forBeginner: false,
    name: 'Push / pull / legs, then upper / lower',
    days: ['push', 'pull', 'legs', 'upper', 'lower'],
  },
  {
    id: 'ppl-6',
    daysPerWeek: 6,
    forBeginner: false,
    name: 'Push / pull / legs, twice each',
    days: ['push', 'pull', 'legs', 'push', 'pull', 'legs'],
  },
  {
    id: 'ppl-7',
    daysPerWeek: 7,
    forBeginner: false,
    name: 'Push / pull / legs, twice, and an arms day',
    days: ['push', 'pull', 'legs', 'push', 'pull', 'legs', 'arms-core'],
  },
];

/** What a slot's role is worth, in scheme and in rest. */
const PRESCRIPTION = {
  // Reverse pyramid, which is what this app is.
  standard: {
    heavy: { schemeId: 'rp-3', restSeconds: 210 },
    secondary: { schemeId: 'rp-2', restSeconds: 180 },
    light: { schemeId: 'high-rep-2', restSeconds: 90 },
  },
  // Straight sets, because a top set to failure is not a beginner's instruction.
  beginner: {
    heavy: { schemeId: 'straight-3', restSeconds: 180 },
    secondary: { schemeId: 'straight-3', restSeconds: 150 },
    light: { schemeId: 'flat-4', restSeconds: 90 },
  },
};

const MACHINE_BARS = new Set(['none', 'none-total']);

/** The split for these answers, or `null` if the day count is not a week. */
export function splitFor(record) {
  const days = Number(record?.daysPerWeek);
  if (!Number.isInteger(days) || days < 1 || days > 7) return null;
  const beginner = isBeginner(record?.experience);
  return SPLITS.find((sp) => sp.daysPerWeek === days && sp.forBeginner === beginner) ?? null;
}

/**
 * Rank the lifts that could fill a slot.
 *
 * Preference, then library order, and nothing random: the same answers have to
 * prescribe the same week every time, or a person who reloads the screen gets a
 * different program and no way to tell which one was real.
 */
function candidatesFor(slot, { exercises, avoid, preferMachines }) {
  const ranked = exercises
    .map((exercise, index) => ({ exercise, index }))
    .filter(({ exercise }) => !exercise.archived)
    .filter(({ exercise }) => !avoid.has(exercise.id))
    .filter(({ exercise }) => poseOf(exercise) === slot.pose)
    .filter(({ exercise }) => exercise.muscleGroup === slot.group)
    .filter(({ exercise }) => !slot.alsoHits || (exercise.secondary ?? []).includes(slot.alsoHits));

  const equipment = ({ exercise }) => {
    if (preferMachines) return MACHINE_BARS.has(exercise.barType) ? 0 : 1;
    // A heavy slot is the one to put a bar in; a light slot is usually a cable.
    if (slot.role === 'heavy') return MACHINE_BARS.has(exercise.barType) ? 1 : 0;
    return 0;
  };

  const staple = ({ exercise }) => (STAPLES.has(exercise.id) ? 0 : 1);

  return ranked
    .sort((a, b) => equipment(a) - equipment(b) || staple(a) - staple(b) || a.index - b.index)
    .map(({ exercise }) => exercise);
}

/**
 * Pick one, rotating by how many times this template has already appeared.
 *
 * Push 1 and Push 2 are the same template, and prescribing the same five lifts
 * twice would be a worse week than the hand-written seed, which deliberately
 * varies them. Rotating through the ranked list by occurrence gives the
 * variation without giving up determinism.
 *
 * **A beginner is not rotated**, and the first draft of this module got that
 * backwards: it prescribed a back squat, a front squat and a goblet squat in
 * one week to somebody in month two. The entire argument for giving a beginner
 * full body three times a week is that they meet each movement three times —
 * rotating the lift throws away the one thing the split was chosen for. So
 * `occurrence` arrives as nought for them and their repeated days are
 * deliberately identical.
 */
function pick(candidates, { occurrence, used }) {
  if (!candidates.length) return null;
  for (let step = 0; step < candidates.length; step += 1) {
    const chosen = candidates[(occurrence + step) % candidates.length];
    if (!used.has(chosen.id)) return chosen;
  }
  return null;
}

/**
 * The lift that gets the extra work when somebody names a priority group.
 *
 * An accessory, deliberately: this is a seventh lift on a day that already has
 * six, and the first draft filled it with an incline barbell press at ninety
 * seconds rest. That is volume nobody recovers from. A barbell goes last.
 */
function extraFor(group, { exercises, avoid, used }) {
  if (!group || !MUSCLE_GROUPS.includes(group)) return null;
  const candidates = exercises
    .map((exercise, index) => ({ exercise, index }))
    .filter(({ exercise }) => !exercise.archived && !avoid.has(exercise.id))
    .filter(({ exercise }) => exercise.muscleGroup === group && !used.has(exercise.id));

  const heavyBar = ({ exercise }) => (exercise.barType === 'olympic' || exercise.barType === 'trap' ? 1 : 0);

  return candidates.sort((a, b) => heavyBar(a) - heavyBar(b) || a.index - b.index)[0]?.exercise ?? null;
}

/**
 * The whole week, or `null`.
 *
 * `null` for an incomplete record, because a program built on a guessed
 * bodyweight is worse than no program — and `null` when any day comes out
 * under three lifts, because that is not a training day and shipping one would
 * look like the app had broken rather than like the answers were too narrow.
 */
export function prescribe(record, { exercises = [], answers = {} } = {}) {
  if (intakeGaps(record, { only: PRESCRIPTION_NEEDS }).length) return null;

  const split = splitFor(record);
  if (!split) return null;

  const beginner = isBeginner(record.experience);
  const avoid = new Set(record.avoid ?? []);
  const preferMachines = beginner && answers?.coached === false;
  const table = beginner ? PRESCRIPTION.beginner : PRESCRIPTION.standard;

  const seen = new Map();
  const dropped = [];

  const days = split.days.map((key) => {
    const template = DAY_TEMPLATES[key];
    const appearance = seen.get(key) ?? 0;
    seen.set(key, appearance + 1);
    // A beginner meets the same lifts every time; see `pick`.
    const occurrence = beginner ? 0 : appearance;

    const used = new Set();
    const chosen = [];

    for (const slot of template.slots) {
      const exercise = pick(candidatesFor(slot, { exercises, avoid, preferMachines }), { occurrence, used });
      if (!exercise) {
        dropped.push(`${template.name}: nothing left for the ${slot.pose} slot`);
        continue;
      }
      used.add(exercise.id);
      chosen.push({ exercise, slot });
    }

    // `appearance` names the day; `occurrence` chose its lifts, and for a
    // beginner those are deliberately not the same number.
    return { key, template, appearance, used, chosen };
  });

  // The priority group gets one more lift on every day that already trains it,
  // so it scales with how often that day comes round. If no day trains it, the
  // shortest day takes it — being asked for calves should add calves even to a
  // week that had none.
  const priority = record.priority;
  if (priority) {
    const trains = days.filter((d) => d.chosen.some(({ exercise }) => exercise.muscleGroup === priority));
    const shortest = [...days].sort((a, b) => a.chosen.length - b.chosen.length)[0];
    for (const day of trains.length ? trains : shortest ? [shortest] : []) {
      const extra = extraFor(priority, { exercises, avoid, used: day.used });
      if (!extra) continue;
      day.used.add(extra.id);
      day.chosen.push({ exercise: extra, slot: s(poseOf(extra), priority, 'light') });
    }
  }

  if (days.some((d) => d.chosen.length < MIN_PER_DAY)) return null;

  // Number a day only when its template appears more than once, so a two-day
  // week says "Upper" and a four-day week says "Upper 1".
  const totals = new Map();
  for (const key of split.days) totals.set(key, (totals.get(key) ?? 0) + 1);

  const out = days.map((day) => {
    const repeated = totals.get(day.key) > 1;
    const name = repeated ? `${day.template.name} ${day.appearance + 1}` : day.template.name;
    return {
      id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      name,
      exercises: day.chosen.map(({ exercise, slot }) => ({
        exerciseId: exercise.id,
        schemeId: table[slot.role].schemeId,
        restSeconds: table[slot.role].restSeconds,
      })),
    };
  });

  return {
    id: `prescribed-${split.id}`,
    name: split.name,
    daysPerWeek: split.daysPerWeek,
    days: out,
    rirTarget: rirTargetFor(record.experience),
    testWeek: testWeekFor(record.experience),
    notes: notesFor({ record, split, beginner, preferMachines, dropped }),
  };
}

/**
 * Why the week looks like this, in sentences.
 *
 * The screen needs these because a program that arrives without a reason reads
 * as arbitrary, and somebody who thinks it is arbitrary edits it on day one.
 */
function notesFor({ record, split, beginner, preferMachines, dropped }) {
  const notes = [`${split.daysPerWeek} ${split.daysPerWeek === 1 ? 'day' : 'days'} a week: ${split.name.toLowerCase()}.`];

  const rir = rirTargetFor(record.experience);
  const bucket = bucketOf(record.experience);
  notes.push(
    rir.low === 0
      ? 'Top sets go to within a rep of failure, which is where the work happens.'
      : `Top sets stop ${rir.low}-${rir.high} reps short of failure while you learn what a hard set feels like.`,
  );

  if (beginner) {
    notes.push('Straight sets rather than reverse pyramid for now — the same weight across sets, so the movement is what you are learning.');
  }
  if (bucket) notes.push(`Built for ${bucket.label.toLowerCase()} of training.`);
  if (preferMachines) {
    notes.push('Leading with machines, since nobody has shown you the barbell lifts yet — they are easier to get right alone.');
  }
  if (record.priority) {
    notes.push(`One extra ${record.priority} lift on every day that already trains ${record.priority}.`);
  }
  if ((record.avoid ?? []).length) {
    notes.push('Movements you ruled out are replaced by another lift in the same pattern, not dropped.');
  }
  for (const note of dropped) notes.push(note);

  return notes;
}
