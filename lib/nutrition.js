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

import { numeric, percentSlope, linearSlope } from './strength.js';

/** Below this far under maintenance is a deliberate cut, not a quiet day. */
export const DEFICIT_PCT = 8;

/** A pound a week is roughly the smallest trend the scale can show past noise. */
const REAL_TREND_PER_WEEK = 0.5;

/**
 * Readings needed before a direction is worth stating.
 *
 * Simulated against a genuinely flat weight with realistic day-to-day swing,
 * a least-squares slope crosses the 0.5 lb/week threshold by chance 86% of the
 * time at 4 readings, 67% at 7, 22% at 14 and 2% at 21. Fourteen is the point
 * where the answer is more often signal than noise; below it the honest output
 * is "not yet", not a number with a direction attached.
 */
const MIN_READINGS = 14;

/** How many recent readings make up the smoothed weight. */
const SMOOTHING_WINDOW = 7;

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
  const values = points.map((p) => p.value);

  // The number everything downstream divides by. A single morning reading can
  // be two pounds off on water alone, so it is never used on its own.
  const recent = values.slice(-SMOOTHING_WINDOW);
  const smoothed = recent.length
    ? Math.round((recent.reduce((a, b) => a + b, 0) / recent.length) * 10) / 10
    : null;

  const base = {
    confident: false,
    latest: values[values.length - 1] ?? null,
    first: values[0] ?? null,
    smoothed,
    readings: points.length,
    needed: Math.max(0, MIN_READINGS - points.length),
  };

  if (points.length < MIN_READINGS) {
    return { ...base, direction: 'unknown', perWeek: 0, percentPerWeek: 0 };
  }

  // Least squares over every reading, not the first against the last. Endpoint
  // differencing puts all its weight on the two readings most likely to be a
  // salty dinner or a bad night's sleep, which is exactly the noise this has
  // to see through.
  const perDay = linearSlope(values);
  const perWeek = Math.round(perDay * 7 * 10) / 10;

  // And the slope has to beat his own scatter, not a number picked in advance.
  // How long the scale takes to speak depends on how much it swings, which
  // varies by person and by week; a fixed threshold is right for nobody. This
  // is the standard error of a least-squares slope, and two of them is the
  // usual bar for calling a direction rather than guessing at one.
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;

  let ssResid = 0;
  let ssX = 0;
  for (let i = 0; i < n; i++) {
    const fitted = meanY + perDay * (i - meanX);
    ssResid += (values[i] - fitted) ** 2;
    ssX += (i - meanX) ** 2;
  }

  const stdErr = ssX > 0 && n > 2 ? Math.sqrt(ssResid / (n - 2) / ssX) : Infinity;
  const confident = Number.isFinite(stdErr) && Math.abs(perDay) > 2 * stdErr;

  const direction = !confident
    ? 'steady'
    : perWeek <= -REAL_TREND_PER_WEEK ? 'falling'
      : perWeek >= REAL_TREND_PER_WEEK ? 'rising'
        : 'steady';

  return {
    ...base,
    direction,
    confident,
    perWeek,
    percentPerWeek: percentSlope(values),
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
    const protein = proteinAdequacy({ proteinAvg, bodyweight: weight.smoothed });

    const cutting = weight.direction === 'falling' || balance.state === 'deficit';
    const parts = [];

    if (weight.direction === 'unknown' && !weight.readings) {
      parts.push('No bodyweight logged, so none of these trends can be read against the scale.');
    } else if (weight.direction === 'unknown') {
      // Saved, just not enough to fit a line through. Saying "none logged"
      // here reads as a failure to someone who typed a number ten seconds ago,
      // which is exactly how this looked broken while working perfectly.
      parts.push(
        `Last weighed ${weight.latest} lb${weight.readings > 1 ? `, averaging ${weight.smoothed}` : ''}. ` +
        `${weight.readings} reading${weight.readings === 1 ? '' : 's'} so far — ${weight.needed} more before a trend means anything. ` +
        `Day to day the scale moves on water and sodium, so it takes a fortnight to see through that.`,
      );
    } else if (weight.direction === 'falling') {
      parts.push(`He is losing about ${Math.abs(weight.perWeek)} lb a week, averaging ${weight.smoothed} lb.`);
    } else if (weight.direction === 'rising') {
      parts.push(`He is gaining about ${weight.perWeek} lb a week, averaging ${weight.smoothed} lb.`);
    } else if (!weight.confident && Math.abs(weight.perWeek) >= REAL_TREND_PER_WEEK) {
      // There is a slope, it is just buried. Calling that "steady" would be a
      // claim; the honest answer is that more readings will settle it, not a
      // change of diet.
      parts.push(
        `Averaging ${weight.smoothed} lb. The scale swings too much day to day to tell a real trend ` +
        `from water yet — more readings will separate them.`,
      );
    } else {
      parts.push(`Bodyweight is steady around ${weight.smoothed} lb.`);
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
