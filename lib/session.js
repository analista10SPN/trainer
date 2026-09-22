/**
 * Repairing an in-progress workout saved by an older version of the app.
 *
 * A session lives on the phone across app updates — you can start one, the app
 * updates overnight, and you finish it the next day. So the shape written to
 * storage is a contract with the past: anything the current code reads has to
 * be reconstructed for sessions that predate it, or the app dies on launch
 * holding a workout you cannot see or finish.
 */

export const SESSION_VERSION = 2;

/** Slots used to be implicit in the template; now the session owns them. */
function slotsFromPlan(planned) {
  return (planned?.working ?? []).map((w) => ({
    pct: w.pct,
    repMin: w.repMin,
    repMax: w.repMax,
    note: w.note,
  }));
}

/**
 * Returns a session that the current code can render, or null if it is too
 * damaged to be worth keeping. Never throws: a bad session must not be able to
 * stop the app from starting.
 */
export function migrateActiveSession(active) {
  try {
    if (!active || typeof active !== 'object') return null;
    if (!Array.isArray(active.plan?.exercises) || !active.plan.exercises.length) return null;

    const ex = { ...(active.ex ?? {}) };

    for (const planned of active.plan.exercises) {
      const key = planned?.dayExerciseId;
      if (!key) return null;

      const previous = ex[key] ?? {};
      const slots = Array.isArray(previous.slots) && previous.slots.length
        ? previous.slots
        : slotsFromPlan(planned);

      const weights = Array.isArray(previous.weights) ? [...previous.weights] : [];
      const logged = Array.isArray(previous.logged) ? [...previous.logged] : [];

      // A set that was added mid-workout can leave the arrays longer than the
      // template; keep every one, and pad whatever is short.
      const size = Math.max(slots.length, weights.length, logged.length);
      while (slots.length < size) slots.push(slots[slots.length - 1] ?? { pct: 1, repMin: 6, repMax: 12, note: 'Extra set' });
      while (weights.length < size) weights.push(weights[weights.length - 1] ?? null);
      while (logged.length < size) logged.push(null);

      ex[key] = { slots, weights, logged, repDraft: previous.repDraft ?? null };
    }

    const count = active.plan.exercises.length;
    const exIndex = Number.isInteger(active.exIndex) ? Math.min(Math.max(active.exIndex, 0), count - 1) : 0;

    return {
      ...active,
      ex,
      exIndex,
      sets: Array.isArray(active.sets) ? active.sets : [],
      version: SESSION_VERSION,
    };
  } catch {
    return null;
  }
}

/* ---------------------------- editing set lists --------------------------- */

/**
 * Remove one set from an exercise, mid-session.
 *
 * Two things have to stay in step: the slot list the screen draws from, and the
 * logged sets, which are the actual record. Removing a set that was already
 * logged means renumbering the ones after it, or the log ends up with a gap
 * where set 2 used to be and every later set claims the wrong position.
 */
export function removeSetAt(exerciseState, sets = [], exerciseId, index) {
  const st = exerciseState;
  if (!st || index < 0 || index >= st.slots.length) return { state: st, sets };

  // One set is the minimum; an exercise with none should be removed instead.
  if (st.slots.length <= 1) return { state: st, sets };

  const nextState = {
    ...st,
    slots: st.slots.filter((_, i) => i !== index),
    weights: st.weights.filter((_, i) => i !== index),
    logged: st.logged.filter((_, i) => i !== index),
  };

  const removedNumber = index + 1;
  const nextSets = sets
    .filter((s) => !(s.exerciseId === exerciseId && s.setIndex === removedNumber))
    .map((s) =>
      s.exerciseId === exerciseId && s.setIndex > removedNumber
        ? { ...s, setIndex: s.setIndex - 1 }
        : s,
    );

  return { state: nextState, sets: nextSets };
}

/**
 * Add a slot after the last one, carrying the weight forward.
 *
 * The set that follows is almost always at the same load, so guessing anything
 * else would cost a correction every time.
 */
export function addSetTo(exerciseState) {
  const st = exerciseState;
  if (!st) return st;

  const last = st.slots[st.slots.length - 1] ?? { pct: 1, repMin: 6, repMax: 12 };
  return {
    ...st,
    slots: [...st.slots, { ...last, note: 'Extra set' }],
    weights: [...st.weights, st.weights[st.weights.length - 1] ?? null],
    logged: [...st.logged, null],
  };
}

/* ------------------ a pull must not erase what the server lost ------------- */

/** Keep local values for keys the incoming row does not mention at all. */
function keepMissing(local, remote) {
  if (!local || typeof local !== 'object') return remote;
  const merged = { ...remote };

  for (const [key, value] of Object.entries(local)) {
    // Null counts as absent, not as "cleared". This API returns null for every
    // value it does not have — `parseJSON(row.checkin, null)`, `row.gym_id ??
    // null` — so the two are genuinely indistinguishable on the wire.
    //
    // The cost is that a field cannot be cleared from somewhere else. That is
    // the right trade here: the phone is the source of truth and the cloud is
    // a backup, there is no second device, and the failure being prevented is
    // silent data loss.
    if (merged[key] == null && value != null) merged[key] = value;
  }
  return merged;
}

/**
 * Fold a session pulled from the server onto the copy already on the phone.
 *
 * Client and server deploy separately, so there is always a window where the
 * phone knows about a field the cloud does not — and during that window a naive
 * pull erases it. That is not hypothetical: the gym, the machine, the tempo and
 * the per-set feel were all recorded on the phone, dropped by the server on
 * write, and then overwritten locally by the very next pull.
 *
 * The server wins on everything it actually sent. It only loses on fields it
 * never mentioned, which is exactly the version-skew case.
 */
export function mergeRemoteSession(local, remote) {
  if (!remote || typeof remote !== 'object') return remote;
  if (!local || typeof local !== 'object') return remote;

  const merged = keepMissing(local, remote);

  if (Array.isArray(remote.sets)) {
    const mine = new Map((local.sets ?? []).map((s) => [s?.id, s]));
    // Driven by the remote list, so a set deleted elsewhere stays deleted.
    merged.sets = remote.sets.map((s) => keepMissing(mine.get(s?.id), s));
  }

  return merged;
}
