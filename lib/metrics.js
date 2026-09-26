/**
 * Readings entered on the phone.
 *
 * Metrics used to be download-only: written by a Shortcut straight to the cloud
 * and never by this app. That put the single most useful number in the system —
 * which way the scale is going — behind a Shortcut that would not set up, while
 * he was actively cutting. A number you cannot enter is a number you do not have,
 * and without it every strength verdict is one variable short.
 *
 * So a reading can be typed. It has to work with no signal like everything else
 * here, which means it is stored locally, marked dirty, and rides up on the next
 * sync — and a reading the server has not seen yet must survive the pull that
 * follows, which is the same skew that quietly ate the gym and the tempo.
 */

import { numeric } from './strength.js';

/** Exactly what the Worker accepts; a name it refuses is a silent loss. */
export const ENTERABLE = new Set([
  'body_weight',
  'dietary_energy',
  'protein',
  'carbohydrates',
  'total_fat',
  'steps',
  'sleep_hours',
]);

const key = (m) => `${m?.name}::${String(m?.date ?? '').slice(0, 10)}`;

/**
 * A reading, or null if it is not one.
 *
 * Rejects zero and negatives outright: `numeric()` keeps `null` from becoming
 * `0`, and a 0 lb bodyweight would drag the trend off a cliff while looking
 * like a real measurement.
 */
export function makeMetric(name, value, date) {
  if (!ENTERABLE.has(name)) return null;

  const n = numeric(value);
  if (n === null || n <= 0) return null;

  const day = String(date ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;

  return {
    id: `${name}-${day}`,
    name,
    value: Math.round(n * 100) / 100,
    date: day,
    _dirty: true,
  };
}

/**
 * Fold newer readings onto older ones, one per metric per day.
 *
 * Weighing twice in a morning should correct the number rather than leave two
 * points that average into something he never actually weighed.
 *
 * `incoming` wins, except where the local copy is still dirty — that one has
 * not reached the server yet, so the server's silence about it is not news.
 */
export function mergeMetrics(base, incoming, suppress) {
  // Readings deleted locally but still present on the server. Without this the
  // next pull resurrects a value he deliberately cleared — the same problem
  // that ate the gym and the tempo, running the other way.
  const gone = new Set((Array.isArray(suppress) ? suppress : []).map((s) => `${s?.name}::${String(s?.date ?? '').slice(0, 10)}`));

  const out = new Map();

  for (const m of Array.isArray(base) ? base : []) {
    if (m?.name && !gone.has(key(m))) out.set(key(m), m);
  }

  for (const m of Array.isArray(incoming) ? incoming : []) {
    if (!m?.name) continue;

    // One rule, stated once: a reading that has not reached the server yet
    // always wins, because the server's silence about it is not disagreement.
    // Anything already uploaded defers to what is already here.
    if (gone.has(key(m))) continue;
    const isNew = !out.has(key(m));
    if (isNew || m._dirty) out.set(key(m), m);
  }

  return [...out.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

export function dirtyMetrics(metrics) {
  return (Array.isArray(metrics) ? metrics : []).filter((m) => m?._dirty);
}

/* ----------------------- a day is a row, not a stream --------------------- */

/**
 * The three things logged per day.
 *
 * Ordered as they are entered and displayed, so one list drives both.
 */
export const DAY_FIELDS = [
  { name: 'body_weight', label: 'Weight', unit: 'lb', step: '0.1' },
  { name: 'dietary_energy', label: 'Calories', unit: 'kcal', step: '1' },
  { name: 'steps', label: 'Steps', unit: '', step: '1' },
];

/** What is recorded for one day. Missing reads as null, never as zero. */
export function metricsForDay(metrics, date) {
  const day = String(date ?? '').slice(0, 10);
  const row = {};

  for (const f of DAY_FIELDS) {
    const found = (Array.isArray(metrics) ? metrics : [])
      .find((m) => m?.name === f.name && String(m.date ?? '').slice(0, 10) === day);
    row[f.name] = found ? found.value : null;
  }

  return { date: day, ...row };
}

/**
 * Write a whole day at once, leaving out what was not mentioned.
 *
 * Three fields and one save, rather than three saves that each clear a box.
 * A field present but blank is a deletion: blanking a mistyped calorie count
 * has to remove it, because storing 0 would read as a day of fasting.
 */
export function setDayMetrics(metrics, date, values) {
  const day = String(date ?? '').slice(0, 10);
  let out = (Array.isArray(metrics) ? metrics : []).slice();

  for (const [name, raw] of Object.entries(values ?? {})) {
    if (!ENTERABLE.has(name)) continue;

    const blank = raw === '' || raw === null || raw === undefined;
    const metric = blank ? null : makeMetric(name, raw, day);

    // Drop whatever is there for this metric on this day, then put back the
    // new value if there is one. Junk in one field leaves the others alone.
    if (blank || metric) {
      out = out.filter((m) => !(m?.name === name && String(m.date ?? '').slice(0, 10) === day));
      if (metric) out.push(metric);
    }
  }

  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/** The last few days that have anything recorded, newest first. */
export function recentDays(metrics, limit = 14) {
  const days = new Set();
  for (const m of Array.isArray(metrics) ? metrics : []) {
    if (m?.name && DAY_FIELDS.some((f) => f.name === m.name)) days.add(String(m.date ?? '').slice(0, 10));
  }

  return [...days]
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, limit)
    .map((d) => metricsForDay(metrics, d));
}

/* --------------------- any date, including empty ones --------------------- */

/** How far back a reading can plausibly be backfilled. */
const MAX_BACKFILL_DAYS = 400;

/**
 * The last `count` calendar days ending at `today`, newest first.
 *
 * Every day, not only the ones with readings — a day he forgot entirely has
 * nothing to list, so listing only what exists makes the gap untappable and
 * therefore unfixable. The gaps are the point.
 *
 * Built by stepping a Date object so month ends and leap days take care of
 * themselves, and read back in local terms so a reading entered at 00:10 sits
 * on the day he thinks it does.
 */
export function calendarDays(today, count = 14) {
  const start = String(today ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return [];

  const [y, m, d] = start.split('-').map(Number);
  const out = [];

  for (let i = 0; i < Math.max(0, count); i++) {
    const day = new Date(y, m - 1, d - i);
    out.push(
      `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`,
    );
  }

  return out;
}

/**
 * Can a reading be filed against this date?
 *
 * The future is refused because tomorrow's weight does not exist, and a reading
 * ahead of the trend is one nothing can ever reconcile. The distant past is
 * refused because a mistyped year is far likelier than a genuine backfill from
 * two years ago.
 */
export function isLoggableDate(date, today) {
  const day = String(date ?? '');
  const now = String(today ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{4}-\d{2}-\d{2}$/.test(now)) return false;

  // Round-trip through a Date so 2026-13-01 and 2026-02-30 are caught.
  const [y, m, d] = day.split('-').map(Number);
  const parsed = new Date(y, m - 1, d);
  if (parsed.getFullYear() !== y || parsed.getMonth() !== m - 1 || parsed.getDate() !== d) return false;

  if (day > now) return false;
  return calendarDays(now, MAX_BACKFILL_DAYS).includes(day);
}
