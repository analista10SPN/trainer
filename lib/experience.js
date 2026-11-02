/**
 * How long somebody has been lifting, and what follows from it.
 *
 * Two things follow, and only two: **how close to failure** their sets should
 * be taken, and **whether they need a week to find out what they can lift**
 * before the app prescribes a number. Everything else about a person lives in
 * `intake.js`; everything the answers turn into lives in `prescribe.js`. This
 * module is the interpretation in the middle, and it is separate so the coach
 * and the prescription cannot disagree about what "beginner" implies.
 *
 * ## Why a beginner is held further from failure
 *
 * Reverse pyramid asks for a top set taken to failure, and that instruction is
 * safe for somebody who has learned what their failure looks like. In month
 * three it is not: the last two reps are where form breaks, a beginner cannot
 * yet tell a hard rep from a failing one, and the app has no way to see the
 * difference — `analysis.js` says as much about its own limits. So the first
 * bucket works at 2-3 reps in reserve and everybody else at 0-1.
 *
 * An unknown bucket gets the **beginner** answer, not the average one. Erring
 * toward the lighter prescription is the only direction in which being wrong
 * costs nothing but time.
 *
 * ## The buckets were widened on purpose
 *
 * They were asked for as "under 6 months, 1-2 years, 3-5, 5+". Those four do
 * not cover anybody: a person at eight months belongs to none of them, and
 * neither does somebody at two and a half years. A list with holes is a form
 * that cannot be answered honestly, so the boundaries meet. The four groups and
 * their order are unchanged — only the edges moved, and a test requires the
 * list to be total over every month from nought to thirty-three years.
 */

/**
 * The four, oldest boundary first. `toMonths` is exclusive, and `null` on the
 * last one because experience has no ceiling.
 */
export const EXPERIENCE_BUCKETS = [
  {
    id: 'under-6mo',
    fromMonths: 0,
    toMonths: 6,
    label: 'Under 6 months',
    says: 'New to lifting, or back after a long time away.',
  },
  {
    id: '6mo-2y',
    fromMonths: 6,
    toMonths: 24,
    label: '6 months to 2 years',
    says: 'Training regularly, still adding weight most months.',
  },
  {
    id: '2-5y',
    fromMonths: 24,
    toMonths: 60,
    label: '2 to 5 years',
    says: 'Past the easy gains, and knows what a hard set feels like.',
  },
  {
    id: 'over-5y',
    fromMonths: 60,
    toMonths: null,
    label: 'Over 5 years',
    says: 'Long-term trainee, progressing in small increments.',
  },
];

export const EXPERIENCE_IDS = EXPERIENCE_BUCKETS.map((b) => b.id);

/** The bucket, or `null` — never a default, because callers below choose their own. */
export function bucketOf(id) {
  return EXPERIENCE_BUCKETS.find((b) => b.id === id) ?? null;
}

/** The first bucket, and only the first. */
export function isBeginner(id) {
  return bucketOf(id)?.id === EXPERIENCE_BUCKETS[0].id;
}

/** Reps left in the tank on a top set. Unknown counts as beginner. */
export function rirTargetFor(id) {
  return isBeginner(id) || !bucketOf(id) ? { low: 2, high: 3 } : { low: 0, high: 1 };
}

/**
 * Whether the week that finds a starting weight is a requirement or an offer.
 *
 * `required` for a beginner is still not a lock — nothing in this app refuses
 * to let somebody train — but it is the difference between a screen that
 * recommends and a screen that asks you to decline.
 */
export function testWeekFor(id) {
  return isBeginner(id) || !bucketOf(id) ? 'required' : 'offered';
}

/**
 * What each bucket is additionally asked.
 *
 * Kept per bucket rather than asked of everybody, because a question that does
 * not apply is worse than no question: somebody in month two answering "which
 * lifts have stalled?" will invent a stall. Each question's `id` is unique
 * across the whole table — a test enforces it — so the answers are one flat
 * record and not a per-bucket shape the storage layer has to know about.
 */
const QUESTIONS = {
  'under-6mo': [
    {
      id: 'coached',
      type: 'yesno',
      says: 'Has anybody shown you how to do the main lifts?',
      why: 'Decides whether the program leads with machines or with barbells.',
    },
    {
      id: 'injuries',
      type: 'text',
      says: 'Anything that hurts, or that a doctor has told you to avoid?',
      why: 'Movements named here are substituted by pattern rather than dropped.',
    },
  ],
  '6mo-2y': [
    {
      id: 'current-program',
      type: 'choice',
      says: 'What have you been following?',
      options: ['Nothing structured', 'A plan from an app', 'A plan from a coach', 'My own'],
      why: 'A person already on a plan gets a split close to it, not a replacement.',
    },
    {
      id: 'knows-top-sets',
      type: 'yesno',
      says: 'Do you know roughly what you last worked up to on your main lifts?',
      why: 'If so, the test week can be skipped without guessing from population numbers.',
    },
  ],
  '2-5y': [
    {
      id: 'stalled',
      type: 'text',
      says: 'Which lifts have stopped moving?',
      why: 'A stalled lift gets a different rep range rather than more of the same.',
    },
    {
      id: 'tracks-rir',
      type: 'yesno',
      says: 'Do you already train by reps in reserve?',
      why: 'Decides whether the app explains RIR or just prescribes it.',
    },
  ],
  'over-5y': [
    {
      id: 'known-maxes',
      type: 'yesno',
      says: 'Do you have current one-rep maxes, or recent numbers close to them?',
      why: 'Real numbers beat any estimate this app can make.',
    },
    {
      id: 'specialising',
      type: 'choice',
      says: 'Is this block aimed at anything in particular?',
      options: ['General size and strength', 'A weak point', 'A meet or a test', 'Holding on while busy'],
      why: 'Sets how much of the week goes to the priority group.',
    },
  ],
};

/** The questions for a bucket. An unknown bucket is asked nothing. */
export function questionsFor(id) {
  return QUESTIONS[bucketOf(id)?.id] ?? [];
}
