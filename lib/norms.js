/**
 * What somebody of these characteristics can probably lift.
 *
 * This exists for one person: the one who declines the test week. They still
 * have to put a number on the bar for their first set, and "work it out
 * yourself" is the answer the app is supposed to replace.
 *
 * It is the weakest module in the onboarding, and the comments here are long
 * because the literature search done for it mostly returned reasons to be
 * careful. Read them before changing a constant.
 *
 * ## What the evidence actually is
 *
 * **There is no population reference data for untrained adults lifting
 * barbells.** No national fitness survey measures a 1RM; surveillance uses
 * handgrip strength, because it is cheap and safe. So there is nothing to look
 * up for the exact question this module is asked.
 *
 * **The large datasets that exist are competitive powerlifters.** van den Hoek
 * et al. (2024) is 809,986 judged competition lifts and is the only large set
 * of genuinely *measured* maxima — and its authors explicitly warn against
 * comparing general-population individuals to it. Their 90th-percentile young
 * adult male squat is 2.83x bodyweight. Using that family of numbers to seed a
 * beginner's first session would be the single worst thing this file could do.
 *
 * **The most widely circulated strength-standards table in the field has no
 * retrievable primary data.** ExRx's standards are attributed to competitive
 * classification systems and described as "not predicted or regression
 * derived", while ExRx's own development page describes a year spent fitting
 * "weighted regression formulas" to produce them — two official accounts,
 * mutually inconsistent, with no dataset, sample size or sample description
 * published. Several commercial charts (Strenf, FitnessVolt) state outright
 * that their beginner and novice tiers are modelled *below* their observed
 * range, which is to say invented. The widely quoted "women are 52% as strong
 * in the upper body" traces to a paper with n = 8 per sex whose abstract does
 * not contain the figure. None of this is used here.
 *
 * ## So the anchors are
 *
 * **Ribeiro et al. (2024)**, `International Journal of Strength and
 * Conditioning` 4(1) — n = 119 (57 men, 62 women), ~10-14 months of training,
 * directly measured barbell 1RM for bench press, squat and arm curl, both sexes
 * under one protocol in one laboratory. This is the closest published
 * population to a new user of this app that measures what we need.
 *
 * **Piper et al. (2021, 2022)**, `International Journal of Strength and
 * Conditioning` — n = 1,095 men and 371 women, directly tested 10RM for
 * overhead press and lat pulldown among others. 10RM converted here with
 * Lombardi, which the validation work below favours.
 *
 * The two agree where they overlap, which is the only external check available:
 * Piper's median male bench works out at 0.96x bodyweight against Ribeiro's
 * measured 0.98x, and for women 0.47x against 0.50x. Two different samples,
 * two different measurements, two different decades.
 *
 * ## Three findings that changed the arithmetic
 *
 * **1. Strength does not scale linearly with bodyweight, so neither does this.**
 * A flat multiple calibrated at one bodyweight is wrong by roughly 15-20%
 * across a 50-120 kg adult range and up to 25% for women — and wrong
 * *systematically*, too light for small people and too heavy for large ones.
 * Load is computed as `k * bodyweight^b` instead. Any exponent in the 0.5-0.67
 * band cuts that error to about 5-8%, so choosing a plausible exponent matters
 * far more than choosing exactly the right one. Three independent lines
 * (Cleather 2006; Huebner 2023; Batterham & George via Vanderburgh 1999) agree
 * that no single exponent removes bias at the extremes — the true curve is not
 * a clean power law, and this is a correction rather than a law.
 *
 * **2. The sexes need separate numbers per lift, not one factor.** The robust
 * finding across every source that split by region is that the upper-body gap
 * is roughly 1.5 to 1.7 times the lower-body gap. One whole-body factor is
 * wrong by about fifteen percentage points at one end. Here each anchor simply
 * carries both sexes' measured values, so the asymmetry comes along for free.
 *
 * **3. A lift with no anchor gets no number.** This is the important one.
 * Rather than invent an accessory fraction for each of the ten movement
 * patterns with no published data, those return `null` and an instruction. For
 * a cable lateral raise on day one, "start light and find it in a set" is not a
 * failure to answer — it is the correct coaching, and it is what an honest
 * table can say.
 *
 * ## Confidence
 *
 * Group means from near-novice samples, corrected for bodyweight and age, with
 * a deliberate downward bias. For an individual this is a prior, not a
 * prediction: the meta-analytic prediction intervals for strength per kilogram
 * of bodyweight include 1.0 for both sexes, meaning an individual woman
 * out-lifting an individual man of the same mass is entirely expected. The
 * first working set is worth more than everything in this file, which is why
 * the test week is recommended and this is the fallback.
 */

import { numeric } from './strength.js';
import { poseOf } from './poses.js';
import { getBarType } from './plates.js';
import { allowsZeroLoad } from './exercises.js';
import { getScheme } from './scheme.js';

/**
 * How load scales with bodyweight: `load = k * bodyweight^b`.
 *
 * From Montenegro et al. (2026), the largest allometric analysis located —
 * 457,471 drug-tested raw competition entries, b = 0.550 (SE 0.002) for men and
 * 0.500 (SE 0.002) for women. Those are lifting-population figures, which is
 * the right family since the anchors below are lifting measurements. The
 * theoretical value from cross-sectional area is 0.667, which sits at the top
 * of the empirical range rather than the middle of it.
 */
export const SCALING_EXPONENT = { male: 0.55, female: 0.5 };

/**
 * Relative strength per movement, as a multiple of bodyweight at the
 * bodyweight it was measured at.
 *
 * Keyed by `poseOf` so one anchor serves every lift in the library that is the
 * same movement — the same reuse `prescribe.js` makes of the pattern
 * vocabulary, rather than a second table keyed by exercise id that would need a
 * row per lift and would silently miss new ones.
 *
 * `refBodyweightLb` is the sample's mean bodyweight, and it is per sex because
 * the samples differ. It matters: the ratio is only true at that bodyweight,
 * and the scaling above moves it from there.
 */
export const ANCHORS = [
  {
    pose: 'bench',
    basis: 'measured',
    source: 'Ribeiro et al. 2024, n=119, measured barbell 1RM, ~10-14 months trained',
    male: { ratio: 0.98, refBodyweightLb: 155.4 },
    female: { ratio: 0.5, refBodyweightLb: 129.0 },
  },
  {
    pose: 'squat',
    basis: 'measured',
    source: 'Ribeiro et al. 2024, n=119, measured barbell 1RM, ~10-14 months trained',
    male: { ratio: 1.66, refBodyweightLb: 155.4 },
    female: { ratio: 1.29, refBodyweightLb: 129.0 },
  },
  {
    pose: 'curl',
    basis: 'measured',
    source: 'Ribeiro et al. 2024, n=119, measured barbell arm curl 1RM',
    male: { ratio: 0.57, refBodyweightLb: 155.4 },
    female: { ratio: 0.37, refBodyweightLb: 129.0 },
  },
  {
    pose: 'overhead',
    basis: 'derived',
    source: 'Piper et al. 2021/2022, n=1,466, tested 10RM seated press, converted with Lombardi',
    male: { ratio: 0.67, refBodyweightLb: 177.5 },
    female: { ratio: 0.42, refBodyweightLb: 135.0 },
  },
  {
    pose: 'pulldown',
    basis: 'derived',
    source: 'Piper et al. 2021/2022, n=1,466, tested 10RM lat pulldown, converted with Lombardi',
    male: { ratio: 0.92, refBodyweightLb: 177.5 },
    female: { ratio: 0.65, refBodyweightLb: 135.0 },
  },
  {
    /**
     * No study measured a novice deadlift 1RM. This takes the squat anchor and
     * applies the deadlift-to-squat ratio observed in Clark et al. (2026),
     * n=74,892 recreational trainees — 1.22 for men and 1.24 for women. Two
     * sources multiplied together, which is why it is `derived` and why it is
     * the anchor to distrust first.
     */
    pose: 'hinge',
    basis: 'derived',
    source: 'Ribeiro 2024 squat x deadlift:squat ratio from Clark et al. 2026, n=74,892',
    male: { ratio: 2.02, refBodyweightLb: 155.4 },
    female: { ratio: 1.59, refBodyweightLb: 129.0 },
  },
];

/**
 * Where the anchor population sits, and what other experience implies.
 *
 * `6mo-2y` is 1.0 because that *is* the Ribeiro sample — roughly a year in.
 * `2-5y` is 1.07, which is not a guess: Clark et al. (2026) put the median
 * recreational male squat at 1.77x bodyweight against Ribeiro's measured 1.655,
 * a ratio of 1.069.
 *
 * `over-5y` at 1.15 looks compressed and is not: the published medians really
 * are close together. Ribeiro's near-novices squat 1.655x bodyweight, Clark's
 * recreational median is 1.77x, and the next step up in the literature is
 * competitive powerlifting at 2.83x. Between one year and many years of
 * ordinary training the reference values barely move, and anybody who has
 * genuinely outgrown this will override a light suggestion on their first set
 * at no cost.
 *
 * `under-6mo` is the one number here with nothing behind it, and it is the one
 * that matters most, because a true beginner is who reads a suggested weight.
 * The first draft had it at 0.8 and that was wrong in the dangerous direction:
 * it suggested a 145 lb squat for eight reps to somebody in month two, which
 * implies a 1.26x bodyweight max. The anchor sample had **ten to fourteen
 * months of supervised progressive training**, and a person in their second
 * month is not eighty per cent of that. 0.6 puts the same man at a 110 lb
 * squat, which is a weight somebody can learn the movement with. It is a
 * judgment, it errs low deliberately, and a beginner is told to do the test
 * week anyway.
 */
export const EXPERIENCE_FACTOR = {
  'under-6mo': 0.6,
  '6mo-2y': 1,
  '2-5y': 1.07,
  'over-5y': 1.15,
};

/**
 * A deliberate downward bias, because the two ways of being wrong do not cost
 * the same. Too light wastes one set. Too heavy, on a first session, with
 * nobody watching, is how people get hurt and stop coming.
 */
export const CAUTION = 0.9;

/**
 * Strength against age, relative to a young adult.
 *
 * Factors computed from van den Hoek et al. (2024) median relative strength,
 * averaged across squat, bench press and deadlift, per sex, placed at the
 * midpoint of each age band and interpolated between.
 *
 * The young-adult band is **flat across 18 to 35** rather than peaking at its
 * midpoint. The first draft put the reference point at 26.5 and declined either
 * side of it, which drew a sharp peak the data does not contain: the source
 * reports a 18-35 *band*, so a 34-year-old and a 20-year-old are the same
 * number in it, and inventing a 1.4% difference between them was reading
 * precision into a bin boundary.
 *
 * Two honest limits. These are **cross-sectional** differences between age
 * groups within a competitive population, not a rate at which a person
 * declines — Wilf & Dunsky (2025), following 61 lifters who competed both
 * before 40 and after 60, found age explained only 0.4% to 15.6% of the
 * variance in their strength, and bench press did not decline significantly at
 * all. Continued training offsets most of this curve. And the shape past 80
 * rests on the smallest cells in the dataset.
 */
const AGE_CURVE = {
  male: [
    [15, 0.835],
    [18, 1],
    [35, 1],
    [47.5, 0.916],
    [69.5, 0.756],
    [85, 0.551],
  ],
  female: [
    [15, 0.847],
    [18, 1],
    [35, 1],
    [47.5, 0.91],
    [69.5, 0.736],
    [85, 0.509],
  ],
};

export function ageFactor(age, sex) {
  const curve = AGE_CURVE[String(sex).toLowerCase()] ?? AGE_CURVE.male;
  const years = numeric(age);
  if (years === null) return curve[1][1];

  if (years <= curve[0][0]) return curve[0][1];
  if (years >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];

  for (let i = 1; i < curve.length; i += 1) {
    const [x0, y0] = curve[i - 1];
    const [x1, y1] = curve[i];
    if (years <= x1) return y0 + ((years - x0) / (x1 - x0)) * (y1 - y0);
  }
  return curve[curve.length - 1][1];
}

const anchorFor = (exercise) => {
  const pose = poseOf(exercise);
  return pose ? (ANCHORS.find((a) => a.pose === pose) ?? null) : null;
};

/** Said rather than left blank, because a blank reads as a bug. */
const FIND_IT = 'Start with the lightest weight that feels like work — one set will tell you.';

/**
 * What to say about a lift where the body is the load.
 *
 * The worst number this module produced, and it was found by printing the
 * output rather than by reading the code. `poseOf` files a weighted pull-up
 * under `pulldown` — correct for choosing it as a slot in a week, since it is
 * the same movement pattern, and wrong for putting a weight on it. The pulldown
 * anchor describes the whole load a machine moved, while a pull-up's logged
 * weight is what the person added **to themselves**. Scaled for a 132 lb woman
 * that came out at 60, so the screen would have told somebody in their first
 * month to hang sixty pounds off a chin-up bar.
 *
 * Read from the `bodyweight` flag rather than a list of names, because
 * `cleanExercise` already owns that list and a second copy here would be one
 * more thing to keep in step.
 */
const OWN_BODYWEIGHT = 'Start with your own bodyweight and no extra load, and see how many reps that is.';

/**
 * An estimated one-rep max, or an honest refusal.
 *
 * Never a figure to train at: `suggestedStartingWeight` turns this into
 * something to put on the bar. Kept separate because the max is the thing the
 * evidence speaks about and the working weight is the thing with the rep range
 * and the reserve applied.
 */
export function suggested1RM(exercise, { sex, weightLb, age, experience } = {}) {
  const anchor = anchorFor(exercise);
  const key = String(sex).toLowerCase();
  const bodyweight = numeric(weightLb);

  if (allowsZeroLoad(exercise)) {
    return { weight: null, basis: 'bodyweight', source: null, says: OWN_BODYWEIGHT };
  }
  if (!anchor) {
    return { weight: null, basis: 'find-it', source: null, says: FIND_IT };
  }
  if (!anchor[key] || !SCALING_EXPONENT[key]) {
    return { weight: null, basis: 'find-it', source: null, says: FIND_IT };
  }
  if (!bodyweight || bodyweight <= 0) {
    return { weight: null, basis: 'find-it', source: null, says: FIND_IT };
  }

  const { ratio, refBodyweightLb } = anchor[key];
  const b = SCALING_EXPONENT[key];

  // load = ratio * ref^(1-b) * bodyweight^b, which reproduces ratio*ref at the
  // reference bodyweight and bends correctly away from it.
  const scaled = ratio * refBodyweightLb ** (1 - b) * bodyweight ** b;
  const weight = scaled * ageFactor(age, key) * (EXPERIENCE_FACTOR[experience] ?? EXPERIENCE_FACTOR['under-6mo']);

  return {
    weight,
    basis: anchor.basis,
    source: anchor.source,
    says: 'An estimate from population data, not from you — the first set is worth more than it is.',
  };
}

/**
 * What to put on the bar, rounded to something loadable.
 *
 * The max is converted with the same inverted Epley `testweek.js` uses, so a
 * person who does the test week and a person who declines it are given weights
 * on the same scale. Rounded to five pounds because a suggestion accurate to a
 * tenth of a pound would be claiming a precision this module does not have.
 */
export function suggestedStartingWeight(exercise, { targetReps = 8, rir = 2, ...person } = {}) {
  const max = suggested1RM(exercise, person);
  if (max.weight === null) return max;

  const reps = numeric(targetReps) ?? 8;
  const reserve = Math.max(0, numeric(rir) ?? 0);
  const working = (max.weight / (1 + (reps + reserve) / 30)) * CAUTION;
  const rounded = Math.max(5, Math.round(working / 5) * 5);

  /**
   * An empty bar is a floor, and for some people it is above the estimate.
   *
   * The first draft told a 140 lb beginner to bench 25 lb. An Olympic bar
   * weighs 45, so that is not a light suggestion — it is an impossible one, and
   * it would have appeared on screen as a number somebody could try to load.
   * This is a real situation rather than an edge case: plenty of people cannot
   * press an empty barbell for eight reps on their first day, and the answer is
   * dumbbells or a machine, which the app can say.
   *
   * **The pound table, always.** Everything in this module is a pound figure —
   * the anchors are pound measurements and every weight this app stores is in
   * pounds — so the floor has to be looked up in pounds too. This took a `unit`
   * option and handed it to `getBarType`, which read the *kilo* table while the
   * estimate stayed in pounds: a kilo user's floor became 20, so it never fired
   * above 20 lb, and the one case it did fire on came back as "20" meaning
   * twenty kilos. That is the dumbbell-unit bug wearing a new hat, and it cost
   * months the first time precisely because a number in the wrong unit looks
   * like a number. Converting for the screen is `formatWeight`'s job and
   * belongs at the edge, not here.
   */
  const bar = getBarType(exercise?.barType, 'lb')?.weight ?? 0;
  if (bar > 0 && rounded < bar) {
    return {
      ...max,
      weight: bar,
      belowBar: true,
      says: `The empty bar weighs ${bar} lb — more than the estimate. Start with the bar, or do this one with dumbbells or a machine until it is easy.`,
    };
  }

  return { ...max, weight: rounded };
}

/**
 * Every lift in a program, with a suggestion or with the instruction to find
 * it. One entry per lift, deduplicated, in the order the program lists them.
 *
 * **The rep target comes from the slot, not from the caller.** One global
 * `targetReps` applied across the week gave a cable hammer curl programmed at
 * 15-20 the load for a set of eight — about forty per cent heavier than the set
 * it sits in. A suggestion is a weight *for a number of reps*, and which number
 * is a property of the slot, exactly as it is in `testWeekPlan`, which reads the
 * lift's own scheme for the same reason. `person.targetReps` still wins where a
 * caller sets it, for the one-lift case where there is no slot to read.
 */
export function suggestionsFor(program, person = {}, { exercises = [] } = {}) {
  if (!program?.days?.length) return [];

  const byId = new Map(exercises.map((e) => [e.id, e]));
  const seen = new Set();
  const out = [];

  for (const day of program.days) {
    for (const x of day.exercises) {
      if (seen.has(x.exerciseId)) continue;
      seen.add(x.exerciseId);

      const top = getScheme(x.schemeId)?.working?.[0] ?? {};
      const exercise = byId.get(x.exerciseId) ?? { id: x.exerciseId, name: x.exerciseId };
      const suggestion = suggestedStartingWeight(exercise, {
        ...person,
        targetReps: person.targetReps ?? numeric(top.repMin) ?? 8,
        rir: person.rir ?? 2,
      });
      out.push({ exerciseId: x.exerciseId, ...suggestion });
    }
  }

  return out;
}
