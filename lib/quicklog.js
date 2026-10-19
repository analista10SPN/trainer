/**
 * A whole session as a few lines of text.
 *
 *   2026-08-13 upper-1
 *   incline-db-press 200x8 200x7 140x9
 *   lat-pulldown 200x11 200x8 160x7
 *
 * The phone owns the data and there is no server to write into, so this is how
 * a session that happened away from the app gets in. Exercises can be named or
 * given by id, and any number of sets is fine — real sessions do not match the
 * set count a template prescribed.
 */

const SET = /^(\d+(?:\.\d+)?)x(\d+)$/i;

const normalise = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

/** A session imported twice must land on the same row, not duplicate. */
function sessionId(date, dayId) {
  return `ql-${date}-${dayId}`;
}

export function parseQuickLog(text, { exercises = [], days = [] } = {}) {
  const errors = [];
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  if (!lines.length) return { session: null, errors: ['Nothing to import.'] };

  const header = lines[0].match(/^(\d{4}-\d{2}-\d{2})\s+(\S+)$/);
  if (!header) {
    return {
      session: null,
      errors: ['First line must be a date and a day, like: 2026-08-13 upper-1'],
    };
  }

  const [, date, dayId] = header;
  const day = days.find((d) => d.id === dayId);
  if (!day) errors.push(`No such day: ${dayId}`);

  const byId = new Map(exercises.map((e) => [e.id, e]));
  const byName = new Map(exercises.map((e) => [normalise(e.name), e]));

  const sets = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/);

    // The exercise may be an id, or a name with spaces; take the longest
    // leading run of words that still resolves to something in the library.
    let lift = null;
    let rest = [];
    for (let take = parts.length; take >= 1; take--) {
      const candidate = parts.slice(0, take).join(' ');
      const found = byId.get(candidate.trim()) ?? byName.get(normalise(candidate));
      if (found) {
        lift = found;
        rest = parts.slice(take);
        break;
      }
    }

    if (!lift) {
      errors.push(`Unknown exercise on line: ${line}`);
      continue;
    }
    if (!rest.length) {
      errors.push(`No sets given for ${lift.name}`);
      continue;
    }

    let index = 0;
    for (const token of rest) {
      const m = token.match(SET);
      if (!m) {
        errors.push(`Could not read set "${token}" on line: ${line}`);
        continue;
      }
      index++;
      sets.push({
        id: `${sessionId(date, dayId)}-${lift.id}-${index}`,
        exerciseId: lift.id,
        setIndex: index,
        weight: Number(m[1]),
        reps: Number(m[2]),
        barType: lift.barType ?? null,
        /**
         * No `loggedAt`. A pasted line says what was lifted, not when.
         *
         * Every set used to be stamped at the session start — one fabricated
         * instant, identical for all of them — and two things downstream read
         * that as fact. The history screen flagged *"Finish was tapped 60 min
         * after the last set"* on every imported day, offering to fix something
         * that was not wrong. And `sessionBurn` caps a session at the last set
         * plus five minutes, so every import came to five minutes, fell under the
         * ten-minute floor and returned null — silently dropping the whole
         * lifting burn from any day containing a pasted workout, while the
         * deficit arithmetic ran against the wrong number.
         *
         * Absent is the honest answer, and all three consumers already guard for
         * a missing timestamp.
         */
      });
    }
  }

  if (!day) return { session: null, errors };

  return {
    session: {
      id: sessionId(date, dayId),
      dayId,
      dayName: day.name,
      startedAt: `${date}T12:00:00.000Z`,
      finishedAt: `${date}T13:00:00.000Z`,
      notes: '',
      sets,
    },
    errors,
  };
}

/** The inverse, so a session can be shown, copied, or re-imported. */
export function formatQuickLog(session, { exercises = [] } = {}) {
  if (!session) return '';
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const date = String(session.startedAt).slice(0, 10);

  const order = [];
  const grouped = new Map();
  for (const set of session.sets ?? []) {
    if (!grouped.has(set.exerciseId)) {
      grouped.set(set.exerciseId, []);
      order.push(set.exerciseId);
    }
    grouped.get(set.exerciseId).push(set);
  }

  const lines = [`${date} ${session.dayId}`];
  for (const id of order) {
    const sets = grouped.get(id).sort((a, b) => a.setIndex - b.setIndex);
    lines.push(`${byId.get(id)?.id ?? id} ${sets.map((s) => `${s.weight}x${s.reps}`).join(' ')}`);
  }
  return lines.join('\n');
}
