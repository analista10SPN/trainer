/**
 * Somebody else's training, summarised for the person coaching them.
 *
 * The admin screen used to show account status and twenty rows of "date · day
 * name · N sets", while the member's own phone computed a verdict on every lift
 * they had logged. Every function needed to close that gap was already written,
 * already pure, and already imported into the same file — it simply was not
 * called. So this is almost entirely composition: no new analysis, just the three
 * questions somebody opens that screen with.
 *
 * **Has she trained. Is anything going backwards. Is she covering her body.**
 *
 * Exceptions are listed and everything else is counted, because a coach wants
 * what needs attention rather than a reprint of the whole log — and because a
 * count is what distinguishes "nothing is wrong" from "nothing was computed".
 *
 * It must never throw. This renders data fetched over a network about another
 * person; a crash here is a crash in the middle of looking at a client.
 */

import { analyzeAll } from './analysis.js';
import { overallProgress } from './progress.js';
import { checkCoverage, GLUTE_FOCUS } from './coverage.js';
import { bodyweightTrend } from './nutrition.js';
import { loggedExerciseList } from './repository.js';
import { weekStart, sessionsThisWeek } from './week.js';

/** Whole days between two instants, floored. Null if either is missing. */
function daysBetween(then, now) {
  const a = Date.parse(then ?? '');
  if (!Number.isFinite(a)) return null;
  return Math.max(0, Math.floor((now.getTime() - a) / 86400000));
}

export function clientSummary(input) {
  /**
   * `input ?? {}`, not a default parameter.
   *
   * A default only fires for `undefined`. `clientSummary(null)` — which is what a
   * not-yet-loaded client is — would skip it and throw on the first property
   * read. The same shape as `Number(null) === 0`, which has cost this project six
   * bugs, and this screen renders another person's data fetched over a network,
   * so it is exactly where a null turns up.
   */
  const { sessions = [], boot = {}, metrics = [], now = new Date() } = input ?? {};

  const log = Array.isArray(sessions) ? sessions : [];
  const library = boot?.exercises ?? [];

  const ordered = [...log].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const last = ordered.length ? ordered[ordered.length - 1].startedAt : null;

  const items = loggedExerciseList(log, boot ?? {});
  const findings = analyzeAll(items);

  /**
   * The exceptions, worst first.
   *
   * `regressing` before `stagnant`, and within each, the steepest decline first —
   * which is the order somebody would ask about them in.
   */
  const rank = { regressing: 0, stagnant: 1 };
  const needsAttention = findings
    .filter((f) => f.status === 'regressing' || f.status === 'stagnant')
    .sort((a, b) => (rank[a.status] - rank[b.status])
      || (a.percentPerSession - b.percentPerSession))
    .map((f) => ({
      exerciseId: f.exerciseId,
      name: f.name,
      status: f.status,
      percentPerSession: f.percentPerSession,
      message: f.message,
    }));

  /**
   * What a week of their training actually hits.
   *
   * Measured over the program they are on rather than over everything in the
   * library, and reported only as the gaps — a coach needs the hole, not the
   * eleven groups that are fine.
   */
  const days = (boot?.days ?? []);
  const coverage = days.length
    ? checkCoverage({ days }, library, GLUTE_FOCUS)
    : { problems: [] };

  const weight = bodyweightTrend(Array.isArray(metrics) ? metrics : []);
  const overall = overallProgress({ items, sessions: log, exercises: library });

  return {
    sessions: log.length,
    lastTrained: last,
    daysSince: last ? daysBetween(last, now) : null,
    weekStart: weekStart(now),
    thisWeek: sessionsThisWeek(log, now).length,

    liftsJudged: findings.length,
    needsAttention,

    overall: overall
      ? { status: overall.status, percentPerSession: overall.percentPerSession, message: overall.message }
      : null,

    coverageGaps: (coverage.problems ?? []).map((p) => ({
      muscleGroup: p.muscleGroup,
      got: p.got,
      wanted: p.wanted,
    })),

    weight: {
      readings: weight.readings,
      smoothed: weight.smoothed,
      perWeek: weight.perWeek,
      direction: weight.direction,
      confident: weight.confident,
    },
  };
}
