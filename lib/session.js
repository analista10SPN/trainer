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
