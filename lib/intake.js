/**
 * What the app asks a new person, as a record.
 *
 * The registration form already asks for height, age, sex and a body-fat range,
 * because those are what the resting-burn estimate needs. None of it says
 * anything about **lifting** — how long they have been doing it, how many days
 * a week they can actually show up, which group they care about, which
 * movements are off the table — so every new install got the same four-day
 * program and the first session prescribed a weight from nothing.
 *
 * This module's only job is turning whatever a form hands over into one record,
 * or saying precisely what is still missing. It decides nothing:
 * `experience.js` interprets the bucket and `prescribe.js` turns the record
 * into a split. The three are separate so a split can be tested against a
 * fixture instead of against a form.
 *
 * ## Zero is an answer. Blank is not.
 *
 * Somebody who does no cardio at all has told us something. Somebody who
 * skipped the question has not, and an estimate built on `0` for the second one
 * is a fabrication. This project shipped exactly that bug in the body-fat
 * field, where an empty box read as zero and the burn silently changed formula
 * with nothing on screen to say so. So every numeric field comes back `null`
 * when unanswered and `0` when answered with zero, and `numeric()` below is the
 * one place that distinction is made.
 *
 * ## Why the ranges refuse rather than clamp
 *
 * A clamp turns a typo into a plausible number — 1980 in the weight box becomes
 * 700 lb and the app carries on. A refusal names the field and hands it back.
 * The ranges are deliberately wide: they are there to catch a year typed into a
 * weight box, not to tell anybody they are an unusual size.
 */

import { EXPERIENCE_IDS } from './experience.js';
import { MUSCLE_GROUPS, normaliseMuscleGroup } from './exercises.js';

/** Sexes the resting-burn formula has a coefficient for. */
export const SEXES = ['male', 'female'];

/**
 * Every field, and what counts as an answer.
 *
 * A table rather than a function per field, so that adding a question is one
 * row and the required list, the normaliser and the gap report cannot drift
 * apart. `says` is what the screen shows when it is missing, written as the
 * thing to do rather than as the error.
 */
const FIELDS = [
  {
    name: 'weightLb',
    kind: 'number',
    required: true,
    min: 50,
    max: 700,
    says: 'Add your bodyweight — every prescribed weight starts from it.',
  },
  {
    name: 'heightInches',
    kind: 'number',
    required: true,
    min: 36,
    max: 96,
    says: 'Add your height, in inches.',
  },
  {
    name: 'age',
    kind: 'number',
    required: true,
    min: 13,
    max: 100,
    says: 'Add your age.',
  },
  {
    name: 'sex',
    kind: 'enum',
    required: true,
    values: SEXES,
    says: 'Choose male or female — it changes both the burn estimate and the starting weights.',
  },
  {
    name: 'experience',
    kind: 'enum',
    required: true,
    values: EXPERIENCE_IDS,
    says: 'Choose how long you have been lifting.',
  },
  {
    name: 'daysPerWeek',
    kind: 'number',
    required: true,
    min: 1,
    max: 7,
    says: 'Choose how many days a week you can train.',
  },
  {
    name: 'cardioSessions',
    kind: 'number',
    required: false,
    min: 0,
    max: 14,
    says: 'How many easy cardio sessions in a normal week?',
  },
  {
    name: 'cardioMinutes',
    kind: 'number',
    required: false,
    min: 0,
    max: 1500,
    says: 'How many minutes of easy cardio in a normal week?',
  },
  {
    name: 'stepsPerDay',
    kind: 'number',
    required: false,
    min: 0,
    max: 60000,
    says: 'Roughly how many steps on a normal day?',
  },
  {
    name: 'priority',
    kind: 'group',
    required: false,
    says: 'Is there a group you want the extra work to go to?',
  },
  {
    name: 'avoid',
    kind: 'list',
    required: false,
    says: 'Anything you would rather not do?',
  },
];

export const INTAKE_FIELDS = FIELDS.map((f) => f.name);
export const REQUIRED_FIELDS = FIELDS.filter((f) => f.required).map((f) => f.name);

/**
 * A number, or `null` for "not answered" — and `0` is answered.
 *
 * `Number('')` is 0 and `Number('  ')` is 0, which is the whole trap. Both are
 * caught before the coercion rather than after, because after it they are
 * indistinguishable from a real zero.
 */
function numeric(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value) {
  const s = String(value ?? '').trim();
  return s === '' ? null : s;
}

/** However the movements-to-avoid arrived: one list, no blanks, no repeats. */
function list(value) {
  const parts = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return [...new Set(parts.map((p) => text(p)).filter(Boolean))];
}

/** Whatever a form sent, as the record the rest of the onboarding reads. */
export function normaliseIntake(raw = {}) {
  const out = {};
  for (const field of FIELDS) {
    const value = raw?.[field.name];
    if (field.kind === 'number') out[field.name] = numeric(value);
    else if (field.kind === 'list') out[field.name] = list(value);
    else if (field.kind === 'group') out[field.name] = normaliseMuscleGroup(value);
    else out[field.name] = text(value)?.toLowerCase() ?? null;
  }
  return out;
}

/**
 * What is still missing or impossible, one entry per field.
 *
 * Every field is checked, not just the first — somebody who left four boxes
 * empty should see four, because being told one at a time is how a form takes
 * five attempts. This mirrors the gap report the profile screen already uses.
 *
 * `only` narrows it to the fields a particular caller actually needs.
 * `prescribe.js` reads it that way: a split depends on how many days somebody
 * can train and how long they have been lifting, and on nothing else. Demanding
 * a bodyweight before handing over a *program* would be the module asking for
 * something it does not use, and it would make the prescription unreachable for
 * anybody who has not filled in the body-metrics form — which on a phone with
 * no account is everybody.
 */
export function intakeGaps(record = {}, { only = null } = {}) {
  const wanted = only ? FIELDS.filter((f) => only.includes(f.name)) : FIELDS;

  const gaps = [];
  for (const field of wanted) {
    const value = record?.[field.name];

    if (field.kind === 'list') continue;

    const missing = value === null || value === undefined;
    if (missing) {
      if (field.required) gaps.push({ field: field.name, says: field.says });
      continue;
    }

    if (field.kind === 'number' && (value < field.min || value > field.max)) {
      gaps.push({ field: field.name, says: field.says });
      continue;
    }

    if (field.kind === 'enum' && !field.values.includes(value)) {
      gaps.push({ field: field.name, says: field.says });
      continue;
    }

    if (field.kind === 'group' && !MUSCLE_GROUPS.includes(value)) {
      gaps.push({ field: field.name, says: field.says });
    }
  }
  return gaps;
}

export function isIntakeComplete(record) {
  return intakeGaps(record).length === 0;
}
