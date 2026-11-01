/**
 * A line about one lift in one session — and what it may and may not be used for.
 *
 * "Close grip." "Lower back pad." "More stretch at the bottom." These are the
 * things that explain a number six weeks later, and nothing in the app could
 * hold them: the session check-in is about the whole workout, and the bug
 * reporter is about the app.
 *
 * ## The key is (session, exercise, occurrence)
 *
 * Not a slot id. A lift swapped in mid-session has no slot, and a lift can
 * legitimately recur inside one workout — a top set early and a back-off at the
 * end are the same `exerciseId` twice, and a note on one is not a note on the
 * other. Migration 008 had to drop a uniqueness constraint for exactly this.
 *
 * ## The vocabulary is open
 *
 * A fixed list was tried and rejected on the first real import: "close grip" and
 * "lower back pad" were not on it, and neither is "more stretch at the bottom",
 * which is the same kind of thing. So a label is whatever was typed, folded for
 * case and spacing, and the app learns the vocabulary from use. `labelsFrom`
 * returns nothing for an empty log rather than seeding suggestions, because
 * offering labels nobody has used is how a fixed list gets reinvented.
 *
 * ## A label is a filter, not a covariate
 *
 * This is the load-bearing one. "Sets labelled more-ROM trend 3% worse" over
 * five sessions is the false-trend problem the bodyweight slope already solved,
 * with a 14-reading floor and a slope-exceeds-twice-its-own-standard-error test.
 *
 * So this module will tell you **which sessions carry a label** and **how many**,
 * and it offers no slope, no percentage and no comparison at any sample size.
 * `enoughToCompare` is permission to put two marked series on one chart and look
 * at them; it is not a verdict, and there is deliberately no function here that
 * would produce one. A second trend line fitted to five labelled sessions would
 * report a finding on flat data most of the time.
 */

/** Folded for case and surrounding space, so "Close Grip " and "close grip" are one. */
const fold = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The composed identity of a note.
 *
 * `occurrence` is 1-based and defaults to the first, because the overwhelming
 * majority of lifts happen once in a session and making every caller pass a 1
 * is how a 0 eventually gets passed instead.
 */
export const LIFT_NOTE_PREFIX = 'lift';

export function noteKey(sessionId, exerciseId, occurrence = 1) {
  const n = Math.max(1, Math.round(Number(occurrence) || 1));
  return `${LIFT_NOTE_PREFIX}::${sessionId}::${exerciseId}::${n}`;
}

/**
 * Is this one of ours?
 *
 * Lift notes share the store, the sync payload and the `notes` table with bug
 * reports, because that channel already works end to end and a second one would
 * be a second thing to keep in step. The id prefix is what tells them apart —
 * **not** a `kind` field, because the table has no column for one and it would
 * be lost the first time a note came back down from the cloud.
 *
 * The bug list in Setup filters on this. Without it, every note about a lift
 * would appear there as something the app did wrong.
 */
export function isLiftNote(note) {
  return String(note?.id ?? '').startsWith(`${LIFT_NOTE_PREFIX}::`);
}

/** A note, ready to store. `_dirty` because it must survive with no signal. */
export function makeNote({ sessionId, exerciseId, occurrence = 1, text, now = new Date() }) {
  const n = Math.max(1, Math.round(Number(occurrence) || 1));
  return {
    id: noteKey(sessionId, exerciseId, n),
    sessionId,
    exerciseId,
    occurrence: n,
    text: String(text ?? '').trim(),
    // Human-readable, for the cloud and for anybody reading the table directly.
    // The machine-readable key is the id.
    context: `${exerciseId} · occurrence ${n}`,
    createdAt: now.toISOString(),
    _dirty: true,
  };
}

/**
 * Write a note, replacing any note on the same lift in the same session.
 *
 * An empty note is not a note: clearing the text removes it, rather than leaving
 * a blank row on the history screen and a blank entry in the vocabulary. Never
 * mutates its input, because two render paths read the same array.
 */
export function upsertNote(notes, note) {
  const all = (Array.isArray(notes) ? notes : []).filter((n) => n?.id !== note.id);
  if (!note.text) return all;
  return [...all, note];
}

/** The note on one lift in one session, or null. */
export function noteFor(notes, sessionId, exerciseId, occurrence = 1) {
  const id = noteKey(sessionId, exerciseId, occurrence);
  return (Array.isArray(notes) ? notes : []).find((n) => n?.id === id) ?? null;
}

/** Every note ever written about one lift, oldest first. */
export function notesForExercise(notes, exerciseId) {
  return (Array.isArray(notes) ? notes : [])
    .filter((n) => n?.exerciseId === exerciseId && n?.text)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/**
 * The labels in one note.
 *
 * Split on commas, because that is how somebody writes two things in one box.
 * A note with no comma is one label — "more stretch at the bottom" is a label,
 * not five words to index separately.
 */
export function labelsOf(text) {
  return String(text ?? '')
    .split(',')
    .map(fold)
    .filter(Boolean);
}

/** Every label used, most used first. Empty for an empty log, deliberately. */
export function labelsFrom(notes) {
  const counts = new Map();

  for (const note of (Array.isArray(notes) ? notes : [])) {
    for (const label of labelsOf(note?.text)) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([label, uses]) => ({ label, uses }))
    .sort((a, b) => b.uses - a.uses || a.label.localeCompare(b.label));
}

/** Which sessions carried this label on this lift. Ids, not a trend. */
export function sessionsWithLabel(notes, exerciseId, label) {
  const wanted = fold(label);
  const ids = new Set();

  for (const note of (Array.isArray(notes) ? notes : [])) {
    if (note?.exerciseId !== exerciseId) continue;
    if (labelsOf(note?.text).includes(wanted)) ids.add(note.sessionId);
  }
  return [...ids];
}

/** Enough labelled sessions on both sides to be worth looking at two series. */
const MIN_EACH_SIDE = 14;

/**
 * How thin a label is, and whether two series are worth drawing.
 *
 * Returns no slope, no percentage and no comparison — at any sample size. That
 * is the point: `enoughToCompare` is permission to *look*, and the honest first
 * version marks the labelled sessions on the chart that already exists.
 */
export function labelCoverage(notes, exerciseId, label, totalSessions = 0) {
  const labelled = sessionsWithLabel(notes, exerciseId, label).length;
  const total = Math.max(0, Math.round(Number(totalSessions) || 0));
  const unlabelled = Math.max(0, total - labelled);

  return {
    label: fold(label),
    labelled,
    unlabelled,
    total,
    enoughToCompare: labelled >= MIN_EACH_SIDE && unlabelled >= MIN_EACH_SIDE,
  };
}
