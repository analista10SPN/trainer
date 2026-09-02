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
  buildLocalBootstrap, mergeSeed, upsertDayIn, removeDayFrom, upsertExerciseIn, upsertProgramIn,
} from './lib/bootstrap.js';
import { smallestStep, suggestNextTopWeight } from './lib/progression.js';
import { analyzeAll } from './lib/analysis.js';
import { bestE1RM, totalVolume, percentSlope, numeric as numericValue } from './lib/strength.js';
import { summaryCacheKey } from './lib/summary.js';
import { parseQuickLog } from './lib/quicklog.js';
import { recoveryReport } from './lib/recovery.js';
import {
  sessionsByDay, monthGrid, liftsInSession, shiftMonth, latestMonth,
  MONTH_NAMES, WEEKDAY_INITIALS,
} from './lib/calendar.js';
import {
  makeGym, recordFix, nearestGym, allMachinesAt, rememberMachine, predictMachine, tracksMachine,
  machineChanged,
} from './lib/gyms.js';
import { migrateActiveSession, removeSetAt, addSetTo } from './lib/session.js';
import {
  fullName, qualifier, normaliseMuscleGroup, MUSCLE_GROUPS,
  familiesOf, allowsZeroLoad, describeLoad,
} from './lib/exercises.js';
import { runCleanup } from './lib/cleanup.js';
import { overallProgress, analyzeFamily, volumeOverTime } from './lib/progress.js';
import { QUESTIONS, SCALE, isAnswered, describeCheckin, checkinEffect } from './lib/checkin.js';
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
  settings: { availablePlates: DEFAULT_PLATES, defaultRestSeconds: 180, serverUrl: '', authToken: '' },
};

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

/**
 * Everything is addressed relative to wherever the app is served from, so the
 * same build runs at the root of a local server and under a subdirectory on a
 * static host.
 */
/** Shown on the Setup screen so a stale phone can be identified from a distance. */
const BUILD = 'v23';

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
  const [boot, sessions, notes, active, settings, lastSync, programHash, metrics, summary] = await Promise.all([
    db.getMeta('boot'),
    db.allSessions(),
    db.allNotes(),
    db.getMeta('active'),
    db.getMeta('settings'),
    db.getMeta('lastSync'),
    db.getMeta('programHash'),
    db.getMeta('metrics'),
    db.getMeta('summary'),
  ]);
  state.syncedProgramHash = programHash ?? null;
  state.metrics = metrics ?? [];
  // The last summary survives a relaunch, so the card is not blank every time
  // the app is opened away from signal.
  state.summary = summary ?? null;
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
      // where the phone knows about something the cloud does not.
      const mine = new Map(state.sessions.map((s) => [s.id, s]));
      for (const s of incoming) {
        const local = mine.get(s.id);
        if (local?.checkin && !s.checkin) s.checkin = local.checkin;
      }

      const known = new Set(state.sessions.map((s) => s.id));
      changed = incoming.some((s) => !known.has(s.id)) || incoming.length !== state.sessions.length;

      const merged = new Map(state.sessions.map((s) => [s.id, s]));
      for (const s of incoming) merged.set(s.id, s);
      state.sessions = [...merged.values()];
      await db.putSessions(incoming);

      // Health metrics only ever come down: they are written by a Shortcut
      // straight to the cloud, never by this app.
      if (Array.isArray(remote.metrics)) {
        if (remote.metrics.length !== state.metrics.length) changed = true;
        state.metrics = remote.metrics;
        await db.setMeta('metrics', remote.metrics);
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
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };

    // A hard cap of our own: some browsers never call either callback when the
    // permission prompt is dismissed rather than answered.
    setTimeout(() => done(null), timeout + 500);

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
async function setMachine(ex, machine, onPick) {
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
  if (gym) await saveGym(rememberMachine(gym, ex.exerciseId, machine));

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
  if (document.getElementById('sheet')?.classList.contains('open')) return;

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
    setMachine(ex, predicted);
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

  go('home');
  toast(`Logged ${a.sets.length} sets`);
  sync({ quiet: true });
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

function render() {
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

  const html = {
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
  }[state.route] ?? viewHome;

  view.innerHTML = html();
  if (state.route === 'session') { startTicking(); maybeAskMachine(); }
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
      return `<div class="setrow ${cls}">
        <div class="idx">${done ? '✓' : i + 1}</div>
        <div class="grow">
          <div class="row-between"><span class="tiny muted">${esc(slot.note || 'Working set')}</span>${right}</div>
        </div>
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
function machineNote(exerciseId) {
  const change = machineChanged(state.sessions, exerciseId);
  if (!change.changed) return '';

  return `<div class="tiny" style="margin-top:8px;color:var(--warn)">
    Different machine last time: ${esc(change.from)} → ${esc(change.to)}.
    The loads are not directly comparable, so read this verdict with that in mind.
  </div>`;
}

function viewCoach() {
  const items = loggedExerciseList().map((e) => ({ name: e.name, exerciseId: e.exerciseId, history: e.history }));
  const findings = analyzeAll(items);
  const overall = renderOverall(items);
  const movements = renderMovements();
  const recovery = renderRecovery(findings);
  const feel = renderCheckinEffect();

  if (!findings.length) {
    return `<h1>Coach</h1>
      ${renderSummary()}
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
      </div>`,
    )
    .join('');

  return `<h1>Coach</h1>
    <p class="sub">Trend analysis over your logged working sets. Worst news first.</p>
    ${renderSummary()}
    ${overall}${movements}${recovery}${feel}
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
  const recent = state.sessions.slice(-14);

  const avg = (values) => {
    const nums = values.map(numericValue).filter((v) => v !== null);
    return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null;
  };

  const checkins = recent.map((s) => s.checkin).filter(Boolean);
  const checkin = {};
  for (const q of QUESTIONS) {
    const value = avg(checkins.map((c) => c[q.id]));
    if (value !== null) checkin[q.id] = value;
  }

  return {
    overall: overall
      ? { status: overall.status, rate: overall.percentPerSession, message: overall.message }
      : null,
    lifts: findings.slice(0, 12).map((f) => ({
      name: f.name,
      status: f.status,
      percentPerSession: f.percentPerSession,
      flags: f.flags,
      muscleGroup: byId.get(f.exerciseId)?.muscleGroup ?? null,
      machine: machineChanged(state.sessions, f.exerciseId).to ?? null,
    })),
    recovery: {
      sleepAvg: avg(state.metrics.filter((m) => m.name === 'sleepHours').slice(-14).map((m) => m.value)),
      stepsAvg: avg(state.metrics.filter((m) => m.name === 'steps').slice(-14).map((m) => m.value)),
    },
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
      <div class="row" style="gap:10px">
        <div class="spinner"></div>
        <span class="tiny muted">Reading your trends…</span>
      </div>
    </div>`;
  }

  if (s.error) {
    return `<div class="card">
      <div class="row-between">
        <span class="tiny muted"><b>What this all means</b></span>
        <button class="btn btn-sm" data-act="summary-go">Try again</button>
      </div>
      <div class="tiny" style="margin-top:8px;color:var(--warn)">${esc(s.error)}</div>
    </div>`;
  }

  const stale = s.key !== summaryCacheKey(summaryFindings());

  return `<div class="card">
    <div class="row-between" style="margin-bottom:8px">
      <span class="tiny muted"><b>What this all means</b></span>
      <button class="btn btn-sm" data-act="summary-go">${stale ? 'Refresh' : 'Rewrite'}</button>
    </div>
    <div style="font-size:14.5px">${esc(s.text)}</div>
    <div class="tiny muted" style="margin-top:8px">
      Written by Claude from the verdicts below${stale ? ' — you have logged a workout since' : ''}.
      The numbers are computed on this phone; only this paragraph needs signal.
    </div>
  </div>`;
}

/** Ask the Worker for a summary. The Worker holds the key; this never sees it. */
async function requestSummary() {
  const findings = summaryFindings();
  const key = summaryCacheKey(findings);

  state.summary = { loading: true, key };
  render();

  try {
    // postJSON throws with the server's own message on a non-2xx, which is
    // already written to be shown to him — "out of credit", "key rejected".
    const body = await postJSON('/api/summary', { findings });
    const text = String(body?.summary ?? '').trim();

    state.summary = text
      ? { text, key }
      : { error: 'The summary came back empty.', key };

    if (text) await db.setMeta('summary', state.summary);
  } catch (err) {
    state.summary = {
      error: err?.message ?? 'Could not reach the summary service.',
      key,
    };
  }

  render();
}

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

function viewSetup() {
  const pending = dirtySessions().length;
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

    <h2>Sync</h2>
    <div class="card">
      <div class="tiny muted" style="margin-bottom:12px">
        Optional. Everything already works without it — this only copies your logs
        to a PC running the server, as a second place they exist.
      </div>

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

async function postJSON(path, payload) {
  const res = await fetch(api(path), {
    method: 'POST',
    // The token was missing here, so every authed POST — the program mirror
    // included — was silently 401ing against a Worker that has one set.
    headers: { 'content-type': 'application/json', ...authHeader() },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

/* ================================ sheets ================================ */

let sheetState = null;

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

          const next = {
            ...draft,
            name,
            machine: field('#ed-machine'),
            handle: field('#ed-handle'),
            notes: field('#ed-notes') ?? '',
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

    case 'summary-go': return requestSummary();

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

    case 'lib-edit': {
      const lift = state.boot.exercises.find((x) => x.id === t.dataset.id);
      if (lift) openExerciseEditor(lift);
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

view.addEventListener('input', (e) => {
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

view.addEventListener('change', async (e) => {
  if (applyFieldEdit(e.target)) return;

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

  checkServer().then((reachable) => {
    if (reachable) sync({ quiet: true });
    else renderStatus();
  });
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
