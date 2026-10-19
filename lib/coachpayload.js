/**
 * Everything the written coach is told, assembled in one place.
 *
 * This was 105 lines in the middle of `app.js`, between two render functions,
 * with no Node test — and it is the single most consequential computation in the
 * app that nothing was checking. The sleep bug lived here for two months: it
 * filtered metrics on `sleepHours` while every other layer uses `sleep_hours`,
 * so `recovery.sleepAvg` was permanently null and the coach had never once been
 * told about sleep. Nothing failed, and the line directly below it was correct.
 *
 * It was always a pure function of the data; the only thing holding it in the UI
 * file was that it reached for `state` instead of taking an argument.
 *
 * The shape is deliberately a *projection*, not the raw records: one line per
 * session rather than every set, verdicts rather than series. The payload is
 * measured at ~3.1k tokens over 23 sessions and the budget is the reason.
 */

import { analyzeAll } from './analysis.js';
import { overallProgress } from './progress.js';
import { profilesFrom, groupTrends } from './profiles.js';
import { QUESTIONS, isAnswered, liftFeel } from './checkin.js';
import { feedbackSummary } from './adapt.js';
import { machineChanged } from './gyms.js';
import { usualTempo, tempoDrift } from './tempo.js';
import { egoCheck } from './diagnose.js';
import { totalVolume } from './strength.js';
import { nutritionContext, bodyweightTrend } from './nutrition.js';
import { measuredDeficit, deficitVerdict } from './energy.js';
import { historyFor, loggedExerciseList } from './repository.js';

/** The last fortnight of a metric, since every window here is fourteen days. */
const WINDOW = 14;

/**
 * Mean of whatever is actually there, or null.
 *
 * Null rather than zero for an empty list, and non-numbers dropped rather than
 * counted as nothing — `Number(null) === 0` has cost this project six bugs, and
 * an average is where it would be least visible.
 */
export function avg(values) {
  const nums = (values ?? [])
    .map((v) => (v === null || v === undefined || v === '' ? null : Number(v)))
    .filter((v) => v !== null && Number.isFinite(v));

  return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null;
}

/** The last `WINDOW` readings of one metric. */
const recent = (metrics, name) =>
  avg((metrics ?? []).filter((m) => m?.name === name).slice(-WINDOW).map((m) => m.value));

/**
 * Are his lifts broadly holding?
 *
 * Fewer than 40% regressing, with at least three lifts to judge from. It feeds
 * `deficitVerdict`, which is the difference between "losing fast and getting away
 * with it" and "spending muscle" — the only combination worth an alarm.
 */
export function liftsAreHolding(sessions, boot) {
  const items = loggedExerciseList(sessions, boot);
  const findings = analyzeAll(items);
  if (findings.length < 3) return null;

  const falling = findings.filter((f) => f.status === 'regressing').length;
  return falling / findings.length < 0.4;
}

export function summaryFindings({ sessions = [], boot = {}, metrics = [], settings = {}, adapt = null, gymNames = [] } = {}) {
  const items = loggedExerciseList(sessions, boot);
  const findings = analyzeAll(items);
  const exercises = boot.exercises ?? [];
  const overall = overallProgress({ items, sessions, exercises });

  const byId = new Map(exercises.map((e) => [e.id, e]));

  const checkins = sessions.map((s) => s?.checkin).filter(Boolean);
  const checkin = {};
  for (const q of QUESTIONS) {
    const value = avg(checkins.map((c) => c[q.id]));
    if (value !== null) checkin[q.id] = value;
  }

  const profiles = profilesFrom(sessions, { minSessions: 3, exercises });

  return {
    // His own verdicts on the app's own advice. The most directly useful thing
    // here: no trend line can say "he has declined four of the last five
    // suggestions and rates his split 2 out of 5".
    feedback: feedbackSummary(adapt?.decisions ?? []),

    overall: overall
      ? { status: overall.status, rate: overall.percentPerSession, message: overall.message }
      : null,

    lifts: findings.map((f) => ({
      name: f.name,
      status: f.status,
      percentPerSession: f.percentPerSession,
      flags: f.flags,
      muscleGroup: byId.get(f.exerciseId)?.muscleGroup ?? null,
      machine: machineChanged(sessions, f.exerciseId).to ?? null,
      feel: liftFeel(sessions, f.exerciseId),
      tempo: usualTempo(sessions, f.exerciseId),
      tempoDrift: (() => {
        const d = tempoDrift(sessions, f.exerciseId);
        return d.drifting ? { from: d.from, to: d.to } : null;
      })(),
      ego: (() => {
        const e = egoCheck({ history: historyFor(sessions, f.exerciseId), exerciseId: f.exerciseId });
        return e.flagged ? { weightTrend: e.weightTrend, strengthTrend: e.strengthTrend } : null;
      })(),
    })),

    recovery: {
      // `sleep_hours`, not `sleepHours`. See the module comment.
      sleepAvg: recent(metrics, 'sleep_hours'),
      stepsAvg: recent(metrics, 'steps'),
    },

    // Per-machine trends, so it can tell "got stronger" from "changed stack".
    profiles: profiles.map((p) => ({
      label: p.label, machine: p.machine, sessions: p.sessions, percentPerSession: p.percentPerSession,
    })),

    groups: groupTrends(profiles, exercises).map((g) => ({
      muscleGroup: g.muscleGroup,
      percentPerSession: g.percentPerSession,
      profiles: g.profiles,
      machines: g.machines,
    })),

    // One line per session ever logged: the shape of the training, without the
    // set-by-set bulk that would say little and cost much.
    history: [...sessions]
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
      .map((s) => ({
        date: String(s.startedAt ?? '').slice(0, 10),
        day: s.dayName ?? null,
        gym: s.gymName ?? null,
        sets: (s.sets ?? []).length,
        volume: Math.round(totalVolume(s.sets ?? [])),
      })),

    // The scale reframes every trend under it: holding a lift while losing
    // weight is a success the coach was calling a stall.
    nutrition: (() => {
      const intakeAvg = recent(metrics, 'dietary_energy');
      const ctx = nutritionContext({
        metrics,
        settings,
        intakeAvg,
        proteinAvg: recent(metrics, 'protein'),
      });

      // What the scale measured beats what the formula estimated, and the model
      // needs both to say which it is trusting.
      const weight = bodyweightTrend(metrics);
      const known = weight.direction !== 'unknown';
      const measured = measuredDeficit({ perWeek: known ? weight.perWeek : null, intakeAvg });
      const verdict = deficitVerdict({
        perWeek: known ? weight.perWeek : null,
        weightLb: weight.smoothed,
        liftsHolding: liftsAreHolding(sessions, boot),
      });

      return {
        ...ctx,
        goal: settings.goal || null,
        deficitPerDay: measured.known ? measured.deficitPerDay : null,
        impliedTDEE: measured.known ? measured.impliedTDEE : null,
        verdict: verdict.severity === 'unknown'
          ? null
          : { severity: verdict.severity, message: verdict.message },
      };
    })(),

    checkin: Object.keys(checkin).length ? checkin : null,

    checkins: sessions
      .filter((s) => s?.checkin && (isAnswered(s.checkin) || String(s.checkin.note ?? '').trim()))
      .map((s) => ({
        date: String(s.startedAt ?? '').slice(0, 10),
        day: s.dayName ?? null,
        ...Object.fromEntries(
          QUESTIONS.map((q) => [q.id, s.checkin[q.id]]).filter(([, v]) => Number.isFinite(Number(v))),
        ),
        note: String(s.checkin.note ?? '').trim() || undefined,
      })),

    gyms: gymNames,
  };
}
