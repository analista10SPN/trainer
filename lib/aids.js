/**
 * Straps, belt, chalk — the kit that changes what a set means.
 *
 * A strapped row and a bare-handed row are not the same set. Straps take grip
 * out as the limiter, so the same load says something different about the
 * muscle actually being trained; a belt does the same for bracing on a squat.
 * Without recording it, "he added 20 lb" and "he put straps on" are the same
 * row in the log, and only one of them is progress.
 *
 * Deliberately *not* the same field as `handle` on the exercise. A rope versus
 * a wide bar changes which lift it **is** — that is identity, it belongs on the
 * exercise, and it splits the history into separate trends. Straps do not
 * change the lift, they change one set of it, and they belong on the set.
 * Collapsing the two would repeat the "two meanings of machine" tangle that
 * took a release to untangle.
 */

/** The common kit. Anything typed that is not here is still kept. */
export const AIDS = [
  { id: 'straps', label: 'Straps' },
  { id: 'belt', label: 'Belt' },
  { id: 'chalk', label: 'Chalk' },
  { id: 'wrist wraps', label: 'Wrist wraps' },
  { id: 'knee sleeves', label: 'Knee sleeves' },
  { id: 'elbow sleeves', label: 'Elbow sleeves' },
];

/** Enough for any real set; a cap so one bad paste cannot fill a row. */
const MAX_AIDS = 8;

/**
 * Clean, lowercase, dedupe, sort.
 *
 * Sorted so two sets with the same kit compare equal whatever order they were
 * tapped in — otherwise ['belt','straps'] and ['straps','belt'] would read as a
 * kit change every session.
 */
export function normaliseAids(list) {
  if (!Array.isArray(list)) return [];

  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim().toLowerCase();
    if (id) seen.add(id);
  }

  return [...seen].sort().slice(0, MAX_AIDS);
}

/** The kit on one set. Always an array, never null, so callers can map. */
export function aidsOf(set) {
  return normaliseAids(set?.aids);
}

export function describeAids(list) {
  return normaliseAids(list).join(', ');
}

/** Every session where this lift recorded any kit, oldest first. */
function aidSessions(history, exerciseId) {
  return (history ?? [])
    .map((s) => {
      const forLift = (s?.sets ?? []).filter((x) => x.exerciseId === exerciseId);
      // A session counts only if kit was actually recorded on it. Sets logged
      // before this field existed must not read as "he took his straps off".
      const recorded = forLift.some((x) => Array.isArray(x.aids));
      const used = new Set();
      for (const x of forLift) for (const a of aidsOf(x)) used.add(a);
      return { date: s?.date ?? s?.startedAt ?? '', recorded, aids: [...used].sort() };
    })
    .filter((s) => s.recorded)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/**
 * What he usually uses on this lift, for pre-filling.
 *
 * Most-used rather than most-recent, for the same reason as the machine and the
 * tempo: one session done differently because he forgot his straps should not
 * become what the app expects from then on.
 */
export function usualAids(history, exerciseId) {
  const counts = new Map();

  for (const s of aidSessions(history, exerciseId)) {
    const key = s.aids.join('|');
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let best = '';
  let bestCount = 0;
  for (const [key, n] of counts) {
    if (n > bestCount) { best = key; bestCount = n; }
  }
  return best ? best.split('|') : [];
}

/**
 * Did the kit change between the last two recorded sessions?
 *
 * The reason this field exists. A row that jumps 30 lb the week straps appear
 * is not a 30 lb stronger back, and nothing else in the data can tell you that.
 * Only counts sessions where kit was actually recorded, so the history that
 * predates the field stays silent instead of flagging every lift.
 */
export function aidsChanged(history, exerciseId) {
  const none = { changed: false, from: [], to: [], added: [], removed: [] };

  const scored = aidSessions(history, exerciseId);
  if (scored.length < 2) return none;

  const from = scored[scored.length - 2].aids;
  const to = scored[scored.length - 1].aids;

  const added = to.filter((a) => !from.includes(a));
  const removed = from.filter((a) => !to.includes(a));
  if (!added.length && !removed.length) return none;

  return { changed: true, from, to, added, removed };
}
