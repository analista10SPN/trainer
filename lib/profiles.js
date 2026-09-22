/**
 * Trends per machine, and per muscle group above that.
 *
 * The problem this solves: a lat pulldown on one cable stack is not the same
 * load as on another. Pulley ratios differ, stack increments differ, and the
 * same effort reads as a different number. A trend computed across both is
 * measuring which machine was free, not whether he got stronger.
 *
 * Splitting by machine fixes the comparison and fragments the picture — five
 * lifts become twelve thin series, none with enough sessions to trend. So the
 * split is only half of it: `groupTrends` puts them back together at the muscle
 * group, indexing each profile to its own baseline first. That is the same
 * trick that already lets a 400 lb leg press and a 20 lb lateral raise be added
 * without the press drowning everything.
 *
 * A "profile" is one (exercise, machine) pair. Sets logged before machines were
 * recorded keep their own profile rather than being folded into whichever
 * machine came later, because that would invent a comparison never made.
 */

import { bestPreciseE1RM, percentSlope } from './strength.js';

/** What the unmachined history is called on screen. */
export const UNSPECIFIED = 'machine not recorded';

const clean = (name) => String(name ?? '').trim();
const key = (name) => clean(name).toLowerCase();

export function profileKey(exerciseId, machine) {
  return `${exerciseId}::${key(machine)}`;
}

/**
 * Every (exercise, machine) pair with enough history to say something.
 *
 * Sessions are split rather than filtered: one workout where the usual machine
 * was taken for the top set only belongs to both profiles, each holding just
 * the sets actually done on it.
 */
export function profilesFrom(sessions, { minSessions = 3, exercises = [] } = {}) {
  const names = new Map((exercises ?? []).map((e) => [e.id, e.name]));
  const found = new Map();

  const ordered = (sessions ?? [])
    .filter((s) => Array.isArray(s?.sets) && s.sets.length)
    .sort((a, b) => String(a?.startedAt ?? a?.date ?? '').localeCompare(String(b?.startedAt ?? b?.date ?? '')));

  for (const session of ordered) {
    const date = String(session.startedAt ?? session.date ?? '').slice(0, 10);

    // One bucket per (lift, machine) within this session.
    const buckets = new Map();
    for (const set of session.sets) {
      if (!set?.exerciseId) continue;
      const machine = clean(set.machine) || null;
      const id = profileKey(set.exerciseId, machine);

      if (!buckets.has(id)) buckets.set(id, { exerciseId: set.exerciseId, machine, sets: [] });
      buckets.get(id).sets.push(set);
    }

    for (const [id, bucket] of buckets) {
      if (!found.has(id)) {
        found.set(id, {
          key: id,
          exerciseId: bucket.exerciseId,
          machine: bucket.machine,
          name: names.get(bucket.exerciseId) ?? bucket.exerciseId,
          history: [],
        });
      }
      found.get(id).history.push({ date, sets: bucket.sets });
    }
  }

  return [...found.values()]
    .filter((p) => p.history.length >= minSessions)
    .map((p) => ({
      ...p,
      label: `${p.name} · ${p.machine ?? UNSPECIFIED}`,
      sessions: p.history.length,
      percentPerSession: percentSlope(
        p.history.map((h) => bestPreciseE1RM(h.sets)).filter((v) => v > 0),
      ),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The middle value. Used rather than the mean, for the usual reason. */
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Roll the profiles up to muscle groups.
 *
 * The rate of each profile is already a percentage of its own baseline, so they
 * are directly comparable whatever the machine or the absolute load. The median
 * of those rates is the group's rate: one profile collapsing — which is exactly
 * what changing machines looks like — cannot swing the whole group.
 */
export function groupTrends(profiles, exercises = []) {
  const groupOf = new Map((exercises ?? []).map((e) => [e.id, e.muscleGroup]));
  const byGroup = new Map();

  for (const p of profiles ?? []) {
    if (!p?.exerciseId) continue;
    const group = groupOf.get(p.exerciseId) || 'unsorted';
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(p);
  }

  return [...byGroup.entries()]
    .map(([muscleGroup, members]) => {
      const rate = Math.round(median(members.map((m) => m.percentPerSession)) * 10) / 10;
      return {
        muscleGroup,
        profiles: members.length,
        machines: new Set(members.map((m) => m.machine).filter(Boolean)).size,
        percentPerSession: rate,
        status: rate >= 1 ? 'progressing' : rate > -1 ? 'stagnant' : 'regressing',
        members: members.slice().sort((a, b) => a.percentPerSession - b.percentPerSession),
      };
    })
    .sort((a, b) => a.percentPerSession - b.percentPerSession);
}
