/**
 * Spanish, as it is spoken in the Dominican Republic.
 *
 * `en.js` is the source of truth and a test asserts this file covers every key
 * in it — because a gap here renders as perfectly good English, which makes a
 * half-written catalog indistinguishable from a finished one.
 *
 * Two conventions worth stating, since they come up on nearly every line:
 *
 * - **`tú`, not `usted`.** This is a training log somebody talks to between
 *   sets, and the formal register would read like a letter from a bank.
 * - **Gym vocabulary stays local.** "mancuerna" for a dumbbell, "disco" for a
 *   plate, "barra" for a bar, "serie" for a set, "repetición" for a rep. Where
 *   the gym itself uses the English word — a *lat pulldown*, a *press* — the
 *   English word is what somebody would actually say, and translating it would
 *   be less clear rather than more.
 */

export const ES = {
  /* --------------------------------- the nav ------------------------------- */
  'nav.train': 'Entrenar',
  'nav.history': 'Historial',
  'nav.coach': 'Entrenador',
  'nav.edit': 'Editar',
  'nav.setup': 'Ajustes',

  /* ----------------------------- Setup sections --------------------------- */
  'setup.you': 'Tú',
  'setup.training': 'Entrenamiento',
  'setup.account': 'Cuenta',
  'setup.app': 'App',

  /* ------------------------------ the verdicts ---------------------------- */
  'verdict.progressing': 'Progresando',
  'verdict.stagnant': 'Estancado',
  'verdict.regressing': 'Retrocediendo',
  'verdict.tooFast': 'Demasiado rápido',

  /* -------------------------------- the counts ---------------------------- */
  'count.days': { one: '{n} día', other: '{n} días' },
  'count.sessions': { one: '{n} sesión', other: '{n} sesiones' },
  'count.workoutsLogged': {
    one: '{n} entrenamiento registrado. Toca un día marcado.',
    other: '{n} entrenamientos registrados. Toca un día marcado.',
  },
  'count.sessionsThisWeek': {
    one: '{n} sesión esta semana',
    other: '{n} sesiones esta semana',
  },
  'count.liftsDoingFine': {
    one: 'Ver el {n} ejercicio que va bien',
    other: 'Ver los {n} ejercicios que van bien',
  },
  'count.sessionsLeftOut': {
    one: '{n} sesión excluida',
    other: '{n} sesiones excluidas',
  },
  'count.visits': { one: '{n} visita', other: '{n} visitas' },
  'count.readings': { one: '{n} medición', other: '{n} mediciones' },
  'count.sets': { one: '{n} serie', other: '{n} series' },
  'count.lifts': { one: '{n} ejercicio', other: '{n} ejercicios' },
  'count.machineProfiles': {
    one: '{n} perfil de máquina',
    other: '{n} perfiles de máquina',
  },
  'count.itemsToUse': { one: 'Usar {n} cosa', other: 'Usar {n} cosas' },

  /* --------------------------------- units -------------------------------- */
  'unit.lb': 'lb',
  'unit.kg': 'kg',
  'unit.perDumbbell': '{unit} por mancuerna',
  'unit.each': '{value} {unit} c/u',

  /* ------------------------------- the level ------------------------------ */
  'level.basic.title': 'Solo el ejercicio',
  'level.basic.blurb': 'Peso, repeticiones y en qué máquina. Todo lo que es un entrenamiento.',
  'level.full.title': 'Todo',
  'level.full.blurb': 'Añade tempo, correas y cinturón, cómo se sintió cada serie, y juntar ejercicios en superseries.',

  /* ------------------------------- coaching ------------------------------- */
  'coaching.heading': 'Entrenamiento con otra persona',
  'coaching.nobody': 'Nadie te está entrenando. Si alguien lo pide, aparece aquí con tres interruptores y los tres apagados — tu entrenamiento no se comparte hasta que tú enciendas uno.',
  'coaching.asked': 'Pidió entrenarte. No se comparte nada hasta que tú lo digas, y puedes quitar cualquiera de estos permisos cuando quieras.',
  'coaching.readTraining': 'Mi entrenamiento',
  'coaching.readTraining.blurb': 'Entrenamientos, series y los veredictos que salen de ellos.',
  'coaching.readBody': 'Mi peso y mi comida',
  'coaching.readBody.blurb': 'Pesajes, calorías y las cifras de energía que se calculan con ellos.',
  'coaching.assign': 'Proponerme la semana',
  'coaching.assign.blurb': 'Puede proponer una semana. Tú sigues decidiendo si la tomas.',
  'coaching.youCoach': 'Tú entrenas a',
  'coaching.nothingShared': 'todavía no comparte nada',
  'coaching.waiting': 'esperando',

  /* --------------------------------- gyms --------------------------------- */
  'gym.which': '¿En qué gym?',
  'gym.pending': 'esperando aprobación — por ahora solo tuyo',
  'gym.queue.heading': 'Esperando por ti',
  'gym.queue.approve': 'Ponerlo en la lista de todos',
  'gym.queue.reject': 'No es un gym de verdad',
  'gym.noneRecorded': 'sin gym registrado',

  /* -------------------------------- the note ------------------------------ */
  'note.add': '+ Nota sobre este ejercicio',
  'note.prompt': 'Qué fue distinto hoy. Las comas separan cosas que quizás quieras buscar después — "agarre cerrado, respaldo más bajo" son dos etiquetas.',
  'note.usedBefore': 'Ya usadas',
  'note.save': 'Guardar',
  'note.addIt': 'Añadir la nota',
  'note.remove': 'Quitarla',
};
