/**
 * Month grids, and what was trained on each day.
 *
 * Pure so it can be tested without a browser: given sessions and a month, work
 * out the cells to draw. Dates are handled as local calendar days rather than
 * instants — a workout belongs to the day you did it, not to a timezone.
 */

const pad = (n) => String(n).padStart(2, '0');

/**
 * The local calendar day a timestamp falls on, as YYYY-MM-DD.
 *
 * A date-only string is already a calendar day and is returned untouched:
 * parsing it would read it as UTC midnight, which lands on the previous day
 * everywhere west of Greenwich.
 */
export function dayKey(iso) {
  const text = String(iso ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return text.slice(0, 10);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function monthKey(year, month) {
  return `${year}-${pad(month + 1)}`;
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Sunday-first initials, matching how the grid is drawn. */
export const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function shiftMonth(year, month, delta) {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/** Group sessions by the local day they happened on. */
export function sessionsByDay(sessions = []) {
  const byDay = new Map();
  for (const session of sessions) {
    if (!session?.startedAt) continue;
    const key = dayKey(session.startedAt);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(session);
  }
  return byDay;
}

/**
 * The cells of a month grid, padded to whole weeks so the columns line up.
 * Leading and trailing cells belong to neighbouring months and are marked.
 */
export function monthGrid(year, month, byDay = new Map()) {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const sessions = byDay.get(key) ?? [];

    cells.push({
      date: key,
      day: d.getDate(),
      inMonth: d.getMonth() === month,
      sessions,
      trained: sessions.length > 0,
    });

    // Stop at the end of the week that contains the last of the month.
    if (i >= 27 && d.getDay() === 6) {
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      if (next.getMonth() !== month) break;
    }
  }

  return cells;
}

/** The lifts in a session, in the order they were performed. */
export function liftsInSession(session, exercises = []) {
  const names = new Map(exercises.map((e) => [e.id, e.name]));
  const order = [];
  const grouped = new Map();

  for (const set of session?.sets ?? []) {
    if (!grouped.has(set.exerciseId)) {
      grouped.set(set.exerciseId, []);
      order.push(set.exerciseId);
    }
    grouped.get(set.exerciseId).push(set);
  }

  return order.map((id) => ({
    exerciseId: id,
    name: names.get(id) ?? id,
    sets: grouped.get(id).sort((a, b) => a.setIndex - b.setIndex),
  }));
}

/** The month to open on: the most recent one with a workout in it. */
export function latestMonth(sessions = [], fallback = new Date(2026, 0, 1)) {
  let newest = null;
  for (const s of sessions) {
    if (!s?.startedAt) continue;
    const d = new Date(s.startedAt);
    if (!newest || d > newest) newest = d;
  }
  const d = newest ?? fallback;
  return { year: d.getFullYear(), month: d.getMonth() };
}
