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

/**
 * Walking, **net of resting**, per pound of bodyweight per mile.
 *
 * The figure usually quoted is 0.57, but that is *gross*: it includes the
 * calories you would have burned lying still for the same twenty minutes. Add
 * that on top of a BMR and resting metabolism gets counted twice — which is
 * exactly how a 172 lb man walking 12 miles came out at an estimated 3,300
 * kcal day, implying a pound of fat every four days that the scale flatly
 * disagreed with.
 *
 * Derived from METs rather than taken from a blog: walking is 3.5 METs, of
 * which 1 MET is the resting rate you are already counting. The active share
 * is therefore (3.5 - 1) / 3.5 of the gross figure.
 */
const KCAL_PER_LB_PER_MILE = 0.57 * ((3.5 - 1) / 3.5);

/** Walking stride is close to this fraction of height. */
const STRIDE_RATIO = 0.415;

/** Digestion takes roughly a tenth of what is eaten, averaged across macros. */
const THERMIC_EFFECT = 0.1;

/**
 * Protein costs far more to digest than anything else — about a quarter of its
 * own calories against well under a tenth for carbs and fat. Worth a few dozen
 * calories a day at a lifter's intake, which is small but real, and it is the
 * one macro worth logging for reasons beyond this anyway.
 */
const THERMIC_PROTEIN = 0.25;
const THERMIC_OTHER = 0.08;
const KCAL_PER_G_PROTEIN = 4;

/**
 * Everything that is neither resting nor walking: fidgeting, standing, lifting.
 *
 * Deliberately small. The familiar "sedentary" multiplier of 1.2 already has
 * several thousand steps baked into it, and using that alongside an explicit
 * step count charges for the same walking twice — the second half of the same
 * overestimate.
 */
const BASE_ACTIVITY = 1.08;

/** Losing more than this share of bodyweight per week starts costing muscle. */
const AGGRESSIVE_PCT_PER_WEEK = 1.0;
const REAL_LOSS_PCT_PER_WEEK = 0.15;

/**
 * Widest body fat range still worth calling an estimate.
 *
 * "Somewhere between 8 and 30 percent" is not a measurement, and taking its
 * midpoint would produce a confident number about nobody. Past this the answer
 * is to fall back to a formula that does not need the figure at all.
 */
export const MAX_BF_SPAN = 8;

/** Katch-McArdle. Lean mass in kg is the only input that matters. */
const katchMcArdle = (lbmKg) => 370 + 21.6 * lbmKg;

/**
 * Resting burn, as a range when body composition is known.
 *
 * Mifflin-St Jeor charges every kilogram identically, muscle or fat, and the
 * athlete literature is consistent that it understates people carrying a lot of
 * lean mass — which is the whole reason for this. Katch-McArdle works off lean
 * mass directly and fits far better, but it needs a body fat figure and nobody
 * knows theirs to the decimal.
 *
 * So it takes a range and reports one. Showing the uncertainty is better than
 * inventing a precision that does not exist; the midpoint drives the arithmetic
 * so nothing downstream has to learn about intervals.
 */
export function restingRange(input) {
  const { weightLb, heightIn, age, sex, bodyFatLow, bodyFatHigh } = input ?? {};
  const lb = numeric(weightLb);

  const fallback = () => {
    const value = bmr({ weightLb, heightIn, age, sex });
    return { method: 'mifflin', low: value, mid: value, high: value };
  };

  if (lb === null || lb <= 0) return { method: 'mifflin', low: null, mid: null, high: null };

  const lo = numeric(bodyFatLow);
  const hi = numeric(bodyFatHigh);
  if (lo === null || hi === null) return fallback();
  if (lo <= 0 || hi <= 0 || lo > hi || hi > 60) return fallback();
  if (hi - lo > MAX_BF_SPAN) return fallback();

  // Less fat means more lean mass means a higher burn, so the *low* body fat
  // end produces the *high* figure. Easy to invert, and inverted would be worse
  // than not having it.
  const lbmKg = (bf) => lb * (1 - bf / 100) * 0.453592;
  const high = Math.round(katchMcArdle(lbmKg(lo)));
  const low = Math.round(katchMcArdle(lbmKg(hi)));

  return { method: 'katch', low, mid: Math.round((low + high) / 2), high };
}

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

  const resting = restingRange(input ?? {}).mid;
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
  const { perWeek, intakeAvg, sePerWeek } = input ?? {};
  const rate = numeric(perWeek);
  const intake = numeric(intakeAvg);
  if (rate === null || intake === null || intake <= 0) {
    return { known: false, deficitPerDay: null, impliedTDEE: null, plusMinus: null, confident: null };
  }

  // Losing weight is a negative rate, so flip it: a deficit is a positive gap.
  const deficitPerDay = Math.round((-rate * KCAL_PER_LB) / 7);
  const impliedTDEE = Math.round(intake + deficitPerDay);

  /**
   * How wrong this might be, carried alongside it.
   *
   * The card showed one flat number and it was read as a measurement. It is a
   * midpoint: at fourteen days with a pound of daily scale noise the honest
   * range is six hundred calories wide, which is wide enough to contain both
   * "you are losing a pound a week" and "you are not losing at all". A number
   * that cannot tell those apart has to say so where it is displayed.
   *
   * Null rather than zero when the spread is unknown — zero reads as certainty.
   */
  const se = numeric(sePerWeek);
  if (se === null || !Number.isFinite(se)) {
    return { known: true, deficitPerDay, impliedTDEE, plusMinus: null, low: null, high: null, confident: null };
  }

  const plusMinus = Math.round((se * KCAL_PER_LB) / 7);

  return {
    known: true,
    deficitPerDay,
    impliedTDEE,
    plusMinus,
    low: Math.round(impliedTDEE - 1.96 * plusMinus),
    high: Math.round(impliedTDEE + 1.96 * plusMinus),
    // The same bar the weight trend uses to call a direction: a slope has to
    // beat twice its own scatter before it is a finding rather than a guess.
    confident: se > 0 ? Math.abs(rate) > 2 * se : null,
  };
}

/** How many readings the swing check looks at: five, so four days of eating. */
export const SWING_READINGS = 5;

/** Below this it is ordinary scale noise, not a story worth telling. */
const SWING_THRESHOLD_LB = 1;

/**
 * Weight the calories cannot account for.
 *
 * The fortnight he questioned ended on four days where the scale climbed two
 * pounds while he ate 9,381 kcal against a burn of about 10,900. Two pounds of
 * fat is 7,000 kcal; the energy balance says he should have *lost* half a pound.
 * Weight that contradicts the arithmetic that hard is water and glycogen — in
 * his case a 3,000 kcal day and a return to lifting after three days off.
 *
 * It matters because of **where** it landed. A least-squares slope weights the
 * ends of its window hardest, so a water swing on the final reading drags the
 * measured burn down by hundreds of calories, and the number looks like a
 * finding rather than an artifact of when he happened to stop counting.
 *
 * Both directions are checked. A fake *loss* is the more dangerous one: it reads
 * as progress and invites eating less on the strength of it.
 *
 * This explains a number; it never silently corrects one. The measured figure
 * stays exactly what the scale said — what changes is that the card can say why
 * not to act on it this week.
 */
export function unexplainedSwing(input) {
  const { weights, intakes, tdee, readings = SWING_READINGS } = input ?? {};

  const scale = (Array.isArray(weights) ? weights : [])
    .map((w) => numeric(w?.value ?? w))
    .filter((w) => w !== null)
    .slice(-readings);

  const burn = numeric(tdee);
  if (scale.length < 3 || burn === null || burn <= 0) {
    return { known: false, swung: false, observedLb: null, explainedLb: null, unexplainedLb: null };
  }

  const days = scale.length - 1;

  /**
   * One intake per elapsed day, and a missing day is missing — not a zero.
   *
   * `Number(null) === 0` would read a day he forgot to log as a total fast, book
   * a 2,700 kcal deficit against it, and explain the swing away as real loss.
   * So gaps are dropped and the average of the days that *were* logged stands in
   * for them, which is the only answer that does not invent a number.
   */
  const eaten = (Array.isArray(intakes) ? intakes : [])
    .map((k) => numeric(k?.value ?? k))
    .slice(-days);
  const known = eaten.filter((k) => k !== null && k > 0);
  const perDay = known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
  if (perDay === null) {
    return { known: false, swung: false, observedLb: null, explainedLb: null, unexplainedLb: null };
  }

  const observedLb = Math.round((scale[scale.length - 1] - scale[0]) * 100) / 100;
  const explainedLb = Math.round((((perDay - burn) * days) / KCAL_PER_LB) * 100) / 100;
  const unexplainedLb = Math.round((observedLb - explainedLb) * 100) / 100;

  const swung = Math.abs(unexplainedLb) >= SWING_THRESHOLD_LB;
  const direction = observedLb >= 0 ? 'up' : 'down';

  return {
    known: true,
    swung,
    days,
    direction,
    observedLb,
    explainedLb,
    unexplainedLb,
    intakeAvg: Math.round(perDay),
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

/* --------------------------- what a session costs ------------------------- */

/**
 * Resistance training, averaged across a whole session.
 *
 * About 3.5 METs, which is far below what a working set feels like — and that
 * is the point. Reverse pyramid with three-minute rests means most of the hour
 * is spent standing still, so the session average sits near brisk walking even
 * though the sets themselves are well over six METs. Counting the effort of the
 * sets across the whole session would roughly double it.
 *
 * Net of resting, like the walking, or the BMR underneath gets charged twice.
 */
const LIFTING_METS = 3.5;

/** Outside this a duration is a forgotten timer, not a workout. */
const MIN_SESSION_MINUTES = 10;
const MAX_SESSION_MINUTES = 240;

/**
 * Time allowed after the last logged set: that set itself, plus racking up.
 *
 * The last set is when the work stopped; `finishedAt` is only when he
 * remembered to tap. He once drove home first, recording 208 minutes against a
 * last set at 79 and billing 706 kcal of lifting instead of 267. Capping at the
 * last set plus this tail leaves a prompt finish — the usual one to three
 * minute gap — completely untouched.
 */
const SESSION_TAIL_MINUTES = 5;

export function sessionBurn(session, weightLb) {
  const lb = numeric(weightLb);
  if (lb === null || lb <= 0) return null;

  const start = Date.parse(session?.startedAt ?? '');
  const finished = Date.parse(session?.finishedAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(finished)) return null;

  // The work ended with the last set, whatever the finish tap says.
  const lastSet = Math.max(
    ...(session?.sets ?? []).map((s) => Date.parse(s?.loggedAt ?? '')).filter(Number.isFinite),
    -Infinity,
  );

  const end = Number.isFinite(lastSet)
    ? Math.min(finished, lastSet + SESSION_TAIL_MINUTES * 60000)
    : finished;

  const minutes = (end - start) / 60000;
  if (minutes < MIN_SESSION_MINUTES || minutes > MAX_SESSION_MINUTES) return null;

  const kg = lb * 0.453592;
  return Math.round(((LIFTING_METS - 1) * 3.5 * kg / 200) * minutes);
}

/**
 * One day's energy, costed from what actually happened on it.
 *
 * A single averaged TDEE was hiding the thing he most wanted to see: his days
 * are not alike. Twelve miles of walking is worth four times a lifting session,
 * so a Saturday of weights and no walking is his *lowest* burn of the week —
 * exactly the day it is easiest to overeat on while believing otherwise.
 */
export function dailyEnergy(input) {
  const { date, metrics = [], sessions = [], settings = {} } = input ?? {};
  const day = String(date ?? '').slice(0, 10);

  const on = (name) =>
    (Array.isArray(metrics) ? metrics : [])
      .find((m) => m?.name === name && String(m.date ?? '').slice(0, 10) === day)?.value ?? null;

  const steps = numeric(on('steps'));
  const intake = numeric(on('dietary_energy'));
  const protein = numeric(on('protein'));

  // He does not weigh every morning. Borrowing the most recent weight keeps the
  // steps and the calories he *did* log from being thrown away with the day.
  const ownWeight = numeric(on('body_weight'));
  const recent = (Array.isArray(metrics) ? metrics : [])
    .filter((m) => m?.name === 'body_weight' && numeric(m.value) !== null)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const weightLb = ownWeight ?? (recent.length ? numeric(recent[recent.length - 1].value) : null);
  const usedFallbackWeight = ownWeight === null && weightLb !== null;

  const rest = restingRange({
    weightLb,
    heightIn: settings?.heightInches,
    age: settings?.age,
    sex: settings?.sex,
    bodyFatLow: settings?.bodyFatLow,
    bodyFatHigh: settings?.bodyFatHigh,
  });

  const resting = rest.mid;
  if (resting === null) {
    return {
      known: false, date: day, usedFallbackWeight: false, protein, tdee: null, tdeeLow: null, tdeeHigh: null,
      bmr: null, method: rest.method, walking: 0, lifting: 0, thermic: 0, intake, deficit: null,
    };
  }

  const walking = steps === null ? 0 : (stepBurn({ steps, weightLb, heightIn: settings.heightInches }) ?? 0);

  const lifting = (Array.isArray(sessions) ? sessions : [])
    .filter((s) => String(s?.startedAt ?? '').slice(0, 10) === day)
    .reduce((sum, s) => sum + (sessionBurn(s, weightLb) ?? 0), 0);

  // Split by macro when protein is known, since it is the expensive one.
  const thermic = intake === null || intake <= 0
    ? 0
    : protein !== null && protein > 0
      ? Math.round(
          Math.min(protein * KCAL_PER_G_PROTEIN, intake) * THERMIC_PROTEIN +
          Math.max(0, intake - protein * KCAL_PER_G_PROTEIN) * THERMIC_OTHER,
        )
      : Math.round(intake * THERMIC_EFFECT);

  const movement = walking + lifting + thermic;
  const total = (restingValue) => Math.round(restingValue * BASE_ACTIVITY) + movement;

  const tdee = total(resting);

  return {
    known: true,
    date: day,
    usedFallbackWeight,
    protein,
    bmr: resting,
    bmrLow: rest.low,
    bmrHigh: rest.high,
    method: rest.method,
    walking,
    lifting,
    thermic,
    tdee,
    tdeeLow: total(rest.low),
    tdeeHigh: total(rest.high),
    intake,
    deficit: intake !== null && intake > 0 ? tdee - intake : null,
  };
}
