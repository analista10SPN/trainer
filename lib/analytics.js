/**
 * The questions a dashboard is for, and the guards that keep them honest.
 *
 * The computation was never the gap. `overallProgress`, `profilesFrom`,
 * `groupTrends`, `trainingLoad` and `volumeOverTime` all existed before any of
 * this, and the Coach tab has been rendering them as sentences and pills. What
 * was missing is the handful of questions nothing answered at all: **am I
 * turning up, where do I train, how long does a session take, and is this month
 * better than last.**
 *
 * Three of those have a trap in the real data, which is why this is a module
 * with tests rather than four expressions inside a view function.
 *
 * 1. **One session in the log reads 400 minutes.** It is a forgotten *Finish*,
 *    not a six-hour workout. A mean over a set containing it is nonsense, and
 *    the project's standing rule applies: it is *shown* as excluded rather than
 *    quietly adjusted, because a number changed behind your back is how you stop
 *    trusting the ones that were not.
 * 2. **Only 11 of 35 sessions carry a gym**, because the prompt arrived late. A
 *    "where do you train" chart with a slice called `undefined` is worse than no
 *    chart, so the unrecorded ones are a named category.
 * 3. **"This period vs last" needs both periods to exist.** A first week
 *    compared against a week that never happened is an infinite improvement,
 *    which is the shape every vanity metric has.
 *
 * Everything here reports its own sample size. That is not politeness: a
 * "45 minutes typical" computed over a set that silently dropped three sessions
 * is a claim about data that was not there, and the count is what makes it
 * checkable.
 */

import { numeric } from './strength.js';
import { weekStart } from './week.js';

/**
 * Longer than this and somebody forgot to tap *Finish*.
 *
 * Generous on purpose. Getting it wrong in the strict direction silently
 * deletes real data, which is worse than keeping one outlier — a two-hour leg
 * day happens, and so does a long session with a conversation in the middle.
 * Three hours does not.
 */
export const MAX_PLAUSIBLE_MINUTES = 180;

/** How long one session took, or null. Never a zero. */
export function sessionMinutes(session) {
  const start = Date.parse(session?.startedAt ?? '');
  const end = Date.parse(session?.finishedAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const minutes = Math.round((end - start) / 60000);
  if (minutes <= 0 || minutes > MAX_PLAUSIBLE_MINUTES) return null;
  return minutes;
}

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * How long a session usually takes, and how many could not be used.
 *
 * The median rather than the mean, for the usual reason: one 120-minute session
 * should not move "typical" by half an hour. `ignored` is the honest half — it
 * covers both the unfinished sessions and the forgotten-Finish ones, and without
 * it the median is a figure with no visible provenance.
 */
export function durationStats(sessions) {
  const all = Array.isArray(sessions) ? sessions : [];
  const minutes = all.map(sessionMinutes).filter((m) => m !== null);

  return {
    median: median(minutes),
    shortest: minutes.length ? Math.min(...minutes) : null,
    longest: minutes.length ? Math.max(...minutes) : null,
    counted: minutes.length,
    ignored: all.length - minutes.length,
  };
}

/**
 * Sessions per week, oldest week first.
 *
 * **A week nobody trained is a zero, not a missing entry.** Drawn as a gap it
 * reads as "no data"; drawn as a zero it reads as the week that was skipped,
 * which is the only thing this chart is for. The same argument as every muscle
 * group appearing in `weeklyCoverage` including the untrained ones.
 */
export function consistency(sessions, { now = new Date(), weeks = 12 } = {}) {
  const all = Array.isArray(sessions) ? sessions : [];
  const span = Math.max(1, Math.round(weeks));

  const counts = new Map();
  for (const session of all) {
    const when = Date.parse(session?.startedAt ?? '');
    if (!Number.isFinite(when)) continue;
    const key = weekStart(new Date(when));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const out = [];
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    const key = weekStart(d);
    out.push({ weekStart: key, sessions: counts.get(key) ?? 0 });
  }
  return out;
}

/**
 * Where the training happens, most frequented first.
 *
 * Sessions with no gym are their own row rather than being dropped or folded
 * into one. Dropping them makes the chart a claim about a quarter of the log;
 * folding them into a gym invents a visit that was never recorded. A gym since
 * deleted keeps its id as its name, which is what `loggedExerciseList` already
 * does with a deleted lift: it stays identifiable and says plainly that
 * something is missing.
 */
export function gymFrequency(sessions, gymNames = {}) {
  const names = gymNames ?? {};
  const counts = new Map();

  for (const session of (Array.isArray(sessions) ? sessions : [])) {
    const id = String(session?.gymId ?? '').trim() || null;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([gymId, n]) => ({
      gymId,
      name: gymId ? (names[gymId] ?? gymId) : 'no gym recorded',
      sessions: n,
    }))
    .sort((a, b) => b.sessions - a.sessions || String(a.name).localeCompare(String(b.name)));
}

/**
 * This period against the one before it.
 *
 * `comparable` is the field that matters. Without it a first period reads as an
 * improvement over a period that never happened, which is how every vanity
 * metric is built — and a previous total of zero gives a percentage of
 * infinity, so the two figures are still reported while the percentage is not.
 */
export function periodCompare(series, { size = 4 } = {}) {
  const values = (Array.isArray(series) ? series : [])
    .map(numeric)
    .filter((v) => v !== null && Number.isFinite(v));

  const span = Math.max(1, Math.round(size));
  const sum = (list) => list.reduce((a, b) => a + b, 0);

  const current = sum(values.slice(-span));

  if (values.length < span * 2) {
    return { current, previous: null, percent: null, comparable: false };
  }

  const previous = sum(values.slice(-span * 2, -span));
  const percent = previous === 0
    ? null
    : Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;

  return { current, previous, percent, comparable: true };
}

/**
 * The band a reading usually falls in.
 *
 * One standard deviation either side of the mean, and **nothing at all below
 * four readings** — the same floor the bodyweight slope insists on, for the same
 * reason. Two points always look like a perfect line, and a number with no error
 * bar is a claim rather than a measurement.
 *
 * A band of zero width is a real answer: four identical readings genuinely have
 * no spread, and reporting null there would say "unknown" about something known.
 */
export function typicalRange(values) {
  const nums = (Array.isArray(values) ? values : [])
    .map(numeric)
    .filter((v) => v !== null && Number.isFinite(v));

  const readings = nums.length;
  if (readings < 4) return { low: null, mid: median(nums), high: null, readings };

  const mean = nums.reduce((a, b) => a + b, 0) / readings;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / readings;
  const sd = Math.sqrt(variance);

  const round = (n) => Math.round(n * 10) / 10;
  return { low: round(mean - sd), mid: round(mean), high: round(mean + sd), readings };
}
