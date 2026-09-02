/**
 * How the session felt.
 *
 * A bad session has a cause, and the numbers alone never hold it. Hunger,
 * sleep, stress and soreness explain more day-to-day variance than programming
 * does, and they cost four taps to record while the answer is still fresh.
 *
 * Everything here is optional. A check-in that feels like a form gets skipped,
 * and a skipped check-in is worth less than none because it looks like data.
 */

/** Asked at the end of a session, in the order they matter. */
export const QUESTIONS = [
  { id: 'energy', label: 'Energy', low: 'drained', high: 'fresh' },
  { id: 'sleep', label: 'Slept', low: 'badly', high: 'well' },
  { id: 'hunger', label: 'Fuelled', low: 'empty', high: 'full' },
  { id: 'stress', label: 'Stress', low: 'calm', high: 'wired', inverted: true },
  { id: 'soreness', label: 'Soreness', low: 'none', high: 'sore', inverted: true },
];

export const SCALE = [1, 2, 3, 4, 5];

/** Below this, on a five-point scale, is a bad day. */
const POOR = 2;

const answered = (checkin) =>
  QUESTIONS.map((q) => [q, Number(checkin?.[q.id])]).filter(([, v]) => Number.isFinite(v) && v >= 1 && v <= 5);

export function isAnswered(checkin) {
  return answered(checkin).length > 0;
}

/**
 * One number for the whole check-in, 1 to 5.
 *
 * Stress and soreness run the other way — high is bad — so they are flipped
 * before averaging, or a stressful day would read as a good one.
 */
export function checkinScore(checkin) {
  const given = answered(checkin);
  if (!given.length) return null;

  const total = given.reduce((sum, [q, value]) => sum + (q.inverted ? 6 - value : value), 0);
  return Math.round((total / given.length) * 10) / 10;
}

/** The things that were bad enough to be worth naming. */
export function concerns(checkin) {
  return answered(checkin)
    .filter(([q, value]) => (q.inverted ? value >= 6 - POOR : value <= POOR))
    .map(([q]) => q.id);
}

/** A short readable line, or nothing if it was not filled in. */
export function describeCheckin(checkin) {
  if (!isAnswered(checkin)) return '';

  const bad = concerns(checkin);
  const score = checkinScore(checkin);

  if (!bad.length) return `Felt fine (${score}/5)`;

  const words = {
    energy: 'low energy', sleep: 'poor sleep', hunger: 'under-fuelled',
    stress: 'stressed', soreness: 'sore',
  };
  return `${bad.map((id) => words[id] ?? id).join(', ')} (${score}/5)`;
}

/**
 * Did the sessions that felt bad actually go worse?
 *
 * Compares volume on poor days against good ones. It reports a difference; it
 * does not claim a cause, because five sessions cannot support one.
 */
export function checkinEffect(sessions = [], { minEach = 2 } = {}) {
  const scored = sessions
    .filter((s) => isAnswered(s.checkin) && (s.sets ?? []).length)
    .map((s) => ({
      score: checkinScore(s.checkin),
      volume: s.sets.reduce((n, x) => n + (Number(x.weight) || 0) * (Number(x.reps) || 0), 0),
    }));

  const poor = scored.filter((s) => s.score <= 3);
  const good = scored.filter((s) => s.score > 3);

  if (poor.length < minEach || good.length < minEach) {
    return { hasSignal: false, sessionsScored: scored.length, message: '' };
  }

  const mean = (xs) => xs.reduce((a, b) => a + b.volume, 0) / xs.length;
  const poorMean = mean(poor);
  const goodMean = mean(good);
  const difference = Math.round(((poorMean - goodMean) / goodMean) * 100);

  return {
    hasSignal: true,
    sessionsScored: scored.length,
    poorSessions: poor.length,
    goodSessions: good.length,
    volumeDifference: difference,
    message:
      difference <= -10
        ? `Sessions you rated poorly carried ${Math.abs(difference)}% less volume than the rest. How you turn up is showing in the work.`
        : difference >= 10
          ? `Oddly, sessions you rated poorly carried ${difference}% more volume. Either the rating is harsh or you push harder on bad days.`
          : 'How a session felt has not made much difference to the work done.',
  };
}

/* ---------------------------- how a set felt ------------------------------ */

/**
 * A per-set score, unlike the check-in above, which covers the whole session.
 *
 * It exists because the notes kept reaching for it — "by lateral raises that
 * was the point in which hunger impeded me" is a position inside a workout that
 * the app gave nowhere to put. It is optional and always will be: logging is
 * one tap, and a prompt on every exercise is one you learn to dismiss unread.
 * Blank is the normal case, so blank must never be read as a score.
 */
export const FEEL_SCALE = [
  { value: 1, face: '😖', label: 'awful' },
  { value: 2, face: '😕', label: 'rough' },
  { value: 3, face: '😐', label: 'fine' },
  { value: 4, face: '🙂', label: 'good' },
  { value: 5, face: '💪', label: 'strong' },
];

/** The score on one set, or null. Never 0 — that is the absent case. */
export function feelOf(set) {
  const v = set?.feel;
  if (typeof v !== 'number' || !Number.isInteger(v)) return null;
  return v >= 1 && v <= 5 ? v : null;
}

/** exerciseId -> mean feel, for the lifts that were actually scored. */
export function feelByLift(session) {
  const totals = new Map();

  for (const set of session?.sets ?? []) {
    const value = feelOf(set);
    if (value === null) continue;

    const current = totals.get(set.exerciseId) ?? { sum: 0, n: 0 };
    totals.set(set.exerciseId, { sum: current.sum + value, n: current.n + 1 });
  }

  const out = new Map();
  for (const [id, { sum, n }] of totals) out.set(id, sum / n);
  return out;
}

/**
 * How one lift has been feeling lately, or null if it was never scored.
 *
 * `falling` needs at least two scored sessions and a real drop, because the
 * point of this is to catch a lift going sour *before* the numbers do — and a
 * direction called from one point is not a direction.
 */
export function liftFeel(sessions, exerciseId) {
  const scored = (sessions ?? [])
    .map((s) => ({ date: s?.date ?? s?.startedAt ?? '', value: feelByLift(s).get(exerciseId) }))
    .filter((s) => s.value !== undefined)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  if (!scored.length) return null;

  const values = scored.map((s) => s.value);
  const latest = values[values.length - 1];
  const average = values.reduce((a, b) => a + b, 0) / values.length;

  return {
    scored: values.length,
    latest,
    average: Math.round(average * 10) / 10,
    falling: values.length >= 2 && latest < values[0],
  };
}
