/**
 * Which past session is the one worth comparing today against.
 *
 * "Last time" is the line above the stepper on every lift, and it meant one
 * thing: the most recent session containing this exercise id, anywhere, on
 * anything. For a barbell that is correct — a 45 lb bar is a 45 lb bar. For a
 * lift done on a *machine* it was quietly wrong.
 *
 * 180 on the stack of a Hammer Strength pulldown is not 180 on the stack of a
 * Cybex, and neither is 180 at the other gym: different plates, different lever
 * arms, and the number painted on the stack is a label rather than a
 * measurement. The app already knew every part of this — the gym is on the
 * session, the machine is on the set, `tracksMachine` says which lifts care,
 * and the coach already prints a warning when a lift's machine changes. The one
 * place that knew none of it was the line telling you what to beat.
 *
 * ## Why this is a ladder, and why the ladder is data
 *
 * The honest answer is not a single lookup, because the most specific match is
 * often missing: first session at a new gym, first time on a machine, a lift
 * logged before the machine question existed. So it is a sequence of
 * progressively weaker questions, and the *first* one that can be asked and
 * answered wins.
 *
 * `RECALL_SCOPES` is that sequence, as an array. Each rung carries its own
 * applicability test and its own match test, and `recallLast` does nothing but
 * walk it. That shape is deliberate: the alternative is a function with three
 * nested `if`s that every future distinction has to be wedged into, and the
 * distinctions here are not finished — "same gym, any machine" is a real
 * question for barbell work, and so is "same handle". Either is one object in a
 * list, added without touching the walker or its callers.
 *
 * ## It reports the rung it landed on
 *
 * Which matters as much as the answer. A number earned on a different machine
 * is still worth showing — it is better than nothing, and refusing to show it
 * would be a regression — but showing it *as if* it were comparable is how the
 * original bug read. `fellBack` and `scope` let the screen say where the number
 * came from.
 */

import { machineKey } from './gyms.js';

/**
 * The machine a session's sets for one lift were done on.
 *
 * Most frequent rather than first, because the set-level field is written in
 * two ways: `setMachine` stamps every set already logged for the lift, so they
 * normally agree — but a machine answered mid-lift, or changed because the
 * usual one was taken, leaves a session straddling two. The majority is the one
 * the session's loads were mostly earned on.
 *
 * Ties go to the earliest set, which is the top set under reverse pyramid, and
 * therefore the one the comparison is actually about.
 */
export function machineOf(session) {
  const sets = session?.sets ?? [];

  const tally = new Map();
  for (const set of sets) {
    const name = String(set?.machine ?? '').trim();
    if (!name) continue;
    // Keyed on the folded name so that two spellings of one machine do not
    // split the vote, but the *label* kept is the one as it was typed.
    const k = machineKey(name);
    const seen = tally.get(k);
    if (seen) seen.count += 1;
    else tally.set(k, { label: name, count: 1 });
  }

  let best = null;
  for (const entry of tally.values()) {
    if (!best || entry.count > best.count) best = entry;
  }

  return best ? best.label : null;
}

/**
 * The ladder, most specific first.
 *
 * `applies(where)` asks whether the rung can be evaluated at all given what we
 * know about today — a machine rung is meaningless before the machine question
 * has been answered. `matches(past, where)` asks whether a particular past
 * session satisfies it.
 *
 * The two are separate on purpose. Collapsing them would make "we cannot ask
 * this question" and "we asked and nothing matched" the same outcome, and they
 * are not: the first should fall through silently, the second is worth telling
 * the user about.
 */
export const RECALL_SCOPES = [
  {
    id: 'gym-machine',
    applies: (where) => Boolean(where?.gymId) && Boolean(machineKey(where?.machine)),
    matches: (past, where) => past.gymId === where.gymId
      && machineKey(machineOf(past)) === machineKey(where.machine),
  },
  {
    id: 'machine',
    applies: (where) => Boolean(machineKey(where?.machine)),
    matches: (past, where) => machineKey(machineOf(past)) === machineKey(where.machine),
  },
  {
    /**
     * The floor, and the old behaviour exactly.
     *
     * It always applies and always matches, which is what guarantees that
     * adding machine-awareness can only ever *narrow* a result that existed —
     * never remove one. A lift with history always shows something.
     */
    id: 'exercise',
    applies: () => true,
    matches: () => true,
  },
];

/**
 * The most relevant past session for a lift, given where you are standing.
 *
 * @param history  oldest-first, as `historyFor` returns it: one lift's sets,
 *                 each session carrying `gymId`.
 * @param where    `{ gymId, machine }` — today. Either may be absent.
 * @param scopes   the ladder. Overridable so a caller with a different question
 *                 does not need this module to grow a flag.
 *
 * @returns `{ session, scope, fellBack }`, or `null` when nothing matched any
 *          rung that could be asked. `fellBack` is true when a more specific
 *          rung was applicable and came back empty — that is, when the number
 *          being returned was earned somewhere other than here.
 */
export function recallLast(history, where = {}, scopes = RECALL_SCOPES) {
  if (!Array.isArray(history) || history.length === 0) return null;

  let skipped = 0;

  for (const scope of scopes) {
    if (!scope.applies(where)) continue;

    // Backwards, because `historyFor` is oldest-first and the answer is the
    // most recent match. A reverse walk rather than a sort: sorting a caller's
    // array in place would silently flip the order every trend downstream
    // assumes, and copying it to sort is work done on every render.
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const past = history[i];
      if (scope.matches(past, where)) {
        return { session: past, scope: scope.id, fellBack: skipped > 0 };
      }
    }

    // Asked, and answered with nothing. That is the fact `fellBack` reports.
    skipped += 1;
  }

  return null;
}
