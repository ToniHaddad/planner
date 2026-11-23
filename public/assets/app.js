/* Planner board: brain dump, today's 3, timebox. No dependencies. */
'use strict';

const H = 52, SNAP = 15, DURS = [15, 30, 45, 60, 90, 120, 180];
const PALETTE = ['#3ca9e1', '#5dbe53', '#fc981e', '#b1a4d9', '#ee483c', '#f6bf1a'];
const csrf = document.querySelector('meta[name=csrf]').content;
const $ = id => document.getElementById(id);

let S = { boards: [], board: 0, projects: [], tasks: [], events: [], settings: { dayStart: 7, dayEnd: 20 }, calendarConnected: false, user: '', local: false };
let CAL = { connected: false, events: [], allDay: [], loading: false };
let DAY = dayStr(new Date());
let BOARD = 0;         // the board being shown; 0 until the server says which exist (the choice is kept per device)
let PAGE = 'day';      // 'day' or 'calendar', kept per device like the board
let VIEW = 'month';    // what the Calendar page shows: a 'month' or a 'week'
try {
  BOARD = +localStorage.getItem('planner_board') || 0;
  PAGE = localStorage.getItem('planner_page') === 'calendar' ? 'calendar' : 'day';
  VIEW = localStorage.getItem('planner_view') === 'week' ? 'week' : 'month';
} catch (e) { /* private window */ }
let CDAY = DAY;        // a day inside the month or week that the Calendar page shows
let CP = { from: '', to: '', board: 0, events: [], tasks: [], google: null, loading: false };   // the Calendar page's days
let UPCOMING = [];     // the board's next events, for "Coming up"
let drag = null;       // { id, off } while a task is being dragged
let subDrag = null;    // { id, i } while a subtask is being dragged to a new place in its list
let evDrag = null;     // { id, off } while an event is being dragged to another day (off: which of its days was grabbed)
let editing = false;   // true while a title is being renamed (pauses re-rendering)
let EV = null;         // the event open in the event dialog: { id, subs }; id is null for a new one
let GE = null;         // the Google event open in its dialog: { day, key }
// sending the plan to Google: one run at a time; `again` asks for one more when changes came in meanwhile
const SYNC = { running: false, again: false, timer: 0, error: '' };
const open = new Set(); // ids of the tasks whose subtasks and notes are showing

// ---------- helpers ----------
const REPEATS = [['', 'Never'], ['daily', 'Every day'], ['weekdays', 'Weekdays (Mon–Fri)'], ['weekly', 'Every week'], ['monthly', 'Every month']];
const REMINDS = [[null, 'No reminder'], [5, '5 minutes before'], [10, '10 minutes before'], [15, '15 minutes before'],
  [30, '30 minutes before'], [60, '1 hour before'], [1440, '1 day before']];
// an all-day event: minutes before its first day begins
const ALLDAY_REMINDS = [[null, 'No reminder'], [900, 'The day before at 09:00'], [360, 'The day before at 18:00'],
  [2340, 'Two days before at 09:00'], [9540, 'A week before at 09:00']];
const options = (list, value) => list.map(([v, label]) => `<option value="${v === null ? '' : v}"${v === value ? ' selected' : ''}>${label}</option>`).join('');
const choiceName = (list, value) => (list.find(c => c[0] === value) || [null, ''])[1];
function dayStr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function dayDate(s) { const p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function shiftDay(s, n) { const d = dayDate(s); d.setDate(d.getDate() + n); return dayStr(d); }
const daysBetween = (a, b) => Math.round((dayDate(b) - dayDate(a)) / 86400000);
const mondayOf = s => shiftDay(s, -((dayDate(s).getDay() + 6) % 7));
const narrow = () => matchMedia('(max-width: 1000px)').matches;
const hm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const durTxt = m => m < 60 ? m + ' m' : (m % 60 ? Math.floor(m / 60) + ' h ' + m % 60 : m / 60 + ' h');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeColor = c => /^#[0-9a-f]{6}$/i.test(c || '') ? c : '#8f8ab8';
const proj = id => S.projects.find(p => p.id === id) || { id: null, name: 'No project', color: '#8f8ab8' };
const task = id => S.tasks.find(t => t.id === id);
// the same event can sit in three lists at once (the day, the calendar's days, coming up)
const findEvent = id => S.events.concat(CP.events, UPCOMING).find(e => e.id === id);
function setEventLocal(id, patch) { [S.events, CP.events, UPCOMING].forEach(list => list.forEach(e => { if (e.id === id) Object.assign(e, patch); })); }
function removeEventLocal(id) {
  S.events = S.events.filter(e => e.id !== id);
  CP.events = CP.events.filter(e => e.id !== id);
  UPCOMING = UPCOMING.filter(e => e.id !== id);
}
const startMin = () => S.settings.dayStart * 60;
const endMin = () => S.settings.dayEnd * 60;
function ink(hex) {
  const m = /^#(..)(..)(..)$/.exec(hex);
  if (!m) return '#1b1c1e';
  const l = (.299 * parseInt(m[1], 16) + .587 * parseInt(m[2], 16) + .114 * parseInt(m[3], 16)) / 255;
  return l > .55 ? '#1b1c1e' : '#fff';
}
/** Shows a short message; `action` ({ label, run }) adds a button to it, such as Undo. */
function toast(msg, action) {
  const t = $('toast'), b = $('toast-act');
  $('toast-msg').textContent = msg;
  b.hidden = !action;
  b.textContent = action ? action.label : '';
  b.onclick = action ? () => { t.classList.remove('on'); action.run(); } : null;
  t.classList.add('on');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), action ? 6000 : 3600);
}

async function api(action, body, params) {
  const qs = new URLSearchParams(Object.assign({ action: action }, params || {}));
  const opt = { credentials: 'same-origin', headers: { 'X-CSRF': csrf } };
  if (body !== undefined && body !== null) {
    opt.method = 'POST';
    opt.keepalive = true;             // lets a save finish even if the tab is closed right after
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let res;
  try { res = await fetch('api.php?' + qs, opt); }
  catch (e) { throw new Error('No connection. Your change was not saved.'); }
  if (res.status === 401) { location.reload(); throw new Error('Signed out'); }
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok || !data) throw new Error((data && data.error) || 'The server did not answer properly (' + res.status + ').');
  return data;
}

/** A change failed to save: say so and reload the truth from the server. */
function saveFailed(err) { toast(err.message); loadState(); }

// ---------- loading ----------
/** Moves unfinished tasks from earlier days back to the brain dump, then loads the board. */
async function startDay() {
  try { await api('rollover', { today: dayStr(new Date()) }); } catch (err) { /* the board still loads */ }
  await loadState();
  if (PAGE === 'calendar') { loadMonth(false); loadUpcoming(); } else loadCalendar(false);
  // Google is brought up to date when the planner opens, unless that happened in the last half hour
  const sy = S.sync || {};
  if (S.calendarConnected && sy.auto && (!sy.last || Date.now() - sy.last.at * 1000 > 30 * 60000)) runSync(false);
}

async function loadState() {
  try {
    const d = await api('state', null, { day: DAY, board: BOARD });
    S = d;
    BOARD = d.board;
    render();
  } catch (err) { toast(err.message); }
}

async function loadCalendar(refresh) {
  const day = DAY;
  if (!S.calendarConnected) { CAL = { connected: false, events: [], allDay: [], loading: false }; render(); return; }
  CAL.loading = true; renderCalStatus();
  try {
    const d = await api('calendar', null, { day: day, refresh: refresh ? '1' : '0' });
    if (day !== DAY) return;            // the user moved to another day meanwhile
    CAL = Object.assign({ events: [], allDay: [], loading: false }, d);
  } catch (err) {
    if (day !== DAY) return;
    CAL = { connected: true, events: [], allDay: [], loading: false, error: err.message };
  }
  render();
}

function goBoard(id) {
  if (id === BOARD) return;
  BOARD = id;
  try { localStorage.setItem('planner_board', String(id)); } catch (e) { /* private window */ }
  S.board = id; S.tasks = []; S.projects = []; S.events = [];
  CP = { from: '', to: '', board: 0, events: [], tasks: [], google: CP.google, loading: false };
  UPCOMING = [];
  open.clear();
  render();
  loadState();
  if (PAGE === 'calendar') { loadMonth(false); loadUpcoming(); }
}

function goDay(day) {
  DAY = day;
  CAL = { connected: S.calendarConnected, events: [], allDay: [], loading: S.calendarConnected };
  S.tasks = S.tasks.filter(t => t.where === 'dump');
  S.events = [];
  render();
  loadState().then(() => loadCalendar(false));
}

/** Shows the Day page or the Calendar page; both stay in the page, one of them hidden. */
function showPage() {
  $('cal').hidden = PAGE !== 'calendar';
  document.querySelector('.cols').hidden = PAGE !== 'day';
  document.querySelectorAll('#pages [data-page]').forEach(b => { b.classList.toggle('on', b.dataset.page === PAGE); b.setAttribute('aria-pressed', b.dataset.page === PAGE); });
}

function goPage(p) {
  if (p === PAGE || (p !== 'day' && p !== 'calendar')) return;
  PAGE = p;
  try { localStorage.setItem('planner_page', p); } catch (e) { /* private window */ }
  showPage();
  if (p === 'calendar') CDAY = DAY;
  render();
  // events may have changed on the other page
  if (p === 'calendar') { loadMonth(false); loadUpcoming(); } else loadState().then(() => loadCalendar(false));
}

/** The days the Calendar page shows: whole weeks, Monday to Sunday. */
function calRange() {
  if (VIEW === 'week') { const m = mondayOf(CDAY); return { from: m, to: shiftDay(m, 6) }; }
  const d = dayDate(CDAY);
  return { from: mondayOf(dayStr(new Date(d.getFullYear(), d.getMonth(), 1))),
           to: shiftDay(mondayOf(dayStr(new Date(d.getFullYear(), d.getMonth() + 1, 0))), 6) };
}

/** Events, planned tasks and Google events of the days in view, in one request. */
async function loadMonth(refresh) {
  const r = calRange(), board = BOARD;
  const current = () => CP.from === r.from && CP.to === r.to && CP.board === board;
  if (!current()) CP = { from: r.from, to: r.to, board: board, events: [], tasks: [], google: CP.google, loading: false };
  CP.loading = true;
  renderCalendar(); renderCalStatus();
  try {
    const d = await api('month', null, { board: board, from: r.from, to: r.to, refresh: refresh ? '1' : '0' });
    if (!current()) return;            // the user moved to another month, week or board meanwhile
    Object.assign(CP, d, { loading: false });
  } catch (err) {
    if (!current()) return;
    CP.loading = false;
    toast(err.message);
  }
  if (PAGE === 'calendar') { renderCalendar(); renderCalStatus(); }
}

/** The board's events from today on, for the "Coming up" column. */
async function loadUpcoming() {
  const today = dayStr(new Date()), board = BOARD;
  try {
    const d = await api('events', null, { board: board, from: today, to: shiftDay(today, 60) });
    if (board !== BOARD) return;
    UPCOMING = d.events;
  } catch (err) { toast(err.message); }
  if (PAGE === 'calendar') renderUpcoming();
}

/** After an event changed: fetch the lists it can be in again. */
function refreshEvents() {
  loadState();
  if (PAGE === 'calendar') { loadMonth(false); loadUpcoming(); }
}

function calMove(n) {
  if (VIEW === 'week') CDAY = shiftDay(CDAY, 7 * n);
  else { const d = dayDate(CDAY); CDAY = dayStr(new Date(d.getFullYear(), d.getMonth() + n, 1)); }
  render();
  loadMonth(false);
}

function setView(v) {
  VIEW = v === 'week' ? 'week' : 'month';
  try { localStorage.setItem('planner_view', VIEW); } catch (e) { /* private window */ }
  render();
  loadMonth(false);
}

// ---------- planning rules ----------
/**
 * Google's timed events of the day, clipped to the day hours and ready to sit on the timeline
 * beside the tasks (lanes() takes both). Hidden ones are left out.
 */
function gBlocks() {
  return CAL.events.filter(e => !e.hidden)
    .map(e => ({ id: 'g:' + e.key, g: true, ev: e, start: Math.max(e.start, startMin()), end: Math.min(e.end, endMin()) }))
    .filter(b => b.end > b.start).map(b => Object.assign(b, { dur: b.end - b.start }));
}
const dayTasks = () => S.tasks.filter(t => t.day === DAY);
const scheduled = () => dayTasks().filter(t => t.start !== null);

/** Why a block cannot go there, or '' when it can. Calendar events do not stop a task: it sits beside them. */
function conflict(s, d) {
  if (s < startMin() || s + d > endMin()) return 'Outside your day hours';
  return '';
}

/**
 * Tasks and calendar events may share a time. Those that do sit side by side: returns, for each
 * id, its column and how many columns its group of overlapping blocks needs. At the same start a
 * calendar event comes first.
 */
function lanes(list) {
  const out = new Map();
  let group = [], ends = [], groupEnd = -1;
  const close = () => { group.forEach(t => { out.get(t.id).cols = ends.length; }); group = []; ends = []; };
  const order = (a, b) => a.start - b.start || (b.g ? 1 : 0) - (a.g ? 1 : 0) || (a.g ? (a.id < b.id ? -1 : 1) : a.id - b.id);
  list.slice().sort(order).forEach(t => {
    if (group.length && t.start >= groupEnd) close();
    let col = ends.findIndex(e => e <= t.start);
    if (col < 0) col = ends.length;
    ends[col] = t.start + t.dur;
    out.set(t.id, { col: col, cols: 1 });
    group.push(t);
    groupEnd = Math.max(groupEnd, t.start + t.dur);
  });
  close();
  return out;
}

function freeMinutes() {
  const spans = gBlocks().map(b => [b.start, b.end]).concat(scheduled().map(t => [Math.max(t.start, startMin()), Math.min(t.start + t.dur, endMin())]))
    .filter(x => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  let used = 0, cur = -1;
  for (const [s, e] of spans) { if (e <= cur) continue; used += e - Math.max(s, cur); cur = e; }
  return Math.max(0, endMin() - startMin() - used);
}

// ---------- changes ----------
/** Sends a change. The answer is only taken over if nothing newer has changed the task meanwhile. */
function save(t, patch) {
  const rev = t.rev = (t.rev || 0) + 1;
  queueSync();
  return api('task_update', { id: t.id, patch: patch })
    .then(d => { if (t.rev === rev) Object.assign(t, d.task); })
    .catch(saveFailed);
}

function update(t, patch) {
  Object.assign(t, patch);
  render();
  save(t, patch);
}

// notes are saved a moment after the last keystroke, and at once when the box is left
const noteTimers = {};
function notesChanged(t, text) {
  t.notes = text;
  t.rev = (t.rev || 0) + 1;            // an answer still on its way must not bring back older text
  clearTimeout(noteTimers[t.id]);
  noteTimers[t.id] = setTimeout(() => flushNotes(t), 700);
  document.querySelectorAll(`[data-act="more"][data-id="${t.id}"]`).forEach(b => { b.textContent = moreLabel(t); b.classList.toggle('has', hasMore(t)); });
}
function flushNotes(t) {
  if (!noteTimers[t.id]) return;
  clearTimeout(noteTimers[t.id]);
  delete noteTimers[t.id];
  save(t, { notes: t.notes });
}

async function addTask(title, p) {
  try {
    const d = await api('task_add', { title: title, p: p, board: BOARD });
    if (d.task.board === BOARD) S.tasks.push(d.task);
    render();
  } catch (err) { toast(err.message); }
}

function cycleProject(t) {
  const ids = S.projects.map(p => p.id);
  if (!ids.length) return;
  update(t, { p: ids[(ids.indexOf(t.p) + 1) % ids.length] });
}

function cycleDur(t) {
  const i = DURS.indexOf(t.dur);
  for (let k = 1; k <= DURS.length; k++) {
    const d = DURS[(i + k) % DURS.length];
    if (t.start === null || !conflict(t.start, d)) { update(t, { dur: d }); return; }
  }
}

function toggleDone(t) {
  const patch = { done: !t.done };
  if (patch.done && t.where === 'dump') { patch.where = 'also'; patch.day = DAY; }
  update(t, patch);
}

function removeTask(t) {
  clearTimeout(noteTimers[t.id]); delete noteTimers[t.id]; open.delete(t.id);
  S.tasks = S.tasks.filter(x => x !== t); render();
  api('task_delete', { id: t.id })
    .then(() => { queueSync(); toast(t.repeat ? 'Deleted from this day. It still repeats on the others.' : 'Task deleted.', { label: 'Undo', run() { restoreTask(t); } }); })
    .catch(saveFailed);
}

/**
 * Undo for a delete: adds the task again where it was. If its place was taken in the
 * meantime (the slot in Today's 3, or its time on the timeline), it comes back without it.
 * A copy of a repeating task comes back as a task of its own that does not repeat.
 */
async function restoreTask(old) {
  try {
    const d = await api('task_add', { title: old.title, p: old.p, board: old.board });
    const patch = { dur: old.dur, notes: old.notes || '', subs: old.subs || [], remind: old.remind === undefined ? null : old.remind };
    if (old.where !== 'dump') {
      const same = old.day === DAY;
      const slotFree = same && !dayTasks().some(x => x.where === 'top' && x.slot === old.slot);
      patch.day = old.day;
      patch.where = old.where === 'top' && slotFree ? 'top' : 'also';
      if (patch.where === 'top') patch.slot = old.slot;
      if (same && old.start !== null && !conflict(old.start, old.dur)) patch.start = old.start;
      if (old.done) patch.done = true;
    }
    await api('task_update', { id: d.task.id, patch: patch });
  } catch (err) { toast(err.message); }
  loadState();
  queueSync();
}

/** Repeat on, off or changed: the server rewrites the days from this one on, so the board is read again. */
async function setRepeat(t, rule) {
  flushNotes(t);
  try {
    await api('task_repeat', { id: t.id, rule: rule, day: DAY, today: dayStr(new Date()) });
    toast(rule ? 'Repeats ' + choiceName(REPEATS, rule).toLowerCase() + '. Coming days have it already.' : 'No longer repeats from this day on.');
  } catch (err) { toast(err.message); }
  await loadState();
  queueSync();
}

// ---------- rendering ----------
const hasMore = t => !!(t.subs.length || t.notes);
/** What the button that opens subtasks and notes shows: "2/5" subtasks done, a pen when there are notes. */
function moreLabel(t) {
  const n = t.subs.length ? t.subs.filter(s => s.done).length + '/' + t.subs.length : '';
  return (n + (t.notes ? ' ✎' : '')).trim() || '⋯';
}
function moreBtn(t) {
  return `<button class="more ${hasMore(t) ? 'has' : ''}" data-act="more" data-id="${t.id}" title="Subtasks and notes" aria-expanded="${open.has(t.id)}">${moreLabel(t)}</button>`;
}

/** Small marks after a task's title: ↻ when it repeats, a bell when Google is to remind about it. */
function marks(t) {
  return (t.repeat ? `<span class="rep" title="Repeats: ${esc(choiceName(REPEATS, t.repeat).toLowerCase())}">↻</span>` : '')
    + (t.remind !== null && t.remind !== undefined && t.start !== null ? `<span class="bell" title="Reminder: ${esc(choiceName(REMINDS, t.remind).toLowerCase())}">🔔</span>` : '');
}

/** The panel under a task: its subtasks, a box to add one, its notes, how it repeats and its reminder. */
function details(t) {
  if (!open.has(t.id)) return '';
  return `<div class="details" data-details="${t.id}">
    <ul class="subs">${t.subs.map((s, i) => `<li class="${s.done ? 'done' : ''}" draggable="true" data-subrow="${t.id}" data-i="${i}">
      <button class="check ${s.done ? 'on' : ''}" data-act="sub-done" data-id="${t.id}" data-i="${i}" title="Done">✓</button>
      <span data-sub="${t.id}" data-i="${i}" title="Drag to reorder, double-click to rename">${esc(s.title)}</span>
      <button class="x" title="Delete subtask" data-act="sub-del" data-id="${t.id}" data-i="${i}">×</button></li>`).join('')}</ul>
    <div class="subaddrow"><input class="subadd" type="text" name="subtask" data-subadd="${t.id}" placeholder="Add a subtask…" aria-label="New subtask" autocomplete="off" enterkeyhint="done" maxlength="300"><button class="btn small" data-act="sub-add" data-id="${t.id}" title="Add the subtask">Add</button></div>
    <textarea class="notes" name="notes" data-notes="${t.id}" placeholder="Notes…" aria-label="Notes" rows="2" maxlength="5000">${esc(t.notes)}</textarea>
    <div class="drow">
      <label>Repeat <select name="repeat" data-repeat="${t.id}">${options(REPEATS, t.repeat || '')}</select></label>
      <label>Remind me <select name="remind" data-remind="${t.id}"${t.start === null ? ' disabled' : ''}>${options(REMINDS, t.start === null ? null : t.remind)}</select></label>
      ${t.start === null ? '<span class="dhint">Give the task a time first</span>' : ''}
    </div>
    ${t.repeat ? `<button class="link small" data-act="series-apply" data-id="${t.id}" title="Coming days get this title, time, length, subtasks, notes and reminder">Use these details from this day on</button>` : ''}
  </div>`;
}

function card(t) {
  const p = proj(t.p);
  return `<div class="task"><div class="item ${t.done ? 'done' : ''}" draggable="true" data-id="${t.id}" style="border-left-color:${safeColor(p.color)}">
    <button class="check ${t.done ? 'on' : ''}" data-act="done" data-id="${t.id}" title="Done">✓</button>
    <button class="dot" style="background:${safeColor(p.color)}" title="${esc(p.name)} (click to change)" data-act="proj" data-id="${t.id}"></button>
    <span class="t" title="${esc(t.title)} (double-click to rename)" data-title="${t.id}">${esc(t.title)}${marks(t)}</span>
    ${t.carried && t.where === 'dump' ? '<span class="carried" title="Left over from an earlier day">carried</span>' : ''}
    ${t.start !== null ? `<span class="at">${hm(t.start)}</span>` : ''}
    ${moreBtn(t)}
    <button class="dur" title="Click to change length" data-act="dur" data-id="${t.id}">${durTxt(t.dur)}</button>
    <button class="x" title="Delete" data-act="del" data-id="${t.id}">×</button></div>${details(t)}</div>`;
}

function renderLists() {
  // a re-draw replaces the boxes; whatever is being typed in one of them is carried over
  const a = document.activeElement;
  const typing = a && a.matches && a.matches('.subadd, .notes')
    ? { sel: a.dataset.subadd ? `[data-subadd="${a.dataset.subadd}"]` : `[data-notes="${a.dataset.notes}"]`, v: a.value, s: a.selectionStart, e: a.selectionEnd, y: a.scrollTop }
    : null;
  $('z-dump').innerHTML = S.tasks.filter(t => t.where === 'dump').map(card).join('');
  $('z-also').innerHTML = dayTasks().filter(t => t.where === 'also').map(card).join('');
  let top = '';
  for (let i = 0; i < 3; i++) {
    const t = dayTasks().find(x => x.where === 'top' && x.slot === i);
    if (!t) { top += `<div class="task"><div class="slot empty" data-slot="${i}">Drag main task ${i + 1} here</div></div>`; continue; }
    const p = proj(t.p);
    top += `<div class="task"><div class="slot ${t.done ? 'done' : ''}" draggable="true" data-id="${t.id}" data-slot="${i}" style="border-left-color:${safeColor(p.color)}">
      <span class="n">${i + 1}</span><div class="body"><b title="${esc(t.title)} (double-click to rename)" data-title="${t.id}">${esc(t.title)}</b>
      <span class="meta">${esc(p.name)} · <button class="dur" data-act="dur" data-id="${t.id}">${durTxt(t.dur)}</button>${t.start !== null ? `<span class="at">${hm(t.start)}</span>` : '<span>not scheduled yet</span>'}${marks(t)}${moreBtn(t)}</span></div>
      <button class="check ${t.done ? 'on' : ''}" data-act="done" data-id="${t.id}" title="Done">✓</button></div>${details(t)}</div>`;
  }
  $('top3').innerHTML = top;
  if (typing) {
    const el = document.querySelector(typing.sel);
    if (el) { el.value = typing.v; el.focus({ preventScroll: true }); el.setSelectionRange(typing.s, typing.e); el.scrollTop = typing.y; }
  }
}

function renderProjects() {
  const sel = $('newp'), keep = sel.value;
  sel.innerHTML = S.projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  if (keep) sel.value = keep;
  if (S.projects.length && !sel.value) sel.value = String(S.projects[0].id);    // the last choice was another board's
  sel.hidden = !S.projects.length;
  $('projhint').textContent = S.projects.length ? 'Click a color to change it everywhere.'
    : (S.boards.length > 1 ? 'This board has no projects yet. ' : 'No projects yet. ') + 'Add one to give its tasks a color.';
  $('projects').innerHTML = S.projects.map(p => `<div class="proj">
    <input type="color" value="${safeColor(p.color)}" data-pcolor="${p.id}" title="Project color">
    <input type="text" value="${esc(p.name)}" data-pname="${p.id}" maxlength="60">
    <button class="x" title="Delete project (its tasks stay)" data-act="del-project" data-id="${p.id}">×</button></div>`).join('');
}

/** The buttons at the top, one per board. With a single board there is nothing to switch, so they stay away. */
function renderBoards() {
  const el = $('tabs');
  el.hidden = S.boards.length < 2;
  el.innerHTML = S.boards.map(b => `<button class="tab ${b.id === BOARD ? 'on' : ''}" data-act="board" data-board="${b.id}" aria-pressed="${b.id === BOARD}">${esc(b.name)}</button>`).join('');
  const list = $('boards');
  const a = document.activeElement;
  if (a && a.dataset && a.dataset.bname && S.boards.some(b => b.id === +a.dataset.bname)) return;   // a name is being typed
  list.innerHTML = S.boards.map(b => `<div class="proj">
    <input type="text" value="${esc(b.name)}" data-bname="${b.id}" maxlength="30" aria-label="Board name">
    ${S.boards.length > 1 ? `<button class="x" title="Delete board (its tasks move to another board)" data-act="del-board" data-board="${b.id}">×</button>` : ''}</div>`).join('');
}

function renderTimeline() {
  const s0 = startMin();
  let h = '';
  for (let i = S.settings.dayStart; i < S.settings.dayEnd; i++) h += `<div class="hr"><i>${String(i).padStart(2, '0')}:00</i></div>`;
  const google = gBlocks(), lane = lanes(scheduled().concat(google));
  const sideOf = l => l.cols > 1 ? `left:calc(8px + (100% - 16px) * ${l.col} / ${l.cols});right:auto;width:calc((100% - 16px) / ${l.cols} - ${l.col < l.cols - 1 ? 3 : 0}px);` : '';
  // a calendar event: its time is Google's, so it is not dragged or resized; a click opens its subtasks and notes
  h += google.map(b => { const e = b.ev; return `<div class="blk gcal" role="button" tabindex="0" data-act="gev-open" data-day="${DAY}" data-gkey="${e.key}" title="${esc(e.title)} · ${esc(e.calendar)}" style="top:${(b.start - s0) / 60 * H + 1}px;height:${b.dur / 60 * H - 2}px;${sideOf(lane.get(b.id))}--c:${safeColor(e.color)}"><i class="gmark" aria-hidden="true"></i>${esc(e.title)}<small>${hm(e.start)}–${hm(e.end)}</small>${hasMore(e) ? `<small>${moreLabel(e)}</small>` : ''}</div>`; }).join('');
  h += scheduled().map(t => {
    const p = proj(t.p), c = safeColor(p.color), n = t.where === 'top' ? ['①', '②', '③'][t.slot] + ' ' : '';
    const l = lane.get(t.id), side = sideOf(l);
    const top = Math.max(t.start, s0), end = Math.min(t.start + t.dur, endMin());
    if (end <= top) return '';
    return `<div class="blk ${t.done ? 'done' : ''}" draggable="true" data-id="${t.id}" data-blk="1" title="${esc(t.title)}" style="top:${(top - s0) / 60 * H + 1}px;height:${(end - top) / 60 * H - 2}px;${side}background-color:${c};color:${ink(c)}">${n}${esc(t.title)}${marks(t)}<small>${hm(t.start)}–${hm(t.start + t.dur)}</small>${hasMore(t) ? `<small>${moreLabel(t)}</small>` : ''}<button class="x" title="Take off the timeline" data-act="unschedule" data-id="${t.id}">×</button><span class="rs" data-rs="${t.id}"></span></div>`;
  }).join('');
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  if (DAY === dayStr(now) && nowMin >= s0 && nowMin <= endMin()) h += `<div class="now" style="top:${(nowMin - s0) / 60 * H}px"></div>`;
  h += '<div class="ghost" id="ghost"></div>';
  $('tl').innerHTML = h;
  // the board's own events first (they never block the timeline), then Google's all-day events
  $('allday').innerHTML = S.events.map(dayChip).join('')
    + CAL.allDay.filter(e => !e.hidden).map(e => `<button type="button" class="chip gchip" data-act="gev-open" data-day="${DAY}" data-gkey="${e.key}" style="--c:${safeColor(e.color)}" title="${esc(e.title)} · ${esc(e.calendar)}"><span>All day: ${esc(e.title)}</span>${hasMore(e) ? `<b>${moreLabel(e)}</b>` : ''}</button>`).join('')
    + `<button class="chip add" data-act="event-new" data-day="${DAY}" title="Add an event on this day">+ Event</button>`;
  const hidden = CAL.events.concat(CAL.allDay).filter(e => e.hidden).length;
  $('tlhint').innerHTML = esc(S.calendarConnected
    ? 'Blocks with a calendar mark come from Google Calendar: click one for its subtasks and notes. Tasks can share a time with anything: they sit side by side.'
    : 'Tasks can share a time: they sit side by side. Your calendar is not connected yet, so its events are not shown. Connect it in Settings (⚙).')
    + (hidden ? ` <button class="link" data-act="gev-unhide" title="Show the calendar events you hid on this day">${hidden} hidden · show</button>` : '');
}

const subsDone = e => e.subs.filter(s => s.done).length;

/** One of the board's events in the row above the timeline: time, title, place, which day of how many, checklist. */
function dayChip(e) {
  const c = safeColor(proj(e.p).color), total = daysBetween(e.from, e.to) + 1;
  let txt = (e.start !== null ? hm(e.start) + '–' + hm(e.end) + ' ' : '') + e.title;
  if (e.location) txt += ' · ' + e.location;
  if (total > 1) txt += ' · day ' + (daysBetween(e.from, DAY) + 1) + ' of ' + total;
  const n = e.subs.length;
  return `<button type="button" class="chip own" data-act="event-open" data-ev="${e.id}" style="--c:${c}" title="${esc(txt)}"><span>${esc(txt)}</span>${e.remind !== null && e.remind !== undefined ? '<i class="bell" title="Reminder">🔔</i>' : ''}${n ? `<b>${subsDone(e)}/${n}</b>` : ''}</button>`;
}

function renderCalStatus() {
  const el = $('calstat');
  const C = PAGE === 'calendar' ? Object.assign({ loading: CP.loading }, CP.google) : CAL;
  const problem = C.error || SYNC.error;            // a failed sync is told here, quietly, not in a toast each time
  el.className = 'calstat' + (problem ? ' bad' : '');
  if (!S.calendarConnected) { el.innerHTML = '<button class="btn go" data-act="settings-open">Connect Google Calendar</button>'; return; }
  let txt = 'Calendar';
  if (C.loading) txt = 'Reading calendar…';
  else if (problem) txt = 'Calendar problem';
  else if (SYNC.running) txt = 'Updating Google Calendar…';
  else if (C.fetchedAt) { const d = new Date(C.fetchedAt * 1000); txt = 'Calendar read ' + hm(d.getHours() * 60 + d.getMinutes()); }
  el.innerHTML = `<span title="${esc(problem || '')}">${esc(txt)}</span><button class="btn small" data-act="refresh-cal" title="Read the calendar again" aria-label="Read the calendar again">↻</button>`;
}

/** "November 2026", or the week: "23–29 November" (in the browser's own words for dates). */
function calTitle() {
  if (VIEW === 'month') return dayDate(CDAY).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const r = calRange(), f = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long' });
  return f.formatRange ? f.formatRange(dayDate(r.from), dayDate(r.to)) : f.format(dayDate(r.from)) + ' – ' + f.format(dayDate(r.to));
}

function renderHeader() {
  const cal = PAGE === 'calendar', unit = cal ? VIEW : 'day';
  $('free').hidden = cal;
  $('push').hidden = !S.calendarConnected;
  [['prev', 'Previous '], ['next', 'Next ']].forEach(([id, w]) => { $(id).title = w + unit; $(id).setAttribute('aria-label', w + unit); });
  if (cal) { $('dayname').textContent = calTitle(); $('daydate').textContent = ''; renderCalStatus(); return; }
  const d = dayDate(DAY), today = dayStr(new Date());
  const rel = DAY === today ? 'Today · ' : DAY === shiftDay(today, 1) ? 'Tomorrow · ' : DAY === shiftDay(today, -1) ? 'Yesterday · ' : '';
  $('dayname').textContent = rel + d.toLocaleDateString(undefined, { weekday: 'long' });
  $('daydate').textContent = d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  $('free').textContent = durTxt(freeMinutes()) + ' still free';
  renderCalStatus();
}

function render(skipProjects) {
  if (editing) return;
  renderBoards();
  renderHeader();
  if (PAGE === 'calendar') { renderCalendar(); return; }
  renderLists();
  if (!skipProjects) renderProjects();
  renderTimeline();
}

// ---------- the Calendar page ----------
const MONTH_ITEMS = 3;          // items in a month cell before "+N more"

/** What one day holds: the board's events, Google's events and the board's planned tasks. */
function dayItems(day) {
  const days = (CP.google && CP.google.days) || {}, g = days[day] || { events: [], allDay: [] };
  return {
    own: CP.events.filter(e => e.from <= day && e.to >= day),
    g: { events: g.events.filter(e => !e.hidden), allDay: g.allDay.filter(e => !e.hidden) },
    tasks: CP.tasks.filter(t => t.day === day),
  };
}

/** An event on the calendar. Over several days it reads as one bar: flat ends where it goes on. */
function evChip(e, day, big) {
  const c = safeColor(proj(e.p).color), n = e.subs.length;
  const time = e.start !== null ? hm(e.start) + '–' + hm(e.end) : '';
  const when = e.from === e.to ? time : e.from + ' – ' + e.to;
  const tip = e.title + (e.location ? ' · ' + e.location : '') + (when ? ' · ' + when : '') + (n ? ' · to arrange ' + subsDone(e) + '/' + n : '');
  const cls = 'ev' + (day === e.from ? '' : ' cont-l') + (day === e.to ? '' : ' cont-r') + (big ? ' big' : '');
  let inner = (e.start !== null ? `<b>${hm(e.start)}</b> ` : '') + esc(e.title) + (e.remind !== null && e.remind !== undefined ? ' <i class="bell">🔔</i>' : '');
  if (big) {
    if (e.start !== null) inner = `<b>${time}</b> ` + esc(e.title);
    if (e.location) inner += `<small>${esc(e.location)}</small>`;
    if (n) inner += `<small>To arrange ${subsDone(e)}/${n}${subsDone(e) === n ? ' ✓' : ''}</small>`;
  }
  return `<div class="${cls}" role="button" tabindex="0" draggable="true" data-act="event-open" data-ev="${e.id}" data-day="${day}" title="${esc(tip)}" style="background-color:${c};color:${ink(c)}">${inner}</div>`;
}

const gAttrs = (x, day) => `class="gev" role="button" tabindex="0" data-act="gev-open" data-day="${day}" data-gkey="${x.key}" title="${esc(x.title)} · ${esc(x.calendar)}" style="--c:${safeColor(x.color)}"`;
const gAllDay = (x, day) => `<div ${gAttrs(x, day)}>${esc(x.title)}</div>`;
const gTimed = (x, day) => `<div ${gAttrs(x, day)}><b>${hm(x.start)}</b> ${esc(x.title)}</div>`;

/** The board's planned tasks of a day, in one line: a dot per filled place in Today's 3, then the count. */
function taskLine(day, tasks) {
  if (!tasks.length) return '';
  const top = [0, 1, 2].map(i => tasks.some(t => t.where === 'top' && t.slot === i));
  const dots = top.some(Boolean) ? top.map(on => `<i class="${on ? '' : 'off'}"></i>`).join('') : '<i class="off"></i>';
  const done = tasks.filter(t => t.done).length, n = tasks.length;
  const txt = n + ' task' + (n === 1 ? '' : 's') + (done ? ', ' + done + ' done' : '');
  return `<button class="tline" data-act="open-day" data-day="${day}" title="${txt}: open this day">${dots}<span>${txt}</span></button>`;
}

function monthCell(day) {
  const it = dayItems(day), d = dayDate(day), today = dayStr(new Date());
  const items = it.own.map(e => evChip(e, day)).concat(it.g.allDay.map(x => gAllDay(x, day)), it.g.events.map(x => gTimed(x, day)));
  if (it.tasks.length) items.push(taskLine(day, it.tasks));
  const max = narrow() ? 12 : MONTH_ITEMS;             // on a phone they are dots, and many fit
  const shown = items.length > max ? items.slice(0, max) : items, more = items.length - shown.length;
  const out = d.getMonth() !== dayDate(CDAY).getMonth();
  const label = d.getDate() === 1 ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : d.getDate();
  return `<div class="cell${out ? ' out' : ''}${day === today ? ' today' : ''}" data-cday="${day}">
    <div class="chead"><button class="dnum" data-act="open-day" data-day="${day}" title="Open this day">${label}</button>${more ? `<button class="more-line" data-act="cal-week" data-day="${day}" title="See the whole week">+${more} more</button>` : ''}</div>${shown.join('')}</div>`;
}

function weekCard(day) {
  const it = dayItems(day), d = dayDate(day), today = dayStr(new Date());
  const tasks = it.tasks.map(t => {
    const c = safeColor(proj(t.p).color);
    return `<div class="wtask${t.done ? ' done' : ''}"><i style="background:${c}"></i><span title="${esc(t.title)}">${t.where === 'top' ? `<b>${t.slot + 1}</b> ` : ''}${esc(t.title)}${t.repeat ? ' <em class="rep">↻</em>' : ''}${t.start !== null ? `<small>${hm(t.start)}</small>` : ''}</span></div>`;
  });
  const google = it.g.allDay.map(x => gAllDay(x, day)).concat(it.g.events.map(x => gTimed(x, day)));
  return `<div class="wday${day === today ? ' today' : ''}" data-cday="${day}">
    <div class="whead"><button class="dnum" data-act="open-day" data-day="${day}" title="Open this day">${d.getDate()}</button><span>${esc(d.toLocaleDateString(undefined, { weekday: 'long' }))}</span></div>
    ${it.own.map(e => evChip(e, day, true)).join('')}${google.join('')}
    ${tasks.length ? `<div class="wsec">Tasks</div>${tasks.join('')}` : ''}</div>`;
}

let shownToday = '';            // the date the calendar was last drawn on, so the minute timer can tell a new day

function renderCalendar() {
  if (PAGE !== 'calendar' || evDrag) return;       // nothing is re-drawn under a dragged event
  shownToday = dayStr(new Date());
  document.querySelectorAll('#views [data-view]').forEach(b => { b.classList.toggle('on', b.dataset.view === VIEW); b.setAttribute('aria-pressed', b.dataset.view === VIEW); });
  const G = CP.google || {};
  const note = $('cal-note');
  note.hidden = !(S.calendarConnected && (G.needsUpdate || (S.sync && S.sync.needsUpdate)));
  if (!note.hidden) note.innerHTML = 'Update the calendar script to get Google events on this page, reminders and one Google calendar per board: <button class="link" data-act="settings-update">Settings › Google Calendar</button>.';
  $('cal-hint').textContent = narrow() && VIEW === 'month' ? 'Tap a day to see its week.' : 'Click a day to add an event; drag an event to move it.';
  const r = calRange(), days = [];
  for (let d = r.from; d <= r.to; d = shiftDay(d, 1)) days.push(d);
  $('cal-days').hidden = VIEW !== 'month';
  $('cal-days').innerHTML = days.slice(0, 7).map(d => `<span>${esc(dayDate(d).toLocaleDateString(undefined, { weekday: 'short' }))}</span>`).join('');
  const grid = $('cal-grid');
  grid.className = 'cal-grid ' + VIEW + (VIEW === 'month' ? ' rows' + days.length / 7 : '');
  grid.innerHTML = days.map(VIEW === 'month' ? monthCell : weekCard).join('');
  renderUpcoming();
}

/** "today", "tomorrow", "in 12 days", or "on now" for an event that started earlier. */
function countdown(e, today) {
  if (e.from < today) return 'on now';
  const n = daysBetween(today, e.from);
  return n === 0 ? 'today' : n === 1 ? 'tomorrow' : 'in ' + n + ' days';
}

function whenTxt(e) {
  if (e.from === e.to) {
    const f = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    return f.format(dayDate(e.from)) + (e.start !== null ? ' · ' + hm(e.start) + '–' + hm(e.end) : '');
  }
  const f = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  return f.formatRange ? f.formatRange(dayDate(e.from), dayDate(e.to)) : f.format(dayDate(e.from)) + ' – ' + f.format(dayDate(e.to));
}

const UP_MAX = 12, UP_OPEN = 3;  // events listed, and how many of them show what is still to arrange

/** "Coming up": the next events, how far off they are, and what is still to arrange for them. */
function renderUpcoming() {
  const today = dayStr(new Date()), list = UPCOMING.filter(e => e.to >= today).slice(0, UP_MAX);
  if (!list.length) { $('up').innerHTML = '<p class="up-empty">Nothing planned for the next 60 days. Add an event with + Event.</p>'; return; }
  $('up').innerHTML = list.map((e, k) => {
    const c = safeColor(proj(e.p).color), n = e.subs.length, done = subsDone(e), when = countdown(e, today);
    const soon = daysBetween(today, e.from) <= 1;      // on now, today or tomorrow
    const prog = n ? `<div class="up-prog"><span class="bar"><i style="width:${Math.round(done / n * 100)}%"></i></span><span>${done}/${n}</span>${done === n ? '<span class="ok" title="Everything is arranged">✓</span>' : ''}</div>` : '';
    const todo = k < UP_OPEN && done < n
      ? `<ul class="up-todo">${e.subs.map((s, i) => s.done ? '' : `<li><button class="check" data-act="up-tick" data-ev="${e.id}" data-i="${i}" title="Arranged">✓</button><span>${esc(s.title)}</span></li>`).join('')}</ul>`
      : '';
    return `<div class="up-row" style="--c:${c}">
      <div class="up-top"><span class="up-date">${esc(whenTxt(e))}</span><span class="up-when${soon ? ' soon' : ''}">${when}</span></div>
      <button class="up-title" data-act="event-open" data-ev="${e.id}" title="${esc(e.title)}">${esc(e.title)}${e.remind !== null && e.remind !== undefined ? ' <i class="bell">🔔</i>' : ''}</button>
      ${e.location ? `<div class="up-loc" title="${esc(e.location)}">${esc(e.location)}</div>` : ''}${prog}${todo}</div>`;
  }).join('');
}

/** The day a new event starts on when nothing else says: today if it is in view, else the first day in view. */
function newEventDay() {
  if (PAGE === 'day') return DAY;
  const r = calRange(), today = dayStr(new Date());
  const first = VIEW === 'week' ? r.from : CDAY.slice(0, 8) + '01';
  const last = VIEW === 'week' ? r.to : shiftDay(dayStr(new Date(dayDate(CDAY).getFullYear(), dayDate(CDAY).getMonth() + 1, 1)), -1);
  return today >= first && today <= last ? today : first;
}

/** An event dragged to another day keeps its length; `from` is its new first day. */
function moveEvent(id, from) {
  const e = findEvent(id);
  if (!e || from === e.from) return;
  const patch = { from: from, to: shiftDay(from, daysBetween(e.from, e.to)) };
  setEventLocal(id, patch);
  api('event_update', { id: id, patch: patch })
    .then(() => { loadUpcoming(); queueSync(); })
    .catch(err => { toast(err.message); refreshEvents(); });
}

// ---------- Google Calendar events: subtasks, notes, hiding ----------
/** The same Google event can be in the day's list and in the Calendar page's days. */
function gLists(day) {
  const lists = day === DAY ? [CAL.events, CAL.allDay] : [];
  const d = CP.google && CP.google.days && CP.google.days[day];
  if (d) lists.push(d.events, d.allDay);
  return lists;
}
const findG = (day, key) => { for (const l of gLists(day)) { const e = l.find(x => x.key === key); if (e) return e; } return null; };
function setGLocal(day, key, patch) { gLists(day).forEach(l => l.forEach(e => { if (e.key === key) Object.assign(e, patch); })); }

/** Saves notes, subtasks or "hidden" for a Google event; the planner keeps them, Google is not changed. */
function gevSave(day, key, patch) {
  setGLocal(day, key, patch);
  render();
  return api('cal_extra', { day: day, key: key, patch: patch }).catch(err => { toast(err.message); loadCalendar(false); });
}

function openGev(day, key) {
  const e = findG(day, key);
  if (!e) return;
  GE = { day: day, key: key, timer: 0 };
  const allDay = e.start === undefined;
  $('gev-title').textContent = e.title;
  $('gev-when').textContent = [allDay ? 'All day' : hm(e.start) + '–' + hm(e.end),
    dayDate(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }), e.calendar].filter(Boolean).join(' · ');
  $('gev-notes').value = e.notes || '';
  $('gev-subadd').value = '';
  renderGevSubs();
  $('gev-dlg').showModal();
}

function renderGevSubs() {
  const e = GE && findG(GE.day, GE.key);
  $('gev-subs').innerHTML = (e ? e.subs : []).map((s, i) => `<li class="${s.done ? 'done' : ''}">
    <button type="button" class="check ${s.done ? 'on' : ''}" data-act="gev-sub-done" data-i="${i}" title="Done">✓</button>
    <span data-gevsub="${i}" title="Double-click to rename">${esc(s.title)}</span>
    <button type="button" class="x" data-act="gev-sub-del" data-i="${i}" title="Delete subtask">×</button></li>`).join('');
}

function gevSubs(change) {
  const e = GE && findG(GE.day, GE.key);
  if (!e) return;
  const subs = e.subs.map(s => ({ title: s.title, done: s.done }));
  change(subs);
  gevSave(GE.day, GE.key, { subs: subs });
  renderGevSubs();
}

function addGevSub() {
  const box = $('gev-subadd'), v = box.value.trim().replace(/\s+/g, ' '), e = GE && findG(GE.day, GE.key);
  if (!v || !e) { box.focus(); return; }
  if (e.subs.length >= 50) { toast('An event holds up to 50 subtasks.'); return; }
  box.value = '';
  gevSubs(subs => subs.push({ title: v, done: false }));
  box.focus();
}

function flushGevNotes() {
  if (!GE || !GE.timer) return;
  clearTimeout(GE.timer);
  GE.timer = 0;
  gevSave(GE.day, GE.key, { notes: $('gev-notes').value });
}

// ---------- clicks ----------
const actions = {
  prev() { if (PAGE === 'calendar') calMove(-1); else goDay(shiftDay(DAY, -1)); },
  next() { if (PAGE === 'calendar') calMove(1); else goDay(shiftDay(DAY, 1)); },
  today() {
    if (PAGE !== 'calendar') { goDay(dayStr(new Date())); return; }
    CDAY = dayStr(new Date()); render(); loadMonth(false);
  },
  board(_, btn) { goBoard(+btn.dataset.board); },
  page(_, btn) { goPage(btn.dataset.page); },
  'cal-view'(_, btn) { if (btn.dataset.view !== VIEW) setView(btn.dataset.view); },
  'cal-week'(_, btn) { CDAY = btn.dataset.day; setView('week'); },
  'open-day'(_, btn) {
    PAGE = 'day';
    try { localStorage.setItem('planner_page', 'day'); } catch (e) { /* private window */ }
    showPage();
    goDay(btn.dataset.day);
  },
  'event-new'(_, btn) { openEvent(null, btn.dataset.day || newEventDay()); },
  'event-open'(_, el) { const e = findEvent(+el.dataset.ev); if (e) openEvent(e); },
  'event-close'() { $('event-dlg').close(); },
  'event-delete'() { deleteEvent(); },
  'evsub-add'() { addEventSub(); $('ev-subadd').focus(); },
  'evsub-done'(_, btn) { const s = EV.subs[+btn.dataset.i]; if (s) { s.done = !s.done; renderEventSubs(); } },
  'evsub-del'(_, btn) { EV.subs.splice(+btn.dataset.i, 1); renderEventSubs(); },
  'up-tick'(_, btn) {
    const e = findEvent(+btn.dataset.ev), i = +btn.dataset.i;
    if (!e || !e.subs[i]) return;
    const subs = e.subs.map((s, k) => k === i ? { title: s.title, done: true } : s);
    setEventLocal(e.id, { subs: subs });
    render();
    api('event_update', { id: e.id, patch: { subs: subs } }).then(queueSync).catch(err => { toast(err.message); refreshEvents(); });
  },
  'settings-update'() { openSettings(); $('cal-update').open = true; },
  'gev-open'(_, el) { openGev(el.dataset.day, el.dataset.gkey); },
  'gev-close'() { $('gev-dlg').close(); },
  'gev-sub-add'() { addGevSub(); },
  'gev-sub-done'(_, btn) { const i = +btn.dataset.i; gevSubs(subs => { if (subs[i]) subs[i].done = !subs[i].done; }); },
  'gev-sub-del'(_, btn) { const i = +btn.dataset.i; gevSubs(subs => subs.splice(i, 1)); },
  'gev-hide'() {
    const g = GE;
    flushGevNotes();
    $('gev-dlg').close();
    gevSave(g.day, g.key, { hidden: true });
    toast('Hidden from the planner. It stays in Google Calendar.', { label: 'Undo', run() { gevSave(g.day, g.key, { hidden: false }); } });
  },
  'gev-unhide'() {
    CAL.events.concat(CAL.allDay).filter(e => e.hidden).forEach(e => gevSave(DAY, e.key, { hidden: false }));
  },
  async 'series-apply'(t) {
    flushNotes(t);
    try {
      await api('series_apply', { id: t.id });
      toast('From this day on, it repeats with these details.');
    } catch (err) { toast(err.message); }
    await loadState();
    queueSync();
  },
  async 'add-board'() {
    try {
      const d = await api('board_add', { name: 'New board' });
      S.boards = d.boards; renderBoards();
      const el = document.querySelector(`[data-bname="${d.board.id}"]`);
      if (el) { el.focus(); el.select(); }
    } catch (err) { toast(err.message); }
  },
  async 'del-board'(_, btn) {
    const id = +btn.dataset.board, b = S.boards.find(x => x.id === id);
    if (!b || !confirm('Delete the board "' + b.name + '"? Its tasks are kept: they move to the brain dump of another board.')) return;
    try {
      const d = await api('board_delete', { id: id });
      S.boards = d.boards;
      if (BOARD === id) { BOARD = 0; goBoard(d.to); } else { renderBoards(); if (d.moved && d.to === BOARD) loadState(); }
    } catch (err) { toast(err.message); }
  },
  proj(t) { cycleProject(t); },
  dur(t) { cycleDur(t); },
  done(t) { toggleDone(t); },
  del(t) { removeTask(t); },
  unschedule(t) { update(t, { start: null }); },
  more(t) {
    if (open.has(t.id)) { flushNotes(t); open.delete(t.id); } else open.add(t.id);
    render();
    if (open.has(t.id) && !hasMore(t)) { const el = document.querySelector(`[data-subadd="${t.id}"]`); if (el) el.focus(); }
  },
  'sub-done'(t, btn) {
    const i = +btn.dataset.i;
    update(t, { subs: t.subs.map((s, k) => k === i ? { title: s.title, done: !s.done } : s) });
  },
  'sub-add'(t, btn) { addSub(t, btn.previousElementSibling); },
  'sub-del'(t, btn) { update(t, { subs: t.subs.filter((s, k) => k !== +btn.dataset.i) }); },
  theme(_, btn) {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    document.querySelector('meta[name=color-scheme]').content = next;
    btn.textContent = next === 'light' ? '☾' : '☀';
    document.cookie = 'planner_theme=' + next + ';path=/;max-age=34560000;samesite=strict';
  },
  'refresh-cal'() { if (PAGE === 'calendar') loadMonth(true); else loadCalendar(true); },
  async push(_, btn) {
    if (!S.calendarConnected) { openSettings(); toast('Connect your calendar first.'); return; }
    if (SYNC.running) { toast('Google Calendar is being brought up to date. One moment.'); return; }
    btn.disabled = true;
    try {
      const r = await runSync(true);
      if (r && r.needsUpdate) {
        // an older script: send the day the old way, and say how to get the rest
        const old = await api('calendar_push', { day: DAY });
        toast((old.created ? old.created + ' block' + (old.created === 1 ? '' : 's') + ' sent to your Planner calendar.' : 'Nothing is on the timeline; the Planner calendar is clear for this day.')
          + ' For reminders and one calendar per board, update the calendar script: Settings › Google Calendar.');
        render();
      } else if (r && r.busy) {
        toast('Google Calendar is busy with another update. It is tried again in half a minute.');
      } else if (r) {
        toast('Google Calendar is up to date: ' + r.created + ' added, ' + r.updated + ' changed, ' + r.removed + ' removed.'
          + (r.partial ? ' There is more to send: press the button again in a minute.' : ''));
      }
    } catch (err) { toast(err.message); }
    btn.disabled = false;
  },
  async 'add-project'() {
    try {
      const d = await api('project_add', { name: 'New project', color: PALETTE[S.projects.length % PALETTE.length], board: BOARD });
      S.projects.push(d.project); render();
      const el = document.querySelector(`[data-pname="${d.project.id}"]`);
      if (el) { el.focus(); el.select(); }
    } catch (err) { toast(err.message); }
  },
  'del-project'(_, btn) {
    const id = +btn.dataset.id, used = S.tasks.filter(t => t.p === id).length;
    if (used && !confirm('Delete the project "' + proj(id).name + '"? Its tasks stay, without a project.')) return;
    S.projects = S.projects.filter(p => p.id !== id);
    S.tasks.forEach(t => { if (t.p === id) t.p = null; });
    render();
    api('project_delete', { id: id }).catch(saveFailed);
  },
  'settings-open'() { openSettings(); },
  'settings-close'() { $('settings').close(); },
  async 'copy-code'() {
    const ta = $('bridge-code');
    if (!ta.value) { toast('The script is still loading. Try again in a moment.'); return; }
    try { await navigator.clipboard.writeText(ta.value); $('copied').hidden = false; $('copied-again').hidden = false; toast('Script copied. Next: paste it into Apps Script (step 2).'); }
    catch (e) { $('code-box').open = true; ta.focus(); ta.select(); toast('Press Ctrl+C to copy the selected script.'); }
  },
  async 'connect-cal'(_, btn) {
    const url = $('bridge-url').value.trim(), box = $('cal-error');
    box.hidden = true;
    if (!url) { $('bridge-url').focus(); return; }
    btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      const r = await api('calendar_connect', { url: url });
      S.calendarConnected = true;
      $('bridge-url').value = '';
      toast('Connected. Reading ' + r.calendars.length + ' calendar' + (r.calendars.length === 1 ? '' : 's') + '.');
      showCalState(r.calendars);
      loadCalendar(true);
      if (PAGE === 'calendar') loadMonth(true);
    } catch (err) { box.textContent = err.message + ' See “It didn’t connect” below.'; box.hidden = false; }
    btn.disabled = false; btn.textContent = 'Connect';
  },
  async 'disconnect-cal'() {
    if (!confirm('Disconnect the calendar? Your tasks stay; calendar events stop showing until you connect again.')) return;
    try { await api('calendar_disconnect', {}); S.calendarConnected = false; showCalState(); loadBridgeCode(); loadCalendar(false); if (PAGE === 'calendar') loadMonth(false); }
    catch (err) { toast(err.message); }
  },
  async 'save-hours'() {
    try {
      const r = await api('settings', { dayStart: +$('set-start').value, dayEnd: +$('set-end').value });
      S.settings = r.settings; render(); toast('Day hours saved.');
    } catch (err) { toast(err.message); }
  },
  async 'change-pw'() {
    try {
      await api('password', { current: $('pw-cur').value, new: $('pw-new').value });
      $('pw-cur').value = ''; $('pw-new').value = '';
      toast('Password changed. Other devices are signed out.');
    } catch (err) { toast(err.message); }
  },
  async logout() {
    try { await api('logout', {}); } catch (e) { /* reload shows the truth */ }
    location.reload();
  }
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  const t = el.dataset.id ? task(+el.dataset.id) : null;
  if (el.dataset.id && !t && el.dataset.act !== 'del-project') return;        // the task is gone
  fn(t, el);
});

// ---------- keeping Google Calendar up to date ----------
/** Something that Google shows changed: send everything a few seconds after the last change. */
function queueSync() {
  const sy = S.sync || {};
  if (!S.calendarConnected || !sy.auto || sy.needsUpdate) return;
  clearTimeout(SYNC.timer);
  SYNC.timer = setTimeout(() => runSync(false), sy.delay || 8000);
}

/** One sync at a time. A manual one (the button) passes its error on; an automatic one only shows it in the status. */
async function runSync(manual) {
  if (SYNC.running) { SYNC.again = true; return null; }
  clearTimeout(SYNC.timer);
  SYNC.running = true;
  renderCalStatus();
  let r = null, failed = null;
  try {
    r = await api('calendar_sync', { today: dayStr(new Date()) });
    S.sync = r.sync;
    SYNC.error = '';
  } catch (err) { failed = err; SYNC.error = err.message; }
  SYNC.running = false;
  if (r && r.busy) {
    // the script is busy with another update (another tab or device): quietly try again in half a minute
    clearTimeout(SYNC.timer);
    SYNC.timer = setTimeout(() => runSync(false), 30000);
  } else if (SYNC.again) { SYNC.again = false; queueSync(); }
  renderCalStatus();
  if (failed && manual) throw failed;
  return r;
}

// subtasks and notes
function addSub(t, box) {
  const v = box.value.trim();
  if (!t || !v) { box.focus(); return; }
  if (t.subs.length >= 50) { toast('A task holds up to 50 subtasks.'); return; }
  box.value = '';
  box.focus();                                    // the re-draw keeps the focus, so several can be typed in a row
  update(t, { subs: t.subs.concat({ title: v, done: false }) });
}
document.addEventListener('keydown', e => {
  const id = e.target.dataset && e.target.dataset.subadd;
  if (id && e.key === 'Enter') addSub(task(+id), e.target);
});
document.addEventListener('input', e => {
  const id = e.target.dataset && e.target.dataset.notes;
  if (id && task(+id)) notesChanged(task(+id), e.target.value);
});
document.addEventListener('focusout', e => {
  const id = e.target.dataset && e.target.dataset.notes;
  if (id && task(+id)) flushNotes(task(+id));
});
addEventListener('pagehide', () => { Object.keys(noteTimers).forEach(id => { const t = task(+id); if (t) flushNotes(t); }); });

// the password boxes and the event dialog sit in forms (so the browser files them correctly); they are sent from here
document.addEventListener('submit', e => {
  e.preventDefault();
  if (e.target.id === 'pw-form') actions['change-pw']();
  if (e.target.id === 'add-form') addFromBox();
  if (e.target.id === 'event-form') saveEvent();
});

// an event on the calendar is a div acting as a button (a real button cannot be dragged everywhere)
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[role=button][data-act]')) { e.preventDefault(); e.target.click(); }
});

// ---------- the event dialog ----------
function openEvent(e, day) {
  EV = { id: e ? e.id : null, subs: e ? e.subs.map(s => ({ title: s.title, done: s.done })) : [] };
  const timed = !!e && e.start !== null;
  $('ev-head').textContent = e ? 'Edit event' : 'New event';
  $('ev-title').value = e ? e.title : '';
  $('ev-from').value = e ? e.from : day;
  $('ev-to').value = e ? e.to : day;
  $('ev-allday').checked = !timed;
  $('ev-start').value = timed ? hm(e.start) : '09:00';
  $('ev-end').value = timed ? hm(e.end % 1440) : '10:00';
  $('ev-loc').value = e ? e.location : '';
  $('ev-proj').innerHTML = '<option value="">No project</option>' + S.projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('ev-proj').value = e && S.projects.some(p => p.id === e.p) ? String(e.p) : '';
  $('ev-notes').value = e ? e.notes : '';
  $('ev-remind').dataset.value = e && e.remind !== null && e.remind !== undefined ? String(e.remind) : '';
  $('ev-subadd').value = '';
  $('ev-del').hidden = !e;
  $('ev-error').hidden = true;
  $('ev-save').disabled = false;
  syncEventTimes();
  renderEventSubs();
  $('event-dlg').showModal();
  if (!e) $('ev-title').focus();
}

/** A timed event lasts one day, so its end date follows the start date. Its reminders are other ones than an all-day event's. */
function syncEventTimes() {
  const timed = !$('ev-allday').checked, sel = $('ev-remind'), list = timed ? REMINDS : ALLDAY_REMINDS;
  $('ev-times').hidden = !timed;
  if (timed || !$('ev-to').value || $('ev-to').value < $('ev-from').value) $('ev-to').value = $('ev-from').value;
  $('ev-to').disabled = timed;
  const keep = sel.dataset.value === '' ? null : +sel.dataset.value;
  sel.innerHTML = options(list, list.some(c => c[0] === keep) ? keep : null);
  sel.dataset.value = sel.value;
}

function renderEventSubs() {
  $('ev-subs').innerHTML = EV.subs.map((s, i) => `<li class="${s.done ? 'done' : ''}">
    <button type="button" class="check ${s.done ? 'on' : ''}" data-act="evsub-done" data-i="${i}" title="Arranged">✓</button>
    <span data-evsub="${i}" title="Double-click to rename">${esc(s.title)}</span>
    <button type="button" class="x" data-act="evsub-del" data-i="${i}" title="Delete">×</button></li>`).join('');
}

function eventError(msg) { $('ev-error').textContent = msg; $('ev-error').hidden = !msg; }

function addEventSub() {
  const inp = $('ev-subadd'), v = inp.value.trim().replace(/\s+/g, ' ');
  if (!v) return true;
  if (EV.subs.length >= 50) { eventError('An event holds up to 50 things to arrange.'); return false; }
  EV.subs.push({ title: v, done: false });
  inp.value = '';
  renderEventSubs();
  return true;
}

const minuteOf = v => { const m = /^(\d{2}):(\d{2})/.exec(v || ''); return m ? +m[1] * 60 + +m[2] : null; };

/** The form as the server wants it, or { error } in the words the server would use. */
function readEvent() {
  const title = $('ev-title').value.trim().replace(/\s+/g, ' ');
  const from = $('ev-from').value, timed = !$('ev-allday').checked;
  const to = timed ? from : $('ev-to').value || from;
  const body = { title: title, from: from, to: to, start: null, end: null, location: $('ev-loc').value.trim(),
                 p: $('ev-proj').value ? +$('ev-proj').value : null, notes: $('ev-notes').value, subs: EV.subs,
                 remind: $('ev-remind').value === '' ? null : +$('ev-remind').value };
  if (!title) return { error: 'An event needs a title' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return { error: 'Pick the days of the event' };
  const len = daysBetween(from, to);
  if (len < 0) return { error: 'The end date is before the start date' };
  if (len >= 60) return { error: 'An event can last at most 60 days' };
  if (timed) {
    body.start = minuteOf($('ev-start').value);
    body.end = minuteOf($('ev-end').value);
    if (body.end === 0) body.end = 1440;              // ending at 00:00 means at midnight, the end of the day
    if (body.start === null || body.end === null) return { error: 'Give both a start and an end time' };
    if (body.start >= body.end) return { error: 'The end time must be after the start time' };
  }
  return { body: body };
}

async function saveEvent() {
  if (!EV || !addEventSub()) return;                  // something typed in "To arrange" but not entered still counts
  const r = readEvent();
  if (r.error) { eventError(r.error); return; }
  eventError('');
  $('ev-save').disabled = true;
  try {
    if (EV.id) await api('event_update', { id: EV.id, patch: r.body });
    else await api('event_add', Object.assign({ board: BOARD }, r.body));
    $('event-dlg').close();
    refreshEvents();
    queueSync();
  } catch (err) { eventError(err.message); }
  $('ev-save').disabled = false;
}

function deleteEvent() {
  const e = EV && findEvent(EV.id);
  $('event-dlg').close();
  if (!e) return;
  removeEventLocal(e.id);
  render();
  api('event_delete', { id: e.id })
    .then(() => { queueSync(); toast('Event deleted.', { label: 'Undo', run() { restoreEvent(e); } }); })
    .catch(err => { toast(err.message); refreshEvents(); });
}

/** Undo for a delete: adds the event again, as it was saved. */
async function restoreEvent(old) {
  try {
    await api('event_add', { board: old.board, title: old.title, from: old.from, to: old.to, start: old.start, end: old.end,
                             location: old.location, p: old.p, notes: old.notes, subs: old.subs, remind: old.remind });
  } catch (err) { toast(err.message); }
  refreshEvents();
  queueSync();
}

$('ev-allday').addEventListener('change', syncEventTimes);
$('ev-remind').addEventListener('change', e => { e.target.dataset.value = e.target.value; });
$('ev-from').addEventListener('change', syncEventTimes);
$('ev-subadd').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();                                 // Enter here adds to the list; it must not send the form
  addEventSub();
});
// rename a thing to arrange on double-click
$('ev-subs').addEventListener('dblclick', e => {
  const el = e.target.closest('[data-evsub]'), i = el ? +el.dataset.evsub : -1;
  if (!EV.subs[i]) return;
  const inp = document.createElement('input');
  inp.className = 'edit'; inp.type = 'text'; inp.name = 'rename'; inp.autocomplete = 'off'; inp.maxLength = 300;
  inp.value = EV.subs[i].title;
  el.replaceWith(inp); inp.focus(); inp.select();
  let finished = false;
  const finish = keep => {
    if (finished) return;
    finished = true;
    const v = inp.value.trim().replace(/\s+/g, ' ');
    if (keep && v) EV.subs[i].title = v;
    renderEventSubs();
  };
  inp.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }   // closes the rename, not the dialog
  });
  inp.addEventListener('blur', () => finish(true));
});
// a click on the dimmed area around the dialog closes it without saving
$('event-dlg').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// the Google event dialog saves as it goes: subtasks at once, notes a moment after the last keystroke
$('gev-dlg').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$('gev-dlg').addEventListener('close', () => { flushGevNotes(); GE = null; });
$('gev-notes').addEventListener('input', () => {
  if (!GE) return;
  clearTimeout(GE.timer);
  GE.timer = setTimeout(flushGevNotes, 700);
});
$('gev-subadd').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addGevSub(); } });
$('gev-subs').addEventListener('dblclick', e => {
  const el = e.target.closest('[data-gevsub]'), g = GE && findG(GE.day, GE.key), i = el ? +el.dataset.gevsub : -1;
  if (!g || !g.subs[i]) return;
  const inp = document.createElement('input');
  inp.className = 'edit'; inp.type = 'text'; inp.name = 'rename'; inp.autocomplete = 'off'; inp.maxLength = 300;
  inp.value = g.subs[i].title;
  el.replaceWith(inp); inp.focus(); inp.select();
  let finished = false;
  const finish = keep => {
    if (finished) return;
    finished = true;
    const v = inp.value.trim().replace(/\s+/g, ' ');
    if (keep && v && v !== g.subs[i].title) gevSubs(subs => { subs[i].title = v; });
    else renderGevSubs();
  };
  inp.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
});

// a click on the free part of a day on the calendar: a new event there (on a phone, that day's week)
$('cal-grid').addEventListener('click', e => {
  const c = e.target.closest('[data-cday]');
  if (!c) return;
  if (VIEW === 'month' && narrow() && !e.target.closest('.dnum')) {
    e.stopPropagation();                              // the dots are too small to aim at; show the week instead
    CDAY = c.dataset.cday;
    setView('week');
    return;
  }
  if (e.target.closest('[data-act], .gev, .wtask')) return;
  openEvent(null, c.dataset.cday);
});

// ---------- events: drag to another day on the calendar (mouse here; a finger through the touch handlers below) ----------
document.addEventListener('dragstart', e => {
  if (touch) return;
  const el = e.target.closest && e.target.closest('[data-ev][draggable="true"]');
  const ev = el && findEvent(+el.dataset.ev);
  if (!ev) return;
  evDrag = { id: ev.id, off: daysBetween(ev.from, el.dataset.day) };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', 'event');
  setTimeout(() => el.classList.add('dragging'), 0);
});
/** Marks the day under the pointer or finger. Returns true when the dragged event can be dropped there. */
function evMove(target) {
  document.querySelectorAll('[data-cday].over').forEach(x => x.classList.remove('over'));
  const c = target && target.closest && target.closest('[data-cday]');
  if (c) c.classList.add('over');
  return !!c;
}
function evDrop(target) {
  const c = target && target.closest && target.closest('[data-cday]');
  if (c) moveEvent(evDrag.id, shiftDay(c.dataset.cday, -evDrag.off));   // the grabbed day lands where it was let go
}
document.addEventListener('dragover', e => {
  if (evDrag && evMove(e.target)) e.preventDefault();
});
document.addEventListener('drop', e => {
  if (!evDrag || !(e.target.closest && e.target.closest('[data-cday]'))) return;
  e.preventDefault();
  evDrop(e.target);
});
document.addEventListener('dragend', () => {
  if (!evDrag) return;
  evDrag = null;
  render();
});

// rename on double-click: a task's title, or one of its subtasks
document.addEventListener('dblclick', e => {
  const el = e.target.closest('[data-title], [data-sub]');
  if (!el || editing) return;
  const sub = el.dataset.sub !== undefined, i = +el.dataset.i;
  const t = task(+(sub ? el.dataset.sub : el.dataset.title));
  if (!t || (sub && !t.subs[i])) return;
  const old = sub ? t.subs[i].title : t.title;
  editing = true;
  const inp = document.createElement('input');
  inp.className = 'edit'; inp.value = old; inp.maxLength = 300;
  inp.type = 'text'; inp.name = 'rename'; inp.autocomplete = 'off';
  el.replaceWith(inp); inp.focus(); inp.select();
  const holder = inp.closest('[draggable]');
  if (holder) holder.draggable = false;
  let finished = false;
  const finish = save => {
    if (finished) return;
    finished = true; editing = false;
    const v = inp.value.trim();
    if (!save || !v || v === old) render();
    else if (sub) update(t, { subs: t.subs.map((s, k) => k === i ? { title: v, done: s.done } : s) });
    else update(t, { title: v });
  };
  inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') finish(true); if (ev.key === 'Escape') finish(false); });
  inp.addEventListener('blur', () => finish(true));
});

/** Adds what is typed in the brain dump box (Enter, or the Add button: some phone keyboards have no Enter). */
function addFromBox() {
  const box = $('new'), v = box.value.trim();
  if (!v) { box.focus(); return; }
  box.value = '';
  addTask(v, $('newp').value ? +$('newp').value : null);
  box.focus();
}

// how a task repeats, and its reminder
document.addEventListener('change', e => {
  const ds = e.target.dataset || {};
  if (ds.repeat && task(+ds.repeat)) setRepeat(task(+ds.repeat), e.target.value);
  if (ds.remind && task(+ds.remind)) update(task(+ds.remind), { remind: e.target.value === '' ? null : +e.target.value });
});

// project color and name
document.addEventListener('input', e => {
  const id = e.target.dataset && e.target.dataset.pcolor;
  if (!id) return;
  proj(+id).color = e.target.value;
  render(true);                       // keep the color picker open while dragging in it
});
document.addEventListener('change', e => {
  const ds = e.target.dataset || {};
  if (ds.pcolor) api('project_update', { id: +ds.pcolor, color: e.target.value }).catch(saveFailed);
  if (ds.bname) {
    const b = S.boards.find(x => x.id === +ds.bname), name = e.target.value.trim();
    if (!b) return;
    if (!name) { e.target.value = b.name; return; }
    b.name = name;
    api('board_update', { id: b.id, name: name }).then(d => { S.boards = d.boards; renderBoards(); queueSync(); }).catch(saveFailed);
    renderBoards();
  }
  if (ds.pname) {
    const p = proj(+ds.pname), name = e.target.value.trim() || 'Project';
    p.name = name; render();
    api('project_update', { id: p.id, name: name }).catch(saveFailed);
  }
});

// ---------- drag and drop ----------
// A mouse uses the browser's own drag and drop. A finger uses the touch handlers further
// down (press and hold, then move). Both end up in dragMove() and dragDrop().
document.addEventListener('dragstart', e => {
  if (touch) { e.preventDefault(); return; }     // a finger is already dragging its own way
  const el = e.target.closest && e.target.closest('[data-id][draggable="true"]');
  if (!el) return;
  const off = el.dataset.blk ? Math.round((e.clientY - el.getBoundingClientRect().top) / H * 60) : 0;
  drag = { id: +el.dataset.id, off: off };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(drag.id));
  setTimeout(() => el.classList.add('dragging'), 0);
});
document.addEventListener('dragend', () => { drag = null; subDrag = null; render(); });

// ---------- subtasks: drag to a new place in the list ----------
document.addEventListener('dragstart', e => {
  if (touch) return;
  const li = e.target.closest && e.target.closest('[data-subrow]');
  if (!li) return;
  subDrag = { id: +li.dataset.subrow, i: +li.dataset.i };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', 'subtask');
  setTimeout(() => li.classList.add('dragging'), 0);
});

/** The row of the same task under the pointer, and whether the drop would go after it. */
function subTarget(target, y) {
  const li = target && target.closest && target.closest('[data-subrow]');
  if (!li || +li.dataset.subrow !== subDrag.id) return null;
  const r = li.getBoundingClientRect();
  return { li: li, after: y > r.top + r.height / 2 };
}

/** Shows where the dragged subtask would land. Returns true when it can be dropped there. */
function subMove(target, y) {
  document.querySelectorAll('.drop-before, .drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after'));
  const at = subTarget(target, y);
  if (at) at.li.classList.add(at.after ? 'drop-after' : 'drop-before');
  return !!at;
}

function subDrop(target, y) {
  const t = task(subDrag.id), at = subTarget(target, y);
  if (!t || !at || !t.subs[subDrag.i]) return;
  let to = +at.li.dataset.i + (at.after ? 1 : 0);
  if (to > subDrag.i) to--;                      // taking the row out shifts the ones below it up
  if (to === subDrag.i) return;
  const subs = t.subs.slice(), moved = subs.splice(subDrag.i, 1)[0];
  subs.splice(to, 0, moved);
  update(t, { subs: subs });
}

function dropTime(y) {
  const t = task(drag.id), r = $('tl').getBoundingClientRect();
  const m = Math.round((startMin() + (y - r.top) / H * 60 - drag.off) / SNAP) * SNAP;
  return Math.max(startMin(), Math.min(endMin() - t.dur, m));
}

/** Shows where the dragged task would land. Returns true when `target` can take it. */
function dragMove(target, y) {
  document.querySelectorAll('.over').forEach(x => x.classList.remove('over'));
  const g = $('ghost');
  if (target && target.closest('#tl')) {
    const t = task(drag.id), s = dropTime(y), bad = conflict(s, t.dur);
    g.style.display = 'block';
    g.style.top = ((s - startMin()) / 60 * H + 1) + 'px';
    g.style.height = (t.dur / 60 * H - 2) + 'px';
    g.className = 'ghost' + (bad ? ' bad' : '');
    g.textContent = bad || hm(s) + '–' + hm(s + t.dur);
    return true;
  }
  if (g) g.style.display = 'none';
  const z = target && target.closest('[data-zone],[data-slot],.tab:not(.on)');
  if (z) z.classList.add('over');
  return !!z;
}

/** Puts the dragged task where it was let go. */
function dragDrop(target, y) {
  const t = task(drag.id);
  if (!t || !target) return;
  if (target.closest('#tl')) {
    const s = dropTime(y), bad = conflict(s, t.dur);
    if (bad) { toast(bad + '. Pick another time.'); return; }
    const patch = { start: s, day: DAY };
    if (t.where === 'dump') patch.where = 'also';
    update(t, patch);
    return;
  }
  const tab = target.closest('.tab:not(.on)');
  if (tab) {
    const to = S.boards.find(b => b.id === +tab.dataset.board);
    if (!to) return;
    flushNotes(t);
    S.tasks = S.tasks.filter(x => x !== t);
    open.delete(t.id);
    api('task_update', { id: t.id, patch: { board: to.id } })
      .then(() => toast('Moved to ' + to.name + '.'))
      .catch(saveFailed);
    return;
  }
  const sl = target.closest('[data-slot]');
  if (sl) {
    const i = +sl.dataset.slot, cur = dayTasks().find(x => x.where === 'top' && x.slot === i);
    if (cur && cur.id !== t.id) {
      if (t.where === 'top' && t.day === DAY) update(cur, { slot: t.slot });
      else update(cur, { where: 'also', slot: null });
    }
    update(t, { where: 'top', slot: i, day: DAY });
    return;
  }
  const z = target.closest('[data-zone]');
  if (!z) return;
  if (z.dataset.zone === 'dump') update(t, { where: 'dump', slot: null, day: null, start: null });
  else update(t, { where: 'also', slot: null, day: DAY });
}

document.addEventListener('dragover', e => {
  if (subDrag) { if (subMove(e.target, e.clientY)) e.preventDefault(); return; }
  if (!drag || !task(drag.id)) return;
  if (dragMove(e.target, e.clientY)) e.preventDefault();
});

document.addEventListener('drop', e => {
  if (subDrag) { e.preventDefault(); subDrop(e.target, e.clientY); return; }
  if (!drag || !task(drag.id)) return;
  e.preventDefault();
  dragDrop(e.target, e.clientY);
});

// ---------- dragging with a finger ----------
// Press and hold a task for a moment, then move. A quick swipe still scrolls the page.
const HOLD_MS = 260, HOLD_SLOP = 9, EDGE = 72;
let touch = null;      // { el, x, y, timer, active, clone, dx, dy, scroller }

function touchEnd(drop) {
  if (!touch) return;
  clearTimeout(touch.timer);
  clearInterval(touch.scroller);
  const was = touch;
  touch = null;
  if (!was.active) return;
  was.clone.remove();
  document.body.classList.remove('touch-dragging');
  const under = document.elementFromPoint(was.x, was.y);
  if (drop && subDrag) subDrop(under, was.y);
  else if (drop && evDrag) evDrop(under);
  else if (drop && drag && task(drag.id)) dragDrop(under, was.y);
  document.querySelectorAll('[data-cday].over').forEach(x => x.classList.remove('over'));
  drag = null; subDrag = null; evDrag = null;
  render();
}

function touchLift() {
  const el = touch.el, r = el.getBoundingClientRect();
  touch.active = true;
  if (el.dataset.subrow) subDrag = { id: +el.dataset.subrow, i: +el.dataset.i };
  else if (el.dataset.ev) { const ev = findEvent(+el.dataset.ev); evDrag = { id: ev.id, off: daysBetween(ev.from, el.dataset.day) }; }
  else drag = { id: +el.dataset.id, off: el.dataset.blk ? Math.round((touch.y - r.top) / H * 60) : 0 };
  const c = el.cloneNode(true);
  c.classList.add('drag-clone');
  c.removeAttribute('data-id'); c.removeAttribute('data-ev'); c.removeAttribute('data-act');
  c.style.width = r.width + 'px';
  c.style.height = r.height + 'px';
  touch.dx = touch.x - r.left; touch.dy = touch.y - r.top;
  c.style.left = r.left + 'px'; c.style.top = r.top + 'px';
  document.body.appendChild(c);
  touch.clone = c;
  el.classList.add('dragging');
  document.body.classList.add('touch-dragging');
  if (navigator.vibrate) navigator.vibrate(12);
  // near the top or bottom edge the page scrolls, so a task can travel to a list that is off screen
  touch.scroller = setInterval(() => {
    const step = touch.y < EDGE ? -14 : touch.y > innerHeight - EDGE ? 14 : 0;
    if (!step) return;
    scrollBy(0, step);
    const under = document.elementFromPoint(touch.x, touch.y);
    if (evDrag) evMove(under); else (subDrag ? subMove : dragMove)(under, touch.y);
  }, 16);
}

document.addEventListener('touchstart', e => {
  if (touch) { touchEnd(false); return; }          // a second finger cancels
  if (e.touches.length !== 1 || editing || drag || subDrag || evDrag) return;
  const el = e.target.closest('[data-id][draggable="true"], [data-subrow], [data-ev][draggable="true"]');
  if (!el || e.target.closest('button, input, [data-rs]')) return;   // buttons keep their tap
  // in a phone's month view events are dots, and a tap shows the week: nothing to drag there
  if (el.dataset.ev && (!findEvent(+el.dataset.ev) || (VIEW === 'month' && narrow()))) return;
  const p = e.touches[0];
  touch = { el: el, x: p.clientX, y: p.clientY, active: false, timer: setTimeout(touchLift, HOLD_MS) };
}, { passive: true });

document.addEventListener('touchmove', e => {
  if (!touch) return;
  const p = e.touches[0];
  if (!touch.active) {                              // moved before the hold was up: it is a scroll
    if (Math.hypot(p.clientX - touch.x, p.clientY - touch.y) > HOLD_SLOP) touchEnd(false);
    return;
  }
  e.preventDefault();
  touch.x = p.clientX; touch.y = p.clientY;
  touch.clone.style.left = (p.clientX - touch.dx) + 'px';
  touch.clone.style.top = (p.clientY - touch.dy) + 'px';
  const under = document.elementFromPoint(p.clientX, p.clientY);
  if (subDrag) { subMove(under, p.clientY); return; }
  if (evDrag) { evMove(under); return; }
  touch.clone.classList.toggle('faint', !!(under && under.closest('#tl')));   // keep the landing time readable
  dragMove(under, p.clientY);
}, { passive: false });

document.addEventListener('touchend', () => touchEnd(true));
document.addEventListener('touchcancel', () => touchEnd(false));
document.addEventListener('contextmenu', e => { if (touch) e.preventDefault(); });   // no long-press menu mid-drag

// ---------- resize a block from its bottom edge (mouse or finger) ----------
function resizeStart(t, y0) {
  const d0 = t.dur;
  return {
    move(y) {
      const d = Math.max(SNAP, Math.round((d0 + (y - y0) / H * 60) / SNAP) * SNAP);
      if (d !== t.dur && !conflict(t.start, d)) { t.dur = d; render(); }
    },
    end() { if (t.dur !== d0) save(t, { dur: t.dur }); }
  };
}

document.addEventListener('mousedown', e => {
  const id = e.target.dataset && e.target.dataset.rs;
  if (!id || !task(+id)) return;
  e.preventDefault();
  const rs = resizeStart(task(+id), e.clientY);
  const move = ev => rs.move(ev.clientY);
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    rs.end();
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
});

document.addEventListener('touchstart', e => {
  const h = e.target, id = h.dataset && h.dataset.rs;
  if (!id || !task(+id) || e.touches.length !== 1) return;
  const rs = resizeStart(task(+id), e.touches[0].clientY);
  // Re-drawing replaces the handle, but a touch keeps reporting to the element it started on,
  // so the listeners go on that element instead of the document.
  const move = ev => { ev.preventDefault(); rs.move(ev.touches[0].clientY); };
  const up = () => {
    h.removeEventListener('touchmove', move);
    h.removeEventListener('touchend', up);
    h.removeEventListener('touchcancel', up);
    rs.end();
  };
  h.addEventListener('touchmove', move, { passive: false });
  h.addEventListener('touchend', up);
  h.addEventListener('touchcancel', up);
}, { passive: true });

// ---------- settings ----------
function showCalState(calendars) {
  const on = S.calendarConnected;
  $('cal-state').textContent = on
    ? '✓ Connected.' + (calendars && calendars.length ? ' Reading: ' + calendars.join(', ') + '.' : '')
    : '';
  $('cal-state').hidden = !on;
  $('cal-setup').hidden = on;
  $('cal-on').hidden = !on;
  // a script pasted before the Calendar page existed cannot read a whole month: say so, and show how to update it
  const sy = S.sync || {};
  const old = on && !!((CP.google && CP.google.needsUpdate) || sy.needsUpdate);
  $('auto-sync').checked = !!sy.auto;
  const l = sy.last;
  $('sync-last').textContent = l ? 'Last brought up to date ' + new Date(l.at * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    + ': ' + l.created + ' added, ' + l.updated + ' changed, ' + l.removed + ' removed.' : 'Not brought up to date yet.';
  $('cal-old').hidden = !old;
  if (old) $('cal-update').open = true;
}

// the script is wanted when connecting, and again when connected to update it
async function loadBridgeCode() {
  if ($('bridge-code').value) return;
  try { const d = await api('bridge_code'); $('bridge-code').value = d.code; }
  catch (err) { toast(err.message); }
}

function openSettings() {
  const hours = (sel, from, to, val) => {
    let o = '';
    for (let i = from; i <= to; i++) o += `<option value="${i}" ${i === val ? 'selected' : ''}>${String(i).padStart(2, '0')}:00</option>`;
    $(sel).innerHTML = o;
  };
  hours('set-start', 0, 20, S.settings.dayStart);
  hours('set-end', 4, 24, S.settings.dayEnd);
  $('whoami').textContent = S.local ? 'Running on this computer. No sign-in needed.' : 'Signed in as ' + S.user;
  showCalState();
  $('copied').hidden = true; $('copied-again').hidden = true; $('cal-error').hidden = true;
  $('settings').showModal();
  loadBridgeCode();
}

// a click on the dimmed area around the settings closes them
$('settings').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$('auto-sync').addEventListener('change', async e => {
  try {
    const d = await api('auto_sync', { on: e.target.checked });
    S.sync = d.sync;
    if (S.sync.auto) runSync(false);
  } catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
});

// ---------- start ----------
showPage();
startDay();
setInterval(() => {                         // keeps the "now" line moving, and the calendar's today mark after midnight
  if (drag || subDrag || evDrag || editing) return;
  if (PAGE === 'day') renderTimeline();
  else if (shownToday !== dayStr(new Date())) renderCalendar();
}, 60000);
document.addEventListener('visibilitychange', () => {                              // new day or stale tab: reload
  const a = document.activeElement;
  if (document.hidden || drag || subDrag || evDrag || editing || $('event-dlg').open || $('gev-dlg').open || (a && a.matches('.subadd, .notes'))) return;
  startDay();
});
// the month grid shows dots instead of titles on a narrow screen
matchMedia('(max-width: 1000px)').addEventListener('change', () => { if (PAGE === 'calendar') renderCalendar(); });
