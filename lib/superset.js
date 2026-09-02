/**
 * Supersets: two or more lifts trained back to back, resting only after the
 * round.
 *
 * The template carries a default pairing and the session can regroup, because
 * the reason to break a superset — the other machine is taken — only shows up
 * once you are standing in front of it.
 *
 * Nothing here changes how a set is stored. A superset changes what comes next,
 * and when the clock starts.
 */

/** Exercises sharing an id, in the order they appear. */
export function groupsOf(exercises = []) {
  const groups = new Map();

  exercises.forEach((exercise, index) => {
    const id = exercise?.supersetId;
    if (!id) return;
    if (!groups.has(id)) groups.set(id, { id, indices: [] });
    groups.get(id).indices.push(index);
  });

  // A group of one is not a superset. It is a lift whose partner was removed.
  return [...groups.values()].filter((g) => g.indices.length > 1);
}

/** The group an exercise belongs to, or null. */
export function groupAt(exercises = [], index) {
  const id = exercises[index]?.supersetId;
  if (!id) return null;
  return groupsOf(exercises).find((g) => g.indices.includes(index)) ?? null;
}

/** Position in the round, for labelling: A, B, C. */
export function positionIn(group, index) {
  const at = group?.indices.indexOf(index) ?? -1;
  return at === -1 ? null : String.fromCharCode(65 + at);
}

const remaining = (state) => (state?.logged ?? []).filter((v) => v == null).length;

/**
 * What to do once a set is logged.
 *
 * Alone, that means rest and stay put. Inside a superset it means move to the
 * next lift in the round with no rest, and only start the clock once the round
 * is complete.
 *
 * @param exercises the session's exercises, in order
 * @param stateOf   (index) => that exercise's { logged: [] }
 * @param index     the exercise just logged into
 */
export function nextAfterSet(exercises = [], stateOf = () => null, index = 0) {
  const group = groupAt(exercises, index);
  if (!group) return { index, rest: true, reason: 'single' };

  const at = group.indices.indexOf(index);
  const after = group.indices.slice(at + 1);

  // Still someone left in this round: straight there, no rest.
  const next = after.find((i) => remaining(stateOf(i)) > 0);
  if (next !== undefined) return { index: next, rest: false, reason: 'next-in-round' };

  // Round complete. Rest, then back to whoever still has sets left.
  const restart = group.indices.find((i) => remaining(stateOf(i)) > 0);
  if (restart !== undefined) return { index: restart, rest: true, reason: 'round-complete' };

  return { index, rest: true, reason: 'group-done' };
}

/** Is every lift in this group finished? */
export function groupComplete(group, stateOf = () => null) {
  return (group?.indices ?? []).every((i) => remaining(stateOf(i)) === 0);
}

/**
 * Pair the given exercises together.
 *
 * Supersets are contiguous by nature — you are walking between two stations —
 * so grouping non-adjacent lifts moves them together rather than leaving a gap
 * that reads as an ordering bug.
 */
export function makeSuperset(exercises = [], indices = [], id = `ss-${Date.now().toString(36)}`) {
  const chosen = [...new Set(indices)].filter((i) => i >= 0 && i < exercises.length).sort((a, b) => a - b);
  if (chosen.length < 2) return exercises;

  const [first] = chosen;
  const moving = chosen.map((i) => ({ ...exercises[i], supersetId: id }));
  const rest = exercises.filter((_, i) => !chosen.includes(i));

  // Land the block where the first member was.
  const before = rest.filter((_, i) => exercises.indexOf(rest[i]) < first);
  const insertAt = exercises.slice(0, first).filter((e) => !chosen.includes(exercises.indexOf(e))).length;
  void before;

  return [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
}

/** Break a group apart, leaving the lifts where they are. */
export function breakSuperset(exercises = [], supersetId) {
  return exercises.map((e) => (e.supersetId === supersetId ? { ...e, supersetId: null } : e));
}
