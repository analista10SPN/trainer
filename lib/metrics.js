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
export function mergeMetrics(base, incoming) {
  const out = new Map();

  for (const m of Array.isArray(base) ? base : []) {
    if (m?.name) out.set(key(m), m);
  }

  for (const m of Array.isArray(incoming) ? incoming : []) {
    if (!m?.name) continue;

    // One rule, stated once: a reading that has not reached the server yet
    // always wins, because the server's silence about it is not disagreement.
    // Anything already uploaded defers to what is already here.
    const isNew = !out.has(key(m));
    if (isNew || m._dirty) out.set(key(m), m);
  }

  return [...out.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

export function dirtyMetrics(metrics) {
  return (Array.isArray(metrics) ? metrics : []).filter((m) => m?._dirty);
}
