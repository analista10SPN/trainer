/**
 * A program per week, and nothing more than that.
 *
 * The ask was "program 1a, 1b, 1c, 1d, up to the amount the coach wants, no
 * limit" — a block that runs week by week rather than one program followed
 * whenever you like. It arrived with a constraint attached, and the constraint
 * is what decided this design: *it needs to remain super simple and easily
 * readable.*
 *
 * So a schedule is **an ordered list of program ids and a start date**. That is
 * the whole model. Week zero is the first entry, week one the second, and when
 * the list runs out it begins again — a four-week block repeats, which is what
 * a block is for.
 *
 * ## What this deliberately is not
 *
 * **Not a calendar of assignments.** A record per week needs a row for every
 * week forever, an answer for the weeks nobody filled in, and an edit screen
 * that is a date picker. All of it buys the ability to say "week seven is 1c
 * rather than 1b", which reordering a list of four already says.
 *
 * **Not tied to finishing the work.** Advancing when a week's days are all done
 * is kinder to a missed week, and it needs completion tracking, a definition of
 * "done enough", and a rule for somebody who trains eight days in one week. The
 * calendar is the one thing the coach and the trainee can both already see.
 *
 * ## The boundary is `week.js`'s boundary
 *
 * Weeks here start on Monday in local time, because `weekStart` says so and
 * because every other weekly figure in this app is already counted that way.
 * Two definitions of "this week" in one app is how a screen comes to disagree
 * with the screen next to it.
 *
 * ## It is off unless it is on
 *
 * An empty or absent schedule means the single active program applies, exactly
 * as it did before this file existed. Everything here answers `null` rather
 * than guessing, because somebody with no schedule has not asked for one.
 */

import { weekStart } from './week.js';

const DAY_MS = 86400000;

/**
 * Whole weeks from the week containing `startedAt` to the week containing
 * `now`. The starting week is zero.
 *
 * Counted between **week boundaries**, not as elapsed time. Seven days after a
 * Monday morning is the following Monday, but seven days after a Friday evening
 * is still the same training week to everybody except a subtraction — and
 * `nextUp`, `sessionsThisWeek` and the Train header all already agree that a
 * week is Monday to Sunday.
 *
 * A date before the start is week zero rather than a negative week: a schedule
 * that has not begun yet is a schedule sitting on its first entry, not one
 * reading backwards off the end of its own list.
 */
export function weeksBetween(startedAt, now = new Date()) {
  const started = Date.parse(startedAt ?? '');
  if (!Number.isFinite(started)) return null;

  const from = Date.parse(`${weekStart(new Date(started))}T00:00:00`);
  const to = Date.parse(`${weekStart(now)}T00:00:00`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;

  return Math.max(0, Math.round((to - from) / (7 * DAY_MS)));
}

/**
 * The program this week calls for, or null.
 *
 * A hole in the list — a program since deleted — stays a hole. Closing it up
 * would shift every later week by one, which is a silent rewrite of a plan
 * somebody wrote down; an empty week is visible and fixable, and the screen
 * says so rather than quietly training the wrong block.
 */
export function scheduledProgramId(plan, now = new Date()) {
  const list = plan?.schedule;
  if (!Array.isArray(list) || !list.length) return null;

  const weeks = weeksBetween(plan?.startedAt, now);
  if (weeks === null) return null;

  return list[weeks % list.length] ?? null;
}

/**
 * The same answer, in words a screen can print.
 *
 * `week` counts **within the block**, so a four-week block in its sixth week
 * reads "week 2 of 4" rather than "week 6 of 4". A number that contradicts the
 * number beside it is a number people stop reading.
 *
 * `nameOf` is passed in rather than looked up, because this module knows about
 * ids and the program list belongs to the caller — the same split that keeps
 * every other pure module here testable without a bootstrap.
 */
export function describeSchedule(plan, nameOf = () => null, now = new Date()) {
  const list = plan?.schedule;
  if (!Array.isArray(list) || !list.length) return null;

  const weeks = weeksBetween(plan?.startedAt, now);
  if (weeks === null) return null;

  const at = weeks % list.length;
  const id = list[at] ?? null;
  const name = id ? (nameOf(id) ?? null) : null;

  return {
    week: at + 1,
    of: list.length,
    id,
    name,
    says: name
      ? `Week ${at + 1} of ${list.length} — ${name}`
      : `Week ${at + 1} of ${list.length} — that program is missing, so nothing is scheduled`,
  };
}
