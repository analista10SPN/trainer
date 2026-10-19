/**
 * What to train today.
 *
 * The concept the app has been missing. `daysPerWeek` has sat on the program
 * object since the start, read in three places, none of which schedule anything
 * — so the Train tab renders a flat list of every day in every program and you
 * choose. For somebody who knows their split that is correct, and for anybody
 * else it is nine undifferentiated choices on the first screen.
 *
 * Everything here is a pure function of (days, sessions, now). It computes a
 * suggestion; it does not make a decision. The Train tab still lists every day
 * and any of them can still be started — the point is to answer the question for
 * somebody who does not yet have an answer, not to take the choice away from
 * somebody who does.
 *
 * **It must never block and never fail.** An unanswered prompt must not mean "no
 * program" in a gym with no signal, so every path here returns a usable shape.
 */

/**
 * The Monday of the week a moment falls in, as a local calendar date.
 *
 * Local, not UTC, for the same reason `todayISO` is: a Sunday-night answer in
 * UTC-4 belongs to the week the person is living in, not the one the server is.
 */
export function weekStart(now = new Date()) {
  const d = new Date(now);
  // getDay(): 0 is Sunday. Shift so Monday is 0 and Sunday is 6.
  const offset = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Sessions that happened in the week containing `now`. */
export function sessionsThisWeek(sessions = [], now = new Date()) {
  const start = weekStart(now);
  const end = weekStart(new Date(new Date(now).getTime() + 7 * 86400000));

  return (Array.isArray(sessions) ? sessions : []).filter((s) => {
    const date = String(s?.startedAt ?? '').slice(0, 10);
    return date >= start && date < end;
  });
}

/** Which days have been trained in the week containing `now`. */
export function trainedThisWeek(sessions = [], now = new Date()) {
  return new Set(sessionsThisWeek(sessions, now).map((s) => s?.dayId).filter(Boolean));
}

/** The split in the order the program gave it. */
const inOrder = (days = []) =>
  [...(Array.isArray(days) ? days : [])].sort((a, b) => (a?.position ?? 0) - (b?.position ?? 0));

/**
 * The day to suggest next, and why.
 *
 * The first day of the split **not yet trained this week** — not the one after
 * whatever was trained last. Training out of order is normal and allowed (skip
 * the row machine because somebody is on it, come back to it), so "what is left"
 * is the honest question and "what comes after the last one" is not.
 *
 * `plannedDays` caps it. "I can only train twice this week" means two days and
 * then nothing, rather than two days and a silent third suggestion on Thursday.
 */
export function nextUp({ days = [], sessions = [], now = new Date(), plannedDays = null } = {}) {
  const split = inOrder(days);
  if (!split.length) return { dayId: null, day: null, reason: 'no-program' };

  const done = trainedThisWeek(sessions, now);
  const cap = Number.isFinite(plannedDays) && plannedDays > 0
    ? Math.min(plannedDays, split.length)
    : split.length;

  if (done.size >= cap) return { dayId: null, day: null, reason: 'week-complete' };

  const next = split.slice(0, cap).find((d) => !done.has(d.id));
  if (!next) return { dayId: null, day: null, reason: 'week-complete' };

  return {
    dayId: next.id,
    day: next,
    reason: done.size === 0 ? 'first-of-week' : 'next-in-split',
  };
}

/**
 * The week as a list: what is done, what is next, what is left.
 *
 * `later` rather than `skipped` for days beyond a shortened week. They are still
 * real days of the split and nobody intended to do them — calling that skipped
 * would be the app telling somebody off for keeping to their own plan.
 */
export function weekPlan({ days = [], sessions = [], now = new Date(), plannedDays = null } = {}) {
  const split = inOrder(days);
  const done = trainedThisWeek(sessions, now);
  const next = nextUp({ days, sessions, now, plannedDays });

  const cap = Number.isFinite(plannedDays) && plannedDays > 0
    ? Math.min(plannedDays, split.length)
    : split.length;

  return {
    weekStart: weekStart(now),
    planned: cap,
    done: split.slice(0, cap).filter((d) => done.has(d.id)).length,
    complete: next.dayId === null && split.length > 0,
    nextDayId: next.dayId,
    reason: next.reason,
    days: split.map((d, i) => ({
      dayId: d.id,
      name: d.name,
      state: done.has(d.id) ? 'done'
        : d.id === next.dayId ? 'next'
          : i >= cap ? 'later'
            : 'todo',
    })),
  };
}
