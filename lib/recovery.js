/**
 * Reading recovery alongside strength.
 *
 * The coach can already see a lift stalling. What it cannot see is why. Sleep
 * and daily activity are the two things most likely to explain a regression
 * that has nothing to do with programming, and they are exactly what a watch
 * measures without being asked.
 *
 * This never diagnoses. It reports what was measured next to what was lifted
 * and says when the two look related, because "you are under-recovered" is a
 * claim the data can support and "you are overtraining" is not.
 */

import { numeric } from './strength.js';

const round1 = (x) => Math.round(x * 10) / 10;

const reading = numeric;

/** Guidance thresholds, deliberately generous — these prompt, they do not judge. */
export const SLEEP_LOW = 6.5;
export const SLEEP_GOOD = 7.5;

export function metricsByDay(metrics = []) {
  const byDay = new Map();
  for (const m of metrics) {
    const value = reading(m?.value);
    if (!m?.date || value === null) continue;
    if (!byDay.has(m.date)) byDay.set(m.date, {});
    byDay.get(m.date)[m.name] = value;
  }
  return byDay;
}

/** Every real reading of one metric, most recent first. */
function readingsOf(metrics, name) {
  return metrics
    .filter((m) => m?.name === name && reading(m.value) !== null)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .map((m) => reading(m.value));
}

/** Mean of a metric over the most recent `days` entries that have it. */
export function recentAverage(metrics = [], name, days = 7) {
  const values = readingsOf(metrics, name).slice(0, days);
  if (!values.length) return null;
  return round1(values.reduce((a, b) => a + b, 0) / values.length);
}

/** How a window of days compares with the window before it. */
export function trend(metrics = [], name, days = 7) {
  const values = readingsOf(metrics, name);

  if (values.length < days + 1) return null;

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const now = mean(values.slice(0, days));
  const before = mean(values.slice(days, days * 2));
  if (!before) return null;

  return round1(((now - before) / before) * 100);
}

/**
 * A short read on recovery, and whether it plausibly explains what the lifting
 * numbers are doing.
 *
 * @param metrics  rows of { date, name, value }
 * @param findings output of analyzeAll — the per-lift verdicts
 */
export function recoveryReport(metrics = [], findings = []) {
  const sleep = recentAverage(metrics, 'sleep_hours');
  const steps = recentAverage(metrics, 'steps');
  const restingHr = recentAverage(metrics, 'resting_hr');
  const hrv = recentAverage(metrics, 'hrv');

  const hasData = [sleep, steps, restingHr, hrv].some((v) => v !== null);
  if (!hasData) {
    return {
      hasData: false,
      sleep: null, steps: null, restingHr: null, hrv: null,
      flags: [],
      message: 'No watch data yet. Once the Shortcut runs, sleep and activity show up here beside your lifting.',
    };
  }

  const flags = [];
  const notes = [];

  if (sleep !== null && sleep < SLEEP_LOW) {
    flags.push('short-sleep');
    notes.push(`You are averaging ${sleep}h of sleep. Under ${SLEEP_LOW}h, strength usually flattens before it falls.`);
  }

  const hrTrend = trend(metrics, 'resting_hr');
  if (hrTrend !== null && hrTrend >= 5) {
    flags.push('resting-hr-up');
    notes.push(`Resting heart rate is up ${hrTrend}% on the week before, which often shows up before you feel run down.`);
  }

  const hrvTrend = trend(metrics, 'hrv');
  if (hrvTrend !== null && hrvTrend <= -10) {
    flags.push('hrv-down');
    notes.push(`HRV is down ${Math.abs(hrvTrend)}% on the week before.`);
  }

  // The connection worth drawing: lifts going backwards while recovery is poor.
  const struggling = findings.filter((f) => f.status === 'regressing' || f.status === 'stagnant');
  if (flags.length && struggling.length >= 2) {
    notes.push(
      `${struggling.length} lifts are flat or falling at the same time. When recovery and strength dip together, ` +
      'the programming is usually not the thing to change first.',
    );
  }

  return {
    hasData: true,
    sleep, steps, restingHr, hrv,
    sleepTrend: trend(metrics, 'sleep_hours'),
    restingHrTrend: hrTrend,
    hrvTrend,
    flags,
    strugglingLifts: struggling.map((f) => f.name),
    message: notes.length
      ? notes.join(' ')
      : `Sleep${sleep !== null ? ` is averaging ${sleep}h` : ''} and recovery markers look steady. Nothing here explains a bad session.`,
  };
}
