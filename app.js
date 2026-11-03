/**
 * Trainer — offline-first lifting log.
 *
 * The phone computes everything itself from its own copy of the data, using
 * the same modules the server uses. The network is only ever a backup channel.
 */

import {
  BAR_TYPES, DEFAULT_PLATES, getBarType,
  platesForTotal, totalFromPlates, roundToLoadable, roundToLoadableLb,
  barTypesFor, platesFor, DEFAULT_PLATES_KG,
} from './lib/plates.js';
import { buildPrescription, describeScheme } from './lib/scheme.js';
import { buildDayPlan, planAdHocExercise } from './lib/plan.js';
import { weekPlan } from './lib/week.js';
import { clientSummary } from './lib/clientview.js';
import {
  makeNote,
  upsertNote,
  noteFor,
  labelsFrom,
  isLiftNote,
} from './lib/liftnotes.js';
import { levelOf, recordsField, uncheckedBy } from './lib/level.js';
import { showWeight, commitWeight, formatWeight, formatBodyweight, fromUnit } from './lib/units.js';
import { resolveLocale, translator } from './lib/i18n.js';
import { cloneDay } from './lib/draft.js';
import { normaliseIntake } from './lib/intake.js';
import { EXPERIENCE_BUCKETS, rirTargetFor } from './lib/experience.js';
import { prescribe } from './lib/prescribe.js';
import { testWeekPlan, testResults, startingWeights, TEST_REPS } from './lib/testweek.js';
import { suggestedStartingWeight, suggestionsFor } from './lib/norms.js';
import { EN } from './lib/messages/en.js';
import { ES } from './lib/messages/es.js';
import {
  durationStats, consistency, gymFrequency, periodCompare, typicalRange,
  MAX_PLAUSIBLE_MINUTES as MAX_SESSION_MINUTES,
} from './lib/analytics.js';
import { summaryFindings as buildSummaryFindings, liftsAreHolding as coachLiftsAreHolding, avg }
  from './lib/coachpayload.js';
import {
  historyFor as repoHistoryFor,
  lastSessionFor as repoLastSessionFor,
  lastPerformed as repoLastPerformed,
  loggedExerciseList as repoLoggedExerciseList,
  liftFor as repoLiftFor,
} from './lib/repository.js';
import {
  buildLocalBootstrap, mergeSeed, upsertDayIn, removeDayFrom, upsertExerciseIn, upsertProgramIn, removeProgramFrom,
  settingsToProfile, profileToSettings, SHARED_SETTINGS } from './lib/bootstrap.js';
import { smallestStep } from './lib/progression.js';
import { analyzeAll , ADVICE } from './lib/analysis.js';
import { bestE1RM, totalVolume, percentSlope, numeric as numericValue } from './lib/strength.js';
import { summaryCacheKey } from './lib/summary.js';
import { parseReport } from './lib/report.js';
import { nutritionContext, bodyweightTrend } from './lib/nutrition.js';
import { parseQuickLog } from './lib/quicklog.js';
import { recoveryReport } from './lib/recovery.js';
import {
  sessionsByDay, monthGrid, liftsInSession, shiftMonth, latestMonth,
  MONTH_NAMES, WEEKDAY_INITIALS,
} from './lib/calendar.js';
import {
  makeGym, recordFix, nearestGym, allMachinesAt, rememberMachine, predictMachine, tracksMachine,
  gymsNear, RADIUS_MILES, machinesForLift,
  machineChanged, renameMachineAt, relabelMachine, sharedFields, mergeGyms,
  hideGymIn, showGymIn, visibleGyms,
} from './lib/gyms.js';
import { recallLast } from './lib/recall.js';
import { poseOf } from './lib/poses.js';
import { can, actorFrom, roleLabel } from './lib/roles.js';
import { groupSuspects, machineSuspects, loadUnitSuspects, doubleLoggedWeights, looksPaired }
  from './lib/audit.js';
import {
  proposeChanges,
  applyProposal,
  dueForReview,
  recordDecision,
  feedbackSummary,
  DECLINE_REASONS,
  FEEDBACK_SCALES,
} from './lib/adapt.js';
import { MEMBER_PROGRAM, PROGRAM_SEED, programForMember } from './lib/templates.js';
import {
  TEMPO_PRESETS, parseTempo, formatTempo, describeTempo, usualTempo, tempoDrift,
} from './lib/tempo.js';
import { egoCheck, loadAdvice } from './lib/diagnose.js';
import { profilesFrom, groupTrends } from './lib/profiles.js';
import { AIDS, normaliseAids, describeAids, usualAids, aidsChanged } from './lib/aids.js';
import {
  makeMetric,
  mergeMetrics,
  dirtyMetrics,
  DAY_FIELDS,
  metricsForDay,
  setDayMetrics,
  calendarDays,
  isLoggableDate,
} from './lib/metrics.js';
import { estimateTDEE, measuredDeficit, deficitVerdict, dailyEnergy, restingRange, unexplainedSwing }
  from './lib/energy.js';
import {
  mergeRemoteSession, migrateActiveSession, removeSetAt, addSetTo,
  freshExerciseState, currentSetIndex, defaultReps,
} from './lib/session.js';
import {
  qualifier,
  normaliseMuscleGroup,
  MUSCLE_GROUPS,
  familiesOf,
  allowsZeroLoad,
  describeLoad,
  describeLoadWithUnit,
  handsOf,
  equipmentFor,
} from './lib/exercises.js';
import { runCleanup } from './lib/cleanup.js';
import { overallProgress, analyzeFamily, volumeOverTime } from './lib/progress.js';
import {
  QUESTIONS,
  SCALE,
  isAnswered,
  checkinEffect,
  FEEL_SCALE,
  feelOf,
} from './lib/checkin.js';
import { lineChart, barChart, trendBadge } from './lib/chart.js';
import {
  groupsOf, groupAt, positionIn, nextAfterSet, makeSuperset, breakSuperset, MAX_BUNDLE,
} from './lib/superset.js';
import * as db from './db.js';

/* ================================ state ================================= */

const state = {
  boot: null,
  sessions: [],
  notes: [],
  metrics: [],
  active: null,
  route: 'home',
  detailExercise: null,
  online: navigator.onLine,
  syncing: false,
  lastSync: null,
  offlineReady: null,
  offlineReason: '',
  bootError: '',
  storageError: '',
  booting: true,
  syncedProgramHash: null,
  draft: null,
  draftDirty: false,
  calMonth: null,
  calPinned: false,
  openDay: null,
  metricDeletions: [],
  dayDraft: null,
  settings: {
    availablePlates: DEFAULT_PLATES,
    /**
     * The kilo gym's plates, kept separately.
     *
     * Not a conversion of the list above: 20 kg is 44.09 lb, so these are
     * different plates rather than the same plates renamed. One shared list made
     * a metric user's gym read as having 25/10/5/2.5 kg and **no 20 and no 15**
     * — the two commonest plates anywhere — purely because those numbers happen
     * to coincide with the pound defaults.
     *
     * Two lists also means switching units and back does not destroy whichever
     * one was customised.
     */
    availablePlatesKg: DEFAULT_PLATES_KG,
    defaultRestSeconds: 180,
    /** Miles. See RADIUS_MILES in lib/gyms.js for why it is bounded. */
    gymRadiusMiles: 25,
    serverUrl: '',
    authToken: '',
    // What the coach reads every trend against. Blank means unknown, and
    // unknown is reported as unknown rather than assumed to be maintenance.
    maintenanceCalories: null,
    goal: '',
    // For the resting-burn formula. Blank means it simply does not run.
    heightInches: null,
    age: null,
    sex: '',
    // A range, because nobody knows this to the decimal and pretending
    // otherwise buys a precision that is not there.
    bodyFatLow: null,
    bodyFatHigh: null,
    /**
      * Which unit weights are shown and typed in.
      *
      * Display only. `set.weight` is the total load moved in pounds, always —
      * every row already logged is pounds, the cloud holds the only copy of them
      * that is not on this phone, and a migration that touches those rows is the
      * highest-stakes write in the project. Nothing stored moves when this does.
      */
    weightUnit: 'lb',
    /**
     * How much detail the logging screen asks for.
     *
     * Null rather than a value, so the role decides until somebody chooses.
     * Defaulting it here would hand the admin a stripped screen on a fresh
     * install, and a member the fourteen-field one on hers.
     */
    level: null,
  },
  /**
   * Who this phone belongs to, from `/api/me`, cached locally.
   *
   * Cached because the founding constraint applies here too: the app has to open
   * and log a set with no signal, and it cannot do that if knowing who you are
   * needs a round trip. So the answer is stored and the network only refreshes
   * it. `null` means nobody has signed in on this device yet.
   */
  account: null,
  accountError: '',
  registerDraft: null,
  tourStep: 0,
  /**
   * Where the first walkthrough was opened from, and so where it ends.
   *
   * `onboarding` leads into the second walkthrough. `setup` goes back to Train,
   * because somebody looking something up in the walkthrough has not asked to
   * be onboarded — and `week.spec.js` has asserted that last step starts
   * training since the walkthrough was written.
   */
  tourFrom: null,
  /** The second walkthrough: which card, which stage, and what has been answered. */
  planStep: 0,
  planStage: 'tour',
  planDraft: {},
  planProgram: null,
  /**
   * Which section of Setup is open.
   *
   * `you` by default: logging today's weight is what the screen is opened for,
   * and it used to be four screens down behind the plate toggles.
   */
  setupTab: 'you',
  /**
   * Who coaches you and who you coach, from `/api/coaching`.
   *
   * `null` until fetched. Cached in `meta` like `account` is, because the
   * consent screen has to be able to say what was agreed with no signal — and
   * because showing nothing there reads as "nobody", which is the one wrong
   * answer a consent screen can give.
   */
  coaching: null,
  /** Whether the server offers Google sign-in, and whether its script loaded. */
  googleClientId: null,
  googleReady: false,
  signingIn: false,
  /** What has been typed into the invitation-code box but not submitted yet. */
  codeDraft: '',
  /**
   * The fortnightly program review.
   *
   * `pending` is what the numbers currently suggest, recomputed after every
   * session so it is never stale. `applied` is what was actually changed, with
   * enough of the previous slot to put it back — an automatic change nobody can
   * reverse is one you have to either trust blindly or turn off.
   */
  adapt: { lastReviewAt: null, pending: [], applied: [], decisions: [], shownAt: null },
  /** Which section of the Coach tab is showing, and which lifts are expanded. */
  coachTab: 'now',
  coachFilter: null,
  /** Which lifts on the Coach screen have their reasoning open. */
  coachOpen: [],
  /**
   * Which folds inside a Setup section are open.
   *
   * In state rather than in the DOM for the same reason `coachOpen` is: every
   * repaint rebuilds the markup, so a fold that remembered itself by being open
   * would close on the next sync.
   */
  setupOpen: [],
  /**
   * Whether the logger's Advanced group is open, and which program on Train is.
   *
   * View state, deliberately not persisted — the same class as `coachTab` and
   * `setupTab`. A disclosure that remembers being open across a reload would
   * reintroduce the thing it was opened to fix: arriving on the lift with the
   * controls in front of the control you came to press.
   */
  advOpen: false,
  /**
   * Programs the user has shut on Train. Empty means everything is open, which
   * is the default and the documented contract: every day is one tap.
   */
  collapsedPrograms: [],
  /** Which gym has its setup panel open on the Gyms screen. */
  openGymPanel: null,
};

/**
 * The shared cloud.
 *
 * Hard-coded rather than typed in, because "paste this URL and also this code"
 * is two chances to get it wrong and the URL is the same for everyone. It is
 * public information — it is in the README — and holds nothing without a token.
 */
const CLOUD_URL = 'https://trainer-api.green-queen-3c1a.workers.dev';

const view = document.getElementById('view');
const nav = document.getElementById('nav');
const sheet = document.getElementById('sheet');
const sheetPanel = document.getElementById('sheet-panel');
const statusBar = document.getElementById('status-bar');
const toastEl = document.getElementById('toast');

/* =============================== utilities ============================== */

const uid = () =>
  crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const nowISO = () => new Date().toISOString();

/** Mean of whatever is actually a number, or null. Never 0 for "nothing". */


/** Local calendar day, not UTC: a 9pm weigh-in must not land on tomorrow. */
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Everything is addressed relative to wherever the app is served from, so the
 * same build runs at the root of a local server and under a subdirectory on a
 * static host.
 */
/** Shown on the Setup screen so a stale phone can be identified from a distance. */
const BUILD = 'v79';

const BASE = new URL('.', document.baseURI).href;

/** Files that ship with the app, always alongside it. */
const asset = (path) => new URL(String(path).replace(/^\//, ''), BASE).href;

/**
 * API calls go to the PC server if one is configured, and to the same origin
 * otherwise. Hosted on GitHub Pages there is no API alongside the app, so
 * without an address there is nothing to sync to.
 */
const api = (path) => {
  const configured = state.settings.serverUrl?.trim();
  const rel = String(path).replace(/^\//, '');
  if (!configured) return asset(rel);
  return new URL(rel, configured.endsWith('/') ? configured : `${configured}/`).href;
};

/**
 * Which unit the screen is in. Read per render rather than captured, because a
 * sync can change it under a view that is already open.
 */
const unit = () => (state.settings.weightUnit === 'kg' ? 'kg' : 'lb');

/**
 * The language the app speaks.
 *
 * Resolved from the phone rather than from a setting, for now: nobody has asked
 * to read the app in a language their phone is not already in, and a preference
 * nobody needs is a preference that goes stale.
 *
 * Computed once at module load. Changing a phone's language relaunches the app,
 * so there is nothing to react to — and reading `navigator.languages` on every
 * render would put a browser call inside a template literal.
 */
const LOCALE = resolveLocale(
  typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]),
);

/** The plates in the gym, in the unit the gym's plates are stamped in. */
/**
 * A chart series in the unit the chart says it is in.
 *
 * `bestE1RM` and `totalVolume` return canonical pounds, and the chart
 * concatenates the unit string onto the value verbatim — so a kilo screen
 * labelled a 180 lb e1RM as "180 kg", 2.2x the real load, with the subtitle two
 * lines above it correctly reading 180 lb. One screen, one number, two units.
 */
const inDisplayUnit = (series) => (unit() === 'lb'
  ? series
  : series.map((p) => ({ ...p, value: showWeight(p.value, unit()) ?? p.value })));

const platesNow = () => (unit() === 'kg'
  ? (state.settings.availablePlatesKg ?? DEFAULT_PLATES_KG)
  : (state.settings.availablePlates ?? DEFAULT_PLATES));

/** One string, in that language, falling back to English rather than to its key. */
const t = translator(LOCALE, { en: EN, es: ES }, { en: EN });

/**
 * A count with its noun, in the right plural form.
 *
 * `n === 1 ? '' : 's'` appears twenty-odd times in this file, is right in
 * English by luck, and is wrong in most languages — Spanish needs "1 sesión" and
 * "3 sesiones", which no suffix produces. It is also already wrong *in English*
 * in one place, where the program header rendered "4 day".
 */
const n = (key, count) => t(key, { n: count });

/**
 * A stored pound figure, as the screen should show it.
 *
 * Snapped to the display unit's own grid, so the number is always a load that
 * exists — showing 81.6466 kg invites editing it, and 81.6466 is not a weight.
 * The unit itself is not appended: several callers put it elsewhere in the
 * sentence, and `formatWeight` is there for the ones that want it inline.
 */
const fmtWeight = (w) => {
  const shown = showWeight(w, unit());
  return shown == null ? '—' : `${Number.isInteger(shown) ? shown : Number(shown.toFixed(2))}`;
};

function fmtDate(iso) {
  const d = new Date(iso);
  // `LOCALE`, not `undefined`. Passing undefined follows the *device*, so a
  // Spanish app on an English phone printed Spanish prose around English dates.
  return d.toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' });
}

function daysAgo(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

function mmss(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let toastTimer;
function toast(message, duration = 1900) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, duration);
}

function plateSummary(weight, equipment) {
  if (weight == null) return '';
  // A dumbbell or a pin-loaded stack has no plates to count.
  if (equipment.barType === 'stack') return '';
  const { plates, exact } = platesForTotal(weight, equipment);
  const entries = Object.entries(plates)
    .map(([lb, n]) => [Number(lb), n])
    .sort((a, b) => b[0] - a[0]);
  if (!entries.length) return equipment.barWeight > 0 ? 'bar only' : '';
  const text = entries.map(([lb, n]) => `${lb}×${n}`).join('  ');
  const side = equipment.loading === 'total' ? '' : '/side';
  return `${text}${side}${exact ? '' : ' ≈'}`;
}

/* ============================== data layer ============================== */

async function loadLocal() {
  const [boot, sessions, notes, active, settings, lastSync, programHash, metrics, summary, metricDeletions, account, adapt, coaching] = await Promise.all([
    db.getMeta('boot'),
    db.allSessions(),
    db.allNotes(),
    db.getMeta('active'),
    db.getMeta('settings'),
    db.getMeta('lastSync'),
    db.getMeta('programHash'),
    db.getMeta('metrics'),
    db.getMeta('summary'),
    db.getMeta('metricDeletions'),
    db.getMeta('account'),
    db.getMeta('adapt'),
    db.getMeta('coaching'),
  ]);
  state.syncedProgramHash = programHash ?? null;
  state.metrics = metrics ?? [];
  // The last summary survives a relaunch, so the card is not blank every time
  // the app is opened away from signal.
  state.summary = summary ?? null;
  // Readings cleared here but still on the server, until the deletion lands.
  state.metricDeletions = metricDeletions ?? [];
  // Who this phone belongs to, as last known. Read before any network call, so
  // an admin screen and a finished registration survive being offline.
  state.account = account ?? null;
  state.adapt = { lastReviewAt: null, pending: [], applied: [], decisions: [], shownAt: null, ...(adapt ?? {}) };
  // Cached like `account`, and for the same reason: the consent screen has to be
  // able to say what was agreed with no signal, and showing nothing there reads
  // as "nobody", which is the one wrong answer a consent screen can give.
  state.coaching = coaching ?? null;
  state.boot = boot ?? null;
  state.sessions = sessions ?? [];
  state.notes = notes ?? [];

  // A workout in progress survives app updates, so it may have been written by
  // an older shape. Repair it rather than letting it crash the launch.
  state.active = active ? migrateActiveSession(active) : null;
  if (active && !state.active) {
    await db.delMeta('active');
    state.storageError = 'An unfinished workout could not be recovered and was discarded.';
  }
  state.lastSync = lastSync ?? null;
  if (settings) state.settings = { ...state.settings, ...settings };
}

/**
 * Bug notes are written where they are noticed — mid-set, offline, on a phone.
 * They queue locally and ride up on the next sync like any workout.
 */
async function reportBug(text) {
  const note = {
    id: uid(),
    text: text.trim(),
    context: state.active ? `session · ${state.active.dayName}` : state.route,
    createdAt: nowISO(),
    _dirty: true,
  };
  state.notes.push(note);
  await db.putNote(note);
  render();
  toast('Noted — it uploads with your next sync');
  if (state.online) sync({ quiet: true });
}

async function fetchBoot() {
  const res = await fetch(api('/api/bootstrap'), { cache: 'no-store' });
  if (!res.ok) throw new Error(`bootstrap ${res.status}`);
  const boot = await res.json();
  state.boot = boot;
  await db.setMeta('boot', boot);
  return boot;
}

/**
 * The phone owns the program. Edits land here first and are pushed to the PC
 * only as a backup, so the app is fully editable with no server in reach.
 */
async function updateBoot(next) {
  state.boot = next;
  await db.setMeta('boot', next);
}

/** Mirror an edit to the PC when it happens to be there. Never blocks. */
function mirror(path, payload) {
  if (!state.online) return;
  postJSON(path, payload).catch(() => {});
}

/** The cloud API holds one person's training history, so it wants a token. */
const authHeader = () => {
  const token = state.settings.authToken?.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
};

const dirtySessions = () => state.sessions.filter((s) => s._dirty);
const dirtyNotes = () => state.notes.filter((n) => n._dirty);

/** Cheap content hash, so an unchanged program is not re-uploaded every time. */
function hashOf(value) {
  const text = JSON.stringify(value ?? null);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
}

/**
 * Repaint only the screens that show sync state. A full repaint mid-workout
 * would rebuild the logger and throw away the reps being typed into it.
 */
function refreshForSync() {
  if (state.route === 'history' || state.route === 'setup') render();
  else renderStatus();
}

async function sync({ quiet = false } = {}) {
  if (state.syncing) return;
  state.syncing = true;
  let changed = false;
  refreshForSync();

  try {
    const pending = dirtySessions();
    const pendingNotes = dirtyNotes();

    // The program rides up with every sync so a replacement phone can pick it
    // up, but never comes back down over a local copy: the phone owns it, and
    // overwriting would undo edits made with no signal.
    // The program is 25KB and rarely changes. Sending it on every sync made
    // each one slow for no reason, so it goes up only when it differs.
    const programHash = hashOf(state.boot);
    const sendProgram = Boolean(state.boot) && programHash !== state.syncedProgramHash;

    const res = await fetch(api('/api/sync'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader() },
      body: JSON.stringify({
        sessions: pending.map(stripLocal),
        notes: pendingNotes.map(({ _dirty, ...n }) => n),
        ...(sendProgram ? { program: state.boot } : {}),
        // Every sync, not only when the program changed. Gyms are the one shared
        // thing here, and a gym named on one phone is only any use to the other
        // one once it has been sent — waiting for an unrelated program edit to
        // carry it is how her picker stayed empty.
        gyms: gymsList().map(sharedFields),
      }),
    });
    if (!res.ok) throw new Error(`sync ${res.status}`);

    // Readings typed on the phone ride up the same way sets do.
    // Deletions first: re-uploading a value we are about to delete would
    // leave the server holding it if the delete then failed.
    for (const gone of [...(state.metricDeletions ?? [])]) {
      try {
        await postJSON('/api/metrics', { name: gone.name, date: gone.date, delete: true });
        state.metricDeletions = state.metricDeletions.filter((d) => !(d.name === gone.name && d.date === gone.date));
      } catch {
        // Stays pending and goes again next sync.
      }
    }
    await db.setMeta('metricDeletions', state.metricDeletions ?? []);

    const pendingMetrics = dirtyMetrics(state.metrics);
    for (const m of pendingMetrics) {
      try {
        await postJSON('/api/metrics', { name: m.name, value: m.value, date: m.date });
        m._dirty = false;
      } catch {
        // Stays dirty and goes again next sync. Never blocks the workout sync.
      }
    }
    if (pendingMetrics.length) await db.setMeta('metrics', state.metrics);

    for (const s of pending) s._dirty = false;
    for (const n of pendingNotes) n._dirty = false;
    await db.putSessions(pending);
    await db.putNotes(pendingNotes);

    if (sendProgram) {
      state.syncedProgramHash = programHash;
      await db.setMeta('programHash', programHash);
    }

    const pullRes = await fetch(api('/api/pull'), { cache: 'no-store', headers: authHeader() });
    if (pullRes.ok) {
      const remote = await pullRes.json();

      const stillDirty = new Set(dirtySessions().map((s) => s.id));
      const incoming = (remote.sessions ?? [])
        .filter((s) => !stillDirty.has(s.id))
        .map((s) => ({ ...s, _dirty: false }));

      // A field the server does not understand yet must not be erased by a
      // pull. Client and server deploy separately, so there is always a window
      // where the phone knows about something the cloud does not. This guarded
      // only `checkin` for a while, and every field added after it — the gym,
      // the machine, the tempo, the per-set feel — was erased by the round trip.
      const mine = new Map(state.sessions.map((s) => [s.id, s]));
      for (let i = 0; i < incoming.length; i++) {
        incoming[i] = mergeRemoteSession(mine.get(incoming[i].id), incoming[i]);
      }

      const known = new Set(state.sessions.map((s) => s.id));
      changed = incoming.some((s) => !known.has(s.id)) || incoming.length !== state.sessions.length;

      const merged = new Map(state.sessions.map((s) => [s.id, s]));
      for (const s of incoming) merged.set(s.id, s);
      state.sessions = [...merged.values()];
      await db.putSessions(incoming);

      // Metrics are written at both ends now — by the Shortcut into the cloud,
      // and by hand in Setup — so the pull has to merge rather than replace.
      //
      // This passed `dirtyMetrics(state.metrics)` as the local side, which
      // erased any reading that had already uploaded and was then missing from
      // the pull response. That is not an exotic case: the upload and the pull
      // are two requests against a replicated database, and the second can be
      // answered from a state that does not contain the first. Metrics also live
      // as one array under one IndexedDB key, so every write is a whole-array
      // overwrite — nothing survives by being a separate record the way sessions
      // do. One weigh-in accepted by the server and dropped on the way back was
      // enough to lose it from the phone permanently.
      //
      // **Absence is not deletion.** It is the same rule `mergeRemoteSession`
      // already states for session fields, and deletions have their own
      // tombstone list precisely so that silence does not have to mean anything.
      if (Array.isArray(remote.metrics)) {
        const merged = mergeMetrics(remote.metrics, state.metrics, state.metricDeletions);
        if (merged.length !== state.metrics.length) changed = true;
        state.metrics = merged;
        await db.setMeta('metrics', merged);
      }

      // A brand new phone has no program of its own; take the stored one.
      if (!state.boot && remote.program) {
        await updateBoot(remote.program);
        changed = true;
      }

      /**
       * The shared gym list, folded in rather than replacing.
       *
       * Merged for the same reason metrics are: this phone can hold a gym the
       * server has never heard of — named mid-workout, with no signal — and
       * **absence is not deletion**. `mergeGyms` also keeps every machine answer
       * on this phone, because the shared record is a name and a position and
       * overwriting the local one with it would wipe the rest.
       */
      if (Array.isArray(remote.gyms) && state.boot) {
        const before = state.boot.gyms ?? [];
        const gyms = mergeGyms(before, remote.gyms, state.boot.hiddenGyms);

        /**
         * Any difference repaints, not only a different count.
         *
         * Comparing lengths meant a rename or a moved position arriving from the
         * other phone changed the data and never reached the screen — the write
         * landed, the view didn't, which is the same shape as half the bugs in
         * the flaky-test analysis below.
         */
        if (JSON.stringify(gyms) !== JSON.stringify(before)) changed = true;
        await updateBoot({ ...state.boot, gyms });
      }
    }

    state.lastSync = nowISO();
    await db.setMeta('lastSync', state.lastSync);
    state.online = true;
    if (!quiet) toast('Synced');
  } catch {
    state.online = false;
    if (!quiet) toast('Could not reach the server — everything is saved on this phone');
  } finally {
    state.syncing = false;
    // Workouts pulled down have to reach the screen. Repainting only the status
    // bar left them invisible until the user happened to switch tabs.
    if (changed) render();
    else refreshForSync();
  }
}

/** Local-only bookkeeping fields never leave the phone. */
function stripLocal(session) {
  const { _dirty, plan, ex, restEndsAt, exIndex, ...rest } = session;
  return rest;
}

async function persistActive() {
  await db.setMeta('active', state.active);
}

async function saveSettings() {
  await db.setMeta('settings', state.settings);
}

/**
 * Save something from Setup → You, on the phone and then in the cloud.
 *
 * The phone first and always: every energy figure reads `state.settings`, and
 * these have to work in a gym basement. The upload is best effort — failing to
 * tell the server is not a reason to refuse somebody their own number on their
 * own phone, and it rides up the next time one of these is touched.
 *
 * This exists because it did not. The fields wrote to the phone and stopped
 * there, so the cloud held a profile of nulls while the phone had the answers,
 * and a reinstall would have lost all of it with no symptom beyond the resting
 * burn quietly ceasing to appear. `profiles` was always the right home — the
 * registration form has written to it from the start. He simply never went
 * through registration.
 */
async function saveYou() {
  await saveSettings();

  if (!state.account) return toast('Saved on this phone');

  const payload = settingsToProfile(state.settings, new Date().getUTCFullYear());

  // The local copy of the account moves first, for the same reason: the screen
  // has to be right whether or not the request lands.
  state.account = { ...state.account, profile: { ...(state.account.profile ?? {}), ...payload } };
  await db.setMeta('account', state.account);

  try {
    const res = await fetch(api('/api/profile'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader() },
      body: JSON.stringify(payload),
    });
    toast(res.ok ? 'Saved' : 'Saved on this phone');
  } catch {
    toast('Saved on this phone — it will sync later');
  }
}

/* ============================ domain helpers ============================ */

/**
 * The query layer now lives in `lib/repository.js`; these bind it to `state`.
 *
 * Nothing about the rules changed — what changed is that they are now pure
 * functions of (sessions, boot) with their own tests, instead of closures over a
 * global that only Playwright ever reached. These wrappers exist so the ~40 call
 * sites below read exactly as they did.
 */
const historyFor = (exerciseId) => repoHistoryFor(state.sessions, exerciseId);
const lastSessionFor = (exerciseId) => repoLastSessionFor(state.sessions, exerciseId);

/**
 * The past session this lift should actually be compared against *right now*.
 *
 * Not `lastSessionFor`, which answers "most recently, anywhere, on anything".
 * This asks the question with the rest of the sentence in it: last time **here,
 * on this machine** — falling back through `lib/recall.js`'s ladder when the
 * narrower answer does not exist.
 *
 * It is computed at render time rather than baked into the plan, and that is
 * forced by the order things happen in: `buildDayPlan` runs when the day is
 * started, and the machine for a lift is chosen per lift *after* that, often
 * several lifts into the session. A plan built before the machine is known
 * cannot carry a machine-scoped answer.
 *
 * Returns `null` when the lift has never been logged, same as before.
 */
function recallFor(ex) {
  if (!ex?.exerciseId) return null;
  return recallLast(historyFor(ex.exerciseId), {
    gymId: state.active?.gymId ?? null,
    machine: state.active?.machines?.[ex.dayExerciseId] ?? null,
  });
}

/**
 * A plan exercise with its `lastSets` re-scoped to the machine in front of you.
 *
 * `defaultReps` offers "what you did on this set last time", and last time on a
 * different machine is the wrong number to offer — it is the same mistake as
 * the "Last time" line, one layer down, and it writes itself into the rep field
 * rather than just being displayed. Four call sites read it, so the scoping
 * happens here rather than at each of them.
 */
function withRecall(ex) {
  const recalled = recallFor(ex);
  return recalled ? { ...ex, lastSets: recalled.session.sets } : ex;
}

/**
 * Where the recalled number was earned, when that is not "here".
 *
 * Empty string when the match is as specific as it could have been — there is
 * nothing to say, and a label reading "same machine" on every screen is noise
 * that trains you to stop reading labels.
 *
 * The mapping is a lookup rather than a chain of ternaries so that a new rung
 * in `RECALL_SCOPES` is a line here, and a missing one shows nothing rather
 * than `undefined`.
 */
const RECALL_LABELS = {
  machine: 'same machine, another gym',
  exercise: 'on another machine',
};

function recallScopeLabel(recalled, ex) {
  if (!recalled || !recalled.fellBack) return '';

  // Only worth saying for a lift where the machine is part of the load. On a
  // barbell, "on another machine" is a category error.
  const lift = state.boot?.exercises?.find((x) => x.id === ex.exerciseId);
  if (!tracksMachine(lift ?? { name: ex.name })) return '';

  return RECALL_LABELS[recalled.scope] ?? '';
}
const lastPerformed = (dayId) => repoLastPerformed(state.sessions, state.boot, dayId);
const loggedExerciseList = () => repoLoggedExerciseList(state.sessions, state.boot);

/** The exact plan the server would build — same module, computed offline. */
function planFor(dayId, gymId = null) {
  const day = state.boot?.days?.find((d) => d.id === dayId);
  return buildDayPlan(day, {
    lastSessionFor,
    historyFor,
    availablePlates: platesNow(),
    // Which grid the gym's plates are stamped in. Stamped onto every
    // `equipment`, so `buildPrescription`, `applyDeload` and `smallestStep` all
    // read it without a new argument each.
    unit: unit(),
    defaultRestSeconds: state.settings.defaultRestSeconds,
    // Where today is. Without it the plan pre-fills a second gym's session with
    // the first gym's weights and says nothing about it.
    station: gymId ? { gymId, machine: null } : null,
  });
}

/* ============================ session control =========================== */

/**
 * One position fix, or null. Never blocks anything.
 *
 * Everything here degrades to null on purpose: permission denied, no GPS, a
 * basement with no signal. The gym is chosen by hand regardless — the fix only
 * improves which one is pre-selected, so failing to get one costs a
 * convenience and nothing else.
 */
function currentPosition({ timeout = 8000 } = {}) {
  if (!navigator.geolocation) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    // A hard cap of our own: some browsers never call either callback when the
    // permission prompt is dismissed rather than answered. Cleared on the happy
    // path, or every gym sheet leaves a live timer behind it for nine seconds.
    let cap = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      if (cap !== null) clearTimeout(cap);
      resolve(value);
    };

    cap = setTimeout(() => done(null), timeout + 500);

    navigator.geolocation.getCurrentPosition(
      (p) => done({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => done(null),
      { enableHighAccuracy: false, timeout, maximumAge: 120000 },
    );
  });
}

const gymsList = () => visibleGyms(state.boot);
const gymById = (id) => gymsList().find((g) => g.id === id) ?? null;

/** Fold a changed gym back into the program the phone owns. */
async function saveGym(gym) {
  const gyms = gymsList();
  const at = gyms.findIndex((g) => g.id === gym.id);
  const next = at === -1 ? [...gyms, gym] : gyms.map((g) => (g.id === gym.id ? gym : g));
  await updateBoot({ ...state.boot, gyms: next });
  return gym;
}

/**
 * Set the machines a gym has for one lift.
 *
 * Written to the phone **first and unconditionally**, then told to the server.
 * That ordering is the rule the whole app follows and it matters as much here
 * as anywhere: a gym admin standing in their own gym with no signal has to be
 * able to write down what is in front of them. The server call is best effort,
 * exactly like `saveYou` — failing to tell the cloud is not a reason to refuse
 * somebody their own answer on their own phone.
 *
 * The local write is not a guess at what the server will say, either: the two
 * agree because both fold the list the same way, and the next pull overwrites
 * this with whatever the server actually holds.
 */
async function saveInventory(gymId, exerciseId, machines) {
  const gym = gymById(gymId);
  if (!gym || !exerciseId) return;

  await saveGym(setInventory(gym, exerciseId, machines));
  render();
  toast(machines.length ? 'Machines saved' : 'Machine list cleared');

  if (!state.settings.serverUrl || !state.settings.authToken) return;

  try {
    await fetch(api(`/api/gyms/${encodeURIComponent(gymId)}/machines`), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeader() },
      body: JSON.stringify({ exerciseId, machines }),
    });
  } catch {
    // It rides up the next time anything syncs. The phone already has it.
  }
}

/**
 * Appoint or remove a gym admin.
 *
 * The opposite ordering to `saveInventory`, deliberately. This one is **not**
 * written locally first, because it is not this phone's fact to assert: who
 * runs a gym is a shared record the server owns, and a phone that showed
 * somebody as appointed while the request failed would be showing an authority
 * that does not exist. So the server answers, and only then does the screen
 * change — and with no signal the control says so rather than lying.
 */
async function setGymAdmin(gymId, userId, remove) {
  if (!state.settings.serverUrl || !state.settings.authToken) {
    return toast('Needs a connection — this one is everybody\'s, not just yours');
  }

  const path = remove
    ? `/api/gyms/${encodeURIComponent(gymId)}/admins/${encodeURIComponent(userId)}`
    : `/api/gyms/${encodeURIComponent(gymId)}/admins`;

  try {
    const res = await fetch(api(path), {
      method: remove ? 'DELETE' : 'POST',
      headers: { 'content-type': 'application/json', ...authHeader() },
      ...(remove ? {} : { body: JSON.stringify({ userId }) }),
    });

    if (!res.ok) return toast('That did not go through');

    await loadAccounts();
    render();
    toast(remove ? 'No longer a gym admin' : 'Now a gym admin');
  } catch {
    toast('Could not reach the server');
  }
}

/**
 * Ask which gym, every single time.
 *
 * Never inferred from position, because visits are unpredictable — three times
 * at one gym this week, five at another the next — and a session labelled with
 * the wrong gym poisons every machine prediction that hangs off it. The
 * coordinates only move the right answer to the top of the list.
 */
function openGymSheet(dayId) {
  let chosen = null;
  let hint = null;

  /**
   * The gym name being typed, kept across repaints.
   *
   * Tapping an existing gym repaints to move the tick, and so did the position
   * lookup when it came back — up to eight and a half seconds after the sheet
   * opened. Either one wiped a half-typed new gym name, and the second one also
   * moved the selection, so **Start** would then begin the session at the
   * pre-selected gym rather than the one being named. A session labelled with
   * the wrong gym poisons every machine prediction hanging off it.
   */
  let typed = '';
  const readTyped = () => {
    typed = sheetPanel.querySelector('#gym-new')?.value ?? typed;
  };

  /**
   * Whether the ones outside the radius are being shown.
   *
   * Off by default and one tap away, which is the whole bargain: the list is
   * short enough to answer at a glance, and nothing has actually been taken
   * away. A filter you cannot undo is a filter that eventually hides the gym
   * somebody is standing in.
   */
  let showFar = false;

  /** Whether the gym being typed is a personal one — a garage, a hotel rack. */
  let personal = false;

  const paint = () => {
    const all = gymsList();
    const { near, far } = gymsNear(all, state.geo, {
      miles: state.settings.gymRadiusMiles ?? RADIUS_MILES.default,
      // Trained here before, so it stays on the list at any distance.
      used: [...new Set(state.sessions.map((s) => s?.gymId).filter(Boolean))],
    });

    const gyms = showFar ? [...near, ...far] : near;

    const rows = gyms
      .map((g) => `<button class="picker-item ${chosen === g.id ? 'on' : ''}" data-gym="${esc(g.id)}">
          <div class="grow min-w-0">
            <b class="t text-lg">${esc(g.name)}</b>
            ${g.id === hint?.id ? '<div class="tiny ok">you look like you are here</div>' : ''}
            ${g.visibility === 'pending'
              ? `<div class="tiny muted">waiting to be approved — yours for now</div>`
              : ''}
            ${g.visibility === 'personal'
              ? `<div class="tiny muted">yours only — not on anybody else's list</div>`
              : ''}
          </div>
          <span class="tiny muted">${chosen === g.id ? '✓' : ''}</span>
        </button>`)
      .join('');

    openSheet(
      `<h2 class="mt-0">Which gym?</h2>
       <div class="tiny muted mb-2.5">
         ${all.length
           ? 'Different gyms have different machines, so weights only compare within one.'
           : 'Name the gym you are in. You only do this once per gym.'}
       </div>
       ${rows}
       ${far.length && !showFar
         ? `<button class="btn btn-sm btn-block btn-ghost mb-2" data-gym-far="1">
              ${far.length} more further away
            </button>`
         : ''}
       <input class="searchbar" id="gym-new" value="${esc(typed)}"
         placeholder="+ New gym — type its name" autocomplete="off">
       <label class="row gap-2 mt-2 tiny muted" style="min-height:44px">
         <input type="checkbox" id="gym-personal" ${personal ? 'checked' : ''}>
         <span>Mine only — a home or hotel gym nobody else should see</span>
       </label>
       <button class="btn btn-primary btn-block btn-lg mt-1.5" data-gym-go="1">Start</button>
       <button class="btn btn-block btn-ghost btn-sm mt-1.5" data-gym-skip="1">
         Not at a gym / skip
       </button>`,
      async (e) => {
        const pick = e.target.closest('[data-gym]');
        if (pick) {
          readTyped();
          chosen = pick.dataset.gym;
          return paint();
        }

        // Both of these repaint, so the half-typed name and the checkbox have
        // to be read back first — the same hazard the `typed` variable exists
        // for, which cost a session the wrong gym label once already.
        if (e.target.closest('[data-gym-far]')) {
          readTyped();
          personal = sheetPanel.querySelector('#gym-personal')?.checked ?? personal;
          showFar = true;
          return paint();
        }

        if (e.target.closest('[data-gym-skip]')) {
          closeSheet();
          return startSession(dayId, null);
        }

        if (e.target.closest('[data-gym-go]')) {
          const typed = document.getElementById('gym-new')?.value.trim();
          const isPersonal = document.getElementById('gym-personal')?.checked ?? false;
          let gym = chosen ? gymById(chosen) : null;

          if (typed) {
            const already = gymsList().find((g) => g.name.toLowerCase() === typed.toLowerCase());
            gym = already ?? (await saveGym(
              makeGym(typed, `gym-${uid().slice(0, 6)}`, { personal: isPersonal }),
            ));
          }

          if (!gym) return toast('Pick a gym, or skip');
          closeSheet();
          return startSession(dayId, gym.id);
        }
      },
    );
  };

  paint();

  // Asked for after the sheet is already up, so a slow or denied fix never
  // stands between him and starting the workout.
  currentPosition().then((pos) => {
    if (!pos) return;
    state.geo = pos;
    const near = nearestGym(gymsList(), pos);
    // Only repaint if the sheet is still the one we opened.
    if (near && document.getElementById('gym-new')) {
      hint = near;
      if (!chosen) chosen = near.id;
      paint();
    }
  });
}

/**
 * Which machine is this lift being done on today.
 *
 * Offered from what this gym is already known to have, plus a free-text box,
 * because the list can only ever be built by using it. A name typed here that
 * matches one already known folds into it rather than becoming a near-duplicate.
 */
/**
 * How one set felt.
 *
 * Opened only by tapping the dot on a logged set — never pushed. Clearing is
 * offered as prominently as scoring, because a wrong tap that cannot be undone
 * is worse than no score at all, and this data is only worth anything if it is
 * honest.
 */
function openFeelSheet(index) {
  const a = state.active;
  const ex = currentExercise();
  const set = a.sets.find((s) => s.exerciseId === ex.exerciseId && s.setIndex === index + 1);
  if (!set) return;

  const current = feelOf(set);

  const choices = FEEL_SCALE.map(
    (f) => `<button class="feel-pick ${current === f.value ? 'on' : ''}" data-feel="${f.value}">
        <span class="feel-face">${f.face}</span>
        <span class="tiny">${esc(f.label)}</span>
      </button>`,
  ).join('');

  openSheet(
    `<h2 class="mt-0">How did that set feel?</h2>
     <div class="tiny muted mb-3">
       ${esc(ex.name)} · set ${index + 1} of ${a.ex[ex.dayExerciseId].slots.length}.
       Optional — this is only worth recording when a set is notably better or worse than usual.
     </div>
     <div class="feel-row">${choices}</div>
     ${current ? '<button class="btn btn-block btn-ghost btn-sm mt-3" data-feel-clear="1">Clear it</button>' : ''}`,
    async (e) => {
      const pick = e.target.closest('[data-feel]');
      const clear = e.target.closest('[data-feel-clear]');
      if (!pick && !clear) return;

      // Tapping the score it already has clears it, so the control is its own undo.
      const value = pick ? Number(pick.dataset.feel) : null;
      if (clear || value === current) delete set.feel;
      else set.feel = value;

      a._dirty = true;
      closeSheet();
      await persistActive();
      render();
    },
  );
}

/* --------------------------------- tempo ---------------------------------- */

/**
 * The tempo for the current lift, and one tap to change it before the set.
 *
 * Shown rather than asked, after the first time. A modal before every set would
 * fire twenty-odd times a workout — four times worse than the prompt this app
 * already decided was too many — and a gate you tap through stops being read
 * long before it stops appearing.
 */
function tempoChip(ex) {
  const a = state.active;
  const tempo = a.tempos?.[ex.dayExerciseId];
  const parsed = parseTempo(tempo ?? '');

  return `<button class="btn btn-sm btn-block ${parsed ? '' : 'btn-ask'} mb-2.5"
      data-act="tempo">
      ${parsed ? `Tempo · ${esc(formatTempo(parsed))} — ${esc(describeTempo(parsed))}` : 'What tempo? — tap to set'}
    </button>`;
}

/**
 * Pick a tempo: the presets, then a free entry for anything else.
 *
 * Prefilled from what this lift is usually done at, so the common case is one
 * tap to confirm rather than a decision to make between sets.
 */
function openTempoSheet(ex) {
  const a = state.active;
  const current = parseTempo(a.tempos?.[ex.dayExerciseId] ?? '');
  const usual = usualTempo(state.sessions, ex.exerciseId);

  const rows = TEMPO_PRESETS.map((p) => {
    const key = formatTempo(p);
    const on = current && formatTempo(current) === key;
    return `<button class="picker-item ${on ? 'on' : ''}" data-tempo="${esc(key)}">
        <div class="grow min-w-0">
          <b>${esc(p.label)}</b>
          <div class="tiny muted">${esc(describeTempo(p))}${usual === key ? ' · your usual here' : ''}</div>
        </div>
        <span class="tiny mono muted">${esc(key)}</span>
      </button>`;
  }).join('');

  openSheet(
    `<h2 class="mt-0">What tempo?</h2>
     <div class="tiny muted mb-2.5">
       ${esc(ex.name)}. Seconds down, hold, up. This is what makes two sets at the same
       weight comparable — and a shortening negative is the earliest sign a load is too heavy.
     </div>
     ${rows}
     <input class="searchbar" id="tempo-custom" placeholder="Custom — e.g. 5-2-1" autocomplete="off"
       inputmode="numeric" value="">
     <button class="btn btn-primary btn-block btn-lg mt-2.5" data-tempo-go="1">Use it</button>
     <button class="btn btn-block btn-ghost btn-sm mt-1.5" data-tempo-skip="1">
       Do not record one
     </button>`,
    async (e) => {
      const pick = e.target.closest('[data-tempo]');
      if (pick) {
        closeSheet();
        return setTempo(ex, pick.dataset.tempo);
      }

      if (e.target.closest('[data-tempo-skip]')) {
        closeSheet();
        // Declining once declines for the session; asking again on the next
        // lift is how "no" becomes eight more taps.
        a.askedTempo = { ...(a.askedTempo ?? {}), [ex.dayExerciseId]: true };
        a.tempoDeclined = true;
        await persistActive();
        return render();
      }

      if (e.target.closest('[data-tempo-go]')) {
        const typed = document.getElementById('tempo-custom')?.value.trim();
        const parsed = parseTempo(typed ?? '');
        if (!parsed) return toast('Write it as seconds, like 4-0-1');
        closeSheet();
        return setTempo(ex, formatTempo(parsed));
      }
    },
  );
}

/**
 * Record the tempo for this lift today.
 *
 * Applied to sets already logged for it this session as well, because the
 * tempo was the same on those — he simply had not said so yet.
 */
async function setTempo(ex, tempo) {
  const a = state.active;
  if (!a || !parseTempo(tempo)) return;

  a.tempos = { ...(a.tempos ?? {}), [ex.dayExerciseId]: tempo };
  a.askedTempo = { ...(a.askedTempo ?? {}), [ex.dayExerciseId]: true };
  a.defaultTempo = tempo;
  a._dirty = true;

  for (const s of a.sets) {
    if (s.exerciseId === ex.exerciseId && !s.tempo) s.tempo = tempo;
  }

  await persistActive();
  render();
}

/**
 * Ask once, when a lift is opened and there is no tempo for it yet.
 *
 * Prefilled silently from what this lift is usually done at — being asked every
 * session about the tempo you always use is the prompt that gets dismissed.
 */
function maybeAskTempo() {
  const a = state.active;
  if (!a || a.view !== 'exercise') return;
  if (sheetOpen()) return;

  // A level that does not record tempo must not ask for one. Hiding the chip and
  // still opening the sheet would be the worst of both: an unexplained prompt for
  // a field with nowhere on screen to see or change it afterwards.
  if (!recordsField(detailLevel(), 'tempo')) return;

  const ex = currentExercise();
  if (!ex || a.askedTempo?.[ex.dayExerciseId] || a.tempos?.[ex.dayExerciseId]) return;
  if (a.tempoDeclined) return;

  // What this lift is usually done at wins: it is the most specific answer.
  const usual = usualTempo(state.sessions, ex.exerciseId);
  if (usual) return void setTempo(ex, usual);

  // Then whatever was answered earlier this session. Without this, a first
  // workout asks on all nine lifts — the prompt fatigue this app has twice
  // decided against. One ask per session, and the chip changes any lift in a
  // tap, which is the same budget the gym prompt already costs.
  if (a.defaultTempo) return void setTempo(ex, a.defaultTempo);

  openTempoSheet(ex);
}

/** Carry forward the kit this lift is usually done with. Silent, never asked. */
function maybeApplyAids() {
  const a = state.active;
  if (!a || a.view !== 'exercise') return;

  const ex = currentExercise();
  if (!ex || a.aids?.[ex.dayExerciseId]) return;

  const usual = usualAids(historyFor(ex.exerciseId), ex.exerciseId);
  if (usual.length) setAids(ex, usual);
}

/* ---------------------------------- kit ----------------------------------- */

/**
 * What you have on for this lift, and one tap to change it.
 *
 * Never prompted. Most sets use nothing, and a question before every set about
 * equipment you are not wearing is the definition of a prompt that gets
 * dismissed unread. It pre-fills from what this lift usually uses, so the
 * common case — straps on every deadlift — costs nothing after the first time.
 */
function aidsChip(ex) {
  const a = state.active;
  const current = normaliseAids(a.aids?.[ex.dayExerciseId]);

  return `<button class="btn btn-sm btn-block mb-2.5" data-act="aids">
      ${current.length ? `Kit · ${esc(describeAids(current))} — change` : '+ Straps, belt, other kit'}
    </button>`;
}

/**
 * Pick the kit. Multi-select, because a belt and straps is one set, not two.
 *
 * Cable attachments are deliberately not here: a rope versus a wide bar changes
 * which lift it is, so it lives on the exercise in the library and splits the
 * history. Straps change one set of a lift, not the lift.
 */
function openAidsSheet(ex) {
  const a = state.active;
  const chosen = new Set(normaliseAids(a.aids?.[ex.dayExerciseId]));

  /**
   * What has been typed into the free-text box, kept across repaints.
   *
   * Every chip tap calls `paint()`, which does `sheetPanel.innerHTML = …` and
   * rebuilt this input from nothing — so typing "knee sleeves" and then tapping
   * the belt chip discarded the typing. Same mechanism that lost the check-in
   * note, same fix: read it before the repaint, render it back after.
   */
  let typed = '';
  const readTyped = () => {
    typed = sheetPanel.querySelector('#aid-custom')?.value ?? typed;
  };

  const paint = () => {
    const known = AIDS.map((x) => x.id);
    const extra = [...chosen].filter((id) => !known.includes(id));

    const rows = [...AIDS, ...extra.map((id) => ({ id, label: id }))]
      .map(
        (x) => `<button class="picker-item ${chosen.has(x.id) ? 'on' : ''}" data-aid="${esc(x.id)}">
          <div class="grow min-w-0"><b>${esc(x.label)}</b></div>
          <span class="tiny muted">${chosen.has(x.id) ? '✓' : ''}</span>
        </button>`,
      )
      .join('');

    openSheet(
      `<h2 class="mt-0">What have you got on?</h2>
       <div class="tiny muted mb-2.5">
         ${esc(ex.name)}. Optional, and most sets need nothing. It matters because straps
         take grip out as the limiter — a strapped row and a bare-handed one are not the
         same set at the same weight.
       </div>
       ${rows}
       <input class="searchbar" id="aid-custom" value="${esc(typed)}"
         placeholder="+ Something else — type it" autocomplete="off">
       <button class="btn btn-primary btn-block btn-lg mt-2.5" data-aids-go="1">
         ${chosen.size ? `Use ${chosen.size} item${chosen.size === 1 ? '' : 's'}` : 'Record none'}
       </button>
       <div class="tiny muted mt-2.5">
         Cable attachments — rope, wide bar — belong on the lift itself, in the exercise
         library. Those change which lift it is; these change one set of it.
       </div>`,
      async (e) => {
        const pick = e.target.closest('[data-aid]');
        if (pick) {
          const id = pick.dataset.aid;
          readTyped();
          if (chosen.has(id)) chosen.delete(id);
          else chosen.add(id);
          return paint();
        }

        if (e.target.closest('[data-aids-go]')) {
          readTyped();
          if (typed.trim()) chosen.add(typed.trim().toLowerCase());
          closeSheet();
          return setAids(ex, [...chosen]);
        }
      },
    );
  };

  paint();
}

/**
 * Record the kit for this lift today.
 *
 * Applied to sets already logged for it this session too: he had the straps on
 * for those, he just had not said so yet.
 */
async function setAids(ex, list) {
  const a = state.active;
  if (!a) return;

  const aids = normaliseAids(list);
  a.aids = { ...(a.aids ?? {}), [ex.dayExerciseId]: aids };
  a._dirty = true;

  for (const s of a.sets) {
    if (s.exerciseId === ex.exerciseId && !Array.isArray(s.aids)) s.aids = aids;
  }

  await persistActive();
  render();
}

function openMachineSheet(ex, { onPick } = {}) {
  const a = state.active;
  const gym = gymById(a?.gymId);
  const current = a?.machines?.[ex.dayExerciseId] ?? null;

  /**
   * This lift's machines first, then the rest of the building.
   *
   * The picker offered every machine at the gym for every lift, so answering
   * "which lat pulldown" meant scrolling past the leg press. `machinesForLift`
   * is the gym's inventory for *this* lift plus anything else I have logged on
   * it — so a first visit to a set-up gym offers the real machines instead of
   * an empty box, which was the one thing the per-person tally could never do.
   *
   * The rest is still offered underneath, because an inventory can be wrong or
   * out of date, and this sheet must never be a reason somebody cannot record
   * what they actually trained on.
   */
  const forLift = gym ? machinesForLift(gym, ex.exerciseId) : [];
  const elsewhere = (gym ? allMachinesAt(gym) : []).filter((name) => !forLift.includes(name));

  const row = (name) => `<button class="picker-item ${current === name ? 'on' : ''}" data-machine="${esc(name)}">
      <div class="grow min-w-0"><b class="t text-lg">${esc(name)}</b></div>
      <span class="tiny muted">${current === name ? '✓' : ''}</span>
    </button>`;

  const rows = forLift.map(row).join('')
    + (elsewhere.length
      ? `<div class="eyebrow mt-2.5 mb-1">Also here</div>${elsewhere.map(row).join('')}`
      : '');

  openSheet(
    `<h2 class="mt-0">Which machine?</h2>
     <div class="tiny muted mb-2.5">
       ${esc(ex.name)}${gym ? ` at ${esc(gym.name)}` : ''}.
       The cable profile and the stack differ between machines, so this is what
       makes the weights comparable.
     </div>
     ${rows}
     <input class="searchbar" id="machine-new" placeholder="+ New machine — type its name"
       autocomplete="off" value="">
     <button class="btn btn-primary btn-block btn-lg mt-2.5" data-machine-go="1">Use it</button>
     <button class="btn btn-block btn-ghost btn-sm mt-1.5" data-machine-skip="1">
       Do not record one
     </button>`,
    async (e) => {
      const pick = e.target.closest('[data-machine]');
      if (pick) {
        closeSheet();
        return setMachine(ex, pick.dataset.machine, onPick);
      }

      if (e.target.closest('[data-machine-skip]')) {
        closeSheet();
        // Remembered as asked-and-declined, so it does not ask again this session.
        a.askedMachine = { ...(a.askedMachine ?? {}), [ex.dayExerciseId]: true };
        await persistActive();
        return render();
      }

      if (e.target.closest('[data-machine-go]')) {
        const typed = document.getElementById('machine-new')?.value.trim();
        if (!typed) return toast('Pick one, or type a name');
        closeSheet();
        return setMachine(ex, typed, onPick);
      }
    },
  );
}

/** Record the machine for this lift, for this session and for the gym. */
async function setMachine(ex, machine, onPick, { remember = true } = {}) {
  const a = state.active;
  if (!a) return;

  a.machines = { ...(a.machines ?? {}), [ex.dayExerciseId]: machine };
  a.askedMachine = { ...(a.askedMachine ?? {}), [ex.dayExerciseId]: true };
  a._dirty = true;

  // Sets already logged for this lift today were done on it too.
  for (const s of a.sets) {
    if (s.exerciseId === ex.exerciseId && !s.machine) s.machine = machine;
  }

  const gym = gymById(a.gymId);
  if (gym && remember) await saveGym(rememberMachine(gym, ex.exerciseId, machine));

  await persistActive();
  if (onPick) onPick(machine);
  render();
}

/**
 * Ask about the machine when this lift is opened and there is nothing recorded
 * for it at this gym — which is exactly the case the list is being built from.
 *
 * Asked at most once per lift per session: backing out of the sheet must not
 * put it straight back up.
 */
function maybeAskMachine() {
  const a = state.active;
  if (!a || a.view !== 'exercise' || !a.gymId) return;
  if (sheetOpen()) return;

  const ex = currentExercise();
  if (!ex || a.askedMachine?.[ex.dayExerciseId]) return;
  if (a.machines?.[ex.dayExerciseId]) return;

  const lift = state.boot.exercises.find((x) => x.id === ex.exerciseId);
  if (!tracksMachine(lift ?? { name: ex.name })) return;

  const gym = gymById(a.gymId);
  const predicted = gym ? predictMachine(gym, ex.exerciseId) : null;

  // Known already: use it silently. Being asked every session about the lat
  // pulldown you always do on the same machine is how the prompt gets ignored.
  if (predicted) {
    // Not remembered: a prediction that increments its own count is making its
    // own evidence, and the tally stops meaning "what he actually chose".
    setMachine(ex, predicted, undefined, { remember: false });
    return;
  }

  openMachineSheet(ex);
}

async function startSession(dayId, gymId = null) {
  const plan = planFor(dayId, gymId);
  if (!plan) return toast('That day template is missing');

  const ex = {};
  for (const e of plan.exercises) ex[e.dayExerciseId] = freshExerciseState(e);

  const gym = gymById(gymId);
  // The fix is recorded against the gym, not the session: knowing where a gym
  // is costs nothing, while a log of when you were where is a different thing
  // that this app has no use for.
  if (gym && state.geo) await saveGym(recordFix(gym, state.geo));

  state.active = {
    id: uid(),
    view: 'overview',
    dayId,
    dayName: plan.dayName,
    gymId: gym?.id ?? null,
    gymName: gym?.name ?? null,
    machines: {},
    askedMachine: {},
    tempos: {},
    askedTempo: {},
    aids: {},
    defaultTempo: null,
    startedAt: nowISO(),
    finishedAt: null,
    notes: '',
    sets: [],
    plan,
    ex,
    exIndex: 0,
    restEndsAt: null,
    _dirty: true,
  };
  await persistActive();
  go('session');
}

/**
 * The set list is seeded from the scheme but owned by the session, not the
 * template. Real sessions run long or stop early, and the log has to record
 * what happened rather than what was planned.
 */
function currentExercise() {
  const a = state.active;
  return a?.plan?.exercises?.[a.exIndex] ?? null;
}

/** The library record behind a plan entry. See `lib/repository.js`. */
const liftFor = (ex) => repoLiftFor(state.boot, ex);

/** A lift that was never in today's template. See `lib/plan.js`. */
function plannedExerciseFor(exerciseId, schemeId = 'rp-2') {
  return planAdHocExercise({
    exerciseId,
    schemeId,
    exercises: state.boot.exercises,
    history: historyFor(exerciseId),
    availablePlates: platesNow(),
    // Which grid the gym's plates are stamped in. Stamped onto every
    // `equipment`, so `buildPrescription`, `applyDeload` and `smallestStep` all
    // read it without a new argument each.
    unit: unit(),
    defaultRestSeconds: state.settings.defaultRestSeconds,
    uid: () => uid().slice(0, 4),
  });
}

/** One more set than the template asked for, at whatever the last one was. */
async function addSet() {
  const a = state.active;
  const ex = currentExercise();
  const st = a.ex[ex.dayExerciseId];
  const last = st.slots[st.slots.length - 1] ?? { pct: 1, repMin: 6, repMax: 12 };

  st.slots.push({ ...last, note: 'Extra set' });
  st.weights.push(st.weights[st.weights.length - 1] ?? null);
  st.logged.push(null);

  await persistActive();
  render();
}

/**
 * One tap arriving twice must not be two sets.
 *
 * `logCurrentSet` is `async`, and nothing stopped a second call entering before
 * the first had written and repainted — so a nervous double-tap recorded a set
 * that never happened, at the prescribed weight and the default reps for the next
 * slot, straight into history where it becomes a real e1RM point. Reproduced at
 * 0 ms, 30 ms *and* 400 ms apart; `user-scalable=no` means iOS does not swallow
 * the second tap for us.
 *
 * A re-entrancy latch rather than a timed debounce, because the thing to prevent
 * is two calls overlapping, not two sets logged quickly — a real second set a
 * moment later is a normal thing to do and must still work.
 */
let loggingSet = false;

async function logCurrentSet() {
  if (loggingSet) return;
  loggingSet = true;
  try {
    await writeCurrentSet();
  } finally {
    loggingSet = false;
  }
}

async function writeCurrentSet() {
  const a = state.active;
  const ex = currentExercise();
  const st = a.ex[ex.dayExerciseId];
  const idx = currentSetIndex(st);
  if (idx >= st.logged.length) return;

  const weight = st.weights[idx];
  const lift = state.boot.exercises.find((e) => e.id === ex.exerciseId);
  if (weight == null || (weight <= 0 && !allowsZeroLoad(lift))) return toast('Set a weight first');

  const reps = st.repDraft ?? defaultReps(withRecall(ex), st, idx);
  const { plates } = platesForTotal(weight, ex.equipment);

  a.sets.push({
    id: uid(),
    exerciseId: ex.exerciseId,
    setIndex: idx + 1,
    weight,
    reps,
    barType: ex.equipment.barType,
    plates,
    machine: a.machines?.[ex.dayExerciseId] ?? null,
    tempo: a.tempos?.[ex.dayExerciseId] ?? null,
    ...(a.aids?.[ex.dayExerciseId] ? { aids: a.aids[ex.dayExerciseId] } : {}),
    loggedAt: nowISO(),
  });

  st.logged[idx] = { weight, reps };
  st.repDraft = null;
  a._dirty = true;

  // In a superset the next thing is the partner, not the clock.
  const next = nextAfterSet(a.plan.exercises, (i) => a.ex[a.plan.exercises[i]?.dayExerciseId], a.exIndex);
  a.exIndex = next.index;
  a.restEndsAt = next.rest ? Date.now() + (ex.restSeconds ?? 180) * 1000 : null;

  await persistActive();
  render();
}

async function undoLastSet() {
  const a = state.active;
  const ex = currentExercise();
  const st = a.ex[ex.dayExerciseId];
  const idx = currentSetIndex(st) - 1;
  if (idx < 0) return;

  st.logged[idx] = null;
  const pos = a.sets.findIndex((s) => s.exerciseId === ex.exerciseId && s.setIndex === idx + 1);
  if (pos >= 0) a.sets.splice(pos, 1);
  a.restEndsAt = null;

  await persistActive();
  render();
}

/** Editing the top set drags the rest of the pyramid with it. */
async function setWeight(idx, weight) {
  const a = state.active;
  const ex = currentExercise();
  const st = a.ex[ex.dayExerciseId];

  if (idx === 0) {
    st.weights = st.slots.map((slot, i) =>
      st.logged[i] ? st.weights[i] : roundToLoadable(weight * slot.pct, ex.equipment),
    );
    st.weights[0] = weight;
  } else {
    st.weights[idx] = weight;
  }

  await persistActive();
  render();
}

async function finishSession() {
  const a = state.active;
  if (!a) return;

  if (!a.sets.length) {
    state.active = null;
    await db.delMeta('active');
    toast('Workout discarded — nothing logged');
    return go('home');
  }

  // Four taps, asked once, while the session is still in the body. A bad day
  // has a cause and the set numbers never hold it.
  if (!a.checkinAsked) {
    return openCheckinSheet();
  }

  a.finishedAt = nowISO();
  const record = { ...stripLocal(a), _dirty: true };
  state.sessions.push(record);
  await db.putSession(record);

  state.active = null;
  await db.delMeta('active');

  // A deload is spent by being trained, and the review runs on fresh numbers.
  const askNow = await (async () => {
    await clearSpentDeloads(record);
    return reviewProgram();
  })();

  go('home');
  toast(`Logged ${a.sets.length} sets`);
  sync({ quiet: true });

  // A suggestion is worth interrupting for at most once a fortnight, and the
  // moment just after a workout is when he is already looking at the phone.
  if (askNow) {
    await markSuggestionsShown();
    const first = state.adapt.pending?.[0];
    if (first) setTimeout(() => openSuggestionSheet(first.id), 400);
  }
}

/* ========================= the fortnightly review ======================== */

/**
 * Work out what the program should change. Change nothing.
 *
 * Run after every finished session, because the verdicts move with every session
 * and a stale suggestion is worse than none.
 *
 * The first version of this **applied** the changes and offered an undo, which is
 * what was asked for. It was the wrong shape, and he said so: a program that edits
 * itself sits badly against the rule the rest of this app is built on — a number
 * changed behind your back is how you stop trusting the ones that were not.
 *
 * Asking also turns out to be worth more than it costs. A decline carries
 * information an acceptance does not: whether the split is satisfying at all,
 * whether this particular idea was any good, and whether the answer is "no" or
 * "not yet". Nothing else in this app can measure any of that.
 *
 * The fortnight survives as the rate at which he is **asked**, not the rate at
 * which things change. A suggestion sheet after every session is the prompt this
 * app has refused five times already.
 */
async function reviewProgram() {
  if (!state.boot) return false;

  const now = nowISO();
  const pending = proposeChanges({
    boot: state.boot,
    sessions: state.sessions,
    now,
    allowVolume: true,
    decisions: state.adapt.decisions ?? [],
  });

  const before = (state.adapt.pending ?? []).map((p) => p.id).join('|');
  state.adapt = { ...state.adapt, pending };
  await db.setMeta('adapt', state.adapt);

  // Worth putting in front of him now? Only if there is something, it is new, and
  // he has not been asked inside the last cycle.
  const isNew = pending.length > 0 && pending.map((p) => p.id).join('|') !== before;
  return isNew && dueForReview(state.adapt.shownAt, now);
}

/** Note that he has been asked, so the next session does not ask again. */
async function markSuggestionsShown() {
  state.adapt = { ...state.adapt, shownAt: nowISO(), lastReviewAt: nowISO() };
  await db.setMeta('adapt', state.adapt);
}

/**
 * Accept a suggestion: make the change, and record that he agreed.
 *
 * The acceptance is kept as well as acted on. "He agreed with this one" is as much
 * signal as "he did not", and the pair is what makes the record worth reading in
 * six months.
 */
async function acceptProposal(id, { ratings = {}, note = '' } = {}) {
  const proposal = (state.adapt.pending ?? []).find((p) => p.id === id);
  if (!proposal) return;

  // Enough of the slot to put it back exactly. Accepting is a decision, not a
  // commitment — he may try the swap for a week and want the old lift again.
  const day = state.boot.days.find((d) => d.id === proposal.dayId);
  const slot = day?.exercises?.find((e) => e.exerciseId === proposal.exerciseId);
  const before = slot ? {
    exerciseId: slot.exerciseId,
    name: slot.name,
    muscleGroup: slot.muscleGroup ?? null,
    schemeId: slot.schemeId,
    deloadPct: slot.deloadPct ?? null,
  } : null;

  const next = applyProposal(state.boot, proposal);

  // Decided BEFORE `updateBoot` runs, because that reassigns `state.boot` — so a
  // later `next === state.boot` is true whether the change happened or not, and the
  // applied list was never written. The undo button then never appeared, which is
  // the same mistake as comparing against a value something else has moved.
  const changed = next !== state.boot;

  if (!changed) {
    // Declined by `applyProposal` — the slot moved, or the replacement is not a
    // lift any more. Saying so is better than a silent no-op on a tap.
    toast('That lift has changed since — nothing to do');
  } else {
    await updateBoot(next);
  }

  state.adapt = {
    ...state.adapt,
    pending: (state.adapt.pending ?? []).filter((p) => p.id !== id),
    applied: changed
      ? [{ ...proposal, appliedAt: nowISO(), before }, ...(state.adapt.applied ?? [])].slice(0, 40)
      : state.adapt.applied ?? [],
    decisions: recordDecision(state.adapt.decisions, {
      proposal, decision: 'accepted', ratings, note, now: nowISO(),
    }),
  };

  await db.setMeta('adapt', state.adapt);
  closeSheet();
  render();
  if (changed) toast('Program updated');
}

/** Decline it, and keep why. */
async function declineProposal(id, { reason = null, ratings = {}, note = '' } = {}) {
  const proposal = (state.adapt.pending ?? []).find((p) => p.id === id);
  if (!proposal) return;

  state.adapt = {
    ...state.adapt,
    pending: (state.adapt.pending ?? []).filter((p) => p.id !== id),
    decisions: recordDecision(state.adapt.decisions, {
      proposal, decision: 'declined', reason, ratings, note, now: nowISO(),
    }),
  };

  await db.setMeta('adapt', state.adapt);
  closeSheet();
  render();
  toast('Left as it is');
}

/**
 * The suggestion, and the few questions worth asking about it.
 *
 * One screen. Two optional scales and an optional note, because "not something
 * super long" was the instruction and a form nobody finishes measures nothing.
 * The decline reasons are three chips rather than free text alone: "no" in three
 * different senses needs three different responses from the app, and only a fixed
 * list can be acted on.
 */
function openSuggestionSheet(id) {
  const proposal = (state.adapt.pending ?? []).find((p) => p.id === id);
  if (!proposal) return;

  const draft = { ratings: {}, reason: null, declining: false };

  const kindLabel = {
    swap: 'Swap this movement', deload: 'Step the weight back',
    'add-set': 'Add a working set', 'remove-set': 'Drop a working set',
  };

  const paint = () => {
    const scaleRow = (scale) => `<div class="mb-3">
        <div class="tiny muted mb-1.5">${esc(scale.label)}</div>
        <div class="row gap-1.5">
          ${[1, 2, 3, 4, 5].map((n) => `<button class="btn btn-sm grow ${draft.ratings[scale.id] === n ? 'btn-primary' : ''}"
              data-scale="${esc(scale.id)}" data-value="${n}">${n}</button>`).join('')}
        </div>
        <div class="row-between tiny muted mt-1">
          <span>${esc(scale.low)}</span><span>${esc(scale.high)}</span>
        </div>
      </div>`;

    openSheet(
      `<h2 class="mt-0">${esc(kindLabel[proposal.kind] ?? 'A change')}</h2>
       <div class="card mb-3.5">
         <b class="text-sm">${esc(proposal.name)}</b>
         <div class="tiny muted mt-1.5">${esc(proposal.reason)}</div>
       </div>

       ${FEEDBACK_SCALES.map(scaleRow).join('')}

       ${draft.declining
         ? `<div class="tiny muted mb-1.5">Why are you leaving it?</div>
            ${DECLINE_REASONS.map((r) => `<button class="btn btn-block ${draft.reason === r.id ? 'btn-primary' : ''} mb-1.5 text-left"
                data-reason="${esc(r.id)}">
                <b>${esc(r.label)}</b><div class="tiny muted">${esc(r.detail)}</div>
              </button>`).join('')}`
         : ''}

       <label class="tiny muted">Anything else? (optional)</label>
       <input class="input mx-0 mt-1.5 mb-3.5" id="sg-note" value="${esc(draft.note ?? '')}"
         placeholder="in your own words" autocomplete="off">

       ${draft.declining
         ? `<button class="btn btn-block btn-lg ${draft.reason ? 'btn-primary' : ''}" data-sg-decline-go="1"
              ${draft.reason ? '' : 'disabled'}>Keep it as it is</button>
            <button class="btn btn-block btn-ghost btn-sm mt-2" data-sg-back="1">Back</button>`
         : `<button class="btn btn-primary btn-block btn-lg" data-sg-accept="1">Make this change</button>
            <button class="btn btn-block mt-2" data-sg-decline="1">Keep it as it is</button>`}`,

      async (e) => {
        const note = () => sheetPanel.querySelector('#sg-note')?.value?.trim() ?? '';

        const scale = e.target.closest('[data-scale]');
        if (scale) {
          const key = scale.dataset.scale;
          const value = Number(scale.dataset.value);
          // Tapping the same number clears it, so a mis-tap is its own undo — the
          // same rule as the per-set feel score.
          draft.ratings[key] = draft.ratings[key] === value ? undefined : value;
          draft.note = note();
          return paint();
        }

        const reason = e.target.closest('[data-reason]');
        if (reason) {
          draft.reason = reason.dataset.reason;
          draft.note = note();
          return paint();
        }

        if (e.target.closest('[data-sg-decline]')) {
          draft.declining = true;
          draft.note = note();
          return paint();
        }

        if (e.target.closest('[data-sg-back]')) {
          draft.declining = false;
          draft.note = note();
          return paint();
        }

        if (e.target.closest('[data-sg-accept]')) {
          return acceptProposal(id, { ratings: draft.ratings, note: note() });
        }

        if (e.target.closest('[data-sg-decline-go]')) {
          if (!draft.reason) return;
          return declineProposal(id, { reason: draft.reason, ratings: draft.ratings, note: note() });
        }
      },
    );
  };

  paint();
}

/** Put one accepted change back exactly as it was. */
async function undoChange(id) {
  const change = (state.adapt.applied ?? []).find((a) => a.id === id);
  if (!change?.before) return;

  const day = state.boot.days.find((d) => d.id === change.dayId);
  // Matched on what it was changed *to*, because that is what is in the slot now.
  const target = change.kind === 'swap' ? change.apply.exerciseId : change.exerciseId;
  const slot = day?.exercises?.find((e) => e.exerciseId === target);

  if (!slot) {
    toast('That lift has moved since — nothing to undo');
    state.adapt = { ...state.adapt, applied: state.adapt.applied.filter((a) => a.id !== id) };
    await db.setMeta('adapt', state.adapt);
    return render();
  }

  const restored = {
    ...slot,
    exerciseId: change.before.exerciseId,
    name: change.before.name,
    muscleGroup: change.before.muscleGroup,
    schemeId: change.before.schemeId,
    deloadPct: change.before.deloadPct ?? undefined,
  };

  await updateBoot({
    ...state.boot,
    days: state.boot.days.map((d) => (d.id !== change.dayId ? d : {
      ...d,
      exercises: d.exercises.map((e) => (e === slot ? restored : e)),
    })),
  });

  state.adapt = { ...state.adapt, applied: state.adapt.applied.filter((a) => a.id !== id) };
  await db.setMeta('adapt', state.adapt);

  render();
  toast(`${change.before.name} put back`);
}

/**
 * A deload is spent the moment the lift is trained.
 *
 * Once, deliberately: it is a step back to climb out of, not a new ceiling. Left in
 * place it would take 10% off every session forever, which is not a deload — it is
 * a quieter program.
 */
async function clearSpentDeloads(session) {
  if (!state.boot) return;

  const trained = new Set((session?.sets ?? []).map((x) => x.exerciseId));
  if (!trained.size) return;

  let touched = false;
  const days = state.boot.days.map((d) => {
    if (d.id !== session.dayId) return d;
    return {
      ...d,
      exercises: d.exercises.map((e) => {
        if (!e.deloadPct || !trained.has(e.exerciseId)) return e;
        touched = true;
        const { deloadPct, ...rest } = e;
        return rest;
      }),
    };
  });

  if (touched) await updateBoot({ ...state.boot, days });
}

/* ================================ routing =============================== */

function go(route, param) {
  // Navigating away from a half-finished edit should never lose it silently.
  if (state.draftDirty && route !== 'edit-day') {
    if (!confirm('Discard unsaved changes to this day?')) return;
    state.draft = null;
    state.draftDirty = false;
  }

  state.route = route;
  if (route === 'exercise') state.detailExercise = param;
  window.scrollTo(0, 0);
  render();
}


/**
 * A day's name, short enough for a calendar cell: "Push 1" becomes "P1".
 *
 * A number stays a number — it is the half of the name that distinguishes
 * "Push 1" from "Push 2", and dropping it would make the two indistinguishable
 * in the one place the whole point is telling days apart.
 */
const initialsOf = (name) => String(name ?? '')
  .split(/\s+/)
  .filter(Boolean)
  .map((w) => (/^\d+$/.test(w) ? w : w[0].toUpperCase()))
  .join('')
  .slice(0, 2);

/**
 * A lift's muscle group, as a mark for the leading slot of a row.
 *
 * Keyed on the *group*, not the exercise, and that is what makes it
 * affordable: `normaliseMuscleGroup` folds every spelling into one of eleven
 * values and runs on a lift created on a phone mid-workout exactly as it does
 * on a seeded one. Per-exercise artwork would be ~150 KB and would still have
 * nothing to draw for a lift somebody invents at the rack.
 *
 * Decorative, so `aria-hidden`: the name beside it is the content, and the
 * glyph says nothing the row does not already say in words.
 */
/**
 * Which region of the body a lift is for, as four learnable groups.
 *
 * Eleven muscle groups is the honest taxonomy and the wrong number of
 * *colours*: people cannot name eleven surface hues reliably, so eleven means
 * nobody learns any of them. Four maps onto the vocabulary the program already
 * uses — the day names are literally "Push 1" and "Pull 2" — so the fill is
 * something the user has already been taught by their own split.
 *
 * The two letters carry the full eleven-way distinction. Letters are a
 * categorically better discriminator at this size than any glyph, because they
 * are the one thing the typeface was actually drawn to render small.
 */
const REGION_OF = {
  chest: 'push', shoulders: 'push', triceps: 'push',
  back: 'pull', biceps: 'pull', forearms: 'pull',
  quads: 'legs', hamstrings: 'legs', glutes: 'legs', calves: 'legs',
  core: 'core',
};

/** Two letters, in the display face, as a stamped tile. */
const MONOGRAM = {
  chest: 'CH', back: 'BK', shoulders: 'SH', triceps: 'TR', biceps: 'BI',
  forearms: 'FA', quads: 'QU', hamstrings: 'HA', glutes: 'GL', calves: 'CA',
  core: 'CO',
};

/**
 * The tile at the leading edge of a row where the category narrows a choice.
 *
 * Used in the picker and the library and **nowhere else**, which is the part
 * that took a failed attempt to learn. A mark helps when the image is the thing
 * being discriminated between, and costs scanning speed when the text already
 * discriminates. On the Train and logger rows the lift's name carries all of
 * the identity, so a category mark there was decoration — it was tried, drawn
 * as eleven abstract glyphs, and it was unreadable at 36px for a reason no
 * amount of redrawing fixes: there was nothing for it to say.
 *
 * In the picker there is. Ninety-three names, most of them unfamiliar, and the
 * region genuinely narrows the field.
 */
function groupGlyph(group) {
  const key = normaliseMuscleGroup(group);
  if (!MUSCLE_GROUPS.includes(key)) return '<span class="ex-glyph" aria-hidden="true"></span>';

  return `<span class="ex-glyph region-${REGION_OF[key] ?? 'core'}" aria-hidden="true"
      >${MONOGRAM[key] ?? '--'}</span>`;
}

/**
 * A figure performing the movement, for the leading slot of a row.
 *
 * One tile carrying two facts: the **drawing** says what the movement is, and
 * its **colour** says which region of the body it is for. That combination is
 * why it is worth 36px — a monogram said only the second thing, and a
 * monochrome figure would have said only the first.
 *
 * Keyed on the movement rather than the exercise, so a lift invented at the
 * rack gets one for free. `poseOf` returns null rather than guessing when it
 * cannot place a lift, and this returns an empty tile for that case: a wrong
 * figure is worse than none, because at this size nobody re-reads the name to
 * check it.
 */
function exerciseFigure(exercise) {
  const pose = poseOf(exercise);
  const region = REGION_OF[normaliseMuscleGroup(exercise?.muscleGroup)] ?? '';

  if (!pose) return `<span class="ex-figure ${region ? `figure-${region}` : ''}" aria-hidden="true"></span>`;

  return `<span class="ex-figure ${region ? `figure-${region}` : ''}" aria-hidden="true">
      <svg viewBox="0 0 24 24"><use href="#p-${pose}"/></svg>
    </span>`;
}

/* ================================= views ================================ */

/**
 * Is the user part-way through filling something in?
 *
 * Rebuilding `view.innerHTML` throws away whatever is in an input, along with
 * focus and the caret. Most renders happen while nothing is focused and nobody
 * notices — but a settings save, a sync finishing, or a rest timer tick can all
 * land mid-entry, and then a typed number silently disappears. This has now
 * caused three separate bugs, so the guard lives in one place rather than being
 * worked around at each of them.
 */
function isEditing() {
  const el = document.activeElement;
  if (!el || !view.contains(el)) return false;
  return el.matches('input, select, textarea');
}

/**
 * A finger is already down somewhere in the view.
 *
 * The same problem as typing, and it took a five-run failure analysis to see that
 * they are the same problem. Taps are dispatched by delegation on `#view`, so a
 * button replaced between the press and the release leaves the click landing on a
 * detached node — where nothing is listening, and **the tap is silently lost**. The
 * typed value sits in the field looking perfectly saved.
 *
 * So an asynchronous repaint waits for the finger to come up, exactly as it waits
 * for typing to stop. Cleared on a timer as well as on release, because a pointer
 * that leaves the screen or is cancelled mid-gesture must not wedge the app into
 * never repainting again.
 */
let interacting = false;
let interactingTimer = null;

const endInteraction = () => {
  interacting = false;
  clearTimeout(interactingTimer);
  // After a tick, so the click that follows the release is dispatched first.
  setTimeout(() => { if (!interacting && renderPending) render(); }, 0);
};

view.addEventListener('pointerdown', () => {
  interacting = true;
  clearTimeout(interactingTimer);
  // A gesture nobody finished must not stop the screen updating for ever.
  interactingTimer = setTimeout(() => { interacting = false; }, 2000);
}, true);

view.addEventListener('pointerup', endInteraction, true);
view.addEventListener('pointercancel', endInteraction, true);

/** A render deferred because he was typing, flushed when he stops. */
let renderPending = false;

/**
 * The markup currently on screen.
 *
 * Compared against before replacing anything, so an identical repaint is skipped
 * rather than destroying focus and in-flight taps for no change.
 */
let lastMarkup = null;

/**
 * The route the enter animation last ran for.
 *
 * The animation is a *navigation* cue, so it has to fire on a route change and
 * on nothing else. `render()` is also called by the rest timer every second, by
 * a sync finishing, and by every set logged — and running an eight-pixel rise
 * on the whole screen once a second while somebody is counting reps would be
 * the single most irritating thing in the app.
 */
let lastEnterRoute = null;

/**
 * @param force  redraw even with a field focused.
 *
 *   Deferring exists to protect typing in progress. By the time a save renders,
 *   every field has already been read and the draft cleared, so there is
 *   nothing left to protect and the deferral can only hold back a redraw he
 *   just asked for.
 *
 *   Honest note: this was added believing it fixed a stale card, and it did
 *   not — that turned out to be a test racing the async write. It is kept
 *   because forcing is right on its own terms, not because a bug was proven.
 */
/**
 * Every screen, by route.
 *
 * Named rather than inlined so that it is a thing which can be checked: the
 * markup test asserts every nav button has an entry here, which caught a nav
 * item pointing at a view that did not exist.
 */
const ROUTES = {
  home: viewHome,
  session: viewSession,
  history: viewHistory,
  exercise: viewExerciseDetail,
  coach: viewCoach,
  edit: viewEdit,
  'edit-day': viewEditDay,
  library: viewLibrary,
  gyms: viewGyms,
  setup: viewSetup,
  accounts: viewAccounts,
  member: viewMember,
  tour: viewTour,
  plan: viewPlan,
};

/**
 * Repaint, and never destroy a field somebody is typing in.
 *
 * `force` used to mean "ignore that someone is typing", and that was the root of a
 * whole family of intermittent failures. The mechanism is narrower and nastier than
 * losing the text:
 *
 *   1. A field is filled. Nothing is saved yet — these save on `change`, which
 *      fires on blur.
 *   2. An asynchronous forced render lands (the Google config lookup on boot, a
 *      sync completing, an account fetch returning) and replaces `view.innerHTML`.
 *   3. The blur then happens on a **detached node**, so no `change` event fires
 *      anywhere, and **the save silently never happens**.
 *   4. The new field renders from state, which still holds the old value — so the
 *      screen looks completely correct and the write is simply missing.
 *
 * Nothing is visibly broken at any point, which is why it surfaced as a different
 * browser test failing each run rather than as a bug anybody could reproduce.
 *
 * So `force` now means "commit and repaint": the focused field is blurred **first**,
 * which runs its change handler against a live node and saves, and only then is the
 * markup replaced. The typing guard itself is no longer bypassable.
 */
/**
 * Acknowledge that the screen changed, then take the flag off again.
 *
 * One fade on `#view`, where this used to be a staggered rise on every child.
 * The attribute is still removed rather than left in place, because the
 * animation sets `animation-fill-mode: both` and `both` holds the *from*
 * keyframe — a screen left carrying the attribute would sit at `opacity: 0`.
 *
 * The listener is on `#view` itself now, which it could not be before:
 * `animationend` bubbles, so a container-level listener used to fire on the
 * first *child* to finish and cut the rest off mid-rise. With one animation on
 * one element there is nothing to be early for. The timeout stays as the belt
 * to that braces — an animation cancelled by another repaint never fires at
 * all, and the attribute must not be able to strand the screen invisible.
 */
function enterView() {
  view.dataset.enter = '1';

  let done = false;
  const clear = () => {
    if (done) return;
    done = true;
    delete view.dataset.enter;
  };

  view.addEventListener('animationend', clear, { once: true });
  setTimeout(clear, 400);
}

function render(force = false) {
  if (!force && (isEditing() || interacting)) {
    renderPending = true;
    renderStatus();
    return;
  }

  /**
   * Commit before repainting. This is the half the comment above described and
   * the code did not do — there was not one `.blur(` in this file.
   *
   * Blurring here runs the field's own `change` handler against a node that is
   * still in the document, so the value is saved; the repaint below then renders
   * it back from state. Without it the blur happened on a detached node after
   * `innerHTML` had already been replaced, no `change` reached anything, and the
   * write silently never happened — while the screen looked entirely correct.
   */
  if (force && isEditing()) document.activeElement.blur();

  renderPending = false;

  renderStatus();
  for (const btn of nav.querySelectorAll('.nav-btn')) {
    const r = btn.dataset.route;
    const active =
      r === state.route ||
      (state.route === 'session' && r === 'home') ||
      (state.route === 'exercise' && r === 'history') ||
      (state.route === 'edit-day' && r === 'edit') ||
      (state.route === 'library' && r === 'edit') ||
      (state.route === 'gyms' && r === 'edit');
    btn.classList.toggle('on', active);

    /**
     * A live workout, said on every tab.
     *
     * Found by walking the app rather than reading it: mid-session, Coach,
     * History, Edit and Setup say nothing at all about a workout being open.
     * The only way back was remembering that Train holds a resume card.
     *
     * That is the most likely thing to be needed mid-workout — you check a
     * lift's history between sets, or whether a weight is holding — and the app
     * quietly stops mentioning that you are in the middle of something. A set
     * logged against the wrong session, or a session left running overnight,
     * both start here.
     *
     * The nav is where it belongs, because the nav is the only thing on screen
     * on every tab. A dot rather than a count: what matters is *that* something
     * is open, and the set count is already on the resume card one tap away.
     * The `aria-label` carries the same fact, because a mark that exists only
     * as a coloured dot says nothing to a screen reader — the same rule the
     * Coach screen already keeps about never giving a direction in colour
     * alone.
     */
    if (r === 'home') {
      const live = Boolean(state.active);
      btn.classList.toggle('has-live', live);
      btn.setAttribute('aria-label', live ? 'Train — a workout is in progress' : 'Train');
      let dot = btn.querySelector('.nav-live');
      if (live && !dot) {
        dot = document.createElement('span');
        dot.className = 'nav-live';
        dot.setAttribute('aria-hidden', 'true');
        btn.append(dot);
      } else if (!live && dot) {
        dot.remove();
      }
    }
  }

  if (!state.boot && state.booting) {
    view.innerHTML = `<div class="loading">
      <div class="spinner spinner-lg"></div>
      <div class="tiny">Loading your program…</div>
    </div>`;
    return;
  }

  if (!state.boot) {
    view.innerHTML = state.bootError
      ? `<h1>Can't load</h1>
         <div class="card">
           <div class="mb-2.5">The app reached this page but could not load your program,
           and there is nothing cached on this phone yet.</div>
           <div class="tiny muted mono break-all">
             tried ${esc(location.origin)}/api/bootstrap<br>
             ${esc(state.bootError)}
           </div>
         </div>
         ${state.storageError
           ? `<div class="card"><div class="tiny text-bad">
                Phone storage unavailable: ${esc(state.storageError)}<br><br>
                This usually means a Private Browsing tab. Open the site in a normal Safari tab.
              </div></div>`
           : ''}
         <button class="btn btn-primary btn-block btn-lg" data-act="retry-boot">Try again</button>`
      : `<div class="empty">Loading your program…<br><br>
         <button class="btn" data-act="retry-boot">Retry</button></div>`;
    return;
  }

  // Two screens come before everything else, and in this order: there is no
  // point asking who she is before she can prove it, and no point showing her a
  // Coach tab that has nothing to say until she has answered six questions.
  const gate = needsWelcome() ? viewWelcome : needsRegistration() ? viewRegister : null;

  const html = gate ?? ROUTES[state.route] ?? viewHome;

  nav.hidden = Boolean(gate);

  /**
   * Only replace the markup when it actually differs.
   *
   * Replacing `view.innerHTML` with an identical string is not free — it is
   * actively destructive. It throws away focus, the caret, and **any tap already in
   * flight**: the click handler is delegated on `#view`, so a button swapped out
   * between the hit-test and the dispatch leaves the event landing on a detached
   * node, where nothing is listening. The tap is then silently lost.
   *
   * That is almost certainly the "bodyweight does not save" he reported weeks ago.
   * `refreshForSync` repaints Setup when a sync starts and again when it finishes,
   * and the markup either side is usually identical — so the only thing those
   * repaints ever did was give a tap a one-in-a-few chance of vanishing.
   *
   * Caught by a browser test that failed about one run in three with the typed
   * weight visibly present in the field and nothing in the store, which is exactly
   * what a swallowed tap looks like from outside.
   */
  const markup = html();
  if (markup !== lastMarkup) {
    view.innerHTML = markup;
    lastMarkup = markup;

    // A route change, not just a repaint. `gate` counts as its own route so
    // that arriving at the sign-in wall animates too.
    const key = gate ? 'gate' : state.route;
    if (key !== lastEnterRoute) {
      lastEnterRoute = key;
      enterView();
    }
  }

  // After the markup exists, because Google renders into an element rather than
  // returning any. Fire-and-forget: a failure leaves the code field untouched.
  if (gate === viewWelcome && state.googleClientId) mountGoogleButton();
  if (state.route === 'session') { startTicking(); maybeAskMachine(); maybeAskTempo(); maybeApplyAids(); }
  else stopTicking();
}

/**
 * The banner is for problems only.
 *
 * Not reaching a PC is the normal state — the phone owns the data and the
 * server is an optional backup — so flagging it permanently was alarming about
 * nothing. Unsynced counts live on the Setup screen instead.
 */
function renderStatus() {
  if (state.syncing) {
    statusBar.hidden = false;
    statusBar.className = 'status-bar syncing';
    statusBar.textContent = 'Backing up…';
    return;
  }

  if (state.offlineReady === false) {
    statusBar.hidden = false;
    statusBar.className = 'status-bar';
    statusBar.textContent = 'No offline mode — open over HTTPS. See Setup.';
    return;
  }

  statusBar.hidden = true;
}

/* -------------------------------- home ---------------------------------- */

function viewHome() {
  const a = state.active;
  const programs = state.boot.programs ?? [];

  const resume = a
    ? `<button class="card card-tap border-accent" data-act="resume">
         <div class="row-between">
           <div>
             <div class="pill pill-accent">In progress</div>
             <h2 class="mx-0 mt-2 mb-0.5">${esc(a.dayName)}</h2>
             <div class="tiny muted">${a.sets.length} sets logged · started ${fmtDate(a.startedAt)}</div>
           </div>
           <div style="font-size:26px">›</div>
         </div>
       </button>`
    : '';

  /**
   * What to do today, answered before the list of everything.
   *
   * The list is unchanged and every day is still one tap — this adds an answer
   * for somebody who does not have one, without taking the choice from somebody
   * who does. The week is computed over the days of the program the person has
   * actually been training, because the seed ships two programs and suggesting
   * across both would produce incoherent training.
   */
  const activeProgram = programs.find((p) => trainedProgramId() === p.id) ?? programs[0];
  const weekDays = (state.boot.days ?? []).filter((d) => d.programId === activeProgram?.id);
  const week = weekPlan({ days: weekDays, sessions: state.sessions });
  const states = new Map(week.days.map((d) => [d.dayId, d.state]));

  const upNext = week.nextDayId
    ? (() => {
        const day = weekDays.find((d) => d.id === week.nextDayId);
        // `data-suggested` because this is a *shortcut to* a day that is also in
        // the list below, not an extra day. Anything counting how many days exist
        // has to be able to say so without double-counting this one.
        return `<button class="card card-tap card-hero rail" data-act="start" data-suggested="1" data-id="${esc(day.id)}">
            <div class="eyebrow text-accent">
              ${week.done === 0 ? 'Start of your week' : `Day ${week.done + 1} of ${week.planned}`}
            </div>
            <div class="row-between mt-1">
              <div class="grow min-w-0">
                <b class="t text-2xl">${esc(day.name)}</b>
                <div class="names mt-1 truncate">
                  ${esc(day.exercises.map((e) => e.name).join(' · '))}
                </div>
              </div>
              <span class="chev chev-lg" aria-hidden="true"></span>
            </div>
          </button>`;
      })()
    : week.complete
      ? `<div class="card">
           <b class="tiny">That is your week done</b>
           <div class="tiny muted mt-1.5">
             ${week.planned} session${week.planned === 1 ? '' : 's'} this week. Anything below is extra —
             train it if you want to, it all counts.
           </div>
         </div>`
      : '';

  const groups = programs
    .map((p) => {
      const days = (state.boot.days ?? []).filter((d) => d.programId === p.id);
      if (!days.length) return '';
      const cards = days
        .map((d) => {
          const last = lastPerformed(d.id);
          const names = d.exercises.map((e) => e.name).join(' · ');
          const state_ = states.get(d.id);

          /**
           * Two pills were removed, and neither carried anything.
           *
           * "not yet" rendered on eight of nine rows on a fresh install — a
           * label repeated until it says nothing, when its own absence already
           * says it. "done this week" went for a different reason: the row is
           * already dimmed to 55% with a greyed title by `.card-day.is-done`,
           * so the pill was the same fact a second time, in the quietest place
           * on the row.
           */
          // `done` dims the row and `next` gets the rail. Both states were
          // carried by a pill alone, which put the only difference between
          // "trained on Monday" and "never done" inside a 7px-tall label at the
          // end of a line — found by reading, not by looking.
          const mark = state_ === 'next' ? ' rail' : state_ === 'done' ? ' is-done' : '';
          return `<button class="card card-tap card-day${mark}" data-act="start" data-id="${esc(d.id)}">
            <div class="row-between">
              <div class="grow min-w-0">
                <div class="row gap-2 wrap">
                  <b class="t text-xl">${esc(d.name)}</b>
                  <span class="pill">${d.exercises.length} lifts</span>
                  ${state_ === 'next' ? '<span class="pill pill-solid">up next</span>' : ''}
                  ${last ? `<span class="pill">${esc(daysAgo(last))}</span>` : ''}
                </div>
                <div class="names mt-1 truncate">${esc(names)}</div>
              </div>
              <span class="chev" aria-hidden="true"></span>
            </div>
          </button>`;
        })
        .join('');
      /**
       * The program you are not training is collapsed.
       *
       * Both programs were fully expanded, so the default screen was nine day
       * cards across two splits — and the second one is *navigation*, not
       * content. "Which program" is a decision made once a mesocycle; "which
       * day" is made daily, and the daily one was sharing the screen with it.
       *
       * `n`, not a bare number: this rendered "4 day" for as long as it had
       * existed, which is the whole argument for plural rules over a ternary —
       * the ternary at least gets English right, and this had neither.
       */
      const active = p.id === activeProgram?.id;

      /**
       * Open unless *this user* shut it — not "open only if it is the one being
       * trained".
       *
       * The first version of this collapsed every program but the active one,
       * which read well and broke the app. `Upper 1` lives in the second
       * program, so half the days became unreachable without a tap — and 150
       * browser tests failed on `startDay(page, 'Upper 1')` finding nothing.
       *
       * They were right to. "Every day is still listed and still one tap" is
       * written into CONTEXT.md as a load-bearing promise and into
       * `week.spec.js` as a test, and it is the whole reason the suggestion is
       * allowed to exist at all: it suggests, it does not decide. A default
       * that hides half the program is deciding.
       *
       * So collapsing is a thing you can *do*, not a thing done to you. The
       * density win is smaller and it costs nothing.
       */
      const open = !state.collapsedPrograms.includes(p.id);

      /*
       * The button lives *inside* the `h2`, rather than replacing it.
       *
       * The first version made the program name a bare button, which reads the
       * same and quietly deleted it from the document outline — a program name
       * introducing its list of days is a heading, and somebody navigating by
       * heading lost both of them. `regressions.spec.js` caught it by asking
       * for the heading role, which is exactly the right thing to have been
       * asserting.
       *
       * A control inside a heading is the standard disclosure shape: the
       * heading keeps the outline, the button keeps the behaviour, and the
       * accessible name is still the program's.
       */
      return `<h2 class="program-head">
          <button class="btn btn-sm btn-block disclosure"
            data-act="program-toggle" data-id="${esc(p.id)}" aria-expanded="${open}">
            <span class="row gap-2 grow min-w-0">
              <b class="t truncate">${esc(p.name)}</b>
              <span class="pill">${esc(n('count.days', p.daysPerWeek))}</span>
            </span>
            ${active ? '<span class="pill pill-accent">training</span>' : ''}
            <span class="chev" aria-hidden="true"></span>
          </button>
        </h2>
        ${open ? cards : ''}`;
    })
    .join('');

  return `<h1>Train</h1>
    <p class="sub">${week.nextDayId || week.complete
      ? `${week.done} of ${week.planned} done this week. Any day is still one tap.`
      : 'Pick any day — order is up to you.'}</p>
    ${resume}
    ${upNext}
    ${week.nextDayId ? '<h2 class="mt-5">Everything else</h2>' : ''}
    ${groups}`;
}

/**
 * Which program the person is actually training.
 *
 * The seed ships two, and the Train tab lists both — so "what is next" has to
 * pick one or it would suggest across a push/pull/legs split and an upper/lower
 * one in the same week, which is incoherent training. The most recently trained
 * program wins; with no history at all, the first one does.
 */
function trainedProgramId() {
  const byDay = new Map((state.boot?.days ?? []).map((d) => [d.id, d.programId]));
  const latest = [...state.sessions]
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .map((s) => byDay.get(s.dayId))
    .find(Boolean);
  return latest ?? state.boot?.programs?.[0]?.id ?? null;
}

/* ------------------------------- session -------------------------------- */

/**
 * The whole workout, at a glance.
 *
 * A session is a list of work, not a queue of one exercise with a Next button.
 * Landing here means you can see what is left, jump to whatever machine is
 * free, and bundle lifts into one round on the spot.
 */
/** The machine this lift is on today, and a way to change it. */
/**
 * How many times this lift has already come up in this session.
 *
 * A lift can legitimately recur — a top set early and a back-off at the end —
 * and a note on one is not a note on the other. Counting the slots before this
 * one is what gives each its own key without needing a slot id, which a lift
 * swapped in mid-session does not have.
 */
function occurrenceOf(ex) {
  const a = state.active;
  const slots = a?.plan?.exercises ?? [];
  const upTo = slots.findIndex((e) => e.dayExerciseId === ex.dayExerciseId);
  if (upTo < 0) return 1;
  return slots.slice(0, upTo).filter((e) => e.exerciseId === ex.exerciseId).length + 1;
}

/** The note on this lift, this session, this time round. */
function noteOf(ex) {
  const a = state.active;
  if (!a) return null;
  return noteFor(state.notes, a.id, ex.exerciseId, occurrenceOf(ex));
}

/**
 * A line about this lift, today.
 *
 * Available at every level, unlike tempo and kit: writing down that the pad was
 * two notches lower needs no vocabulary and is the single most useful thing a
 * beginner can record, because it is the thing they will not remember and the
 * thing that explains next week's number.
 */
function noteChip(ex) {
  const note = noteOf(ex);
  return `<button class="btn btn-sm btn-block ${note ? '' : 'btn-ghost'} mb-2.5"
      data-act="lift-note">
      ${note ? `Note · ${esc(note.text)}` : '+ Note on this lift'}
    </button>`;
}

/**
 * Write it, with the words already used offered as chips.
 *
 * The vocabulary is **learned, not fixed**. A fixed list was tried and rejected
 * on the first real import: "close grip" and "lower back pad" were not on it,
 * and neither is "more stretch at the bottom". So the chips are the labels this
 * log already contains, most used first, and an empty log offers none — because
 * suggesting labels nobody has used is how a fixed list gets reinvented.
 */
function openNoteSheet(ex) {
  const a = state.active;
  if (!a) return;

  const occurrence = occurrenceOf(ex);
  const existing = noteOf(ex);
  const vocab = labelsFrom(state.notes.filter(isLiftNote)).slice(0, 8);

  openSheet(
    `<h2 class="mt-0">${esc(ex.name)}</h2>
     <div class="tiny muted mb-2.5">
       What was different about it today. Commas separate things you may want to find
       again — "close grip, lower pad" is two labels.
     </div>
     <textarea class="input mb-2.5" id="note-text" rows="3"
       placeholder="close grip">${esc(existing?.text ?? '')}</textarea>
     ${vocab.length
       ? `<div class="tiny muted mb-1.5">Used before</div>
          <div class="row wrap gap-1.5 mb-3">
            ${vocab.map((v) => `<button class="btn btn-sm" data-label="${esc(v.label)}">${esc(v.label)}</button>`).join('')}
          </div>`
       : ''}
     <button class="btn btn-primary btn-block btn-lg" data-note-save="1">
       ${existing ? 'Save' : 'Add the note'}
     </button>
     ${existing
       ? '<button class="btn btn-block btn-ghost btn-sm mt-2" data-note-clear="1">Remove it</button>'
       : ''}`,
    async (e) => {
      const box = sheetPanel.querySelector('#note-text');

      const chip = e.target.closest('[data-label]');
      if (chip) {
        // Appended rather than replacing: the chips are for adding a label to
        // what is already written, which is the common case.
        const current = box.value.trim();
        box.value = current ? `${current}, ${chip.dataset.label}` : chip.dataset.label;
        box.focus();
        return;
      }

      if (e.target.closest('[data-note-clear]')) {
        closeSheet();
        return saveLiftNote(ex, occurrence, '');
      }

      if (e.target.closest('[data-note-save]')) {
        const text = box.value;
        closeSheet();
        return saveLiftNote(ex, occurrence, text);
      }
    },
  );

  sheetPanel.querySelector('#note-text')?.focus();
}

/**
 * Store it, locally first.
 *
 * Lift notes ride the same store, the same sync payload and the same `notes`
 * table as bug reports, because that channel already works end to end. They are
 * told apart by the id prefix rather than by a field, since the table has no
 * column for one and it would be lost the first time a note came back down.
 */
async function saveLiftNote(ex, occurrence, text) {
  const a = state.active;
  if (!a) return;

  const note = makeNote({ sessionId: a.id, exerciseId: ex.exerciseId, occurrence, text });
  state.notes = upsertNote(state.notes, note);

  if (note.text) await db.putNote(note);
  else await db.delNote(note.id);

  render(true);
}

function machineChip(ex) {
  const a = state.active;
  const lift = state.boot.exercises.find((x) => x.id === ex.exerciseId);
  if (!a.gymId || !tracksMachine(lift ?? { name: ex.name })) return '';

  const machine = a.machines?.[ex.dayExerciseId];
  return `<button class="btn btn-sm btn-block ${machine ? '' : 'btn-ask'} mb-2.5"
      data-act="machine">
      ${machine ? `Machine · ${esc(machine)} — change` : 'Which machine? — tap to set'}
    </button>`;
}

function viewSessionOverview() {
  const a = state.active;
  const exercises = a.plan.exercises;
  const groups = groupsOf(exercises);

  const done = a.sets.length;
  const planned = exercises.reduce((n, e) => n + (a.ex[e.dayExerciseId]?.logged.length ?? 0), 0);
  const volume = Math.round(totalVolume(a.sets));

  const rows = exercises
    .map((e, i) => {
      const st = a.ex[e.dayExerciseId];
      const logged = st.logged.filter(Boolean).length;
      const total = st.logged.length;
      const finished = logged >= total;
      const group = groupAt(exercises, i);
      const lift = state.boot.exercises.find((x) => x.id === e.exerciseId);
      const extra = qualifier(lift ?? {});

      const sets = st.logged
        .map((s, n) => (s
          // Through `describeLoad`, like every other place a logged weight is
          // shown. This printed the raw total, so the same set read `70×12`
          // here and `35 ea × 12` one tap away.
          ? `<span class="ov-set done">${esc(describeLoad(s, lift, unit()))}×${s.reps}</span>`
          : `<span class="ov-set">${n + 1}</span>`))
        .join('');

      return `<button class="ov-row ${finished ? 'done' : ''} ${i === a.exIndex ? 'current' : ''} ${group ? 'grouped' : ''}"
          data-act="ov-open" data-i="${i}">
          ${group ? `<span class="ov-badge">${positionIn(group, i)}</span>` : ''}
          ${exerciseFigure(lift ?? e)}
          <div class="grow min-w-0">
            <div class="row gap-1.5">
              <b class="t text-lg truncate">${esc(e.name)}</b>
              <span class="num text-sm muted">${logged}/${total}</span>
            </div>
            ${extra ? `<div class="tiny muted">${esc(extra)}</div>` : ''}
            <div class="ov-sets">${sets}</div>
          </div>
          ${finished
            ? '<span class="ov-tick" aria-hidden="true"></span>'
            : '<span class="chev" aria-hidden="true"></span>'}
        </button>`;
    })
    .join('');

  // One button per bundle, naming its members, because with three or more on
  // screen "Unbundle" alone would not say which round it breaks.
  const groupNotes = groups
    .map((g) => `<button class="btn btn-sm" data-act="ov-unpair" data-ss="${esc(g.id)}">
        Unbundle ${g.indices.map((i) => esc(exercises[i].name.split(' ').slice(-1)[0])).join(' + ')}
      </button>`)
    .join('');

  return `
    <div class="row-between">
      <button class="btn btn-sm btn-ghost" data-act="home">‹ Back</button>
      <span class="pill">${done} of ${planned} sets</span>
      <button class="btn btn-sm btn-ghost" data-act="finish">Finish</button>
    </div>

    <h1 class="mt-2.5">${esc(a.dayName)}</h1>
    <p class="sub">${volume.toLocaleString()} lb so far · tap any lift to log it</p>
    ${a.gymName
      ? `<div class="ov-gym tiny muted">at <b>${esc(a.gymName)}</b></div>`
      : ''}

    ${rows}

    <div class="row wrap gap-2 mt-3">
      ${recordsField(detailLevel(), 'superset')
        // "Pair two lifts" is the line that made a feature with no limit read as
        // a feature limited to two. The sheet behind it always accepted more.
        ? '<button class="btn btn-sm grow" data-act="ov-pair">Bundle lifts</button>'
        : ''}
      <button class="btn btn-sm grow" data-act="session-add">+ Add a lift</button>
    </div>
    ${groupNotes ? `<div class="row wrap gap-2 mt-2">${groupNotes}</div>` : ''}`;
}

/**
 * How much detail to ask for, resolved once per render.
 *
 * A function rather than a value because `state.account` and `state.settings`
 * both change under it — a sync can land mid-session — and a stale copy would
 * leave the screen asking for a field the level no longer records.
 */
function detailLevel() {
  return levelOf(state.account, state.settings);
}

/**
 * The logging screen, ordered like a form rather than like a document.
 *
 * It used to read top to bottom as: name, four prompts, what you did last
 * time, the warmups, the prescription — and *then* the control you came to
 * press. Measured on an iPhone 14 against a 664px fold, LOG SET sat **370px
 * below it** at the default detail level and 532px below it at `full`. So
 * arriving on a lift meant scrolling the better part of a screen, mid-set,
 * one-handed, before anything could be recorded. `render()` repaints `#view`
 * wholesale and never scrolls, so that happened on every single lift.
 *
 * The steppers and LOG SET come first now; everything else is reference
 * material and sits underneath. Nothing was removed — the set rows are a
 * progress indicator rather than an instruction, and the logger card already
 * restates the target range, so moving them below the fold costs nothing that
 * was being read at the moment of logging.
 */
function viewSession() {
  const a = state.active;
  if (!a) return viewHome();
  if (a.view !== 'exercise') return viewSessionOverview();

  const ex = currentExercise();
  const st = a.ex[ex.dayExerciseId];
  const idx = currentSetIndex(st);
  const complete = idx >= st.logged.length;
  const total = a.plan.exercises.length;

  const topWeight = st.weights[0];
  const pres = buildPrescription({ scheme: ex.scheme, topWeight, equipment: ex.equipment });

  // The library row, not the plan slot: a plan entry does not carry `entry`, and
  // reading the unit off it is how a swapped-in dumbbell lift asked for the pair.
  const warmupLift = liftFor(ex);

  const warmups = pres.warmups
    .map(
      (w, i) => `<div class="warmup">
        <span class="pill">W${i + 1}</span>
        <span class="grow mono"><b>${esc(describeLoadWithUnit({ weight: w.weight }, warmupLift, unit()))}</b> × ${esc(w.reps)}</span>
        <span class="tiny">${esc(plateSummary(w.weight, ex.equipment))}</span>
      </div>`,
    )
    .join('');

  const sets = st.slots
    .map((slot, i) => {
      const done = st.logged[i];
      const isCurrent = !complete && i === idx;
      const cls = done ? 'done' : isCurrent ? 'current' : '';
      const weight = st.weights[i];
      const lift = state.boot.exercises.find((x) => x.id === ex.exerciseId);
      const right = done
        ? `<b class="mono">${esc(describeLoad(done, lift, unit()))} × ${done.reps}</b>`
        : `<span class="muted mono">${esc(describeLoadWithUnit({ weight }, lift, unit()))} · ${slot.repMin}–${slot.repMax}</span>`;
      const logged = done ? a.sets.find((s) => s.exerciseId === ex.exerciseId && s.setIndex === i + 1) : null;
      const felt = logged ? feelOf(logged) : null;
      const face = felt ? FEEL_SCALE.find((f) => f.value === felt)?.face : null;

      return `<div class="setrow ${cls}">
        <div class="idx">${done ? '✓' : i + 1}</div>
        <div class="grow">
          <div class="row-between"><span class="tiny muted">${esc(slot.note || 'Working set')}</span>${right}</div>
        </div>
        ${done && recordsField(detailLevel(), 'feel')
          ? `<button class="setrow-feel ${felt ? 'set' : ''}" data-act="feel" data-i="${i}"
              aria-label="${felt ? `Felt ${esc(FEEL_SCALE.find((f) => f.value === felt).label)}` : 'Say how this set felt'}">${face ?? '·'}</button>`
          : ''}
        ${st.slots.length > 1
          ? `<button class="setrow-x" data-act="del-set" data-i="${i}" aria-label="Remove set ${i + 1}">×</button>`
          : ''}
      </div>`;
    })
    .join('');

  /**
   * "Last time", scoped to the machine in front of you.
   *
   * `ex.lastSets` is whatever the plan was built with, which is the most recent
   * session on this lift *anywhere, on anything*. For a lift on a stack that is
   * the wrong number: 180 on a Hammer Strength is not 180 on a Cybex, and
   * neither is 180 at the other gym.
   *
   * The fallback still shows a number when the exact match does not exist —
   * refusing to would be a regression, and something beats nothing when you are
   * standing at a machine deciding what to load. What changed is that the line
   * now says *where* the number was earned when it was not earned here.
   */
  const recalled = recallFor(ex);
  const recalledSets = recalled?.session.sets ?? ex.lastSets ?? [];

  const lastLine = recalledSets.length
    // The line that made the complaint. It sat directly above a stepper reading
    // `35` and said `70×12` — the same set, two units, nothing saying which.
    ? recalledSets.map((s) => `${describeLoad(s, liftFor(ex), unit())}×${s.reps}`).join('  ·  ')
    : 'first time on this lift';

  const recalledWhere = recallScopeLabel(recalled, ex);

  /**
   * A number for the first time on a lift, where it is actually needed.
   *
   * Standing at a machine with nothing logged, the coach line has always read
   * "First time on this lift — pick a top weight and take it to failure", which
   * is honest and is also the one moment the app has an answer and was not
   * giving it. The population estimate belongs here more than it belongs on an
   * onboarding screen somebody saw once: this is the minute they need it.
   *
   * Only when there is a number, and only when nothing has been logged. The
   * refusals have their own wording on the plan screen, where there is room to
   * explain them, and repeating "find it in a set" next to a line that already
   * says to find it in a set is prose for its own sake.
   */
  const estimate = (() => {
    if (ex.suggestion?.action !== 'no-history' || !normsKnows()) return null;

    const slot = ex.scheme?.working?.[0] ?? {};
    const suggestion = suggestedStartingWeight(liftFor(ex), {
      ...normsPerson(),
      targetReps: Number(slot.repMin) || 8,
      // The cautious end of the person's own range, for the same reason
      // `startingWeights` uses it: landing three reps short costs a set,
      // landing short of nothing costs the lift.
      rir: Math.max(...Object.values(rirTargetFor(state.settings.experience))),
    });

    return suggestion.weight === null ? null : suggestion;
  })();

  const body = complete
    ? `<button class="btn btn-primary btn-block btn-lg" data-act="next-ex">
         ${a.exIndex + 1 < total ? 'Next exercise ›' : 'Finish workout'}
       </button>`
    : renderLogger(ex, st, idx);

  const restRemaining = a.restEndsAt ? (a.restEndsAt - Date.now()) / 1000 : 0;
  const timer =
    a.restEndsAt && restRemaining > -30
      ? `<div class="timer" id="rest-timer">
           <div class="t" id="rest-t">${mmss(Math.max(0, restRemaining))}</div>
           <div class="grow tiny muted">${restRemaining > 0 ? 'Rest' : 'Ready — go'}</div>
           <button class="btn btn-sm" data-act="rest-add">+30s</button>
           <button class="btn btn-sm" data-act="rest-skip">Skip</button>
         </div>`
      : '';

  return `
    <div class="row-between">
      <button class="btn btn-sm btn-ghost" data-act="ov-show">‹ All lifts</button>
      <span class="pill">${a.sets.length} sets logged</span>
      <button class="btn btn-sm btn-ghost" data-act="finish">Finish</button>
    </div>

    <div class="row mt-2.5 gap-2.5">
      ${exerciseFigure(liftFor(ex) ?? ex)}
      <h1 class="m-0 grow min-w-0">${esc(ex.name)}</h1>
      ${demoButton(ex.exerciseId)}
    </div>
    <p class="sub">
      ${esc(a.dayName)}${a.gymName ? ` · ${esc(a.gymName)}` : ''} · exercise ${a.exIndex + 1} of ${total}<br>
      <span class="tiny">${esc(describeScheme(ex.scheme))}</span>
    </p>

    ${body}
    ${timer}

    <div class="card">
      <div class="row-between mb-2">
        <span class="tiny muted">Last time${recalledWhere ? ` <span class="pill pill-warn">${esc(recalledWhere)}</span>` : ''}</span>
        <span class="tiny mono">${esc(lastLine)}</span>
      </div>
      <div class="row-between">
        <span class="tiny muted">Coach</span>
        <span class="tiny text-right max-w-[78%]">${esc(ex.suggestion.reason)}</span>
      </div>
      ${estimate ? `<div class="row-between mt-2 norm-hint">
        <span class="tiny muted">Average for you</span>
        <span class="tiny text-right max-w-[78%] mono">${esc(formatWeight(estimate.weight, unit()))}${
          estimate.belowBar ? ' · the empty bar' : ''}</span>
      </div>
      <div class="tiny muted mt-1">${esc(estimate.says)}</div>` : ''}
    </div>

    ${advancedGroup(ex)}

    ${warmups ? `<h2>Warmup <span class="tiny muted">· not logged</span></h2>${warmups}` : ''}

    <h2>Working sets</h2>
    ${sets}
    <button class="btn btn-sm btn-block mb-2.5" data-act="add-set">+ Add a set</button>

    <div class="row mt-3 gap-2">
      <button class="btn btn-sm grow" data-act="prev-ex" ${a.exIndex === 0 ? 'disabled' : ''}>‹ Previous</button>
      <button class="btn btn-sm grow" data-act="pick-ex">Jump to…</button>
      <button class="btn btn-sm grow" data-act="next-ex" ${a.exIndex + 1 >= total ? 'disabled' : ''}>Next ›</button>
    </div>

    <div class="row mt-2 gap-2">
      <button class="btn btn-sm grow" data-act="session-swap">Swap this lift</button>
      <button class="btn btn-sm grow" data-act="session-add">+ Add a lift</button>
    </div>`;
}

/** Is this a lift that can legitimately be done with nothing added? */
function bodyweightLift(ex) {
  return allowsZeroLoad(state.boot.exercises.find((x) => x.id === ex.exerciseId));
}

function renderLogger(ex, st, idx) {
  const weight = st.weights[idx];
  const slot = st.slots[idx];
  const reps = st.repDraft ?? defaultReps(withRecall(ex), st, idx);

  /**
   * A pair of dumbbells steps by what the rack holds, which is per bell.
   *
   * Five pounds on each hand is ten on the total, and stepping the total by five
   * would ask for a 2.5 lb jump per hand that no rack can make.
   *
   * `lift`, not `unit`: this local was named `unit` while meaning "the exercise",
   * which shadowed the accessor that says which unit the screen is in. Two
   * different things with one name is how the old single column became
   * unreadable, and here it would have been a runtime error.
   */
  const lift = liftFor(ex);
  const hands = handsOf(lift);
  const u = unit();
  /**
   * One tap is one notch of whatever the gym's smallest increment is.
   *
   * `smallestStep` reads the unit off the equipment, so this comes back in the
   * **gym's** unit — 2.5 on a metric stack, 5 on a pound one. The stored weight
   * is canonical pounds, so it is converted before being added: without that,
   * a kilo screen moved 2.27 kg a tap and every value it reached was a load no
   * kg machine can make.
   *
   * `5 * hands` for a stack is per *bell*: five pounds on each hand is ten on
   * the total, and stepping the total by five would ask the rack for a 2.5 lb
   * jump per hand that no rack can make.
   */
  const stepShown = ex.equipment.barType === 'stack'
    ? smallestStep(ex.equipment) * hands
    : smallestStep(ex.equipment);
  const step = Math.round((fromUnit(stepShown, u) ?? stepShown) * 100) / 100;

  /**
   * One tap for the commonest case there is.
   *
   * Under reverse pyramid the usual answer is *what you did last time, or one
   * notch off it* — and v69 already computes that number, scoped to this gym
   * and this machine, and already prints it two lines above as "Last time". So
   * the user was reading the answer off the screen and then driving two
   * steppers to re-enter it.
   *
   * The chip is labelled with the **values**, never the word "repeat". That is
   * the same rule the collapsed Advanced row follows: what a control hides must
   * never be its own state, and a button that says "repeat" makes you tap it to
   * find out what it would do.
   *
   * It pre-fills rather than logging. Logging is the one action in this app
   * that is a nuisance to undo, and removing the glance before it to save a tap
   * is the wrong trade — the steppers are still there for the notch-off case,
   * which is the other half of "the same, or one notch".
   */
  const sameAsLast = (() => {
    const previous = recallFor(ex)?.session.sets?.find((s) => s.setIndex === idx + 1);
    // `numericValue`, which is how `numeric` is imported here. A bodyweight
    // lift legitimately logs zero, so the weight is only required to be a
    // number — `reps` is what decides whether the set happened at all.
    if (!previous?.reps || numericValue(previous.weight) === null) return '';

    const shown = describeLoad(previous, liftFor(ex), u);
    return `<button class="btn btn-sm btn-block repeat mb-2.5"
        data-act="repeat-set" data-w="${esc(String(previous.weight))}" data-r="${esc(String(previous.reps))}">
        ${esc(shown)} × ${previous.reps}
      </button>`;
  })();

  return `
    <div class="card border-accent">
      <div class="row-between mb-2.5">
        <b>Set ${idx + 1}</b>
        <span class="tiny muted">target ${slot.repMin}–${slot.repMax} · ${esc(slot.note || '')}</span>
      </div>
      ${sameAsLast}

      <div class="stepper mb-2.5">
        <button class="step" data-act="w-down" data-step="${step}">−</button>
        <button class="value" data-act="open-weight">
          <b>${bodyweightLift(ex) && !(weight > 0)
            ? 'BW'
            : fmtWeight(hands > 1 ? (numericValue(weight) ?? 0) / hands : weight)}</b>
          <small>${bodyweightLift(ex) && !(weight > 0)
            ? 'bodyweight · tap to add load'
            : hands > 1
              // The number on the bell and the total it adds up to, as a
              // sentence rather than as two bare figures. Each on its own is
              // wrong in a different way — the total is unrecognisable in front
              // of the rack, and the per-hand figure is not comparable to
              // anything else in the log — and "35 · 70 total" made the reader
              // work out which was which.
              ? `${u} on each bell · ${fmtWeight(weight)} ${u} moved`
              : `${u} · ${esc(plateSummary(weight, ex.equipment)) || 'tap to edit'}`}</small>
        </button>
        <button class="step" data-act="w-up" data-step="${step}">+</button>
      </div>

      <div class="stepper mb-3">
        <button class="step" data-act="r-down">−</button>
        <button class="value" data-act="open-reps"><b>${reps}</b><small>reps</small></button>
        <button class="step" data-act="r-up">+</button>
      </div>

      <button class="btn btn-primary btn-block btn-lg" data-act="log-set">LOG SET</button>
      ${idx > 0 ? '<button class="btn btn-block btn-ghost btn-sm mt-2" data-act="undo">Undo last set</button>' : ''}
    </div>`;
}

/* ------------------------------- history -------------------------------- */

/**
 * History as a month grid.
 *
 * A flat list answers "what did I do" but buries "when", and it grows without
 * bound. A calendar answers both at a glance and keeps the detail one tap away.
 */
function viewHistory() {
  const byDay = sessionsByDay(state.sessions);

  // Follow the data until the user takes over. Latching this on the first
  // render pinned the calendar to today's month before synced workouts had
  // arrived, so a phone that had not synced yet opened on an empty month and
  // read as "nothing logged" with a month of training one tap away.
  if (!state.calPinned) state.calMonth = latestMonth(state.sessions, new Date());
  const { year, month } = state.calMonth;

  const cells = monthGrid(year, month, byDay);

  const head = `<div class="cal-head">
      <button data-act="cal-prev" aria-label="Previous month"><span class="chev chev-back" aria-hidden="true"></span></button>
      <div class="cal-title">${MONTH_NAMES[month]} ${year}</div>
      <button data-act="cal-next" aria-label="Next month"><span class="chev" aria-hidden="true"></span></button>
    </div>`;

  const grid = `<div class="calendar">
      <div class="cal-grid">
        ${WEEKDAY_INITIALS.map((d) => `<div class="cal-dow">${d}</div>`).join('')}
        ${cells
          .map((c) => {
            const classes = [
              'cal-day',
              c.inMonth ? '' : 'outside',
              c.trained ? 'trained' : '',
              c.trained && state.openDay === c.date ? 'open' : '',
            ].filter(Boolean).join(' ');
            const names = c.sessions.map((x) => x.dayName).filter(Boolean);
            return `<button class="${classes}" data-date="${c.date}" ${c.trained ? 'data-act="cal-day"' : ''}
              ${names.length ? `aria-label="${esc(c.day)} — ${esc(names.join(', '))}"` : ''}>
              ${c.day}${names.length
                ? `<span class="cal-tag">${esc(initialsOf(names[0]))}</span>`
                : c.trained ? '<span class="dot"></span>' : ''}
            </button>`;
          })
          .join('')}
      </div>
    </div>`;

  const detail = state.openDay ? renderDayDetail(byDay.get(state.openDay) ?? []) : '';

  // With nothing local yet and a fetch in flight, "nothing logged" would be a
  // lie — the workouts may be on their way down.
  let footer = '';
  if (!state.sessions.length) {
    footer = state.syncing
      ? `<div class="loading"><div class="spinner"></div><div class="tiny">Fetching your workouts…</div></div>`
      : `<div class="empty">Nothing logged yet.<br>Finish a workout, or paste one in from Setup, and the days fill in here.</div>`;
  }

  const count = state.sessions.length;
  const subtitle = count
    ? `${count} workout${count === 1 ? '' : 's'} logged. Tap a marked day.`
    : 'Tap a marked day to see what you did.';

  return `<h1>History</h1>
    <p class="sub">${esc(subtitle)}</p>
    ${head}${grid}${detail}${footer}`;
}

/**
 * How long a session took, and a way to correct it.
 *
 * The finish tap is only when he remembered — once, two hours after driving
 * home. The burn already caps itself at the last logged set, but the recorded
 * length is still wrong on the screen and still his to fix, so it is shown with
 * the gap named rather than quietly adjusted behind his back.
 */
function sessionLengthRow(session) {
  const start = Date.parse(session?.startedAt ?? '');
  const finish = Date.parse(session?.finishedAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return '';

  const mins = Math.round((finish - start) / 60000);
  const lastSet = Math.max(
    ...(session.sets ?? []).map((s) => Date.parse(s?.loggedAt ?? '')).filter(Number.isFinite),
    -Infinity,
  );

  const workMins = Number.isFinite(lastSet) ? Math.round((lastSet - start) / 60000) : null;
  const stale = workMins !== null && mins - workMins > 15;

  return `<div class="row-between px-0 py-1.5 border-t border-line">
      <div class="grow min-w-0">
        <span class="tiny muted">${mins} min recorded${stale ? `, last set at ${workMins} min` : ''}</span>
        ${stale
          ? `<div class="tiny text-warn mt-0.5">
               Finish was tapped ${mins - workMins} min after the last set — the burn counts
               up to the last set, not the tap.
             </div>`
          : ''}
      </div>
      <button class="btn btn-sm btn-ghost" data-act="fix-length" data-id="${esc(session.id)}">Fix</button>
    </div>`;
}

/** Correct a session's length, in minutes from when it started. */
function openLengthSheet(sessionId) {
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return;

  const start = Date.parse(session.startedAt);
  const mins = Math.round((Date.parse(session.finishedAt ?? '') - start) / 60000);
  const lastSet = Math.max(
    ...(session.sets ?? []).map((s) => Date.parse(s?.loggedAt ?? '')).filter(Number.isFinite),
    -Infinity,
  );
  const suggested = Number.isFinite(lastSet) ? Math.round((lastSet - start) / 60000) + 5 : mins;

  openSheet(
    `<h2 class="mt-0">How long was it?</h2>
     <div class="tiny muted mb-3">
       ${esc(session.dayName ?? 'Workout')}, ${esc(fmtDate(session.startedAt))}.
       Recorded as ${mins} minutes${Number.isFinite(lastSet) ? `, with the last set logged at ${Math.round((lastSet - start) / 60000)}` : ''}.
     </div>
     <label class="tiny muted">Minutes</label>
     <input class="input mono mx-0 mt-2 mb-3" id="len-mins" inputmode="numeric" value="${suggested}">
     <button class="btn btn-primary btn-block btn-lg" data-len-save="1">Save</button>`,
    async (e) => {
      if (!e.target.closest('[data-len-save]')) return;

      const value = numericValue(document.getElementById('len-mins')?.value);
      if (value === null || value < 1 || value > 600) return toast('Give it a length in minutes');

      session.finishedAt = new Date(start + Math.round(value) * 60000).toISOString();
      session._dirty = true;
      await db.putSession(session);

      closeSheet();
      toast('Length corrected');
      if (state.online) sync({ quiet: true });
      render(true);
    },
  );
}

function renderDayDetail(sessions) {
  return sessions
    .map((session) => {
      const lifts = liftsInSession(session, state.boot.exercises);
      const volume = Math.round(totalVolume(session.sets ?? []));

      const rows = lifts
        .map(
          (lift) => `<button class="detail-lift" data-act="exercise" data-id="${esc(lift.exerciseId)}">
            <div class="grow min-w-0">
              <b class="text-sm">${esc(lift.name)}</b>
              <div class="tiny muted mono mt-1">
                ${lift.sets.map((s) => `${esc(describeLoad(s, liftFor(lift.exerciseId), unit()))}×${s.reps}`).join('   ')}
              </div>
            </div>
            <span class="tiny muted">›</span>
          </button>`,
        )
        .join('');

      return `<div class="day-detail">
        <div class="row-between mb-1.5">
          <b style="font-size:17px">${esc(session.dayName ?? 'Workout')}</b>
          ${session._dirty ? '<span class="pill">on this phone only</span>' : ''}
        </div>
        <div class="tiny muted mb-1.5">
          ${fmtDate(session.startedAt)} · ${(session.sets ?? []).length} sets · ${volume.toLocaleString()} lb volume
        </div>
        ${sessionLengthRow(session)}
        ${rows}
      </div>`;
    })
    .join('');
}

function viewExerciseDetail() {
  const id = state.detailExercise;
  const lift = state.boot.exercises.find((e) => e.id === id) ?? { id, name: id };
  const history = historyFor(id);
  const series = history.map((s) => bestE1RM(s.sets));

  const strength = history.map((s) => ({
    label: fmtDate(s.date),
    value: bestE1RM(s.sets),
    detail: s.sets.map((x) => `${describeLoad(x, lift, unit())}×${x.reps}`).join('  '),
  }));

  const volume = history.map((s) => ({
    label: fmtDate(s.date),
    value: Math.round(totalVolume(s.sets)),
    detail: `${s.sets.length} sets`,
  }));

  const rows = [...history]
    .reverse()
    .map(
      (s) => `<div class="card">
        <div class="row-between mb-1.5">
          <b>${fmtDate(s.date)}</b>
          <span class="pill">e1RM ${Math.round(bestE1RM(s.sets))}</span>
        </div>
        <div class="tiny mono">${s.sets.map((x) => `${esc(describeLoad(x, lift, unit()))}×${x.reps}`).join('   ·   ')}</div>
      </div>`,
    )
    .join('');

  const meta = [
    lift.machine ? `machine ${lift.machine}` : '',
    lift.handle ? `handle ${lift.handle}` : '',
    lift.muscleGroup ?? '',
  ].filter(Boolean).join(' · ');

  return `<button class="btn btn-sm btn-ghost" data-act="history">‹ History</button>
    <h1 class="mt-2">${esc(lift.name)}</h1>
    <p class="sub">
      ${history.length} session${history.length === 1 ? '' : 's'} · best e1RM ${Math.round(Math.max(0, ...series))} lb
      ${meta ? `<br><span class="tiny">${esc(meta)}</span>` : ''}
      ${lift.notes ? `<br><span class="tiny">${esc(lift.notes)}</span>` : ''}
    </p>

    ${demoPanel(lift)}

    <div class="card">
      <div class="row-between mb-1.5">
        <b class="tiny">Estimated 1RM</b>
        ${trendBadge(seriesTrend(strength.map((p) => p.value)))}
      </div>
      <div class="chart-wrap" data-chart="1">${lineChart(inDisplayUnit(strength), { unit: ` ${unit()}`, title: `${lift.name} estimated 1RM over time` })}</div>
    </div>

    <div class="card">
      <div class="tiny mb-1.5"><b>Volume per session</b></div>
      <div class="chart-wrap" data-chart="1">${barChart(inDisplayUnit(volume), { unit: ` ${unit()}`, title: `${lift.name} volume per session` })}</div>
    </div>

    ${rows}`;
}

/**
 * How the lift is done.
 *
 * Off for him and on for a new lifter, which is the one default in this app that
 * differs per person and the right way round: he has trained these movements for
 * years and a demonstration on every screen is a thing to scroll past.
 *
 * **No video ids are shipped.** A specific YouTube id cannot be checked from here
 * for being the right lift, taught well, or still online — and a confidently wrong
 * demonstration is worse than none, because it is the one thing on the screen
 * somebody would copy with a loaded bar. So the default is a search link, which
 * cannot be wrong and cannot rot, and a URL pinned to the lift in the library is
 * embedded from then on. The machinery is here; the judgement about which video is
 * good stays with the person who can actually watch it.
 *
 * The embed is `youtube-nocookie.com` and `loading="lazy"`: nothing is requested
 * until the panel is on screen, so an offline phone shows the link and no error.
 */
function youtubeId(url) {
  const text = String(url ?? '');
  const patterns = [
    /youtu\.be\/([\w-]{11})/,
    /[?&]v=([\w-]{11})/,
    /youtube\.com\/embed\/([\w-]{11})/,
    /youtube\.com\/shorts\/([\w-]{11})/,
  ];
  for (const re of patterns) {
    const found = text.match(re);
    if (found) return found[1];
  }
  return null;
}

/**
 * Is the demonstration wanted on this phone?
 *
 * One place, because the answer comes from two: the account profile when there is
 * one, and the local setting otherwise. Reading them in the wrong order on one
 * screen and the right order on another is how a toggle appears to do nothing.
 */
function wantsDemos() {
  return Boolean(state.account?.profile?.showExerciseVideo ?? state.settings.showExerciseVideo);
}

/**
 * "Show me how", wherever an exercise is actually in front of you.
 *
 * The first version put the demonstration on the exercise *detail* screen only —
 * History, then a day, then a lift. He turned the setting on, saw nothing, and
 * was right to call it broken: a feature three taps down a screen nobody opens
 * mid-workout is a feature that does not exist. **The place you need to know how a
 * lift is done is while you are standing in front of it**, which is the logger.
 *
 * A chip rather than an inline player there. Space is scarce on that screen and
 * logging a set is one tap by founding constraint; an embedded video pushing the
 * set rows down would make the common action worse to improve the rare one. The
 * chip opens a sheet, which is how every other optional thing in this app behaves.
 */
function demoChip(exerciseId) {
  if (!wantsDemos()) return '';
  // The same shape as the machine, tempo and kit chips above it, because a control
  // that looks like a different kind of thing reads as a different kind of thing.
  return `<button class="btn btn-sm btn-block btn-ghost mb-2.5"
      data-act="demo-open" data-id="${esc(exerciseId)}">
      ▶ Show me how to do this
    </button>`;
}

/**
 * The demonstration, as a mark beside the lift's name.
 *
 * `demoChip` spends a 44px full-width row on seventeen characters — "Show me
 * how to do this" — to carry a triangle everybody already reads without being
 * told. Beside the heading it costs no vertical space at all.
 *
 * The label is not deleted, it moves to `aria-label`: a standalone icon needs a
 * text *alternative*, which is not the same thing as a text label. The target
 * is 44px under a 20px mark, which is the bargain every icon control in this
 * app makes.
 */
function demoButton(exerciseId) {
  if (!wantsDemos()) return '';
  return `<button class="icon-btn" data-act="demo-open" data-id="${esc(exerciseId)}"
      aria-label="Show me how to do this">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
        <path d="M8 5v14l11-7z"/>
      </svg>
    </button>`;
}

/**
 * Tempo, kit, machine and the lift note, behind one row.
 *
 * Four full-width buttons of identical shape and weight sat above the thing you
 * came to do, and measured 206px — a third of the screen spent on controls
 * touched once a session or never. `e2e/theme.spec.js` already documents one
 * round of this complaint, about three stacked accent buttons.
 *
 * **The collapsed row carries the values, not just the label.** That is the one
 * rule that makes a disclosure honest here: what is hidden is the *control*,
 * never the state. A machine, once chosen, decides which history a set joins —
 * so it has to stay readable without opening anything, and it reads as a pill
 * on the summary. A group that hides its own state is a group nobody opens,
 * and a machine nobody notices is a set filed against the wrong trend.
 */
function advancedGroup(ex) {
  const a = state.active;

  const controls = [
    machineChip(ex),
    recordsField(detailLevel(), 'tempo') ? tempoChip(ex) : '',
    recordsField(detailLevel(), 'aids') ? aidsChip(ex) : '',
    noteChip(ex),
  ].filter(Boolean).join('');

  if (!controls) return '';

  const tempo = parseTempo(a.tempos?.[ex.dayExerciseId] ?? '');
  const kit = normaliseAids(a.aids?.[ex.dayExerciseId]);
  const note = noteOf(ex);

  const answered = [
    a.machines?.[ex.dayExerciseId],
    tempo ? formatTempo(tempo) : '',
    kit.length ? describeAids(kit) : '',
    note?.text,
  ].filter(Boolean);

  const open = Boolean(state.advOpen);

  return `<button class="btn btn-sm btn-block disclosure mb-2.5" data-act="adv-toggle"
      aria-expanded="${open}">
      <span class="row gap-1.5 wrap grow min-w-0">
        <span>Advanced</span>
        ${answered.map((v) => `<span class="pill">${esc(v)}</span>`).join('')}
      </span>
      <span class="chev" aria-hidden="true"></span>
    </button>
    <div ${open ? '' : 'hidden'}>${controls}</div>`;
}

/**
 * The demonstration, in a sheet.
 *
 * Built fresh each time rather than kept in the markup: an iframe that exists on
 * the logging screen is an iframe loading video while somebody is trying to log a
 * set, and on a gym connection that is the one thing competing for bandwidth.
 */
function openDemoSheet(exerciseId) {
  const lift = state.boot.exercises.find((x) => x.id === exerciseId)
    ?? { id: exerciseId, name: exerciseId };

  const id = youtubeId(lift.videoUrl);
  const query = encodeURIComponent(`how to ${String(lift.name ?? '').trim()} proper form`);

  openSheet(
    `<h2 class="mt-0">${esc(lift.name)}</h2>
     ${id
       ? `<div class="demo-frame mb-3">
            <iframe src="https://www.youtube-nocookie.com/embed/${esc(id)}?rel=0"
              title="${esc(lift.name)} demonstration" allowfullscreen
              referrerpolicy="strict-origin-when-cross-origin"></iframe>
          </div>
          <div class="tiny muted mb-3">
            Not the right movement, or badly taught? Pin a better one — it is yours from
            then on.
          </div>`
       : `<a class="btn btn-block btn-primary" target="_blank" rel="noopener noreferrer"
             href="https://www.youtube.com/results?search_query=${query}">
            Search YouTube for this lift
          </a>
          <div class="tiny muted mx-0 mt-2.5 mb-3">
            No demonstration pinned to this one yet. Find one you like and pin it, and it
            plays here from then on.
          </div>`}
     <button class="btn btn-block" data-demo-pin="1">${id ? 'Pin a different video' : 'Pin a video'}</button>
     <button class="btn btn-block btn-ghost mt-2" data-close="1">Done</button>`,
    (e) => {
      if (!e.target.closest('[data-demo-pin]')) return;
      closeSheet();
      // A beat, so the first sheet is gone before the second opens — two stacked
      // sheets lost an answer once already.
      setTimeout(() => openDemoPrompt(lift), 60);
    },
  );
}

/** Ask for a URL, validate it, keep it. */
function openDemoPrompt(lift) {
  openTextSheet({
    title: `A demonstration of ${lift.name}`,
    label: 'Paste a YouTube link',
    value: lift.videoUrl ?? '',
    placeholder: 'https://www.youtube.com/watch?v=…',
    onSave: async (url) => {
      if (!youtubeId(url)) return toast('That does not look like a YouTube link');
      await updateBoot(upsertExerciseIn(state.boot, { ...lift, videoUrl: url.trim() }));
      render();
      toast('Pinned');
    },
  });
}

function demoPanel(lift) {
  if (!wantsDemos()) return '';

  const id = youtubeId(lift?.videoUrl);
  const query = encodeURIComponent(`how to ${String(lift?.name ?? '').trim()} proper form`);

  return `<div class="card">
    <div class="row-between mb-2">
      <b class="tiny">How it is done</b>
      <button class="btn btn-sm btn-ghost" data-act="demo-set" data-id="${esc(lift.id)}">
        ${id ? 'Change' : 'Pin a video'}
      </button>
    </div>

    ${id
      ? `<div class="demo-frame">
           <iframe src="https://www.youtube-nocookie.com/embed/${esc(id)}?rel=0"
             title="${esc(lift.name)} demonstration" loading="lazy" allowfullscreen
             referrerpolicy="strict-origin-when-cross-origin"></iframe>
         </div>`
      : `<a class="btn btn-block" target="_blank" rel="noopener noreferrer"
            href="https://www.youtube.com/results?search_query=${query}">
           Find a demonstration
         </a>
         <div class="tiny muted mt-2">
           A search rather than a fixed video, because a wrong demonstration is worse than
           none. Once you find one you like, pin it and it plays here from then on.
         </div>`}
  </div>`;
}

function sparkline(values) {
  if (!values || values.length < 2) return '<div class="tiny muted">Not enough sessions to chart yet.</div>';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${43 - ((v - min) / span) * 36}`)
    .join(' ');
  const rising = values[values.length - 1] >= values[0];
  return `<svg class="spark" viewBox="0 0 100 46" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="${rising ? 'var(--good)' : 'var(--bad)'}"
      stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

/* -------------------------------- coach --------------------------------- */

/**
 * Did this lift change machines since last time?
 *
 * Shown next to the verdict rather than folded into it, because the verdict is
 * about the numbers and this is about whether the numbers are comparable at
 * all. Only appears when both sessions actually recorded a machine.
 */
/**
 * Whether the load is real, and what to change.
 *
 * Sits under the verdict rather than replacing it: the verdict says which way
 * the lift is going, this says whether the weight on it is being earned. They
 * disagree often — a lift can gain weight every week and be going nowhere.
 */
function diagnosisNote(exerciseId) {
  const history = historyFor(exerciseId);
  const slot = (state.boot.days ?? [])
    .flatMap((d) => d.exercises ?? [])
    .find((e) => e.exerciseId === exerciseId);

  const scheme = slot?.customScheme ?? state.boot.schemes?.[slot?.schemeId ?? 'rp-2'] ?? null;
  const equipment = slot?.equipment ?? {};

  const ego = egoCheck({ history, scheme, exerciseId });
  const advice = loadAdvice({ history, scheme, exerciseId, equipment });
  const parts = [];

  if (ego.flagged) {
    parts.push(`<div class="tiny mt-2 text-bad">
      <b>The load is outrunning the strength.</b> ${esc(ego.message)}
      ${ego.reasons.map((r) => `<div class="mt-1">· ${esc(r)}</div>`).join('')}
    </div>`);
  }

  if (advice.action === 'lighter' || advice.action === 'change-stimulus') {
    const label = advice.action === 'lighter' ? 'Go lighter' : 'Change the stimulus';
    parts.push(`<div class="tiny mt-2 text-warn">
      <b>${label}${advice.suggestedWeight ? ` — try ${esc(formatWeight(advice.suggestedWeight, unit()))}` : ''}.</b>
      ${esc(advice.reason)}
    </div>`);
  }

  const kit = aidsChanged(historyFor(exerciseId), exerciseId);
  if (kit.changed) {
    const what = kit.added.length ? `added ${esc(describeAids(kit.added))}` : `stopped using ${esc(describeAids(kit.removed))}`;
    parts.push(`<div class="tiny mt-2 text-warn">
      You ${what} since last time. The load is not directly comparable across that —
      straps and a belt change what the set asks of you.
    </div>`);
  }

  const drift = tempoDrift(state.sessions, exerciseId);
  if (drift.drifting && !ego.flagged) {
    parts.push(`<div class="tiny mt-2 text-warn">
      The negative has shortened from ${drift.from}s to ${drift.to}s. The same weight moved
      faster is not the same set — worth checking that is deliberate.
    </div>`);
  }

  return parts.join('');
}

function machineNote(exerciseId) {
  const change = machineChanged(state.sessions, exerciseId);
  if (!change.changed) return '';

  // Two different sentences, because "Technogym → Technogym" reads as a bug
  // rather than as a warning. When the gym moved, the building is the reason.
  return `<div class="tiny mt-2 text-warn">
    ${change.gymChanged
      ? `Different gym last time, so a different ${esc(change.to)} — same name, different stack.`
      : `Different machine last time: ${esc(change.from)} → ${esc(change.to)}.`}
    The loads are not directly comparable, so read this verdict with that in mind.
  </div>`;
}

/**
 * What the program suggests, and what it changed when you said yes.
 *
 * Top of the Coach tab. Suggestions are tappable — nothing happens until one is
 * answered, which is the whole shape of this feature after the first version got it
 * wrong by applying changes and offering an undo.
 *
 * The satisfaction figures are shown back. Partly because a number somebody is
 * asked for and never sees again feels like a survey, and partly because the trend
 * in them is genuinely interesting: a split rated 2 out of 5 for a month is a thing
 * worth noticing before the lifts start to say it.
 */
function renderAdaptation() {
  const pending = state.adapt?.pending ?? [];
  const applied = state.adapt?.applied ?? [];
  const decisions = state.adapt?.decisions ?? [];

  const recent = applied.filter((a) => {
    const at = Date.parse(a.appliedAt);
    return Number.isFinite(at) && Date.now() - at < 30 * 86400000;
  });

  if (!pending.length && !recent.length && !decisions.length) return '';

  const kindLabel = {
    swap: 'Swap the movement', deload: 'Step the weight back',
    'add-set': 'Add a working set', 'remove-set': 'Drop a working set',
  };
  const doneLabel = {
    swap: 'Movement swapped', deload: 'Weight stepped back',
    'add-set': 'A set added', 'remove-set': 'A set removed',
  };

  const suggestions = pending.map((p) => `<button class="card w-full text-left mb-2 border-accent"
      data-act="adapt-open" data-id="${esc(p.id)}">
      <div class="row-between mb-1.5">
        <b class="text-sm">${esc(p.name)}</b>
        <span class="pill pill-warn">${esc(kindLabel[p.kind] ?? p.kind)}</span>
      </div>
      <div class="tiny muted mb-2">${esc(p.reason)}</div>
      <div class="tiny text-accent">Tap to decide ›</div>
    </button>`).join('');

  const appliedRows = recent.map((a) => `<div class="card mb-2">
      <div class="row-between mb-1.5">
        <b class="text-sm">${esc(doneLabel[a.kind] ?? 'Changed')}</b>
        <span class="tiny mono muted">${esc(daysAgo(a.appliedAt))}</span>
      </div>
      <div class="tiny mb-2">
        ${a.kind === 'swap' && a.before
          ? `<b>${esc(a.before.name)}</b> → <b>${esc(state.boot.exercises.find((e) => e.id === a.apply.exerciseId)?.name ?? a.apply.exerciseId)}</b>`
          : `<b>${esc(a.name ?? a.before?.name ?? '')}</b>`}
      </div>
      ${a.before ? `<button class="btn btn-sm btn-block btn-ghost" data-act="adapt-undo" data-id="${esc(a.id)}">
          Put it back
        </button>` : ''}
    </div>`).join('');

  const feedback = feedbackSummary(decisions);
  const scales = feedback && (feedback.splitSatisfaction !== null || feedback.suggestionRating !== null)
    ? `<div class="card">
         ${feedback.splitSatisfaction !== null ? `<div class="row-between">
             <span class="tiny muted">How you rate your split</span>
             <span class="tiny mono">${feedback.splitSatisfaction} / 5</span>
           </div>` : ''}
         ${feedback.suggestionRating !== null ? `<div class="row-between mt-1.5">
             <span class="tiny muted">How you rate these suggestions</span>
             <span class="tiny mono">${feedback.suggestionRating} / 5</span>
           </div>` : ''}
         <div class="row-between mt-1.5">
           <span class="tiny muted">Taken up</span>
           <span class="tiny mono">${feedback.accepted} of ${feedback.considered}</span>
         </div>
       </div>`
    : '';

  return `<h2>Your program</h2>
    ${pending.length
      ? `<div class="tiny muted mb-2">
           ${pending.length === 1 ? 'One suggestion' : `${pending.length} suggestions`} from your last few
           sessions. Nothing changes unless you say so.
         </div>
         ${suggestions}`
      : ''}
    ${appliedRows}
    ${scales}`;
}

/**
 * Turning up, where, and for how long.
 *
 * The four questions nothing in the app answered. Everything else on the Coach
 * tab is about whether the lifts are moving; none of it notices that somebody
 * trained twice in three weeks, which is the thing that actually decides whether
 * any of the rest means anything.
 *
 * Each figure carries its own sample size, because the real data makes every one
 * of these a partial reading: one session is a forgotten *Finish* at 400
 * minutes, and only 11 of 35 have a gym on them. A number with no visible
 * provenance is a number nobody can check.
 */
function renderHabits() {
  const sessions = state.sessions ?? [];
  if (!sessions.length) return '';

  const weeks = consistency(sessions, { weeks: 12 });
  const duration = durationStats(sessions);
  const gyms = gymFrequency(sessions, Object.fromEntries(gymsList().map((g) => [g.id, g.name])));
  const perWeek = periodCompare(weeks.map((w) => w.sessions), { size: 4 });
  const band = typicalRange(weeks.filter((w) => w.sessions > 0).map((w) => w.sessions));

  /**
   * The sentence, built the way a verdict should be: the figure, then the
   * comparison *with its own baseline stated*, then nothing else. The loudest
   * complaint about this kind of prose elsewhere is that it restates the number
   * you can already read — so if there is no comparison to make, there is no
   * sentence.
   */
  const headline = perWeek.comparable && perWeek.percent !== null
    ? `${perWeek.current} session${perWeek.current === 1 ? '' : 's'} in the last four weeks, against ${perWeek.previous} in the four before — ${perWeek.percent > 0 ? 'up' : 'down'} ${Math.abs(perWeek.percent)}%.`
    : `${perWeek.current} session${perWeek.current === 1 ? '' : 's'} in the last four weeks. Four more weeks and this can be compared against something.`;

  const bars = `<div class="habit-weeks" role="img"
      aria-label="Sessions per week over the last twelve weeks: ${weeks.map((w) => w.sessions).join(', ')}">
      ${weeks.map((w) => {
        const tall = Math.min(100, w.sessions * 25);
        return `<span class="habit-bar ${w.sessions ? '' : 'empty'}" style="--h:${tall}%"
            title="${esc(w.weekStart)}: ${w.sessions}"></span>`;
      }).join('')}
    </div>`;

  return `<h2>Turning up</h2>
    <div class="card">
      <div class="text-sm mb-2.5">${esc(headline)}</div>
      ${bars}
      <div class="row-between tiny muted mt-1.5">
        <span>12 weeks ago</span><span>this week</span>
      </div>
      ${band.low !== null
        ? `<div class="tiny muted mt-2.5">
             A normal week for you is ${band.low}–${band.high} sessions. Measured over the
             ${band.readings} weeks you trained at all, so a week off is not counted against it.
           </div>`
        : `<div class="tiny muted mt-2.5">
             Four trained weeks and this can say what a normal week looks like for you.
           </div>`}
    </div>

    <h2>How long it takes</h2>
    <div class="card">
      ${duration.median !== null
        ? `<div class="row-between">
             <span class="tiny muted">Typical session</span>
             <span class="tiny mono">${duration.median} min</span>
           </div>
           <div class="row-between mt-1.5">
             <span class="tiny muted">Shortest and longest</span>
             <span class="tiny mono">${duration.shortest}–${duration.longest} min</span>
           </div>`
        : '<div class="tiny muted">No finished session yet to measure.</div>'}
      ${duration.ignored
        ? `<div class="tiny muted mt-2.5">
             ${duration.ignored} session${duration.ignored === 1 ? '' : 's'} left out — either still
             open or longer than ${MAX_SESSION_MINUTES} minutes, which means <b>Finish</b> was never
             tapped. Nothing was changed; they are just not counted here.
           </div>`
        : ''}
    </div>

    ${gyms.length > 1 || (gyms[0] && gyms[0].gymId)
      ? `<h2>Where you train</h2>
         <div class="card">
           ${gyms.map((g) => `<div class="row-between px-0 py-1.5">
               <span class="tiny ${g.gymId ? '' : 'muted'}">${esc(g.name)}</span>
               <span class="tiny mono">${g.sessions}</span>
             </div>`).join('')}
         </div>`
      : ''}`;
}

/**
 * What the verdicts above could not look at.
 *
 * The hazard of the detail level, and the only reason the level needed a module
 * rather than an `if`. `tempoDrift` and `aidsChanged` both refuse to fire unless
 * *both* compared sessions recorded the field — the right guard, and it means a
 * basic-level user never gets a wrong warning. They get **no** warning, and
 * silence from this app means "nothing is wrong".
 *
 * Two things this app has already shipped are exactly that failure: the written
 * coach went two months without being told about sleep because of a key spelled
 * two ways, and `clientSummary` sat unreferenced for a release. Both looked
 * fine. So a quieter screen states its own blind spots rather than inheriting
 * the confidence of a full one.
 */
function renderUnchecked() {
  const missed = uncheckedBy(detailLevel());
  if (!missed.length) return '';

  return `<div class="card unchecked">
      <b class="tiny">What these verdicts could not check</b>
      <div class="tiny muted mt-1.5">
        You are logging just the lift, so these are not being written down. Nothing
        above is wrong — it is narrower than it looks.
      </div>
      ${missed.map((m) => `<div class="tiny mt-2 pt-2 border-t border-line">
          ${esc(m.cannotTell)}
        </div>`).join('')}
      <button class="btn btn-sm btn-block btn-ghost mt-2.5" data-act="level-full">
        Record everything instead
      </button>
    </div>`;
}

/**
 * What the first week actually found.
 *
 * The payoff of the measuring week, and the only screen that reports a test
 * which **could not be used**. Ordinary progression reads the last session and
 * suggests the next weight, which is right and also silent: a set taken for
 * twenty reps gives an estimate Epley cannot support, and nothing else in the
 * app ever says so. `startingWeights` knows, and before this nothing asked it.
 *
 * Only for somebody who took the week up, only once something has been logged
 * against the week they were given, and gone again as soon as the week is no
 * longer the thing being started from — it reads the **first** session on each
 * lift, so it stops moving once there is history.
 */
function renderWeekFound() {
  if (state.settings.planChoice !== 'in') return '';

  const program = (state.boot.programs ?? []).find((p) => String(p.id).startsWith('prescribed-'));
  if (!program) return '';

  const days = (state.boot.days ?? []).filter((d) => d.programId === program.id);
  if (!days.length) return '';

  const found = startingWeights({ days }, testResults(loggedExerciseList()), {
    rirTarget: rirTargetFor(state.settings.experience),
  });

  // Nothing logged against it yet: the card would be a column of "not tested
  // yet", which is the same screen as not having the card.
  if (!found.some((f) => f.source === 'tested')) return '';

  const liftOf = (id) => (state.boot.exercises ?? []).find((e) => e.id === id) ?? null;
  const nameOf = (id) => liftOf(id)?.name ?? id;
  const order = { tested: 0, unusable: 1, untested: 2 };

  /**
   * Onto a weight the gym can actually make.
   *
   * `startingWeights` divides, so it returns things like 118.47. Printed
   * straight it read "118.5 lb", which is not a load any plate set in the
   * building holds — the app telling somebody to put a weight on the bar that
   * does not exist. `roundToLoadableLb` is the one function that knows both
   * grids, and it takes the pound figure with the unit named separately for
   * exactly the reason its own comment gives.
   */
  const loadable = (lb, id) => roundToLoadableLb(
    lb,
    equipmentFor(liftOf(id), { available: platesNow() }),
    unit(),
  );

  return `<div class="card mb-3 week-found">
    <b class="tiny">What your first week found</b>
    <div class="tiny muted mt-1.5">
      Taken from the hardest set in the asked-for rep range on each lift's first session,
      and converted to a working weight. Every lift still untested gets a number the week it is.
    </div>
    <div class="mt-2.5">
      ${[...found].sort((a, b) => order[a.source] - order[b.source]).map((f) => `
        <div class="row-between plan-lift" data-found="${f.source}">
          <span class="tiny truncate">${esc(nameOf(f.exerciseId))}</span>
          <span class="tiny muted mono">${f.weight === null
            ? (f.source === 'unusable' ? 'retest it' : 'not yet')
            : esc(formatWeight(loadable(f.weight, f.exerciseId), unit()))}</span>
        </div>`).join('')}
    </div>
    ${found.some((f) => f.source === 'unusable')
      ? `<div class="tiny muted mt-2">
          A set taken for more than twelve reps cannot be turned into a max worth trusting, and an
          over-estimate on a first week is the one error this app compounds rather than corrects.
          Those lifts want one more hard set in the ${TEST_REPS.min}-${TEST_REPS.max} range.
        </div>`
      : ''}
  </div>`;
}

function viewCoach() {
  const items = loggedExerciseList().map((e) => ({ name: e.name, exerciseId: e.exerciseId, history: e.history }));
  const findings = analyzeAll(items);
  const overall = renderOverall(items);
  const movements = renderMovements();
  const profiles = renderProfiles();
  const recovery = renderRecovery(findings);
  const feel = renderCheckinEffect();

  if (!findings.length) {
    // No sections yet: with nothing to sort, tabs would be four ways to see the same
    // empty screen.
    return `<h1>Coach</h1>
      ${renderSummary()}
      ${renderWeekFound()}
      ${renderAdaptation()}
      ${overall}${movements}${recovery}${feel}
      ${renderHabits()}
      ${renderUnchecked()}
      <div class="card">
        <div class="tiny muted">Per-lift verdicts need three sessions of the same lift. Movements above need
        only two, and count every machine you did them on — which is why they fill in first.</div>
      </div>`;
  }

  const pillFor = { progressing: 'pill-good', stagnant: 'pill-warn', regressing: 'pill-bad', 'too-fast': 'pill-warn' };
  const labelFor = {
    progressing: t('verdict.progressing'),
    stagnant: t('verdict.stagnant'),
    regressing: t('verdict.regressing'),
    'too-fast': t('verdict.tooFast'),
  };

  /**
   * What to do about this group of lifts, said once.
   *
   * The advice for a status is the same words for every lift that has it, and
   * inlining it into each verdict meant the Coach screen printed the identical
   * sentence once per card — twenty-four times, for twenty-four stalled lifts.
   * A sentence repeated until it carries nothing is worse than a sentence
   * nobody wrote, because it also teaches the reader to skip the ones that do
   * carry something.
   *
   * One line per status actually present in the group, under the heading,
   * where it reads as the general case rather than as this lift's diagnosis.
   */
  const adviceFor = (list) => {
    const statuses = [...new Set(list.map((f) => f.status))].filter((s) => ADVICE[s]);
    if (!statuses.length) return '';

    return `<p class="sub">${statuses.map((s) => esc(ADVICE[s])).join(' ')}</p>`;
  };

  /**
   * A lift's verdict, with the reasoning one tap in.
   *
   * Every card carried a name, a status, three figures and two paragraphs of
   * prose — about 130 words — and with twenty-four lifts expanded this screen
   * measured **4,744px: seven and a bit screens of scroll**. A list that long
   * is not a list, it is an archive.
   *
   * The question this tab answers is "is anything wrong", and a row with a
   * name, a rate and a verdict answers it. The prose is the *second* question
   * — "why, and what do I do" — and it belongs behind the first. Collapsed,
   * a row is about 56px, so twenty-four of them is 1,344px instead of 4,744.
   *
   * The figures stay inside rather than on the row on purpose: `e1RM 173` and
   * `best 173` are what you read *after* deciding to look, and putting five
   * pills on a collapsed row rebuilds the wall this is dismantling.
   */
  const liftCard = (f) => {
    const open = state.coachOpen.includes(f.exerciseId);

    return `<div class="card p-0 mb-2">
      <button class="btn btn-block disclosure" data-act="lift-toggle" data-id="${esc(f.exerciseId)}"
          aria-expanded="${open}">
        <span class="row gap-2 grow min-w-0">
          <b class="t truncate">${esc(f.name)}</b>
          <span class="pill mono">${f.percentPerSession > 0 ? '+' : ''}${f.percentPerSession}%</span>
        </span>
        <span class="pill ${pillFor[f.status] ?? ''}">${labelFor[f.status] ?? f.status}</span>
        <span class="chev" aria-hidden="true"></span>
      </button>
      ${open ? `<div class="px-3.5 pb-3.5">
        <div class="row wrap tiny muted gap-1.5 mb-2">
          <span class="pill mono">e1RM ${Math.round(f.lastE1RM)}</span>
          <span class="pill mono">best ${Math.round(f.bestE1RM)}</span>
          ${f.flags.map((x) => `<span class="pill pill-warn">${esc(x)}</span>`).join('')}
        </div>
        <div class="text-sm">${esc(f.message)}</div>
        ${machineNote(f.exerciseId)}
        ${diagnosisNote(f.exerciseId)}
      </div>` : ''}
    </div>`;
  };

  /**
   * Four sections, because one column of everything answers no question at all.
   *
   * It used to be the written summary, the program suggestions, the overall trend,
   * the per-machine profiles, the movements, recovery, the check-in effect and then
   * twenty-nine lift cards, stacked. Every one of those is worth having and none of
   * them was findable — his words were "a pretty long list and I don't know where to
   * look".
   *
   * So they are grouped by the question each one answers, and **Now** is the default
   * because "what needs my attention" is why anybody opens this tab. Nothing is
   * removed and nothing is behind more than one tap.
   */
  const needsWork = findings.filter((f) => f.status === 'regressing' || f.status === 'stagnant');
  const fine = findings.filter((f) => f.status === 'progressing' || f.status === 'too-fast');

  const counts = {
    regressing: findings.filter((f) => f.status === 'regressing').length,
    stagnant: findings.filter((f) => f.status === 'stagnant').length,
    progressing: findings.filter((f) => f.status === 'progressing').length,
  };

  const pending = state.adapt?.pending?.length ?? 0;

  const sections = [
    ['now', 'Now', pending + counts.regressing + counts.stagnant],
    ['lifts', 'Lifts', findings.length],
    ['trends', 'Trends', null],
    ['body', 'Recovery', null],
  ];

  // Buttons with `aria-pressed`, deliberately not role="tablist". A real tablist
  // owes the screen reader `aria-controls`, arrow-key navigation and a focus-managed
  // panel; half of one announces a contract this does not keep.
  const tabs = `<div class="tabs">
      ${sections.map(([id, label, badge]) => `<button class="${state.coachTab === id ? 'on' : ''}"
          data-act="coach-tab" data-tab="${id}"
          aria-pressed="${state.coachTab === id}"
          ${badge ? `aria-label="${esc(label)}, ${badge} waiting"` : ''}>
          ${esc(label)}${badge ? ` <span class="tiny mono">${badge}</span>` : ''}
        </button>`).join('')}
    </div>`;

  /**
   * The one-line answer, above the tabs.
   *
   * Counts rather than prose, because the useful question is "is anything wrong"
   * and three numbers answer it faster than a paragraph. Tapping one jumps to the
   * list filtered to it, which is the whole path from "is anything wrong" to
   * "which ones" — two taps, from anywhere on the tab.
   *
   * It sits above the tabs rather than inside Lifts so that path works from the
   * section he lands on. The wording avoids "climbing", which the overall view
   * already uses for the whole-program trend; two different things with one word
   * is how the old single column became unreadable.
   */
  const glance = `<div class="glance">
      ${[
        ['regressing', counts.regressing, 'going backwards', 'pill-bad'],
        ['stagnant', counts.stagnant, 'stalled', 'pill-warn'],
        ['progressing', counts.progressing, 'improving', 'pill-good'],
      ].map(([status, n, label, pill]) => `<button class="card"
            data-act="coach-filter" data-status="${status}"
            aria-pressed="${state.coachFilter === status}"
            aria-label="${n} ${label}${state.coachFilter === status ? ', showing only these' : ''}">
            <div class="mono n">${n}</div>
            <div class="tiny muted">${label}</div>
            <div class="pill ${pill} mt-1 inline-block">&nbsp;</div>
          </button>`).join('')}
    </div>`;

  const liftCards = (list) => list.map(liftCard).join('');

  const body = {
    now: `${renderSummary()}
      ${renderWeekFound()}
      ${renderAdaptation()}
      ${renderUnchecked()}
      ${needsWork.length
        ? `<h2>Worth your attention</h2>
           <p class="sub">Stalled or going backwards. Everything else is in Lifts.</p>
           ${adviceFor(needsWork)}
           ${liftCards(needsWork)}`
        : `<div class="card"><b class="tiny">Nothing is going backwards</b>
             <div class="tiny muted mt-1.5">
               Every lift with enough history is holding or climbing. The full list is in Lifts.
             </div>
           </div>`}`,

    lifts: `${state.coachFilter
        ? `<div class="row-between mb-2.5">
             <span class="tiny muted">Showing ${esc(state.coachFilter)} only</span>
             <button class="btn btn-sm btn-ghost" data-act="coach-filter" data-status="">Show all</button>
           </div>
           ${liftCards(findings.filter((f) => f.status === state.coachFilter))}`
        /*
         * Everything, with no "show the rest" button.
         *
         * That button existed because an expanded card cost ~200px, so
         * twenty-four of them was seven screens and the tab had to hide most
         * of itself to stay usable. The side effect was a tab whose badge read
         * `Lifts 24` and whose body showed three — a count that contradicted
         * what was under it.
         *
         * Now that a row collapses to ~56px the whole list fits in about
         * 1,300px, so there is nothing left to hide and nothing to explain.
         */
        : `${needsWork.length ? `${adviceFor(needsWork)}${liftCards(needsWork)}` : ''}
           ${fine.length ? `<h2>Doing fine</h2>${adviceFor(fine)}${liftCards(fine)}` : ''}`}`,

    trends: `${overall}${profiles}${movements}${renderHabits()}`,
    body: `${recovery}${feel}`,
  }[state.coachTab] ?? '';

  return `<h1>Coach</h1>
    ${glance}
    ${tabs}
    ${body}
    <div class="card mt-3.5">
      <div class="tiny muted">These are numbers, not a camera. No lifting log can see your form — a jump flag or a
      rep collapse is a hint to check technique, not a diagnosis.</div>
    </div>`;
}

/**
 * Recovery sits above the lift verdicts because it is the more likely
 * explanation when several of them go bad at once.
 */
/** The slope of a series, indexed to its own start so any lift is comparable. */
function seriesTrend(values = []) {
  const clean = values.map(Number).filter((v) => Number.isFinite(v) && v > 0);
  if (clean.length < 2) return null;
  const first = clean[0];
  return percentSlope(clean.map((v) => (v / first) * 100));
}

/**
 * The headline: how is everything going?
 *
 * This sits above the per-lift verdicts because it answers first, and because
 * with varied training it is often the only thing that can answer at all.
 */
/* ----------------------------- the AI summary ----------------------------- */

/**
 * The findings, compacted for the summary request.
 *
 * Deliberately the *computed verdicts* rather than the raw log: it is a much
 * smaller payload, and a much smaller disclosure, to answer a question about
 * trends that have already been worked out on this phone.
 */
/** The coach payload now lives in `lib/coachpayload.js`; this binds it to state. */
function summaryFindings() {
  return buildSummaryFindings({
    sessions: state.sessions,
    boot: state.boot,
    metrics: state.metrics,
    settings: state.settings,
    adapt: state.adapt,
    gymNames: gymsList().map((g) => g.name),
  });
}

/**
 * The one card on the tab that is not arithmetic.
 *
 * Everything below it is computed on this phone and works with no signal. This
 * needs the network, so it is written to be *additive only*: unconfigured,
 * offline, rate-limited or out of credit, it says so in one line and nothing
 * else on the screen changes.
 */
/**
 * The coach report, rendered as the structure it now is.
 *
 * A score, a status, what it found and what to do. Prose could only ever be a
 * paragraph; this can be scanned between sets, which is when it is actually
 * read. A report that failed to parse still renders — as its own text, marked
 * as such — because a coach that vanishes on a bad reply is worse than a
 * scruffy one.
 */
function renderReportBody(r) {
  if (!r) return '';

  if (r.degraded) {
    return `<div class="text-sm">${esc(r.headline)}</div>
      <div class="tiny muted mt-2">
        That came back as prose rather than the usual structure, so it is shown as written.
      </div>`;
  }

  const scoreColour = r.score === null
    ? 'var(--muted)'
    : r.score >= 65 ? 'var(--good)' : r.score >= 45 ? 'var(--warn)' : 'var(--bad)';

  const severityColour = { high: 'var(--bad)', medium: 'var(--warn)', low: 'var(--muted)' };

  const findings = r.findings
    .map(
      (f) => `<div class="px-0 py-2 border-t border-line">
        <div class="row gap-2 items-start">
          <span style="color:${severityColour[f.severity]};font-size:16px;line-height:1.2">•</span>
          <div class="grow min-w-0">
            <b class="text-sm">${esc(f.title)}</b>
            ${f.detail ? `<div class="tiny muted mt-0.5">${esc(f.detail)}</div>` : ''}
          </div>
        </div>
      </div>`,
    )
    .join('');

  const recommendations = r.recommendations
    .map(
      (x, i) => `<div class="px-0 py-2 border-t border-line">
        <div class="row gap-2 items-start">
          <span class="tiny mono muted min-w-3.5">${i + 1}</span>
          <div class="grow min-w-0">
            <b class="text-sm">${esc(x.action)}</b>
            ${x.why ? `<div class="tiny muted mt-0.5">${esc(x.why)}</div>` : ''}
          </div>
        </div>
      </div>`,
    )
    .join('');

  return `
    ${r.score !== null
      ? `<div class="row gap-3 items-baseline mb-1.5">
           <span class="mono" style="font-size:30px;font-weight:600;color:${scoreColour}">${r.score}</span>
           <span class="tiny muted">out of 100 · ${esc(r.status)}</span>
         </div>`
      : `<div class="tiny muted mb-1.5">${esc(r.status)}</div>`}

    ${r.headline ? `<div class="text-sm">${esc(r.headline)}</div>` : ''}

    ${findings ? `<div class="tiny muted mt-3"><b>What it found</b></div>${findings}` : ''}
    ${recommendations ? `<div class="tiny muted mt-3"><b>Do next</b></div>${recommendations}` : ''}

    ${r.caveats.length
      ? `<div class="tiny muted mt-3">
           ${r.caveats.map((c) => `<div class="mt-1">· ${esc(c)}</div>`).join('')}
         </div>`
      : ''}`;
}

function renderSummary() {
  const s = state.summary;

  // Nothing logged means nothing to synthesise, and a request would be spent
  // describing an empty list.
  if (!state.sessions.length) {
    return `<div class="card">
      <div class="tiny muted"><b>What this all means</b></div>
      <div class="tiny muted mt-2">
        Log a workout and this will read your trends together and say what they mean.
      </div>
    </div>`;
  }

  if (!s || (!s.text && !s.loading && !s.error)) {
    return `<div class="card">
      <div class="row-between">
        <span class="tiny muted"><b>What this all means</b></span>
        <button class="btn btn-sm" data-act="summary-go">Write it</button>
      </div>
      <div class="tiny muted mt-2">
        Reads the verdicts below and says what they mean together — which is the one
        thing the per-lift numbers cannot do for themselves.
        ${state.online ? '' : ' Needs signal, unlike everything else here.'}
      </div>
    </div>`;
  }

  if (s.loading) {
    return `<div class="card">
      <div class="row-between">
        <div class="row gap-2.5">
          <div class="spinner"></div>
          <span class="tiny muted">Reading your trends…</span>
        </div>
        <button class="btn btn-sm btn-ghost" data-act="summary-cancel">Cancel</button>
      </div>
    </div>`;
  }

  if (s.error) {
    return `<div class="card">
      <div class="row-between">
        <span class="tiny muted"><b>What this all means</b></span>
        <button class="btn btn-sm" data-act="summary-go">Try again</button>
      </div>
      ${s.text ? `<div class="text-sm mt-2">${esc(s.text)}</div>` : ''}
      <div class="tiny mt-2 text-warn">${esc(s.error)}</div>
      ${s.text ? '<div class="tiny muted mt-1">That is the previous answer, kept.</div>' : ''}
    </div>`;
  }

  const stale = s.key !== summaryCacheKey(summaryFindings());

  return `<div class="card">
    <div class="row-between mb-2">
      <span class="tiny muted"><b>What this all means</b></span>
      <button class="btn btn-sm" data-act="summary-go">${stale ? 'Refresh' : 'Rewrite'}</button>
    </div>
    ${renderReportBody(parseReport(s.text))}
    <div class="tiny muted mt-3">
      Written by Claude from the verdicts below${stale ? ' — you have logged a workout since' : ''}.
      The numbers are computed on this phone; only this reading needs signal.
    </div>
  </div>`;
}

/** Ask the Worker for a summary. The Worker holds the key; this never sees it. */
/** Generous: the model genuinely takes ten to twenty seconds on a long history. */
const SUMMARY_TIMEOUT_MS = 45000;

async function requestSummary() {
  const findings = summaryFindings();
  const key = summaryCacheKey(findings);

  // Keep whatever is on screen. Cancelling, or failing, must not destroy an
  // answer he could still read.
  const previous = state.summary?.text ? { text: state.summary.text, key: state.summary.key } : null;

  summaryAbort?.abort();
  const controller = new AbortController();
  summaryAbort = controller;

  const deadline = setTimeout(() => controller.abort('timeout'), SUMMARY_TIMEOUT_MS);
  state.summary = { loading: true, key, previous };
  render();

  try {
    // postJSON throws with the server's own message on a non-2xx, which is
    // already written to be shown to him — "out of credit", "key rejected".
    const body = await postJSON('/api/summary', { findings }, { signal: controller.signal });
    const text = String(body?.summary ?? '').trim();

    state.summary = text
      ? { text, key }
      : { error: 'The summary came back empty.', key, ...(previous ? { text: previous.text } : {}) };

    if (text) await db.setMeta('summary', state.summary);
  } catch (err) {
    // An abort we asked for is not a failure to report as one.
    if (controller.signal.aborted && controller.signal.reason === 'cancelled') {
      state.summary = previous ?? null;
    } else if (controller.signal.aborted) {
      state.summary = {
        error: 'That took too long and was given up on. The service may be busy — try again.',
        key,
        ...(previous ? { text: previous.text } : {}),
      };
    } else {
      state.summary = {
        error: err?.message ?? 'Could not reach the summary service.',
        key,
        ...(previous ? { text: previous.text } : {}),
      };
    }
  } finally {
    clearTimeout(deadline);
    if (summaryAbort === controller) summaryAbort = null;
  }

  render();
}

/** The in-flight summary request, so it can be cancelled or superseded. */
let summaryAbort = null;

function renderOverall(items) {
  const o = overallProgress({ items, sessions: state.sessions, exercises: state.boot.exercises });

  const volume = volumeOverTime(state.sessions).map((v) => ({
    label: fmtDate(v.date),
    value: v.volume,
    detail: `${v.dayName} · ${v.sets} sets`,
  }));

  const tone = { progressing: 'pill-good', regressing: 'pill-bad', stagnant: '', 'too-fast': 'pill-warn' }[o.status] ?? '';

  return `<div class="card">
      <div class="row-between mb-2.5">
        <b style="font-size:17px">Overall</b>
        ${trendBadge(o.percentPerSession)}
      </div>

      <div class="row mb-3">
        <div class="text-center flex-1">
          <div class="mono font-bold text-good" style="font-size:20px">${o.improving}</div>
          <div class="tiny muted">climbing</div>
        </div>
        <div class="text-center flex-1">
          <div class="mono font-bold" style="font-size:20px">${o.flat}</div>
          <div class="tiny muted">flat</div>
        </div>
        <div class="text-center flex-1">
          <div class="mono font-bold text-bad" style="font-size:20px">${o.declining}</div>
          <div class="tiny muted">falling</div>
        </div>
        <div class="text-center flex-1">
          <div class="mono font-bold" style="font-size:20px">${o.movements}</div>
          <div class="tiny muted">movements</div>
        </div>
      </div>

      <div class="${tone ? '' : 'muted'} text-sm mb-3">${esc(o.message)}</div>

      ${volume.length > 1
        ? `<div class="tiny muted mb-1">Volume per session</div>
           <div class="chart-wrap" data-chart="1">${barChart(inDisplayUnit(volume), { unit: ` ${unit()}`, title: 'Volume per session' })}</div>`
        : ''}
    </div>`;
}

/**
 * Movements, not lifts.
 *
 * A movement done on three machines has three thin histories and one clear
 * direction, which is exactly the case the per-lift view cannot see.
 */
/**
 * Trends by machine, and by muscle group above them.
 *
 * This sits above the per-lift verdicts because it answers a question they
 * cannot: whether a number moved because he got stronger or because the machine
 * changed. A lift split across two stacks has two honest trends and no single
 * one, and showing the single one was quietly lying.
 */
function renderProfiles() {
  const profiles = profilesFrom(state.sessions, {
    minSessions: 3,
    exercises: state.boot.exercises,
    gymNames: Object.fromEntries(gymsList().map((g) => [g.id, g.name])),
  });
  if (!profiles.length) return '';

  const groups = groupTrends(profiles, state.boot.exercises);
  const machineCount = new Set(profiles.map((p) => p.machine).filter(Boolean)).size;

  const rows = groups
    .map((g) => {
      const worst = g.members[0];
      const best = g.members[g.members.length - 1];
      const spread = g.members.length > 1 && Math.abs(best.percentPerSession - worst.percentPerSession) >= 2;

      return `<div class="card">
        <div class="row-between mb-1.5">
          <b>${esc(g.muscleGroup)}</b>
          ${trendBadge(g.percentPerSession, { unit: '%/session' })}
        </div>
        <div class="tiny muted">
          ${g.profiles} machine profile${g.profiles === 1 ? '' : 's'}${g.machines ? ` across ${g.machines} machine${g.machines === 1 ? '' : 's'}` : ''}.
          Each is indexed to its own start before they are combined, so the loads never need to match.
        </div>
        <div class="mt-2">
          ${g.members
            .map(
              (m) => `<div class="row-between border-t border-line" style="padding:5px 0">
                <span class="tiny truncate">${esc(m.label)}</span>
                <span class="tiny mono ${m.percentPerSession >= 0 ? 'ok' : ''}"
                  style="${m.percentPerSession < 0 ? 'color:var(--bad)' : ''}">
                  ${m.percentPerSession > 0 ? '+' : ''}${m.percentPerSession}% · ${m.sessions}x
                </span>
              </div>`,
            )
            .join('')}
        </div>
        ${spread
          ? `<div class="tiny mt-2 text-warn">
               ${esc(best.machine ?? 'one machine')} is climbing while ${esc(worst.machine ?? 'another')} is not.
               Same muscle, different machine — worth knowing which one the progress is actually on.
             </div>`
          : ''}
      </div>`;
    })
    .join('');

  return `<h2>By machine</h2>
    <p class="sub -mt-1.5">
      ${machineCount
        ? `Loads only compare within one machine, so each ${esc('(lift, machine)')} pair is trended on its own.`
        : 'No machines recorded yet, so every lift is one profile. These split as soon as machines are logged.'}
    </p>
    ${rows}`;
}

function renderMovements() {
  const query = (state.libraryQuery ?? '').trim().toLowerCase();

  const logged = new Set();
  for (const s of state.sessions) for (const x of s.sets ?? []) logged.add(x.exerciseId);
  if (!logged.size) return '';

  const analysed = familiesOf(state.boot.exercises)
    .filter((f) => f.members.some((m) => logged.has(m.id)))
    .map((f) => analyzeFamily(f, (id) => historyFor(id)))
    .filter((f) => f.hasTrend)
    .sort((a, b) => (a.percentPerSession ?? 0) - (b.percentPerSession ?? 0));

  if (!analysed.length) return '';

  const rows = analysed
    .map(
      (f) => `<div class="row-between border-t border-line" style="padding:9px 0">
        <div class="grow min-w-0">
          <div class="text-sm">${esc(f.name)}</div>
          <div class="tiny muted">${f.sessionCount} session${f.sessionCount === 1 ? '' : 's'}${f.variants > 1 ? ` · ${f.variants} machines` : ''}</div>
        </div>
        ${trendBadge(f.percentPerSession)}
      </div>`,
    )
    .join('');

  return `<div class="card">
      <div class="row-between mb-0.5">
        <b>Movements</b><span class="pill">${analysed.length} with a trend</span>
      </div>
      <div class="tiny muted mb-1">
        Each movement read across every machine you did it on. Two sessions is enough.
      </div>
      ${rows}
    </div>`;
}

/** Whether how a session felt showed up in the work. */
function renderCheckinEffect() {
  const effect = checkinEffect(state.sessions);
  if (!effect.hasSignal) {
    const scored = state.sessions.filter((s) => isAnswered(s.checkin)).length;
    if (!scored) return '';
    return `<div class="card">
        <b class="tiny">How it felt</b>
        <div class="tiny muted mt-1.5">
          ${scored} session${scored === 1 ? '' : 's'} rated. A few more and this will say whether
          how you turn up is showing in the work.
        </div>
      </div>`;
  }

  return `<div class="card">
      <div class="row-between mb-2">
        <b>How it felt</b>
        <span class="pill">${effect.sessionsScored} rated</span>
      </div>
      <div class="text-sm">${esc(effect.message)}</div>
    </div>`;
}

function renderRecovery(findings) {
  const r = recoveryReport(state.metrics, findings);

  if (!r.hasData) {
    return `<div class="card">
      <div class="row-between mb-2">
        <b>Recovery</b><span class="pill">no watch data</span>
      </div>
      <div class="tiny muted">${esc(r.message)}</div>
      <div class="tiny muted mt-2">Setup → Apple Health has the steps.</div>
    </div>`;
  }

  const stat = (label, value, unit) =>
    value === null
      ? ''
      : `<div class="text-center flex-1">
           <div class="mono font-bold" style="font-size:20px">${value}<span class="tiny muted">${unit}</span></div>
           <div class="tiny muted">${label}</div>
         </div>`;

  return `<div class="card" style="${r.flags.length ? 'border-color:var(--warn)' : ''}">
      <div class="row-between mb-2.5">
        <b>Recovery</b>
        <span class="pill ${r.flags.length ? 'pill-warn' : 'pill-good'}">
          ${r.flags.length ? `${r.flags.length} thing${r.flags.length === 1 ? '' : 's'} to watch` : 'steady'}
        </span>
      </div>
      <div class="row mb-2.5">
        ${stat('sleep', r.sleep, 'h')}
        ${stat('steps', r.steps === null ? null : Math.round(r.steps).toLocaleString(), '')}
        ${stat('resting HR', r.restingHr, '')}
        ${stat('HRV', r.hrv, '')}
      </div>
      <div class="tiny muted mb-1">7-day averages</div>
      <div class="text-sm">${esc(r.message)}</div>
    </div>`;
}

/* -------------------------------- setup --------------------------------- */

/**
 * What is actually recorded about him, and what it implies.
 *
 * The readings are listed because the entry boxes clear on save — and without
 * a list, typing a weight and seeing nothing back is indistinguishable from it
 * failing. That is precisely how this looked broken while working perfectly.
 */
/**
 * One day of readings, as a row you edit.
 *
 * The first version treated each number as an event: type it, it saves, the box
 * clears. That was wrong twice over. You could not fill three fields and press
 * save once, and a number that vanishes on entry is indistinguishable from one
 * that failed. What is actually being recorded is a single row per day — weight,
 * calories, steps — which can be corrected whenever, including days later.
 */
function renderDayRow(date, values) {
  const draft = state.dayDraft?.date === date ? state.dayDraft.values : null;

  const fields = DAY_FIELDS.map((f) => {
    const typed = draft?.[f.name];
    const stored = values[f.name];
    const value = typed !== undefined ? typed : stored === null || stored === undefined ? '' : stored;

    return `<div class="row-between px-0 py-1.5">
      <label class="tiny muted grow-0 shrink-0 basis-19.5">${esc(f.label)}</label>
      <input class="input mono grow text-right" data-day-field="${esc(f.name)}" inputmode="decimal"
        placeholder="—" value="${esc(String(value))}">
      <span class="tiny muted grow-0 shrink-0 basis-8.5 text-right">${esc(f.unit)}</span>
    </div>`;
  }).join('');

  return `<div data-day="${esc(date)}">${fields}</div>`;
}

/** Remember every keystroke, so a sync landing mid-entry cannot erase it. */
function noteDayDraft(input) {
  const row = input.closest('[data-day]');
  if (!row) return;

  const date = row.dataset.day;
  const values = state.dayDraft?.date === date ? { ...state.dayDraft.values } : {};
  values[input.dataset.dayField] = input.value;
  state.dayDraft = { date, values };
}

/** Read whatever is currently typed into a day row. */
function readDayRow(root) {
  const values = {};
  for (const input of root.querySelectorAll('[data-day-field]')) {
    values[input.dataset.dayField] = input.value.trim();
  }
  return values;
}

/**
 * Save a day, including the blanks.
 *
 * A field cleared is a field deleted — a mistyped 21000 kcal has to be
 * removable, and storing 0 would read as a day of fasting. Deletions are
 * tracked separately so the next pull cannot hand the bad value back.
 */
async function saveDay(date, values) {
  const bad = DAY_FIELDS.filter((f) => {
    const raw = String(values[f.name] ?? '').trim();
    return raw && makeMetric(f.name, raw, date) === null;
  });

  if (bad.length) {
    toast(`${bad.map((f) => f.label).join(' and ')} — that does not look like a number`);
    return;
  }

  const before = metricsForDay(state.metrics, date);
  state.metrics = setDayMetrics(state.metrics, date, values);
  const after = metricsForDay(state.metrics, date);

  for (const f of DAY_FIELDS) {
    const wasThere = before[f.name] !== null;
    const goneNow = after[f.name] === null;

    if (wasThere && goneNow) {
      state.metricDeletions = [
        ...(state.metricDeletions ?? []).filter((d) => !(d.name === f.name && d.date === date)),
        { name: f.name, date },
      ];
    } else if (!goneNow) {
      // Re-entered after a delete: drop the tombstone or it kills the new value.
      state.metricDeletions = (state.metricDeletions ?? []).filter((d) => !(d.name === f.name && d.date === date));
    }
  }

  await db.setMeta('metrics', state.metrics);
  await db.setMeta('metricDeletions', state.metricDeletions ?? []);

  // Saved, so the draft has served its purpose and the stored values take over.
  if (state.dayDraft?.date === date) state.dayDraft = null;

  toast(state.online ? 'Saved' : 'Saved — uploads on next sync');
  if (state.online) sync({ quiet: true });
  render(true);
}

/** Edit any past day, because a reading is often remembered late. */
function openDaySheet(date) {
  const values = metricsForDay(state.metrics, date);
  const when = new Date(`${date}T12:00:00`);
  const label = when.toLocaleDateString(LOCALE, { weekday: 'long', month: 'short', day: 'numeric' });

  openSheet(
    `<h2 class="mt-0">${esc(label)}</h2>
     <div class="tiny muted mb-3">
       Fill in what you know and save. Clearing a box removes that reading.
     </div>
     ${renderDayRow(date, values)}
     <button class="btn btn-primary btn-block btn-lg mt-3" data-day-save="1">Save</button>`,
    async (e) => {
      if (!e.target.closest('[data-day-save]')) return;
      const root = sheetPanel.querySelector(`[data-day="${date}"]`);
      closeSheet();
      await saveDay(date, readDayRow(root));
    },
  );
}

function renderYou() {
  const ctx = nutritionContext({
    metrics: state.metrics,
    settings: state.settings,
    intakeAvg: avg(state.metrics.filter((m) => m.name === 'dietary_energy').slice(-14).map((m) => m.value)),
  });

  const today = todayISO();
  const pendingFor = (date) => state.metrics.some((m) => m.date === date && m._dirty);

  const past = calendarDays(today, 15)
    .filter((d) => d !== today)
    .map((d) => metricsForDay(state.metrics, d));

  const summarise = (d) =>
    DAY_FIELDS.map((f) => (d[f.name] === null ? null : `${d[f.name]}${f.unit ? ` ${f.unit}` : ''}`))
      .filter(Boolean)
      .join(' · ') || 'nothing logged — tap to add';

  const weekday = (date) =>
    new Date(`${date}T12:00:00`).toLocaleDateString(LOCALE, { weekday: 'short' });

  const rows = past
    .map(
      (d) => `<button class="lib-row" data-act="edit-day" data-date="${esc(d.date)}">
        <div class="grow min-w-0">
          <b style="font-size:13.5px">${esc(weekday(d.date))} ${esc(d.date)}</b>
          <div class="tiny muted">${esc(summarise(d))}${pendingFor(d.date) ? ' · queued' : ''}</div>
        </div>
        <span class="tiny muted">›</span>
      </button>`,
    )
    .join('');

  return {
    ctx,
    rows,
    count: past.length,
    today,
    todayValues: metricsForDay(state.metrics, today),
    todayPending: pendingFor(today),
  };
}

/**
 * The energy picture: what the formulas estimate, and what the scale measured.
 *
 * Both are shown, in that order, because they disagree often and the
 * disagreement is the useful part — an estimate that the scale contradicts is
 * a wrong estimate, and seeing both makes that obvious rather than mysterious.
 */
/** Each logged day, costed from what actually happened on it. */
function renderDailyEnergy() {
  const days = calendarDays(todayISO(), 8)
    .map((date) => dailyEnergy({ date, metrics: state.metrics, sessions: state.sessions, settings: state.settings }))
    .filter((d) => d.known && (d.walking || d.lifting || d.intake));

  if (!days.length) return '';

  const dow = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(LOCALE, { weekday: 'short' });

  const rows = days
    .map((d) => {
      const bits = [
        d.walking ? `walk ${d.walking}` : null,
        d.lifting ? `lift ${d.lifting}` : null,
      ].filter(Boolean).join(' · ');

      const colour = d.deficit === null ? 'var(--muted)' : d.deficit > 0 ? 'var(--good)' : 'var(--bad)';

      return `<div class="row-between px-0 py-1.5 border-t border-line">
        <div class="grow min-w-0">
          <span class="tiny"><b>${esc(dow(d.date))}</b> ${esc(d.date.slice(5))}</span>
          <div class="tiny muted">burn ${d.tdee}${bits ? ` · ${esc(bits)}` : ''}</div>
        </div>
        <span class="tiny mono" style="color:${colour}">
          ${d.deficit === null
            ? '—'
            : d.tdeeLow !== d.tdeeHigh
              ? `${d.deficit > 0 ? '-' : '+'}${Math.abs(d.deficit)} ±${Math.round((d.tdeeHigh - d.tdeeLow) / 2)}`
              : `${d.deficit > 0 ? '-' : '+'}${Math.abs(d.deficit)}`}
        </span>
      </div>`;
    })
    .join('');

  return `<div class="tiny muted mt-3.5"><b>Day by day</b> — burn against what you ate</div>
    ${rows}
    <div class="tiny muted mt-2">
      Your days are not alike. A walking day is worth several hundred more than a
      lift-only one, which makes the lifting days without walking the easiest to overeat on.
    </div>`;
}

/** Which resting formula is in play, given what he has filled in. */
function restingMethod() {
  const weight = bodyweightTrend(state.metrics);
  return restingRange({
    weightLb: weight.smoothed,
    heightIn: state.settings.heightInches,
    age: state.settings.age,
    sex: state.settings.sex,
    bodyFatLow: state.settings.bodyFatLow,
    bodyFatHigh: state.settings.bodyFatHigh,
  }).method;
}

/** "1,712-1,796 kcal" when body fat is a range, otherwise null. */
function restingSpan() {
  const weight = bodyweightTrend(state.metrics);
  const r = restingRange({
    weightLb: weight.smoothed,
    heightIn: state.settings.heightInches,
    age: state.settings.age,
    sex: state.settings.sex,
    bodyFatLow: state.settings.bodyFatLow,
    bodyFatHigh: state.settings.bodyFatHigh,
  });

  if (r.method !== 'katch' || r.low === null || r.low === r.high) return null;
  return `${r.low}–${r.high} kcal`;
}

function renderEnergy() {
  const weight = bodyweightTrend(state.metrics);
  const stepsAvg = avg(state.metrics.filter((m) => m.name === 'steps').slice(-14).map((m) => m.value));
  const intakeAvg = avg(state.metrics.filter((m) => m.name === 'dietary_energy').slice(-14).map((m) => m.value));

  const est = estimateTDEE({
    weightLb: weight.smoothed,
    heightIn: state.settings.heightInches,
    age: state.settings.age,
    sex: state.settings.sex,
    bodyFatLow: state.settings.bodyFatLow,
    bodyFatHigh: state.settings.bodyFatHigh,
    stepsAvg,
    intakeAvg,
  });

  const measured = measuredDeficit({
    perWeek: weight.direction === 'unknown' ? null : weight.perWeek,
    intakeAvg,
    // So the figure can carry how wrong it might be. Shown flat, it was read as
    // a measurement when it was the midpoint of a 700 kcal range.
    sePerWeek: weight.sePerWeek,
  });

  /**
   * Weight at the end of the window that the eating cannot account for.
   *
   * Checked against the *estimate* rather than the measured figure, deliberately:
   * the measured one is the number being dragged about by the swing, so using it
   * as the reference would be asking the artifact whether it is an artifact.
   */
  const swing = unexplainedSwing({
    weights: state.metrics.filter((m) => m.name === 'body_weight').map((m) => m.value),
    intakes: state.metrics.filter((m) => m.name === 'dietary_energy').map((m) => m.value),
    tdee: est.tdee,
  });
  const verdict = deficitVerdict({
    perWeek: weight.direction === 'unknown' ? null : weight.perWeek,
    weightLb: weight.smoothed,
    liftsHolding: liftsAreHolding(),
  });

  if (!est.known && !measured.known) {
    return `<div class="tiny muted mt-3">
      Add your height and age above, and log a few weights, and this works out what you are
      burning — and then checks that against what the scale actually did.
    </div>`;
  }

  const line = (k, v) => `<div class="row-between border-t border-line" style="padding:5px 0">
      <span class="tiny muted">${k}</span><span class="tiny mono">${v}</span>
    </div>`;

  return `
    ${est.known
      ? `${line(
           `Resting burn${restingMethod() === 'katch' ? ' (lean mass)' : ' (BMR)'}`,
           restingSpan() ?? `${est.bmr} kcal`,
         )}
         ${est.steps ? line('Walking, <i>above</i> resting', `+${est.steps} kcal`) : ''}
         ${line('Estimated daily burn', `${est.tdee} kcal`)}`
      : ''}
    ${measured.known
      ? `${line('<b>What the scale says you burn</b>',
           `<b>${measured.impliedTDEE}${measured.plusMinus ? ` ± ${measured.plusMinus}` : ''} kcal</b>`)}
         ${measured.plusMinus
           ? line('<span class="opacity-70">which could be anywhere in</span>',
               `<span class="opacity-70">${measured.low}–${measured.high}</span>`)
           : ''}
         ${line('Actual daily deficit', `${measured.deficitPerDay} kcal`)}`
      : ''}
    ${verdict.severity !== 'unknown'
      ? `<div class="tiny" style="margin-top:10px;color:${
          verdict.severity === 'too-steep' ? 'var(--bad)' : verdict.severity === 'aggressive' ? 'var(--warn)' : 'var(--good)'
        }">${esc(verdict.message)}</div>`
      : ''}
    ${swing.swung && measured.known
      /**
       * The swing comes first, and it overrides "believe the scale".
       *
       * That advice is right in general and wrong in exactly this case: a
       * least-squares slope weights the ends of its window hardest, so water on
       * the last reading moves the measured burn by hundreds of calories. Telling
       * him to believe it here would be telling him to act on the artifact.
       */
      ? `<div class="tiny mt-2.5 text-warn">
           <b>This fortnight ends on a ${swing.unexplainedLb > 0 ? '+' : ''}${swing.unexplainedLb} lb
           swing the calories cannot explain.</b>
           Over the last ${swing.days} days the scale went ${swing.direction} ${Math.abs(swing.observedLb)} lb
           while you ate about ${swing.intakeAvg} a day — the arithmetic says
           ${swing.explainedLb >= 0 ? '+' : ''}${swing.explainedLb} lb. That difference is water and
           glycogen, not fat: ${Math.abs(swing.unexplainedLb)} lb of fat is
           ${Math.abs(Math.round(swing.unexplainedLb * 3500)).toLocaleString()} kcal, which you did not eat.
         </div>
         <div class="tiny muted mt-1.5">
           The trend fits a line through every reading and the last one counts most, so the
           ${measured.impliedTDEE} above is being pulled ${swing.direction === 'up' ? 'down' : 'up'} by it.
           ${est.known ? `The estimate of ${est.tdee} is the better number this week.` : ''}
           Wait for it to clear — usually a few days — rather than changing anything on the
           strength of it.
         </div>`
      : est.known && measured.known && Math.abs(est.tdee - measured.impliedTDEE) > 400
        ? `<div class="tiny mt-2 text-warn">
             The estimate and the scale disagree by ${Math.abs(est.tdee - measured.impliedTDEE)} kcal a day.
             Believe the scale: the formula cannot see how much you actually move, and it is the
             one being contradicted by the weight that did or did not leave.
           </div>`
        : est.known && measured.known
          ? `<div class="tiny muted mt-2">
               These agree closely, which is a good sign both are roughly right.
             </div>`
          : est.known
            ? `<div class="tiny muted mt-2">
                 An estimate only, good to about ±20%. Log weights for two weeks and the scale
                 will measure this properly — it cannot be argued with the way a formula can.
               </div>`
            : ''}
    ${measured.known && measured.confident === false && !swing.swung
      ? `<div class="tiny muted mt-2">
           The weight trend has not yet beaten its own scatter, so that range is wide enough to
           hold both "losing steadily" and "not losing at all". More days narrow it; nothing else does.
         </div>`
      : ''}`;
}

/** Are his lifts broadly holding? Used to judge whether a cut is too steep. */
const liftsAreHolding = () => coachLiftsAreHolding(state.sessions, state.boot);

/* ============================== the walkthrough ========================= */

/**
 * What the app is, in six screens that move.
 *
 * Animated with inline SVG and CSS, no library, because every byte here is
 * downloaded once and then has to work in a gym basement with no signal. A
 * motion-graphics library would be the largest thing in the app and the first
 * thing to fail offline.
 *
 * Each drawing animates the **mechanism** rather than decorating the words — the
 * rep range filling up, three rings closing before the weight moves, a fortnight
 * of scattered weigh-ins resolving into one direction. A picture that shows how
 * something works earns its place; one that illustrates a noun does not.
 *
 * `prefers-reduced-motion` stops all of it and leaves the final frame, which is
 * the state each drawing was explaining anyway.
 */
const TOUR = [
  {
    title: 'Every set goes to failure',
    body: 'There is no guessing how much you had left. You take the last honest rep and '
      + 'write down what happened — the number of reps is the measurement.',
    art: `<svg viewBox="0 0 200 120" class="tour-art" role="img" aria-label="Reps filling a target range">
      <rect x="20" y="52" width="160" height="16" rx="8" fill="var(--line)"/>
      <rect x="20" y="52" width="0" height="16" rx="8" fill="var(--accent)">
        <animate attributeName="width" values="0;96;128;128" dur="2.4s" begin="0.2s"
          keyTimes="0;0.5;0.8;1" fill="freeze" repeatCount="indefinite"/>
      </rect>
      <g fill="var(--text)" font-size="11" text-anchor="middle" opacity="0.7">
        <text x="116" y="42">6</text><text x="180" y="42">10</text>
      </g>
      <g stroke="var(--text)" opacity="0.25" stroke-width="1">
        <line x1="116" y1="46" x2="116" y2="74"/><line x1="180" y1="46" x2="180" y2="74"/>
      </g>
      <text x="100" y="98" fill="var(--muted)" font-size="11" text-anchor="middle">the target range</text>
    </svg>`,
  },
  {
    title: 'Hit the top three times, the weight goes up',
    body: 'Once is a good day. Three sessions at the same weight, each reaching the top of '
      + 'the range, is the weight being too light — and only then does it move.',
    art: `<svg viewBox="0 0 200 120" class="tour-art" role="img" aria-label="Three sessions completed, then the weight increases">
      <g><circle cx="40" cy="70" r="13" fill="none" stroke="var(--line)" stroke-width="3"/><circle cx="40" cy="70" r="13" fill="none" stroke="var(--good)" stroke-width="3" stroke-dasharray="82" stroke-dashoffset="82"><animate attributeName="stroke-dashoffset" from="82" to="0" dur="0.5s" begin="0.3s" fill="freeze" repeatCount="indefinite"/></circle><circle cx="74" cy="70" r="13" fill="none" stroke="var(--line)" stroke-width="3"/><circle cx="74" cy="70" r="13" fill="none" stroke="var(--good)" stroke-width="3" stroke-dasharray="82" stroke-dashoffset="82"><animate attributeName="stroke-dashoffset" from="82" to="0" dur="0.5s" begin="0.9s" fill="freeze" repeatCount="indefinite"/></circle><circle cx="108" cy="70" r="13" fill="none" stroke="var(--line)" stroke-width="3"/><circle cx="108" cy="70" r="13" fill="none" stroke="var(--good)" stroke-width="3" stroke-dasharray="82" stroke-dashoffset="82"><animate attributeName="stroke-dashoffset" from="82" to="0" dur="0.5s" begin="1.5s" fill="freeze" repeatCount="indefinite"/></circle></g>
      <g opacity="0">
        <animate attributeName="opacity" from="0" to="1" dur="0.5s" begin="2.2s" fill="freeze" repeatCount="indefinite"/>
        <line x1="146" y1="70" x2="176" y2="70" stroke="var(--accent)" stroke-width="3"/>
        <polygon points="176,64 188,70 176,76" fill="var(--accent)"/>
      </g>
      <text x="100" y="104" fill="var(--muted)" font-size="11" text-anchor="middle">earned, not assumed</text>
    </svg>`,
  },
  {
    title: 'It works with no signal',
    body: 'Everything is on the phone: your program, your history, the plate maths, the '
      + 'coaching. A gym with no reception changes nothing. It backs up when you get home.',
    art: `<svg viewBox="0 0 200 120" class="tour-art" role="img" aria-label="A phone logging offline, then syncing later">
      <rect x="76" y="24" width="48" height="76" rx="8" fill="none" stroke="var(--text)" stroke-width="2.5" opacity="0.8"/>
      <rect x="84" y="36" width="32" height="6" rx="3" fill="var(--accent)"/>
      <rect x="84" y="48" width="32" height="6" rx="3" fill="var(--accent)" opacity="0">
        <animate attributeName="opacity" values="0;1;1" dur="3s" begin="0.4s" keyTimes="0;0.15;1" repeatCount="indefinite"/>
      </rect>
      <rect x="84" y="60" width="32" height="6" rx="3" fill="var(--accent)" opacity="0">
        <animate attributeName="opacity" values="0;1;1" dur="3s" begin="0.9s" keyTimes="0;0.15;1" repeatCount="indefinite"/>
      </rect>
      <g stroke="var(--muted)" stroke-width="2" fill="none" opacity="0.45">
        <path d="M46 60 q-12 -10 0 -20"/><path d="M154 60 q12 -10 0 -20"/>
      </g>
      <g opacity="0">
        <animate attributeName="opacity" values="0;0;1" dur="3s" keyTimes="0;0.7;0.85" repeatCount="indefinite"/>
        <path d="M124 70 L164 70" stroke="var(--good)" stroke-width="2.5" stroke-dasharray="4 4"/>
        <circle cx="174" cy="70" r="8" fill="none" stroke="var(--good)" stroke-width="2.5"/>
      </g>
      <text x="100" y="114" fill="var(--muted)" font-size="11" text-anchor="middle">logged first, uploaded later</text>
    </svg>`,
  },
  {
    title: 'The scale is the only honest referee',
    body: 'Every calorie formula is a guess within about twenty percent. What no formula '
      + 'gets wrong is whether the weight left. Weigh in most mornings and the trend '
      + 'overrules the estimate.',
    art: `<svg viewBox="0 0 200 120" class="tour-art" role="img" aria-label="Scattered daily weights resolving into one trend line">
      <g fill="var(--muted)" opacity="0.55"><circle cx="24" cy="80.0" r="2.6"/><circle cx="37" cy="67.4" r="2.6"/><circle cx="50" cy="73.8" r="2.6"/><circle cx="63" cy="62.2" r="2.6"/><circle cx="76" cy="72.6" r="2.6"/><circle cx="89" cy="64.0" r="2.6"/><circle cx="102" cy="71.4" r="2.6"/><circle cx="115" cy="56.8" r="2.6"/><circle cx="128" cy="63.2" r="2.6"/><circle cx="141" cy="55.6" r="2.6"/><circle cx="154" cy="63.0" r="2.6"/><circle cx="167" cy="53.4" r="2.6"/></g>
      <path d="M24 78 L167 60" stroke="var(--accent)" stroke-width="3" fill="none"
        stroke-dasharray="145" stroke-dashoffset="145">
        <animate attributeName="stroke-dashoffset" from="145" to="0" dur="1.6s" begin="0.5s"
          fill="freeze" repeatCount="indefinite"/>
      </path>
      <text x="100" y="104" fill="var(--muted)" font-size="11" text-anchor="middle">a fortnight of readings, one direction</text>
    </svg>`,
  },
  {
    title: 'The coach only says what the numbers support',
    body: 'It reports what your estimated one-rep max is doing and flags what moves with '
      + 'it. It cannot see your form, and it says so rather than inventing a reason.',
    art: `<svg viewBox="0 0 200 120" class="tour-art" role="img" aria-label="Three per-lift verdicts appearing in turn">
      <g opacity="0"><animate attributeName="opacity" from="0" to="1" dur="0.4s" begin="0.3s" fill="freeze" repeatCount="indefinite"/><rect x="26" y="30" width="148" height="16" rx="8" fill="var(--line)"/><rect x="26" y="30" width="104" height="16" rx="8" fill="var(--good)"/></g><g opacity="0"><animate attributeName="opacity" from="0" to="1" dur="0.4s" begin="0.8s" fill="freeze" repeatCount="indefinite"/><rect x="26" y="54" width="148" height="16" rx="8" fill="var(--line)"/><rect x="26" y="54" width="62" height="16" rx="8" fill="var(--muted)"/></g><g opacity="0"><animate attributeName="opacity" from="0" to="1" dur="0.4s" begin="1.3s" fill="freeze" repeatCount="indefinite"/><rect x="26" y="78" width="148" height="16" rx="8" fill="var(--line)"/><rect x="26" y="78" width="132" height="16" rx="8" fill="var(--accent)"/></g>
      <text x="100" y="108" fill="var(--muted)" font-size="11" text-anchor="middle">per lift, per muscle group</text>
    </svg>`,
  },
  {
    title: 'Logging a set is one tap',
    body: 'The weight is already filled in, from what you did last time and what the plates '
      + 'can actually make. Change it if the day says otherwise. That is the whole workflow.',
    art: `<svg viewBox="0 0 200 120" class="tour-art" role="img" aria-label="A prefilled weight being confirmed with one tap">
      <rect x="34" y="40" width="132" height="34" rx="10" fill="none" stroke="var(--line)" stroke-width="2.5"/>
      <text x="100" y="63" fill="var(--text)" font-size="17" text-anchor="middle" font-weight="600">185 × 8</text>
      <circle cx="100" cy="57" r="0" fill="var(--accent)">
        <animate attributeName="r" values="0;54;54" dur="2.2s" begin="0.6s" keyTimes="0;0.35;1" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="0.3;0;0" dur="2.2s" begin="0.6s" keyTimes="0;0.35;1" repeatCount="indefinite"/>
      </circle>
      <text x="100" y="100" fill="var(--muted)" font-size="11" text-anchor="middle">tap once, the rest timer starts</text>
    </svg>`,
  },
];

function viewTour() {
  const step = Math.max(0, Math.min(state.tourStep, TOUR.length - 1));
  const card = TOUR[step];
  const last = step === TOUR.length - 1;

  return `<div class="tour">
    <div class="row-between mb-1.5">
      <span class="tiny mono muted">${step + 1} / ${TOUR.length}</span>
      ${last ? '' : '<button class="btn btn-sm btn-ghost" data-act="tour-done">Skip</button>'}
    </div>

    <div class="tour-stage">${card.art}</div>

    <h1 class="mx-0 mt-4.5 mb-2" style="font-size:22px">${esc(card.title)}</h1>
    <p class="sub min-h-20.5">${esc(card.body)}</p>

    <div class="tour-dots" aria-hidden="true">
      ${TOUR.map((_, i) => `<span class="tour-dot${i === step ? ' on' : ''}"></span>`).join('')}
    </div>

    <div class="row gap-2 mt-3.5">
      ${step > 0 ? '<button class="btn grow" data-act="tour-back">Back</button>' : ''}
      <button class="btn btn-primary grow" data-act="${last ? 'tour-done' : 'tour-next'}">
        ${last ? 'Start training' : 'Next'}
      </button>
    </div>
  </div>`;
}

/* ========================= the second walkthrough ======================= */

/**
 * What the app is about to ask for, and what it gives back.
 *
 * Three cards and then a question. Running this *after* the first walkthrough
 * is deliberate rather than cosmetic: somebody who has not yet understood that
 * every set goes to failure cannot evaluate an offer to spend a week finding
 * out what their failure weighs. So it runs second, and only for somebody
 * arriving through onboarding — reopening the first walkthrough from Setup
 * still ends at Train, which has been its contract since it was written.
 *
 * The drawings follow the same rule as the first walkthrough's: animate the
 * mechanism, not the noun. Here the mechanism is the one thing the app cannot
 * do for a new lifter — know what to put on the bar on day one.
 */
const PLAN_TOUR = [
  {
    title: 'The first weight is the hard one',
    body: 'Everything after it is arithmetic — the app reads what you lifted and works out '
      + 'what comes next. On day one it has nothing to read.',
    art: `<svg viewBox="0 0 200 120" class="tour-art" role="img" aria-label="A loaded bar with an unknown weight">
      <rect x="30" y="56" width="140" height="7" rx="3.5" fill="var(--line-strong)"/>
      <rect x="36" y="42" width="13" height="35" rx="3" fill="var(--surface-2)" stroke="var(--line)"/>
      <rect x="151" y="42" width="13" height="35" rx="3" fill="var(--surface-2)" stroke="var(--line)"/>
      <text x="100" y="34" text-anchor="middle" font-size="26" font-weight="700" fill="var(--accent)">
        ?
        <animate attributeName="opacity" values="1;0.25;1" dur="2.4s" repeatCount="indefinite"/>
      </text>
    </svg>`,
  },
  {
    title: 'One week answers it',
    body: 'Train the week as written and work up on each lift until the reps are honestly hard. '
      + 'That is the measurement. No max attempts, nothing to grind out.',
    art: `<svg viewBox="0 0 200 120" class="tour-art" role="img" aria-label="Three logged days producing a number">
      ${[0, 1, 2].map((i) => `<rect x="${24 + i * 34}" y="40" width="26" height="34" rx="4"
          fill="var(--surface-2)" stroke="var(--line)">
          <animate attributeName="fill" values="var(--surface-2);var(--accent-fill)"
            dur="0.5s" begin="${0.5 + i * 0.6}s" fill="freeze"/>
        </rect>`).join('')}
      <path d="M132 57 L150 57" stroke="var(--line-strong)" stroke-width="2"/>
      <text x="176" y="63" text-anchor="middle" font-size="19" font-weight="700" fill="var(--accent)" opacity="0">
        kg
        <animate attributeName="opacity" values="0;1" dur="0.5s" begin="2.4s" fill="freeze"/>
      </text>
    </svg>`,
  },
  {
    title: 'Or start from the averages',
    body: 'Skip it and you get a suggested weight per lift for somebody your size, age and '
      + 'training age. It is an estimate about a population, not about you.',
    art: `<svg viewBox="0 0 200 120" class="tour-art" role="img" aria-label="A distribution with one person marked on it">
      <path d="M20 86 Q60 86 80 54 Q100 22 120 54 Q140 86 180 86" fill="none"
        stroke="var(--line-strong)" stroke-width="2"/>
      <line x1="20" y1="86" x2="180" y2="86" stroke="var(--line)" stroke-width="1"/>
      <circle cx="100" cy="38" r="5" fill="var(--accent-fill)">
        <animate attributeName="cx" values="78;122;100" dur="3s" repeatCount="indefinite"/>
        <animate attributeName="cy" values="52;52;38" dur="3s" repeatCount="indefinite"/>
      </circle>
    </svg>`,
  },
];

/**
 * Who the estimate is for.
 *
 * Assembled at render time from the same places the energy screen reads, rather
 * than captured when the questions were answered: a bodyweight logged this
 * morning should move the estimate, and a sync that fills in an age should too.
 *
 * Bodyweight is the *smoothed* trend rather than the latest reading, which is
 * one reading when that is all there is. A single morning weight can be two
 * pounds off on water alone, and the whole module scales by `bodyweight^0.55`.
 */
function normsPerson() {
  return {
    sex: state.settings.sex,
    weightLb: bodyweightTrend(state.metrics).smoothed,
    age: state.settings.age,
    experience: state.settings.experience,
  };
}

/**
 * Enough about the body to estimate anything at all.
 *
 * Sex and bodyweight are load-bearing — each anchor is a multiple of bodyweight
 * measured separately per sex, so without both there is no number to scale.
 * Age is not in here on purpose: missing it costs the age correction and
 * `ageFactor` already defaults to the young-adult band, which is a far smaller
 * error than refusing to say anything.
 */
function normsKnows() {
  const { sex, weightLb } = normsPerson();
  return Boolean(sex) && Number(weightLb) > 0;
}

/** Has the question actually been answered, either way? */
function planAnswered() {
  return state.settings.planChoice === 'in' || state.settings.planChoice === 'out';
}

/** Enough to prescribe a week. Bodyweight is not part of it; see PRESCRIPTION_NEEDS. */
function planReady() {
  const d = state.planDraft ?? {};
  return Boolean(d.experience) && Number(d.daysPerWeek) > 0;
}

/**
 * The choice, with both paths named and costed.
 *
 * One is styled as the main action because measuring beats estimating for
 * everybody. That is a recommendation, not a default: nothing is recorded until
 * one of them is tapped, and the skip is a button of its own rather than a
 * greyed-out afterthought.
 */
function planChoicePanel() {
  return `<div class="plan-choice">
    <button class="btn btn-primary btn-block btn-lg" data-act="plan-in">Find my weights</button>
    <div class="tiny muted">
      One week of ordinary training, and after it every weight comes from what you actually lifted.
    </div>
    <button class="btn btn-block" data-act="plan-out">Estimate them for me instead</button>
    <div class="tiny muted">
      A suggested weight per lift from population averages for somebody of your size and age.
      Less accurate, and the first set corrects it.
    </div>
    <button class="btn btn-block btn-ghost btn-sm" data-act="plan-later">Not now</button>
  </div>`;
}

/** A rep target, which is sometimes a single number. See `testWeekPlan`. */
const repTarget = (reps) => (reps.min === reps.max ? `${reps.min} reps` : `${reps.min}-${reps.max} reps`);

/**
 * What to show in the weight column, including when there is nothing to show.
 *
 * Three different kinds of silence, said differently, because they are not the
 * same fact: there is no published anchor for this movement, the body *is* the
 * load here, or the app does not know enough about the person. A blank cell
 * reads as a bug and all three read as a blank cell.
 */
function estimateText(suggestion) {
  if (!suggestion || suggestion.weight === null) {
    return suggestion?.basis === 'bodyweight' ? 'bodyweight' : 'find it';
  }
  return formatWeight(suggestion.weight, unit());
}

function viewPlanQuestions() {
  const d = state.planDraft ?? {};

  return `<div class="px-1 py-4.5 plan-questions">
    <h1 class="mt-0 mx-0 mb-1.5">Shaping your week</h1>
    <p class="sub mb-5">
      Two answers decide what the week looks like. The third is optional, and everything
      in it is changeable afterwards.
    </p>

    <div class="card mb-3">
      <label class="tiny muted">How long have you been lifting?</label>
      <div class="mt-2">
        ${EXPERIENCE_BUCKETS.map((b) => `<button class="btn btn-block mb-1.5 text-left ${d.experience === b.id ? 'btn-primary' : ''}"
            data-act="q-experience" data-value="${esc(b.id)}">
            <div class="grow min-w-0">
              <b>${esc(b.label)}</b>
              <div class="tiny muted">${esc(b.says)}</div>
            </div>
          </button>`).join('')}
      </div>
    </div>

    <div class="card mb-3">
      <label class="tiny muted">Days a week you can train</label>
      <div class="day-pick mt-2">
        ${[1, 2, 3, 4, 5, 6, 7].map((n) => `<button class="btn ${Number(d.daysPerWeek) === n ? 'btn-primary' : ''}"
            data-act="q-days" data-value="${n}">${n}</button>`).join('')}
      </div>
    </div>

    <div class="card mb-4">
      <label class="tiny muted">A group to put the extra work into — optional</label>
      <div class="row wrap gap-1.5 mt-2">
        ${MUSCLE_GROUPS.map((g) => `<button class="btn btn-sm ${d.priority === g ? 'btn-primary' : ''}"
            data-act="q-priority" data-value="${esc(g)}">${esc(g)}</button>`).join('')}
      </div>
    </div>

    <button class="btn btn-primary btn-block btn-lg" data-act="plan-build" ${planReady() ? '' : 'disabled'}>
      Build my week
    </button>
  </div>`;
}

/**
 * The week, with a number against every lift in it.
 *
 * Which number depends on which path was taken, and that is the whole point of
 * the screen: the measuring path shows what to work up to, the estimating path
 * shows what to start with. Before this, both paths showed a list of lift names
 * and the estimate was never shown at all — a button reading "estimate them for
 * me" that recorded the choice and went to Train. The card before it promises a
 * suggested weight per lift, so the app made a specific offer and did not keep
 * it, which is worse than not offering: there is nothing to tell the person that
 * the thing they were promised is not on a screen they have not found yet.
 *
 * Both lists are per lift rather than one sentence at the top standing in for
 * all of them. A rep target that is right for a bench press and wrong for a
 * lateral raise is not a rep target.
 */
function viewPlanResult() {
  const p = state.planProgram;
  const nameOf = (id) => (state.boot.exercises ?? []).find((e) => e.id === id)?.name ?? id;
  const rir = p.rirTarget;
  const measuring = state.settings.planChoice !== 'out';

  const week = measuring ? testWeekPlan(p, { rirTarget: rir }) : null;
  const estimates = measuring
    ? null
    // No `targetReps`: each slot's own scheme decides that, and a week-wide
    // figure gave a lift programmed at 15-20 the load for a set of eight. The
    // reserve is the person's own, at its cautious end.
    : new Map(suggestionsFor(p, { ...normsPerson(), rir: Math.max(rir.low, rir.high) },
      { exercises: state.boot.exercises ?? [] }).map((s) => [s.exerciseId, s]));

  // `testWeekPlan` maps the days and the lifts in order, which `testweek.test.js`
  // asserts — so the index is the join, and there is no second lookup to fall
  // out of step with the first.
  const valueOf = (x, dayIndex, i) => (measuring
    ? repTarget(week.days[dayIndex].lifts[i].targetReps)
    : estimateText(estimates.get(x.exerciseId)));

  const head = measuring
    ? `<div class="card mt-3 mb-3 plan-measure">
        <b>${p.testWeek === 'required' ? 'Start with a test week' : 'A test week is worth doing'}</b>
        <div class="tiny muted mt-1">${esc(week.says)}</div>
      </div>`
    : `<div class="card mt-3 mb-3 plan-estimate">
        <b>Starting weights</b>
        <div class="tiny muted mt-1">
          ${normsKnows()
            ? 'What somebody your size, age and training age lifts on average. It is an estimate about a '
              + 'population and not about you, it errs light on purpose, and your first set is worth more than it is.'
            : 'These need your bodyweight and sex to mean anything, and this phone does not have them yet, '
              + 'so every lift below says to find it in a set instead. Adding them takes a moment and the '
              + 'estimates appear.'}
        </div>
        <div class="tiny muted mt-1">
          Top sets stop ${rir.low}-${rir.high} ${rir.high === 1 ? 'rep' : 'reps'} short of failure.
        </div>
        ${normsKnows() ? '' : `<button class="btn btn-sm btn-block mt-2" data-act="plan-fill-in">
          Add my weight and sex
        </button>`}
      </div>`;

  return `<div class="px-1 py-4.5 plan-result">
    <h1 class="mt-0 mx-0 mb-1.5">${esc(p.name)}</h1>

    ${p.notes.map((n) => `<div class="tiny muted plan-note mb-1">${esc(n)}</div>`).join('')}

    ${head}

    ${p.days.map((day, dayIndex) => `<div class="card plan-day mb-2">
        <b>${esc(day.name)}</b>
        <div class="mt-1.5">
          ${day.exercises.map((x, i) => `<div class="row-between plan-lift">
              <span class="tiny truncate">${esc(nameOf(x.exerciseId))}</span>
              <span class="tiny muted mono plan-lift-value">${esc(valueOf(x, dayIndex, i))}</span>
            </div>`).join('')}
        </div>
      </div>`).join('')}

    <button class="btn btn-primary btn-block btn-lg mt-3" data-act="plan-install">Use this week</button>
    <button class="btn btn-block btn-ghost mt-1.5" data-act="plan-redo">Change the answers</button>
  </div>`;
}

function viewPlan() {
  if (state.planStage === 'result' && state.planProgram) return viewPlanResult();
  if (state.planStage === 'questions') return viewPlanQuestions();

  const step = Math.max(0, Math.min(state.planStep, PLAN_TOUR.length - 1));
  const card = PLAN_TOUR[step];
  const last = step === PLAN_TOUR.length - 1;

  return `<div class="tour plan-tour${last ? ' plan-deciding' : ''}">
    <div class="row-between">
      <span class="tiny muted">${step + 1} / ${PLAN_TOUR.length}</span>
      ${last
        ? '<button class="btn btn-sm btn-ghost" data-act="plan-back">Back</button>'
        : '<button class="btn btn-sm btn-ghost" data-act="plan-later">Skip</button>'}
    </div>

    <h1 class="mt-2 mx-0 mb-1.5">${esc(card.title)}</h1>
    <p class="sub mb-3">${esc(card.body)}</p>

    <div class="tour-stage">${card.art}</div>

    <div class="tour-dots" aria-hidden="true">
      ${PLAN_TOUR.map((_, i) => `<span class="tour-dot${i === step ? ' on' : ''}" data-plan-dot="${i}"></span>`).join('')}
    </div>

    ${last
      ? planChoicePanel()
      : `<div class="row gap-2 mt-3">
          ${step > 0 ? '<button class="btn grow" data-act="plan-back">Back</button>' : ''}
          <button class="btn btn-primary grow" data-act="plan-next">Next</button>
        </div>`}
  </div>`;
}

/**
 * Put a prescribed week on the phone.
 *
 * Deliberately the same shape as `installMemberProgram`, including the part
 * that matters: the seeded programs are only cleared when there is **no history
 * at all**. A program with sets logged against it is somebody's training, and
 * removing it to tidy a screen would be destroying data to improve a layout.
 */
async function installPrescribed(program) {
  if (!state.boot || !program) return;

  let boot = upsertProgramIn(state.boot, {
    id: program.id,
    name: program.name,
    daysPerWeek: program.daysPerWeek,
  });

  const current = new Set(program.days.map((d) => d.id));
  const trained = new Set(state.sessions.map((s) => s.dayId));

  for (const day of boot.days ?? []) {
    if (day.programId !== program.id) continue;
    if (current.has(day.id) || trained.has(day.id)) continue;
    boot = removeDayFrom(boot, day.id);
  }

  const have = new Set((boot.days ?? []).map((d) => d.id));
  for (const day of program.days) {
    if (have.has(day.id)) continue;
    boot = upsertDayIn(boot, { ...day, programId: program.id });
  }

  /**
   * Clear the shipped templates, and **only** those.
   *
   * `installMemberProgram` removes every other program when there is no history,
   * which is right there: it runs during registration, and the two seeded
   * templates would otherwise turn a new member's Train tab into thirteen days
   * of which four are hers.
   *
   * Copying that rule here was a data-loss bug. A member registers, her coach's
   * four-day program is installed, and she has **no history yet** — so opting
   * into the weight-finding week and building a split would have deleted the
   * program somebody wrote for her, on her first day, with no warning. A week
   * this person asked for does not get to remove one they were given.
   */
  if (!state.sessions.length) {
    const shipped = new Set(PROGRAM_SEED.map((p) => p.id));
    for (const id of (boot.programs ?? []).map((p) => p.id)) {
      if (id !== program.id && shipped.has(id)) boot = removeProgramFrom(boot, id);
    }
  }

  await updateBoot(boot);
}

/**
 * The admin / my-own-training switch.
 *
 * He is both things — the person who administers the app and the person who
 * trains in it — and the two need different screens. Burying the way back inside
 * a "‹ Setup" breadcrumb made the admin screens feel like a dead end you had to
 * retrace out of.
 *
 * Only drawn for an admin, and the server does not care what this shows: every
 * admin route checks the role itself. A UI that hides a button is not a permission
 * model, it is a courtesy.
 */
function adminSwitch(current) {
  if (!isAdmin()) return '<button class="btn btn-sm btn-ghost" data-act="setup">‹ Setup</button>';

  const tab = (mode, label) =>
    `<button class="btn btn-sm grow ${current === mode ? 'btn-primary' : ''}"
       data-act="${mode === 'admin' ? 'accounts' : 'my-training'}">${label}</button>`;

  return `<div class="row gap-1.5 mb-1">
      ${tab('mine', 'My training')}
      ${tab('admin', 'Admin')}
    </div>`;
}

/* ========================= looking at a member =========================== */

/**
 * One member's training, read-only.
 *
 * Deliberately not "his app but with her data in it". Borrowing `state.sessions`
 * for somebody else's workouts would put her sets into the array the sync uploads
 * and the local store persists, and one missed reset later they would be his. So
 * this is a separate screen reading a separate snapshot, and the server refuses a
 * write with `?userId=` anyway — two independent reasons it cannot go wrong.
 *
 * An account with nothing in it is the **normal** early state and says so plainly.
 * A screen that is merely blank is indistinguishable from one that is broken,
 * which is exactly the confusion this replaced.
 */
function viewMember() {
  const person = state.viewingAs;
  if (!person) return viewAccounts();

  const weights = (person.metrics ?? [])
    .filter((m) => m.name === 'body_weight')
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const sessions = person.sessions ?? [];

  const rows = sessions.slice(0, 20).map((s) => {
    const lifts = new Map();
    for (const set of s.sets ?? []) {
      lifts.set(set.exerciseId, (lifts.get(set.exerciseId) ?? 0) + 1);
    }
    const names = [...lifts.keys()]
      .map((id) => state.boot?.exercises?.find((e) => e.id === id)?.name ?? id);

    return `<div class="card mb-2">
        <div class="row-between">
          <b>${esc(s.dayName ?? 'Workout')}</b>
          <span class="tiny mono muted">${esc(fmtDate(String(s.startedAt ?? '').slice(0, 10)))}</span>
        </div>
        <div class="tiny muted mt-1">
          ${(s.sets ?? []).length} set${(s.sets ?? []).length === 1 ? '' : 's'}
          ${names.length ? ` · ${esc(names.slice(0, 4).join(' · '))}${names.length > 4 ? ' …' : ''}` : ''}
        </div>
      </div>`;
  }).join('');

  const profile = person.profile ?? null;
  const said = profile && profile.onboardedAt;

  return `${adminSwitch('admin')}
    <button class="btn btn-sm btn-ghost" data-act="acct-view-self">‹ Accounts</button>
    <h1 class="mt-2">${esc(person.name)}</h1>
    <p class="sub">
      Read-only. Nothing here writes to their log, and your own training is untouched.
    </p>

    ${person.loading ? '<div class="empty">Fetching their workouts…</div>' : ''}
    ${person.error ? '<div class="card border-bad"><div class="tiny text-bad">Could not reach the server. Their training is not lost — this screen just could not load it.</div></div>' : ''}

    ${!person.loading && !person.error ? `
      <div class="card">
        <div class="row-between">
          <span class="tiny muted">Account</span>
          <span class="pill ${person.status === 'active' ? 'pill-good' : ''}">${esc(person.status)}</span>
        </div>
        <div class="row-between mt-2">
          <span class="tiny muted">Registered</span>
          <span class="tiny mono">${said ? 'yes' : 'not yet'}</span>
        </div>
        <div class="row-between mt-2">
          <span class="tiny muted">Workouts logged</span>
          <span class="tiny mono">${sessions.length}</span>
        </div>
        <div class="row-between mt-2">
          <span class="tiny muted">Weigh-ins</span>
          <span class="tiny mono">${weights.length}</span>
        </div>
        ${weights.length ? `<div class="row-between mt-2">
            <span class="tiny muted">Last weighed</span>
            <span class="tiny mono">${esc(formatBodyweight(weights[0].value, unit()))} · ${esc(fmtDate(weights[0].date))}</span>
          </div>` : ''}
      </div>

      ${sessions.length ? (() => {
        /**
         * What a coach opens this screen for.
         *
         * Everything below is composition — `analyzeAll`, `overallProgress`,
         * `checkCoverage` and `bodyweightTrend` were all already imported here
         * and simply never called, so the member's own phone computed a verdict
         * on every lift and this screen showed a list of dates.
         */
        /**
         * **Their** program, not his.
         *
         * This passed `state.boot`, so the coverage card below described the
         * admin's own program while sitting under her name — a gap reported
         * against a split she is not on, which reads as a finding about her.
         * Her program is already in the pull; it was simply not used.
         *
         * When it has not arrived, no coverage is computed at all and the card
         * says so. "No gaps" and "nothing was checked" must not render as the
         * same empty space, which is the exact failure this screen exists to fix.
         */
        const c = clientSummary({
          sessions,
          boot: person.program ?? { exercises: state.boot.exercises ?? [] },
          metrics: person.metrics ?? [],
        });

        const since = c.daysSince === null ? 'never'
          : c.daysSince === 0 ? 'today'
            : c.daysSince === 1 ? 'yesterday'
              : `${c.daysSince} days ago`;

        return `<h2 class="mt-4.5">Where they are</h2>
          <div class="glance">
            <div class="card p-2.5 text-center">
              <div class="mono n">${c.thisWeek}</div>
              <div class="tiny muted">this week</div>
            </div>
            <div class="card p-2.5 text-center">
              <div class="mono n">${c.needsAttention.length}</div>
              <div class="tiny muted">need attention</div>
            </div>
            <div class="card p-2.5 text-center">
              <div class="mono n text-md">${esc(since)}</div>
              <div class="tiny muted">last trained</div>
            </div>
          </div>

          ${c.overall && c.overall.status !== 'insufficient-data'
            ? `<div class="card"><div class="tiny muted"><b>Overall</b></div>
                 <div class="text-sm mt-1.5">${esc(c.overall.message)}</div>
               </div>`
            : ''}

          ${c.needsAttention.length
            ? `<h2>Worth a word</h2>
               ${c.needsAttention.slice(0, 5).map((f) => `<div class="card">
                   <div class="row-between mb-1.5">
                     <b>${esc(f.name)}</b>
                     <span class="pill ${f.status === 'regressing' ? 'pill-bad' : 'pill-warn'}">
                       ${f.status === 'regressing' ? 'Regressing' : 'Stalled'}
                     </span>
                   </div>
                   <div class="text-sm">${esc(f.message)}</div>
                 </div>`).join('')}
               ${c.needsAttention.length > 5
                 ? `<div class="tiny muted mb-2.5">and ${c.needsAttention.length - 5} more.</div>`
                 : ''}`
            : c.liftsJudged
              ? `<div class="card"><b class="tiny">Nothing is going backwards</b>
                   <div class="tiny muted mt-1.5">
                     All ${c.liftsJudged} lifts with enough history are holding or climbing.
                   </div>
                 </div>`
              : `<div class="card"><b class="tiny">No verdicts yet</b>
                   <div class="tiny muted mt-1.5">
                     A lift needs three sessions before its trend means anything.
                   </div>
                 </div>`}

          ${!c.programKnown
            ? `<div class="card">
                 <b class="tiny">Their program has not reached the cloud</b>
                 <div class="tiny muted mt-1.5">
                   So nothing here checks whether their week covers their body. Programs sync
                   upward only, from their phone — this is not a gap in their training, it is
                   a gap in what this screen can see.
                 </div>
               </div>`
            : c.coverageGaps.length
              ? `<div class="card border-warn">
                   <b class="tiny text-warn">Not getting hit twice a week</b>
                   <div class="row wrap gap-1.5 mt-2">
                     ${c.coverageGaps.map((g) => `<span class="pill pill-warn">${esc(g.muscleGroup)} · ${g.got}×</span>`).join('')}
                   </div>
                   <div class="tiny muted mt-2">
                     Counted over their own program, secondary muscles included.
                   </div>
                 </div>`
              : `<div class="card">
                   <b class="tiny">Their week covers their body</b>
                   <div class="tiny muted mt-1.5">
                     Every muscle group their program asks for is trained at least twice,
                     secondary muscles counted.
                   </div>
                 </div>`}

          ${c.weight.readings >= 2
            ? `<div class="card">
                 <div class="row-between">
                   <span class="tiny muted">Bodyweight</span>
                   <span class="tiny mono">${esc(formatBodyweight(c.weight.smoothed, unit()))}</span>
                 </div>
                 <div class="tiny muted mt-1.5">
                   ${c.weight.confident
                     ? `${c.weight.perWeek > 0 ? 'Up' : 'Down'} ${esc(formatBodyweight(Math.abs(c.weight.perWeek), unit()))} a week over ${c.weight.readings} readings.`
                     : `Steady over ${c.weight.readings} readings — not enough to call a direction yet.`}
                 </div>
               </div>`
            : ''}`;
      })() : ''}

      ${!sessions.length ? `<div class="card mt-3">
          <b class="tiny">Nothing logged yet</b>
          <div class="tiny muted mt-1.5">
            ${said
              ? 'They have set themselves up but have not trained yet. This fills in after their first workout.'
              : person.firstSeenAt
                ? 'They have opened the app but not finished setting it up, so there is nothing to show.'
                : 'They have not opened the app yet. Nothing is wrong — there is simply nothing there.'}
          </div>
        </div>` : `<h2>Recent workouts</h2>${rows}`}

      <button class="btn btn-block btn-ghost btn-sm mt-3" data-act="acct-view-refresh">
        Refresh
      </button>
    ` : ''}`;
}

/* ============================ signing in ================================ */

/**
 * The first screen on a phone nobody has used yet.
 *
 * One field. The cloud address is filled in rather than asked for, because it is
 * the same for everyone and "paste this URL and also this code" is two chances to
 * get it wrong on a phone. The code is what identifies her, and it is the only
 * thing she has that nobody else does.
 *
 * There is a way past it: he has run this app with no account at all for months
 * and a new install of his should not demand one. "Use this on my own" sets the
 * app up exactly as it behaves today.
 */
function viewWelcome() {
  return `<div class="px-1 py-6">
    <div class="tour-mark" aria-hidden="true">
      <svg viewBox="0 0 120 120" width="88" height="88">
        <circle cx="60" cy="60" r="52" fill="none" stroke="var(--accent)" stroke-width="3"
          stroke-dasharray="327" stroke-dashoffset="327" opacity="0.35">
          <animate attributeName="stroke-dashoffset" from="327" to="0" dur="1.1s" fill="freeze"/>
        </circle>
        <g stroke="var(--accent)" stroke-width="7" stroke-linecap="round" fill="none">
          <line x1="34" y1="60" x2="86" y2="60">
            <animate attributeName="x2" from="34" to="86" dur="0.5s" begin="0.5s" fill="freeze"/>
          </line>
          <line x1="34" y1="44" x2="34" y2="76" opacity="0">
            <animate attributeName="opacity" from="0" to="1" dur="0.3s" begin="0.9s" fill="freeze"/>
          </line>
          <line x1="86" y1="44" x2="86" y2="76" opacity="0">
            <animate attributeName="opacity" from="0" to="1" dur="0.3s" begin="0.9s" fill="freeze"/>
          </line>
        </g>
      </svg>
    </div>

    <h1 class="mx-0 mt-3.5 mb-1.5">Personal Trainer</h1>
    <p class="sub mb-5.5">
      A lifting log that works with no signal, and a coach that reads your own numbers
      back to you.
    </p>

    ${state.accountError ? `<div class="card border-bad mb-3.5">
        <div class="tiny text-bad">${esc(state.accountError)}</div>
      </div>` : ''}

    ${state.googleClientId ? `<div class="card mb-3">
        <div class="tiny muted mb-2.5">
          Use the Google account the invitation was sent to.
        </div>
        <div class="flex justify-center min-h-11" id="google-slot">
          <span class="spinner"></span>
        </div>
      </div>

      <div class="row gap-2.5 items-center mx-0 mt-1 mb-3">
        <div class="flex-1 h-px bg-line"></div>
        <span class="tiny muted">or</span>
        <div class="flex-1 h-px bg-line"></div>
      </div>` : ''}

    <div class="card">
      <label class="tiny muted">Your invitation code</label>
      <!--
        The value is rendered back from state, and that is not decoration. This box
        is the most important input in the app and the longest-lived: a render
        arriving from the Google config lookup, a sync landing, or the account
        fetch returning would otherwise wipe what she had just pasted, and the
        Continue button would then complain that the field is empty. The same
        class of bug already ate a typed bodyweight; CONTEXT.md says every
        long-lived input here has this exposure, and this one was new.
      -->
      <input class="input mono mx-0 mt-2 mb-3 text-xs" id="welcome-code" placeholder="paste it here"
        autocapitalize="off" autocorrect="off" spellcheck="false"
        value="${esc(state.codeDraft ?? '')}">
      <button class="btn btn-primary btn-block btn-lg" data-act="welcome-signin"
        ${state.signingIn ? 'disabled' : ''}>
        ${state.signingIn ? '<span class="spinner"></span> Signing in…' : 'Continue'}
      </button>
      <div class="tiny muted mt-2.5">
        It came in the email that sent you here. There is no password${state.googleClientId
          ? ' — this and the Google button do the same thing'
          : ' and nothing else to set up'}.
      </div>
    </div>

    <button class="btn btn-block btn-ghost btn-sm mt-4" data-act="welcome-solo">
      Use this on my own, with no account
    </button>
    <div class="tiny muted text-center mt-1.5">
      Everything works offline either way. An account is only what lets it back up
      and be read on a second device.
    </div>
  </div>`;
}

/* ========================== telling us about you ======================== */

/**
 * Six questions, asked once, before anything can be estimated.
 *
 * Blocking — the only blocking screen here — because every number downstream is
 * either wrong or silent without it. A resting burn needs height, age and sex; a
 * deficit needs a weight; whether a falling lift is a problem or the expected
 * price of a cut depends on which of those she chose. A guessed value would
 * produce a confident figure about nobody, so the app would rather ask.
 *
 * The answers are written **both** locally and to the cloud. Local is what the
 * estimates read, so they work with no signal; the cloud is what survives a new
 * phone.
 */
function viewRegister() {
  const d = state.registerDraft ?? {};
  const field = (key) => esc(d[key] ?? '');

  const goals = [
    ['cut', 'Losing fat', 'eating under maintenance'],
    ['recomp', 'Maingain', 'holding weight while building'],
    ['maintain', 'Maintaining', 'staying where I am'],
    ['bulk', 'Gaining', 'eating over maintenance'],
  ];

  return `<div class="px-1 py-4.5">
    <h1 class="mt-0 mx-0 mb-1.5">A few things about you</h1>
    <p class="sub mb-5">
      This is asked once. Without it the calorie and recovery numbers cannot be worked
      out at all, and a guess would be a confident number about nobody.
    </p>

    <div class="card mb-3">
      <div class="meta-grid">
        <div>
          <label class="tiny muted">Age</label>
          <input class="input mt-1.5" id="reg-age" type="number" inputmode="numeric" min="13" max="100"
            placeholder="e.g. 27" value="${field('age')}">
        </div>
        <div>
          <label class="tiny muted">Height (inches)</label>
          <input class="input mt-1.5" id="reg-height" type="number" inputmode="decimal" min="36" max="96"
            placeholder="e.g. 64" value="${field('heightInches')}">
        </div>
      </div>
      <div class="tiny muted mt-1.5">5'4" is 64 inches.</div>
    </div>

    <div class="card mb-3">
      <label class="tiny muted">Sex — the resting burn formula needs it</label>
      <div class="row gap-2 mt-2">
        ${['female', 'male'].map((v) => `<button class="btn grow ${d.sex === v ? 'btn-primary' : ''}"
            data-act="reg-sex" data-value="${v}">${v === 'female' ? 'Female' : 'Male'}</button>`).join('')}
      </div>
    </div>

    <div class="card mb-3">
      <label class="tiny muted">Bodyweight (lb)</label>
      <input class="input mx-0 mt-1.5 mb-1" id="reg-weight" type="number" inputmode="decimal" min="50" max="600" step="0.1"
        placeholder="e.g. 132.4" value="${field('weight')}">
      <div class="tiny muted">
        Logged as today's reading. Weigh yourself the same way each morning and the trend
        does the rest — day to day it moves on salt and water, not fat.
      </div>
    </div>

    <div class="card mb-3">
      <label class="tiny muted">Body fat, as a range you believe</label>
      <div class="meta-grid mt-1.5">
        <input class="input" id="reg-bf-low" type="number" inputmode="decimal" min="3" max="60"
          placeholder="e.g. 24" value="${field('bodyFatLow')}">
        <input class="input" id="reg-bf-high" type="number" inputmode="decimal" min="3" max="60"
          placeholder="e.g. 28" value="${field('bodyFatHigh')}">
      </div>
      <div class="tiny muted mt-1.5">
        Optional, and an eye estimate is fine — nobody knows this to a decimal. A range
        is an honest answer where a single number is not.
      </div>
    </div>

    <div class="card mb-3">
      <label class="tiny muted">Steps on a normal day</label>
      <input class="input mx-0 mt-1.5 mb-1" id="reg-steps" type="number" inputmode="numeric" min="0" max="60000"
        placeholder="e.g. 7000" value="${field('averageSteps')}">
      <div class="tiny muted">
        A starting point only. Real readings replace it as soon as there are any.
      </div>
    </div>

    <div class="card mb-4">
      <label class="tiny muted">What you are doing right now</label>
      <div class="mt-2">
        ${goals.map(([value, label, hint]) => `<button class="btn btn-block ${d.goal === value ? 'btn-primary' : ''} mb-1.5 text-left"
            data-act="reg-goal" data-value="${value}">
            <b>${label}</b> <span class="tiny muted">— ${hint}</span>
          </button>`).join('')}
      </div>
    </div>

    ${state.accountError ? `<div class="tiny text-bad mb-2.5">${esc(state.accountError)}</div>` : ''}

    <button class="btn btn-primary btn-block btn-lg" data-act="reg-save">Start training</button>
    <div class="tiny muted text-center mt-2">
      All of it is changeable later in Setup.
    </div>
  </div>`;
}

/* ============================== the accounts =========================== */

/**
 * Who has access, and adding somebody.
 *
 * Admin only, and it is the *server* that enforces that — this screen merely
 * does not draw. A UI that hides a button it is the only thing preventing is not
 * a permission model.
 *
 * Creating an account shows the invitation code **once**. Only its hash is
 * stored, so there is no screen that can show it again and the honest thing is to
 * say so on the spot rather than let it be discovered later.
 */
function viewAccounts() {
  if (!isAdmin()) return viewSetup();

  const users = state.accounts ?? null;

  /**
   * Each row names the authority, not the column.
   *
   * `roleLabel` rather than `u.role`: somebody who can set up a building's
   * machine list is not "a member" to the person reading this screen, whatever
   * `users.role` says. The authority is an edge, and a column cannot hold it —
   * which is the whole reason gym admin is a relationship.
   */
  const rows = (users ?? [])
    .map((u) => `<div class="card mb-2 p-3">
        <div class="row-between">
          <div class="min-w-0">
            <b class="text-sm">${esc(u.name)}</b>
            <div class="tiny muted break-all">${esc(u.email)}</div>
          </div>
          <span class="pill ${u.status === 'active' ? 'pill-good' : u.status === 'suspended' ? 'pill-warn' : ''}">
            ${esc(u.status)}
          </span>
        </div>
        <div class="tiny muted mt-1.5">
          ${esc(roleLabel(u).toLowerCase())}
          ${(u.gymAdminOf ?? []).length
            ? ` · runs ${(u.gymAdminOf ?? []).length} gym${u.gymAdminOf.length === 1 ? '' : 's'}`
            : ''}
          ${u.firstSeenAt ? ` · first opened it ${esc(daysAgo(u.firstSeenAt))}` : ' · has not opened it yet'}
        </div>
        ${u.role === 'admin' ? '' : `<div class="row gap-1.5 mt-2.5">
            <button class="btn btn-sm grow" data-act="acct-view" data-id="${esc(u.id)}">See their training</button>
            <button class="btn btn-sm btn-ghost grow" data-act="coach-offer" data-id="${esc(u.id)}">Offer to coach</button>
            <button class="btn btn-sm btn-ghost grow" data-act="acct-rotate" data-id="${esc(u.id)}">New code</button>
          </div>
          <button class="btn btn-sm btn-block btn-ghost ${u.status === 'suspended' ? '' : 'danger'} mt-1.5"
            data-act="acct-status" data-id="${esc(u.id)}" data-status="${u.status === 'suspended' ? 'active' : 'suspended'}">
            ${u.status === 'suspended' ? 'Restore access' : 'Suspend access'}
          </button>`}
      </div>`)
    .join('');

  return `${adminSwitch('admin')}
    <h1 class="mt-2">Accounts</h1>
    <p class="sub">
      Access is by invitation only — an account has to exist before anyone can sign in,
      and nobody can create one for themselves.
    </p>


    ${users === null
      ? '<div class="empty">Loading…</div>'
      : rows || '<div class="empty">Only you, so far.</div>'}

    <button class="btn btn-primary btn-block mt-3.5" data-act="acct-invite">
      Invite somebody
    </button>`;
}

/**
 * Who may see your training, and what you may see of somebody else's.
 *
 * Coaching is a relationship rather than a role, so this is two lists: people
 * who have asked to coach you, and people you coach. The three consents are
 * separate switches because they are three different questions — "see my
 * training" and "see my weigh-ins" are not the same thing, and one bundled
 * scale would be granted by default by anybody who thought about the first and
 * not the second.
 *
 * Everything defaults to off, and only the person being coached can change it.
 * The card renders even when both lists are empty, because an absent card reads
 * as "this app does not share your data" — which is true today and would stop
 * being true the moment somebody asked.
 */
function renderCoaching() {
  const c = state.coaching;
  const coaches = c?.coaches ?? [];
  const clients = c?.clients ?? [];

  if (!state.account) return '';

  const toggle = (coachId, key, on, label, blurb) => `<label class="row gap-2.5 mt-3 items-start">
      <input type="checkbox" data-act="consent" data-coach="${esc(coachId)}" data-key="${esc(key)}" ${on ? 'checked' : ''}>
      <span class="min-w-0">
        <span class="tiny"><b>${esc(label)}</b></span>
        <span class="tiny muted block">${esc(blurb)}</span>
      </span>
    </label>`;

  return `<h2>Coaching</h2>
    ${coaches.length
      ? coaches.map((edge) => `<div class="card mb-2.5">
          <b>${esc(edge.name)}</b>
          <div class="tiny muted break-all">${esc(edge.email ?? '')}</div>
          <div class="tiny muted mt-2">
            They asked to coach you. Nothing is shared until you say so, and you can
            take any of it back at any time.
          </div>
          ${toggle(edge.coachId, 'readTraining', edge.readTraining,
            'My training', 'Workouts, sets and the verdicts worked out from them.')}
          ${toggle(edge.coachId, 'readBody', edge.readBody,
            'My weight and food', 'Weigh-ins, calories and the energy figures built on them.')}
          ${toggle(edge.coachId, 'assign', edge.assign,
            'Suggest my week', 'They can propose a week. You still decide whether to take it.')}
        </div>`).join('')
      : `<div class="card">
           <div class="tiny muted">
             Nobody is coaching you. If somebody asks, they appear here with three switches
             and all three off — your training is not shared until you turn one on.
           </div>
         </div>`}

    ${clients.length
      ? `<div class="card mt-2.5">
           <b class="tiny">You coach</b>
           ${clients.map((edge) => {
             const allowed = [
               edge.readTraining ? 'training' : null,
               edge.readBody ? 'weight and food' : null,
               edge.assign ? 'can suggest a week' : null,
             ].filter(Boolean);

             return `<div class="row-between px-0 py-2 border-t border-line" data-client="${esc(edge.clientId)}">
                 <span class="min-w-0">
                   <span class="tiny"><b>${esc(edge.name)}</b></span>
                   <span class="tiny muted block">
                     ${allowed.length ? esc(allowed.join(' · ')) : 'nothing shared yet'}
                   </span>
                 </span>
                 ${edge.readTraining
                   ? `<button class="btn btn-sm" data-act="acct-view" data-id="${esc(edge.clientId)}">Open</button>`
                   : '<span class="tiny muted">waiting</span>'}
               </div>`;
           }).join('')}
         </div>`
      : ''}`;
}

function viewSetup() {
  const pending = dirtySessions().length;
  const you = renderYou();
  // The plate set follows the unit, because the two lists are different plates
  // rather than the same plates renamed: 20 kg is 44.09 lb, which no pound grid
  // can make.
  const plates = platesFor(unit());
  const ownedPlates = platesNow();

  const toggles = plates
    .map((p) => {
      // Against the list for *this* unit. Checking the pound list told a metric
      // user their gym had 25/10/5/2.5 kg and no 20 or 15, because those
      // numbers coincide with the pound defaults.
      const on = ownedPlates.includes(p);
      // `aria-pressed`, like every other toggle in the app. These signalled
      // their state with a background colour alone, so a screen reader could
      // not tell which plates the gym has.
      return `<button class="btn btn-sm" data-act="toggle-plate" data-p="${p}"
        aria-pressed="${on}"
        style="${on ? 'background:var(--accent);color:var(--accent-ink);border-color:transparent' : ''}">${p}</button>`;
    })
    .join('');

  /**
   * Four sections, because ten `h2`s in one scroll is a filing cabinet.
   *
   * It held the plate toggles, the rest timer, You, offline, account, sync,
   * Apple Health, bug reports, data and the build numbers — roughly 46 controls
   * in an unbroken column, and the thing it is opened for most often, today's
   * weight, sat four screens down behind the plates.
   *
   * Grouped by the question each one answers, with the same rule the Coach tab
   * is held to: **nothing is more than one tap away.** The strip renders in all
   * four, nothing is nested, and nothing was removed on the way.
   *
   * `you` is the default for the same reason `now` is the Coach tab's.
   */
  const SECTIONS = [
    ['you', 'You'],
    ['training', 'Training'],
    ['account', 'Account'],
    ['app', 'App'],
  ];
  const open = SECTIONS.some(([id]) => id === state.setupTab) ? state.setupTab : 'you';

  const strip = `<div class="tabs">
      ${SECTIONS.map(([id, label]) => `<button class="${open === id ? 'on' : ''}"
          data-act="setup-tab" data-tab="${id}" aria-pressed="${open === id}">${esc(label)}</button>`).join('')}
    </div>`;

  const level = levelOf(state.account, state.settings);

  /**
   * The detail level, as two cards rather than a checkbox.
   *
   * A checkbox labelled "advanced mode" makes somebody guess what is behind it.
   * Naming what each one records is the only way the choice can be made without
   * trying both, and the words are what the person would say, not field names.
   */
  const levelCard = (id, title, blurb) => `<button class="pick ${level === id ? 'on' : ''}"
      data-act="level-${id}" aria-pressed="${level === id}">
      <b>${esc(title)}</b>
      <span class="tiny muted">${esc(blurb)}</span>
    </button>`;

  const body = {};

  /**
   * A section of a Setup tab that folds away.
   *
   * The four tabs fixed ten `h2`s in one scroll; the **You** tab then grew back
   * into the same shape underneath one of them — measured at 3.96 screens
   * against 2.07, 2.18 and 1.67 for the other three, with eleven inputs under a
   * single heading.
   *
   * What folds is decided by how often a thing is touched, not by what it is
   * about. Today's reading is why the tab gets opened, so it stays in the open.
   * Height, age and body fat are answered once and then left alone; the energy
   * figures are read rather than edited. Both of those fold.
   *
   * The label carries the answers, so a closed fold still says what is inside
   * it — `69 in · 35 · 16-19%` rather than a chevron and the word "more". A
   * fold whose label says nothing is a mystery box, and the section strip above
   * it exists precisely because mystery boxes were the problem.
   *
   * Still one tap, which is the rule the sections are held to and the reason
   * this is a fold rather than another tab.
   */
  const fold = (id, label, inner) => {
    const open = state.setupOpen.includes(id);
    return `<div class="card p-0 mt-2.5">
      <button class="btn btn-block disclosure" data-act="setup-fold" data-fold="${esc(id)}"
          aria-expanded="${open}">
        <span class="grow min-w-0 text-left">
          <b class="tiny">${esc(label.title)}</b>
          <span class="tiny muted block truncate">${esc(label.says)}</span>
        </span>
        <span class="chev" aria-hidden="true"></span>
      </button>
      ${open ? `<div class="px-3.5 pb-3.5">${inner}</div>` : ''}
    </div>`;
  };

  /**
   * The fortnight of past days, which is most of the tab's height.
   *
   * Fourteen rows at about sixty pixels each is half the screen before anything
   * else is drawn, and the reason to open any of them — a reading logged on the
   * wrong day — is occasional. The label carries the only thing worth knowing
   * from outside: how many of those days have anything in them.
   */
  const earlierLabel = (you) => {
    const filled = you.rows ? (you.rows.match(/data-act="edit-day"/g) ?? []).length : 0;
    return {
      title: 'Earlier days',
      says: filled
        ? `The last ${filled} days, and any date before them`
        : 'Fix a reading logged on the wrong day',
    };
  };

  /** What the folded "about you" section already knows, said on its own label. */
  const aboutLabel = () => {
    const s = state.settings;
    const bits = [
      s.heightInches ? `${s.heightInches} in` : null,
      s.age ? `${s.age}` : null,
      s.bodyFatLow && s.bodyFatHigh ? `${s.bodyFatLow}-${s.bodyFatHigh}%` : null,
      s.goal || null,
    ].filter(Boolean);

    return {
      title: 'About you',
      says: bits.length ? bits.join(' · ') : 'Height, age, body fat — all optional, all blank',
    };
  };

  /** And the energy fold, which leads with the figure somebody opens it for. */
  const energyLabel = () => {
    const weight = bodyweightTrend(state.metrics);
    return {
      title: 'Energy',
      says: weight.smoothed === null
        ? 'Log a weight and this starts working'
        : `${restingSpan() ?? `${esc(String(weight.smoothed))} lb`} · burn, intake and what the scale did`,
    };
  };

  const u = unit();

  /**
   * Pounds or kilos, as two cards rather than a dropdown.
   *
   * The sentence underneath is the important part. A unit switch is exactly the
   * control somebody would expect to rewrite their history, and it does not:
   * every set stays the total load moved in pounds, and this changes what the
   * screen prints. Saying so is cheaper than having to be asked.
   */
  const unitCard = (id, title, blurb) => `<button class="pick ${u === id ? 'on' : ''}"
      data-act="unit-${id}" aria-pressed="${u === id}">
      <b>${esc(title)}</b>
      <span class="tiny muted">${esc(blurb)}</span>
    </button>`;

  body.training = `<h2>Weights in</h2>
    <div class="card">
      <div class="picks mb-2.5">
        ${unitCard('lb', 'Pounds', 'Plates of 45, 35, 25, 10, 5 and 2.5.')}
        ${unitCard('kg', 'Kilos', 'Plates of 25, 20, 15, 10, 5, 2.5 and 1.25.')}
      </div>
      <div class="tiny muted">
        Only what you read and type. Every workout you have logged is kept exactly as it
        was — nothing is converted or rewritten, and switching back shows the same numbers
        you started with.
      </div>
    </div>

    <h2>How much to ask you</h2>
    <div class="card">
      <div class="picks mb-2.5">
        ${levelCard('basic', 'Just the lift',
          'Weight, reps, and which machine. Everything a workout is.')}
        ${levelCard('full', 'Everything',
          'Adds tempo, straps and belts, how each set felt, and bundling lifts into one round.')}
      </div>
      <div class="tiny muted">
        ${level === 'basic'
          ? 'The coach will say so when a verdict needed something this level does not record.'
          : 'Fourteen things per set. Turn it down any time — nothing already logged is lost.'}
      </div>
    </div>

    <h2>Plates in your gym</h2>
    <div class="card">
      <div class="row wrap gap-2">${toggles}</div>
      <div class="tiny muted mt-2.5">
        In ${esc(unit())}. Every prescribed weight is rounded to something these plates can
        actually make.
      </div>
    </div>

    <h2>Rest timer</h2>
    <div class="card">
      <label class="tiny muted">Default rest between sets (seconds)</label>
      <input class="input mono mt-2" type="number" inputmode="numeric" data-act="rest-default"
        value="${state.settings.defaultRestSeconds}">
    </div>

    <h2>Gyms near you</h2>
    <div class="card">
      <label class="tiny muted">Only offer gyms within this many miles</label>
      <input class="input mono mt-2" type="number" inputmode="numeric" data-act="gym-radius"
        min="${RADIUS_MILES.min}" max="${RADIUS_MILES.max}"
        value="${state.settings.gymRadiusMiles ?? RADIUS_MILES.default}">
      <div class="tiny muted mt-2">
        Gyms you have trained at, and your own, are always offered — this only
        shortens the list of everybody else's. Anything further away is one tap
        down the sheet, and with no location fix the whole list comes back.
      </div>
    </div>

`;

  body.you = `<h2>You</h2>
    <div class="card">

      <div class="row-between mb-1">
        <span class="tiny muted"><b>Today</b></span>
        ${you.todayPending ? '<span class="tiny muted">queued to upload</span>' : ''}
      </div>
      ${renderDayRow(you.today, you.todayValues)}
      <button class="btn btn-primary btn-block mt-2" data-act="save-today">Save today</button>

      <!--
        Underneath the action, not above it.

        This paragraph is the reason to log a weight at all and is worth
        keeping — but sitting above the fields it pushed Save today under the
        nav bar at iPhone height, so the one thing this tab exists for was off
        screen. Read once and skipped forever is exactly the shape of content
        that belongs below the fold rather than in front of it.

        Hiding it from returning users was tried first and was the wrong fix: it
        showed precisely when it did the damage, since the person with nothing
        logged is both the one who needs the explanation and the one who needs
        the button.
      -->
      <div class="tiny muted mt-3">
        Strength on its own is a half-reading. Holding a lift while you lose weight is a
        win, and without this the coach calls it a stall. All optional — blank stays
        blank, and unknown is reported as unknown rather than guessed at.
      </div>
    </div>

    ${fold('earlier', earlierLabel(you), `
      ${you.count ? `<div class="tiny muted mx-0 mb-1">Tap any day to add or fix it</div>${you.rows}` : ''}

      <div class="row gap-2 mt-3 items-center">
        <span class="tiny muted flex-none">Older day</span>
        <input class="input mono grow" type="date" data-act="pick-day" max="${esc(you.today)}" value="">
      </div>
      <div class="tiny muted mt-1.5">
        For anything past the fortnight above — or to move a reading you logged just after
        midnight onto the day it belongs to.
      </div>
    `)}

    ${fold('about', aboutLabel(), `
      <div class="row gap-2">
        <div class="grow">
          <label class="tiny muted">Height (in)</label>
          <input class="input mono mt-2" data-act="height" inputmode="numeric" placeholder="69"
            value="${state.settings.heightInches ?? ''}">
        </div>
        <div class="grow">
          <label class="tiny muted">Age</label>
          <input class="input mono mt-2" data-act="age" inputmode="numeric" placeholder="35"
            value="${state.settings.age ?? ''}">
        </div>
      </div>

      <div class="row gap-2 mt-3">
        <div class="grow">
          <label class="tiny muted">Body fat from (%)</label>
          <input class="input mono mt-2" data-act="bf-low" inputmode="numeric" placeholder="e.g. 16"
            value="${state.settings.bodyFatLow ?? ''}">
        </div>
        <div class="grow">
          <label class="tiny muted">to (%)</label>
          <input class="input mono mt-2" data-act="bf-high" inputmode="numeric" placeholder="e.g. 19"
            value="${state.settings.bodyFatHigh ?? ''}">
        </div>
      </div>
      <div class="tiny muted mt-1.5">
        A range, not a number — an eye-test estimate is honest and a decimal place is not.
      </div>
      ${(() => {
        // Three states, not two: with no weight at all nothing is being
        // computed, and saying "using Mifflin" there would be a claim about
        // arithmetic that is not running.
        if (bodyweightTrend(state.metrics).smoothed === null) {
          return `<div class="tiny muted mt-1.5">
            Log a weight and this starts working.
          </div>`;
        }
        return restingMethod() === 'katch'
          ? `<div class="tiny ok mt-1.5">Using Katch-McArdle off your lean mass.</div>`
          : `<div class="tiny mt-1.5 text-warn">
               Not set — the burn is using Mifflin-St Jeor, which charges muscle and fat the
               same and understates a muscular build. Fill both boxes to switch.
             </div>`;
      })()}

      <label class="tiny muted block mt-3">Maintenance calories (optional — the scale works it out)</label>
      <input class="input mono mx-0 mt-2 mb-3" data-act="maintenance" inputmode="numeric" placeholder="e.g. 2600"
        value="${state.settings.maintenanceCalories ?? ''}">

      <label class="tiny muted">What you are doing right now</label>
      <select class="input mx-0 mt-2 mb-3" data-act="goal">
        ${[
          ['', 'not saying'],
          ['cut', 'cutting — losing fat'],
          ['maintain', 'maintaining'],
          ['bulk', 'bulking — gaining'],
          ['recomp', 'recomp — both at once'],
        ].map(([v, label]) =>
          `<option value="${v}" ${(state.settings.goal ?? '') === v ? 'selected' : ''}>${esc(label)}</option>`,
        ).join('')}
      </select>

    `)}

    ${fold('energy', energyLabel(), `
      <div class="tiny muted">${esc(you.ctx.summary)}</div>
      ${renderEnergy()}
      ${renderDailyEnergy()}
      <div class="tiny muted mt-2">
        Bodyweight, calories and macros come from the Health shortcut — see HEALTH.md.
        Log <span class="mono">body_weight</span>, <span class="mono">dietary_energy</span>
        and <span class="mono">protein</span> and they appear here.
      </div>
    `)}
`;

  // Offline belongs with the App section, but sits here in the source because
  // this is where it was written. Named rather than moved, so the diff stays
  // readable.
  const offline = `<h2>Offline</h2>
    <div class="card">
      <div class="row-between" style="margin-bottom:${state.offlineReady === false ? '10px' : '0'}">
        <span class="tiny muted">Works with no signal</span>
        <span class="pill ${state.offlineReady ? 'pill-good' : state.offlineReady === false ? 'pill-bad' : ''}">
          ${state.offlineReady === null ? 'checking…' : state.offlineReady ? 'ready' : 'NOT ready'}
        </span>
      </div>
      ${state.offlineReason ? `<div class="tiny text-bad">${esc(state.offlineReason)}</div>` : ''}
    </div>

`;

  body.account = `<h2>Account</h2>
    <div class="card">
      ${state.account
        ? `<div class="row-between">
             <div class="min-w-0">
               <b>${esc(state.account.name ?? 'You')}</b>
               <div class="tiny muted break-all">${esc(state.account.email ?? '')}</div>
             </div>
             <span class="pill ${isAdmin() ? 'pill-good' : ''}">${isAdmin() ? 'administrator' : 'member'}</span>
           </div>
           ${isAdmin()
             ? '<button class="btn btn-block mt-3" data-act="accounts">Accounts and invitations</button>'
             : ''}`
        : `<div class="tiny muted">
             Not signed in. Everything works on this phone alone — an account is only what
             lets it back up and be read on a second device.
           </div>`}
      <label class="row gap-2.5 mt-3.5">
        <input type="checkbox" data-act="video-toggle"
          ${(state.account?.profile?.showExerciseVideo ?? state.settings.showExerciseVideo) ? 'checked' : ''}>
        <span class="tiny">Show how each exercise is done</span>
      </label>
      <button class="btn btn-block btn-ghost btn-sm mt-3" data-act="tour-open">
        Show me around again
      </button>
      <button class="btn btn-block btn-ghost btn-sm mt-1.5" data-act="plan-open">
        ${planAnswered() ? 'Build me a week again' : 'Build me a week'}
      </button>
    </div>

    ${renderCoaching()}

    <h2>Sync</h2>
    <div class="card">
      <div class="tiny muted mb-3">
        Optional. Everything already works without it — this only copies your logs
        somewhere they also exist.
      </div>
      <button class="btn btn-sm btn-block btn-ghost mb-3" data-act="use-cloud">
        Use the shared cloud
      </button>

      <label class="tiny muted">Your PC's address</label>
      <input class="input mono mx-0 my-2 text-xs" data-act="server-url" inputmode="url" autocapitalize="off" autocorrect="off"
        spellcheck="false" placeholder="https://your-pc.local:8443"
        value="${esc(state.settings.serverUrl ?? '')}">
      <div class="tiny muted mb-3">
        The app is served from GitHub, so it cannot guess where your PC is. Leave this
        blank and there is nothing to sync to.
      </div>
      <label class="tiny muted">Access token</label>
      <input class="input mono mx-0 mt-2 mb-3 text-xs" type="password" data-act="auth-token" autocapitalize="off" autocorrect="off"
        spellcheck="false" placeholder="leave blank for a PC on your own network"
        value="${esc(state.settings.authToken ?? '')}">

      <button class="btn btn-block btn-sm mb-3" data-act="test-server">Test connection</button>

      <div class="row-between mb-2.5">
        <span class="tiny muted">PC server</span>
        <span class="pill ${state.online ? 'pill-good' : ''}">${state.online ? 'reachable' : 'not reachable'}</span>
      </div>
      <div class="row-between mb-2.5">
        <span class="tiny muted">Not yet backed up</span>
        <span class="tiny mono">${pending} session${pending === 1 ? '' : 's'}</span>
      </div>
      <div class="row-between mb-3">
        <span class="tiny muted">Last sync</span>
        <span class="tiny mono">${state.lastSync ? esc(daysAgo(state.lastSync)) : 'never'}</span>
      </div>
      <button class="btn btn-block" data-act="sync" ${state.syncing ? 'disabled' : ''}>
        ${state.syncing ? '<span class="spinner"></span> Backing up…' : 'Back up now'}
      </button>
    </div>

    <h2>Apple Health</h2>
    <div class="card">
      <div class="tiny muted mb-2.5">
        Apple gives web apps no access to Health, so this cannot read your watch directly.
        An iOS Shortcut can, and can post to your server on a schedule.
      </div>
      <div class="row-between mb-2.5">
        <span class="tiny muted">Readings stored</span>
        <span class="tiny mono">${state.metrics.length}</span>
      </div>
      <div class="tiny muted break-all">
        Post to <b>${esc(state.settings.serverUrl || '<your server>')}/api/metrics</b><br>
        with your access token. See <b>HEALTH.md</b> in the repo for the exact Shortcut.
      </div>
    </div>

`;

  body.app = offline + `<h2>Found a bug?</h2>
    <div class="card">
      <div class="tiny muted mb-2.5">
        Write it down the moment you hit it. Works with no signal — it uploads with your next sync.
      </div>
      <button class="btn btn-block" data-act="report-bug">Report a bug</button>
      ${state.notes.filter((n) => !isLiftNote(n)).length
        ? `<div class="mt-3">${state.notes
            .filter((n) => !isLiftNote(n))
            .slice(-5)
            .reverse()
            .map(
              (n) => `<div class="tiny px-0 py-2 border-t border-line">
                <div>${esc(n.text)}</div>
                <div class="muted mt-1">${fmtDate(n.createdAt)} · ${esc(n.context ?? '')}${n._dirty ? ' · not uploaded' : ''}</div>
              </div>`,
            )
            .join('')}</div>`
        : ''}
    </div>

    <h2>Data</h2>
    <div class="card">
      <button class="btn btn-block mb-2" data-act="import-log">Paste in a workout</button>
      <button class="btn btn-block mb-2" data-act="export">Export all sessions (JSON)</button>
      <button class="btn btn-block btn-ghost mb-2" data-act="reset-program">
        Reset program to the built-in one
      </button>
      <button class="btn btn-block btn-ghost" data-act="reload-boot">Refresh program from PC server</button>
      <div class="tiny muted mt-2.5">
        Resetting replaces your day templates. Every workout you have logged is kept.
      </div>
    </div>

    <h2>This build</h2>
    <div class="card">
      <div class="tiny muted mb-2.5">
        If something looks out of date, these numbers say what your phone is actually running.
      </div>
      <div class="row-between"><span class="tiny muted">Build</span><span class="tiny mono">${esc(BUILD)}</span></div>
      <div class="row-between"><span class="tiny muted">Exercise library</span><span class="tiny mono">${(state.boot.exercises ?? []).filter((e) => !e.archived).length} lifts</span></div>
      <div class="row-between"><span class="tiny muted">Program version</span><span class="tiny mono">${state.boot.seedVersion ?? 'older than 2'}</span></div>
      <div class="row-between"><span class="tiny muted">Sessions on this phone</span><span class="tiny mono">${(state.sessions ?? []).length}</span></div>
    </div>`;

  return `<h1>Setup</h1>${strip}${body[open]}`;
}

/* ================================ editor ================================ */

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';



function markDirty() {
  const first = !state.draftDirty;
  state.draftDirty = true;
  if (first) render();
}

function viewEdit() {
  const programs = state.boot.programs ?? [];
  const days = state.boot.days ?? [];

  /**
   * No warning. Editing works with no server, and saying otherwise was false.
   *
   * `saveDraftDay` writes through `updateBoot` to IndexedDB and `mirror()` is
   * fire-and-forget — the phone owns the program, which is the whole design. The
   * amber card keyed off `state.online`, which is set by a `/api/health` request
   * that 404s on a static host: i.e. **always**, on the live install. So the one
   * screen for building a program permanently told you to go home and try again,
   * about something that already worked.
   */
  const warning = '';

  const groups = programs
    .map((p) => {
      const mine = days.filter((d) => d.programId === p.id);
      const rows = mine
        .map(
          (d) => `<button class="card card-tap" data-act="edit-program-day" data-id="${esc(d.id)}">
            <div class="row-between">
              <div class="grow min-w-0">
                <b>${esc(d.name)}</b>
                <div class="tiny muted mt-1 truncate">
                  ${esc(d.exercises.map((e) => e.name).join(' · ')) || 'no exercises yet'}
                </div>
              </div>
              <span class="pill">${d.exercises.length}</span>
              <div class="text-muted" style="font-size:22px">›</div>
            </div>
          </button>`,
        )
        .join('');

      return `<div class="row-between mx-0 mt-6 mb-2.5">
          <h2 class="m-0">${esc(p.name)}</h2>
          <button class="btn btn-sm btn-ghost" data-act="rename-program" data-id="${esc(p.id)}">Rename</button>
        </div>
        ${rows}
        <button class="btn btn-sm btn-block" data-act="new-day" data-id="${esc(p.id)}">+ Add a day</button>`;
    })
    .join('');

  return `<h1>Edit</h1>
    <p class="sub">Rename days, swap lifts, change how many. Logged history is never touched by an edit.</p>
    ${warning}
    ${groups}
    <button class="btn btn-block mt-4" data-act="library">Exercise library</button>
    <button class="btn btn-block mt-2" data-act="gyms">Gyms and machines</button>
    <button class="btn btn-block mt-2" data-act="new-program">+ New program</button>`;
}

/**
 * The exercise library.
 *
 * Machine, handle and notes were addable when creating a lift but not
 * afterwards, which left a hundred existing lifts — including the ones the
 * cleanup guessed at — with no way to correct them.
 */
/**
 * The gyms, and what each one is known to have.
 *
 * Built entirely by using the app — nothing here is seeded, because a list of
 * machines that came from anywhere but his own sessions would be wrong in ways
 * that are tedious to correct.
 */
/**
 * Setting a gym up for everybody, for whoever is allowed to.
 *
 * Two different jobs behind one disclosure, and they are gated separately
 * because they are granted separately: the machine list is the gym admin's,
 * and appointing a gym admin is the super admin's alone. A gym admin running
 * one building does not get to hand out the right to run it.
 *
 * Shown only to somebody who can act. A control rendered to a person who may
 * not use it is a list of things they are being told they cannot do — the same
 * argument the approval queue above already makes for itself.
 */
function gymAdminPanel(gym) {
  const mayMachines = may('gym:set-machines', gym);
  const mayAppoint = may('gym:appoint-admin', gym);
  if (!mayMachines && !mayAppoint) return '';

  const open = state.openGymPanel === gym.id;
  const lifts = Object.keys(gym.inventory ?? {}).length;

  return `<button class="btn btn-sm btn-block disclosure mt-2.5"
      data-act="gym-panel" data-id="${esc(gym.id)}" aria-expanded="${open}">
      <span class="row gap-2 grow min-w-0">
        <span>Set this gym up</span>
        ${lifts ? `<span class="pill">${lifts} lift${lifts === 1 ? '' : 's'}</span>` : ''}
      </span>
      <span class="chev" aria-hidden="true"></span>
    </button>
    ${open ? `<div class="mt-2">
      ${mayMachines ? `
        <div class="eyebrow mb-1">Machines here</div>
        <p class="tiny muted mb-2">
          What the building actually has, for everybody. Separate from which one you
          personally use — that stays yours and is counted from your own visits.
        </p>
        <button class="btn btn-sm btn-block" data-act="gym-inventory" data-id="${esc(gym.id)}">
          ${lifts ? `Edit — ${lifts} lift${lifts === 1 ? '' : 's'} set up` : 'Add the machines'}
        </button>` : ''}

      ${mayAppoint ? `
        <div class="eyebrow mb-1 mt-3">Who runs it</div>
        <p class="tiny muted mb-2">
          A gym admin can name the machines here and correct the gym's details. They
          cannot approve gyms, invite anybody, or appoint another admin.
        </p>
        <button class="btn btn-sm btn-block" data-act="gym-admins" data-id="${esc(gym.id)}">
          Manage gym admins
        </button>` : ''}
    </div>` : ''}`;
}

/**
 * The machines a gym has, per lift, edited one lift at a time.
 *
 * Per lift rather than per gym, because "which machines are here" is not a
 * question anybody can answer in one go — it is answered the first time
 * somebody trains each movement. A single box listing every machine in the
 * building would be a form nobody finishes.
 *
 * The list is sent **as typed and in order**: the server replaces rather than
 * merges, because an admin editing a list they can see has to be able to
 * remove a machine that has left the gym, and because the order is "the usual
 * one first" and alphabetising it throws that away.
 */
function openInventorySheet(gymId) {
  const gym = gymById(gymId);
  if (!gym) return;

  let lift = null;

  const paint = () => {
    const lifts = (state.boot.exercises ?? []).filter((e) => tracksMachine(e));
    const current = lift ? (gym.inventory?.[lift] ?? []) : [];

    const rows = lifts.map((e) => {
      const has = (gym.inventory?.[e.id] ?? []).length;
      return `<button class="picker-item ${lift === e.id ? 'on' : ''}" data-lift="${esc(e.id)}">
          ${exerciseFigure(e)}
          <div class="grow min-w-0"><b class="t text-lg">${esc(e.name)}</b></div>
          ${has ? `<span class="pill">${has}</span>` : '<span class="tiny muted">—</span>'}
        </button>`;
    }).join('');

    openSheet(
      `<h2 class="mt-0">Machines at ${esc(gym.name)}</h2>
       <p class="tiny muted mb-2.5">
         What this building has, for everybody who trains here. Which one you personally
         use stays yours and is counted from your own visits.
       </p>
       ${lift
         ? `<button class="btn btn-sm btn-block btn-ghost mb-2.5" data-back="1">‹ All lifts</button>
            <div class="eyebrow mb-1">${esc(state.boot.exercises.find((e) => e.id === lift)?.name ?? lift)}</div>
            <p class="tiny muted mb-2">One per line, the usual one first.</p>
            <textarea class="input" id="inv-list" rows="5"
              placeholder="Hammer Strength&#10;Cybex">${esc(current.join('\n'))}</textarea>
            <button class="btn btn-primary btn-block btn-lg mt-2.5" data-save="1">Save</button>`
         : rows || '<div class="empty">No lifts here record a machine.</div>'}`,
      async (e) => {
        const pick = e.target.closest('[data-lift]');
        if (pick) { lift = pick.dataset.lift; return paint(); }
        if (e.target.closest('[data-back]')) { lift = null; return paint(); }
        if (!e.target.closest('[data-save]')) return;

        const typed = sheetPanel.querySelector('#inv-list')?.value ?? '';
        const machines = typed.split('\n').map((s) => s.trim()).filter(Boolean);

        closeSheet();
        await saveInventory(gym.id, lift, machines);
      },
    );
  };

  paint();
}

/**
 * Who runs this gym. Super admin only — the server refuses anybody else, and
 * `gymAdminPanel` does not render the button for them.
 */
async function openGymAdminSheet(gymId) {
  const gym = gymById(gymId);
  if (!gym) return;

  // Loaded on demand, like the accounts screen itself: this is one sheet out of
  // a dozen and the list is only correct if it has just been fetched — somebody
  // appointed on another device would otherwise show as unappointed here.
  await loadAccounts();

  const people = (state.accounts ?? []).filter((m) => m.id !== state.account?.id);

  openSheet(
    `<h2 class="mt-0">Who runs ${esc(gym.name)}</h2>
     <p class="tiny muted mb-2.5">
       A gym admin can name the machines here and correct this gym's details. They cannot
       approve gyms, invite anybody, or appoint another admin.
     </p>
     ${people.length
       ? people.map((m) => {
         const runs = (m.gymAdminOf ?? []).includes(gym.id);
         return `<button class="picker-item ${runs ? 'on' : ''}"
             data-person="${esc(m.id)}" data-runs="${runs ? '1' : ''}">
             <div class="grow min-w-0">
               <b class="t text-lg">${esc(m.name)}</b>
               <div class="tiny muted">${esc(m.email ?? '')}</div>
             </div>
             <span class="tiny muted">${runs ? 'runs it' : 'tap to add'}</span>
           </button>`;
       }).join('')
       : `<div class="empty">Nobody else has an account yet. Invite somebody from Setup first.</div>`}`,
    async (e) => {
      const pick = e.target.closest('[data-person]');
      if (!pick) return;
      closeSheet();
      await setGymAdmin(gym.id, pick.dataset.person, Boolean(pick.dataset.runs));
    },
  );
}

function viewGyms() {
  const gyms = gymsList();

  const rows = gyms
    .map((g) => {
      const machines = allMachinesAt(g);
      const lifts = Object.keys(g.machines ?? {}).length;

      return `<div class="card mb-2.5">
        <div class="row-between">
          <b>${esc(g.name)}</b>
          <button class="btn btn-sm btn-ghost" data-act="gym-rename" data-id="${esc(g.id)}">Rename</button>
        </div>
        ${g.visibility === 'pending'
          ? `<div class="tiny mt-1 text-warn">
               Waiting to be approved. It is on your picker and nobody else's — you can
               train at it now, and approval only decides who else sees it.
             </div>`
          : ''}
        <div class="tiny muted mt-1">
          ${g.fixes
            ? `position learned from ${g.fixes} visit${g.fixes === 1 ? '' : 's'}`
            : 'no position yet — it learns one the next time you train here'}
          · ${lifts} lift${lifts === 1 ? '' : 's'} mapped
        </div>
        ${machines.length
          ? `<div class="row wrap gap-1 mt-2">
               ${machines.map((m) => `<span class="pill">${esc(m)}</span>`).join('')}
             </div>`
          : '<div class="tiny muted mt-2">No machines recorded here yet.</div>'}
        ${machineSuspects(g)
          .map((pair) => `<div class="card mt-2.5 p-3">
              <div class="tiny">
                <b>${esc(pair.names[0])}</b> and <b>${esc(pair.names[1])}</b> look like two
                names for one machine. Split like that, each one is counted separately and
                neither becomes the expected answer.
              </div>
              <div class="row gap-1.5 mt-2.5">
                ${pair.names.map((keep, i) => `<button class="btn btn-sm ${i ? 'btn-ghost' : 'btn-primary'} grow"
                    data-act="gym-merge-machine" data-id="${esc(g.id)}"
                    data-keep="${esc(keep)}" data-drop="${esc(pair.names[i ? 0 : 1])}">
                    Keep ${esc(keep)}
                  </button>`).join('')}
              </div>
            </div>`)
          .join('')}
        ${gymAdminPanel(g)}
        <button class="btn btn-sm btn-block btn-ghost mt-2.5"
          data-act="gym-delete" data-id="${esc(g.id)}">Remove from my list</button>
      </div>`;
    })
    .join('');

  /**
   * What is waiting, for whoever can clear it.
   *
   * A gym is a building and the table is shared, so one careless name is on
   * everybody's picker — "gym", "Gym 2", a misspelling of one that already
   * exists. With three people who know each other that was fine; it stops being
   * fine the moment there are thirty.
   *
   * Only the admin sees this, because only the admin can act on it. A queue
   * rendered to somebody who cannot clear it is a list of things they are being
   * told they may not do.
   */
  const waiting = isAdmin() ? gyms.filter((g) => g.visibility === 'pending') : [];

  const queue = waiting.length
    ? `<h2>Waiting on you</h2>
       <p class="sub">
         Submitted by somebody else. Until you approve one it is on their picker alone —
         they can already train at it, so there is no hurry, only tidiness.
       </p>
       ${waiting.map((g) => `<div class="card mb-2.5 border-warn">
           <b>${esc(g.name)}</b>
           <div class="tiny muted mt-1">
             ${g.fixes ? `position from ${g.fixes} visit${g.fixes === 1 ? '' : 's'}` : 'no position yet'}
           </div>
           <div class="row gap-2 mt-2.5">
             <button class="btn btn-sm btn-primary grow" data-act="gym-approve" data-id="${esc(g.id)}">
               Put it on everyone's list
             </button>
             <button class="btn btn-sm btn-ghost grow" data-act="gym-reject" data-id="${esc(g.id)}">
               Not a real gym
             </button>
           </div>
         </div>`).join('')}`
    : '';

  return `<button class="btn btn-sm btn-ghost" data-act="edit">‹ Edit</button>
    <h1 class="mt-2">Gyms</h1>
    <p class="sub">
      Asked at the start of every workout. Each one keeps its own machines, because the
      same lift on two different stacks is two different weights.
    </p>
    ${queue}
    ${waiting.length ? '<h2>All of them</h2>' : ''}
    ${rows || '<div class="empty">No gyms yet. The first workout you start will ask.</div>'}
    ${(() => {
      /**
       * Gyms removed from the list, and the way back.
       *
       * Removing is a hide now rather than a delete, so there has to be somewhere
       * the hidden ones can be seen — otherwise "reversible" is a property only
       * the code knows about.
       */
      const hidden = (state.boot?.hiddenGyms ?? [])
        .map((id) => (state.boot?.gyms ?? []).find((g) => g.id === id))
        .filter(Boolean);
      if (!hidden.length) return '';

      return `<h2 class="mt-5.5">Removed</h2>
        <p class="sub">Still here, with everything you recorded at them.</p>
        ${hidden.map((g) => `<div class="card row-between mb-2">
            <div class="grow min-w-0">
              <b>${esc(g.name)}</b>
              <div class="tiny muted">${Object.keys(g.machines ?? {}).length} lifts mapped, kept</div>
            </div>
            <button class="btn btn-sm" data-act="gym-unhide" data-id="${esc(g.id)}">Add back</button>
          </div>`).join('')}`;
    })()}`;
}

/**
 * Lifts whose muscle group contradicts their name.
 *
 * Shown rather than corrected, for the reason the session-length fix is shown
 * rather than corrected: a number quietly changed behind you is how you stop
 * trusting the ones that were not. Two taps are offered — take the suggestion,
 * or record that it was looked at and kept — because without the second one the
 * only way to silence a suggestion he disagrees with is to accept it.
 */
/**
 * Lifts where it is unclear whether a weight was one dumbbell or the pair.
 *
 * Two buttons and no default, because this is a question only he can answer. Where
 * the numbers do settle it — 200 lb is not one dumbbell, 17.5 lb is not a pair — the
 * answer is said plainly and the matching button leads. Where they do not, both are
 * offered equally: a confident guess here rewrites months of history in the wrong
 * unit, and he would have to check each one anyway.
 */
function loadUnitChecks(exercises) {
  const found = loadUnitSuspects(exercises, state.sessions);
  if (!found.length) return '';

  const rows = found.map((f) => {
    const lift = exercises.find((e) => e.id === f.id);
    // One side at a time means one bell already *is* the whole load, so answering
    // "one dumbbell" changes the label and leaves every number alone.
    const doubles = !lift?.unilateral;

    return `<div class="card mb-2 p-3">
        <b class="text-sm">${esc(f.name)}</b>
        <div class="tiny muted mt-1">${esc(f.reason)}</div>
        <div class="row gap-1.5 mt-2.5">
          <button class="btn btn-sm grow ${f.suggested === 'per-hand' ? 'btn-primary' : ''}"
            data-act="unit-per-hand" data-id="${esc(f.id)}">
            One dumbbell${doubles ? ' — double them' : ''}
          </button>
          <button class="btn btn-sm grow ${f.suggested === 'total' ? 'btn-primary' : ''}"
            data-act="unit-total" data-id="${esc(f.id)}">
            Already the total
          </button>
        </div>
      </div>`;
  }).join('');

  return `<div class="mx-0 mt-3.5 mb-4.5">
      <div class="row-between mb-2">
        <span class="tiny muted">One dumbbell, or both?</span>
        <span class="tiny mono">${found.length}</span>
      </div>
      ${rows}
      <div class="tiny muted">
        Dumbbell lifts now ask for the weight of a single bell and record double. These
        were logged before that, so each one needs saying once — a lift measured in two
        units has no honest trend.
      </div>
    </div>`;
}

function groupChecks(exercises) {
  const found = groupSuspects(exercises);
  if (!found.length) return '';

  const rows = found
    .map((s) => `<div class="card mb-2 p-3">
        <b class="text-sm">${esc(s.name)}</b>
        <div class="tiny muted mt-1">
          ${s.reason === 'missing'
            ? 'No muscle group recorded, so it is missing from every group total.'
            : `Filed under <b>${esc(s.recorded)}</b>, but it reads as a <b>${esc(s.suggested)}</b> movement.`}
        </div>
        <div class="row gap-1.5 mt-2.5">
          <button class="btn btn-sm btn-primary grow" data-act="lib-regroup"
            data-id="${esc(s.id)}" data-group="${esc(s.suggested)}">
            ${s.reason === 'missing' ? 'Set to' : 'Move to'} ${esc(s.suggested)}
          </button>
          <button class="btn btn-sm btn-ghost grow" data-act="lib-keep-group" data-id="${esc(s.id)}">
            ${s.reason === 'missing' ? 'Not now' : `Keep ${esc(s.recorded)}`}
          </button>
        </div>
      </div>`)
    .join('');

  return `<div class="mx-0 mt-3.5 mb-4.5">
      <div class="row-between mb-2">
        <span class="tiny muted">Worth a look</span>
        <span class="tiny mono">${found.length}</span>
      </div>
      ${rows}
      <div class="tiny muted">
        Nothing here changes until you tap. A group that is wrong puts the lift in the
        wrong total on the Coach tab, which is the kind of error that looks plausible.
      </div>
    </div>`;
}

function viewLibrary() {
  // Retired lifts stay visible here, and only here, so they can be brought back.
  const all = [...(state.boot.exercises ?? [])]
    .sort((a, b) => Number(a.archived ?? false) - Number(b.archived ?? false) || a.name.localeCompare(b.name));

  const query = (state.libraryQuery ?? '').trim().toLowerCase();

  const logged = new Set();
  for (const s of state.sessions) for (const x of s.sets ?? []) logged.add(x.exerciseId);

  const rows = all
    .map((e) => {
      const extra = qualifier(e);
      const marks = [
        e.archived ? '<span class="pill pill-warn">retired</span>' : '',
        e.bodyweight ? '<span class="pill">bodyweight</span>' : '',
        e.variantOf ? '<span class="pill">variant</span>' : '',
        logged.has(e.id) ? '' : '<span class="pill">never used</span>',
      ].filter(Boolean).join(' ');

      const haystack = `${e.name} ${e.machine ?? ''} ${e.handle ?? ''} ${e.muscleGroup ?? ''}`.toLowerCase();
      const hidden = query && !haystack.includes(query) ? ' style="display:none"' : '';
      return `<button class="lib-row" data-act="lib-edit" data-id="${esc(e.id)}" data-search="${esc(haystack)}"${hidden}>
          ${exerciseFigure(e)}
          <div class="grow min-w-0">
            <b class="t text-lg">${esc(e.name)}</b>
            ${extra ? `<div class="tiny muted">${esc(extra)}</div>` : ''}
            <div class="row wrap gap-1 mt-1">
              ${e.muscleGroup ? `<span class="pill">${esc(e.muscleGroup)}</span>` : ''}
              ${marks}
            </div>
          </div>
          <span class="tiny muted">›</span>
        </button>`;
    })
    .join('');

  const matches = query
    ? all.filter((e) => `${e.name} ${e.machine ?? ''} ${e.handle ?? ''} ${e.muscleGroup ?? ''}`.toLowerCase().includes(query)).length
    : all.length;

  return `<button class="btn btn-sm btn-ghost" data-act="edit">‹ Edit</button>
    <h1 class="mt-2">Exercise library</h1>
    <p class="sub">${all.length} lifts. Tap one to change its machine, handle, notes or equipment.</p>
    ${loadUnitChecks(all)}
    ${groupChecks(all)}
    <input class="searchbar" id="lib-q" placeholder="Search lifts, machines, handles…" autocomplete="off"
      value="${esc(state.libraryQuery ?? '')}">
    <div id="lib-list">${rows}</div>
    <div class="empty" id="lib-none"${matches ? ' hidden' : ''}>Nothing matches that.</div>`;
}

function viewEditDay() {
  const d = state.draft;
  if (!d) return viewEdit();

  const programs = state.boot.programs ?? [];
  const schemes = Object.values(state.boot.schemes ?? {});

  const rows = d.exercises
    .map(
      (e, i) => `<div class="edit-row">
        <div class="handle">
          <button data-act="ex-up" data-i="${i}" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button data-act="ex-down" data-i="${i}" ${i === d.exercises.length - 1 ? 'disabled' : ''}>▼</button>
        </div>
        <div class="grow min-w-0">
          <button class="row w-full text-left" data-act="ex-swap" data-i="${i}">
            <b class="grow truncate">${esc(e.name)}</b>
            <span class="tiny muted">change ›</span>
          </button>
          <div class="edit-meta">
            <select data-act="ex-scheme" data-i="${i}">
              ${schemes.map((s) => `<option value="${esc(s.id)}" ${s.id === e.schemeId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
            </select>
            <span class="field-suffix">
              <input type="number" inputmode="numeric" data-act="ex-rest" data-i="${i}"
                value="${e.restSeconds}" aria-label="Rest between sets, in seconds">
              <small>s rest</small>
            </span>
            <button class="btn btn-sm" data-act="ex-rename" data-i="${i}">✎ rename</button>
          </div>
        </div>
        <button class="btn btn-sm danger flex-none" data-act="ex-remove" data-i="${i}">×</button>
      </div>`,
    )
    .join('');

  return `<div class="row-between">
      <button class="btn btn-sm btn-ghost" data-act="edit">‹ Back</button>
      <button class="btn btn-sm danger" data-act="delete-day">Delete day</button>
    </div>

    <h1 class="mt-2.5">${esc(d.name || 'New day')}</h1>

    <div class="card">
      <label class="tiny muted">Day name</label>
      <input class="input mx-0 mt-2 mb-3.5" data-act="day-name" value="${esc(d.name)}" placeholder="e.g. Legs 1">
      <label class="tiny muted">Belongs to</label>
      <select class="input mt-2" data-act="day-program">
        ${programs.map((p) => `<option value="${esc(p.id)}" ${p.id === d.programId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
    </div>

    <h2>Exercises <span class="tiny muted">· ${d.exercises.length}</span></h2>
    ${rows || '<div class="empty">No exercises yet — add the first one.</div>'}
    <button class="btn btn-block" data-act="add-exercise">+ Add exercise</button>



    ${state.draftDirty
      ? `<div class="dirty-bar">
           <button class="btn btn-sm grow" data-act="cancel-day">Discard</button>
           <button class="btn btn-primary btn-sm grow" data-act="save-day">Save changes</button>
         </div>`
      : ''}`;
}

async function saveDraftDay() {
  const d = state.draft;
  if (!d?.name?.trim()) return toast('Give the day a name');

  await updateBoot(upsertDayIn(state.boot, d));
  state.draft = null;
  state.draftDirty = false;
  go('edit');
  toast('Saved');
  mirror('/api/days', d);
}

async function deleteDraftDay() {
  const d = state.draft;
  if (!d) return;
  if (!confirm(`Delete "${d.name}"? Workouts you already logged are kept.`)) return;

  await updateBoot(removeDayFrom(state.boot, d.id));
  state.draft = null;
  state.draftDirty = false;
  go('edit');
  toast('Deleted');

  if (state.online) {
    fetch(api(`/api/days/${encodeURIComponent(d.id)}`), { method: 'DELETE' }).catch(() => {});
  }
}

async function postJSON(path, payload, { signal = null } = {}) {
  const res = await fetch(api(path), {
    method: 'POST',
    // The token was missing here, so every authed POST — the program mirror
    // included — was silently 401ing against a Worker that has one set.
    headers: { 'content-type': 'application/json', ...authHeader() },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

/* ================================ sheets ================================ */

let sheetState = null;

/** Is a sheet currently up? Checked before any prompt opens another. */
const sheetOpen = () => sheet && !sheet.hidden;

/**
 * How long a freshly opened sheet ignores a dismissal.
 *
 * A sheet covers the whole screen the instant it opens, so the second tap of a
 * double-tap lands on its backdrop and closes it. On the Train tab that meant
 * tapping a day card twice flashed the gym sheet and left you back where you
 * started with no session and nothing on screen having changed — from the user's
 * side, the card simply did not work. Reproduced at every gap from 0 to 300 ms.
 *
 * Long enough to cover a nervous double-tap, short enough that nobody deliberately
 * dismissing a sheet ever waits for it.
 */
const SHEET_DEAF_MS = 350;

let sheetOpenedAt = 0;

/**
 * Focus a sheet's first field, unless the person got there first.
 *
 * The delay is deliberate: the sheet has to be laid out before iOS will raise
 * the keyboard for it. The hazard is that 60ms is also long enough to tap a
 * different field, and an unguarded focus then yanks the cursor back, so the
 * next keystrokes land in the wrong box. That is how a lift typed as
 * `Cable Tricep Pushdown` with a machine of `Eleiko` was once stored as one
 * lift named `Cable Tricep PushdownEleiko`, with no machine recorded at all.
 *
 * So the rule is the same one `isEditing` already encodes: anything the user is
 * part-way through outranks anything the app wants to do to the focus.
 */
function focusFirstField(selector) {
  setTimeout(() => {
    if (sheetPanel.contains(document.activeElement)) return;
    sheetPanel.querySelector(selector)?.focus();
  }, 60);
}

function openSheet(html, onEvent) {
  sheetPanel.innerHTML = `<div class="grabber"></div>${html}`;
  sheet.hidden = false;
  sheetOpenedAt = Date.now();
  sheetState = { onEvent };
}

function closeSheet() {
  sheet.hidden = true;
  sheetState = null;
}

function openWeightSheet() {
  const a = state.active;
  const ex = currentExercise();
  const st = a.ex[ex.dayExerciseId];
  const idx = currentSetIndex(st);
  const equipment = ex.equipment;

  /**
   * The keypad works in the unit the screen is in, and stores canonical pounds.
   *
   * Two conversions, both here, and the order they compose in is the whole
   * hazard. A pair of dumbbells shows **one bell** — the only number available
   * while standing at the rack — and the screen may be in kilos, so the box
   * holds `total pounds ÷ hands, converted`. Getting those two the wrong way
   * round is how the Plates tab halved a logged set.
   *
   * `lift`, not `unit`: the local was called `unit` while meaning "the exercise",
   * which now shadows the accessor that answers which unit the screen is in.
   */
  const lift = liftFor(ex);
  const hands = handsOf(lift);
  const perHand = hands > 1;
  const u = unit();

  /** The stored canonical figures, captured once so nothing re-derives them. */
  const storedTotalLb = numericValue(st.weights[idx]) ?? equipment.barWeight ?? 0;
  const storedSideLb = perHand ? storedTotalLb / hands : storedTotalLb;

  /** Canonical pounds for one side, as the box should show it. */
  const toShown = (sideLb) => showWeight(sideLb, u) ?? 0;

  /**
   * What the box shows, back to a canonical total in pounds.
   *
   * Through `commitWeight`, which is what makes the round trip lossless: a value
   * submitted unchanged returns the stored number bit for bit rather than being
   * reconverted. Without it, opening the keypad on a kilo screen and closing it
   * again would walk every weight by a quarter-pound a time.
   */
  const toStored = (shown) => {
    const sideLb = commitWeight(shown, u, storedSideLb);
    return (sideLb ?? 0) * (perHand ? hands : 1);
  };

  /** The number alone — `draft.lb` is already in the display unit and snapped. */
  const shownNumber = (v) => (v == null ? '—' : String(Number(Number(v).toFixed(2))));

  const draft = {
    tab: 'lb',
    lb: toShown(storedSideLb),
    barType: equipment.barType,
    // In the plate unit, because the plate grid is. A pound figure here would
    // decompose against kg plates and produce a stack nobody can build.
    plates: platesForTotal(showWeight(storedTotalLb, u) ?? 0, { ...equipment, unit: u }).plates,
    typing: '',
  };

  const paint = () => {
    const bar = getBarType(draft.barType, u);
    const eq = {
      barWeight: bar.weight,
      loading: bar.loading,
      available: state.settings.availablePlates,
      unit: u,
    };

    /**
     * Two totals, because two things need one.
     *
     * `totalShown` is in the display unit and is what the plate grid and every
     * caption work in. `total` is canonical pounds and is the only thing that
     * reaches `setWeight`. Keeping them as separate names is deliberate: the one
     * bug this sheet has already shipped was a per-hand number being used where
     * a total was meant, and an untyped `total` is what let that happen.
     */
    const totalShown = draft.tab === 'plates'
      ? totalFromPlates({ ...eq, plates: draft.plates })
      : (showWeight(toStored(draft.lb), u) ?? 0);

    const total = draft.tab === 'plates'
      ? commitWeight(totalShown, u, storedTotalLb)
      : toStored(draft.lb);

    const lbTab = `
      <div class="readout">${draft.typing !== '' ? esc(draft.typing) : shownNumber(draft.lb)}<button class="unit-swap" data-unit-swap="1"
          aria-label="Showing ${u}. Tap to switch to ${u === 'kg' ? 'pounds' : 'kilos'}.">${perHand ? `${u} per dumbbell` : u} ⇄</button></div>
      <div class="numpad">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join('')}
        <button data-k=".">.</button><button data-k="0">0</button><button data-k="del">⌫</button>
      </div>
      <div class="row gap-2 mt-2.5">
        ${[-10, -5, 5, 10].map((d) => `<button class="btn btn-sm grow" data-adj="${d}">${d > 0 ? '+' : ''}${d}</button>`).join('')}
      </div>`;

    const plateTab = `
      <div class="readout">${shownNumber(totalShown)}<small>${esc(bar.name)}${bar.weight ? ` · bar ${bar.weight} ${u}` : ''}</small></div>
      <select class="input mb-3" data-act="bar">
        ${barTypesFor(u).map((b) => `<option value="${b.id}" ${b.id === draft.barType ? 'selected' : ''}>${esc(b.name)}${b.weight ? ` (${b.weight} ${u})` : ''}</option>`).join('')}
      </select>
      <div class="plate-grid">
        ${state.settings.availablePlates
          .map(
            (p) => `<div class="plate">
              <div class="lbl">${p} ${u}</div>
              <div class="cnt">${draft.plates[p] ?? 0}</div>
              <div class="pm"><button data-plate="${p}" data-d="-1">−</button><button data-plate="${p}" data-d="1">+</button></div>
            </div>`,
          )
          .join('')}
      </div>
      <div class="tiny muted text-center">
        ${bar.loading === 'total' ? 'Plates counted as the whole load' : 'Plates counted per side'}
      </div>`;

    openSheet(
      `<div class="tabs">
        <button class="${draft.tab === 'lb' ? 'on' : ''}" data-tab="lb">${u === 'kg' ? 'Kilos' : 'Pounds'}</button>
        <button class="${draft.tab === 'plates' ? 'on' : ''}" data-tab="plates">Plates</button>
      </div>
      ${draft.tab === 'lb' ? lbTab : plateTab}
      ${perHand
        ? `<div class="tiny muted text-center mt-2.5">
             One dumbbell. ${draft.tab === 'lb' ? `That is ${shownNumber(totalShown)} ${u} moved in total.` : ''}
           </div>`
        : ''}
      <button class="btn btn-primary btn-block btn-lg mt-3.5" data-done="1">
        Set ${perHand && draft.tab === 'lb' ? shownNumber(draft.lb) : shownNumber(totalShown)} ${u}${perHand && draft.tab === 'lb' ? ' each' : ''}
      </button>`,
      (e) => {
        const t = e.target.closest('[data-k],[data-adj],[data-tab],[data-plate],[data-done],[data-unit-swap],[data-act="bar"]');
        if (e.target.matches('select[data-act="bar"]')) {
          draft.barType = e.target.value;
          return paint();
        }
        if (!t) return;

        /**
          * The label that says the unit is the control that changes it.
          *
          * Lifted from Hevy, which is the one thing it does better than anybody:
          * the unit is right where you are already looking when you realise it
          * is wrong, instead of three screens away in a settings list. It is
          * also where somebody *discovers* the app has units at all.
          *
          * The sheet closes rather than repainting in place. `setWeightUnit`
          * re-renders the whole view underneath, which would leave this sheet
          * floating over a screen that had moved on — and the weight it is
          * editing is unchanged either way, because the unit is display only.
          */
        if (t.dataset.unitSwap) {
          closeSheet();
          return setWeightUnit(u === 'kg' ? 'lb' : 'kg');
        }

        if (t.dataset.tab) {
          /**
           * Both tabs hold the same load. Only one of them held it in totals.
           *
           * `draft.lb` is the **shown** number, which on a pair of dumbbells is
           * one bell; the plate functions work in **totals**. This handed one
           * straight to the other, so opening the keypad on a dumbbell lift and
           * tapping Plates built a stack for 35 lb instead of 70 — and Done
           * stored the 35. Two taps, nothing typed, and the set was halved.
           *
           * It is the same fault the per-hand rule was written to kill, reached
           * from the side the rule did not cover: the boundary was crossed at
           * the keypad and at the stepper and not here.
           */
          if (t.dataset.tab === 'plates' && draft.tab === 'lb') {
            const b = getBarType(draft.barType, u);
            draft.plates = platesForTotal(totalShown, {
              barWeight: b.weight, loading: b.loading, available: state.settings.availablePlates, unit: u,
            }).plates;
          }
          if (t.dataset.tab === 'lb' && draft.tab === 'plates') {
            draft.lb = toShown(perHand ? total / hands : total);
          }
          draft.tab = t.dataset.tab;
          draft.typing = '';
          return paint();
        }

        if (t.dataset.k) {
          const k = t.dataset.k;
          if (k === 'del') draft.typing = draft.typing.slice(0, -1);
          else if (k === '.' && draft.typing.includes('.')) return;
          else draft.typing = (draft.typing + k).slice(0, 6);
          draft.lb = draft.typing === '' ? 0 : Number(draft.typing) || 0;
          return paint();
        }

        if (t.dataset.adj) {
          draft.lb = Math.max(0, (draft.typing !== '' ? Number(draft.typing) : draft.lb) + Number(t.dataset.adj));
          draft.typing = '';
          return paint();
        }

        if (t.dataset.plate) {
          const p = Number(t.dataset.plate);
          const next = (draft.plates[p] ?? 0) + Number(t.dataset.d);
          draft.plates = { ...draft.plates, [p]: Math.max(0, next) };
          return paint();
        }

        if (t.dataset.done) {
          closeSheet();
          setWeight(idx, Math.max(0, total));
        }
      },
    );
  };

  paint();
}

function openRepsSheet() {
  const a = state.active;
  const ex = currentExercise();
  const st = a.ex[ex.dayExerciseId];
  const idx = currentSetIndex(st);
  let typing = '';

  const paint = () => {
    const value = typing === '' ? (st.repDraft ?? defaultReps(withRecall(ex), st, idx)) : Number(typing);
    openSheet(
      `<div class="readout">${value}<small>reps completed</small></div>
       <div class="numpad">
         ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join('')}
         <button data-k="del">⌫</button><button data-k="0">0</button><button data-done="1">✓</button>
       </div>`,
      (e) => {
        const t = e.target.closest('[data-k],[data-done]');
        if (!t) return;
        if (t.dataset.done) {
          st.repDraft = Math.max(0, value);
          closeSheet();
          persistActive();
          return render();
        }
        typing = t.dataset.k === 'del' ? typing.slice(0, -1) : (typing + t.dataset.k).slice(0, 3);
        paint();
      },
    );
  };

  paint();
}

/**
 * Show exactly what landed, lift by lift.
 *
 * A paste that loses its last line is not an error — the text simply is not
 * there — so nothing could report it, and three sets went missing in silence.
 * Reading back what was understood is the only way that is visible.
 */
function showImportSummary(session, errors = []) {
  const grouped = new Map();
  for (const set of session.sets) {
    if (!grouped.has(set.exerciseId)) grouped.set(set.exerciseId, []);
    grouped.get(set.exerciseId).push(set);
  }

  const rows = [...grouped.entries()]
    .map(([id, sets]) => {
      const name = state.boot.exercises.find((e) => e.id === id)?.name ?? id;
      return `<div class="row-between border-t border-line" style="padding:7px 0">
        <span class="tiny">${esc(name)}</span>
        <span class="tiny mono muted">${sets.map((s) => `${s.weight}×${s.reps}`).join('  ')}</span>
      </div>`;
    })
    .join('');

  openSheet(
    `<h2 class="mt-0">Imported into ${esc(session.dayName)}</h2>
     <div class="tiny muted mb-1">
       Check every lift you did is listed. If one is missing, its line did not make it into the box — paste again.
     </div>
     ${rows}
     <div class="row-between px-0 py-2.5 border-t border-line mt-1">
       <b class="tiny">${grouped.size} lift${grouped.size === 1 ? '' : 's'}</b>
       <b class="tiny mono">${session.sets.length} sets</b>
     </div>
     ${errors.length
       ? `<div class="card border-bad">
            <div class="tiny text-bad">${errors.map(esc).join('<br>')}</div>
          </div>`
       : ''}
     <button class="btn btn-primary btn-block btn-lg mt-2.5" data-close="1">Done</button>`,
    () => {},
  );
}

/**
 * How did that go?
 *
 * Asked once, at the end, on a five-point scale. Every question is skippable —
 * a check-in that feels like paperwork gets abandoned, and a half-abandoned one
 * is worse than none because it still looks like data.
 */
function openCheckinSheet() {
  const a = state.active;
  const answers = { ...(a.checkin ?? {}) };

  const paint = () => {
    const rows = QUESTIONS.map(
      (q) => `<div class="scale-row">
          <div class="s-label">${esc(q.label)}</div>
          <div class="scale-btns">
            ${SCALE.map(
              // `aria-pressed` as well as the class. Every other toggle in the
              // app carries it — the Coach tabs, the level cards, the unit
              // cards — and these twenty did not, so a screen reader could not
              // tell which score was chosen. The class is what paints it; the
              // attribute is what says it.
              (n) => `<button class="${answers[q.id] === n ? 'on' : ''}" aria-pressed="${answers[q.id] === n}"
                  data-q="${esc(q.id)}" data-v="${n}">${n}</button>`,
            ).join('')}
          </div>
        </div>
        <div class="scale-ends"><span>${esc(q.low)}</span><span>${esc(q.high)}</span></div>`,
    ).join('');

    openSheet(
      `<h2 class="mt-0">How did that go?</h2>
       <div class="tiny muted mb-3.5">
         Four taps. It is what explains a bad session weeks later, when the numbers alone will not.
       </div>
       ${rows}
       <label class="tiny muted">Anything worth remembering</label>
       <input class="input mx-0 mt-2 mb-3.5" id="ci-note" value="${esc(answers.note ?? '')}"
         placeholder="e.g. skipped lunch, gym was packed" autocomplete="off">
       <button class="btn btn-primary btn-block btn-lg" data-ci-save="1">Save and finish</button>
       <button class="btn btn-block btn-ghost btn-sm mt-2" data-ci-skip="1">Skip</button>`,
      async (e) => {
        const pick = e.target.closest('[data-q]');
        if (pick) {
          const id = pick.dataset.q;
          const value = Number(pick.dataset.v);

          /**
           * Read the note **before** repainting.
           *
           * `paint()` does `sheetPanel.innerHTML = …`, which rebuilds the input
           * from `answers.note` — and `answers.note` was only ever assigned in
           * the save branch below. So typing the note and then correcting a
           * mis-tapped score silently destroyed it, with the box visibly empty
           * and Save writing an empty string.
           *
           * That is the worst version of this bug in the app: the note is 1.3k
           * of the 3.1k the written coach is sent, and the one field that
           * explains a bad session weeks later. It was also lost to the exact
           * gesture somebody makes *because* they are being careful.
           *
           * `openSuggestionSheet` has done this correctly all along — it reads
           * `#sg-note` into its draft before every paint. This is the same
           * three words, three functions later.
           */
          answers.note = sheetPanel.querySelector('#ci-note')?.value ?? answers.note ?? '';

          // Tapping the same number again clears it, so a mis-tap is undoable.
          answers[id] = answers[id] === value ? undefined : value;
          return paint();
        }

        if (e.target.closest('[data-ci-skip]')) {
          a.checkinAsked = true;
          closeSheet();
          await persistActive();
          return finishSession();
        }

        if (e.target.closest('[data-ci-save]')) {
          answers.note = (sheetPanel.querySelector('#ci-note')?.value ?? answers.note ?? '').trim();
          a.checkin = isAnswered(answers) || answers.note ? answers : undefined;
          a.checkinAsked = true;
          closeSheet();
          await persistActive();
          return finishSession();
        }
      },
    );
  };

  paint();
}

/**
 * Pick lifts to run back to back — as many as you like.
 *
 * Chosen from the session rather than the template, because the reason to
 * bundle lifts or break a bundle is what is free right now.
 *
 * ## Why it stopped saying "pair"
 *
 * Nothing here was ever limited to two. `makeSuperset` has a floor of two and
 * no ceiling, the selection below has never been capped, and this sheet has
 * read "Pick two or more" since it was written. But every *word* around it said
 * pair — this function's name, the button on the overview, the action id, the
 * heading, the confirm button — and it was reported as "we are limited to 2".
 * That was true of the language and never of the code.
 *
 * A word that means two answers the question before anybody asks it, and no
 * amount of explanatory copy underneath undoes the heading above it. So the
 * user-facing noun is now **bundle**, which carries no count. `supersetId` and
 * `makeSuperset` keep their names: the stored field is the same field it has
 * always been, and renaming data to match a label is how a migration gets
 * invented for a vocabulary change.
 *
 * The count on the button is the other half of the fix. "Bundle 4 lifts" is the
 * screen stating the capability back, which a static label cannot do.
 */
function openBundleSheet() {
  const a = state.active;
  const chosen = new Set();

  const paint = () => {
    const rows = a.plan.exercises
      .map((e, i) => `<button class="picker-item ${chosen.has(i) ? 'on' : ''}" data-pick-i="${i}">
          <div class="grow min-w-0"><b>${esc(e.name)}</b></div>
          <span class="tiny muted">${chosen.has(i) ? '✓' : ''}</span>
        </button>`)
      .join('');

    const full = chosen.size >= MAX_BUNDLE;

    openSheet(
      `<h2 class="mt-0">Bundle lifts together</h2>
       <div class="tiny muted mb-2.5">
         Pick as many as you want — two, three, five. You move straight between them and
         rest only after the whole round. Lifts that are apart get moved together.
       </div>
       ${rows}
       ${full ? `<div class="tiny muted mt-2">That is ${MAX_BUNDLE}, which is as many as one bundle holds.</div>` : ''}
       <button class="btn btn-primary btn-block btn-lg" style="margin-top:10px" data-pair-go="1"
         ${chosen.size < 2 ? 'disabled' : ''}>
         ${chosen.size < 2 ? 'Pick at least two' : `Bundle ${chosen.size} lifts`}
       </button>`,
      async (e) => {
        const pick = e.target.closest('[data-pick-i]');
        if (pick) {
          const i = Number(pick.dataset.pickI);
          if (chosen.has(i)) chosen.delete(i);
          // Refused at the edge rather than silently dropped by `makeSuperset`,
          // so a tap that does nothing says why on the line above the button.
          else if (chosen.size < MAX_BUNDLE) chosen.add(i);

          return paint();
        }

        if (e.target.closest('[data-pair-go]') && chosen.size >= 2) {
          a.plan.exercises = makeSuperset(a.plan.exercises, [...chosen], `ss-${uid().slice(0, 6)}`);
          a.exIndex = 0;
          a._dirty = true;
          closeSheet();
          await persistActive();
          render();
        }
      },
    );
  };

  paint();
}

/**
 * Edit an existing lift.
 *
 * The same fields the create sheet offers, on a lift that already exists. The
 * name is deliberately editable here too: renaming keeps the id, so every set
 * ever logged against it follows the new name.
 */
function openExerciseEditor(lift) {
  const draft = { ...lift };

  const paint = () => {
    const others = [...state.boot.exercises]
      .filter((x) => x.id !== lift.id && !x.variantOf)
      .sort((a, b) => a.name.localeCompare(b.name));

    openSheet(
      `<h2 class="mt-0">${esc(lift.name)}</h2>
       <div class="tiny muted mb-3">
         Renaming keeps its history — every set logged against this lift follows it.
       </div>

       <label class="tiny muted">Movement</label>
       <input class="input mx-0 mt-2 mb-3.5" id="ed-name" value="${esc(draft.name ?? '')}" autocomplete="off">

       <div class="meta-grid">
         <input class="input" id="ed-machine" placeholder="Machine" value="${esc(draft.machine ?? '')}" autocomplete="off">
         <input class="input" id="ed-handle" placeholder="Handle / grip" value="${esc(draft.handle ?? '')}" autocomplete="off">
       </div>

       <label class="tiny muted">Equipment — drives the plate calculator</label>
       <select class="input mx-0 mt-2 mb-3.5" id="ed-bar">
         ${BAR_TYPES.map((b) => `<option value="${esc(b.id)}" ${b.id === draft.barType ? 'selected' : ''}>${esc(b.name)}${b.weight ? ` (${b.weight} lb)` : ''}</option>`).join('')}
       </select>

       <label class="tiny muted">Muscle group</label>
       <select class="input mx-0 mt-2 mb-3.5" id="ed-group">
         <option value="">—</option>
         ${MUSCLE_GROUPS.map((g) => `<option value="${esc(g)}" ${g === draft.muscleGroup ? 'selected' : ''}>${esc(g)}</option>`).join('')}
       </select>

       <label class="tiny muted">A variant of</label>
       <select class="input mx-0 mt-2 mb-3.5" id="ed-variant">
         <option value="">nothing — it stands on its own</option>
         ${others.map((x) => `<option value="${esc(x.id)}" ${x.id === draft.variantOf ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
       </select>

       <label class="tiny muted">Notes — setup that changes the movement</label>
       <input class="input mx-0 mt-2 mb-3" id="ed-notes" value="${esc(draft.notes ?? '')}"
         placeholder="e.g. pad under hips for extra range" autocomplete="off">

       <label class="tiny muted">Demonstration — a YouTube link</label>
       <input class="input mx-0 mt-2 mb-1 text-xs" id="ed-video" value="${esc(draft.videoUrl ?? '')}"
         placeholder="https://www.youtube.com/watch?v=…"
         autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off">
       <div class="tiny muted mb-3">
         Most lifts come with one already. If it is the wrong movement or badly taught,
         paste a better link — or clear the box and the app offers a search instead.
       </div>

       <label class="tiny muted">How the weight is entered</label>
       <select class="input mx-0 mt-2 mb-1" id="ed-entry">
         <option value="total" ${draft.entry !== 'per-hand' ? 'selected' : ''}>The whole load — a bar, a machine, one bell in both hands</option>
         <option value="per-hand" ${draft.entry === 'per-hand' ? 'selected' : ''}>One dumbbell — the number on the thing you pick up</option>
       </select>
       <div class="tiny muted mb-3">
         Pick "one dumbbell" and typing 35 records 70 lb moved. What is stored is always
         the total, so every lift compares against every other.
       </div>

       <label class="row gap-2.5 mb-2.5">
         <input type="checkbox" id="ed-uni" ${draft.unilateral ? 'checked' : ''}>
         <span class="tiny">One side at a time — so one dumbbell <b>is</b> the whole load</span>
       </label>

       <label class="row gap-2.5 mb-2.5">
         <input type="checkbox" id="ed-bw" ${draft.bodyweight ? 'checked' : ''}>
         <span class="tiny">Can be done with no added weight</span>
       </label>

       <label class="row gap-2.5 mb-3.5">
         <input type="checkbox" id="ed-track"
           ${tracksMachine(draft) ? 'checked' : ''}>
         <span class="tiny">Ask which machine at each gym</span>
       </label>

       <button class="btn btn-primary btn-block btn-lg" data-ed-save="1">Save</button>
       <button class="btn btn-block btn-ghost btn-sm ${draft.archived ? '' : 'danger'} mt-2" data-ed-archive="1">
         ${draft.archived ? 'Bring this lift back' : 'Retire this lift'}
       </button>
       <div class="tiny muted text-center mt-2">
         Retiring hides it from the pickers. Everything you logged with it is kept.
       </div>`,

      async (e) => {
        if (e.target.closest('[data-ed-save]')) {
          const field = (id) => sheetPanel.querySelector(id)?.value?.trim() || null;
          const name = field('#ed-name');
          if (!name) return toast('It needs a name');

          const video = field('#ed-video');
          if (video && !youtubeId(video)) return toast('That does not look like a YouTube link');

          const next = {
            ...draft,
            name,
            machine: field('#ed-machine'),
            handle: field('#ed-handle'),
            notes: field('#ed-notes') ?? '',
            // Cleared on purpose reads as null, not as "never set": the seed
            // merge fills only absent fields, so a null stays cleared instead of
            // having the built-in video handed back on the next launch.
            videoUrl: field('#ed-video') ?? null,
            barType: sheetPanel.querySelector('#ed-bar')?.value ?? draft.barType,
            muscleGroup: normaliseMuscleGroup(field('#ed-group')),
            variantOf: field('#ed-variant') ?? undefined,
            entry: sheetPanel.querySelector('#ed-entry')?.value === 'per-hand' ? 'per-hand' : 'total',
            unilateral: Boolean(sheetPanel.querySelector('#ed-uni')?.checked),
            bodyweight: Boolean(sheetPanel.querySelector('#ed-bw')?.checked),
            tracksMachine: Boolean(sheetPanel.querySelector('#ed-track')?.checked),
          };

          await updateBoot(upsertExerciseIn(state.boot, next));
          closeSheet();
          render();
          toast('Saved');
          mirror('/api/exercises', next);
          return;
        }

        if (e.target.closest('[data-ed-archive]')) {
          const retiring = !draft.archived;
          if (retiring && !confirm(`Retire "${lift.name}"? Logged sets are kept.`)) return;
          await updateBoot(upsertExerciseIn(state.boot, { ...draft, archived: retiring }));
          closeSheet();
          render();
          toast(retiring ? 'Retired' : 'Back in the pickers');
        }
      },
    );
  };

  paint();
}

/**
 * Give a new member the four-day glute program, and reconcile an older version.
 *
 * Additive and idempotent by day id, so a registration corrected a second time
 * does not duplicate her week. Days she invented herself are left alone.
 *
 * **It also retires days of a previous version of her program that this version
 * no longer has** — but only ones she has never trained. The program was rewritten
 * once (a lower/upper/lower split became four near-full-body days), and without
 * this her phone would have carried both: seven days, three of them stale, with no
 * way to tell which four were current. A day with sets logged against it is her
 * training and stays whatever the template now says, for the same reason the
 * seeded templates are only cleared on a phone with no history at all.
 */
async function installMemberProgram() {
  if (!state.boot) return;

  /**
   * Only for the person it was written for.
   *
   * This ran for every member, so the second account invited would have signed
   * in and found a four-day glute-focused split built around somebody else's
   * goals and somebody else's starting loads. Everyone else keeps the two
   * programs the app ships with — the same ones the admin has — which is a
   * sensible place to land. A programme written *for* somebody is a coach
   * assigning one, and that is Phase 5, not a default.
   */
  if (!programForMember(state.account)) return;

  // Through the bootstrap helpers rather than by hand: a day is not a plain
  // object, it carries the resolved lift names, positions and per-slot equipment
  // that the plate calculator reads. Building one literally is how a screen ends
  // up showing an exercise id instead of a name.
  let boot = upsertProgramIn(state.boot, {
    id: MEMBER_PROGRAM.id,
    name: MEMBER_PROGRAM.name,
    daysPerWeek: MEMBER_PROGRAM.daysPerWeek,
  });

  const current = new Set(MEMBER_PROGRAM.days.map((d) => d.id));
  const trained = new Set(state.sessions.map((s) => s.dayId));

  for (const day of boot.days ?? []) {
    if (day.programId !== MEMBER_PROGRAM.id) continue;
    if (current.has(day.id) || trained.has(day.id)) continue;
    // `removeDayFrom`, which records a tombstone — filtering the array by hand
    // does not stick, because `mergeSeed` re-adds any day the phone is missing.
    boot = removeDayFrom(boot, day.id);
  }

  const have = new Set((boot.days ?? []).map((d) => d.id));
  for (const day of MEMBER_PROGRAM.days) {
    if (have.has(day.id)) continue;
    boot = upsertDayIn(boot, { ...day, programId: MEMBER_PROGRAM.id });
  }

  // On a phone with nothing logged, the seeded programs are templates nobody has
  // used, and leaving them turns her Train tab into thirteen days of which four
  // are hers. They are only removed when there is **no history at all** — a
  // program with sets logged against it is somebody's training, and clearing it
  // to tidy a screen would be destroying data to improve a layout.
  if (!state.sessions.length) {
    // Through `removeProgramFrom`, which records the deletion. Filtering the
    // arrays by hand does not stick: `mergeSeed` re-adds any seed day the phone
    // is missing, so the templates were back on the next launch.
    for (const program of (boot.programs ?? []).map((p) => p.id)) {
      if (program !== MEMBER_PROGRAM.id) boot = removeProgramFrom(boot, program);
    }
  }

  await updateBoot(boot);
}

/** Read the registration form, so a repaint never loses what was typed. */
function readRegisterFields() {
  const value = (id) => view.querySelector(id)?.value?.trim() ?? '';
  return {
    ...(state.registerDraft ?? {}),
    age: value('#reg-age'),
    heightInches: value('#reg-height'),
    weight: value('#reg-weight'),
    bodyFatLow: value('#reg-bf-low'),
    bodyFatHigh: value('#reg-bf-high'),
    averageSteps: value('#reg-steps'),
  };
}

/**
 * Fetch one member's training into a read-only snapshot.
 *
 * **Not into `state.sessions`.** That array is what the sync uploads and what the
 * local store persists, so borrowing it for somebody else's workouts would put her
 * sets in his account the next time either happened. A separate snapshot, held in
 * memory and never written to IndexedDB, cannot do that — and the server refuses a
 * write with `?userId=` regardless, which is the second independent reason.
 */
async function loadMemberTraining(person) {
  state.viewingAs = { ...person, loading: true, error: false, sessions: [], metrics: [], program: null };
  render(true);

  try {
    const res = await fetch(api(`/api/pull?userId=${encodeURIComponent(person.id)}`), {
      cache: 'no-store', headers: authHeader(),
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();

    state.viewingAs = {
      ...person,
      loading: false,
      error: false,
      sessions: (body.sessions ?? []).slice().sort((a, b) =>
        String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? ''))),
      metrics: body.metrics ?? [],
      program: body.program ?? null,
    };
  } catch {
    state.viewingAs = { ...person, loading: false, error: true, sessions: [], metrics: [], program: null };
  }

  render(true);
}

/**
 * Approve or reject a submitted gym.
 *
 * Server first, and only then locally: this is a decision about **everybody's**
 * picker, so a phone that applied it optimistically and failed to reach the
 * server would be the only device that believed it. The opposite of the rule for
 * a weight, which must land locally with no signal — and the difference is
 * whether the answer is this person's to give.
 */
async function setGymVisibility(gymId, visibility) {
  if (!isAdmin() || !gymId) return;

  try {
    const body = await postJSON(`/api/gyms/${encodeURIComponent(gymId)}`, { visibility });
    if (Array.isArray(body?.gyms)) {
      await updateBoot({ ...state.boot, gyms: mergeGyms(state.boot.gyms ?? [], body.gyms, state.boot.hiddenGyms ?? []) });
    }
    toast(visibility === 'public' ? 'On everyone\u2019s list' : 'Taken off the list');
  } catch {
    toast('Could not reach the server — nothing changed');
  }
  render(true);
}

/**
 * Offer to coach somebody.
 *
 * Creates the edge with every consent off. Asking is not being allowed — the row
 * exists so they have something to answer, because a consent screen with nothing
 * on it cannot be used to grant anything.
 */
async function offerToCoach(clientId) {
  if (!clientId) return;

  try {
    const body = await postJSON(`/api/coaching/${encodeURIComponent(clientId)}`, {});
    state.coaching = { coaches: body.coaches ?? [], clients: body.clients ?? [] };
    await db.setMeta('coaching', state.coaching);
    toast('Asked. They decide what you see.');
  } catch {
    toast('Could not reach the server');
  }
  render(true);
}

/**
 * Change one consent.
 *
 * Sends only the switch that moved. The server leaves a key it was not given
 * exactly as it was, so a screen that sends one thing cannot silently revoke the
 * other two — and the local copy is updated from the server's answer rather than
 * optimistically, because this is a decision about what somebody else may see and
 * the only honest source for it is the server that enforces it.
 */
async function setConsent(coachId, key, on) {
  if (!coachId || !key) return;

  try {
    const body = await postJSON(`/api/coaching/${encodeURIComponent(coachId)}/consent`, { [key]: on });
    state.coaching = { coaches: body.coaches ?? [], clients: body.clients ?? [] };
    await db.setMeta('coaching', state.coaching);
  } catch {
    toast('Could not reach the server — nothing changed');
  }
  render(true);
}

/** Who coaches whom. Fetched alongside the account, cached for no signal. */
async function loadCoaching() {
  if (!state.account) return;

  try {
    const res = await fetch(api('/api/coaching'), { cache: 'no-store', headers: authHeader() });
    if (!res.ok) return;
    const body = await res.json();
    state.coaching = { coaches: body.coaches ?? [], clients: body.clients ?? [] };
    await db.setMeta('coaching', state.coaching);
    render();
  } catch {
    /* the cached copy stands */
  }
}

/** Who has access. Loaded on demand, because it is one screen out of twelve. */
async function loadAccounts() {
  try {
    const res = await fetch(api('/api/users'), { cache: 'no-store', headers: authHeader() });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    state.accounts = body.users ?? [];
  } catch {
    state.accounts = [];
    toast('Could not load the accounts');
  }
  render();
}

/**
 * The invitation code, shown once.
 *
 * Only its hash is stored, so there is no screen anywhere that can show it again.
 * Saying that here — on the one occasion it is visible — is much cheaper than the
 * discovery a week later.
 */
function showInviteCode(user) {
  openSheet(
    `<h2 class="mt-0">${esc(user.name)} can sign in</h2>
     <div class="tiny muted mb-3">
       Send them this code with the link to the app. <b>It is shown only now</b> — only a
       hash of it is kept, so nothing can display it again. If it goes astray, issue a new
       one, which invalidates this one.
     </div>
     <div class="card mono break-all text-xs p-3.5">${esc(user.token)}</div>
     <button class="btn btn-block mt-3" data-copy-code="1">Copy the code</button>
     <button class="btn btn-primary btn-block btn-lg mt-2" data-close-code="1">Done</button>`,
    async (e) => {
      if (e.target.closest('[data-copy-code]')) {
        try {
          await navigator.clipboard.writeText(user.token);
          toast('Copied');
        } catch {
          toast('Select it and copy by hand');
        }
        return;
      }
      if (e.target.closest('[data-close-code]')) closeSheet();
    },
  );
}

/** A short text prompt, rendered as a sheet so it matches the rest of the app. */
function openTextSheet({ title, label, value = '', placeholder = '', onSave }) {
  openSheet(
    `<h2 class="mt-0">${esc(title)}</h2>
     <label class="tiny muted">${esc(label)}</label>
     <input class="input mx-0 mt-2 mb-3.5" id="text-field" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">
     <button class="btn btn-primary btn-block btn-lg" data-save="1">Save</button>`,
    (e) => {
      if (!e.target.closest('[data-save]')) return;
      const next = sheetPanel.querySelector('#text-field')?.value?.trim() ?? '';
      if (!next) return toast('Type something first');
      closeSheet();
      onSave(next);
    },
  );
  focusFirstField('#text-field');
}

/**
 * The lift library. Filtering hides rows in place rather than re-rendering,
 * because rebuilding the markup on each keystroke would drop keyboard focus.
 */
function openExerciseLibrary(onPick) {
  const items = (state.boot.exercises ?? []).filter((e) => !e.archived);

  openSheet(
    `<h2 class="mt-0">Choose a lift</h2>
     <input class="searchbar" id="ex-q" placeholder="Search…" autocomplete="off">
     <div id="ex-list">
       ${items
         .map(
           (e) => `<button class="picker-item" data-pick="${esc(e.id)}" data-name="${esc(e.name.toLowerCase())}">
             ${groupGlyph(e.muscleGroup)}
             <div class="grow min-w-0">
               <b class="t text-lg">${esc(e.name)}</b>
               <div class="tiny muted">${esc(e.muscleGroup ?? '')} · ${esc(getBarType(e.barType).name)}</div>
             </div>
           </button>`,
         )
         .join('')}
     </div>
     <button class="btn btn-block mt-2.5" data-newex="1">+ Create a new lift</button>`,
    (e) => {
      if (e.target.id === 'ex-q') {
        const q = e.target.value.trim().toLowerCase();
        for (const el of sheetPanel.querySelectorAll('[data-pick]')) {
          el.style.display = el.dataset.name.includes(q) ? '' : 'none';
        }
        return;
      }
      if (e.target.closest('[data-newex]')) {
        closeSheet();
        return openNewExerciseSheet(onPick);
      }
      const pick = e.target.closest('[data-pick]');
      if (pick) {
        closeSheet();
        onPick(pick.dataset.pick);
      }
    },
  );
}

function openNewExerciseSheet(onCreated) {
  openSheet(
    `<h2 class="mt-0">New lift</h2>
     <label class="tiny muted">Movement</label>
     <input class="input mx-0 mt-2 mb-3.5" id="nx-name" placeholder="e.g. Cable Tricep Pushdown" autocomplete="off">

     <div class="tiny muted mb-2">
       On a machine or cable, the unit and the handle change what the same movement takes.
       Put them here rather than in the name, and the two versions stay comparable as one movement.
     </div>
     <div class="meta-grid">
       <input class="input" id="nx-machine" placeholder="Machine (e.g. Eleiko)" autocomplete="off">
       <input class="input" id="nx-handle" placeholder="Handle / grip" autocomplete="off">
     </div>

     <label class="tiny muted">Equipment — this drives the plate calculator</label>
     <select class="input mx-0 mt-2 mb-3.5" id="nx-bar">
       ${BAR_TYPES.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}${b.weight ? ` (${b.weight} lb)` : ''}</option>`).join('')}
     </select>

     <label class="tiny muted">Muscle group</label>
     <select class="input mx-0 mt-2 mb-3.5" id="nx-group">
       <option value="">—</option>
       ${MUSCLE_GROUPS.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}
     </select>

     <label class="tiny muted">A variant of an existing movement? (optional)</label>
     <select class="input mx-0 mt-2 mb-3.5" id="nx-variant">
       <option value="">no — it stands on its own</option>
       ${[...state.boot.exercises]
         .filter((x) => !x.variantOf)
         .sort((a, b) => a.name.localeCompare(b.name))
         .map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}
     </select>

     <label class="tiny muted">Notes — setup that changes the movement</label>
     <input class="input mx-0 mt-2 mb-3" id="nx-notes" placeholder="e.g. pad under hips for extra range" autocomplete="off">

     <label class="tiny muted">How the weight is entered</label>
     <select class="input mx-0 mt-2 mb-1" id="nx-entry">
       <option value="auto">From the name — dumbbell lifts ask for one bell</option>
       <option value="per-hand">One dumbbell — typing 35 records 70 moved</option>
       <option value="total">The whole load — a bar, a machine, one bell in both hands</option>
     </select>
     <div class="tiny muted mb-3">
       A new dumbbell lift asks for the bell, not the pair, because the bell is the only
       number written on anything in the gym. What gets stored is always the total.
     </div>

     <label class="row gap-2.5 mb-3.5">
       <input type="checkbox" id="nx-uni">
       <span class="tiny">One side at a time — so one dumbbell <b>is</b> the whole load</span>
     </label>

     <label class="row gap-2.5 mb-3.5">
       <input type="checkbox" id="nx-bw">
       <span class="tiny">Can be done with no added weight (pull-ups, dips)</span>
     </label>

     <button class="btn btn-primary btn-block btn-lg" data-create="1">Create</button>`,
    async (e) => {
      const createBtn = e.target.closest('[data-create]');
      if (!createBtn || createBtn.disabled) return;
      const name = sheetPanel.querySelector('#nx-name')?.value?.trim();
      if (!name) return toast('Name it first');

      const field = (id) => sheetPanel.querySelector(id)?.value?.trim() || null;

      /**
       * A new dumbbell lift asks for one bell unless told otherwise.
       *
       * Read from the name at create time rather than at render time, because the
       * name is typed after the sheet is open — so there is nothing to read from
       * until the moment Create is pressed. Choosing explicitly overrides it.
       */
      const chosen = sheetPanel.querySelector('#nx-entry')?.value ?? 'auto';
      const entry = chosen === 'auto' ? (looksPaired({ name }) ? 'per-hand' : 'total') : chosen;

      const payload = {
        id: `${slug(name)}-${uid().slice(0, 4)}`,
        name,
        machine: field('#nx-machine'),
        handle: field('#nx-handle'),
        notes: field('#nx-notes') ?? '',
        variantOf: field('#nx-variant') ?? undefined,
        bodyweight: Boolean(sheetPanel.querySelector('#nx-bw')?.checked),
        barType: sheetPanel.querySelector('#nx-bar')?.value ?? 'olympic',
        muscleGroup: normaliseMuscleGroup(field('#nx-group')),
        entry,
        unilateral: Boolean(sheetPanel.querySelector('#nx-uni')?.checked),
        // Nothing to clean up later: the question was answered when it was created.
        unitConfirmed: true,
      };

      createBtn.disabled = true;
      createBtn.textContent = 'Creating…';
      // Created on the phone first, so this works with no server in reach.
      await updateBoot(upsertExerciseIn(state.boot, payload));
      closeSheet();
      onCreated(payload.id);
      mirror('/api/exercises', payload);
    },
  );
  focusFirstField('#nx-name');
}

function openExercisePicker() {
  const a = state.active;
  const rows = a.plan.exercises
    .map((e, i) => {
      const st = a.ex[e.dayExerciseId];
      const done = st.logged.filter(Boolean).length;
      return `<button class="setrow ${i === a.exIndex ? 'current' : done === st.logged.length ? 'done' : ''} w-full"
        data-jump="${i}">
        <div class="idx">${i + 1}</div>
        <div class="grow text-left"><b>${esc(e.name)}</b></div>
        <span class="tiny muted mono">${done}/${st.logged.length}</span>
      </button>`;
    })
    .join('');

  openSheet(`<h2 class="mt-0">Jump to exercise</h2>${rows}`, (e) => {
    const t = e.target.closest('[data-jump]');
    if (!t) return;
    state.active.exIndex = Number(t.dataset.jump);
    closeSheet();
    persistActive();
    render();
  });
}

/* =============================== events ================================= */

sheet.addEventListener('click', (e) => {
  if (e.target.dataset.close) {
    /**
     * The tail of the tap that opened it is not a dismissal — but only the
     * **backdrop** is ignored, never a button.
     *
     * A sheet that re-renders itself calls `openSheet` again and restarts the
     * clock, so deafening every `data-close` target swallowed the deliberate
     * "Done" press right after an import finished. The backdrop is the thing a
     * stray second tap lands on; a button is always meant.
     */
    const isBackdrop = e.target.classList.contains('sheet-backdrop');
    if (isBackdrop && Date.now() - sheetOpenedAt < SHEET_DEAF_MS) return;
    return closeSheet();
  }
  sheetState?.onEvent?.(e);
});
sheet.addEventListener('change', (e) => sheetState?.onEvent?.(e));
sheet.addEventListener('input', (e) => sheetState?.onEvent?.(e));

nav.addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-btn');
  if (btn) go(btn.dataset.route);
});

view.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  const a = state.active;

  switch (act) {
    case 'retry-boot': return boot().catch((err) => showFatal(err?.message ?? String(err), 'boot'));
    case 'hard-reload': return location.reload();
    case 'drop-active': {
      // Last resort when a half-finished workout is what is breaking startup.
      await db.delMeta('active');
      return location.reload();
    }
    case 'home': return go('home');
    case 'history': return go('history');
    case 'resume': return go('session');
    case 'start': return openGymSheet(t.dataset.id);
    case 'exercise': return go('exercise', t.dataset.id);

    case 'cal-prev':
    case 'cal-next': {
      state.calMonth = shiftMonth(state.calMonth.year, state.calMonth.month, act === 'cal-next' ? 1 : -1);
      state.calPinned = true;
      state.openDay = null;
      return render();
    }

    case 'cal-day': {
      // Tapping the open day closes it again.
      state.openDay = state.openDay === t.dataset.date ? null : t.dataset.date;
      return render();
    }

    case 'ov-show': {
      a.view = 'overview';
      await persistActive();
      return render();
    }

    case 'ov-open': {
      a.exIndex = Number(t.dataset.i);
      a.view = 'exercise';
      await persistActive();
      return render();
    }

    case 'ov-unpair': {
      a.plan.exercises = breakSuperset(a.plan.exercises, t.dataset.ss);
      a._dirty = true;
      await persistActive();
      return render();
    }

    // Supersets genuinely are structural, so the button follows the level. The
    // guard is here as well as on the button because a dead control is worse
    // than a hidden one, and this project has shipped one of those.
    case 'ov-pair': return recordsField(detailLevel(), 'superset') ? openBundleSheet() : undefined;

    case 'save-today': {
      /**
       * The draft wins over the DOM, where this used to read the DOM alone.
       *
       * `readDayRow` re-derives what the user typed from the rendered inputs —
       * but the inputs are a *rendering* of intent, and `render()` rebuilds
       * them from `state`. If a repaint lands between a field being edited and
       * Save being pressed, the field is re-rendered from the stored value and
       * the edit is read straight back out as though it had never happened.
       * A cleared field is the case that actually loses data: the old reading
       * returns to the box and Save writes it back.
       *
       * `state.dayDraft` is the intent itself. It is recorded on `input`, it is
       * keyed by date so a stale one cannot bleed across rows, and it survives
       * repaints — which is the whole reason it exists. Reading the DOM and
       * then letting the draft override it keeps untouched fields coming from
       * what is on screen while making every *edited* field come from what was
       * actually typed.
       *
       * This is the suspected cause of `energy.spec.js` finding a cleared
       * reading still in storage under parallel load. Suspected, not proven —
       * the sequence will not reproduce outside the full suite.
       */
      const today = todayISO();
      const root = view.querySelector(`[data-day="${today}"]`);
      if (!root) return;

      const typed = state.dayDraft?.date === today ? state.dayDraft.values : {};
      return saveDay(today, { ...readDayRow(root), ...typed });
    }

    case 'edit-day': return openDaySheet(t.dataset.date);

    case 'fix-length': return openLengthSheet(t.dataset.id);

    case 'summary-go': return requestSummary();

    case 'summary-cancel': {
      summaryAbort?.abort('cancelled');
      return;
    }

    case 'gyms': return go('gyms');

    case 'gym-rename': {
      const gym = gymById(t.dataset.id);
      if (!gym) return;
      const name = prompt('Rename this gym', gym.name)?.trim();
      if (!name || name === gym.name) return;
      await saveGym({ ...gym, name });
      return render();
    }

    case 'gym-delete': {
      const gym = gymById(t.dataset.id);
      if (!gym) return;

      /**
       * Hidden, not destroyed — and the wording now says what actually happens.
       *
       * It used to filter the gym out of the program, which took the machine map
       * inside it with it, uploaded the stripped program over the cloud's only
       * copy, and was then undone anyway by the next sync putting the gym back.
       * The old confirm text promised the machines would go; they went, and the
       * gym stayed. Precisely backwards.
       */
      const count = allMachinesAt(gym).length;
      const warning = count
        ? `Remove ${gym.name} from your list? The ${count} machine${count === 1 ? '' : 's'} recorded there are kept, and you can add it back.`
        : `Remove ${gym.name} from your list?`;
      if (!confirm(warning)) return;

      await updateBoot(hideGymIn(state.boot, gym.id));
      render();
      toast(`${gym.name} removed from your list`);
      return;
    }

    case 'gym-unhide': {
      await updateBoot(showGymIn(state.boot, t.dataset.id));
      render();
      toast('Back on your list');
      return;
    }

    case 'feel': return openFeelSheet(Number(t.dataset.i));

    case 'aids': return openAidsSheet(currentExercise());

    case 'tempo': return openTempoSheet(currentExercise());

    case 'machine': return openMachineSheet(currentExercise());

    case 'log-set': return logCurrentSet();
    case 'undo': return undoLastSet();
    case 'add-set': {
      const ex2 = currentExercise();
      a.ex[ex2.dayExerciseId] = addSetTo(a.ex[ex2.dayExerciseId]);
      a._dirty = true;
      await persistActive();
      return render();
    }

    case 'del-set': {
      const ex2 = currentExercise();
      const out = removeSetAt(a.ex[ex2.dayExerciseId], a.sets, ex2.exerciseId, Number(t.dataset.i));
      a.ex[ex2.dayExerciseId] = out.state;
      a.sets = out.sets;
      a._dirty = true;
      await persistActive();
      return render();
    }

    // Swapping and adding mid-session: the day is a suggestion, and what a
    // machine is free or how you feel decides the rest.
    case 'session-swap':
      return openExerciseLibrary(async (exerciseId) => {
        const planned = plannedExerciseFor(exerciseId);
        a.plan.exercises[a.exIndex] = planned;
        a.ex[planned.dayExerciseId] = freshExerciseState(planned);
        a._dirty = true;
        await persistActive();
        render();
      });

    case 'session-add':
      return openExerciseLibrary(async (exerciseId) => {
        const planned = plannedExerciseFor(exerciseId);
        a.plan.exercises.push(planned);
        a.ex[planned.dayExerciseId] = freshExerciseState(planned);
        a.exIndex = a.plan.exercises.length - 1;
        a.restEndsAt = null;
        a._dirty = true;
        await persistActive();
        render();
      });
    case 'open-weight': return openWeightSheet();
    case 'open-reps': return openRepsSheet();
    case 'pick-ex': return openExercisePicker();

    case 'w-up':
    case 'w-down': {
      const ex = currentExercise();
      const st = a.ex[ex.dayExerciseId];
      const idx = currentSetIndex(st);
      const delta = Number(t.dataset.step) * (act === 'w-up' ? 1 : -1);
      return setWeight(idx, Math.max(0, (st.weights[idx] ?? 0) + delta));
    }

    case 'repeat-set': {
      /**
       * Fill both steppers from what was done on this set last time.
       *
       * The values come off the button rather than being recomputed, because
       * the button is what the user read before tapping it — recomputing here
       * could, in principle, answer with a different number than the one on
       * screen if the machine changed under an open view, and filling a field
       * with something other than what the control said is worse than not
       * filling it at all.
       */
      const ex = currentExercise();
      const st = a.ex[ex.dayExerciseId];
      const idx = currentSetIndex(st);

      st.repDraft = Math.max(0, Number(t.dataset.r) || 0);
      await setWeight(idx, Math.max(0, Number(t.dataset.w) || 0));
      return;
    }

    case 'r-up':
    case 'r-down': {
      const ex = currentExercise();
      const st = a.ex[ex.dayExerciseId];
      const idx = currentSetIndex(st);
      const current = st.repDraft ?? defaultReps(withRecall(ex), st, idx);
      st.repDraft = Math.max(0, current + (act === 'r-up' ? 1 : -1));
      await persistActive();
      return render();
    }

    case 'next-ex': {
      if (a.exIndex + 1 >= a.plan.exercises.length) return finishSession();
      a.exIndex++;
      a.restEndsAt = null;
      await persistActive();
      return render();
    }
    case 'prev-ex': {
      if (a.exIndex === 0) return;
      a.exIndex--;
      a.restEndsAt = null;
      await persistActive();
      return render();
    }

    case 'rest-add': a.restEndsAt = Math.max(Date.now(), a.restEndsAt) + 30000; await persistActive(); return render();
    case 'rest-skip': a.restEndsAt = null; await persistActive(); return render();

    case 'finish': {
      if (a.sets.length && !confirm(`Finish ${a.dayName}? ${a.sets.length} sets logged.`)) return;
      return finishSession();
    }

    /* ------------------------------ editor ------------------------------ */

    case 'edit': return go('edit');
    case 'library': return go('library');

    /*
     * The way back out of an admin screen for somebody who is not an admin.
     *
     * `adminSwitch` has always drawn this button and the dispatcher never had a
     * branch for it, so the one escape hatch on those screens swallowed the tap.
     * It is a fallback — reached when a role changes under a view that is still
     * open — which means it is met by exactly the person least able to work out
     * why nothing happened.
     */
    case 'setup': return go('setup');

    /* ------------------------- signing in ---------------------------- */

    case 'welcome-signin': {
      // The field first, the draft as the fallback — a render may have just
      // rebuilt the box, and the draft is what survives that.
      const code = (view.querySelector('#welcome-code')?.value ?? state.codeDraft ?? '').trim();
      if (!code) return toast('Paste the code from your email');
      state.codeDraft = code;

      state.settings.serverUrl = CLOUD_URL;
      state.settings.authToken = code;
      await db.setMeta('settings', state.settings);

      state.accountError = '';
      render(true);

      const reachable = await checkServer();
      if (!reachable) {
        state.accountError = 'Could not reach the server. Check your connection and try again.';
        return render(true);
      }

      const account = await fetchAccount();
      if (!account) {
        // The token goes back out, so nothing is left configured that does not
        // work — an app that thinks it is signed in and is not backs up nowhere
        // and says nothing about it.
        state.settings.authToken = '';
        await db.setMeta('settings', state.settings);

        state.accountError = state.accountError
          || 'That code was not recognised. Check it against the email.';
        return render(true);
      }

      state.codeDraft = '';
      await signInSettled();

      // Straight on to the next screen. The first sync is NOT awaited: it is a
      // push, a pull and several writes, and making somebody watch a sign-in
      // screen until it finishes is both slower than it needs to be and the
      // difference between a sign-in that works on a bad connection and one that
      // appears to hang. Anything it pulls down repaints when it lands.
      state.tourStep = 0;
      state.tourFrom = 'onboarding';
      state.route = 'tour';
      render(true);
      sync({ quiet: true });
      return;
    }

    case 'use-cloud': {
      // One tap rather than typing a URL on a phone. It is the same address for
      // everyone and holds nothing without a token.
      state.settings.serverUrl = CLOUD_URL;
      await db.setMeta('settings', state.settings);
      toast('Pointed at the cloud');
      render(true);
      if (await checkServer()) { await fetchAccount(); render(true); }
      return;
    }

    case 'welcome-solo': {
      // Exactly what the app has always been: no account, no cloud, everything
      // on the phone. His own install of a new phone lands here.
      state.settings.authToken = '';
      await db.setMeta('settings', state.settings);
      await signInSettled();
      state.account = null;
      state.tourStep = 0;
      state.tourFrom = 'onboarding';
      state.route = 'tour';
      return render(true);
    }

    /* ------------------------ the walkthrough ------------------------ */

    case 'tour-next': state.tourStep = Math.min(state.tourStep + 1, TOUR.length - 1); return render(true);
    case 'tour-back': state.tourStep = Math.max(state.tourStep - 1, 0); return render(true);

    /**
     * Where the first walkthrough ends depends on why it was opened.
     *
     * From onboarding it leads into the second one, which is the whole point of
     * there being two. From Setup it ends at Train, because somebody looking
     * something up has not asked to be onboarded — and that has been this
     * button's contract since the walkthrough was written.
     */
    case 'tour-done':
      if (state.tourFrom === 'onboarding' && !planAnswered()) {
        state.tourFrom = null;
        state.planStep = 0;
        state.planStage = 'tour';
        state.route = 'plan';
        return render(true);
      }
      state.tourFrom = null;
      state.route = 'home';
      return render(true);

    case 'tour-open':
      state.tourStep = 0;
      state.tourFrom = 'setup';
      state.route = 'tour';
      return render(true);

    /* ---------------------- the second walkthrough ------------------- */

    case 'plan-next': state.planStep = Math.min(state.planStep + 1, PLAN_TOUR.length - 1); return render(true);
    case 'plan-back': state.planStep = Math.max(state.planStep - 1, 0); return render(true);

    case 'plan-open':
      state.planStep = 0;
      state.planStage = 'tour';
      state.planProgram = null;
      state.route = 'plan';
      return render(true);

    /**
     * The three answers, all recorded rather than inferred.
     *
     * Somebody who declined and somebody who never saw the question need
     * different things said to them later, so a tap outside or a timeout is not
     * an answer. `out` and `later` record the same choice — both declined the
     * measuring week — and differ only in what happens next.
     *
     * Declining the week goes **to the questions**, not to Train. The estimate
     * offered instead needs to know who it is for, and it needs a week to put
     * the weights against. `later` is the exit that asks for nothing.
     */
    case 'plan-out':
      state.settings.planChoice = 'out';
      await db.setMeta('settings', state.settings);
      state.planStage = 'questions';
      return render(true);

    case 'plan-later':
      state.settings.planChoice = 'out';
      await db.setMeta('settings', state.settings);
      state.route = 'home';
      return render(true);

    case 'plan-in':
      state.settings.planChoice = 'in';
      await db.setMeta('settings', state.settings);
      state.planStage = 'questions';
      return render(true);

    // Straight to the fields themselves, rather than to Setup's front door.
    // "Add my weight and sex" that lands somewhere they then have to search is
    // the same dead end as the button that promised an estimate and gave none.
    case 'plan-fill-in':
      state.setupTab = 'you';
      state.route = 'setup';
      return render(true);

    case 'q-experience':
      state.planDraft = { ...state.planDraft, experience: t.dataset.value };
      return render(true);

    case 'q-days':
      state.planDraft = { ...state.planDraft, daysPerWeek: Number(t.dataset.value) };
      return render(true);

    // Tapping the chosen group again clears it, because "no preference" has to
    // be reachable after a mis-tap without starting the questions over.
    case 'q-priority':
      state.planDraft = {
        ...state.planDraft,
        priority: state.planDraft?.priority === t.dataset.value ? null : t.dataset.value,
      };
      return render(true);

    case 'plan-build': {
      if (!planReady()) return;
      const program = prescribe(normaliseIntake(state.planDraft), { exercises: state.boot.exercises ?? [] });
      if (!program) return toast('Could not build a week from that');

      /**
       * Kept, because it is an answer about the person and not about this screen.
       *
       * Everything that reads it later needs it: the reserve to leave on a top
       * set, and the suggested starting weight, which moves by nearly a factor
       * of two between the first bucket and the last. Held only in `planDraft`
       * it would be gone the moment the week was installed.
       */
      state.settings.experience = state.planDraft.experience;
      await db.setMeta('settings', state.settings);

      state.planProgram = program;
      state.planStage = 'result';
      return render(true);
    }

    case 'plan-redo':
      state.planProgram = null;
      state.planStage = 'questions';
      return render(true);

    case 'plan-install': {
      if (!state.planProgram) return;
      await installPrescribed(state.planProgram);
      toast('Your week is in');
      state.planProgram = null;
      state.planStage = 'tour';
      state.route = 'home';
      return render(true);
    }

    /* -------------------------- registration ------------------------- */

    case 'reg-sex':
    case 'reg-goal': {
      const key = t.dataset.act === 'reg-sex' ? 'sex' : 'goal';
      // Typed values live in the draft alongside the tapped ones, or a render
      // triggered by tapping a button would throw away the numbers.
      state.registerDraft = { ...readRegisterFields(), [key]: t.dataset.value };
      return render(true);
    }

    case 'reg-save': {
      const d = readRegisterFields();
      state.registerDraft = d;

      const missing = [];
      if (!numericValue(d.age)) missing.push('age');
      if (!numericValue(d.heightInches)) missing.push('height');
      if (!d.sex) missing.push('sex');
      if (!numericValue(d.weight)) missing.push('bodyweight');
      if (!d.goal) missing.push('what you are doing');

      if (missing.length) {
        state.accountError = `Still needed: ${missing.join(', ')}.`;
        return render(true);
      }

      const low = numericValue(d.bodyFatLow);
      const high = numericValue(d.bodyFatHigh);
      if (low !== null && high !== null && low > high) {
        state.accountError = 'The body fat range runs backwards — the lower number goes first.';
        return render(true);
      }

      // Written locally first. The estimates read `state.settings`, so this is
      // what makes them work at all, and it must not depend on the network.
      state.settings = {
        ...state.settings,
        age: numericValue(d.age),
        heightInches: numericValue(d.heightInches),
        sex: d.sex,
        bodyFatLow: low,
        bodyFatHigh: high,
        goal: d.goal,
      };
      await db.setMeta('settings', state.settings);

      // Today's weight becomes a real reading, so the trend has its first point.
      state.metrics = setDayMetrics(state.metrics, todayISO(), { body_weight: d.weight });
      await db.setMeta('metrics', state.metrics);

      /**
       * Through `settingsToProfile`, not by hand.
       *
       * This built the birth year as `new Date().getFullYear() - Number(d.age)`,
       * and `Number('')` is **0** — so somebody who skipped the age field
       * uploaded `birthYear: 2026`. The Worker's `inRange(…, 1900, 2100)`
       * accepts that happily, and every resting-burn figure downstream was then
       * computed for a newborn, on the one screen a new member cannot skip past.
       *
       * Seventh time `Number(null) === 0` has cost something here, and the third
       * copy of this conversion — `settingsToProfile` has done it correctly all
       * along, with a null guard and a `Math.round`. There is now one copy.
       */
      const payload = {
        ...settingsToProfile({
          age: numericValue(d.age),
          heightInches: numericValue(d.heightInches),
          sex: d.sex,
          bodyFatLow: low,
          bodyFatHigh: high,
          goal: d.goal,
        }),
        averageSteps: numericValue(d.averageSteps),
      };

      try {
        const res = await fetch(api('/api/profile'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeader() },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(String(res.status));

        const body = await res.json();
        state.account = { ...state.account, profile: body.profile };
        await db.setMeta('account', state.account);
      } catch {
        // Offline, or the server is down. The answers are already stored locally
        // and ride up on the next sync, so she is not held here — being unable to
        // reach a server is not a reason to refuse somebody their own app.
        state.account = {
          ...state.account,
          profile: { ...(state.account?.profile ?? {}), ...payload, onboardedAt: new Date().toISOString() },
        };
        await db.setMeta('account', state.account);
      }

      // Her program, installed only now. It is deliberately not in the shared
      // seed: `mergeSeed` is additive across every phone, and the first version
      // of this put "Lower · Glutes 1" on his Train tab.
      await installMemberProgram();

      state.accountError = '';
      state.registerDraft = null;
      state.tourStep = 0;
      state.tourFrom = 'onboarding';
      state.route = 'tour';
      render(true);
      sync({ quiet: true });
      return;
    }

    /* --------------------------- the accounts ------------------------ */

    case 'accounts': {
      state.route = 'accounts';
      render(true);
      return loadAccounts();
    }

    case 'my-training': {
      // Back to being a user. The snapshot is dropped rather than kept around:
      // stale numbers about somebody else are worse than none.
      state.viewingAs = null;
      state.route = 'home';
      return render(true);
    }

    case 'acct-invite': {
      return openTextSheet({
        title: 'Invite somebody',
        label: 'Their email address',
        placeholder: 'name@example.com',
        onSave: async (email) => {
          try {
            const res = await fetch(api('/api/users'), {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...authHeader() },
              body: JSON.stringify({ email, name: email.split('@')[0] }),
            });
            const body = await res.json();
            if (!res.ok) return toast(body.error ?? 'Could not create that account');

            await loadAccounts();
            // Shown once, because only the hash is stored and no screen can ever
            // show it again. Saying so here is cheaper than the discovery later.
            showInviteCode(body);
          } catch {
            toast('Could not reach the server');
          }
        },
      });
    }

    case 'acct-rotate': {
      const id = t.dataset.id;
      if (!confirm('Issue a new code? The old one stops working immediately.')) return;
      try {
        const res = await fetch(api(`/api/users/${encodeURIComponent(id)}/token`), {
          method: 'POST', headers: authHeader(),
        });
        const body = await res.json();
        if (!res.ok) return toast(body.error ?? 'Could not issue a new code');
        showInviteCode(body);
      } catch {
        toast('Could not reach the server');
      }
      return;
    }

    case 'acct-status': {
      const { id, status } = t.dataset;
      try {
        const res = await fetch(api(`/api/users/${encodeURIComponent(id)}`), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...authHeader() },
          body: JSON.stringify({ status }),
        });
        const body = await res.json();
        if (!res.ok) return toast(body.error ?? 'Could not change that');
        await loadAccounts();
        return render();
      } catch {
        return toast('Could not reach the server');
      }
    }

    /**
     * Look at a member's training.
     *
     * The first version of this set `state.viewingAs` and drew a banner, and
     * **nothing else read it** — the button was dead and the screen showed his own
     * log. Shipped with no test, which is exactly how a feature that does nothing
     * gets shipped.
     *
     * Her data is fetched into a snapshot held in memory and **never written to
     * IndexedDB**. That is the important part: `state.sessions` is what the sync
     * uploads and what the local store persists, so borrowing it for somebody
     * else's workouts would mean her sets arriving in his account on the next
     * sync. A separate read-only snapshot cannot do that.
     */
    case 'acct-view': {
      const person = (state.accounts ?? []).find((u) => u.id === t.dataset.id);
      if (!person) return;
      state.route = 'member';
      return loadMemberTraining(person);
    }

    case 'acct-view-refresh': {
      if (!state.viewingAs) return;
      return loadMemberTraining(state.viewingAs);
    }

    case 'acct-view-self': {
      state.viewingAs = null;
      state.route = 'accounts';
      return render(true);
    }

    case 'coach-tab': {
      state.coachTab = t.dataset.tab;
      state.coachFilter = null;
      return render(true);
    }

    case 'adv-toggle': {
      state.advOpen = !state.advOpen;
      return render(true);
    }

    case 'lift-toggle': {
      const id = t.dataset.id;
      state.coachOpen = state.coachOpen.includes(id)
        ? state.coachOpen.filter((x) => x !== id)
        : [...state.coachOpen, id];
      return render(true);
    }

    case 'setup-fold': {
      const id = t.dataset.fold;
      state.setupOpen = state.setupOpen.includes(id)
        ? state.setupOpen.filter((x) => x !== id)
        : [...state.setupOpen, id];
      return render(true);
    }

    case 'gym-panel': {
      const id = t.dataset.id;
      state.openGymPanel = state.openGymPanel === id ? null : id;
      return render(true);
    }

    case 'gym-inventory': return openInventorySheet(t.dataset.id);
    case 'gym-admins': return openGymAdminSheet(t.dataset.id);

    case 'program-toggle': {
      const id = t.dataset.id;
      state.collapsedPrograms = state.collapsedPrograms.includes(id)
        ? state.collapsedPrograms.filter((x) => x !== id)
        : [...state.collapsedPrograms, id];
      return render(true);
    }

    case 'setup-tab': {
      state.setupTab = t.dataset.tab;
      return render(true);
    }

    case 'level-basic':
    case 'level-full': return setLevel(t.dataset.act === 'level-full' ? 'full' : 'basic');

    case 'unit-lb':
    case 'unit-kg': return setWeightUnit(t.dataset.act === 'unit-kg' ? 'kg' : 'lb');

    case 'lift-note': return openNoteSheet(currentExercise());

    case 'coach-offer': return offerToCoach(t.dataset.id);

    case 'gym-approve': return setGymVisibility(t.dataset.id, 'public');
    case 'gym-reject': return setGymVisibility(t.dataset.id, 'rejected');

    case 'coach-filter': {
      // Tapping a count jumps to the list filtered to it, which is the fastest path
      // from "is anything wrong" to "which ones".
      state.coachFilter = t.dataset.status || null;
      state.coachTab = 'lifts';
      return render(true);
    }

    case 'adapt-open': return openSuggestionSheet(t.dataset.id);
    case 'adapt-undo': return undoChange(t.dataset.id);

    case 'demo-open': return openDemoSheet(t.dataset.id);

    case 'demo-set': {
      const lift = state.boot.exercises.find((x) => x.id === t.dataset.id);
      if (!lift) return;

      return openTextSheet({
        title: `A demonstration of ${lift.name}`,
        label: 'Paste a YouTube link',
        value: lift.videoUrl ?? '',
        placeholder: 'https://www.youtube.com/watch?v=…',
        onSave: async (url) => {
          if (!youtubeId(url)) return toast('That does not look like a YouTube link');
          const next = { ...lift, videoUrl: url.trim() };
          await updateBoot(upsertExerciseIn(state.boot, next));
          render();
          toast('Pinned');
        },
      });
    }

    case 'lib-edit': {
      const lift = state.boot.exercises.find((x) => x.id === t.dataset.id);
      if (lift) openExerciseEditor(lift);
      return;
    }

    // Both of these write `groupConfirmed`, whichever way he answers: the point
    // of the flag is that the question got asked once, not that it got agreed
    // with. Without it on the "keep" path the row comes back every visit and
    // the only way to be rid of it is to accept a suggestion he rejected.
    /**
     * Answer the one-dumbbell question for a lift.
     *
     * Both answers write `unitConfirmed`, so the row does not come back either way —
     * the point is that the question got asked once. "One dumbbell" also rewrites
     * that lift's logged weights, unless it is done one side at a time, where one
     * bell already is the whole load.
     */
    case 'unit-per-hand': {
      const lift = state.boot.exercises.find((x) => x.id === t.dataset.id);
      if (!lift) return toast('That lift is gone');

      const doubles = !lift.unilateral;
      const sets = state.sessions.reduce(
        (n, s) => n + (s.sets ?? []).filter((x) => x.exerciseId === lift.id && Number(x.weight) > 0).length, 0);

      if (doubles && sets && !confirm(
        `Double ${sets} logged set${sets === 1 ? '' : 's'} of ${lift.name}? `
        + 'They were one dumbbell, so the real load was twice that.')) return;

      await updateBoot(upsertExerciseIn(state.boot, {
        ...lift, entry: 'per-hand', unitConfirmed: true,
      }));

      if (doubles) {
        const rewritten = doubleLoggedWeights(state.sessions, lift.id);
        const touched = rewritten.filter((x) => x._dirty);
        state.sessions = rewritten;
        if (touched.length) await db.putSessions(touched);
      }

      render();
      toast(doubles ? `${lift.name} doubled` : `${lift.name} set to one dumbbell`);
      return;
    }

    case 'unit-total': {
      const lift = state.boot.exercises.find((x) => x.id === t.dataset.id);
      if (!lift) return toast('That lift is gone');

      await updateBoot(upsertExerciseIn(state.boot, {
        ...lift, entry: 'total', unitConfirmed: true,
      }));
      render();
      toast(`${lift.name} left as it is`);
      return;
    }

    case 'lib-regroup': {
      const lift = state.boot.exercises.find((x) => x.id === t.dataset.id);
      if (!lift) return toast('That lift is gone');
      const group = normaliseMuscleGroup(t.dataset.group);
      const next = { ...lift, muscleGroup: group, groupConfirmed: true };
      await updateBoot(upsertExerciseIn(state.boot, next));
      render();
      toast(`${lift.name} → ${group}`);
      mirror('/api/exercises', next);
      return;
    }

    case 'lib-keep-group': {
      const lift = state.boot.exercises.find((x) => x.id === t.dataset.id);
      if (!lift) return toast('That lift is gone');
      const next = { ...lift, groupConfirmed: true };
      await updateBoot(upsertExerciseIn(state.boot, next));
      render();
      mirror('/api/exercises', next);
      return;
    }

    // Folds two labels for one machine together, in the tally and in the sets
    // already logged. Scoped to this gym: the same name at another gym is a
    // different stack, and merging across them would put two machines in one
    // trend.
    case 'gym-merge-machine': {
      const gym = gymById(t.dataset.id);
      if (!gym) return toast('That gym is gone');

      const keep = t.dataset.keep;
      const drop = t.dataset.drop;
      await saveGym(renameMachineAt(gym, drop, keep));

      const relabelled = relabelMachine(state.sessions, { gymId: gym.id, from: drop, to: keep });
      const touched = relabelled.filter((x) => x._dirty);
      state.sessions = relabelled;
      if (touched.length) await db.putSessions(touched);

      render();
      toast(`Now all ${keep}`);
      return;
    }

    /**
     * `edit-program-day`, not `edit-day` — which was already taken.
     *
     * Two cases in this one switch answered to `edit-day`: the health readings
     * for a calendar day in Setup (keyed on `data-date`) and this one, a program
     * day on the Edit tab (keyed on `data-id`). The first wins, so **this was
     * unreachable** and tapping a day card on the Edit tab ran the readings sheet
     * with no date and threw. The whole program editor — rename a day, reorder
     * lifts, set schemes and rests, which the README documents at length — could
     * not be opened at all, and nothing tested it.
     */
    case 'edit-program-day': {
      const day = state.boot.days.find((x) => x.id === t.dataset.id);
      if (!day) return toast('That day is gone');
      state.draft = cloneDay(day, { defaultRestSeconds: state.settings.defaultRestSeconds });
      state.draftDirty = false;
      return go('edit-day');
    }

    case 'new-day': {
      const programId = t.dataset.id;
      const count = state.boot.days.filter((x) => x.programId === programId).length;
      state.draft = { id: `day-${uid().slice(0, 8)}`, programId, name: '', position: count, exercises: [] };
      state.draftDirty = true;
      return go('edit-day');
    }

    case 'new-program':
      return openTextSheet({
        title: 'New program', label: 'Name', placeholder: 'e.g. My Split',
        onSave: async (name) => {
          const program = { id: `prog-${uid().slice(0, 8)}`, name, daysPerWeek: 4 };
          await updateBoot(upsertProgramIn(state.boot, program));
          render();
          toast('Program created');
          mirror('/api/programs', program);
        },
      });

    case 'rename-program': {
      const program = state.boot.programs.find((x) => x.id === t.dataset.id);
      if (!program) return;
      return openTextSheet({
        title: 'Rename program', label: 'Name', value: program.name,
        onSave: async (name) => {
          await updateBoot(upsertProgramIn(state.boot, { ...program, name }));
          render();
          toast('Renamed');
          mirror('/api/programs', { ...program, name });
        },
      });
    }

    case 'ex-up':
    case 'ex-down': {
      const i = Number(t.dataset.i);
      const j = act === 'ex-up' ? i - 1 : i + 1;
      const list = state.draft.exercises;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      state.draftDirty = true;
      return render();
    }

    case 'ex-remove': {
      state.draft.exercises.splice(Number(t.dataset.i), 1);
      state.draftDirty = true;
      return render();
    }

    case 'ex-swap': {
      const i = Number(t.dataset.i);
      return openExerciseLibrary((exerciseId) => {
        const lift = state.boot.exercises.find((x) => x.id === exerciseId);
        state.draft.exercises[i] = { ...state.draft.exercises[i], exerciseId, name: lift?.name ?? exerciseId };
        state.draftDirty = true;
        render();
      });
    }

    case 'ex-rename': {
      const i = Number(t.dataset.i);
      const slot = state.draft.exercises[i];
      const lift = state.boot.exercises.find((x) => x.id === slot.exerciseId);
      if (!lift) return toast('Unknown lift');
      return openTextSheet({
        title: 'Rename lift', label: 'This renames it everywhere, and your history follows it.',
        value: lift.name,
        onSave: async (name) => {
          await updateBoot(upsertExerciseIn(state.boot, { ...lift, name }));
          state.draft.exercises[i] = { ...slot, name };
          render();
          mirror('/api/exercises', { ...lift, name });
        },
      });
    }

    case 'add-exercise':
      return openExerciseLibrary((exerciseId) => {
        const lift = state.boot.exercises.find((x) => x.id === exerciseId);
        state.draft.exercises.push({
          exerciseId,
          name: lift?.name ?? exerciseId,
          schemeId: 'rp-2',
          restSeconds: state.settings.defaultRestSeconds,
        });
        state.draftDirty = true;
        render();
      });

    case 'save-day': return saveDraftDay();
    case 'delete-day': return deleteDraftDay();
    case 'cancel-day': {
      state.draftDirty = false;
      state.draft = null;
      return go('edit');
    }

    case 'report-bug':
      return openSheet(
        `<h2 class="mt-0">What went wrong?</h2>
         <div class="tiny muted mb-2.5">Rough words are fine. What you did, what happened.</div>
         <textarea class="input min-h-27.5 p-2.5 resize-none" id="bug-text" rows="4" placeholder="e.g. logged a set and the rest timer never started"></textarea>
         <button class="btn btn-primary btn-block btn-lg mt-3" data-send="1">Save note</button>`,
        (ev) => {
          if (!ev.target.closest('[data-send]')) return;
          const text = sheetPanel.querySelector('#bug-text')?.value ?? '';
          if (!text.trim()) return toast('Type something first');
          closeSheet();
          reportBug(text);
        },
      );

    case 'import-log':
      return openSheet(
        `<h2 class="mt-0">Paste in a workout</h2>
         <div class="tiny muted mb-2.5">
           First line is the date and the day. Then one line per lift: the lift, then weight×reps for each set.
         </div>
         <textarea class="input min-h-47.5 p-2.5 text-xs resize-none" id="import-text" rows="9" spellcheck="false" autocapitalize="off"
           style="font-family:ui-monospace,monospace"
           placeholder="2026-08-12 upper-1&#10;lat-pulldown 200x11 200x8 160x7"></textarea>
         <button class="btn btn-primary btn-block btn-lg mt-3" data-import="1">Import</button>`,
        async (ev) => {
          if (!ev.target.closest('[data-import]')) return;
          const text = sheetPanel.querySelector('#import-text')?.value ?? '';
          const { session, errors } = parseQuickLog(text, {
            exercises: state.boot.exercises,
            days: state.boot.days,
          });

          if (!session) return toast(errors[0] ?? 'Could not read that', 5000);

          const record = { ...session, _dirty: true };
          const at = state.sessions.findIndex((s) => s.id === record.id);
          if (at === -1) state.sessions.push(record);
          else state.sessions[at] = record;
          await db.putSession(record);

          render();
          showImportSummary(record, errors);
          sync({ quiet: true });
        },
      );

    case 'reset-program': {
      if (!confirm('Replace your day templates with the built-in program? Logged workouts are kept.')) return;
      await updateBoot(buildLocalBootstrap());
      render();
      return toast('Program reset');
    }

    case 'test-server': {
      const configured = state.settings.serverUrl?.trim();
      if (!configured) return toast('Type the server address in first', 4000);

      t.disabled = true;
      t.textContent = 'Testing…';
      try {
        const res = await fetch(api('/api/health'), { cache: 'no-store' });
        state.online = res.ok;
        render();
        return toast(res.ok ? 'Connected' : `Reached it, but it answered ${res.status}`, 4000);
      } catch {
        state.online = false;
        render();
        // The browser hides the reason, so name the three that actually happen.
        return toast('No answer. Check the server is running, the address is right, and the certificate is trusted.', 6000);
      }
    }

    case 'sync': return sync();
    case 'reload-boot': {
      try { await fetchBoot(); toast('Program refreshed'); render(); }
      catch { toast('Server unreachable'); }
      return;
    }
    case 'toggle-plate': {
      /**
       * Writes to the list for **this** unit.
       *
       * One shared list meant tapping a 20 kg plate wrote 20 into the pound
       * list, which `roundToLoadable` then read on the pound grid — leaving a
       * mixed-unit list in IndexedDB that survived switching back to pounds.
       */
      const key = unit() === 'kg' ? 'availablePlatesKg' : 'availablePlates';
      const p = Number(t.dataset.p);

      const set = new Set(platesNow());
      set.has(p) ? set.delete(p) : set.add(p);
      if (!set.size) return toast('Keep at least one plate');

      state.settings[key] = [...set].sort((x, y) => y - x);
      await saveSettings();
      return render();
    }
    case 'export': {
      const blob = new Blob([JSON.stringify({ sessions: state.sessions }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `trainer-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      return;
    }
  }
});

/**
 * Choose the unit weights are read and typed in.
 *
 * Nothing logged changes. This is the one thing worth saying out loud on the
 * screen, because a unit switch that silently rewrote a thousand rows is exactly
 * what somebody would fear from it — and would be the dumbbell bug at scale.
 */
async function setWeightUnit(next) {
  state.settings.weightUnit = next;
  await saveYou();
  return render(true);
}

/**
 * Choose how much the logging screen asks for.
 *
 * Written to the local setting *first*, because the logging screen reads it and
 * has to work with no signal — the founding constraint. The profile write is
 * best effort for the same reason the video toggle's is: failing to tell the
 * server is not a reason to refuse somebody their own preference on their own
 * phone.
 */
async function setLevel(level) {
  state.settings.level = level;
  await saveSettings();

  if (state.account) {
    state.account = { ...state.account, profile: { ...(state.account.profile ?? {}), level } };
    await db.setMeta('account', state.account);

    try {
      await fetch(api('/api/profile'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader() },
        body: JSON.stringify({ level }),
      });
    } catch { /* rides up next time the profile is saved */ }
  }
  return render(true);
}

/**
 * Field edits update the draft without re-rendering, which would tear the
 * keyboard away mid-word. Only the first change repaints, to reveal the save bar.
 */
function applyFieldEdit(target) {
  const act = target.dataset.act;
  const d = state.draft;
  if (!d) return false;

  const i = Number(target.dataset.i);
  switch (act) {
    case 'day-name': d.name = target.value; break;
    case 'day-program': d.programId = target.value; break;
    case 'ex-scheme': d.exercises[i].schemeId = target.value; break;
    case 'ex-rest': d.exercises[i].restSeconds = Math.max(0, Number(target.value) || 0); break;
    default: return false;
  }
  markDirty();
  return true;
}

view.addEventListener('input', (e) => applyFieldEdit(e.target));

// Whatever was skipped while he was typing happens the moment he is done.
view.addEventListener('focusout', () => {
  if (!renderPending) return;
  // Let focus settle first: tabbing between fields is not "done".
  setTimeout(() => { if (renderPending && !isEditing()) render(); }, 0);
});

view.addEventListener('input', (e) => {
  if (e.target.dataset.dayField) return noteDayDraft(e.target);
  if (e.target.id !== 'lib-q') return;

  state.libraryQuery = e.target.value;
  const query = state.libraryQuery.trim().toLowerCase();
  let shown = 0;
  for (const row of view.querySelectorAll('.lib-row')) {
    const hit = !query || row.dataset.search.includes(query);
    row.style.display = hit ? '' : 'none';
    if (hit) shown++;
  }
  const none = view.querySelector('#lib-none');
  if (none) none.hidden = shown > 0;
});

view.addEventListener('input', (e) => {
  // Every keystroke, so a background render can put it back. Nothing is saved and
  // nothing re-renders here — this is only a place for the value to survive.
  if (e.target.id === 'welcome-code') state.codeDraft = e.target.value;
});

view.addEventListener('change', async (e) => {
  if (applyFieldEdit(e.target)) return;

  if (e.target.dataset.act === 'pick-day') {
    const date = e.target.value;
    e.target.value = '';

    if (!isLoggableDate(date, todayISO())) {
      if (date) toast('Pick a day in the last year, up to today');
      return;
    }
    return openDaySheet(date);
  }

  if (e.target.dataset.act === 'consent') {
    return setConsent(e.target.dataset.coach, e.target.dataset.key, Boolean(e.target.checked));
  }

  if (e.target.dataset.act === 'video-toggle') {
    const on = Boolean(e.target.checked);

    // Stored locally first, because the panel reads it and has to work offline.
    state.settings.showExerciseVideo = on;
    await saveSettings();

    if (state.account) {
      state.account = { ...state.account, profile: { ...(state.account.profile ?? {}), showExerciseVideo: on } };
      await db.setMeta('account', state.account);

      // Best effort. Failing to tell the server is not a reason to refuse the
      // person their own setting on their own phone.
      try {
        await fetch(api('/api/profile'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeader() },
          body: JSON.stringify({ showExerciseVideo: on }),
        });
      } catch { /* rides up next time the profile is saved */ }
    }
    return render();
  }

  if (['bf-low', 'bf-high'].includes(e.target.dataset.act)) {
    const key = e.target.dataset.act === 'bf-low' ? 'bodyFatLow' : 'bodyFatHigh';
    const value = numericValue(e.target.value);
    state.settings[key] = value !== null && value > 0 && value < 60 ? Math.round(value * 10) / 10 : null;
    await saveYou();
    return render();
  }

  if (['height', 'age'].includes(e.target.dataset.act)) {
    const key = e.target.dataset.act === 'height' ? 'heightInches' : 'age';
    const value = numericValue(e.target.value);
    state.settings[key] = value !== null && value > 0 ? Math.round(value) : null;
    await saveYou();
    return render();
  }

  if (e.target.dataset.act === 'maintenance') {
    // Blank stays blank. A zero here would be read as a real number and make
    // every intake look like a 100% deficit.
    const value = numericValue(e.target.value);
    state.settings.maintenanceCalories = value !== null && value > 0 ? Math.round(value) : null;
    await saveYou();
    return render();
  }

  if (e.target.dataset.act === 'goal') {
    state.settings.goal = e.target.value;
    await saveYou();
    return render();
  }

  if (e.target.dataset.act === 'rest-default') {
    state.settings.defaultRestSeconds = Math.max(0, Number(e.target.value) || 180);
    await saveSettings();
    toast('Saved');
  }

  if (e.target.dataset.act === 'gym-radius') {
    // Clamped here as well as in `gymsNear`. The library clamps because it
    // cannot trust a caller; this clamps so that what is stored is what the
    // field will show again next time — a value silently corrected on read and
    // not on write is a setting that reads back as something you did not type.
    const asked = Number(e.target.value);
    state.settings.gymRadiusMiles = Number.isFinite(asked)
      ? Math.min(RADIUS_MILES.max, Math.max(RADIUS_MILES.min, Math.round(asked)))
      : RADIUS_MILES.default;
    await saveSettings();
    toast('Saved');
    return render();
  }

  if (e.target.dataset.act === 'server-url') {
    state.settings.serverUrl = e.target.value.trim().replace(/\/+$/, '');
    await saveSettings();
    toast('Saved — now tap Test connection');
  }

  if (e.target.dataset.act === 'auth-token') {
    state.settings.authToken = e.target.value.trim();
    await saveSettings();
    toast('Token saved');
  }
});

/**
 * Chart tooltips.
 *
 * Delegated, because every render replaces the markup underneath. Touch is the
 * primary input here, so the hit targets are far wider than the marks and the
 * tooltip clears on release.
 */
function showChartTip(wrap, target) {
  hideChartTip();
  const label = target.dataset.label;
  if (!label) return;

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.innerHTML = `<div><b>${esc(target.dataset.value ?? '')}</b></div>
    <div class="t-detail">${esc(label)}</div>
    ${target.dataset.detail ? `<div class="t-detail">${esc(target.dataset.detail)}</div>` : ''}`;

  const box = target.getBoundingClientRect();
  const host = wrap.getBoundingClientRect();
  tip.style.left = `${Math.min(Math.max(box.left - host.left + box.width / 2, 46), host.width - 46)}px`;
  tip.style.top = `${Math.max(box.top - host.top, 34)}px`;

  wrap.appendChild(tip);
  target.classList.add('on');
}

function hideChartTip() {
  for (const el of document.querySelectorAll('.chart-tip')) el.remove();
  for (const el of document.querySelectorAll('.c-bar.on')) el.classList.remove('on');
}

view.addEventListener('pointerdown', (e) => {
  const wrap = e.target.closest('[data-chart]');
  if (!wrap) return hideChartTip();
  const mark = e.target.closest('.c-hit, .c-bar');
  if (mark) showChartTip(wrap, mark);
});

view.addEventListener('pointermove', (e) => {
  if (e.pressure === 0 && e.pointerType === 'touch') return;
  const wrap = e.target.closest('[data-chart]');
  if (!wrap) return;
  const mark = e.target.closest('.c-hit, .c-bar');
  if (mark) showChartTip(wrap, mark);
});

for (const evt of ['pointerup', 'pointercancel', 'scroll']) {
  window.addEventListener(evt, hideChartTip, { passive: true });
}

window.addEventListener('online', () => { state.online = true; renderStatus(); sync({ quiet: true }); });
window.addEventListener('offline', () => { state.online = false; renderStatus(); });

/* ------------------------------ rest ticker ------------------------------ */

let ticker;
function startTicking() {
  stopTicking();
  ticker = setInterval(() => {
    const a = state.active;
    const node = document.getElementById('rest-t');
    if (!a?.restEndsAt || !node) return;
    const remaining = (a.restEndsAt - Date.now()) / 1000;
    node.textContent = mmss(Math.max(0, remaining));
    const wrap = document.getElementById('rest-timer');
    if (wrap && remaining <= 0) wrap.style.borderColor = 'var(--good)';
  }, 500);
}
function stopTicking() {
  clearInterval(ticker);
  ticker = null;
}

/* ================================= boot ================================= */

/**
 * A dead grey screen is the worst failure this app can have — you would be
 * standing in a gym with no idea why. Anything that escapes gets painted.
 */
function showFatal(message, detail = '') {
  view.innerHTML = `<h1>Something broke</h1>
    <div class="card">
      <div class="mb-2.5">The app hit an error while starting. That is a bug — the text below says where.</div>
      <div class="tiny mono text-bad break-all">${esc(message)}<br>${esc(detail)}</div>
    </div>
    <button class="btn btn-primary btn-block btn-lg" data-act="hard-reload">Reload</button>
    <button class="btn btn-block btn-ghost btn-sm mt-2.5" data-act="drop-active">
      Discard the unfinished workout and reload
    </button>
    <div class="tiny muted text-center mt-2">
      Finished workouts are never touched by this.
    </div>`;
}

window.addEventListener('error', (e) => showFatal(e.message, `${e.filename ?? ''}:${e.lineno ?? ''}`));
window.addEventListener('unhandledrejection', (e) =>
  showFatal(e.reason?.message ?? String(e.reason), 'unhandled promise'),
);

async function boot() {
  // Storage can be unavailable — a Private Browsing tab, a full disk. That
  // degrades the app to online-only, but it must never stop it from running.
  try {
    await loadLocal();
  } catch (err) {
    state.storageError = String(err?.message ?? err);
  }

  // The program has to exist before anything renders. Prefer a server on the
  // very first run so an existing PC database wins, but never depend on one:
  // with nothing reachable, build it from the seed bundled in the app.
  if (!state.boot) {
    try {
      await fetchBoot();
      state.online = true;
    } catch {
      await updateBoot(buildLocalBootstrap());
      state.online = false;
    }
  } else {
    // The phone owns its program, so a newer built-in one has no other way in.
    // Additive only: edits and invented days are left alone.
    const merged = mergeSeed(state.boot);
    if (merged !== state.boot) await updateBoot(merged);
  }

  // Before the first paint, so the sign-in wall is never drawn late — a flash of
  // the Train tab followed by a sign-in screen reads as a bug.
  await noticeInvitation();

  // Repairs to data logged before machine, handle and bodyweight were fields.
  // This runs on the phone rather than against the cloud because the phone owns
  // the program: a server-side fix would be undone by the next sync.
  const repaired = runCleanup({ boot: state.boot, sessions: state.sessions });
  if (repaired.report) {
    await updateBoot(repaired.boot);
    state.sessions = repaired.sessions;
    const touched = repaired.sessions.filter((x) => x._dirty);
    if (touched.length) await db.putSessions(touched);
    state.cleanupReport = repaired.report;
  }

  /**
   * Her program, reconciled on every launch rather than only at registration.
   *
   * It was called once, from the end of registration, which meant a *rewrite* of
   * the program could never reach a phone that had already installed it — she
   * would have kept the old split forever and the only symptom would have been
   * four days that no longer matched what the program says. Idempotent, so
   * running it at every launch costs nothing: it adds days that are missing and
   * retires ones this version replaced, and it never touches a day she has
   * trained or invented.
   */
  if (programForMember(state.account)
      && state.boot?.days?.some((d) => d.programId === MEMBER_PROGRAM.id)) {
    await installMemberProgram();
  }

  if (state.active) state.route = 'session';
  state.booting = false;
  render();

  // Everything past this point is deliberately off the startup path. The app is
  // already usable; waiting on a round trip to a server on the other side of
  // the world just to draw a screen we can already draw is what made it feel
  // slow to open.
  registerOffline().then(() => render());

  /**
   * Whether Google sign-in is on offer, asked without blocking anything.
   *
   * This used to be `await`ed before the first paint, so that the button never
   * appeared a beat late. That was a **network fetch on the boot critical path**, in
   * an app whose founding rule is that it opens and works with no signal — on a bad
   * connection the sign-in screen would simply hang until the request gave up.
   *
   * It was also the root cause of a whole family of intermittent test failures, all
   * of them in the one spec where this screen appears. Five of seven failures across
   * five full runs, in a single place, because boot was waiting on a round trip.
   *
   * The screen is complete without it: the invitation code is always there, and the
   * Google section appears above it if and when the answer arrives.
   */
  if (needsWelcome()) {
    loadGoogleConfig().then(() => {
      if (state.googleClientId) render();
    });
  }

  checkServer().then((reachable) => {
    if (!reachable) return renderStatus();

    // In parallel, not in sequence. They are independent, and awaiting the
    // account first put a whole round trip in front of the first sync — which
    // showed up immediately as a browser test about the loading state timing out.
    // Nothing on the Train tab needs to know who you are.
    fetchAccount().then(() => { render(); return loadCoaching(); });
    sync({ quiet: true });
  });
}

/**
 * Ask the cloud who this token belongs to.
 *
 * Never throws and never blocks: a failure leaves the cached answer in place,
 * because "we could not reach the server" is not evidence that the account
 * changed. The only thing that clears it is an explicit 401, which does mean the
 * token has stopped working and the person needs to know.
 */
async function fetchAccount() {
  const url = state.settings.serverUrl?.trim();
  const token = state.settings.authToken?.trim();
  if (!url || !token) return null;

  try {
    const res = await fetch(api('/api/me'), { cache: 'no-store', headers: authHeader() });

    if (res.status === 401) {
      state.accountError = 'That invitation code is not recognised any more.';
      state.account = null;
      await db.delMeta('account');
      return null;
    }
    if (!res.ok) return state.account;

    const account = await res.json();

    /**
     * Absence is not deletion — the same rule as everywhere else here.
     *
     * The server answers with whatever it has. If a profile write has not landed yet
     * (offline when she registered, or simply answered out of order), its reply
     * carries `onboardedAt: null` — and taking that literally **un-registers her**,
     * because the blocking registration screen is gated on exactly that field. She
     * would be asked the same six questions again, having already answered them.
     *
     * So a local value survives a remote blank, which is the identical rule
     * `mergeRemoteSession` states for session fields and the metrics pull learned the
     * hard way.
     */
    const mine = state.account?.profile ?? null;
    const theirs = account.profile ?? null;

    const profile = mine && theirs
      ? Object.fromEntries(
          Object.keys({ ...mine, ...theirs })
            .map((key) => [key, theirs[key] ?? mine[key] ?? null]),
        )
      : theirs ?? mine;

    state.account = { ...account, profile };
    state.accountError = '';
    await db.setMeta('account', state.account);

    /**
     * And back into the settings the estimates actually read.
     *
     * Every energy figure reads `state.settings`, not the profile, so a profile
     * arriving from the cloud is only useful once it lands there. `profileToSettings`
     * never lets a remote blank wipe a local answer, so a phone that has the numbers
     * keeps them when the server does not.
     */
    const merged = profileToSettings(profile, new Date().getUTCFullYear(), state.settings);
    if (SHARED_SETTINGS.some((k) => merged[k] !== state.settings[k])) {
      state.settings = merged;
      await db.setMeta('settings', state.settings);
    }

    return state.account;
  } catch {
    // Offline. The cached answer stands.
    return state.account;
  }
}

/* ---------------------------- signing in with Google ---------------------- */

/**
 * Google's script, loaded only when it is needed and never blocking.
 *
 * It is the one external script in the app and it is **deliberately not in the
 * service worker's precache**: an offline-first app cannot have a third-party
 * script on its startup path, and this one is needed on exactly one screen that
 * nobody reaches without a working connection anyway. If it fails to load — no
 * signal, blocked, Google having a bad day — the invitation code is still there
 * and the app says nothing about it.
 */
const GOOGLE_SCRIPT = 'https://accounts.google.com/gsi/client';

let googleLoading = null;

function loadGoogleScript() {
  if (window.google?.accounts?.id) return Promise.resolve(true);
  if (googleLoading) return googleLoading;

  googleLoading = new Promise((resolve) => {
    const tag = document.createElement('script');
    tag.src = GOOGLE_SCRIPT;
    tag.async = true;
    tag.defer = true;
    tag.onload = () => resolve(Boolean(window.google?.accounts?.id));
    tag.onerror = () => resolve(false);
    document.head.appendChild(tag);
  });

  return googleLoading;
}

/**
 * Does this server offer Google sign-in?
 *
 * Asked rather than hardcoded, so that setting the client ID on the Worker is the
 * only step — no client release, no second place to keep it in step. A client ID
 * is public by design, which is why this route needs no token.
 */
async function loadGoogleConfig() {
  const url = state.settings.serverUrl?.trim() || CLOUD_URL;

  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/auth/config`, { cache: 'no-store' });
    if (!res.ok) return null;

    const { googleClientId } = await res.json();
    state.googleClientId = googleClientId ?? null;
    return state.googleClientId;
  } catch {
    // Offline, or no server. The code path is unaffected.
    return null;
  }
}

/**
 * Draw Google's own button.
 *
 * Their rendered button rather than a styled link of our own, because it is the
 * one element users actually recognise, and because the alternative is maintaining
 * a facsimile of somebody else's brand guidelines.
 */
async function mountGoogleButton() {
  const slot = document.getElementById('google-slot');
  if (!slot || !state.googleClientId) return;

  if (!(await loadGoogleScript())) {
    // Said once, quietly, and only here. The code below it still works.
    slot.innerHTML = '<div class="tiny muted">Google sign-in could not load. The code below still works.</div>';
    return;
  }

  state.googleReady = true;

  window.google.accounts.id.initialize({
    client_id: state.googleClientId,
    callback: (response) => signInWithGoogle(response?.credential),
    auto_select: false,
    cancel_on_tap_outside: true,
  });

  slot.innerHTML = '';
  window.google.accounts.id.renderButton(slot, {
    theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: 280,
  });
}

/**
 * Hand Google's token to our own server and keep what it gives back.
 *
 * The ID token is never stored: it expires in an hour and would be useless to an
 * app that has to work for weeks with no signal. What is stored is the device token
 * the Worker mints in exchange, which is the same kind of credential the
 * invitation code produces — so everything downstream is unchanged.
 */
async function signInWithGoogle(credential) {
  if (!credential) return;

  const url = state.settings.serverUrl?.trim() || CLOUD_URL;
  state.accountError = '';
  state.signingIn = true;
  render(true);

  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/auth/google`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    const body = await res.json();

    if (!res.ok) {
      state.accountError = body?.error ?? 'That sign-in was refused.';
      state.signingIn = false;
      return render(true);
    }

    state.settings.serverUrl = url;
    state.settings.authToken = body.token;
    await db.setMeta('settings', state.settings);

    await fetchAccount();
    await signInSettled();
    state.signingIn = false;

    // Same reasoning as the code path: the sync happens behind the next screen
    // rather than in front of it.
    state.tourStep = 0;
    state.tourFrom = 'onboarding';
    state.route = 'tour';
    render(true);
    sync({ quiet: true });
  } catch {
    state.accountError = 'Could not reach the server. Check your connection and try again.';
    state.signingIn = false;
    render(true);
  }
}

/** The one place that decides whether a screen is hers, his, or nobody's yet. */
const isAdmin = () => (state.account?.role ?? 'admin') === 'admin';

/**
 * This phone's user, as `lib/roles.js` wants them.
 *
 * The same shape the Worker builds per request, from the same module, so a
 * capability cannot mean one thing on the screen and another on the server.
 *
 * The signed-out default is the super admin, matching `isAdmin()` above: with
 * no account this is a phone running on its own with nobody else's data on it,
 * and the alternative — showing its owner a screen full of controls they are
 * told they may not use — is worse than letting them use their own app.
 */
const actor = () => actorFrom(state.account
  ? { id: state.account.id, role: state.account.role, gymAdminOf: state.account.gymAdminOf }
  : { id: 'u-admin', role: 'admin', gymAdminOf: [] });

/** May this phone's user do `capability` to `subject`? */
const may = (capability, subject = null) => can(actor(), capability, subject);

/**
 * A phone that arrived here from an invitation and has not signed in yet.
 *
 * The first attempt at this asked "is this a new install?" and there is no such
 * signal: a brand-new phone builds its program from the seed on first launch, so
 * it looks identical to one that has been used for months but logged nothing
 * this week. Every rule along those lines either never fires or fires on **his**
 * install, and putting a sign-in wall in front of somebody with three hundred
 * logged sets would be the worst regression available.
 *
 * So the invitation says so: the link in the email carries `?invite`, and a
 * device that opens it without a token is waiting to sign in. The flag is stored,
 * because she will install the app to her home screen and the query string does
 * not survive that — losing it would drop her back into an app with no account
 * and no explanation.
 *
 * Nobody else is affected at all. No query string, no wall.
 */
function needsWelcome() {
  // The flag is checked FIRST, and deliberately. Sign-in has to write the token
  // before it can verify it — that is what `api()` and `authHeader()` read — and
  // an earlier version dropped the wall the moment the token was stored. A code
  // the server then rejected landed her in the app anyway, signed in to nothing
  // and silently backing up nowhere. Only `signInSettled()` lowers this.
  if (state.settings.awaitingSignIn === true) return true;
  return false;
}

/**
 * Notice an invitation link.
 *
 * Runs before the first render so the wall is never drawn late — a flash of the
 * Train tab followed by a sign-in screen reads as a bug.
 */
async function noticeInvitation() {
  const invited = new URLSearchParams(location.search).has('invite');
  if (!invited || state.settings.authToken?.trim()) return;
  if (state.settings.awaitingSignIn === true) return;

  state.settings.awaitingSignIn = true;
  await db.setMeta('settings', state.settings);
}

/** Signed in, or deliberately declined. Either way the wall is done with. */
async function signInSettled() {
  if (state.settings.awaitingSignIn === undefined) return;
  state.settings.awaitingSignIn = false;
  await db.setMeta('settings', state.settings);
}

/**
 * She has signed in but has not told us anything about herself yet.
 *
 * Blocking, and the only blocking screen in the app. Everything downstream —
 * every calorie figure, the resting burn, whether a falling lift is a problem or
 * the price of a deficit she chose — is wrong or silent without it, and a
 * dismissible prompt for six numbers is one that never gets filled in.
 *
 * It does not apply to the admin: he has been using this for months and his
 * numbers are already in Setup.
 */
function needsRegistration() {
  if (!state.account || isAdmin()) return false;
  return !state.account.profile?.onboardedAt;
}

/** Is the backup server there? Never throws, never blocks anything. */
async function checkServer() {
  try {
    const res = await fetch(api('/api/health'), { cache: 'no-store' });
    state.online = res.ok;
  } catch {
    state.online = false;
  }
  return state.online;
}

/**
 * Offline caching is the whole point of this app, so a failure here must be
 * loud. iOS only installs a service worker in a secure context — HTTPS, or
 * localhost. Over plain http:// on a LAN or Tailscale IP it silently refuses,
 * and the app would then need a live connection just to open.
 */
async function registerOffline() {
  if (!window.isSecureContext) {
    state.offlineReady = false;
    state.offlineReason =
      'Served over plain HTTP. iOS only allows offline caching on HTTPS, so this app needs to reach the PC every time it opens. Put it behind HTTPS to fix.';
    return;
  }
  if (!('serviceWorker' in navigator)) {
    state.offlineReady = false;
    state.offlineReason = 'This browser has no service worker support. Open in Safari and Add to Home Screen.';
    return;
  }
  try {
    // A new worker takes control the moment it activates. Reload once so the
    // page is running the code that was just installed, not the old copy —
    // otherwise every fix needs the user to manually reload twice.
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });

    await navigator.serviceWorker.register(asset('/sw.js'), { scope: BASE });
    state.offlineReady = true;
    state.offlineReason = '';
  } catch (err) {
    state.offlineReady = false;
    state.offlineReason = `Offline caching failed to install: ${err?.message ?? err}`;
  }
}

boot().catch((err) => showFatal(err?.message ?? String(err), 'boot'));
