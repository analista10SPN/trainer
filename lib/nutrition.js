/**
 * Bodyweight and intake, because strength on its own is a half-reading.
 *
 * Every verdict in this app was one variable short. Holding a lift while the
 * scale falls is a win, and the coach was calling it "stagnant". Losing a
 * little off a lift during a 600 kcal deficit is the expected cost of the
 * deficit, and it was being reported as a regression to go and fix.
 *
 * So the direction of the scale is context that belongs next to every trend.
 * Nothing here is inferred when it is not logged: "unknown" is a real answer
 * and much better than assuming maintenance, which would let the coach draw
 * confident conclusions from a number nobody supplied.
 */

import { numeric, percentSlope } from './strength.js';

/** Below this far under maintenance is a deliberate cut, not a quiet day. */
export const DEFICIT_PCT = 8;

/** A pound a week is roughly the smallest trend the scale can show past noise. */
const REAL_TREND_PER_WEEK = 0.5;

/** The usual target: about 0.7 g per pound of bodyweight. */
const PROTEIN_PER_LB = 0.7;

const readings = (metrics, name) =>
  (Array.isArray(metrics) ? metrics : [])
    .filter((m) => m?.name === name && numeric(m.value) !== null)
    .map((m) => ({ date: String(m.date ?? m.recordedAt ?? ''), value: numeric(m.value) }))
    .sort((a, b) => a.date.localeCompare(b.date));

/**
 * Which way the scale is going, in pounds per week.
 *
 * A slope rather than first-versus-last, because daily weight swings a pound or
 * two on water alone and two unlucky readings would otherwise report a cut that
 * is not happening — which would then reframe every lift verdict in the app.
 */
export function bodyweightTrend(metrics) {
  const points = readings(metrics, 'body_weight');
  if (points.length < 4) {
    return { direction: 'unknown', perWeek: 0, latest: points[points.length - 1]?.value ?? null, first: points[0]?.value ?? null, readings: points.length };
  }

  const values = points.map((p) => p.value);
  const days = Math.max(1, points.length - 1);
  const perDay = (values[values.length - 1] - values[0]) / days;
  const perWeek = Math.round(perDay * 7 * 10) / 10;

  return {
    direction: perWeek <= -REAL_TREND_PER_WEEK ? 'falling' : perWeek >= REAL_TREND_PER_WEEK ? 'rising' : 'steady',
    perWeek,
    percentPerWeek: percentSlope(values),
    latest: values[values.length - 1],
    first: values[0],
    readings: points.length,
  };
}

/** Intake against maintenance, or unknown. Never assumed. */
export function energyBalance({ intakeAvg, maintenance } = {}) {
  const intake = numeric(intakeAvg);
  const target = numeric(maintenance);
  if (intake === null || target === null || intake <= 0 || target <= 0) {
    return { state: 'unknown', percent: 0, intake, maintenance: target };
  }

  const percent = Math.round(((intake - target) / target) * 100);
  return {
    state: percent <= -DEFICIT_PCT ? 'deficit' : percent >= DEFICIT_PCT ? 'surplus' : 'maintenance',
    percent,
    intake,
    maintenance: target,
  };
}

/** Protein relative to bodyweight, which is the only way it means anything. */
export function proteinAdequacy({ proteinAvg, bodyweight } = {}) {
  const protein = numeric(proteinAvg);
  const weight = numeric(bodyweight);
  if (protein === null || weight === null || weight <= 0) return { enough: null, perLb: null, target: null };

  const perLb = Math.round((protein / weight) * 100) / 100;
  return { enough: perLb >= PROTEIN_PER_LB, perLb, target: Math.round(weight * PROTEIN_PER_LB) };
}

/**
 * The paragraph the coach needs before it reads a single trend.
 *
 * `guidance` is separate from `summary` on purpose: the summary is what is
 * true, the guidance is how to read the lifts in light of it. Only the second
 * changes what a verdict means, and only when there is something to say.
 */
export function nutritionContext(input) {
  // Not a destructured default: those fire only for `undefined`, so a null
  // argument would throw before the try block could catch it.
  const { metrics = [], settings = {}, intakeAvg = null, proteinAvg = null } = input ?? {};

  try {
    const weight = bodyweightTrend(metrics);
    const balance = energyBalance({ intakeAvg, maintenance: settings?.maintenanceCalories });
    const protein = proteinAdequacy({ proteinAvg, bodyweight: weight.latest });

    const cutting = weight.direction === 'falling' || balance.state === 'deficit';
    const parts = [];

    if (weight.direction === 'unknown') {
      parts.push('No bodyweight logged, so none of these trends can be read against the scale.');
    } else if (weight.direction === 'falling') {
      parts.push(`He is losing about ${Math.abs(weight.perWeek)} lb a week, now ${weight.latest} lb.`);
    } else if (weight.direction === 'rising') {
      parts.push(`He is gaining about ${weight.perWeek} lb a week, now ${weight.latest} lb.`);
    } else {
      parts.push(`Bodyweight is steady around ${weight.latest} lb.`);
    }

    if (balance.state === 'deficit') parts.push(`Eating about ${Math.abs(balance.percent)}% under maintenance.`);
    else if (balance.state === 'surplus') parts.push(`Eating about ${balance.percent}% over maintenance.`);
    else if (balance.state === 'maintenance') parts.push('Eating around maintenance.');

    if (protein.enough === false) parts.push(`Protein is about ${protein.perLb} g/lb, under the ${PROTEIN_PER_LB} g/lb that protects muscle in a cut.`);
    else if (protein.enough === true) parts.push(`Protein is about ${protein.perLb} g/lb, which is adequate.`);

    return {
      cutting,
      weight,
      balance,
      protein,
      summary: parts.join(' '),
      guidance: cutting
        ? 'He is in a cut. Holding a lift steady here is a success, not a stall, and a small loss is the expected price of the deficit — do not prescribe more volume or a deload for it. Reserve the alarm for lifts falling much faster than the scale.'
        : '',
    };
  } catch {
    return { cutting: false, weight: { direction: 'unknown' }, balance: { state: 'unknown' }, protein: { enough: null }, summary: 'No bodyweight logged.', guidance: '' };
  }
}
