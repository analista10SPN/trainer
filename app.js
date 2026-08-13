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
  buildLocalBootstrap, upsertDayIn, removeDayFrom, upsertExerciseIn, upsertProgramIn,
} from './lib/bootstrap.js';
import { smallestStep, suggestNextTopWeight } from './lib/progression.js';
import { analyzeAll } from './lib/analysis.js';
import { bestE1RM, totalVolume } from './lib/strength.js';
import { parseQuickLog } from './lib/quicklog.js';
import { migrateActiveSession } from './lib/session.js';
import * as db from './db.js';

/* ================================ state ================================= */

const state = {
  boot: null,
  sessions: [],
  notes: [],
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
  draft: null,
  draftDirty: false,
  settings: { availablePlates: DEFAULT_PLATES, defaultRestSeconds: 180 },
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
const BASE = new URL('.', document.baseURI).href;
const api = (path) => new URL(String(path).replace(/^\//, ''), BASE).href;

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
  const [boot, sessions, notes, active, settings, lastSync] = await Promise.all([
    db.getMeta('boot'),
    db.allSessions(),
    db.allNotes(),
    db.getMeta('active'),
    db.getMeta('settings'),
    db.getMeta('lastSync'),
  ]);
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

const dirtySessions = () => state.sessions.filter((s) => s._dirty);
const dirtyNotes = () => state.notes.filter((n) => n._dirty);

async function sync({ quiet = false } = {}) {
  if (state.syncing) return;
  state.syncing = true;
  renderStatus();

  try {
    const pending = dirtySessions();
    const pendingNotes = dirtyNotes();

    if (pending.length || pendingNotes.length) {
      const res = await fetch(api('/api/sync'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessions: pending.map(stripLocal),
          notes: pendingNotes.map(({ _dirty, ...n }) => n),
        }),
      });
      if (!res.ok) throw new Error(`sync ${res.status}`);

      for (const s of pending) s._dirty = false;
      for (const n of pendingNotes) n._dirty = false;
      await db.putSessions(pending);
      await db.putNotes(pendingNotes);
    }

    const listRes = await fetch(api('/api/sessions?limit=500'), { cache: 'no-store' });
    if (listRes.ok) {
      const { sessions } = await listRes.json();
      const localDirty = new Set(dirtySessions().map((s) => s.id));
      const incoming = sessions.filter((s) => !localDirty.has(s.id)).map((s) => ({ ...s, _dirty: false }));
      const merged = new Map(state.sessions.map((s) => [s.id, s]));
      for (const s of incoming) merged.set(s.id, s);
      state.sessions = [...merged.values()];
      await db.putSessions(incoming);
    }

    // Deliberately no bootstrap pull here: the phone is authoritative for the
    // program, and re-reading the PC's copy would undo edits made offline.
    state.lastSync = nowISO();
    await db.setMeta('lastSync', state.lastSync);
    state.online = true;
    if (!quiet) toast('Synced');
  } catch {
    state.online = false;
    if (!quiet) toast('Server unreachable — saved on phone');
  } finally {
    state.syncing = false;
    renderStatus();
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

async function startSession(dayId) {
  const plan = planFor(dayId);
  if (!plan) return toast('That day template is missing');

  const ex = {};
  for (const e of plan.exercises) ex[e.dayExerciseId] = freshExerciseState(e);

  state.active = {
    id: uid(),
    dayId,
    dayName: plan.dayName,
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
  const suggestion = suggestNextTopWeight({ scheme, lastSession, equipment });
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
  if (weight == null || weight <= 0) return toast('Set a weight first');

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
    loggedAt: nowISO(),
  });

  st.logged[idx] = { weight, reps };
  st.repDraft = null;
  a.restEndsAt = Date.now() + (ex.restSeconds ?? 180) * 1000;
  a._dirty = true;

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
      (state.route === 'edit-day' && r === 'edit');
    btn.classList.toggle('on', active);
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
    setup: viewSetup,
  }[state.route] ?? viewHome;

  view.innerHTML = html();
  if (state.route === 'session') startTicking();
  else stopTicking();
}

function renderStatus() {
  const pending = dirtySessions().length + (state.active ? 1 : 0);
  if (state.syncing) {
    statusBar.hidden = false;
    statusBar.className = 'status-bar syncing';
    statusBar.textContent = 'Syncing…';
  } else if (!state.online) {
    statusBar.hidden = false;
    statusBar.className = 'status-bar';
    statusBar.textContent = pending
      ? `Offline · ${pending} workout${pending === 1 ? '' : 's'} waiting to sync`
      : 'Offline · logging locally';
  } else if (state.offlineReady === false) {
    statusBar.hidden = false;
    statusBar.className = 'status-bar';
    statusBar.textContent = 'No offline mode — needs HTTPS. See Setup.';
  } else {
    statusBar.hidden = true;
  }
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

function viewSession() {
  const a = state.active;
  if (!a) return viewHome();

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
      const right = done
        ? `<b class="mono">${fmtWeight(done.weight)} × ${done.reps}</b>`
        : `<span class="muted mono">${fmtWeight(weight)} lb · ${slot.repMin}–${slot.repMax}</span>`;
      return `<div class="setrow ${cls}">
        <div class="idx">${done ? '✓' : i + 1}</div>
        <div class="grow">
          <div class="row-between"><span class="tiny muted">${esc(slot.note || 'Working set')}</span>${right}</div>
        </div>
      </div>`;
    })
    .join('');

  const lastLine = ex.lastSets?.length
    ? ex.lastSets.map((s) => `${fmtWeight(s.weight)}×${s.reps}`).join('  ·  ')
    : 'first time on this lift';

  const body = complete
    ? `<button class="btn btn-block" style="margin-bottom:8px" data-act="add-set">+ One more set</button>
       <button class="btn btn-primary btn-block btn-lg" data-act="next-ex">
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
      <button class="btn btn-sm btn-ghost" data-act="home">‹ Back</button>
      <span class="pill">${a.sets.length} sets logged</span>
      <button class="btn btn-sm btn-ghost" data-act="finish">Finish</button>
    </div>

    <h1 style="margin-top:10px">${esc(ex.name)}</h1>
    <p class="sub">
      ${esc(a.dayName)} · exercise ${a.exIndex + 1} of ${total}<br>
      <span class="tiny">${esc(describeScheme(ex.scheme))}</span>
    </p>

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
          <b>${fmtWeight(weight)}</b>
          <small>lb · ${esc(plateSummary(weight, ex.equipment)) || 'tap to edit'}</small>
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

function viewHistory() {
  const sessions = [...state.sessions].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));

  if (!sessions.length) {
    return `<h1>History</h1><div class="empty">Nothing logged yet.<br>Finish a workout and it shows up here.</div>`;
  }

  const exercises = loggedExerciseList()
    .map((e) => ({ ...e, series: e.history.map((s) => bestE1RM(s.sets)) }))
    .sort((a, b) => b.history.length - a.history.length);

  const lifts = exercises
    .map(
      (e) => `<button class="card card-tap" data-act="exercise" data-id="${esc(e.exerciseId)}">
        <div class="row-between">
          <b>${esc(e.name)}</b>
          <span class="tiny muted mono">${e.history.length} sessions</span>
        </div>
        ${sparkline(e.series)}
      </button>`,
    )
    .join('');

  const list = sessions
    .slice(0, 25)
    .map((s) => {
      const vol = Math.round(totalVolume(s.sets ?? []));
      return `<div class="card">
        <div class="row-between">
          <div>
            <b>${esc(s.dayName ?? 'Workout')}</b>
            <div class="tiny muted">${fmtDate(s.startedAt)} · ${(s.sets ?? []).length} sets · ${vol.toLocaleString()} lb volume</div>
          </div>
          ${s._dirty ? '<span class="pill pill-warn">not synced</span>' : ''}
        </div>
      </div>`;
    })
    .join('');

  return `<h1>History</h1>
    <h2>Lifts</h2>${lifts}
    <h2>Sessions</h2>${list}`;
}

function viewExerciseDetail() {
  const id = state.detailExercise;
  const name = state.boot.exercises.find((e) => e.id === id)?.name ?? id;
  const history = historyFor(id);
  const series = history.map((s) => bestE1RM(s.sets));

  const rows = [...history]
    .reverse()
    .map(
      (s) => `<div class="card">
        <div class="row-between" style="margin-bottom:6px">
          <b>${fmtDate(s.date)}</b>
          <span class="pill">e1RM ${Math.round(bestE1RM(s.sets))}</span>
        </div>
        <div class="tiny mono">${s.sets.map((x) => `${fmtWeight(x.weight)}×${x.reps}`).join('   ·   ')}</div>
      </div>`,
    )
    .join('');

  return `<button class="btn btn-sm btn-ghost" data-act="history">‹ History</button>
    <h1 style="margin-top:8px">${esc(name)}</h1>
    <p class="sub">${history.length} sessions · best e1RM ${Math.round(Math.max(0, ...series))} lb</p>
    <div class="card">${sparkline(series)}<div class="tiny muted" style="margin-top:6px">Estimated 1RM over time</div></div>
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

function viewCoach() {
  const findings = analyzeAll(loggedExerciseList().map((e) => ({ name: e.name, exerciseId: e.exerciseId, history: e.history })));

  if (!findings.length) {
    return `<h1>Coach</h1>
      <div class="empty">Log three sessions of a lift and the trend analysis starts here.<br><br>
      It watches estimated 1RM per lift and calls out regression, stalls, and jumps too big to be real strength.</div>`;
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
      </div>`,
    )
    .join('');

  return `<h1>Coach</h1>
    <p class="sub">Trend analysis over your logged working sets. Worst news first.</p>
    ${cards}
    <div class="card">
      <div class="tiny muted">These are numbers, not a camera. No lifting log can see your form — a jump flag or a
      rep collapse is a hint to check technique, not a diagnosis.</div>
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
      <div class="row-between" style="margin-bottom:10px">
        <span class="tiny muted">Server</span>
        <span class="pill ${state.online ? 'pill-good' : 'pill-warn'}">${state.online ? 'reachable' : 'offline'}</span>
      </div>
      <div class="row-between" style="margin-bottom:10px">
        <span class="tiny muted">Waiting to upload</span>
        <span class="tiny mono">${pending} session${pending === 1 ? '' : 's'}</span>
      </div>
      <div class="row-between" style="margin-bottom:12px">
        <span class="tiny muted">Last sync</span>
        <span class="tiny mono">${state.lastSync ? esc(daysAgo(state.lastSync)) : 'never'}</span>
      </div>
      <button class="btn btn-block" data-act="sync">Sync now</button>
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
      <button class="btn btn-block btn-ghost" data-act="reload-boot">Refresh program from server</button>
    </div>

    <div class="tiny muted" style="text-align:center;margin-top:20px">
      ${(state.sessions ?? []).length} sessions on this phone
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
    <button class="btn btn-block" style="margin-top:24px" data-act="new-program">+ New program</button>`;
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
    headers: { 'content-type': 'application/json' },
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
  const items = state.boot.exercises ?? [];

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
     <label class="tiny muted">Name</label>
     <input class="input" id="nx-name" placeholder="e.g. Pendlay Row" style="margin:8px 0 14px" autocomplete="off">
     <label class="tiny muted">Equipment — this drives the plate calculator</label>
     <select class="input" id="nx-bar" style="margin:8px 0 14px">
       ${BAR_TYPES.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}${b.weight ? ` (${b.weight} lb)` : ''}</option>`).join('')}
     </select>
     <label class="tiny muted">Muscle group (optional)</label>
     <input class="input" id="nx-group" placeholder="e.g. back" style="margin:8px 0 14px" autocomplete="off">
     <button class="btn btn-primary btn-block btn-lg" data-create="1">Create</button>`,
    async (e) => {
      const createBtn = e.target.closest('[data-create]');
      if (!createBtn || createBtn.disabled) return;
      const name = sheetPanel.querySelector('#nx-name')?.value?.trim();
      if (!name) return toast('Name it first');

      const payload = {
        id: `${slug(name)}-${uid().slice(0, 4)}`,
        name,
        barType: sheetPanel.querySelector('#nx-bar')?.value ?? 'olympic',
        muscleGroup: sheetPanel.querySelector('#nx-group')?.value?.trim() || null,
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
    case 'start': return startSession(t.dataset.id);
    case 'exercise': return go('exercise', t.dataset.id);

    case 'log-set': return logCurrentSet();
    case 'undo': return undoLastSet();
    case 'add-set': return addSet();

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

          closeSheet();
          render();
          toast(
            `Imported ${record.sets.length} sets${errors.length ? ` · ${errors.length} line(s) skipped` : ''}`,
            errors.length ? 5000 : 2200,
          );
          sync({ quiet: true });
        },
      );

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

view.addEventListener('change', async (e) => {
  if (applyFieldEdit(e.target)) return;

  if (e.target.dataset.act === 'rest-default') {
    state.settings.defaultRestSeconds = Math.max(0, Number(e.target.value) || 180);
    await saveSettings();
    toast('Saved');
  }
});

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
  }

  if (state.active) state.route = 'session';
  render();

  // From here a server is optional: it is a backup target, not a dependency.
  try {
    const res = await fetch(api('/api/health'), { cache: 'no-store' });
    state.online = res.ok;
  } catch {
    state.online = false;
  }

  await registerOffline();
  render();

  if (state.online) sync({ quiet: true });
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

    await navigator.serviceWorker.register(api('/sw.js'), { scope: BASE });
    state.offlineReady = true;
    state.offlineReason = '';
  } catch (err) {
    state.offlineReady = false;
    state.offlineReason = `Offline caching failed to install: ${err?.message ?? err}`;
  }
}

boot().catch((err) => showFatal(err?.message ?? String(err), 'boot'));
