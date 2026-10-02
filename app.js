/**
 * Trainer — offline-first lifting log.
 *
 * The phone computes everything itself from its own copy of the data, using
 * the same modules the server uses. The network is only ever a backup channel.
 */

import {
  BAR_TYPES, DEFAULT_PLATES, getBarType,
  platesForTotal, totalFromPlates, roundToLoadable,
} from './lib/plates.js';
import { buildPrescription, describeScheme, getScheme } from './lib/scheme.js';
import { buildDayPlan } from './lib/plan.js';
import {
  buildLocalBootstrap, mergeSeed, upsertDayIn, removeDayFrom, upsertExerciseIn, upsertProgramIn, removeProgramFrom } from './lib/bootstrap.js';
import { smallestStep, suggestNextTopWeight } from './lib/progression.js';
import { analyzeAll } from './lib/analysis.js';
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
  machineChanged, renameMachineAt, relabelMachine,
} from './lib/gyms.js';
import { groupSuspects, machineSuspects } from './lib/audit.js';
import {
  proposeChanges, applyProposal, dueForReview, REVIEW_DAYS,
  recordDecision, feedbackSummary, DECLINE_REASONS, FEEDBACK_SCALES,
} from './lib/adapt.js';
import { MEMBER_PROGRAM } from './lib/templates.js';
import {
  TEMPO_PRESETS, parseTempo, formatTempo, describeTempo, usualTempo, tempoDrift,
} from './lib/tempo.js';
import { egoCheck, loadAdvice } from './lib/diagnose.js';
import { profilesFrom, groupTrends } from './lib/profiles.js';
import { AIDS, normaliseAids, describeAids, usualAids, aidsChanged } from './lib/aids.js';
import {
  makeMetric, mergeMetrics, dirtyMetrics,
  DAY_FIELDS, metricsForDay, setDayMetrics, recentDays, calendarDays, isLoggableDate,
} from './lib/metrics.js';
import { estimateTDEE, measuredDeficit, deficitVerdict, dailyEnergy, restingRange } from './lib/energy.js';
import { mergeRemoteSession, migrateActiveSession, removeSetAt, addSetTo } from './lib/session.js';
import {
  fullName, qualifier, normaliseMuscleGroup, MUSCLE_GROUPS,
  familiesOf, allowsZeroLoad, describeLoad,
} from './lib/exercises.js';
import { runCleanup } from './lib/cleanup.js';
import { overallProgress, analyzeFamily, volumeOverTime } from './lib/progress.js';
import {
  QUESTIONS, SCALE, isAnswered, describeCheckin, checkinEffect,
  FEEL_SCALE, feelOf, liftFeel,
} from './lib/checkin.js';
import { lineChart, barChart, trendBadge } from './lib/chart.js';
import {
  groupsOf, groupAt, positionIn, nextAfterSet, makeSuperset, breakSuperset,
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
    defaultRestSeconds: 180,
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
const avg = (values) => {
  const nums = (values ?? []).map(numericValue).filter((v) => v !== null);
  return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null;
};

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
const BUILD = 'v50';

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

const fmtWeight = (w) => (w == null ? '—' : `${Number.isInteger(w) ? w : w.toFixed(1)}`);

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
  const [boot, sessions, notes, active, settings, lastSync, programHash, metrics, summary, metricDeletions, account, adapt] = await Promise.all([
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

/* ============================ domain helpers ============================ */

function historyFor(exerciseId) {
  return state.sessions
    .filter((s) => (s.sets ?? []).some((x) => x.exerciseId === exerciseId && Number(x.reps) > 0))
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
    .map((s) => ({
      sessionId: s.id,
      date: s.startedAt,
      sets: s.sets.filter((x) => x.exerciseId === exerciseId).sort((a, b) => a.setIndex - b.setIndex),
    }));
}

function lastSessionFor(exerciseId) {
  const h = historyFor(exerciseId);
  return h.length ? h[h.length - 1] : null;
}

function lastPerformed(dayId) {
  const done = state.sessions
    .filter((s) => s.dayId === dayId)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return done.length ? done[0].startedAt : null;
}

/** The exact plan the server would build — same module, computed offline. */
function planFor(dayId) {
  const day = state.boot?.days?.find((d) => d.id === dayId);
  return buildDayPlan(day, {
    lastSessionFor,
    historyFor,
    availablePlates: state.settings.availablePlates,
    defaultRestSeconds: state.settings.defaultRestSeconds,
  });
}

function loggedExerciseList() {
  const ids = new Set();
  for (const s of state.sessions) for (const set of s.sets ?? []) ids.add(set.exerciseId);
  return [...ids].map((id) => ({
    exerciseId: id,
    name: state.boot?.exercises?.find((e) => e.id === id)?.name ?? id,
    history: historyFor(id),
  }));
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

const gymsList = () => state.boot?.gyms ?? [];
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

  const paint = () => {
    const gyms = gymsList();

    const rows = gyms
      .map((g) => `<button class="picker-item ${chosen === g.id ? 'on' : ''}" data-gym="${esc(g.id)}">
          <div class="grow" style="min-width:0">
            <b>${esc(g.name)}</b>
            ${g.id === hint?.id ? '<div class="tiny ok">you look like you are here</div>' : ''}
          </div>
          <span class="tiny muted">${chosen === g.id ? '✓' : ''}</span>
        </button>`)
      .join('');

    openSheet(
      `<h2 style="margin-top:0">Which gym?</h2>
       <div class="tiny muted" style="margin-bottom:10px">
         ${gyms.length
           ? 'Different gyms have different machines, so weights only compare within one.'
           : 'Name the gym you are in. You only do this once per gym.'}
       </div>
       ${rows}
       <input class="searchbar" id="gym-new" placeholder="+ New gym — type its name" autocomplete="off">
       <button class="btn btn-primary btn-block btn-lg" style="margin-top:10px" data-gym-go="1">Start</button>
       <button class="btn btn-block btn-ghost btn-sm" style="margin-top:6px" data-gym-skip="1">
         Not at a gym / skip
       </button>`,
      async (e) => {
        const pick = e.target.closest('[data-gym]');
        if (pick) {
          chosen = pick.dataset.gym;
          return paint();
        }

        if (e.target.closest('[data-gym-skip]')) {
          closeSheet();
          return startSession(dayId, null);
        }

        if (e.target.closest('[data-gym-go]')) {
          const typed = document.getElementById('gym-new')?.value.trim();
          let gym = chosen ? gymById(chosen) : null;

          if (typed) {
            const already = gymsList().find((g) => g.name.toLowerCase() === typed.toLowerCase());
            gym = already ?? (await saveGym(makeGym(typed, `gym-${uid().slice(0, 6)}`)));
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
    `<h2 style="margin-top:0">How did that set feel?</h2>
     <div class="tiny muted" style="margin-bottom:12px">
       ${esc(ex.name)} · set ${index + 1} of ${a.ex[ex.dayExerciseId].slots.length}.
       Optional — this is only worth recording when a set is notably better or worse than usual.
     </div>
     <div class="feel-row">${choices}</div>
     ${current ? '<button class="btn btn-block btn-ghost btn-sm" style="margin-top:12px" data-feel-clear="1">Clear it</button>' : ''}`,
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

  return `<button class="btn btn-sm btn-block ${parsed ? '' : 'btn-primary'}"
      style="margin-bottom:10px" data-act="tempo">
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
        <div class="grow" style="min-width:0">
          <b>${esc(p.label)}</b>
          <div class="tiny muted">${esc(describeTempo(p))}${usual === key ? ' · your usual here' : ''}</div>
        </div>
        <span class="tiny mono muted">${esc(key)}</span>
      </button>`;
  }).join('');

  openSheet(
    `<h2 style="margin-top:0">What tempo?</h2>
     <div class="tiny muted" style="margin-bottom:10px">
       ${esc(ex.name)}. Seconds down, hold, up. This is what makes two sets at the same
       weight comparable — and a shortening negative is the earliest sign a load is too heavy.
     </div>
     ${rows}
     <input class="searchbar" id="tempo-custom" placeholder="Custom — e.g. 5-2-1" autocomplete="off"
       inputmode="numeric" value="">
     <button class="btn btn-primary btn-block btn-lg" style="margin-top:10px" data-tempo-go="1">Use it</button>
     <button class="btn btn-block btn-ghost btn-sm" style="margin-top:6px" data-tempo-skip="1">
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

  return `<button class="btn btn-sm btn-block" style="margin-bottom:10px" data-act="aids">
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

  const paint = () => {
    const known = AIDS.map((x) => x.id);
    const extra = [...chosen].filter((id) => !known.includes(id));

    const rows = [...AIDS, ...extra.map((id) => ({ id, label: id }))]
      .map(
        (x) => `<button class="picker-item ${chosen.has(x.id) ? 'on' : ''}" data-aid="${esc(x.id)}">
          <div class="grow" style="min-width:0"><b>${esc(x.label)}</b></div>
          <span class="tiny muted">${chosen.has(x.id) ? '✓' : ''}</span>
        </button>`,
      )
      .join('');

    openSheet(
      `<h2 style="margin-top:0">What have you got on?</h2>
       <div class="tiny muted" style="margin-bottom:10px">
         ${esc(ex.name)}. Optional, and most sets need nothing. It matters because straps
         take grip out as the limiter — a strapped row and a bare-handed one are not the
         same set at the same weight.
       </div>
       ${rows}
       <input class="searchbar" id="aid-custom" placeholder="+ Something else — type it" autocomplete="off">
       <button class="btn btn-primary btn-block btn-lg" style="margin-top:10px" data-aids-go="1">
         ${chosen.size ? `Use ${chosen.size} item${chosen.size === 1 ? '' : 's'}` : 'Record none'}
       </button>
       <div class="tiny muted" style="margin-top:10px">
         Cable attachments — rope, wide bar — belong on the lift itself, in the exercise
         library. Those change which lift it is; these change one set of it.
       </div>`,
      async (e) => {
        const pick = e.target.closest('[data-aid]');
        if (pick) {
          const id = pick.dataset.aid;
          if (chosen.has(id)) chosen.delete(id);
          else chosen.add(id);
          return paint();
        }

        if (e.target.closest('[data-aids-go]')) {
          const typed = document.getElementById('aid-custom')?.value.trim();
          if (typed) chosen.add(typed.toLowerCase());
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
  const known = gym ? allMachinesAt(gym) : [];
  const current = a?.machines?.[ex.dayExerciseId] ?? null;

  const rows = known
    .map((name) => `<button class="picker-item ${current === name ? 'on' : ''}" data-machine="${esc(name)}">
        <div class="grow" style="min-width:0"><b>${esc(name)}</b></div>
        <span class="tiny muted">${current === name ? '✓' : ''}</span>
      </button>`)
    .join('');

  openSheet(
    `<h2 style="margin-top:0">Which machine?</h2>
     <div class="tiny muted" style="margin-bottom:10px">
       ${esc(ex.name)}${gym ? ` at ${esc(gym.name)}` : ''}.
       The cable profile and the stack differ between machines, so this is what
       makes the weights comparable.
     </div>
     ${rows}
     <input class="searchbar" id="machine-new" placeholder="+ New machine — type its name"
       autocomplete="off" value="">
     <button class="btn btn-primary btn-block btn-lg" style="margin-top:10px" data-machine-go="1">Use it</button>
     <button class="btn btn-block btn-ghost btn-sm" style="margin-top:6px" data-machine-skip="1">
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
  const plan = planFor(dayId);
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
function freshExerciseState(planned) {
  return {
    slots: planned.working.map((w) => ({ pct: w.pct, repMin: w.repMin, repMax: w.repMax, note: w.note })),
    weights: planned.working.map((w) => w.weight),
    logged: planned.working.map(() => null),
    repDraft: null,
  };
}

function currentExercise() {
  const a = state.active;
  return a?.plan?.exercises?.[a.exIndex] ?? null;
}

function currentSetIndex(exState) {
  const i = exState.logged.findIndex((v) => v == null);
  return i === -1 ? exState.logged.length : i;
}

function defaultReps(ex, exState, idx) {
  const previous = ex.lastSets?.find((s) => s.setIndex === idx + 1);
  if (previous?.reps) return previous.reps;
  return exState.slots[idx]?.repMin ?? 8;
}

/**
 * Build a plan entry for a lift that was never in today's template, using its
 * own history so it still arrives pre-filled and progressing.
 */
function plannedExerciseFor(exerciseId, schemeId = 'rp-2') {
  const lift = state.boot.exercises.find((e) => e.id === exerciseId);
  const scheme = getScheme(schemeId);
  const equipment = {
    barType: lift?.barType ?? 'olympic',
    barWeight: lift?.barWeight ?? 45,
    loading: lift?.loading ?? 'per-side',
    available: state.settings.availablePlates,
  };

  const lastSession = lastSessionFor(exerciseId);
  const suggestion = suggestNextTopWeight({ scheme, history: historyFor(exerciseId), lastSession, equipment });
  const prescription = buildPrescription({ scheme, topWeight: suggestion.weight, equipment });

  return {
    ...prescription,
    dayExerciseId: `adhoc-${exerciseId}-${uid().slice(0, 4)}`,
    exerciseId,
    name: lift?.name ?? exerciseId,
    schemeId,
    scheme,
    restSeconds: state.settings.defaultRestSeconds,
    equipment,
    suggestion,
    lastDate: lastSession?.date ?? null,
    lastSets: lastSession?.sets ?? [],
    lastTopWeight: lastSession ? (lastSession.sets?.[0]?.weight ?? null) : null,
  };
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

async function logCurrentSet() {
  const a = state.active;
  const ex = currentExercise();
  const st = a.ex[ex.dayExerciseId];
  const idx = currentSetIndex(st);
  if (idx >= st.logged.length) return;

  const weight = st.weights[idx];
  const lift = state.boot.exercises.find((e) => e.id === ex.exerciseId);
  if (weight == null || (weight <= 0 && !allowsZeroLoad(lift))) return toast('Set a weight first');

  const reps = st.repDraft ?? defaultReps(ex, st, idx);
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
    const scaleRow = (scale) => `<div style="margin-bottom:12px">
        <div class="tiny muted" style="margin-bottom:6px">${esc(scale.label)}</div>
        <div class="row" style="gap:6px">
          ${[1, 2, 3, 4, 5].map((n) => `<button class="btn btn-sm grow ${draft.ratings[scale.id] === n ? 'btn-primary' : ''}"
              data-scale="${esc(scale.id)}" data-value="${n}">${n}</button>`).join('')}
        </div>
        <div class="row-between tiny muted" style="margin-top:4px">
          <span>${esc(scale.low)}</span><span>${esc(scale.high)}</span>
        </div>
      </div>`;

    openSheet(
      `<h2 style="margin-top:0">${esc(kindLabel[proposal.kind] ?? 'A change')}</h2>
       <div class="card" style="margin-bottom:14px">
         <b style="font-size:14.5px">${esc(proposal.name)}</b>
         <div class="tiny muted" style="margin-top:6px">${esc(proposal.reason)}</div>
       </div>

       ${FEEDBACK_SCALES.map(scaleRow).join('')}

       ${draft.declining
         ? `<div class="tiny muted" style="margin-bottom:6px">Why are you leaving it?</div>
            ${DECLINE_REASONS.map((r) => `<button class="btn btn-block ${draft.reason === r.id ? 'btn-primary' : ''}"
                style="margin-bottom:6px;text-align:left" data-reason="${esc(r.id)}">
                <b>${esc(r.label)}</b><div class="tiny muted">${esc(r.detail)}</div>
              </button>`).join('')}`
         : ''}

       <label class="tiny muted">Anything else? (optional)</label>
       <input class="input" id="sg-note" value="${esc(draft.note ?? '')}"
         placeholder="in your own words" style="margin:6px 0 14px" autocomplete="off">

       ${draft.declining
         ? `<button class="btn btn-block btn-lg ${draft.reason ? 'btn-primary' : ''}" data-sg-decline-go="1"
              ${draft.reason ? '' : 'disabled'}>Keep it as it is</button>
            <button class="btn btn-block btn-ghost btn-sm" style="margin-top:8px" data-sg-back="1">Back</button>`
         : `<button class="btn btn-primary btn-block btn-lg" data-sg-accept="1">Make this change</button>
            <button class="btn btn-block" style="margin-top:8px" data-sg-decline="1">Keep it as it is</button>`}`,

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
function render(force = false) {
  if (!force && (isEditing() || interacting)) {
    renderPending = true;
    renderStatus();
    return;
  }
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
           <div style="margin-bottom:10px">The app reached this page but could not load your program,
           and there is nothing cached on this phone yet.</div>
           <div class="tiny muted mono" style="word-break:break-all">
             tried ${esc(location.origin)}/api/bootstrap<br>
             ${esc(state.bootError)}
           </div>
         </div>
         ${state.storageError
           ? `<div class="card"><div class="tiny" style="color:var(--bad)">
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
    ? `<button class="card card-tap" data-act="resume" style="border-color:var(--accent)">
         <div class="row-between">
           <div>
             <div class="pill pill-accent">In progress</div>
             <h2 style="margin:8px 0 2px">${esc(a.dayName)}</h2>
             <div class="tiny muted">${a.sets.length} sets logged · started ${fmtDate(a.startedAt)}</div>
           </div>
           <div style="font-size:26px">›</div>
         </div>
       </button>`
    : '';

  const groups = programs
    .map((p) => {
      const days = (state.boot.days ?? []).filter((d) => d.programId === p.id);
      if (!days.length) return '';
      const cards = days
        .map((d) => {
          const last = lastPerformed(d.id);
          const names = d.exercises.map((e) => e.name).join(' · ');
          return `<button class="card card-tap" data-act="start" data-id="${esc(d.id)}">
            <div class="row-between">
              <div class="grow">
                <div class="row" style="gap:8px">
                  <b style="font-size:17px">${esc(d.name)}</b>
                  <span class="pill">${d.exercises.length} lifts</span>
                  ${last ? `<span class="pill">${esc(daysAgo(last))}</span>` : '<span class="pill pill-accent">new</span>'}
                </div>
                <div class="tiny muted" style="margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(names)}</div>
              </div>
              <div style="font-size:26px;color:var(--muted)">›</div>
            </div>
          </button>`;
        })
        .join('');
      return `<h2>${esc(p.name)} <span class="muted tiny">· ${p.daysPerWeek} day</span></h2>${cards}`;
    })
    .join('');

  return `<h1>Train</h1>
    <p class="sub">Pick any day — order is up to you.</p>
    ${resume}
    ${groups}`;
}

/* ------------------------------- session -------------------------------- */

/**
 * The whole workout, at a glance.
 *
 * A session is a list of work, not a queue of one exercise with a Next button.
 * Landing here means you can see what is left, jump to whatever machine is
 * free, and pair two lifts on the spot.
 */
/** The machine this lift is on today, and a way to change it. */
function machineChip(ex) {
  const a = state.active;
  const lift = state.boot.exercises.find((x) => x.id === ex.exerciseId);
  if (!a.gymId || !tracksMachine(lift ?? { name: ex.name })) return '';

  const machine = a.machines?.[ex.dayExerciseId];
  return `<button class="btn btn-sm btn-block ${machine ? '' : 'btn-primary'}"
      style="margin-bottom:10px" data-act="machine">
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
          ? `<span class="ov-set done">${fmtWeight(s.weight)}×${s.reps}</span>`
          : `<span class="ov-set">${n + 1}</span>`))
        .join('');

      return `<button class="ov-row ${finished ? 'done' : ''} ${i === a.exIndex ? 'current' : ''} ${group ? 'grouped' : ''}"
          data-act="ov-open" data-i="${i}">
          ${group ? `<span class="ov-badge">${positionIn(group, i)}</span>` : ''}
          <div class="grow" style="min-width:0">
            <div class="row" style="gap:6px">
              <b style="font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.name)}</b>
              <span class="tiny muted">${logged}/${total}</span>
            </div>
            ${extra ? `<div class="tiny muted">${esc(extra)}</div>` : ''}
            <div class="ov-sets">${sets}</div>
          </div>
          <span class="tiny muted">${finished ? '✓' : '›'}</span>
        </button>`;
    })
    .join('');

  const groupNotes = groups
    .map((g) => `<button class="btn btn-sm" data-act="ov-unpair" data-ss="${esc(g.id)}">
        Unpair ${g.indices.map((i) => esc(exercises[i].name.split(' ').slice(-1)[0])).join(' + ')}
      </button>`)
    .join('');

  return `
    <div class="row-between">
      <button class="btn btn-sm btn-ghost" data-act="home">‹ Back</button>
      <span class="pill">${done} of ${planned} sets</span>
      <button class="btn btn-sm btn-ghost" data-act="finish">Finish</button>
    </div>

    <h1 style="margin-top:10px">${esc(a.dayName)}</h1>
    <p class="sub">${volume.toLocaleString()} lb so far · tap any lift to log it</p>
    ${a.gymName
      ? `<div class="ov-gym tiny muted">at <b>${esc(a.gymName)}</b></div>`
      : ''}

    ${rows}

    <div class="row wrap" style="gap:8px;margin-top:12px">
      <button class="btn btn-sm grow" data-act="ov-pair">Pair two lifts</button>
      <button class="btn btn-sm grow" data-act="session-add">+ Add a lift</button>
    </div>
    ${groupNotes ? `<div class="row wrap" style="gap:8px;margin-top:8px">${groupNotes}</div>` : ''}`;
}

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

  const warmups = pres.warmups
    .map(
      (w, i) => `<div class="warmup">
        <span class="pill">W${i + 1}</span>
        <span class="grow mono"><b>${fmtWeight(w.weight)}</b> lb × ${esc(w.reps)}</span>
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
        ? `<b class="mono">${esc(describeLoad(done, lift))} × ${done.reps}</b>`
        : `<span class="muted mono">${esc(describeLoad({ weight }, lift))} lb · ${slot.repMin}–${slot.repMax}</span>`;
      const logged = done ? a.sets.find((s) => s.exerciseId === ex.exerciseId && s.setIndex === i + 1) : null;
      const felt = logged ? feelOf(logged) : null;
      const face = felt ? FEEL_SCALE.find((f) => f.value === felt)?.face : null;

      return `<div class="setrow ${cls}">
        <div class="idx">${done ? '✓' : i + 1}</div>
        <div class="grow">
          <div class="row-between"><span class="tiny muted">${esc(slot.note || 'Working set')}</span>${right}</div>
        </div>
        ${done
          ? `<button class="setrow-feel ${felt ? 'set' : ''}" data-act="feel" data-i="${i}"
              aria-label="${felt ? `Felt ${esc(FEEL_SCALE.find((f) => f.value === felt).label)}` : 'Say how this set felt'}">${face ?? '·'}</button>`
          : ''}
        ${st.slots.length > 1
          ? `<button class="setrow-x" data-act="del-set" data-i="${i}" aria-label="Remove set ${i + 1}">×</button>`
          : ''}
      </div>`;
    })
    .join('');

  const lastLine = ex.lastSets?.length
    ? ex.lastSets.map((s) => `${fmtWeight(s.weight)}×${s.reps}`).join('  ·  ')
    : 'first time on this lift';

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

    <h1 style="margin-top:10px">${esc(ex.name)}</h1>
    <p class="sub">
      ${esc(a.dayName)}${a.gymName ? ` · ${esc(a.gymName)}` : ''} · exercise ${a.exIndex + 1} of ${total}<br>
      <span class="tiny">${esc(describeScheme(ex.scheme))}</span>
    </p>
    ${machineChip(ex)}
    ${tempoChip(ex)}
    ${aidsChip(ex)}
    ${demoChip(ex.exerciseId)}

    <div class="card">
      <div class="row-between" style="margin-bottom:8px">
        <span class="tiny muted">Last time</span>
        <span class="tiny mono">${esc(lastLine)}</span>
      </div>
      <div class="row-between">
        <span class="tiny muted">Coach</span>
        <span class="tiny" style="text-align:right;max-width:78%">${esc(ex.suggestion.reason)}</span>
      </div>
    </div>

    ${warmups ? `<h2>Warmup <span class="tiny muted">· not logged</span></h2>${warmups}` : ''}

    <h2>Working sets</h2>
    ${sets}
    <button class="btn btn-sm btn-block" style="margin-bottom:10px" data-act="add-set">+ Add a set</button>
    ${body}
    ${timer}

    <div class="row" style="margin-top:12px;gap:8px">
      <button class="btn btn-sm grow" data-act="prev-ex" ${a.exIndex === 0 ? 'disabled' : ''}>‹ Previous</button>
      <button class="btn btn-sm grow" data-act="pick-ex">Jump to…</button>
      <button class="btn btn-sm grow" data-act="next-ex" ${a.exIndex + 1 >= total ? 'disabled' : ''}>Next ›</button>
    </div>

    <div class="row" style="margin-top:8px;gap:8px">
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
  const reps = st.repDraft ?? defaultReps(ex, st, idx);
  // Stacks and dumbbells move in 5s; loaded bars move in whatever the plates allow.
  const step = ex.equipment.barType === 'stack' ? 5 : smallestStep(ex.equipment);

  return `
    <div class="card" style="border-color:var(--accent)">
      <div class="row-between" style="margin-bottom:10px">
        <b>Set ${idx + 1}</b>
        <span class="tiny muted">target ${slot.repMin}–${slot.repMax} · ${esc(slot.note || '')}</span>
      </div>

      <div class="stepper" style="margin-bottom:10px">
        <button class="step" data-act="w-down" data-step="${step}">−</button>
        <button class="value" data-act="open-weight">
          <b>${bodyweightLift(ex) && !(weight > 0) ? 'BW' : fmtWeight(weight)}</b>
          <small>${bodyweightLift(ex) && !(weight > 0)
            ? 'bodyweight · tap to add load'
            : `lb · ${esc(plateSummary(weight, ex.equipment)) || 'tap to edit'}`}</small>
        </button>
        <button class="step" data-act="w-up" data-step="${step}">+</button>
      </div>

      <div class="stepper" style="margin-bottom:12px">
        <button class="step" data-act="r-down">−</button>
        <button class="value" data-act="open-reps"><b>${reps}</b><small>reps</small></button>
        <button class="step" data-act="r-up">+</button>
      </div>

      <button class="btn btn-primary btn-block btn-lg" data-act="log-set">LOG SET</button>
      ${idx > 0 ? '<button class="btn btn-block btn-ghost btn-sm" style="margin-top:8px" data-act="undo">Undo last set</button>' : ''}
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
      <button data-act="cal-prev" aria-label="Previous month">‹</button>
      <div class="cal-title">${MONTH_NAMES[month]} ${year}</div>
      <button data-act="cal-next" aria-label="Next month">›</button>
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
            return `<button class="${classes}" data-date="${c.date}" ${c.trained ? 'data-act="cal-day"' : ''}>
              ${c.day}${c.trained ? '<span class="dot"></span>' : ''}
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

  return `<div class="row-between" style="padding:6px 0;border-top:1px solid var(--line)">
      <div class="grow" style="min-width:0">
        <span class="tiny muted">${mins} min recorded${stale ? `, last set at ${workMins} min` : ''}</span>
        ${stale
          ? `<div class="tiny" style="color:var(--warn);margin-top:2px">
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
    `<h2 style="margin-top:0">How long was it?</h2>
     <div class="tiny muted" style="margin-bottom:12px">
       ${esc(session.dayName ?? 'Workout')}, ${esc(fmtDate(session.startedAt))}.
       Recorded as ${mins} minutes${Number.isFinite(lastSet) ? `, with the last set logged at ${Math.round((lastSet - start) / 60000)}` : ''}.
     </div>
     <label class="tiny muted">Minutes</label>
     <input class="input mono" id="len-mins" inputmode="numeric" value="${suggested}" style="margin:8px 0 12px">
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
            <div class="grow" style="min-width:0">
              <b style="font-size:14.5px">${esc(lift.name)}</b>
              <div class="tiny muted mono" style="margin-top:3px">
                ${lift.sets.map((s) => `${fmtWeight(s.weight)}×${s.reps}`).join('   ')}
              </div>
            </div>
            <span class="tiny muted">›</span>
          </button>`,
        )
        .join('');

      return `<div class="day-detail">
        <div class="row-between" style="margin-bottom:6px">
          <b style="font-size:17px">${esc(session.dayName ?? 'Workout')}</b>
          ${session._dirty ? '<span class="pill">on this phone only</span>' : ''}
        </div>
        <div class="tiny muted" style="margin-bottom:6px">
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
    detail: s.sets.map((x) => `${describeLoad(x, lift)}×${x.reps}`).join('  '),
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
        <div class="row-between" style="margin-bottom:6px">
          <b>${fmtDate(s.date)}</b>
          <span class="pill">e1RM ${Math.round(bestE1RM(s.sets))}</span>
        </div>
        <div class="tiny mono">${s.sets.map((x) => `${esc(describeLoad(x, lift))}×${x.reps}`).join('   ·   ')}</div>
      </div>`,
    )
    .join('');

  const meta = [
    lift.machine ? `machine ${lift.machine}` : '',
    lift.handle ? `handle ${lift.handle}` : '',
    lift.muscleGroup ?? '',
  ].filter(Boolean).join(' · ');

  return `<button class="btn btn-sm btn-ghost" data-act="history">‹ History</button>
    <h1 style="margin-top:8px">${esc(lift.name)}</h1>
    <p class="sub">
      ${history.length} session${history.length === 1 ? '' : 's'} · best e1RM ${Math.round(Math.max(0, ...series))} lb
      ${meta ? `<br><span class="tiny">${esc(meta)}</span>` : ''}
      ${lift.notes ? `<br><span class="tiny">${esc(lift.notes)}</span>` : ''}
    </p>

    ${demoPanel(lift)}

    <div class="card">
      <div class="row-between" style="margin-bottom:6px">
        <b class="tiny">Estimated 1RM</b>
        ${trendBadge(seriesTrend(strength.map((p) => p.value)))}
      </div>
      <div class="chart-wrap" data-chart="1">${lineChart(strength, { unit: ' lb', title: `${lift.name} estimated 1RM over time` })}</div>
    </div>

    <div class="card">
      <div class="tiny" style="margin-bottom:6px"><b>Volume per session</b></div>
      <div class="chart-wrap" data-chart="1">${barChart(volume, { unit: ' lb', title: `${lift.name} volume per session` })}</div>
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
  return `<button class="btn btn-sm btn-block btn-ghost" style="margin-bottom:10px"
      data-act="demo-open" data-id="${esc(exerciseId)}">
      ▶ Show me how to do this
    </button>`;
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
    `<h2 style="margin-top:0">${esc(lift.name)}</h2>
     ${id
       ? `<div class="demo-frame" style="margin-bottom:12px">
            <iframe src="https://www.youtube-nocookie.com/embed/${esc(id)}?rel=0"
              title="${esc(lift.name)} demonstration" allowfullscreen
              referrerpolicy="strict-origin-when-cross-origin"></iframe>
          </div>
          <div class="tiny muted" style="margin-bottom:12px">
            Not the right movement, or badly taught? Pin a better one — it is yours from
            then on.
          </div>`
       : `<a class="btn btn-block btn-primary" target="_blank" rel="noopener noreferrer"
             href="https://www.youtube.com/results?search_query=${query}">
            Search YouTube for this lift
          </a>
          <div class="tiny muted" style="margin:10px 0 12px">
            No demonstration pinned to this one yet. Find one you like and pin it, and it
            plays here from then on.
          </div>`}
     <button class="btn btn-block" data-demo-pin="1">${id ? 'Pin a different video' : 'Pin a video'}</button>
     <button class="btn btn-block btn-ghost" style="margin-top:8px" data-close="1">Done</button>`,
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
    <div class="row-between" style="margin-bottom:8px">
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
         <div class="tiny muted" style="margin-top:8px">
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
    parts.push(`<div class="tiny" style="margin-top:8px;color:var(--bad)">
      <b>The load is outrunning the strength.</b> ${esc(ego.message)}
      ${ego.reasons.map((r) => `<div style="margin-top:4px">· ${esc(r)}</div>`).join('')}
    </div>`);
  }

  if (advice.action === 'lighter' || advice.action === 'change-stimulus') {
    const label = advice.action === 'lighter' ? 'Go lighter' : 'Change the stimulus';
    parts.push(`<div class="tiny" style="margin-top:8px;color:var(--warn)">
      <b>${label}${advice.suggestedWeight ? ` — try ${fmtWeight(advice.suggestedWeight)} lb` : ''}.</b>
      ${esc(advice.reason)}
    </div>`);
  }

  const kit = aidsChanged(historyFor(exerciseId), exerciseId);
  if (kit.changed) {
    const what = kit.added.length ? `added ${esc(describeAids(kit.added))}` : `stopped using ${esc(describeAids(kit.removed))}`;
    parts.push(`<div class="tiny" style="margin-top:8px;color:var(--warn)">
      You ${what} since last time. The load is not directly comparable across that —
      straps and a belt change what the set asks of you.
    </div>`);
  }

  const drift = tempoDrift(state.sessions, exerciseId);
  if (drift.drifting && !ego.flagged) {
    parts.push(`<div class="tiny" style="margin-top:8px;color:var(--warn)">
      The negative has shortened from ${drift.from}s to ${drift.to}s. The same weight moved
      faster is not the same set — worth checking that is deliberate.
    </div>`);
  }

  return parts.join('');
}

function machineNote(exerciseId) {
  const change = machineChanged(state.sessions, exerciseId);
  if (!change.changed) return '';

  return `<div class="tiny" style="margin-top:8px;color:var(--warn)">
    Different machine last time: ${esc(change.from)} → ${esc(change.to)}.
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

  const suggestions = pending.map((p) => `<button class="card" style="width:100%;text-align:left;margin-bottom:8px;border-color:var(--accent)"
      data-act="adapt-open" data-id="${esc(p.id)}">
      <div class="row-between" style="margin-bottom:6px">
        <b style="font-size:14.5px">${esc(p.name)}</b>
        <span class="pill pill-warn">${esc(kindLabel[p.kind] ?? p.kind)}</span>
      </div>
      <div class="tiny muted" style="margin-bottom:8px">${esc(p.reason)}</div>
      <div class="tiny" style="color:var(--accent)">Tap to decide ›</div>
    </button>`).join('');

  const appliedRows = recent.map((a) => `<div class="card" style="margin-bottom:8px">
      <div class="row-between" style="margin-bottom:6px">
        <b style="font-size:14.5px">${esc(doneLabel[a.kind] ?? 'Changed')}</b>
        <span class="tiny mono muted">${esc(daysAgo(a.appliedAt))}</span>
      </div>
      <div class="tiny" style="margin-bottom:8px">
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
         ${feedback.suggestionRating !== null ? `<div class="row-between" style="margin-top:6px">
             <span class="tiny muted">How you rate these suggestions</span>
             <span class="tiny mono">${feedback.suggestionRating} / 5</span>
           </div>` : ''}
         <div class="row-between" style="margin-top:6px">
           <span class="tiny muted">Taken up</span>
           <span class="tiny mono">${feedback.accepted} of ${feedback.considered}</span>
         </div>
       </div>`
    : '';

  return `<h2>Your program</h2>
    ${pending.length
      ? `<div class="tiny muted" style="margin-bottom:8px">
           ${pending.length === 1 ? 'One suggestion' : `${pending.length} suggestions`} from your last few
           sessions. Nothing changes unless you say so.
         </div>
         ${suggestions}`
      : ''}
    ${appliedRows}
    ${scales}`;
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
    return `<h1>Coach</h1>
      ${renderSummary()}
      ${renderAdaptation()}
      ${overall}${movements}${recovery}${feel}
      <div class="card">
        <div class="tiny muted">Per-lift verdicts need three sessions of the same lift. Movements above need
        only two, and count every machine you did them on — which is why they fill in first.</div>
      </div>`;
  }

  const pillFor = { progressing: 'pill-good', stagnant: 'pill-warn', regressing: 'pill-bad', 'too-fast': 'pill-warn' };
  const labelFor = { progressing: 'Progressing', stagnant: 'Stalled', regressing: 'Regressing', 'too-fast': 'Too fast' };

  const cards = findings
    .map(
      (f) => `<div class="card">
        <div class="row-between" style="margin-bottom:8px">
          <b>${esc(f.name)}</b>
          <span class="pill ${pillFor[f.status] ?? ''}">${labelFor[f.status] ?? f.status}</span>
        </div>
        <div class="row wrap tiny muted" style="gap:6px;margin-bottom:8px">
          <span class="pill mono">${f.percentPerSession > 0 ? '+' : ''}${f.percentPerSession}% / session</span>
          <span class="pill mono">e1RM ${Math.round(f.lastE1RM)}</span>
          <span class="pill mono">best ${Math.round(f.bestE1RM)}</span>
          ${f.flags.map((x) => `<span class="pill pill-warn">${esc(x)}</span>`).join('')}
        </div>
        <div style="font-size:14.5px">${esc(f.message)}</div>
        ${machineNote(f.exerciseId)}
        ${diagnosisNote(f.exerciseId)}
      </div>`,
    )
    .join('');

  return `<h1>Coach</h1>
    <p class="sub">Trend analysis over your logged working sets. Worst news first.</p>
    ${renderSummary()}
    ${renderAdaptation()}
    ${overall}${profiles}${movements}${recovery}${feel}
    <h2>Lift by lift</h2>
    ${cards}
    <div class="card">
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
function summaryFindings() {
  const items = loggedExerciseList().map((e) => ({ name: e.name, exerciseId: e.exerciseId, history: e.history }));
  const findings = analyzeAll(items);
  const overall = overallProgress({ items, sessions: state.sessions, exercises: state.boot.exercises });

  const byId = new Map((state.boot.exercises ?? []).map((e) => [e.id, e]));
  const recent = state.sessions;

  const checkins = recent.map((s) => s.checkin).filter(Boolean);
  const checkin = {};
  for (const q of QUESTIONS) {
    const value = avg(checkins.map((c) => c[q.id]));
    if (value !== null) checkin[q.id] = value;
  }

  // His own verdicts on the app's own advice. The most directly useful thing in
  // this payload: no trend line can say "he has declined four of the last five
  // suggestions and rates his split 2 out of 5".
  const feedback = feedbackSummary(state.adapt?.decisions ?? []);

  return {
    feedback,
    overall: overall
      ? { status: overall.status, rate: overall.percentPerSession, message: overall.message }
      : null,
    lifts: findings.map((f) => ({
      name: f.name,
      status: f.status,
      percentPerSession: f.percentPerSession,
      flags: f.flags,
      muscleGroup: byId.get(f.exerciseId)?.muscleGroup ?? null,
      machine: machineChanged(state.sessions, f.exerciseId).to ?? null,
      feel: liftFeel(state.sessions, f.exerciseId),
      tempo: usualTempo(state.sessions, f.exerciseId),
      tempoDrift: (() => {
        const d = tempoDrift(state.sessions, f.exerciseId);
        return d.drifting ? { from: d.from, to: d.to } : null;
      })(),
      ego: (() => {
        const e = egoCheck({ history: historyFor(f.exerciseId), exerciseId: f.exerciseId });
        return e.flagged ? { weightTrend: e.weightTrend, strengthTrend: e.strengthTrend } : null;
      })(),
    })),
    recovery: {
      sleepAvg: avg(state.metrics.filter((m) => m.name === 'sleepHours').slice(-14).map((m) => m.value)),
      stepsAvg: avg(state.metrics.filter((m) => m.name === 'steps').slice(-14).map((m) => m.value)),
    },
    // Per-machine trends, so it can tell "got stronger" from "changed stack".
    profiles: profilesFrom(state.sessions, { minSessions: 3, exercises: state.boot.exercises })
      .map((p) => ({ label: p.label, machine: p.machine, sessions: p.sessions, percentPerSession: p.percentPerSession })),
    groups: groupTrends(
      profilesFrom(state.sessions, { minSessions: 3, exercises: state.boot.exercises }),
      state.boot.exercises,
    ).map((g) => ({ muscleGroup: g.muscleGroup, percentPerSession: g.percentPerSession, profiles: g.profiles, machines: g.machines })),

    // One line per session ever logged: the shape of the training, without the
    // set-by-set bulk that would say little and cost much.
    history: [...state.sessions]
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
      .map((s) => ({
        date: String(s.startedAt ?? '').slice(0, 10),
        day: s.dayName ?? null,
        gym: s.gymName ?? null,
        sets: (s.sets ?? []).length,
        volume: Math.round(totalVolume(s.sets ?? [])),
      })),

    // The scale reframes every trend under it: holding a lift while losing
    // weight is a success the coach was calling a stall.
    nutrition: (() => {
      const intakeAvg = avg(state.metrics.filter((m) => m.name === 'dietary_energy').slice(-14).map((m) => m.value));
      const ctx = nutritionContext({
        metrics: state.metrics,
        settings: state.settings,
        intakeAvg,
        proteinAvg: avg(state.metrics.filter((m) => m.name === 'protein').slice(-14).map((m) => m.value)),
      });

      // What the scale measured beats what the formula estimated, and the
      // model needs both to say which it is trusting.
      const weight = bodyweightTrend(state.metrics);
      const known = weight.direction !== 'unknown';
      const measured = measuredDeficit({ perWeek: known ? weight.perWeek : null, intakeAvg });
      const verdict = deficitVerdict({
        perWeek: known ? weight.perWeek : null,
        weightLb: weight.smoothed,
        liftsHolding: liftsAreHolding(),
      });

      return {
        ...ctx,
        goal: state.settings.goal || null,
        deficitPerDay: measured.known ? measured.deficitPerDay : null,
        impliedTDEE: measured.known ? measured.impliedTDEE : null,
        verdict: verdict.severity === 'unknown' ? null : { severity: verdict.severity, message: verdict.message },
      };
    })(),

    checkin: Object.keys(checkin).length ? checkin : null,
    checkins: recent
      .filter((s) => s.checkin && (isAnswered(s.checkin) || String(s.checkin.note ?? '').trim()))
      .map((s) => ({
        date: String(s.startedAt ?? '').slice(0, 10),
        day: s.dayName ?? null,
        ...Object.fromEntries(QUESTIONS.map((q) => [q.id, s.checkin[q.id]]).filter(([, v]) => Number.isFinite(Number(v)))),
        note: String(s.checkin.note ?? '').trim() || undefined,
      })),
    gyms: gymsList().map((g) => g.name),
  };
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
    return `<div style="font-size:14.5px">${esc(r.headline)}</div>
      <div class="tiny muted" style="margin-top:8px">
        That came back as prose rather than the usual structure, so it is shown as written.
      </div>`;
  }

  const scoreColour = r.score === null
    ? 'var(--muted)'
    : r.score >= 65 ? 'var(--good)' : r.score >= 45 ? 'var(--warn)' : 'var(--bad)';

  const severityColour = { high: 'var(--bad)', medium: 'var(--warn)', low: 'var(--muted)' };

  const findings = r.findings
    .map(
      (f) => `<div style="padding:8px 0;border-top:1px solid var(--line)">
        <div class="row" style="gap:8px;align-items:flex-start">
          <span style="color:${severityColour[f.severity]};font-size:16px;line-height:1.2">•</span>
          <div class="grow" style="min-width:0">
            <b style="font-size:14px">${esc(f.title)}</b>
            ${f.detail ? `<div class="tiny muted" style="margin-top:2px">${esc(f.detail)}</div>` : ''}
          </div>
        </div>
      </div>`,
    )
    .join('');

  const recommendations = r.recommendations
    .map(
      (x, i) => `<div style="padding:8px 0;border-top:1px solid var(--line)">
        <div class="row" style="gap:8px;align-items:flex-start">
          <span class="tiny mono muted" style="min-width:14px">${i + 1}</span>
          <div class="grow" style="min-width:0">
            <b style="font-size:14px">${esc(x.action)}</b>
            ${x.why ? `<div class="tiny muted" style="margin-top:2px">${esc(x.why)}</div>` : ''}
          </div>
        </div>
      </div>`,
    )
    .join('');

  return `
    ${r.score !== null
      ? `<div class="row" style="gap:12px;align-items:baseline;margin-bottom:6px">
           <span class="mono" style="font-size:30px;font-weight:600;color:${scoreColour}">${r.score}</span>
           <span class="tiny muted">out of 100 · ${esc(r.status)}</span>
         </div>`
      : `<div class="tiny muted" style="margin-bottom:6px">${esc(r.status)}</div>`}

    ${r.headline ? `<div style="font-size:14.5px">${esc(r.headline)}</div>` : ''}

    ${findings ? `<div class="tiny muted" style="margin-top:12px"><b>What it found</b></div>${findings}` : ''}
    ${recommendations ? `<div class="tiny muted" style="margin-top:12px"><b>Do next</b></div>${recommendations}` : ''}

    ${r.caveats.length
      ? `<div class="tiny muted" style="margin-top:12px">
           ${r.caveats.map((c) => `<div style="margin-top:4px">· ${esc(c)}</div>`).join('')}
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
      <div class="tiny muted" style="margin-top:8px">
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
      <div class="tiny muted" style="margin-top:8px">
        Reads the verdicts below and says what they mean together — which is the one
        thing the per-lift numbers cannot do for themselves.
        ${state.online ? '' : ' Needs signal, unlike everything else here.'}
      </div>
    </div>`;
  }

  if (s.loading) {
    return `<div class="card">
      <div class="row-between">
        <div class="row" style="gap:10px">
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
      ${s.text ? `<div style="font-size:14.5px;margin-top:8px">${esc(s.text)}</div>` : ''}
      <div class="tiny" style="margin-top:8px;color:var(--warn)">${esc(s.error)}</div>
      ${s.text ? '<div class="tiny muted" style="margin-top:4px">That is the previous answer, kept.</div>' : ''}
    </div>`;
  }

  const stale = s.key !== summaryCacheKey(summaryFindings());

  return `<div class="card">
    <div class="row-between" style="margin-bottom:8px">
      <span class="tiny muted"><b>What this all means</b></span>
      <button class="btn btn-sm" data-act="summary-go">${stale ? 'Refresh' : 'Rewrite'}</button>
    </div>
    ${renderReportBody(parseReport(s.text))}
    <div class="tiny muted" style="margin-top:12px">
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
      <div class="row-between" style="margin-bottom:10px">
        <b style="font-size:17px">Overall</b>
        ${trendBadge(o.percentPerSession)}
      </div>

      <div class="row" style="margin-bottom:12px">
        <div style="text-align:center;flex:1">
          <div class="mono" style="font-size:20px;font-weight:700;color:var(--good)">${o.improving}</div>
          <div class="tiny muted">climbing</div>
        </div>
        <div style="text-align:center;flex:1">
          <div class="mono" style="font-size:20px;font-weight:700">${o.flat}</div>
          <div class="tiny muted">flat</div>
        </div>
        <div style="text-align:center;flex:1">
          <div class="mono" style="font-size:20px;font-weight:700;color:var(--bad)">${o.declining}</div>
          <div class="tiny muted">falling</div>
        </div>
        <div style="text-align:center;flex:1">
          <div class="mono" style="font-size:20px;font-weight:700">${o.movements}</div>
          <div class="tiny muted">movements</div>
        </div>
      </div>

      <div style="font-size:14.5px;margin-bottom:12px" class="${tone ? '' : 'muted'}">${esc(o.message)}</div>

      ${volume.length > 1
        ? `<div class="tiny muted" style="margin-bottom:4px">Volume per session</div>
           <div class="chart-wrap" data-chart="1">${barChart(volume, { unit: ' lb', title: 'Volume per session' })}</div>`
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
  const profiles = profilesFrom(state.sessions, { minSessions: 3, exercises: state.boot.exercises });
  if (!profiles.length) return '';

  const groups = groupTrends(profiles, state.boot.exercises);
  const machineCount = new Set(profiles.map((p) => p.machine).filter(Boolean)).size;

  const rows = groups
    .map((g) => {
      const worst = g.members[0];
      const best = g.members[g.members.length - 1];
      const spread = g.members.length > 1 && Math.abs(best.percentPerSession - worst.percentPerSession) >= 2;

      return `<div class="card">
        <div class="row-between" style="margin-bottom:6px">
          <b>${esc(g.muscleGroup)}</b>
          ${trendBadge(g.percentPerSession, { unit: '%/session' })}
        </div>
        <div class="tiny muted">
          ${g.profiles} machine profile${g.profiles === 1 ? '' : 's'}${g.machines ? ` across ${g.machines} machine${g.machines === 1 ? '' : 's'}` : ''}.
          Each is indexed to its own start before they are combined, so the loads never need to match.
        </div>
        <div style="margin-top:8px">
          ${g.members
            .map(
              (m) => `<div class="row-between" style="padding:5px 0;border-top:1px solid var(--line)">
                <span class="tiny" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.label)}</span>
                <span class="tiny mono ${m.percentPerSession >= 0 ? 'ok' : ''}"
                  style="${m.percentPerSession < 0 ? 'color:var(--bad)' : ''}">
                  ${m.percentPerSession > 0 ? '+' : ''}${m.percentPerSession}% · ${m.sessions}x
                </span>
              </div>`,
            )
            .join('')}
        </div>
        ${spread
          ? `<div class="tiny" style="margin-top:8px;color:var(--warn)">
               ${esc(best.machine ?? 'one machine')} is climbing while ${esc(worst.machine ?? 'another')} is not.
               Same muscle, different machine — worth knowing which one the progress is actually on.
             </div>`
          : ''}
      </div>`;
    })
    .join('');

  return `<h2>By machine</h2>
    <p class="sub" style="margin-top:-6px">
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
      (f) => `<div class="row-between" style="padding:9px 0;border-top:1px solid var(--line)">
        <div class="grow" style="min-width:0">
          <div style="font-size:14.5px">${esc(f.name)}</div>
          <div class="tiny muted">${f.sessionCount} session${f.sessionCount === 1 ? '' : 's'}${f.variants > 1 ? ` · ${f.variants} machines` : ''}</div>
        </div>
        ${trendBadge(f.percentPerSession)}
      </div>`,
    )
    .join('');

  return `<div class="card">
      <div class="row-between" style="margin-bottom:2px">
        <b>Movements</b><span class="pill">${analysed.length} with a trend</span>
      </div>
      <div class="tiny muted" style="margin-bottom:4px">
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
        <div class="tiny muted" style="margin-top:6px">
          ${scored} session${scored === 1 ? '' : 's'} rated. A few more and this will say whether
          how you turn up is showing in the work.
        </div>
      </div>`;
  }

  return `<div class="card">
      <div class="row-between" style="margin-bottom:8px">
        <b>How it felt</b>
        <span class="pill">${effect.sessionsScored} rated</span>
      </div>
      <div style="font-size:14.5px">${esc(effect.message)}</div>
    </div>`;
}

function renderRecovery(findings) {
  const r = recoveryReport(state.metrics, findings);

  if (!r.hasData) {
    return `<div class="card">
      <div class="row-between" style="margin-bottom:8px">
        <b>Recovery</b><span class="pill">no watch data</span>
      </div>
      <div class="tiny muted">${esc(r.message)}</div>
      <div class="tiny muted" style="margin-top:8px">Setup → Apple Health has the steps.</div>
    </div>`;
  }

  const stat = (label, value, unit) =>
    value === null
      ? ''
      : `<div style="text-align:center;flex:1">
           <div class="mono" style="font-size:20px;font-weight:700">${value}<span class="tiny muted">${unit}</span></div>
           <div class="tiny muted">${label}</div>
         </div>`;

  return `<div class="card" style="${r.flags.length ? 'border-color:var(--warn)' : ''}">
      <div class="row-between" style="margin-bottom:10px">
        <b>Recovery</b>
        <span class="pill ${r.flags.length ? 'pill-warn' : 'pill-good'}">
          ${r.flags.length ? `${r.flags.length} thing${r.flags.length === 1 ? '' : 's'} to watch` : 'steady'}
        </span>
      </div>
      <div class="row" style="margin-bottom:10px">
        ${stat('sleep', r.sleep, 'h')}
        ${stat('steps', r.steps === null ? null : Math.round(r.steps).toLocaleString(), '')}
        ${stat('resting HR', r.restingHr, '')}
        ${stat('HRV', r.hrv, '')}
      </div>
      <div class="tiny muted" style="margin-bottom:4px">7-day averages</div>
      <div style="font-size:14.5px">${esc(r.message)}</div>
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

    return `<div class="row-between" style="padding:6px 0">
      <label class="tiny muted" style="flex:0 0 78px">${esc(f.label)}</label>
      <input class="input mono grow" data-day-field="${esc(f.name)}" inputmode="decimal"
        placeholder="—" value="${esc(String(value))}" style="text-align:right">
      <span class="tiny muted" style="flex:0 0 34px;text-align:right">${esc(f.unit)}</span>
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
  const label = when.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

  openSheet(
    `<h2 style="margin-top:0">${esc(label)}</h2>
     <div class="tiny muted" style="margin-bottom:12px">
       Fill in what you know and save. Clearing a box removes that reading.
     </div>
     ${renderDayRow(date, values)}
     <button class="btn btn-primary btn-block btn-lg" style="margin-top:12px" data-day-save="1">Save</button>`,
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
    new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' });

  const rows = past
    .map(
      (d) => `<button class="lib-row" data-act="edit-day" data-date="${esc(d.date)}">
        <div class="grow" style="min-width:0">
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

  const dow = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' });

  const rows = days
    .map((d) => {
      const bits = [
        d.walking ? `walk ${d.walking}` : null,
        d.lifting ? `lift ${d.lifting}` : null,
      ].filter(Boolean).join(' · ');

      const colour = d.deficit === null ? 'var(--muted)' : d.deficit > 0 ? 'var(--good)' : 'var(--bad)';

      return `<div class="row-between" style="padding:6px 0;border-top:1px solid var(--line)">
        <div class="grow" style="min-width:0">
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

  return `<div class="tiny muted" style="margin-top:14px"><b>Day by day</b> — burn against what you ate</div>
    ${rows}
    <div class="tiny muted" style="margin-top:8px">
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

  const measured = measuredDeficit({ perWeek: weight.direction === 'unknown' ? null : weight.perWeek, intakeAvg });
  const verdict = deficitVerdict({
    perWeek: weight.direction === 'unknown' ? null : weight.perWeek,
    weightLb: weight.smoothed,
    liftsHolding: liftsAreHolding(),
  });

  if (!est.known && !measured.known) {
    return `<div class="tiny muted" style="margin-top:12px">
      Add your height and age above, and log a few weights, and this works out what you are
      burning — and then checks that against what the scale actually did.
    </div>`;
  }

  const line = (k, v) => `<div class="row-between" style="padding:5px 0;border-top:1px solid var(--line)">
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
      ? `${line('<b>What the scale says you burn</b>', `<b>${measured.impliedTDEE} kcal</b>`)}
         ${line('Actual daily deficit', `${measured.deficitPerDay} kcal`)}`
      : ''}
    ${verdict.severity !== 'unknown'
      ? `<div class="tiny" style="margin-top:10px;color:${
          verdict.severity === 'too-steep' ? 'var(--bad)' : verdict.severity === 'aggressive' ? 'var(--warn)' : 'var(--good)'
        }">${esc(verdict.message)}</div>`
      : ''}
    ${est.known && measured.known && Math.abs(est.tdee - measured.impliedTDEE) > 400
      ? `<div class="tiny" style="margin-top:8px;color:var(--warn)">
           The estimate and the scale disagree by ${Math.abs(est.tdee - measured.impliedTDEE)} kcal a day.
           Believe the scale: the formula cannot see how much you actually move, and it is the
           one being contradicted by the weight that did or did not leave.
         </div>`
      : est.known && measured.known
        ? `<div class="tiny muted" style="margin-top:8px">
             These agree closely, which is a good sign both are roughly right.
           </div>`
        : est.known
          ? `<div class="tiny muted" style="margin-top:8px">
               An estimate only, good to about ±20%. Log weights for two weeks and the scale
               will measure this properly — it cannot be argued with the way a formula can.
             </div>`
          : ''}`;
}

/** Are his lifts broadly holding? Used to judge whether a cut is too steep. */
function liftsAreHolding() {
  const items = loggedExerciseList().map((e) => ({ name: e.name, exerciseId: e.exerciseId, history: e.history }));
  const findings = analyzeAll(items);
  if (findings.length < 3) return null;

  const falling = findings.filter((f) => f.status === 'regressing').length;
  return falling / findings.length < 0.4;
}

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
    <div class="row-between" style="margin-bottom:6px">
      <span class="tiny mono muted">${step + 1} / ${TOUR.length}</span>
      ${last ? '' : '<button class="btn btn-sm btn-ghost" data-act="tour-done">Skip</button>'}
    </div>

    <div class="tour-stage">${card.art}</div>

    <h1 style="margin:18px 0 8px;font-size:22px">${esc(card.title)}</h1>
    <p class="sub" style="min-height:82px">${esc(card.body)}</p>

    <div class="tour-dots" aria-hidden="true">
      ${TOUR.map((_, i) => `<span class="tour-dot${i === step ? ' on' : ''}"></span>`).join('')}
    </div>

    <div class="row" style="gap:8px;margin-top:14px">
      ${step > 0 ? '<button class="btn grow" data-act="tour-back">Back</button>' : ''}
      <button class="btn btn-primary grow" data-act="${last ? 'tour-done' : 'tour-next'}">
        ${last ? 'Start training' : 'Next'}
      </button>
    </div>
  </div>`;
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

  return `<div class="row" style="gap:6px;margin-bottom:4px">
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

    return `<div class="card" style="margin-bottom:8px">
        <div class="row-between">
          <b>${esc(s.dayName ?? 'Workout')}</b>
          <span class="tiny mono muted">${esc(fmtDate(String(s.startedAt ?? '').slice(0, 10)))}</span>
        </div>
        <div class="tiny muted" style="margin-top:4px">
          ${(s.sets ?? []).length} set${(s.sets ?? []).length === 1 ? '' : 's'}
          ${names.length ? ` · ${esc(names.slice(0, 4).join(' · '))}${names.length > 4 ? ' …' : ''}` : ''}
        </div>
      </div>`;
  }).join('');

  const profile = person.profile ?? null;
  const said = profile && profile.onboardedAt;

  return `${adminSwitch('admin')}
    <button class="btn btn-sm btn-ghost" data-act="acct-view-self">‹ Accounts</button>
    <h1 style="margin-top:8px">${esc(person.name)}</h1>
    <p class="sub">
      Read-only. Nothing here writes to their log, and your own training is untouched.
    </p>

    ${person.loading ? '<div class="empty">Fetching their workouts…</div>' : ''}
    ${person.error ? '<div class="card" style="border-color:var(--bad)"><div class="tiny" style="color:var(--bad)">Could not reach the server. Their training is not lost — this screen just could not load it.</div></div>' : ''}

    ${!person.loading && !person.error ? `
      <div class="card">
        <div class="row-between">
          <span class="tiny muted">Account</span>
          <span class="pill ${person.status === 'active' ? 'pill-good' : ''}">${esc(person.status)}</span>
        </div>
        <div class="row-between" style="margin-top:8px">
          <span class="tiny muted">Registered</span>
          <span class="tiny mono">${said ? 'yes' : 'not yet'}</span>
        </div>
        <div class="row-between" style="margin-top:8px">
          <span class="tiny muted">Workouts logged</span>
          <span class="tiny mono">${sessions.length}</span>
        </div>
        <div class="row-between" style="margin-top:8px">
          <span class="tiny muted">Weigh-ins</span>
          <span class="tiny mono">${weights.length}</span>
        </div>
        ${weights.length ? `<div class="row-between" style="margin-top:8px">
            <span class="tiny muted">Last weighed</span>
            <span class="tiny mono">${weights[0].value} lb · ${esc(fmtDate(weights[0].date))}</span>
          </div>` : ''}
      </div>

      ${!sessions.length ? `<div class="card" style="margin-top:12px">
          <b class="tiny">Nothing logged yet</b>
          <div class="tiny muted" style="margin-top:6px">
            ${said
              ? 'They have set themselves up but have not trained yet. This fills in after their first workout.'
              : person.firstSeenAt
                ? 'They have opened the app but not finished setting it up, so there is nothing to show.'
                : 'They have not opened the app yet. Nothing is wrong — there is simply nothing there.'}
          </div>
        </div>` : `<h2>Recent workouts</h2>${rows}`}

      <button class="btn btn-block btn-ghost btn-sm" style="margin-top:12px" data-act="acct-view-refresh">
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
  return `<div style="padding:24px 4px">
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

    <h1 style="margin:14px 0 6px">Personal Trainer</h1>
    <p class="sub" style="margin-bottom:22px">
      A lifting log that works with no signal, and a coach that reads your own numbers
      back to you.
    </p>

    ${state.accountError ? `<div class="card" style="border-color:var(--bad);margin-bottom:14px">
        <div class="tiny" style="color:var(--bad)">${esc(state.accountError)}</div>
      </div>` : ''}

    ${state.googleClientId ? `<div class="card" style="margin-bottom:12px">
        <div class="tiny muted" style="margin-bottom:10px">
          Use the Google account the invitation was sent to.
        </div>
        <div id="google-slot" style="display:flex;justify-content:center;min-height:44px">
          <span class="spinner"></span>
        </div>
      </div>

      <div class="row" style="gap:10px;align-items:center;margin:4px 0 12px">
        <div style="flex:1;height:1px;background:var(--line)"></div>
        <span class="tiny muted">or</span>
        <div style="flex:1;height:1px;background:var(--line)"></div>
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
      <input class="input mono" id="welcome-code" placeholder="paste it here"
        autocapitalize="off" autocorrect="off" spellcheck="false"
        value="${esc(state.codeDraft ?? '')}"
        style="margin:8px 0 12px;font-size:13px">
      <button class="btn btn-primary btn-block btn-lg" data-act="welcome-signin"
        ${state.signingIn ? 'disabled' : ''}>
        ${state.signingIn ? '<span class="spinner"></span> Signing in…' : 'Continue'}
      </button>
      <div class="tiny muted" style="margin-top:10px">
        It came in the email that sent you here. There is no password${state.googleClientId
          ? ' — this and the Google button do the same thing'
          : ' and nothing else to set up'}.
      </div>
    </div>

    <button class="btn btn-block btn-ghost btn-sm" style="margin-top:16px" data-act="welcome-solo">
      Use this on my own, with no account
    </button>
    <div class="tiny muted" style="text-align:center;margin-top:6px">
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

  return `<div style="padding:18px 4px">
    <h1 style="margin:0 0 6px">A few things about you</h1>
    <p class="sub" style="margin-bottom:20px">
      This is asked once. Without it the calorie and recovery numbers cannot be worked
      out at all, and a guess would be a confident number about nobody.
    </p>

    <div class="card" style="margin-bottom:12px">
      <div class="meta-grid">
        <div>
          <label class="tiny muted">Age</label>
          <input class="input" id="reg-age" type="number" inputmode="numeric" min="13" max="100"
            placeholder="e.g. 27" value="${field('age')}" style="margin-top:6px">
        </div>
        <div>
          <label class="tiny muted">Height (inches)</label>
          <input class="input" id="reg-height" type="number" inputmode="decimal" min="36" max="96"
            placeholder="e.g. 64" value="${field('heightInches')}" style="margin-top:6px">
        </div>
      </div>
      <div class="tiny muted" style="margin-top:6px">5'4" is 64 inches.</div>
    </div>

    <div class="card" style="margin-bottom:12px">
      <label class="tiny muted">Sex — the resting burn formula needs it</label>
      <div class="row" style="gap:8px;margin-top:8px">
        ${['female', 'male'].map((v) => `<button class="btn grow ${d.sex === v ? 'btn-primary' : ''}"
            data-act="reg-sex" data-value="${v}">${v === 'female' ? 'Female' : 'Male'}</button>`).join('')}
      </div>
    </div>

    <div class="card" style="margin-bottom:12px">
      <label class="tiny muted">Bodyweight (lb)</label>
      <input class="input" id="reg-weight" type="number" inputmode="decimal" min="50" max="600" step="0.1"
        placeholder="e.g. 132.4" value="${field('weight')}" style="margin:6px 0 4px">
      <div class="tiny muted">
        Logged as today's reading. Weigh yourself the same way each morning and the trend
        does the rest — day to day it moves on salt and water, not fat.
      </div>
    </div>

    <div class="card" style="margin-bottom:12px">
      <label class="tiny muted">Body fat, as a range you believe</label>
      <div class="meta-grid" style="margin-top:6px">
        <input class="input" id="reg-bf-low" type="number" inputmode="decimal" min="3" max="60"
          placeholder="e.g. 24" value="${field('bodyFatLow')}">
        <input class="input" id="reg-bf-high" type="number" inputmode="decimal" min="3" max="60"
          placeholder="e.g. 28" value="${field('bodyFatHigh')}">
      </div>
      <div class="tiny muted" style="margin-top:6px">
        Optional, and an eye estimate is fine — nobody knows this to a decimal. A range
        is an honest answer where a single number is not.
      </div>
    </div>

    <div class="card" style="margin-bottom:12px">
      <label class="tiny muted">Steps on a normal day</label>
      <input class="input" id="reg-steps" type="number" inputmode="numeric" min="0" max="60000"
        placeholder="e.g. 7000" value="${field('averageSteps')}" style="margin:6px 0 4px">
      <div class="tiny muted">
        A starting point only. Real readings replace it as soon as there are any.
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <label class="tiny muted">What you are doing right now</label>
      <div style="margin-top:8px">
        ${goals.map(([value, label, hint]) => `<button class="btn btn-block ${d.goal === value ? 'btn-primary' : ''}"
            style="margin-bottom:6px;text-align:left" data-act="reg-goal" data-value="${value}">
            <b>${label}</b> <span class="tiny muted">— ${hint}</span>
          </button>`).join('')}
      </div>
    </div>

    ${state.accountError ? `<div class="tiny" style="color:var(--bad);margin-bottom:10px">${esc(state.accountError)}</div>` : ''}

    <button class="btn btn-primary btn-block btn-lg" data-act="reg-save">Start training</button>
    <div class="tiny muted" style="text-align:center;margin-top:8px">
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

  const rows = (users ?? [])
    .map((u) => `<div class="card" style="margin-bottom:8px;padding:12px">
        <div class="row-between">
          <div style="min-width:0">
            <b style="font-size:14.5px">${esc(u.name)}</b>
            <div class="tiny muted" style="word-break:break-all">${esc(u.email)}</div>
          </div>
          <span class="pill ${u.status === 'active' ? 'pill-good' : u.status === 'suspended' ? 'pill-warn' : ''}">
            ${esc(u.status)}
          </span>
        </div>
        <div class="tiny muted" style="margin-top:6px">
          ${u.role === 'admin' ? 'administrator' : 'member'}
          ${u.firstSeenAt ? ` · first opened it ${esc(daysAgo(u.firstSeenAt))}` : ' · has not opened it yet'}
        </div>
        ${u.role === 'admin' ? '' : `<div class="row" style="gap:6px;margin-top:10px">
            <button class="btn btn-sm grow" data-act="acct-view" data-id="${esc(u.id)}">See their training</button>
            <button class="btn btn-sm btn-ghost grow" data-act="acct-rotate" data-id="${esc(u.id)}">New code</button>
          </div>
          <button class="btn btn-sm btn-block btn-ghost ${u.status === 'suspended' ? '' : 'danger'}" style="margin-top:6px"
            data-act="acct-status" data-id="${esc(u.id)}" data-status="${u.status === 'suspended' ? 'active' : 'suspended'}">
            ${u.status === 'suspended' ? 'Restore access' : 'Suspend access'}
          </button>`}
      </div>`)
    .join('');

  return `${adminSwitch('admin')}
    <h1 style="margin-top:8px">Accounts</h1>
    <p class="sub">
      Access is by invitation only — an account has to exist before anyone can sign in,
      and nobody can create one for themselves.
    </p>


    ${users === null
      ? '<div class="empty">Loading…</div>'
      : rows || '<div class="empty">Only you, so far.</div>'}

    <button class="btn btn-primary btn-block" style="margin-top:14px" data-act="acct-invite">
      Invite somebody
    </button>`;
}

function viewSetup() {
  const pending = dirtySessions().length;
  const you = renderYou();
  const plates = [45, 35, 25, 10, 5, 2.5];

  const toggles = plates
    .map((p) => {
      const on = state.settings.availablePlates.includes(p);
      return `<button class="btn btn-sm" data-act="toggle-plate" data-p="${p}"
        style="${on ? 'background:var(--accent);color:var(--accent-ink);border-color:transparent' : ''}">${p}</button>`;
    })
    .join('');

  return `<h1>Setup</h1>
    <h2>Plates in your gym</h2>
    <div class="card">
      <div class="row wrap" style="gap:8px">${toggles}</div>
      <div class="tiny muted" style="margin-top:10px">
        Every prescribed weight is rounded to something these plates can actually make.
      </div>
    </div>

    <h2>Rest timer</h2>
    <div class="card">
      <label class="tiny muted">Default rest between sets (seconds)</label>
      <input class="input mono" type="number" inputmode="numeric" data-act="rest-default"
        value="${state.settings.defaultRestSeconds}" style="margin-top:8px">
    </div>

    <h2>You</h2>
    <div class="card">
      <div class="tiny muted" style="margin-bottom:12px">
        Strength on its own is a half-reading. Holding a lift while you lose weight is a
        win, and without this the coach calls it a stall. All optional — blank stays
        blank, and unknown is reported as unknown rather than guessed at.
      </div>

      <div class="row-between" style="margin-bottom:4px">
        <span class="tiny muted"><b>Today</b></span>
        ${you.todayPending ? '<span class="tiny muted">queued to upload</span>' : ''}
      </div>
      ${renderDayRow(you.today, you.todayValues)}
      <button class="btn btn-primary btn-block" style="margin-top:8px" data-act="save-today">Save today</button>

      ${you.count
        ? `<div class="tiny muted" style="margin:14px 0 4px"><b>Earlier</b> — tap any day to add or fix it</div>${you.rows}`
        : ''}

      <div class="row" style="gap:8px;margin-top:12px;align-items:center">
        <span class="tiny muted" style="flex:0 0 auto">Older day</span>
        <input class="input mono grow" type="date" data-act="pick-day" max="${esc(you.today)}" value="">
      </div>
      <div class="tiny muted" style="margin-top:6px">
        For anything past the fortnight above — or to move a reading you logged just after
        midnight onto the day it belongs to.
      </div>

      <div class="row" style="gap:8px;margin-top:14px">
        <div class="grow">
          <label class="tiny muted">Height (in)</label>
          <input class="input mono" data-act="height" inputmode="numeric" placeholder="69"
            value="${state.settings.heightInches ?? ''}" style="margin-top:8px">
        </div>
        <div class="grow">
          <label class="tiny muted">Age</label>
          <input class="input mono" data-act="age" inputmode="numeric" placeholder="35"
            value="${state.settings.age ?? ''}" style="margin-top:8px">
        </div>
      </div>

      <div class="row" style="gap:8px;margin-top:12px">
        <div class="grow">
          <label class="tiny muted">Body fat from (%)</label>
          <input class="input mono" data-act="bf-low" inputmode="numeric" placeholder="e.g. 16"
            value="${state.settings.bodyFatLow ?? ''}" style="margin-top:8px">
        </div>
        <div class="grow">
          <label class="tiny muted">to (%)</label>
          <input class="input mono" data-act="bf-high" inputmode="numeric" placeholder="e.g. 19"
            value="${state.settings.bodyFatHigh ?? ''}" style="margin-top:8px">
        </div>
      </div>
      <div class="tiny muted" style="margin-top:6px">
        A range, not a number — an eye-test estimate is honest and a decimal place is not.
      </div>
      ${(() => {
        // Three states, not two: with no weight at all nothing is being
        // computed, and saying "using Mifflin" there would be a claim about
        // arithmetic that is not running.
        if (bodyweightTrend(state.metrics).smoothed === null) {
          return `<div class="tiny muted" style="margin-top:6px">
            Log a weight and this starts working.
          </div>`;
        }
        return restingMethod() === 'katch'
          ? `<div class="tiny ok" style="margin-top:6px">Using Katch-McArdle off your lean mass.</div>`
          : `<div class="tiny" style="margin-top:6px;color:var(--warn)">
               Not set — the burn is using Mifflin-St Jeor, which charges muscle and fat the
               same and understates a muscular build. Fill both boxes to switch.
             </div>`;
      })()}

      <label class="tiny muted" style="display:block;margin-top:12px">Maintenance calories (optional — the scale works it out)</label>
      <input class="input mono" data-act="maintenance" inputmode="numeric" placeholder="e.g. 2600"
        value="${state.settings.maintenanceCalories ?? ''}" style="margin:8px 0 12px">

      <label class="tiny muted">What you are doing right now</label>
      <select class="input" data-act="goal" style="margin:8px 0 12px">
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

      <div class="tiny muted">${esc(you.ctx.summary)}</div>
      ${renderEnergy()}
      ${renderDailyEnergy()}
      <div class="tiny muted" style="margin-top:8px">
        Bodyweight, calories and macros come from the Health shortcut — see HEALTH.md.
        Log <span class="mono">body_weight</span>, <span class="mono">dietary_energy</span>
        and <span class="mono">protein</span> and they appear here.
      </div>
    </div>

    <h2>Offline</h2>
    <div class="card">
      <div class="row-between" style="margin-bottom:${state.offlineReady === false ? '10px' : '0'}">
        <span class="tiny muted">Works with no signal</span>
        <span class="pill ${state.offlineReady ? 'pill-good' : state.offlineReady === false ? 'pill-bad' : ''}">
          ${state.offlineReady === null ? 'checking…' : state.offlineReady ? 'ready' : 'NOT ready'}
        </span>
      </div>
      ${state.offlineReason ? `<div class="tiny" style="color:var(--bad)">${esc(state.offlineReason)}</div>` : ''}
    </div>

    <h2>Account</h2>
    <div class="card">
      ${state.account
        ? `<div class="row-between">
             <div style="min-width:0">
               <b>${esc(state.account.name ?? 'You')}</b>
               <div class="tiny muted" style="word-break:break-all">${esc(state.account.email ?? '')}</div>
             </div>
             <span class="pill ${isAdmin() ? 'pill-good' : ''}">${isAdmin() ? 'administrator' : 'member'}</span>
           </div>
           ${isAdmin()
             ? '<button class="btn btn-block" style="margin-top:12px" data-act="accounts">Accounts and invitations</button>'
             : ''}`
        : `<div class="tiny muted">
             Not signed in. Everything works on this phone alone — an account is only what
             lets it back up and be read on a second device.
           </div>`}
      <label class="row" style="gap:10px;margin-top:14px">
        <input type="checkbox" data-act="video-toggle" style="width:22px;height:22px"
          ${(state.account?.profile?.showExerciseVideo ?? state.settings.showExerciseVideo) ? 'checked' : ''}>
        <span class="tiny">Show how each exercise is done</span>
      </label>
      <button class="btn btn-block btn-ghost btn-sm" style="margin-top:12px" data-act="tour-open">
        Show me around again
      </button>
    </div>

    <h2>Sync</h2>
    <div class="card">
      <div class="tiny muted" style="margin-bottom:12px">
        Optional. Everything already works without it — this only copies your logs
        somewhere they also exist.
      </div>
      <button class="btn btn-sm btn-block btn-ghost" style="margin-bottom:12px" data-act="use-cloud">
        Use the shared cloud
      </button>

      <label class="tiny muted">Your PC's address</label>
      <input class="input mono" data-act="server-url" inputmode="url" autocapitalize="off" autocorrect="off"
        spellcheck="false" placeholder="https://your-pc.local:8443"
        value="${esc(state.settings.serverUrl ?? '')}" style="margin:8px 0 8px;font-size:13px">
      <div class="tiny muted" style="margin-bottom:12px">
        The app is served from GitHub, so it cannot guess where your PC is. Leave this
        blank and there is nothing to sync to.
      </div>
      <label class="tiny muted">Access token</label>
      <input class="input mono" type="password" data-act="auth-token" autocapitalize="off" autocorrect="off"
        spellcheck="false" placeholder="leave blank for a PC on your own network"
        value="${esc(state.settings.authToken ?? '')}" style="margin:8px 0 12px;font-size:13px">

      <button class="btn btn-block btn-sm" data-act="test-server" style="margin-bottom:12px">Test connection</button>

      <div class="row-between" style="margin-bottom:10px">
        <span class="tiny muted">PC server</span>
        <span class="pill ${state.online ? 'pill-good' : ''}">${state.online ? 'reachable' : 'not reachable'}</span>
      </div>
      <div class="row-between" style="margin-bottom:10px">
        <span class="tiny muted">Not yet backed up</span>
        <span class="tiny mono">${pending} session${pending === 1 ? '' : 's'}</span>
      </div>
      <div class="row-between" style="margin-bottom:12px">
        <span class="tiny muted">Last sync</span>
        <span class="tiny mono">${state.lastSync ? esc(daysAgo(state.lastSync)) : 'never'}</span>
      </div>
      <button class="btn btn-block" data-act="sync" ${state.syncing ? 'disabled' : ''}>
        ${state.syncing ? '<span class="spinner"></span> Backing up…' : 'Back up now'}
      </button>
    </div>

    <h2>Apple Health</h2>
    <div class="card">
      <div class="tiny muted" style="margin-bottom:10px">
        Apple gives web apps no access to Health, so this cannot read your watch directly.
        An iOS Shortcut can, and can post to your server on a schedule.
      </div>
      <div class="row-between" style="margin-bottom:10px">
        <span class="tiny muted">Readings stored</span>
        <span class="tiny mono">${state.metrics.length}</span>
      </div>
      <div class="tiny muted" style="word-break:break-all">
        Post to <b>${esc(state.settings.serverUrl || '<your server>')}/api/metrics</b><br>
        with your access token. See <b>HEALTH.md</b> in the repo for the exact Shortcut.
      </div>
    </div>

    <h2>Found a bug?</h2>
    <div class="card">
      <div class="tiny muted" style="margin-bottom:10px">
        Write it down the moment you hit it. Works with no signal — it uploads with your next sync.
      </div>
      <button class="btn btn-block" data-act="report-bug">Report a bug</button>
      ${state.notes.length
        ? `<div style="margin-top:12px">${state.notes
            .slice(-5)
            .reverse()
            .map(
              (n) => `<div class="tiny" style="padding:8px 0;border-top:1px solid var(--line)">
                <div>${esc(n.text)}</div>
                <div class="muted" style="margin-top:3px">${fmtDate(n.createdAt)} · ${esc(n.context ?? '')}${n._dirty ? ' · not uploaded' : ''}</div>
              </div>`,
            )
            .join('')}</div>`
        : ''}
    </div>

    <h2>Data</h2>
    <div class="card">
      <button class="btn btn-block" data-act="import-log" style="margin-bottom:8px">Paste in a workout</button>
      <button class="btn btn-block" data-act="export" style="margin-bottom:8px">Export all sessions (JSON)</button>
      <button class="btn btn-block btn-ghost" style="margin-bottom:8px" data-act="reset-program">
        Reset program to the built-in one
      </button>
      <button class="btn btn-block btn-ghost" data-act="reload-boot">Refresh program from PC server</button>
      <div class="tiny muted" style="margin-top:10px">
        Resetting replaces your day templates. Every workout you have logged is kept.
      </div>
    </div>

    <h2>This build</h2>
    <div class="card">
      <div class="tiny muted" style="margin-bottom:10px">
        If something looks out of date, these numbers say what your phone is actually running.
      </div>
      <div class="row-between"><span class="tiny muted">Build</span><span class="tiny mono">${esc(BUILD)}</span></div>
      <div class="row-between"><span class="tiny muted">Exercise library</span><span class="tiny mono">${(state.boot.exercises ?? []).filter((e) => !e.archived).length} lifts</span></div>
      <div class="row-between"><span class="tiny muted">Program version</span><span class="tiny mono">${state.boot.seedVersion ?? 'older than 2'}</span></div>
      <div class="row-between"><span class="tiny muted">Sessions on this phone</span><span class="tiny mono">${(state.sessions ?? []).length}</span></div>
    </div>`;
}

/* ================================ editor ================================ */

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'item';

/** Edits happen on a copy, so backing out leaves the real template untouched. */
function cloneDay(day) {
  return {
    id: day.id,
    programId: day.programId,
    name: day.name,
    position: day.position ?? 0,
    exercises: (day.exercises ?? []).map((e) => ({
      id: e.id,
      exerciseId: e.exerciseId,
      name: e.name,
      schemeId: e.schemeId ?? 'rp-2',
      restSeconds: e.restSeconds ?? state.settings.defaultRestSeconds,
    })),
  };
}

function markDirty() {
  const first = !state.draftDirty;
  state.draftDirty = true;
  if (first) render();
}

function viewEdit() {
  const programs = state.boot.programs ?? [];
  const days = state.boot.days ?? [];

  const warning = state.online
    ? ''
    : `<div class="card" style="border-color:var(--warn)">
         <div class="tiny" style="color:var(--warn)">Editing writes to your PC, so it needs to be reachable.
         Get on your home wifi and this page will work.</div>
       </div>`;

  const groups = programs
    .map((p) => {
      const mine = days.filter((d) => d.programId === p.id);
      const rows = mine
        .map(
          (d) => `<button class="card card-tap" data-act="edit-day" data-id="${esc(d.id)}">
            <div class="row-between">
              <div class="grow" style="min-width:0">
                <b>${esc(d.name)}</b>
                <div class="tiny muted" style="margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                  ${esc(d.exercises.map((e) => e.name).join(' · ')) || 'no exercises yet'}
                </div>
              </div>
              <span class="pill">${d.exercises.length}</span>
              <div style="font-size:22px;color:var(--muted)">›</div>
            </div>
          </button>`,
        )
        .join('');

      return `<div class="row-between" style="margin:24px 0 10px">
          <h2 style="margin:0">${esc(p.name)}</h2>
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
    <button class="btn btn-block" style="margin-top:16px" data-act="library">Exercise library</button>
    <button class="btn btn-block" style="margin-top:8px" data-act="gyms">Gyms and machines</button>
    <button class="btn btn-block" style="margin-top:8px" data-act="new-program">+ New program</button>`;
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
function viewGyms() {
  const gyms = gymsList();

  const rows = gyms
    .map((g) => {
      const machines = allMachinesAt(g);
      const lifts = Object.keys(g.machines ?? {}).length;

      return `<div class="card" style="margin-bottom:10px">
        <div class="row-between">
          <b>${esc(g.name)}</b>
          <button class="btn btn-sm btn-ghost" data-act="gym-rename" data-id="${esc(g.id)}">Rename</button>
        </div>
        <div class="tiny muted" style="margin-top:4px">
          ${g.fixes
            ? `position learned from ${g.fixes} visit${g.fixes === 1 ? '' : 's'}`
            : 'no position yet — it learns one the next time you train here'}
          · ${lifts} lift${lifts === 1 ? '' : 's'} mapped
        </div>
        ${machines.length
          ? `<div class="row wrap" style="gap:4px;margin-top:8px">
               ${machines.map((m) => `<span class="pill">${esc(m)}</span>`).join('')}
             </div>`
          : '<div class="tiny muted" style="margin-top:8px">No machines recorded here yet.</div>'}
        ${machineSuspects(g)
          .map((pair) => `<div class="card" style="margin-top:10px;padding:12px">
              <div class="tiny">
                <b>${esc(pair.names[0])}</b> and <b>${esc(pair.names[1])}</b> look like two
                names for one machine. Split like that, each one is counted separately and
                neither becomes the expected answer.
              </div>
              <div class="row" style="gap:6px;margin-top:10px">
                ${pair.names.map((keep, i) => `<button class="btn btn-sm ${i ? 'btn-ghost' : 'btn-primary'} grow"
                    data-act="gym-merge-machine" data-id="${esc(g.id)}"
                    data-keep="${esc(keep)}" data-drop="${esc(pair.names[i ? 0 : 1])}">
                    Keep ${esc(keep)}
                  </button>`).join('')}
              </div>
            </div>`)
          .join('')}
        <button class="btn btn-sm btn-block btn-ghost danger" style="margin-top:10px"
          data-act="gym-delete" data-id="${esc(g.id)}">Delete this gym</button>
      </div>`;
    })
    .join('');

  return `<button class="btn btn-sm btn-ghost" data-act="edit">‹ Edit</button>
    <h1 style="margin-top:8px">Gyms</h1>
    <p class="sub">
      Asked at the start of every workout. Each one keeps its own machines, because the
      same lift on two different stacks is two different weights.
    </p>
    ${rows || '<div class="empty">No gyms yet. The first workout you start will ask.</div>'}`;
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
function groupChecks(exercises) {
  const found = groupSuspects(exercises);
  if (!found.length) return '';

  const rows = found
    .map((s) => `<div class="card" style="margin-bottom:8px;padding:12px">
        <b style="font-size:14.5px">${esc(s.name)}</b>
        <div class="tiny muted" style="margin-top:3px">
          ${s.reason === 'missing'
            ? 'No muscle group recorded, so it is missing from every group total.'
            : `Filed under <b>${esc(s.recorded)}</b>, but it reads as a <b>${esc(s.suggested)}</b> movement.`}
        </div>
        <div class="row" style="gap:6px;margin-top:10px">
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

  return `<div style="margin:14px 0 18px">
      <div class="row-between" style="margin-bottom:8px">
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
          <div class="grow" style="min-width:0">
            <b style="font-size:14.5px">${esc(e.name)}</b>
            ${extra ? `<div class="tiny muted">${esc(extra)}</div>` : ''}
            <div class="row wrap" style="gap:4px;margin-top:4px">
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
    <h1 style="margin-top:8px">Exercise library</h1>
    <p class="sub">${all.length} lifts. Tap one to change its machine, handle, notes or equipment.</p>
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
        <div class="grow" style="min-width:0">
          <button class="row" style="width:100%;text-align:left" data-act="ex-swap" data-i="${i}">
            <b class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.name)}</b>
            <span class="tiny muted">change ›</span>
          </button>
          <div class="edit-meta">
            <select data-act="ex-scheme" data-i="${i}">
              ${schemes.map((s) => `<option value="${esc(s.id)}" ${s.id === e.schemeId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
            </select>
            <input type="number" inputmode="numeric" data-act="ex-rest" data-i="${i}" value="${e.restSeconds}">
            <button class="btn btn-sm" data-act="ex-rename" data-i="${i}">✎ rename</button>
          </div>
        </div>
        <button class="btn btn-sm danger" data-act="ex-remove" data-i="${i}" style="flex:none">×</button>
      </div>`,
    )
    .join('');

  return `<div class="row-between">
      <button class="btn btn-sm btn-ghost" data-act="edit">‹ Back</button>
      <button class="btn btn-sm danger" data-act="delete-day">Delete day</button>
    </div>

    <h1 style="margin-top:10px">${esc(d.name || 'New day')}</h1>

    <div class="card">
      <label class="tiny muted">Day name</label>
      <input class="input" data-act="day-name" value="${esc(d.name)}" placeholder="e.g. Legs 1" style="margin:8px 0 14px">
      <label class="tiny muted">Belongs to</label>
      <select class="input" data-act="day-program" style="margin-top:8px">
        ${programs.map((p) => `<option value="${esc(p.id)}" ${p.id === d.programId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
    </div>

    <h2>Exercises <span class="tiny muted">· ${d.exercises.length}</span></h2>
    ${rows || '<div class="empty">No exercises yet — add the first one.</div>'}
    <button class="btn btn-block" data-act="add-exercise">+ Add exercise</button>

    <div class="tiny muted" style="margin-top:14px">
      The number box is rest between sets, in seconds.
    </div>

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

function openSheet(html, onEvent) {
  sheetPanel.innerHTML = `<div class="grabber"></div>${html}`;
  sheet.hidden = false;
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

  const draft = {
    tab: 'lb',
    lb: st.weights[idx] ?? equipment.barWeight,
    barType: equipment.barType,
    plates: platesForTotal(st.weights[idx] ?? 0, equipment).plates,
    typing: '',
  };

  const paint = () => {
    const bar = getBarType(draft.barType);
    const eq = { barWeight: bar.weight, loading: bar.loading, available: state.settings.availablePlates };
    const total = draft.tab === 'plates' ? totalFromPlates({ ...eq, plates: draft.plates }) : draft.lb;

    const lbTab = `
      <div class="readout">${fmtWeight(draft.typing !== '' ? Number(draft.typing) : draft.lb)}<small>pounds</small></div>
      <div class="numpad">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join('')}
        <button data-k=".">.</button><button data-k="0">0</button><button data-k="del">⌫</button>
      </div>
      <div class="row" style="gap:8px;margin-top:10px">
        ${[-10, -5, 5, 10].map((d) => `<button class="btn btn-sm grow" data-adj="${d}">${d > 0 ? '+' : ''}${d}</button>`).join('')}
      </div>`;

    const plateTab = `
      <div class="readout">${fmtWeight(total)}<small>${esc(bar.name)}${bar.weight ? ` · bar ${bar.weight}` : ''}</small></div>
      <select class="input" data-act="bar" style="margin-bottom:12px">
        ${BAR_TYPES.map((b) => `<option value="${b.id}" ${b.id === draft.barType ? 'selected' : ''}>${esc(b.name)}${b.weight ? ` (${b.weight} lb)` : ''}</option>`).join('')}
      </select>
      <div class="plate-grid">
        ${state.settings.availablePlates
          .map(
            (p) => `<div class="plate">
              <div class="lbl">${p} lb</div>
              <div class="cnt">${draft.plates[p] ?? 0}</div>
              <div class="pm"><button data-plate="${p}" data-d="-1">−</button><button data-plate="${p}" data-d="1">+</button></div>
            </div>`,
          )
          .join('')}
      </div>
      <div class="tiny muted" style="text-align:center">
        ${bar.loading === 'total' ? 'Plates counted as the whole load' : 'Plates counted per side'}
      </div>`;

    openSheet(
      `<div class="tabs">
        <button class="${draft.tab === 'lb' ? 'on' : ''}" data-tab="lb">Pounds</button>
        <button class="${draft.tab === 'plates' ? 'on' : ''}" data-tab="plates">Plates</button>
      </div>
      ${draft.tab === 'lb' ? lbTab : plateTab}
      <button class="btn btn-primary btn-block btn-lg" style="margin-top:14px" data-done="1">Set ${fmtWeight(total)} lb</button>`,
      (e) => {
        const t = e.target.closest('[data-k],[data-adj],[data-tab],[data-plate],[data-done],[data-act="bar"]');
        if (e.target.matches('select[data-act="bar"]')) {
          draft.barType = e.target.value;
          return paint();
        }
        if (!t) return;

        if (t.dataset.tab) {
          if (t.dataset.tab === 'plates' && draft.tab === 'lb') {
            const b = getBarType(draft.barType);
            draft.plates = platesForTotal(draft.lb, { barWeight: b.weight, loading: b.loading, available: state.settings.availablePlates }).plates;
          }
          if (t.dataset.tab === 'lb' && draft.tab === 'plates') draft.lb = total;
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
    const value = typing === '' ? (st.repDraft ?? defaultReps(ex, st, idx)) : Number(typing);
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
      return `<div class="row-between" style="padding:7px 0;border-top:1px solid var(--line)">
        <span class="tiny">${esc(name)}</span>
        <span class="tiny mono muted">${sets.map((s) => `${s.weight}×${s.reps}`).join('  ')}</span>
      </div>`;
    })
    .join('');

  openSheet(
    `<h2 style="margin-top:0">Imported into ${esc(session.dayName)}</h2>
     <div class="tiny muted" style="margin-bottom:4px">
       Check every lift you did is listed. If one is missing, its line did not make it into the box — paste again.
     </div>
     ${rows}
     <div class="row-between" style="padding:10px 0;border-top:1px solid var(--line);margin-top:4px">
       <b class="tiny">${grouped.size} lift${grouped.size === 1 ? '' : 's'}</b>
       <b class="tiny mono">${session.sets.length} sets</b>
     </div>
     ${errors.length
       ? `<div class="card" style="border-color:var(--bad)">
            <div class="tiny" style="color:var(--bad)">${errors.map(esc).join('<br>')}</div>
          </div>`
       : ''}
     <button class="btn btn-primary btn-block btn-lg" style="margin-top:10px" data-close="1">Done</button>`,
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
              (n) => `<button class="${answers[q.id] === n ? 'on' : ''}" data-q="${esc(q.id)}" data-v="${n}">${n}</button>`,
            ).join('')}
          </div>
        </div>
        <div class="scale-ends"><span>${esc(q.low)}</span><span>${esc(q.high)}</span></div>`,
    ).join('');

    openSheet(
      `<h2 style="margin-top:0">How did that go?</h2>
       <div class="tiny muted" style="margin-bottom:14px">
         Four taps. It is what explains a bad session weeks later, when the numbers alone will not.
       </div>
       ${rows}
       <label class="tiny muted">Anything worth remembering</label>
       <input class="input" id="ci-note" value="${esc(answers.note ?? '')}"
         placeholder="e.g. skipped lunch, gym was packed" style="margin:8px 0 14px" autocomplete="off">
       <button class="btn btn-primary btn-block btn-lg" data-ci-save="1">Save and finish</button>
       <button class="btn btn-block btn-ghost btn-sm" style="margin-top:8px" data-ci-skip="1">Skip</button>`,
      async (e) => {
        const pick = e.target.closest('[data-q]');
        if (pick) {
          const id = pick.dataset.q;
          const value = Number(pick.dataset.v);
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
          answers.note = sheetPanel.querySelector('#ci-note')?.value?.trim() ?? '';
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
 * Pick two lifts to run back to back.
 *
 * Chosen from the session rather than the template, because the reason to pair
 * or break a pair is what is free right now.
 */
function openPairSheet() {
  const a = state.active;
  const chosen = new Set();

  const paint = () => {
    const rows = a.plan.exercises
      .map((e, i) => `<button class="picker-item ${chosen.has(i) ? 'on' : ''}" data-pick-i="${i}">
          <div class="grow" style="min-width:0"><b>${esc(e.name)}</b></div>
          <span class="tiny muted">${chosen.has(i) ? '✓' : ''}</span>
        </button>`)
      .join('');

    openSheet(
      `<h2 style="margin-top:0">Pair into a superset</h2>
       <div class="tiny muted" style="margin-bottom:10px">
         Pick two or more. You will move straight between them, resting only after the round.
         Lifts that are apart get moved together.
       </div>
       ${rows}
       <button class="btn btn-primary btn-block btn-lg" style="margin-top:10px" data-pair-go="1"
         ${chosen.size < 2 ? 'disabled' : ''}>
         Pair ${chosen.size || ''} lift${chosen.size === 1 ? '' : 's'}
       </button>`,
      async (e) => {
        const pick = e.target.closest('[data-pick-i]');
        if (pick) {
          const i = Number(pick.dataset.pickI);
          if (chosen.has(i)) chosen.delete(i);
          else chosen.add(i);
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
      `<h2 style="margin-top:0">${esc(lift.name)}</h2>
       <div class="tiny muted" style="margin-bottom:12px">
         Renaming keeps its history — every set logged against this lift follows it.
       </div>

       <label class="tiny muted">Movement</label>
       <input class="input" id="ed-name" value="${esc(draft.name ?? '')}" style="margin:8px 0 14px" autocomplete="off">

       <div class="meta-grid">
         <input class="input" id="ed-machine" placeholder="Machine" value="${esc(draft.machine ?? '')}" autocomplete="off">
         <input class="input" id="ed-handle" placeholder="Handle / grip" value="${esc(draft.handle ?? '')}" autocomplete="off">
       </div>

       <label class="tiny muted">Equipment — drives the plate calculator</label>
       <select class="input" id="ed-bar" style="margin:8px 0 14px">
         ${BAR_TYPES.map((b) => `<option value="${esc(b.id)}" ${b.id === draft.barType ? 'selected' : ''}>${esc(b.name)}${b.weight ? ` (${b.weight} lb)` : ''}</option>`).join('')}
       </select>

       <label class="tiny muted">Muscle group</label>
       <select class="input" id="ed-group" style="margin:8px 0 14px">
         <option value="">—</option>
         ${MUSCLE_GROUPS.map((g) => `<option value="${esc(g)}" ${g === draft.muscleGroup ? 'selected' : ''}>${esc(g)}</option>`).join('')}
       </select>

       <label class="tiny muted">A variant of</label>
       <select class="input" id="ed-variant" style="margin:8px 0 14px">
         <option value="">nothing — it stands on its own</option>
         ${others.map((x) => `<option value="${esc(x.id)}" ${x.id === draft.variantOf ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
       </select>

       <label class="tiny muted">Notes — setup that changes the movement</label>
       <input class="input" id="ed-notes" value="${esc(draft.notes ?? '')}"
         placeholder="e.g. pad under hips for extra range" style="margin:8px 0 12px" autocomplete="off">

       <label class="tiny muted">Demonstration — a YouTube link</label>
       <input class="input" id="ed-video" value="${esc(draft.videoUrl ?? '')}"
         placeholder="https://www.youtube.com/watch?v=…" style="margin:8px 0 4px;font-size:13px"
         autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off">
       <div class="tiny muted" style="margin-bottom:12px">
         Most lifts come with one already. If it is the wrong movement or badly taught,
         paste a better link — or clear the box and the app offers a search instead.
       </div>

       <label class="row" style="gap:10px;margin-bottom:10px">
         <input type="checkbox" id="ed-bw" style="width:22px;height:22px" ${draft.bodyweight ? 'checked' : ''}>
         <span class="tiny">Can be done with no added weight</span>
       </label>

       <label class="row" style="gap:10px;margin-bottom:14px">
         <input type="checkbox" id="ed-track" style="width:22px;height:22px"
           ${tracksMachine(draft) ? 'checked' : ''}>
         <span class="tiny">Ask which machine at each gym</span>
       </label>

       <button class="btn btn-primary btn-block btn-lg" data-ed-save="1">Save</button>
       <button class="btn btn-block btn-ghost btn-sm ${draft.archived ? '' : 'danger'}" style="margin-top:8px" data-ed-archive="1">
         ${draft.archived ? 'Bring this lift back' : 'Retire this lift'}
       </button>
       <div class="tiny muted" style="text-align:center;margin-top:8px">
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
 * Give a new member the four-day glute program.
 *
 * Additive and idempotent: if the days are already there it does nothing, so a
 * registration corrected a second time does not duplicate her week. Her existing
 * days are left alone entirely — if she has invented one, it stays.
 */
async function installMemberProgram() {
  if (!state.boot) return;

  const have = new Set((state.boot.days ?? []).map((d) => d.id));
  const wanted = MEMBER_PROGRAM.days.filter((d) => !have.has(d.id));
  if (!wanted.length) return;

  // Through the bootstrap helpers rather than by hand: a day is not a plain
  // object, it carries the resolved lift names, positions and per-slot equipment
  // that the plate calculator reads. Building one literally is how a screen ends
  // up showing an exercise id instead of a name.
  let boot = upsertProgramIn(state.boot, {
    id: MEMBER_PROGRAM.id,
    name: MEMBER_PROGRAM.name,
    daysPerWeek: MEMBER_PROGRAM.daysPerWeek,
  });

  for (const day of wanted) {
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
    `<h2 style="margin-top:0">${esc(user.name)} can sign in</h2>
     <div class="tiny muted" style="margin-bottom:12px">
       Send them this code with the link to the app. <b>It is shown only now</b> — only a
       hash of it is kept, so nothing can display it again. If it goes astray, issue a new
       one, which invalidates this one.
     </div>
     <div class="card mono" style="word-break:break-all;font-size:13px;padding:14px">${esc(user.token)}</div>
     <button class="btn btn-block" style="margin-top:12px" data-copy-code="1">Copy the code</button>
     <button class="btn btn-primary btn-block btn-lg" style="margin-top:8px" data-close-code="1">Done</button>`,
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
    `<h2 style="margin-top:0">${esc(title)}</h2>
     <label class="tiny muted">${esc(label)}</label>
     <input class="input" id="text-field" value="${esc(value)}" placeholder="${esc(placeholder)}" style="margin:8px 0 14px" autocomplete="off">
     <button class="btn btn-primary btn-block btn-lg" data-save="1">Save</button>`,
    (e) => {
      if (!e.target.closest('[data-save]')) return;
      const next = sheetPanel.querySelector('#text-field')?.value?.trim() ?? '';
      if (!next) return toast('Type something first');
      closeSheet();
      onSave(next);
    },
  );
  setTimeout(() => sheetPanel.querySelector('#text-field')?.focus(), 60);
}

/**
 * The lift library. Filtering hides rows in place rather than re-rendering,
 * because rebuilding the markup on each keystroke would drop keyboard focus.
 */
function openExerciseLibrary(onPick) {
  const items = (state.boot.exercises ?? []).filter((e) => !e.archived);

  openSheet(
    `<h2 style="margin-top:0">Choose a lift</h2>
     <input class="searchbar" id="ex-q" placeholder="Search…" autocomplete="off">
     <div id="ex-list">
       ${items
         .map(
           (e) => `<button class="picker-item" data-pick="${esc(e.id)}" data-name="${esc(e.name.toLowerCase())}">
             <div class="grow" style="min-width:0">
               <b>${esc(e.name)}</b>
               <div class="tiny muted">${esc(e.muscleGroup ?? '')} · ${esc(getBarType(e.barType).name)}</div>
             </div>
           </button>`,
         )
         .join('')}
     </div>
     <button class="btn btn-block" data-newex="1" style="margin-top:10px">+ Create a new lift</button>`,
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
    `<h2 style="margin-top:0">New lift</h2>
     <label class="tiny muted">Movement</label>
     <input class="input" id="nx-name" placeholder="e.g. Cable Tricep Pushdown" style="margin:8px 0 14px" autocomplete="off">

     <div class="tiny muted" style="margin-bottom:8px">
       On a machine or cable, the unit and the handle change what the same movement takes.
       Put them here rather than in the name, and the two versions stay comparable as one movement.
     </div>
     <div class="meta-grid">
       <input class="input" id="nx-machine" placeholder="Machine (e.g. Eleiko)" autocomplete="off">
       <input class="input" id="nx-handle" placeholder="Handle / grip" autocomplete="off">
     </div>

     <label class="tiny muted">Equipment — this drives the plate calculator</label>
     <select class="input" id="nx-bar" style="margin:8px 0 14px">
       ${BAR_TYPES.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}${b.weight ? ` (${b.weight} lb)` : ''}</option>`).join('')}
     </select>

     <label class="tiny muted">Muscle group</label>
     <select class="input" id="nx-group" style="margin:8px 0 14px">
       <option value="">—</option>
       ${MUSCLE_GROUPS.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}
     </select>

     <label class="tiny muted">A variant of an existing movement? (optional)</label>
     <select class="input" id="nx-variant" style="margin:8px 0 14px">
       <option value="">no — it stands on its own</option>
       ${[...state.boot.exercises]
         .filter((x) => !x.variantOf)
         .sort((a, b) => a.name.localeCompare(b.name))
         .map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}
     </select>

     <label class="tiny muted">Notes — setup that changes the movement</label>
     <input class="input" id="nx-notes" placeholder="e.g. pad under hips for extra range" style="margin:8px 0 12px" autocomplete="off">

     <label class="row" style="gap:10px;margin-bottom:14px">
       <input type="checkbox" id="nx-bw" style="width:22px;height:22px">
       <span class="tiny">Can be done with no added weight (pull-ups, dips)</span>
     </label>

     <button class="btn btn-primary btn-block btn-lg" data-create="1">Create</button>`,
    async (e) => {
      const createBtn = e.target.closest('[data-create]');
      if (!createBtn || createBtn.disabled) return;
      const name = sheetPanel.querySelector('#nx-name')?.value?.trim();
      if (!name) return toast('Name it first');

      const field = (id) => sheetPanel.querySelector(id)?.value?.trim() || null;
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
  setTimeout(() => sheetPanel.querySelector('#nx-name')?.focus(), 60);
}

function openExercisePicker() {
  const a = state.active;
  const rows = a.plan.exercises
    .map((e, i) => {
      const st = a.ex[e.dayExerciseId];
      const done = st.logged.filter(Boolean).length;
      return `<button class="setrow ${i === a.exIndex ? 'current' : done === st.logged.length ? 'done' : ''}"
        style="width:100%" data-jump="${i}">
        <div class="idx">${i + 1}</div>
        <div class="grow" style="text-align:left"><b>${esc(e.name)}</b></div>
        <span class="tiny muted mono">${done}/${st.logged.length}</span>
      </button>`;
    })
    .join('');

  openSheet(`<h2 style="margin-top:0">Jump to exercise</h2>${rows}`, (e) => {
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
  if (e.target.dataset.close) return closeSheet();
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

    case 'ov-pair': return openPairSheet();

    case 'save-today': {
      const root = view.querySelector(`[data-day="${todayISO()}"]`);
      if (root) await saveDay(todayISO(), readDayRow(root));
      return;
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
      // The machines go with it, so say so rather than discovering it after.
      const count = allMachinesAt(gym).length;
      const warning = count
        ? `Delete ${gym.name}? The ${count} machine${count === 1 ? '' : 's'} recorded there go too. Workouts you already logged are untouched.`
        : `Delete ${gym.name}?`;
      if (!confirm(warning)) return;
      await updateBoot({ ...state.boot, gyms: gymsList().filter((g) => g.id !== gym.id) });
      return render();
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

    case 'r-up':
    case 'r-down': {
      const ex = currentExercise();
      const st = a.ex[ex.dayExerciseId];
      const idx = currentSetIndex(st);
      const current = st.repDraft ?? defaultReps(ex, st, idx);
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
      state.route = 'tour';
      return render(true);
    }

    /* ------------------------ the walkthrough ------------------------ */

    case 'tour-next': state.tourStep = Math.min(state.tourStep + 1, TOUR.length - 1); return render(true);
    case 'tour-back': state.tourStep = Math.max(state.tourStep - 1, 0); return render(true);
    case 'tour-done': state.route = 'home'; return render(true);
    case 'tour-open': state.tourStep = 0; state.route = 'tour'; return render(true);

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

      const payload = {
        birthYear: new Date().getFullYear() - Number(d.age),
        sex: d.sex,
        heightInches: numericValue(d.heightInches),
        bodyFatLow: low,
        bodyFatHigh: high,
        averageSteps: numericValue(d.averageSteps),
        goal: d.goal,
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

    case 'edit-day': {
      const day = state.boot.days.find((x) => x.id === t.dataset.id);
      if (!day) return toast('That day is gone');
      state.draft = cloneDay(day);
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
        `<h2 style="margin-top:0">What went wrong?</h2>
         <div class="tiny muted" style="margin-bottom:10px">Rough words are fine. What you did, what happened.</div>
         <textarea class="input" id="bug-text" rows="4" placeholder="e.g. logged a set and the rest timer never started"
           style="min-height:110px;padding:10px;resize:none"></textarea>
         <button class="btn btn-primary btn-block btn-lg" style="margin-top:12px" data-send="1">Save note</button>`,
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
        `<h2 style="margin-top:0">Paste in a workout</h2>
         <div class="tiny muted" style="margin-bottom:10px">
           First line is the date and the day. Then one line per lift: the lift, then weight×reps for each set.
         </div>
         <textarea class="input" id="import-text" rows="9" spellcheck="false" autocapitalize="off"
           style="min-height:190px;padding:10px;font-family:ui-monospace,monospace;font-size:13px;resize:none"
           placeholder="2026-08-12 upper-1&#10;lat-pulldown 200x11 200x8 160x7"></textarea>
         <button class="btn btn-primary btn-block btn-lg" style="margin-top:12px" data-import="1">Import</button>`,
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
      const p = Number(t.dataset.p);
      const set = new Set(state.settings.availablePlates);
      set.has(p) ? set.delete(p) : set.add(p);
      if (!set.size) return toast('Keep at least one plate');
      state.settings.availablePlates = [...set].sort((x, y) => y - x);
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
    await saveSettings();
    toast('Saved');
    return render();
  }

  if (['height', 'age'].includes(e.target.dataset.act)) {
    const key = e.target.dataset.act === 'height' ? 'heightInches' : 'age';
    const value = numericValue(e.target.value);
    state.settings[key] = value !== null && value > 0 ? Math.round(value) : null;
    await saveSettings();
    toast('Saved');
    return render();
  }

  if (e.target.dataset.act === 'maintenance') {
    // Blank stays blank. A zero here would be read as a real number and make
    // every intake look like a 100% deficit.
    const value = numericValue(e.target.value);
    state.settings.maintenanceCalories = value !== null && value > 0 ? Math.round(value) : null;
    await saveSettings();
    toast('Saved');
    return render();
  }

  if (e.target.dataset.act === 'goal') {
    state.settings.goal = e.target.value;
    await saveSettings();
    toast('Saved');
    return render();
  }

  if (e.target.dataset.act === 'rest-default') {
    state.settings.defaultRestSeconds = Math.max(0, Number(e.target.value) || 180);
    await saveSettings();
    toast('Saved');
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
      <div style="margin-bottom:10px">The app hit an error while starting. That is a bug — the text below says where.</div>
      <div class="tiny mono" style="color:var(--bad);word-break:break-all">${esc(message)}<br>${esc(detail)}</div>
    </div>
    <button class="btn btn-primary btn-block btn-lg" data-act="hard-reload">Reload</button>
    <button class="btn btn-block btn-ghost btn-sm" style="margin-top:10px" data-act="drop-active">
      Discard the unfinished workout and reload
    </button>
    <div class="tiny muted" style="text-align:center;margin-top:8px">
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
    fetchAccount().then(() => render());
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
