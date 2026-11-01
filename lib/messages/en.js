/**
 * English, which is the source of truth.
 *
 * A key here with no Spanish renders in English and `missingKeys` says so, so
 * this file is where a string is added and `es.js` is where it catches up.
 *
 * An entry is either a string or an object of CLDR plural forms. The plural
 * entries are the ones that cannot be done any other way: `n === 1 ? '' : 's'`
 * appears twenty-odd times in `app.js`, is right in English by luck, is wrong in
 * most languages, and is already wrong *in English* in one place — the program
 * header renders "4 day".
 */

export const EN = {
  /* --------------------------------- the nav ------------------------------- */
  'nav.train': 'Train',
  'nav.history': 'History',
  'nav.coach': 'Coach',
  'nav.edit': 'Edit',
  'nav.setup': 'Setup',

  /* ----------------------------- Setup sections --------------------------- */
  'setup.you': 'You',
  'setup.training': 'Training',
  'setup.account': 'Account',
  'setup.app': 'App',

  /* ------------------------------ the verdicts ---------------------------- */
  'verdict.progressing': 'Progressing',
  'verdict.stagnant': 'Stalled',
  'verdict.regressing': 'Regressing',
  'verdict.tooFast': 'Too fast',

  /* -------------------------------- the counts ---------------------------- */
  'count.days': { one: '{n} day', other: '{n} days' },
  'count.sessions': { one: '{n} session', other: '{n} sessions' },
  'count.workoutsLogged': {
    one: '{n} workout logged. Tap a marked day.',
    other: '{n} workouts logged. Tap a marked day.',
  },
  'count.sessionsThisWeek': {
    one: '{n} session this week',
    other: '{n} sessions this week',
  },
  'count.liftsDoingFine': {
    one: 'Show the {n} lift that is doing fine',
    other: 'Show the {n} lifts that are doing fine',
  },
  'count.sessionsLeftOut': {
    one: '{n} session left out',
    other: '{n} sessions left out',
  },
  'count.visits': { one: '{n} visit', other: '{n} visits' },
  'count.readings': { one: '{n} reading', other: '{n} readings' },
  'count.sets': { one: '{n} set', other: '{n} sets' },
  'count.lifts': { one: '{n} lift', other: '{n} lifts' },
  'count.machineProfiles': {
    one: '{n} machine profile',
    other: '{n} machine profiles',
  },
  'count.itemsToUse': { one: 'Use {n} item', other: 'Use {n} items' },

  /* --------------------------------- units -------------------------------- */
  'unit.lb': 'lb',
  'unit.kg': 'kg',
  'unit.perDumbbell': '{unit} per dumbbell',
  'unit.each': '{value} {unit} ea',

  /* ------------------------------- the level ------------------------------ */
  'level.basic.title': 'Just the lift',
  'level.basic.blurb': 'Weight, reps, and which machine. Everything a workout is.',
  'level.full.title': 'Everything',
  'level.full.blurb': 'Adds tempo, straps and belts, how each set felt, and pairing lifts into supersets.',

  /* ------------------------------- coaching ------------------------------- */
  'coaching.heading': 'Coaching',
  'coaching.nobody': 'Nobody is coaching you. If somebody asks, they appear here with three switches and all three off — your training is not shared until you turn one on.',
  'coaching.asked': 'They asked to coach you. Nothing is shared until you say so, and you can take any of it back at any time.',
  'coaching.readTraining': 'My training',
  'coaching.readTraining.blurb': 'Workouts, sets and the verdicts worked out from them.',
  'coaching.readBody': 'My weight and food',
  'coaching.readBody.blurb': 'Weigh-ins, calories and the energy figures built on them.',
  'coaching.assign': 'Suggest my week',
  'coaching.assign.blurb': 'They can propose a week. You still decide whether to take it.',
  'coaching.youCoach': 'You coach',
  'coaching.nothingShared': 'nothing shared yet',
  'coaching.waiting': 'waiting',

  /* --------------------------------- gyms --------------------------------- */
  'gym.which': 'Which gym?',
  'gym.pending': 'waiting to be approved — yours for now',
  'gym.queue.heading': 'Waiting on you',
  'gym.queue.approve': "Put it on everyone's list",
  'gym.queue.reject': 'Not a real gym',
  'gym.noneRecorded': 'no gym recorded',

  /* -------------------------------- the note ------------------------------ */
  'note.add': '+ Note on this lift',
  'note.prompt': 'What was different about it today. Commas separate things you may want to find again — "close grip, lower pad" is two labels.',
  'note.usedBefore': 'Used before',
  'note.save': 'Save',
  'note.addIt': 'Add the note',
  'note.remove': 'Remove it',
};
