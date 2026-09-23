/**
 * How much he burns, how much he eats, and whether the gap is sensible.
 *
 * The load-bearing idea: **the measured deficit beats the estimated one.**
 * Every TDEE formula is roughly ±20% — none of them can see NEAT, the thermic
 * effect of what he actually ate, or how much he moves between sets. What no
 * formula can get wrong is the scale. Losing a pound a week is a ~500 kcal
 * daily deficit whatever the arithmetic claims, because the pound left.
 *
 * So the formulas are a starting point for someone with no weight history, and
 * the moment there is one, the scale overrules them. That ordering is the whole
 * design: an estimate that disagrees with the scale is a wrong estimate.
 *
 * These are estimates about training, not medical advice, and the numbers are
 * reported with their uncertainty rather than as facts.
 */

import { numeric } from './strength.js';

/** The usual approximation for a pound of body fat. */
export const KCAL_PER_LB = 3500;

/** Walking costs about this per pound of bodyweight per mile. */
const KCAL_PER_LB_PER_MILE = 0.57;

/** Walking stride is close to this fraction of height. */
const STRIDE_RATIO = 0.415;

/** Digestion takes roughly a tenth of what is eaten. */
const THERMIC_EFFECT = 0.1;

/** Everything not walking and not resting: fidgeting, standing, lifting. */
const BASE_ACTIVITY = 1.15;

/** Losing more than this share of bodyweight per week starts costing muscle. */
const AGGRESSIVE_PCT_PER_WEEK = 1.0;
const REAL_LOSS_PCT_PER_WEEK = 0.15;

/**
 * Mifflin-St Jeor, the usual choice for resting burn.
 *
 * Returns null unless every input is present. A defaulted height or age would
 * produce a confident number about nobody in particular, and every figure
 * downstream would inherit that invention.
 */
export function bmr(input) {
  const { weightLb, heightIn, age, sex } = input ?? {};
  const lb = numeric(weightLb);
  const inches = numeric(heightIn);
  const years = numeric(age);
  if (lb === null || inches === null || years === null || lb <= 0 || inches <= 0 || years <= 0) return null;

  const kg = lb * 0.453592;
  const cm = inches * 2.54;
  const base = 10 * kg + 6.25 * cm - 5 * years;

  return Math.round(base + (String(sex).toLowerCase() === 'female' ? -161 : 5));
}

/**
 * Calories from walking, via distance rather than a flat per-step figure.
 *
 * Stride comes from height, which is why a shorter person burns less over the
 * same step count: they covered less ground. A fixed "steps × 0.04" ignores
 * both height and bodyweight, which are the two things that actually matter.
 */
export function stepBurn(input) {
  const { steps, weightLb, heightIn } = input ?? {};
  const count = numeric(steps);
  const lb = numeric(weightLb);
  const inches = numeric(heightIn);
  if (count === null || lb === null || lb <= 0) return null;
  if (count <= 0) return 0;

  // Fall back to a 2000-steps-per-mile average when height is unknown.
  const strideIn = inches !== null && inches > 0 ? inches * STRIDE_RATIO : 63 * STRIDE_RATIO;
  const miles = (count * strideIn) / 63360;

  return Math.round(lb * KCAL_PER_LB_PER_MILE * miles);
}

/**
 * A whole day's burn, and honest about being an estimate.
 *
 * Resting, plus a modest multiplier for living, plus what the steps actually
 * cost. The thermic effect is folded in as a share of intake where intake is
 * known, because it is real and worth roughly 200 kcal a day.
 */
export function estimateTDEE(input) {
  const { weightLb, heightIn, age, sex, stepsAvg, intakeAvg } = input ?? {};

  const resting = bmr({ weightLb, heightIn, age, sex });
  if (resting === null) {
    return { known: false, tdee: null, bmr: null, steps: null, note: 'Needs height, age and a bodyweight.' };
  }

  const walking = stepBurn({ steps: stepsAvg, weightLb, heightIn }) ?? 0;
  const intake = numeric(intakeAvg);
  const thermic = intake !== null && intake > 0 ? intake * THERMIC_EFFECT : 0;

  return {
    known: true,
    bmr: resting,
    steps: walking,
    tdee: Math.round(resting * BASE_ACTIVITY + walking + thermic),
    note: 'An estimate, good to about ±20%. The scale is the better measure once there is one.',
  };
}

/**
 * What the scale says the deficit actually is.
 *
 * This is the number to trust. It integrates everything a formula guesses at,
 * because the weight either left or it did not.
 */
export function measuredDeficit(input) {
  const { perWeek, intakeAvg } = input ?? {};
  const rate = numeric(perWeek);
  const intake = numeric(intakeAvg);
  if (rate === null || intake === null || intake <= 0) {
    return { known: false, deficitPerDay: null, impliedTDEE: null };
  }

  // Losing weight is a negative rate, so flip it: a deficit is a positive gap.
  const deficitPerDay = Math.round((-rate * KCAL_PER_LB) / 7);

  return {
    known: true,
    deficitPerDay,
    impliedTDEE: Math.round(intake + deficitPerDay),
  };
}

/**
 * Is the cut well judged?
 *
 * Rate alone is not the answer. Losing fast while the lifts hold is a lifter
 * getting away with it; losing fast while they fall is muscle being spent, and
 * that is the only combination worth raising an alarm over. Reporting rate on
 * its own would flag a good aggressive cut and miss a bad gentle one.
 */
export function deficitVerdict(input) {
  const { perWeek, weightLb, liftsHolding } = input ?? {};
  const rate = numeric(perWeek);
  const lb = numeric(weightLb);

  if (rate === null || lb === null || lb <= 0) {
    return { severity: 'unknown', pctPerWeek: null, message: 'Not enough bodyweight history to judge the rate yet.' };
  }

  const pct = Math.round((Math.abs(rate) / lb) * 100 * 100) / 100;

  if (rate >= 0 || pct < REAL_LOSS_PCT_PER_WEEK) {
    return {
      severity: 'none',
      pctPerWeek: pct,
      message: rate > 0
        ? `Bodyweight is going up about ${rate} lb a week, so this is not a deficit.`
        : 'Bodyweight is essentially flat, so whatever the intake says, this is not currently a deficit.',
    };
  }

  const aggressive = pct > AGGRESSIVE_PCT_PER_WEEK;

  if (aggressive && liftsHolding === false) {
    return {
      severity: 'too-steep',
      pctPerWeek: pct,
      message: `Losing ${Math.abs(rate)} lb a week is ${pct}% of bodyweight, and the lifts are falling with it. That combination is muscle being spent, not just fat — eat more or accept the strength cost deliberately.`,
    };
  }

  if (aggressive) {
    return {
      severity: 'aggressive',
      pctPerWeek: pct,
      message: `Losing ${Math.abs(rate)} lb a week is ${pct}% of bodyweight, which is fast. The lifts are holding so far, so it is working — but it is the steep end, and strength usually goes before the scale slows.`,
    };
  }

  return {
    severity: 'sustainable',
    pctPerWeek: pct,
    message: liftsHolding
      ? `Losing ${Math.abs(rate)} lb a week is ${pct}% of bodyweight — a sensible rate, and the lifts are holding through it. That is the outcome you want from a cut.`
      : `Losing ${Math.abs(rate)} lb a week is ${pct}% of bodyweight, which is a sustainable rate.`,
  };
}
