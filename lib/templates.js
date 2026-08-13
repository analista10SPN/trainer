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
  { id: 'db-bench', name: 'Dumbbell Bench Press', barType: 'stack', muscleGroup: 'chest' },
  { id: 'incline-db-press', name: 'Incline Dumbbell Press', barType: 'stack', muscleGroup: 'chest' },
  { id: 'chest-press-machine', name: 'Chest Press Machine', barType: 'none', muscleGroup: 'chest' },
  { id: 'ohp', name: 'Standing Overhead Press', barType: 'olympic', muscleGroup: 'shoulders' },
  { id: 'db-shoulder-press', name: 'Seated Dumbbell Shoulder Press', barType: 'stack', muscleGroup: 'shoulders' },
  { id: 'lateral-raise', name: 'Dumbbell Lateral Raise', barType: 'stack', muscleGroup: 'shoulders' },
  { id: 'weighted-dip', name: 'Weighted Dip', barType: 'stack', muscleGroup: 'chest' },
  { id: 'tricep-pushdown', name: 'Cable Tricep Pushdown', barType: 'stack', muscleGroup: 'triceps' },
  { id: 'skullcrusher', name: 'EZ Bar Skullcrusher', barType: 'ez', muscleGroup: 'triceps' },
  { id: 'overhead-tricep-ext', name: 'Overhead Cable Tricep Extension (triangle)', barType: 'stack', muscleGroup: 'triceps' },
  // Smith bar is counterbalanced, so the number that matters is the plates on it.
  { id: 'jm-press', name: 'JM Press (Smith Machine)', barType: 'none-total', muscleGroup: 'triceps' },
  { id: 'decline-db-fly', name: 'Decline Dumbbell Chest Fly', barType: 'stack', muscleGroup: 'chest' },
  { id: 'cable-fly-high', name: 'Cable Top-Down Chest Fly', barType: 'stack', muscleGroup: 'chest' },
  { id: 'cable-fly-low', name: 'Cable Bottom-Up Chest Fly', barType: 'stack', muscleGroup: 'chest' },
  { id: 'pec-deck', name: 'Pec Deck', barType: 'stack', muscleGroup: 'chest' },
  { id: 'bench-lateral-raise', name: 'Bench Reclined Lateral Raise', barType: 'stack', muscleGroup: 'shoulders' },
  { id: 'lying-cable-lateral', name: 'Lying Cable Lateral Raise', barType: 'stack', muscleGroup: 'shoulders' },
  { id: 'cable-lateral', name: 'Cable Lateral Raise', barType: 'stack', muscleGroup: 'shoulders' },
  { id: 'machine-lateral', name: 'Machine Lateral Raise', barType: 'stack', muscleGroup: 'shoulders' },
  { id: 'rear-delt-fly', name: 'Rear Delt Fly', barType: 'stack', muscleGroup: 'shoulders' },
  { id: 'front-raise', name: 'Front Raise', barType: 'stack', muscleGroup: 'shoulders' },
  { id: 'arnold-press', name: 'Arnold Press', barType: 'stack', muscleGroup: 'shoulders' },
  { id: 'machine-shoulder-press', name: 'Machine Shoulder Press', barType: 'none', muscleGroup: 'shoulders' },
  { id: 'close-grip-bench', name: 'Close Grip Bench Press', barType: 'olympic', muscleGroup: 'triceps' },
  { id: 'decline-bench', name: 'Decline Barbell Bench Press', barType: 'olympic', muscleGroup: 'chest' },
  { id: 'smith-bench', name: 'Smith Machine Bench Press', barType: 'none-total', muscleGroup: 'chest' },
  { id: 'smith-incline', name: 'Smith Machine Incline Press', barType: 'none-total', muscleGroup: 'chest' },
  { id: 'tricep-kickback', name: 'Tricep Kickback', barType: 'stack', muscleGroup: 'triceps' },
  { id: 'rope-pushdown', name: 'Rope Tricep Pushdown', barType: 'stack', muscleGroup: 'triceps' },
  { id: 'dip-machine', name: 'Assisted / Machine Dip', barType: 'stack', muscleGroup: 'triceps' },
  { id: 'push-up', name: 'Push-Up (weighted)', barType: 'stack', muscleGroup: 'chest' },

  // ---- Pull ----
  { id: 'deadlift', name: 'Barbell Deadlift', barType: 'olympic', muscleGroup: 'back' },
  { id: 'bb-row', name: 'Barbell Row', barType: 'olympic', muscleGroup: 'back' },
  { id: 't-bar-row', name: 'T-Bar Row', barType: 'none', muscleGroup: 'back' },
  { id: 'weighted-pullup', name: 'Weighted Pull-up', barType: 'stack', muscleGroup: 'back' },
  { id: 'lat-pulldown', name: 'Lat Pulldown', barType: 'stack', muscleGroup: 'back' },
  { id: 'cable-row', name: 'Seated Cable Row', barType: 'stack', muscleGroup: 'back' },
  { id: 'db-row', name: 'Single-Arm Dumbbell Row', barType: 'stack', muscleGroup: 'back' },
  // A T-bar sleeve is loaded once, so the plates on it are the whole load.
  { id: 'chest-supported-row', name: 'Chest Supported T-Bar Row', barType: 'none-total', muscleGroup: 'back' },
  { id: 'cable-curl', name: 'Cable Curl', barType: 'stack', muscleGroup: 'biceps' },
  { id: 'cable-hammer-curl', name: 'Cable Hammer Curl', barType: 'stack', muscleGroup: 'biceps' },
  { id: 'preacher-curl', name: 'Preacher Curl', barType: 'stack', muscleGroup: 'biceps' },
  { id: 'incline-db-curl', name: 'Incline Dumbbell Curl', barType: 'stack', muscleGroup: 'biceps' },
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
  { id: 'db-shrug', name: 'Dumbbell Shrug', barType: 'stack', muscleGroup: 'back' },
  { id: 'rack-pull', name: 'Rack Pull', barType: 'olympic', muscleGroup: 'back' },
  { id: 'good-morning', name: 'Good Morning', barType: 'olympic', muscleGroup: 'hamstrings' },
  { id: 'face-pull', name: 'Cable Face Pull', barType: 'stack', muscleGroup: 'shoulders' },
  { id: 'bb-curl', name: 'EZ Bar Curl', barType: 'ez', muscleGroup: 'biceps' },
  { id: 'db-curl', name: 'Dumbbell Curl', barType: 'stack', muscleGroup: 'biceps' },
  { id: 'hammer-curl', name: 'Hammer Curl', barType: 'stack', muscleGroup: 'biceps' },

  // ---- Legs ----
  { id: 'squat', name: 'Barbell Back Squat', barType: 'olympic', muscleGroup: 'quads' },
  { id: 'front-squat', name: 'Front Squat', barType: 'olympic', muscleGroup: 'quads' },
  { id: 'leg-press', name: 'Leg Press', barType: 'none', muscleGroup: 'quads' },
  { id: 'hack-squat', name: 'Hack Squat', barType: 'none', muscleGroup: 'quads' },
  { id: 'rdl', name: 'Romanian Deadlift', barType: 'olympic', muscleGroup: 'hamstrings' },
  { id: 'leg-curl', name: 'Lying Leg Curl', barType: 'stack', muscleGroup: 'hamstrings' },
  { id: 'leg-extension', name: 'Leg Extension', barType: 'stack', muscleGroup: 'quads' },
  { id: 'bulgarian-split-squat', name: 'Bulgarian Split Squat', barType: 'stack', muscleGroup: 'quads' },
  { id: 'hip-thrust', name: 'Barbell Hip Thrust', barType: 'olympic', muscleGroup: 'glutes' },
  { id: 'standing-calf-raise', name: 'Standing Calf Raise', barType: 'none', muscleGroup: 'calves' },
  { id: 'seated-calf-raise', name: 'Seated Calf Raise', barType: 'none', muscleGroup: 'calves' },
  { id: 'leg-press-calf-raise', name: 'Leg Press Calf Raise', barType: 'none', muscleGroup: 'calves' },
  { id: 'pendulum-squat', name: 'Pendulum Squat', barType: 'none', muscleGroup: 'quads' },
  { id: 'smith-squat', name: 'Smith Machine Squat', barType: 'none-total', muscleGroup: 'quads' },
  { id: 'goblet-squat', name: 'Goblet Squat', barType: 'stack', muscleGroup: 'quads' },
  { id: 'walking-lunge', name: 'Walking Lunge', barType: 'stack', muscleGroup: 'quads' },
  { id: 'step-up', name: 'Step-Up', barType: 'stack', muscleGroup: 'quads' },
  { id: 'seated-leg-curl', name: 'Seated Leg Curl', barType: 'stack', muscleGroup: 'hamstrings' },
  { id: 'nordic-curl', name: 'Nordic Hamstring Curl', barType: 'stack', muscleGroup: 'hamstrings' },
  { id: 'back-extension', name: 'Back Extension', barType: 'stack', muscleGroup: 'hamstrings' },
  { id: 'glute-ham-raise', name: 'Glute Ham Raise', barType: 'stack', muscleGroup: 'hamstrings' },
  { id: 'abductor-machine', name: 'Hip Abduction Machine', barType: 'stack', muscleGroup: 'glutes' },
  { id: 'adductor-machine', name: 'Hip Adduction Machine', barType: 'stack', muscleGroup: 'glutes' },
  { id: 'sled-push', name: 'Sled Push', barType: 'none-total', muscleGroup: 'quads' },
  { id: 'trap-bar-deadlift', name: 'Trap Bar Deadlift', barType: 'trap', muscleGroup: 'back' },
  { id: 'sumo-deadlift', name: 'Sumo Deadlift', barType: 'olympic', muscleGroup: 'back' },
  { id: 'wrist-curl', name: 'Wrist Curl', barType: 'stack', muscleGroup: 'forearms' },
  { id: 'farmers-carry', name: "Farmer's Carry", barType: 'stack', muscleGroup: 'forearms' },

  // ---- Core ----
  { id: 'cable-crunch', name: 'Cable Crunch', barType: 'stack', muscleGroup: 'core' },
  { id: 'hanging-leg-raise', name: 'Hanging Leg Raise', barType: 'stack', muscleGroup: 'core' },
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
