/**
 * Seed data: the exercise library and the starting day templates.
 *
 * Day templates are the unit you pick from on the phone. They belong to a
 * program only for grouping — on any given day you can start any template,
 * from either program, in any order.
 */

export const EXERCISE_SEED = [
  // ---- Push ----
  { id: 'bb-bench', name: 'Barbell Bench Press', barType: 'olympic', muscleGroup: 'chest' },
  { id: 'incline-bb-bench', name: 'Incline Barbell Bench Press', barType: 'olympic', muscleGroup: 'chest' },
  { id: 'db-bench', name: 'Dumbbell Bench Press', barType: 'stack', muscleGroup: 'chest', entry: 'per-hand' },
  { id: 'incline-db-press', name: 'Incline Dumbbell Press', barType: 'stack', muscleGroup: 'chest', videoUrl: 'https://www.youtube.com/watch?v=awEEyL5zGvU', entry: 'per-hand' },
  { id: 'chest-press-machine', name: 'Chest Press Machine', barType: 'none', muscleGroup: 'chest', videoUrl: 'https://www.youtube.com/watch?v=CIykDiF4sfg' },
  { id: 'ohp', name: 'Standing Overhead Press', barType: 'olympic', muscleGroup: 'shoulders' },
  { id: 'db-shoulder-press', name: 'Seated Dumbbell Shoulder Press', barType: 'stack', muscleGroup: 'shoulders', entry: 'per-hand' },
  { id: 'lateral-raise', name: 'Dumbbell Lateral Raise', barType: 'stack', muscleGroup: 'shoulders', videoUrl: 'https://www.youtube.com/watch?v=Y29xKcze8Ik', entry: 'per-hand' },
  { id: 'weighted-dip', name: 'Weighted Dip', barType: 'stack', muscleGroup: 'chest' },
  { id: 'tricep-pushdown', name: 'Cable Tricep Pushdown', barType: 'stack', muscleGroup: 'triceps' },
  { id: 'skullcrusher', name: 'EZ Bar Skullcrusher', barType: 'ez', muscleGroup: 'triceps' },
  { id: 'overhead-tricep-ext', name: 'Overhead Cable Tricep Extension (triangle)', barType: 'stack', muscleGroup: 'triceps' },
  // Smith bar is counterbalanced, so the number that matters is the plates on it.
  { id: 'jm-press', name: 'JM Press (Smith Machine)', barType: 'none-total', muscleGroup: 'triceps' },
  { id: 'decline-db-fly', name: 'Decline Dumbbell Chest Fly', barType: 'stack', muscleGroup: 'chest', entry: 'per-hand' },
  { id: 'cable-fly-high', name: 'Cable Top-Down Chest Fly', barType: 'stack', muscleGroup: 'chest' },
  { id: 'cable-fly-low', name: 'Cable Bottom-Up Chest Fly', barType: 'stack', muscleGroup: 'chest' },
  { id: 'pec-deck', name: 'Pec Deck', barType: 'stack', muscleGroup: 'chest' },
  { id: 'bench-lateral-raise', name: 'Bench Reclined Lateral Raise', barType: 'stack', muscleGroup: 'shoulders', entry: 'per-hand' },
  { id: 'lying-cable-lateral', name: 'Lying Cable Lateral Raise', barType: 'stack', muscleGroup: 'shoulders' },
  { id: 'cable-lateral', name: 'Cable Lateral Raise', barType: 'stack', muscleGroup: 'shoulders' },
  { id: 'machine-lateral', name: 'Machine Lateral Raise', barType: 'stack', muscleGroup: 'shoulders' },
  { id: 'rear-delt-fly', name: 'Rear Delt Fly', barType: 'stack', muscleGroup: 'shoulders', entry: 'per-hand' },
  { id: 'front-raise', name: 'Front Raise', barType: 'stack', muscleGroup: 'shoulders' },
  { id: 'arnold-press', name: 'Arnold Press', barType: 'stack', muscleGroup: 'shoulders' },
  { id: 'machine-shoulder-press', name: 'Machine Shoulder Press', barType: 'none', muscleGroup: 'shoulders', videoUrl: 'https://www.youtube.com/watch?v=X0SteQbRbCo' },
  { id: 'close-grip-bench', name: 'Close Grip Bench Press', barType: 'olympic', muscleGroup: 'triceps' },
  { id: 'decline-bench', name: 'Decline Barbell Bench Press', barType: 'olympic', muscleGroup: 'chest' },
  { id: 'smith-bench', name: 'Smith Machine Bench Press', barType: 'none-total', muscleGroup: 'chest' },
  { id: 'smith-incline', name: 'Smith Machine Incline Press', barType: 'none-total', muscleGroup: 'chest' },
  { id: 'tricep-kickback', name: 'Tricep Kickback', barType: 'stack', muscleGroup: 'triceps', videoUrl: 'https://www.youtube.com/watch?v=XuH2W_R5YoA' },
  { id: 'rope-pushdown', name: 'Rope Tricep Pushdown', barType: 'stack', muscleGroup: 'triceps', videoUrl: 'https://www.youtube.com/watch?v=vPeQu_L-1n0' },
  { id: 'dip-machine', name: 'Assisted / Machine Dip', barType: 'stack', muscleGroup: 'triceps' },
  { id: 'push-up', name: 'Push-Up (weighted)', barType: 'stack', muscleGroup: 'chest' },

  // ---- Pull ----
  { id: 'deadlift', name: 'Barbell Deadlift', barType: 'olympic', muscleGroup: 'back' },
  { id: 'bb-row', name: 'Barbell Row', barType: 'olympic', muscleGroup: 'back' },
  { id: 't-bar-row', name: 'T-Bar Row', barType: 'none', muscleGroup: 'back' },
  { id: 'weighted-pullup', name: 'Weighted Pull-up', barType: 'stack', muscleGroup: 'back' },
  { id: 'lat-pulldown', name: 'Lat Pulldown', barType: 'stack', muscleGroup: 'back', videoUrl: 'https://www.youtube.com/watch?v=CAwf7n6Luuc' },
  { id: 'cable-row', name: 'Seated Cable Row', barType: 'stack', muscleGroup: 'back', videoUrl: 'https://www.youtube.com/watch?v=OeLb503NZHk' },
  { id: 'db-row', name: 'Single-Arm Dumbbell Row', barType: 'stack', muscleGroup: 'back', videoUrl: 'https://www.youtube.com/watch?v=fURsHPHgssI', entry: 'per-hand', unilateral: true },
  // A T-bar sleeve is loaded once, so the plates on it are the whole load.
  { id: 'chest-supported-row', name: 'Chest Supported T-Bar Row', barType: 'none-total', muscleGroup: 'back' },
  { id: 'cable-curl', name: 'Cable Curl', barType: 'stack', muscleGroup: 'biceps', videoUrl: 'https://www.youtube.com/watch?v=u9XtfyqeJd4' },
  { id: 'cable-hammer-curl', name: 'Cable Hammer Curl', barType: 'stack', muscleGroup: 'biceps' },
  { id: 'preacher-curl', name: 'Preacher Curl', barType: 'stack', muscleGroup: 'biceps' },
  { id: 'incline-db-curl', name: 'Incline Dumbbell Curl', barType: 'stack', muscleGroup: 'biceps', entry: 'per-hand' },
  { id: 'concentration-curl', name: 'Concentration Curl', barType: 'stack', muscleGroup: 'biceps' },
  { id: 'reverse-curl', name: 'Reverse Curl', barType: 'ez', muscleGroup: 'biceps' },
  { id: 'machine-row', name: 'Machine Row', barType: 'none', muscleGroup: 'back' },
  { id: 'seal-row', name: 'Seal Row', barType: 'olympic', muscleGroup: 'back' },
  { id: 'meadows-row', name: 'Meadows Row', barType: 'none-total', muscleGroup: 'back' },
  { id: 'straight-arm-pulldown', name: 'Straight-Arm Pulldown', barType: 'stack', muscleGroup: 'back' },
  { id: 'neutral-pulldown', name: 'Neutral Grip Lat Pulldown', barType: 'stack', muscleGroup: 'back' },
  { id: 'assisted-pullup', name: 'Assisted Pull-up', barType: 'stack', muscleGroup: 'back' },
  { id: 'chin-up', name: 'Weighted Chin-up', barType: 'stack', muscleGroup: 'back' },
  { id: 'shrug', name: 'Barbell Shrug', barType: 'olympic', muscleGroup: 'back' },
  { id: 'db-shrug', name: 'Dumbbell Shrug', barType: 'stack', muscleGroup: 'back', entry: 'per-hand' },
  { id: 'rack-pull', name: 'Rack Pull', barType: 'olympic', muscleGroup: 'back' },
  { id: 'good-morning', name: 'Good Morning', barType: 'olympic', muscleGroup: 'hamstrings' },
  { id: 'face-pull', name: 'Cable Face Pull', barType: 'stack', muscleGroup: 'shoulders' },
  { id: 'bb-curl', name: 'EZ Bar Curl', barType: 'ez', muscleGroup: 'biceps' },
  { id: 'db-curl', name: 'Dumbbell Curl', barType: 'stack', muscleGroup: 'biceps', entry: 'per-hand' },
  { id: 'hammer-curl', name: 'Hammer Curl', barType: 'stack', muscleGroup: 'biceps', videoUrl: 'https://www.youtube.com/watch?v=zC3nLlEvin4', entry: 'per-hand' },

  // ---- Legs ----
  { id: 'squat', name: 'Barbell Back Squat', barType: 'olympic', muscleGroup: 'quads' },
  { id: 'front-squat', name: 'Front Squat', barType: 'olympic', muscleGroup: 'quads' },
  { id: 'leg-press', name: 'Leg Press', barType: 'none', muscleGroup: 'quads', videoUrl: 'https://www.youtube.com/watch?v=XNvaNipSycI' },
  { id: 'hack-squat', name: 'Hack Squat', barType: 'none', muscleGroup: 'quads' },
  { id: 'rdl', name: 'Romanian Deadlift', barType: 'olympic', muscleGroup: 'hamstrings', videoUrl: 'https://www.youtube.com/watch?v=uhghy9pFIPY' },
  { id: 'leg-curl', name: 'Lying Leg Curl', barType: 'stack', muscleGroup: 'hamstrings' },
  { id: 'leg-extension', name: 'Leg Extension', barType: 'stack', muscleGroup: 'quads' },
  { id: 'bulgarian-split-squat', name: 'Bulgarian Split Squat', barType: 'stack', muscleGroup: 'quads', videoUrl: 'https://www.youtube.com/watch?v=uKvbvGEBhRg', entry: 'per-hand' },
  { id: 'hip-thrust', name: 'Barbell Hip Thrust', barType: 'olympic', muscleGroup: 'glutes', videoUrl: 'https://www.youtube.com/watch?v=pBH7pKHn-dI' },
  { id: 'standing-calf-raise', name: 'Standing Calf Raise', barType: 'none', muscleGroup: 'calves', videoUrl: 'https://www.youtube.com/watch?v=4HQ8Am9IuME' },
  { id: 'seated-calf-raise', name: 'Seated Calf Raise', barType: 'none', muscleGroup: 'calves', videoUrl: 'https://www.youtube.com/watch?v=I1uQtobaNRQ' },
  { id: 'leg-press-calf-raise', name: 'Leg Press Calf Raise', barType: 'none', muscleGroup: 'calves' },
  { id: 'pendulum-squat', name: 'Pendulum Squat', barType: 'none', muscleGroup: 'quads' },
  { id: 'smith-squat', name: 'Smith Machine Squat', barType: 'none-total', muscleGroup: 'quads' },
  { id: 'goblet-squat', name: 'Goblet Squat', barType: 'stack', muscleGroup: 'quads', videoUrl: 'https://www.youtube.com/watch?v=zsN2WvklwDk' },
  { id: 'walking-lunge', name: 'Walking Lunge', barType: 'stack', muscleGroup: 'quads', entry: 'per-hand' },
  { id: 'step-up', name: 'Step-Up', barType: 'stack', muscleGroup: 'quads', entry: 'per-hand' },
  { id: 'seated-leg-curl', name: 'Seated Leg Curl', barType: 'stack', muscleGroup: 'hamstrings', videoUrl: 'https://www.youtube.com/watch?v=70P96Zns5OA' },
  { id: 'nordic-curl', name: 'Nordic Hamstring Curl', barType: 'stack', muscleGroup: 'hamstrings' },
  { id: 'back-extension', name: 'Back Extension', barType: 'stack', muscleGroup: 'hamstrings' },
  { id: 'glute-ham-raise', name: 'Glute Ham Raise', barType: 'stack', muscleGroup: 'hamstrings' },
  { id: 'abductor-machine', name: 'Hip Abduction Machine', barType: 'stack', muscleGroup: 'glutes', videoUrl: 'https://www.youtube.com/watch?v=5O_Y9l__iao' },
  { id: 'adductor-machine', name: 'Hip Adduction Machine', barType: 'stack', muscleGroup: 'glutes', videoUrl: 'https://www.youtube.com/watch?v=CjAVezAggkI' },
  { id: 'sled-push', name: 'Sled Push', barType: 'none-total', muscleGroup: 'quads' },
  { id: 'trap-bar-deadlift', name: 'Trap Bar Deadlift', barType: 'trap', muscleGroup: 'back' },
  { id: 'sumo-deadlift', name: 'Sumo Deadlift', barType: 'olympic', muscleGroup: 'back' },
  { id: 'wrist-curl', name: 'Wrist Curl', barType: 'stack', muscleGroup: 'forearms' },
  { id: 'farmers-carry', name: "Farmer's Carry", barType: 'stack', muscleGroup: 'forearms' },

  // ---- Core ----
  { id: 'cable-crunch', name: 'Cable Crunch', barType: 'stack', muscleGroup: 'core', videoUrl: 'https://www.youtube.com/watch?v=0KEP6A1deBE' },
  { id: 'cable-glute-kickback', name: 'Cable Glute Kickback', barType: 'stack', muscleGroup: 'glutes', videoUrl: 'https://www.youtube.com/watch?v=5jJNfIlKTmg' },
  { id: 'hanging-leg-raise', name: 'Hanging Leg Raise', barType: 'stack', muscleGroup: 'core', videoUrl: 'https://www.youtube.com/watch?v=vwl68EF9M2Q' },
];

const HEAVY = 210;
const LIGHT = 90;

/** [exerciseId, schemeId, restSeconds] */
const d = (exerciseId, schemeId, rest) => ({ exerciseId, schemeId, restSeconds: rest });

/** One slot, two working sets: supinated then pronated, each taken to failure. */
export const SUPINATED_PRONATED = {
  id: 'supinated-pronated',
  name: 'Supinated then pronated',
  warmups: [{ pct: 0.5, reps: '10' }],
  working: [
    { pct: 1.0, repMin: 10, repMax: 20, note: 'Supinated grip — to failure' },
    { pct: 1.0, repMin: 10, repMax: 20, note: 'Pronated grip — to failure' },
  ],
};

export const PROGRAM_SEED = [
  {
    id: 'ppl-5',
    name: 'Push / Pull / Legs',
    daysPerWeek: 5,
    days: [
      {
        id: 'push-1',
        name: 'Push 1',
        exercises: [
          d('bb-bench', 'rp-3', HEAVY),
          d('incline-db-press', 'rp-2', HEAVY),
          d('ohp', 'rp-2', HEAVY),
          d('lateral-raise', 'high-rep-2', LIGHT),
          d('tricep-pushdown', 'high-rep-2', LIGHT),
        ],
      },
      {
        id: 'pull-1',
        name: 'Pull 1',
        exercises: [
          d('bb-row', 'rp-3', HEAVY),
          d('lat-pulldown', 'rp-2', HEAVY),
          d('cable-row', 'rp-2', HEAVY),
          d('face-pull', 'high-rep-2', LIGHT),
          d('bb-curl', 'rp-2', LIGHT),
        ],
      },
      {
        id: 'legs-1',
        name: 'Legs 1',
        exercises: [
          d('squat', 'rp-3', HEAVY),
          d('rdl', 'rp-2', HEAVY),
          d('leg-press', 'rp-2', HEAVY),
          d('leg-curl', 'rp-2', LIGHT),
          d('standing-calf-raise', 'flat-5', LIGHT),
        ],
      },
      {
        id: 'push-2',
        name: 'Push 2',
        exercises: [
          d('incline-bb-bench', 'rp-3', HEAVY),
          d('db-bench', 'rp-2', HEAVY),
          d('db-shoulder-press', 'rp-2', HEAVY),
          d('lateral-raise', 'high-rep-2', LIGHT),
          d('skullcrusher', 'rp-2', LIGHT),
        ],
      },
      {
        id: 'pull-2',
        name: 'Pull 2',
        exercises: [
          d('deadlift', 'rp-2', HEAVY),
          d('weighted-pullup', 'rp-3', HEAVY),
          d('t-bar-row', 'rp-2', HEAVY),
          d('db-row', 'rp-2', LIGHT),
          d('hammer-curl', 'rp-2', LIGHT),
        ],
      },
    ],
  },
  {
    id: 'ul-4',
    name: 'Upper / Lower',
    daysPerWeek: 4,
    days: [
      {
        id: 'upper-1',
        name: 'Upper 1',
        // Mirrors a real session rather than a plan: set counts vary per lift
        // because that is how the day is actually trained.
        exercises: [
          d('incline-db-press', 'rp-3', 210),
          d('lat-pulldown', 'rp-3', HEAVY),
          d('chest-supported-row', 'rp-2', HEAVY),
          d('jm-press', 'rp-3', HEAVY),
          d('bench-lateral-raise', 'flat-4', LIGHT),
          d('bb-curl', 'rp-2', LIGHT),
          d('cable-fly-high', 'single', LIGHT),
          d('overhead-tricep-ext', 'high-rep-2', LIGHT),
          d('cable-hammer-curl', 'rp-3', LIGHT),
        ],
      },
      {
        id: 'lower-1',
        name: 'Lower 1',
        exercises: [
          d('squat', 'rp-3', HEAVY),
          d('rdl', 'rp-2', HEAVY),
          d('leg-press', 'rp-2', HEAVY),
          d('leg-curl', 'rp-2', LIGHT),
          d('standing-calf-raise', 'flat-5', LIGHT),
        ],
      },
      {
        id: 'upper-2',
        name: 'Upper 2',
        exercises: [
          d('incline-bb-bench', 'rp-3', HEAVY),
          d('weighted-pullup', 'rp-3', HEAVY),
          d('db-shoulder-press', 'rp-2', HEAVY),
          d('cable-row', 'rp-2', HEAVY),
          d('hammer-curl', 'rp-2', LIGHT),
          d('skullcrusher', 'rp-2', LIGHT),
        ],
      },
      {
        id: 'lower-2',
        name: 'Lower 2',
        exercises: [
          d('deadlift', 'rp-2', HEAVY),
          d('front-squat', 'rp-3', HEAVY),
          d('hack-squat', 'rp-2', HEAVY),
          d('leg-extension', 'rp-2', LIGHT),
          d('seated-calf-raise', 'flat-5', LIGHT),
        ],
      },
    ],
  },

];

/**
 * A program that is **not** in `PROGRAM_SEED`, deliberately.
 *
 * `mergeSeed` folds the seed into every phone that launches the app, additively,
 * so anything in `PROGRAM_SEED` arrives on *his* phone too. The first version of
 * this lived there and put "Lower · Glutes 1" on his Train tab — caught by a test
 * that counted the days on the home screen and found thirteen where there had
 * been nine. A program belongs to one person, and the seed is shared.
 *
 * So it is exported on its own and installed only when somebody registers as a
 * member. The lifts it uses are all in `EXERCISE_SEED`, which is genuinely
 * shared: a library everyone can pick from is the point, and an extra lift nobody
 * uses costs a row.
 */
export const MEMBER_PROGRAM = /**
   * Four days, each one almost a whole body, glutes focused on three of them.
   *
   * The constraints were given: every muscle group at least twice a week, glutes
   * three times, four days, **almost full body each day**. The first three are
   * weekly totals and `checkCoverage` has held them from the start. The fourth is
   * a per-day shape, nothing was checking it, and the first version of this
   * program broke it while passing everything else — it was a
   * lower / upper / lower / full-body split, flawless over a week and half a body
   * on three days out of four. He had to point that out, which is what a rule
   * living in somebody's head rather than in the code costs.
   *
   * So `checkDays` now states it and `test/jeanny.test.js` asserts it: every day
   * carries a lower-body lift, an upper push, an upper pull and at least six of
   * the ten muscle groups. Both checks run against secondary muscles too, which
   * is the only way a full-body day counts honestly.
   *
   * Three things shaped the exercise choices beyond the two rules:
   *
   * **Machines and dumbbells rather than a loaded barbell.** She is starting; the
   * point of the first months is turning up and adding load, not learning to
   * brace a 45 lb bar. A hip thrust from a bench and a leg press teach the same
   * pattern with a fraction of the setup, and the reverse-pyramid logic this app
   * is built on works identically on them.
   *
   * **Glute focus means two glute slots on those days, not one.** A single hip
   * thrust makes glutes *present*; a hip thrust plus an abduction or a kickback
   * makes the day about them. `weeklyCoverage` reports slots alongside days for
   * exactly this distinction. Day three has one incidental glute slot — a leg
   * press trains glutes whatever it is called — and that is not a fourth glute
   * session, which is why the focused days are counted separately.
   *
   * **The order within a day is the same every time: the heavy lower lift, then
   * the upper push, then the upper pull, then the accessories.** Reverse pyramid
   * puts the top set first and the first lift gets the best effort, so the lift
   * the week is built around goes first. Keeping the order identical across four
   * days also means she learns one session, not four.
   *
   * The day ids are deliberately **not** the ones the first version used. Her
   * program is installed additively by id, so reusing `glute-full-1` for a day
   * with different contents would have left her phone showing the old day under
   * the new name while silently keeping three orphans — seven days, three of them
   * stale. New ids make the replacement visible to `installMemberProgram`, which
   * retires the days it replaced unless she has actually trained one.
   *
   * Rest is shorter than his throughout. He trains to failure on a reverse
   * pyramid with three-minute rests; that is a specific choice for a specific
   * goal, and inheriting it would make her sessions an hour longer than they need
   * to be for no benefit she can currently use.
   */
  {
    id: 'glute-4',
    name: 'Full Body · Glute Focus',
    daysPerWeek: 4,
    days: [
      {
        // Hip thrust first, while she is fresh, because it is the lift the whole
        // program is built around.
        id: 'glute-fb-1',
        name: 'Full Body · Glutes 1',
        exercises: [
          d('hip-thrust', 'rp-3', 150),
          d('chest-press-machine', 'rp-2', 120),
          d('cable-row', 'rp-2', 120),
          d('abductor-machine', 'high-rep-2', 75),
          d('leg-extension', 'high-rep-2', 75),
          d('standing-calf-raise', 'flat-5', 60),
          d('cable-crunch', 'high-rep-2', 60),
        ],
      },
      {
        // The hinge day. An RDL trains glutes and hamstrings together, so the
        // kickback is what makes the day *about* glutes rather than merely
        // including them.
        id: 'glute-fb-2',
        name: 'Full Body · Glutes 2',
        exercises: [
          d('rdl', 'rp-3', 150),
          d('machine-shoulder-press', 'rp-2', 120),
          d('lat-pulldown', 'rp-2', 120),
          d('cable-glute-kickback', 'high-rep-2', 75),
          d('pec-deck', 'high-rep-2', 75),
          d('cable-curl', 'high-rep-2', 75),
          d('seated-calf-raise', 'flat-5', 60),
        ],
      },
      {
        // The one day without a glute focus. Three focused days was the target
        // and a fourth would come out of recovery rather than progress — so this
        // day leads on a press and takes its legs from a leg press and a curl.
        id: 'glute-fb-3',
        name: 'Full Body · Upper Led',
        exercises: [
          d('incline-db-press', 'rp-3', 150),
          d('db-row', 'rp-2', 120),
          d('leg-press', 'rp-2', 150),
          d('seated-leg-curl', 'rp-2', 120),
          d('lateral-raise', 'high-rep-2', 75),
          d('rope-pushdown', 'high-rep-2', 75),
          d('hanging-leg-raise', 'high-rep-2', 60),
        ],
      },
      {
        // Glutes a third time, led by a squat pattern: a goblet squat asks for
        // range and bracing where the hip thrust asks for load, and they grow
        // different things.
        id: 'glute-fb-4',
        name: 'Full Body · Glutes 3',
        exercises: [
          d('goblet-squat', 'rp-3', 150),
          d('hip-thrust', 'rp-2', 150),
          d('dip-machine', 'rp-2', 120),
          d('neutral-pulldown', 'rp-2', 120),
          d('adductor-machine', 'high-rep-2', 75),
          d('hammer-curl', 'high-rep-2', 75),
          d('leg-press-calf-raise', 'flat-5', 60),
        ],
      },
    ],
  };
