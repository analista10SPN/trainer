/**
 * Gyms, and which machine each lift gets done on at each of them.
 *
 * Three gyms, visited unpredictably. So the gym is *asked* at the start of
 * every workout and never inferred — the coordinates recorded alongside exist
 * only to pre-select the likely answer next time. That ordering is deliberate:
 * a gym that guesses wrong and is never questioned mislabels a whole session,
 * and the label is what every machine prediction hangs off afterwards.
 *
 * What is stored is a position *per gym*, averaged over visits — not a position
 * per session. Knowing where the gym is costs nothing; a log of when you were
 * where is a different thing entirely, and this app has no use for it.
 */

import { numeric } from './strength.js';

/** Beyond this, "you are probably at this gym" stops being a fair guess. */
const NEAR_METERS = 250;

/** A phone that reports worse accuracy than this is not locating a building. */
const USABLE_ACCURACY = 200;

const key = (name) => String(name ?? '').trim().toLowerCase();

export function makeGym(name, id = `gym-${key(name).replace(/[^a-z0-9]+/g, '-')}`) {
  return {
    id,
    name: String(name ?? '').trim(),
    lat: null,
    lon: null,
    fixes: 0,
    /** exerciseId -> { [machine name]: times used } */
    machines: {},
  };
}

/**
 * Fold one position reading into a gym's running average.
 *
 * Averaged rather than overwritten because a single fix taken indoors, on a
 * cold GPS, can be a kilometre out — and one such fix as the stored position
 * would break the pre-selection for every visit afterwards.
 */
export function recordFix(gym, fix) {
  const lat = numeric(fix?.lat);
  const lon = numeric(fix?.lon);
  if (lat === null || lon === null) return gym;

  const accuracy = numeric(fix?.accuracy);
  if (accuracy !== null && accuracy > USABLE_ACCURACY) return gym;

  const n = gym.fixes ?? 0;
  if (!n) return { ...gym, lat, lon, fixes: 1 };

  return {
    ...gym,
    lat: (gym.lat * n + lat) / (n + 1),
    lon: (gym.lon * n + lon) / (n + 1),
    fixes: n + 1,
  };
}

/** Haversine. Metres, because "0.0002 degrees" means nothing to anyone. */
export function distanceMeters(a, b) {
  const lat1 = numeric(a?.lat), lon1 = numeric(a?.lon);
  const lat2 = numeric(b?.lat), lon2 = numeric(b?.lon);
  if ([lat1, lon1, lat2, lon2].some((v) => v === null)) return Infinity;

  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The gym you are probably standing in, or null.
 *
 * Null is a real answer and the common one — at home, on the way, at a gym
 * never visited before. A wrong pre-selection is worse than none, because it is
 * the one thing you might not read before tapping start.
 */
export function nearestGym(gyms = [], position, maxMeters = NEAR_METERS) {
  let best = null;
  let bestDistance = Infinity;

  for (const gym of gyms) {
    if (!gym?.fixes) continue;
    const d = distanceMeters(gym, position);
    if (d < bestDistance) { best = gym; bestDistance = d; }
  }

  return bestDistance <= maxMeters ? best : null;
}

/* -------------------------------- machines -------------------------------- */

/** Every machine name known at this gym, for the picker. */
export function allMachinesAt(gym) {
  const names = new Map();
  for (const byMachine of Object.values(gym?.machines ?? {})) {
    for (const name of Object.keys(byMachine)) names.set(key(name), name);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Note that a lift was done on a machine here.
 *
 * Names are folded case- and space-insensitively: typed on a phone between
 * sets, "Hammer Strength" and "hammer strength " are the same machine, and
 * letting them split would put a stranger in the picker every other week.
 */
export function rememberMachine(gym, exerciseId, machine) {
  const name = String(machine ?? '').trim();
  if (!name || !exerciseId) return gym;

  const forLift = { ...(gym.machines?.[exerciseId] ?? {}) };
  const existing = Object.keys(forLift).find((n) => key(n) === key(name));
  const canonical = existing ?? name;

  forLift[canonical] = (forLift[canonical] ?? 0) + 1;
  return { ...gym, machines: { ...(gym.machines ?? {}), [exerciseId]: forLift } };
}

/**
 * The machine this lift is most often done on here.
 *
 * Most-used, not most-recent: using the free one twice because the usual was
 * busy should not permanently change what the app expects.
 */
export function predictMachine(gym, exerciseId) {
  const forLift = gym?.machines?.[exerciseId];
  if (!forLift) return null;

  let best = null;
  let bestCount = 0;
  for (const [name, count] of Object.entries(forLift)) {
    if (count > bestCount) { best = name; bestCount = count; }
  }
  return best;
}

/**
 * Did this lift change machines between its last two sessions?
 *
 * The coach needs this to avoid reading a gym change as a collapse. A lift that
 * drops 30% because the cable stack is different is not a regression, and
 * calling it one is how a useful warning becomes noise you learn to ignore.
 *
 * Only reports a change when *both* sessions recorded a machine — most history
 * predates machines being recorded at all, and treating "unknown" as a change
 * would put a warning on every lift in the app.
 */
export function machineChanged(sessions, exerciseId) {
  const none = { changed: false, from: null, to: null };

  const machineIn = (session) =>
    (session.sets ?? []).find((s) => s.exerciseId === exerciseId && s.machine)?.machine ?? null;

  const withLift = (sessions ?? [])
    .filter((s) => (s?.sets ?? []).some((x) => x.exerciseId === exerciseId))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  if (withLift.length < 2) return none;

  const to = machineIn(withLift[withLift.length - 1]);
  const from = machineIn(withLift[withLift.length - 2]);
  if (!to || !from || key(to) === key(from)) return none;

  return { changed: true, from, to };
}

/**
 * Is this a lift where the specific machine matters?
 *
 * Bar type alone cannot answer it: `stack` covers both a pin-loaded cable
 * column and a pair of dumbbells, and those are opposite answers. So this is a
 * guess on the name, and it will be wrong somewhere — which is why an explicit
 * `tracksMachine` on the exercise always wins. Getting it wrong in the asking
 * direction is the expensive one: a prompt that appears every session on a
 * barbell bench press is one you learn to tap through without reading.
 */
const FREEWEIGHT = /\b(dumbbell|dumbell|db|barbell|kettlebell|ez bar)\b/i;
const MACHINE = /\b(machine|cable|smith|pulldown|pulley|press|extension|curl|row|fly|pushdown|raise)\b/i;

export function tracksMachine(exercise) {
  if (!exercise) return false;
  if (typeof exercise.tracksMachine === 'boolean') return exercise.tracksMachine;

  // Your own bodyweight is the same at every gym.
  if (exercise.bodyweight) return false;

  const name = String(exercise.name ?? '');

  // A Smith rack is a machine even though it holds a bar, and it is the one
  // case where the freeweight words are present but irrelevant.
  if (/\b(smith|machine)\b/i.test(name)) return true;
  if (FREEWEIGHT.test(name)) return false;

  const bar = exercise.barType ?? 'olympic';
  if (['olympic', 'womens', 'ez', 'trap', 'ssb'].includes(bar)) return false;

  return MACHINE.test(name) || bar === 'stack' || bar === 'none' || bar === 'none-total';
}
