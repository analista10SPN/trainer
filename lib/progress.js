/**
 * Progress across everything, not one lift at a time.
 *
 * Per-lift verdicts go quiet when training is varied: swap a machine and the
 * new variant has one session, which is never enough to say anything. After two
 * weeks of real use the coach could speak about exactly one lift out of
 * twenty-nine.
 *
 * The fix is not a lower threshold — it is asking a different question. How is
 * everything moving, together?
 *
 * Loads are not comparable across lifts, let alone across two cable stacks, so
 * nothing here averages raw weight. Each lift is indexed against its own first
 * session and the *rates* are combined, which is a fair comparison between a
 * 400 lb leg press and a 20 lb lateral raise.
 */

import { bestPreciseE1RM, totalVolume, percentSlope } from './strength.js';
import { familyOf } from './exercises.js';

const round1 = (x) => Math.round(x * 10) / 10;

/** Enough points to draw a line through. */
export const MIN_POINTS = 2;

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : round1((sorted[mid - 1] + sorted[mid]) / 2);
};

/**
 * One lift's e1RM, expressed as a percentage of where it started.
 *
 * This is what makes lifts addable: a leg press and a lateral raise both start
 * at 100 and the question becomes how fast each is moving, not how heavy it is.
 */
export function indexedSeries(history = []) {
  const raw = history.map((session) => bestPreciseE1RM(session.sets)).filter((v) => v > 0);
  if (!raw.length) return [];
  const first = raw[0];
  return raw.map((v) => round1((v / first) * 100));
}

/** Every session that happened, with what was lifted in it. */
export function volumeOverTime(sessions = []) {
  return sessions
    .filter((s) => (s.sets ?? []).length)
    .map((s) => ({
      date: String(s.startedAt).slice(0, 10),
      dayName: s.dayName ?? 'Workout',
      volume: Math.round(totalVolume(s.sets)),
      sets: s.sets.length,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Sessions and sets per week, over the period actually trained. */
export function trainingLoad(sessions = []) {
  const dated = sessions
    .filter((s) => s.startedAt)
    .map((s) => String(s.startedAt).slice(0, 10))
    .sort();

  if (dated.length < 2) {
    return { sessions: dated.length, weeks: 0, sessionsPerWeek: null, setsPerWeek: null };
  }

  const days = Math.max(1, (new Date(dated.at(-1)) - new Date(dated[0])) / 86400000);
  const weeks = Math.max(1, days / 7);
  const sets = sessions.reduce((n, s) => n + (s.sets?.length ?? 0), 0);

  return {
    sessions: dated.length,
    weeks: round1(weeks),
    sessionsPerWeek: round1(dated.length / weeks),
    setsPerWeek: Math.round(sets / weeks),
  };
}

/**
 * A movement read across its variants.
 *
 * Two cable stacks cannot be added, but their rates of change can. A movement
 * trained on three machines has three sparse histories and one clear direction.
 */
export function analyzeFamily(family, historyFor) {
  const members = (family.members ?? [])
    .map((m) => ({ exercise: m, history: historyFor(m.id) ?? [] }))
    .filter((m) => m.history.length);

  const rates = members
    .map((m) => indexedSeries(m.history))
    .filter((series) => series.length >= MIN_POINTS)
    .map((series) => percentSlope(series));

  const sessionCount = members.reduce((n, m) => n + m.history.length, 0);

  return {
    id: family.id,
    name: family.name,
    variants: members.length,
    sessionCount,
    percentPerSession: rates.length ? median(rates) : null,
    // A movement with plenty of sessions spread thinly across machines still
    // has something to say, which is exactly the case this exists for.
    hasTrend: rates.length > 0,
  };
}

/**
 * The headline. How is training going, taken as a whole?
 *
 * @param items       [{ exerciseId, name, history }]
 * @param sessions    every logged session
 * @param exercises   the library, for grouping variants into movements
 */
export function overallProgress({ items = [], sessions = [], exercises = [] } = {}) {
  const byId = new Map(exercises.map((e) => [e.id, e]));

  const rates = [];
  let improving = 0;
  let flat = 0;
  let declining = 0;

  for (const item of items) {
    const series = indexedSeries(item.history);
    if (series.length < MIN_POINTS) continue;

    const rate = percentSlope(series);
    rates.push(rate);
    if (rate >= 1) improving++;
    else if (rate <= -1) declining++;
    else flat++;
  }

  const volume = volumeOverTime(sessions);
  const volumeSeries = volume.map((v) => v.volume);
  const volumeTrend = volumeSeries.length >= MIN_POINTS ? percentSlope(volumeSeries) : null;
  const load = trainingLoad(sessions);

  // Distinct movements, so swapping machines does not read as variety.
  const movements = new Set(
    items.map((i) => familyOf(byId.get(i.exerciseId) ?? { id: i.exerciseId })),
  );

  const rate = rates.length ? median(rates) : null;
  let status = 'insufficient-data';
  if (rate !== null) {
    if (rate > 6) status = 'too-fast';
    else if (rate >= 1) status = 'progressing';
    else if (rate > -1) status = 'stagnant';
    else status = 'regressing';
  }

  return {
    status,
    percentPerSession: rate,
    liftsTracked: items.length,
    liftsWithTrend: rates.length,
    movements: movements.size,
    improving,
    flat,
    declining,
    volume,
    volumeTrend,
    ...load,
    message: overallMessage({ status, rate, improving, flat, declining, volumeTrend, load, items }),
  };
}

function overallMessage({ status, rate, improving, flat, declining, volumeTrend, load, items }) {
  if (status === 'insufficient-data') {
    return items.length
      ? `${items.length} lifts logged, but none yet has two sessions to compare. Repeat a few and this fills in.`
      : 'Nothing logged yet.';
  }

  const direction = {
    progressing: `Training is moving forward, around ${rate}% per session across your lifts.`,
    stagnant: `Overall you are flat, about ${rate}% per session. Not losing ground, not gaining it either.`,
    regressing: `Overall trend is down, about ${rate}% per session across your lifts.`,
    'too-fast': `Overall you are up ${rate}% per session, which is faster than adaptation usually runs. Worth checking the reps are honest.`,
  }[status];

  const split = `${improving} lift${improving === 1 ? '' : 's'} climbing, ${flat} flat, ${declining} falling.`;

  const parts = [direction, split];

  if (volumeTrend !== null && Math.abs(volumeTrend) >= 5) {
    parts.push(
      volumeTrend > 0
        ? `Session volume is up ${volumeTrend}% per session — you are doing more work, so some of the gain is effort rather than strength.`
        : `Session volume is down ${Math.abs(volumeTrend)}% per session, so lifts holding steady are doing so on less work.`,
    );
  }

  if (load.sessionsPerWeek) {
    parts.push(`Averaging ${load.sessionsPerWeek} sessions and ${load.setsPerWeek} working sets a week.`);
  }

  return parts.join(' ');
}
