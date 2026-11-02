/**
 * The coach.
 *
 * Deterministic trend detection over logged working sets. This layer never
 * guesses: it reports the slope of your estimated 1RM and the specific patterns
 * that tend to precede a stall or a technique breakdown, and says which is which.
 *
 * Honest limit: no amount of weight-and-reps data can see your form. What it can
 * see are the correlates — a load that jumped faster than adaptation plausibly
 * allows, and reps falling off a cliff inside a single session.
 */

import { bestE1RM, percentSlope, topSet } from './strength.js';

export const MIN_SESSIONS = 3;
export const TREND_WINDOW = 6;

const TOO_FAST_PCT = 6;
const PROGRESS_PCT = 1;
const REGRESS_PCT = -1;

const JUMP_RATIO = 1.1;
const COLLAPSE_RATIO = 0.4;
const BELOW_BEST_RATIO = 0.95;

const SEVERITY = { regressing: 0, 'too-fast': 1, stagnant: 2, progressing: 3, 'insufficient-data': 4 };

/** Reps falling off a cliff across sets at the same load, within one session. */
function hasRepCollapse(session) {
  const byWeight = new Map();
  for (const s of session?.sets ?? []) {
    if (!(Number(s.weight) > 0) || !(Number(s.reps) >= 0)) continue;
    const key = Number(s.weight);
    if (!byWeight.has(key)) byWeight.set(key, []);
    byWeight.get(key).push(s);
  }

  for (const group of byWeight.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => Number(a.setIndex) - Number(b.setIndex));
    const first = Number(ordered[0].reps);
    const last = Number(ordered[ordered.length - 1].reps);
    if (first > 0 && last <= first * COLLAPSE_RATIO) return true;
  }
  return false;
}

/**
 * What to do about a status. The same words for every lift that has it.
 *
 * Separated from the finding because it *is* separate: "deload 10% and build
 * back, switch the rep range, or swap the movement" is advice about stalling,
 * not about this lift. Inlined into each verdict it was byte-identical across
 * every stalled lift on the screen — twenty-four cards, the same sentence
 * twenty-four times, which is how a screen teaches somebody to stop reading it.
 *
 * Exported so the view can print it **once**, under the heading for the group,
 * where it is read as the general case rather than as this lift's diagnosis.
 */
export const ADVICE = {
  progressing: 'Keep the progression exactly as is.',
  stagnant: 'Change one variable: deload 10% and build back, switch the rep range, or swap the movement.',
  regressing: 'That is usually recovery rather than strength — check sleep, food, and whether these lifts are being trained too often.',
  'too-fast': 'Confirm the reps are real and the range of motion has not shortened.',
  'insufficient-data': `A trend needs ${MIN_SESSIONS} logged sessions before it means anything.`,
};

/**
 * What is true of *this* lift: its name, its rate, and anything unusual in the
 * sets themselves.
 *
 * The flags stay here rather than moving to `ADVICE` because each one is about
 * a specific session of a specific lift — "the load jumped more than 10% in one
 * session" is an observation, not general guidance, and it is only attached to
 * the lifts it actually happened to.
 */
function messageFor(status, pct, flags, name) {
  const rate = `${pct > 0 ? '+' : ''}${pct}% per session`;
  const base = {
    progressing: `${name} is climbing at ${rate}.`,
    stagnant: `${name} has been flat (${rate}) for several sessions.`,
    regressing: `${name} is trending down at ${rate}.`,
    'too-fast': `${name} is climbing at ${rate}, which is faster than adaptation usually allows.`,
    'insufficient-data': `${name} needs ${MIN_SESSIONS} logged sessions before a trend means anything.`,
  }[status];

  const extra = [];
  if (flags.includes('weight-jump')) extra.push('The load jumped more than 10% in one session — a big single-session jump is where technique usually slips.');
  if (flags.includes('rep-collapse')) extra.push('Reps collapsed across sets at the same weight — the top set was likely too heavy for the target range.');
  if (flags.includes('below-best')) extra.push('The last session came in under your recent best on this lift.');

  return [base, ...extra].join(' ');
}

export function analyzeExercise({ name, exerciseId = null, history = [] }) {
  const sessions = history.filter((s) => (s.sets ?? []).some((x) => Number(x.reps) > 0));
  const e1rmSeries = sessions.map((s) => bestE1RM(s.sets));

  if (sessions.length < MIN_SESSIONS) {
    return {
      name,
      exerciseId,
      status: 'insufficient-data',
      percentPerSession: 0,
      e1rmSeries,
      sessionCount: sessions.length,
      flags: [],
      message: messageFor('insufficient-data', 0, [], name),
    };
  }

  const window = e1rmSeries.slice(-TREND_WINDOW);
  const pct = percentSlope(window);

  let status;
  if (pct > TOO_FAST_PCT) status = 'too-fast';
  else if (pct >= PROGRESS_PCT) status = 'progressing';
  else if (pct > REGRESS_PCT) status = 'stagnant';
  else status = 'regressing';

  const flags = [];
  const latest = sessions[sessions.length - 1];
  const previous = sessions[sessions.length - 2];

  const latestTop = topSet(latest.sets ?? []);
  const previousTop = topSet(previous.sets ?? []);
  if (latestTop && previousTop && Number(latestTop.weight) > Number(previousTop.weight) * JUMP_RATIO) {
    flags.push('weight-jump');
  }

  if (hasRepCollapse(latest)) flags.push('rep-collapse');

  const best = Math.max(...e1rmSeries);
  if (best > 0 && e1rmSeries[e1rmSeries.length - 1] < best * BELOW_BEST_RATIO) {
    flags.push('below-best');
  }

  return {
    name,
    exerciseId,
    status,
    percentPerSession: pct,
    e1rmSeries,
    sessionCount: sessions.length,
    lastE1RM: e1rmSeries[e1rmSeries.length - 1],
    bestE1RM: best,
    flags,
    message: messageFor(status, pct, flags, name),
  };
}

/** Analyze a set of exercises, worst news first, silent about anything too new to judge. */
export function analyzeAll(items = []) {
  return items
    .map(analyzeExercise)
    .filter((r) => r.status !== 'insufficient-data')
    .sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status] || b.flags.length - a.flags.length);
}
