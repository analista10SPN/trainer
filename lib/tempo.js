/**
 * Tempo: how long the weight takes to move.
 *
 * The variable the log was missing. Two sets at 200 lb for 8 reps are the same
 * row in history and completely different work if one was four seconds down and
 * the other was a bounce — and the bounce is how a weight gets moved that
 * should not be. Without tempo, "same weight, fewer reps" and "same weight,
 * faster reps" look identical, and only the second is a warning.
 *
 * Notation is eccentric-pause-concentric in seconds: `4-1-1` is four seconds
 * down, a one second hold, one second up. The fourth number of the usual
 * four-part notation (the pause at the top) is deliberately not collected —
 * nobody records it honestly mid-set, and a field that gets guessed at is worse
 * than one that does not exist.
 */

import { numeric } from './strength.js';

/** Slowest first: the list is read top-down while standing at the machine. */
export const TEMPO_PRESETS = [
  { ecc: 4, pause: 1, con: 1, label: 'Slow negative + hold' },
  { ecc: 4, pause: 0, con: 1, label: 'Slow negative' },
  { ecc: 3, pause: 0, con: 1, label: 'Controlled' },
  { ecc: 2, pause: 0, con: 1, label: 'Standard' },
  { ecc: 1, pause: 0, con: 1, label: 'Explosive' },
];

/** Beyond these a number is a slipped keypress, not a tempo. */
const MAX_SECONDS = 15;

/**
 * Read `4-1-1`, or `4-1` meaning no pause, or null.
 *
 * Two-part is accepted because "four second negative, one second positive" is
 * how it gets said out loud, and making him type a zero he does not mean is how
 * a field stops being used.
 */
export function parseTempo(value) {
  if (typeof value !== 'string') return null;

  const parts = value.trim().split('-');
  if (parts.length !== 2 && parts.length !== 3) return null;

  const nums = parts.map((p) => numeric(p.trim()));
  if (nums.some((n) => n === null || n < 0 || n > MAX_SECONDS || !Number.isInteger(n))) return null;

  const [ecc, pause, con] = parts.length === 3 ? nums : [nums[0], 0, nums[1]];

  // A rep takes time. All zeroes is a typo, not a tempo.
  if (ecc + pause + con <= 0) return null;

  return { ecc, pause, con };
}

export function formatTempo(t) {
  if (!t) return '';
  return `${t.ecc}-${t.pause}-${t.con}`;
}

/** Words as well as digits: "4-1-1" means nothing read cold. */
export function describeTempo(t) {
  if (!t) return '';
  const bits = [`${t.ecc}s down`];
  if (t.pause > 0) bits.push(`${t.pause}s hold`);
  bits.push(`${t.con}s up`);
  return bits.join(' · ');
}

/** The tempo on one set, or null. Never a default — absent is a real answer. */
export function tempoOf(set) {
  return parseTempo(set?.tempo ?? null);
}

/**
 * Seconds of work in a set: reps times the length of one rep.
 *
 * The honest way to compare across tempos — 8 reps at 4-0-1 is 40 seconds and
 * 8 reps at 1-0-1 is 16, which is why they are not the same set. Null rather
 * than 0 when either half is missing, because 0 would read as no work done and
 * drag every average built from it.
 */
export function timeUnderTension(set) {
  const t = tempoOf(set);
  const reps = numeric(set?.reps);
  if (!t || reps === null || reps <= 0) return null;

  return reps * (t.ecc + t.pause + t.con);
}

/* -------------------------- what he usually does -------------------------- */

/** Every tempo recorded against one lift, oldest session first. */
function tempoSessions(sessions, exerciseId) {
  return (sessions ?? [])
    .map((s) => {
      const tempos = (s?.sets ?? [])
        .filter((x) => x.exerciseId === exerciseId)
        .map(tempoOf)
        .filter(Boolean);
      return { date: s?.date ?? s?.startedAt ?? '', tempos };
    })
    .filter((s) => s.tempos.length)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/**
 * The tempo to pre-fill, as a `4-1-1` string, or null.
 *
 * Most-used rather than most-recent, for the same reason the machine
 * prediction is: one session done fast because the gym was closing should not
 * become what the app expects from then on.
 */
export function usualTempo(sessions, exerciseId) {
  const counts = new Map();

  for (const s of tempoSessions(sessions, exerciseId)) {
    for (const t of s.tempos) {
      const key = formatTempo(t);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  let best = null;
  let bestCount = 0;
  for (const [key, n] of counts) {
    if (n > bestCount) { best = key; bestCount = n; }
  }
  return best;
}

/**
 * Is the eccentric getting shorter on this lift?
 *
 * The single most useful thing tempo buys. A weight that holds while the
 * negative collapses from four seconds to one is not the same weight being
 * lifted — it is a heavier weight being dropped, and no rep count shows it.
 *
 * Only a *shortening* eccentric counts. Going from 2s to 4s is doing it better,
 * and flagging that would teach him to ignore the flag.
 */
export function tempoDrift(sessions, exerciseId) {
  const none = { drifting: false, from: null, to: null, sessions: 0 };

  const scored = tempoSessions(sessions, exerciseId);
  if (scored.length < 2) return { ...none, sessions: scored.length };

  // The slowest eccentric of a session is the honest one: the top set is where
  // tempo goes first, and taking the mean would hide it behind the backoffs.
  const eccentrics = scored.map((s) => Math.max(...s.tempos.map((t) => t.ecc)));

  const from = eccentrics[0];
  const to = eccentrics[eccentrics.length - 1];

  return {
    drifting: to < from,
    from,
    to,
    sessions: scored.length,
  };
}
