/**
 * Changing the program because the numbers said to.
 *
 * Asked for directly: when a lift stalls, suggest swapping the movement; suggest a
 * deload, or more sets, or fewer; as structured data that can be applied
 * automatically, on a fortnightly cadence rather than after every session.
 *
 * Three decisions shape the whole module.
 *
 * **A proposal is data, not an action.** `proposeChanges` decides and
 * `applyProposal` edits, and they are separate functions over plain objects. That
 * is what makes a change reviewable before it happens, reversible after it has,
 * and testable against a fixture — a function that edited the program as a side
 * effect of analysing it could be none of those.
 *
 * **It is computed, never invented.** The verdicts already exist in `analysis.js`
 * and `diagnose.js`; this turns them into concrete edits. Nothing here asks a
 * language model what to do. A hallucinated exercise id applied automatically to
 * his program is a bug with no recovery path — an unopenable day, in a gym, with
 * no signal — and the app has to work offline besides.
 *
 * **It changes two things, not six.** A program that changes everywhere at once
 * cannot be learned from: when the next fortnight goes better or worse, nothing
 * says which change did it. The cap is the feature, not a limitation of it.
 *
 * **And nothing is applied without being accepted.** The first version applied
 * automatically and offered an undo, which is what was asked for — but it sat
 * badly against the rule the rest of this app is built on: a number changed behind
 * your back is how you stop trusting the ones that were not. Asking is also worth
 * more than it costs, because a *decline* carries information an acceptance does
 * not: whether the split is satisfying, whether this particular idea was any good,
 * and whether the answer is "no" or "not yet". That is exactly the signal nothing
 * else in the app can measure.
 */

import { analyzeExercise } from './analysis.js';
import { loadAdvice } from './diagnose.js';
import { getScheme, workingSetCount } from './scheme.js';
import { numeric } from './strength.js';

/** How long a change gets before the next review. */
export const REVIEW_DAYS = 14;

/** How many edits one review may make. */
export const MAX_CHANGES = 2;

/** Below this many sessions, nothing is said about a lift at all. */
const MIN_SESSIONS = 3;

/** How far back a deload steps, and the most it ever will. */
const DELOAD_PCT = 10;
const MAX_DELOAD_PCT = 20;

/**
 * Is it time to look again?
 *
 * A fortnight, because he has to be able to tell whether a change helped, and
 * that takes three or four sessions of the lift. Reviewing after every session
 * would be thrashing dressed as responsiveness.
 *
 * An unparseable date reads as "never reviewed" on the `last` side — the honest
 * reading when the record is missing — and as "do not propose anything" on the
 * `now` side, because a review stamped with a time nobody can place is worse than
 * a late one.
 */
export function dueForReview(last, now) {
  const at = Date.parse(now);
  if (!Number.isFinite(at)) return false;

  const before = Date.parse(last);
  if (!Number.isFinite(before)) return true;

  return at - before >= REVIEW_DAYS * 86400000;
}

/* ------------------------------- the answer ------------------------------- */

/**
 * Why somebody said no.
 *
 * A fixed list rather than free text alone, because "no" in three different
 * senses needs three different responses from the app: a lift he believes he can
 * still push should come back later, a change of split he dislikes should not come
 * back at all, and "not now" is a timing answer and nothing more. Free text is
 * kept as well — it is where the reason nobody anticipated turns up.
 */
export const DECLINE_REASONS = [
  {
    id: 'keeping-it',
    label: 'I can keep this going',
    detail: 'The lift is fine, I want more time on it',
    // Comes back after one more cycle: he may be right, and if he is not the
    // numbers will say so again.
    cooldownDays: REVIEW_DAYS,
  },
  {
    id: 'dislike-change',
    label: 'I do not like that change',
    detail: 'Wrong movement, or not how I want to train',
    // Never again for this exact suggestion. Proposing it a third time after being
    // told twice is how an app stops being listened to.
    cooldownDays: null,
  },
  {
    id: 'not-yet',
    label: 'Not right now',
    detail: 'Ask me again later',
    cooldownDays: REVIEW_DAYS,
  },
];

/** The two scales worth asking about, and they are both optional. */
export const FEEDBACK_SCALES = [
  { id: 'splitSatisfaction', label: 'Happy with your current split?', low: 'Not at all', high: 'Very' },
  { id: 'suggestionRating', label: 'What do you make of this suggestion?', low: 'Bad idea', high: 'Good idea' },
];

const reasonById = (id) => DECLINE_REASONS.find((r) => r.id === id) ?? null;

/**
 * Record an answer.
 *
 * Returns a new decisions list — the caller owns storage. A decision is kept even
 * when it is an acceptance, because "he agreed with this one" is as much signal as
 * "he did not", and the pair of them is what makes the suggestions worth reading
 * in six months.
 */
export function recordDecision(decisions, { proposal, decision, reason = null, ratings = {}, note = '', now }) {
  if (!proposal?.id || !['accepted', 'declined'].includes(decision)) return decisions ?? [];

  const clean = (value) => {
    const n = numeric(value);
    return n !== null && n >= 1 && n <= 5 ? Math.round(n) : null;
  };

  const record = {
    proposalId: proposal.id,
    kind: proposal.kind,
    exerciseId: proposal.exerciseId,
    dayId: proposal.dayId,
    decision,
    reason: decision === 'declined' ? (reasonById(reason)?.id ?? null) : null,
    splitSatisfaction: clean(ratings.splitSatisfaction),
    suggestionRating: clean(ratings.suggestionRating),
    note: String(note ?? '').trim().slice(0, 500),
    at: now,
  };

  // One answer per suggestion: changing your mind replaces the old answer rather
  // than leaving two contradictory ones in the record.
  return [record, ...(decisions ?? []).filter((d) => d.proposalId !== proposal.id)].slice(0, 200);
}

/**
 * Is this suggestion still worth putting in front of him?
 *
 * An accepted one never is — it has been done. A declined one depends on why: a
 * change he disliked is gone for good, and the other two answers come back after a
 * cycle, because the numbers may well say the same thing again and he may well have
 * changed his mind.
 */
export function isSuppressed(decisions, proposalId, now) {
  const answer = (decisions ?? []).find((d) => d.proposalId === proposalId);
  if (!answer) return false;
  if (answer.decision === 'accepted') return true;

  const reason = reasonById(answer.reason);
  if (!reason || reason.cooldownDays === null) return true;

  const at = Date.parse(answer.at);
  const then = Date.parse(now);
  if (!Number.isFinite(at) || !Number.isFinite(then)) return true;

  return then - at < reason.cooldownDays * 86400000;
}

/**
 * What he has told us, summarised for the written coach.
 *
 * This is the point of asking in a structured way rather than only in prose: these
 * are countable. "He has declined four of the last five suggestions and rates the
 * split 2 out of 5" is a fact worth putting in a prompt; four paragraphs of
 * free text is not.
 */
export function feedbackSummary(decisions, { limit = 12 } = {}) {
  const recent = (decisions ?? []).slice(0, limit);
  if (!recent.length) return null;

  const rated = (key) => recent.map((d) => d[key]).filter((v) => v !== null && v !== undefined);
  const mean = (values) => (values.length
    ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
    : null);

  return {
    considered: recent.length,
    accepted: recent.filter((d) => d.decision === 'accepted').length,
    declined: recent.filter((d) => d.decision === 'declined').length,
    reasons: Object.fromEntries(
      DECLINE_REASONS
        .map((r) => [r.id, recent.filter((d) => d.reason === r.id).length])
        .filter(([, n]) => n > 0),
    ),
    splitSatisfaction: mean(rated('splitSatisfaction')),
    suggestionRating: mean(rated('suggestionRating')),
    notes: recent.map((d) => d.note).filter(Boolean),
  };
}

/* ------------------------------ what to change ---------------------------- */

const historyFor = (sessions, exerciseId) =>
  (sessions ?? [])
    .filter((s) => (s?.sets ?? []).some((x) => x?.exerciseId === exerciseId && Number(x.reps) > 0))
    .sort((a, b) => String(a?.startedAt ?? a?.date ?? '').localeCompare(String(b?.startedAt ?? b?.date ?? '')))
    .map((s) => ({
      date: String(s.startedAt ?? s.date ?? '').slice(0, 10),
      sets: (s.sets ?? []).filter((x) => x.exerciseId === exerciseId),
    }));

/**
 * Something else for the same muscle group that is not already in the week.
 *
 * Not already in the week, because two slots doing the same lift is a day that
 * trains one thing twice and calls it variety. Not retired, because those are out
 * of the pickers for a reason. Preferring the least-recently trained gives the
 * swap its best chance of being a genuine change of stimulus rather than a
 * sideways move.
 */
function alternativeFor(exercise, { exercises, inUse, sessions }) {
  if (!exercise?.muscleGroup) return null;

  const lastTrained = new Map();
  for (const s of sessions ?? []) {
    const when = String(s?.startedAt ?? s?.date ?? '');
    for (const set of s?.sets ?? []) {
      const seen = lastTrained.get(set.exerciseId);
      if (!seen || when > seen) lastTrained.set(set.exerciseId, when);
    }
  }

  return (exercises ?? [])
    .filter((e) => e.id !== exercise.id)
    .filter((e) => !e.archived)
    .filter((e) => e.muscleGroup === exercise.muscleGroup)
    .filter((e) => !inUse.has(e.id))
    .sort((a, b) => (lastTrained.get(a.id) ?? '').localeCompare(lastTrained.get(b.id) ?? '')
      || a.id.localeCompare(b.id))[0] ?? null;
}

/** A scheme with one more working set, or nothing if there is no such thing. */
function nextSchemeUp(schemeId) {
  const sets = workingSetCount(getScheme(schemeId));
  // Only within the reverse-pyramid family: moving between families changes the
  // rep ranges too, which is a different proposal wearing this one's clothes.
  if (schemeId === 'rp-2' && sets === 2) return 'rp-3';
  return null;
}

/** Worst news first, because the cap means order decides what happens. */
const SEVERITY = { regressing: 0, 'too-fast': 1, stagnant: 2, progressing: 3, 'insufficient-data': 4 };

/**
 * What this program should change, in order, capped.
 *
 * `alternatives` and `allowVolume` exist for the tests and for the caller that
 * knows better: a caller with no library to swap into passes `alternatives: []`
 * and gets no swaps rather than a swap to nothing.
 */
export function proposeChanges({
  boot, sessions = [], now = new Date().toISOString(),
  alternatives = null, allowVolume = false, decisions = [],
} = {}) {
  const exercises = boot?.exercises ?? [];
  const days = boot?.days ?? [];
  if (!exercises.length || !days.length) return [];

  const byId = new Map(exercises.map((e) => [e.id, e]));
  const pool = alternatives ?? exercises;

  // Every lift the program currently uses, so a swap never lands on one of them.
  const inUse = new Set(days.flatMap((d) => (d.exercises ?? []).map((e) => e.exerciseId)));

  const found = [];

  for (const day of days) {
    for (const slot of day.exercises ?? []) {
      const exercise = byId.get(slot.exerciseId);
      if (!exercise) continue;

      const history = historyFor(sessions, slot.exerciseId);
      if (history.length < MIN_SESSIONS) continue;

      const verdict = analyzeExercise({
        name: exercise.name, exerciseId: exercise.id, history,
      });

      // Nothing is ever done to a lift that is working. This is the most important
      // line here: touching something that is progressing is worse than doing
      // nothing at all.
      if (verdict.status === 'progressing') {
        if (!allowVolume) continue;

        const up = nextSchemeUp(slot.schemeId);
        if (!up) continue;

        found.push({
          id: `add-set:${day.id}:${slot.exerciseId}`,
          kind: 'add-set',
          severity: SEVERITY[verdict.status],
          dayId: day.id,
          exerciseId: slot.exerciseId,
          name: exercise.name,
          reason: `${exercise.name} is climbing at about ${verdict.percentPerSession.toFixed(1)}% a session `
            + `and the reps are holding. That is a lift with room for more work, so this adds a third `
            + `working set rather than more weight — the weight is already going up on its own.`,
          apply: { schemeId: up },
        });
        continue;
      }

      if (verdict.status === 'insufficient-data') continue;

      const advice = loadAdvice({
        history,
        scheme: getScheme(slot.schemeId),
        exerciseId: slot.exerciseId,
        equipment: slot.equipment ?? {},
      });

      if (advice.action === 'lighter') {
        // How far back is taken from the advice where it has an opinion, so the
        // number here and the number on the Coach tab cannot disagree.
        const top = history[history.length - 1]?.sets?.[0]?.weight;
        const suggested = numeric(advice.suggestedWeight);
        const current = numeric(top);

        const pct = suggested !== null && current !== null && current > 0
          ? Math.min(MAX_DELOAD_PCT, Math.max(1, Math.round((1 - suggested / current) * 100)))
          : DELOAD_PCT;

        found.push({
          id: `deload:${day.id}:${slot.exerciseId}`,
          kind: 'deload',
          severity: SEVERITY[verdict.status],
          dayId: day.id,
          exerciseId: slot.exerciseId,
          name: exercise.name,
          reason: `${advice.reason} This takes ${pct}% off the next time it comes up, once.`,
          apply: { pct },
        });
        continue;
      }

      if (advice.action === 'change-stimulus') {
        const swap = alternativeFor(exercise, { exercises: pool, inUse, sessions });
        if (!swap) continue;

        found.push({
          id: `swap:${day.id}:${slot.exerciseId}`,
          kind: 'swap',
          severity: SEVERITY[verdict.status],
          dayId: day.id,
          exerciseId: slot.exerciseId,
          name: exercise.name,
          reason: `${advice.reason} So this swaps it for ${swap.name}, which trains the same `
            + `muscle group and is not already in your week.`,
          apply: { exerciseId: swap.id },
        });
      }
    }
  }

  return found
    // Already answered, and either done or not wanted. Filtered before the cap so
    // a declined suggestion does not occupy one of the two slots forever.
    .filter((p) => !isSuppressed(decisions, p.id, now))
    .sort((a, b) => a.severity - b.severity || a.exerciseId.localeCompare(b.exerciseId))
    .slice(0, MAX_CHANGES)
    .map(({ severity, ...rest }) => rest);
}

/* ------------------------------ making the change ------------------------- */

/**
 * Apply one proposal to the program.
 *
 * Returns the boot **unchanged, by identity**, whenever it cannot do exactly what
 * was asked — the slot has gone, the replacement is not a lift, the kind is not one
 * of the four. A caller can then tell the difference between "done" and "declined",
 * and nothing is half-applied. He may well have edited the day between the proposal
 * being made and this running, and quietly recreating what he deleted would
 * overwrite a decision of his with one of ours.
 */
export function applyProposal(boot, proposal) {
  const dayId = proposal?.dayId;
  const exerciseId = proposal?.exerciseId;
  if (!boot?.days || !dayId || !exerciseId) return boot;

  const day = boot.days.find((d) => d.id === dayId);
  const slot = day?.exercises?.find((e) => e.exerciseId === exerciseId);
  if (!slot) return boot;

  let next = null;

  if (proposal.kind === 'swap') {
    const replacement = (boot.exercises ?? []).find((e) => e.id === proposal.apply?.exerciseId);
    if (!replacement || replacement.archived) return boot;

    next = {
      ...slot,
      exerciseId: replacement.id,
      // The denormalised fields follow, or the screen shows the old name against
      // the new lift — which reads as the swap not having happened.
      name: replacement.name,
      muscleGroup: replacement.muscleGroup ?? null,
      // A weight for the lift that just left means nothing to the one arriving.
      deloadPct: undefined,
    };
  }

  if (proposal.kind === 'deload') {
    const pct = numeric(proposal.apply?.pct);
    if (pct === null || pct <= 0 || pct > MAX_DELOAD_PCT) return boot;
    next = { ...slot, deloadPct: pct };
  }

  if (proposal.kind === 'add-set' || proposal.kind === 'remove-set') {
    const schemeId = proposal.apply?.schemeId;
    // `getScheme` falls back rather than failing, so an unknown id would silently
    // become the default scheme — checked explicitly instead.
    if (!schemeId || getScheme(schemeId).id !== schemeId) return boot;
    next = { ...slot, schemeId };
  }

  if (!next) return boot;

  return {
    ...boot,
    days: boot.days.map((d) => (d.id !== dayId ? d : {
      ...d,
      exercises: d.exercises.map((e) => (e.exerciseId === exerciseId ? next : e)),
      // The day is his now, so a future seed update leaves it alone.
      userEdited: true,
    })),
  };
}
