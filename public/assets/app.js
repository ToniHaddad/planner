/* Planner board: brain dump, today's 3, timebox. No dependencies. */
'use strict';

const H = 52, SNAP = 15, DURS = [15, 30, 45, 60, 90, 120, 180];
const PALETTE = ['#3ca9e1', '#5dbe53', '#fc981e', '#b1a4d9', '#ee483c', '#f6bf1a'];
const csrf = document.querySelector('meta[name=csrf]').content;
const $ = id => document.getElementById(id);

let S = { boards: [], board: 0, projects: [], tasks: [], settings: { dayStart: 7, dayEnd: 20 }, calendarConnected: false, user: '', local: false };
let CAL = { connected: false, events: [], allDay: [], loading: false };
let DAY = dayStr(new Date());
let BOARD = 0;         // the board being shown; 0 until the server says which exist (the choice is kept per device)
try { BOARD = +localStorage.getItem('planner_board') || 0; } catch (e) { /* private window */ }
let drag = null;       // { id, off } while a task is being dragged
let subDrag = null;    // { id, i } while a subtask is being dragged to a new place in its list
let editing = false;   // true while a title is being renamed (pauses re-rendering)
const open = new Set(); // ids of the tasks whose subtasks and notes are showing

// ---------- helpers ----------
function dayStr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function dayDate(s) { const p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function shiftDay(s, n) { const d = dayDate(s); d.setDate(d.getDate() + n); return dayStr(d); }
const hm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const durTxt = m => m < 60 ? m + ' m' : (m % 60 ? Math.floor(m / 60) + ' h ' + m % 60 : m / 60 + ' h');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeColor = c => /^#[0-9a-f]{6}$/i.test(c || '') ? c : '#8f8ab8';
const proj = id => S.projects.find(p => p.id === id) || { id: null, name: 'No project', color: '#8f8ab8' };
const task = id => S.tasks.find(t => t.id === id);
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
  loadCalendar(false);
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
  S.board = id; S.tasks = []; S.projects = [];
  open.clear();
  render();
  loadState();
}

function goDay(day) {
  DAY = day;
  CAL = { connected: S.calendarConnected, events: [], allDay: [], loading: S.calendarConnected };
  S.tasks = S.tasks.filter(t => t.where === 'dump');
  render();
  loadState().then(() => loadCalendar(false));
}

// ---------- planning rules ----------
/** Busy time from the calendar, clipped to the visible day. */
function booked() {
  return CAL.events.map(e => ({ s: Math.max(e.start, startMin()), e: Math.min(e.end, endMin()), title: e.title, calendar: e.calendar }))
    .filter(b => b.e > b.s);
}
const dayTasks = () => S.tasks.filter(t => t.day === DAY);
const scheduled = () => dayTasks().filter(t => t.start !== null);

/** Why a block cannot go there, or '' when it can. */
function conflict(s, d) {
  if (s < startMin() || s + d > endMin()) return 'Outside your day hours';
  for (const b of booked()) if (s < b.e && s + d > b.s) return 'Booked: ' + b.title;
  return '';
}

/**
 * Tasks may share a time. Those that do sit side by side: returns, for each task id, its
 * column and how many columns its group of overlapping tasks needs.
 */
function lanes(list) {
  const out = new Map();
  let group = [], ends = [], groupEnd = -1;
  const close = () => { group.forEach(t => { out.get(t.id).cols = ends.length; }); group = []; ends = []; };
  list.slice().sort((a, b) => a.start - b.start || a.id - b.id).forEach(t => {
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
  const spans = booked().map(b => [b.s, b.e]).concat(scheduled().map(t => [Math.max(t.start, startMin()), Math.min(t.start + t.dur, endMin())]))
    .filter(x => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  let used = 0, cur = -1;
  for (const [s, e] of spans) { if (e <= cur) continue; used += e - Math.max(s, cur); cur = e; }
  return Math.max(0, endMin() - startMin() - used);
}

// ---------- changes ----------
/** Sends a change. The answer is only taken over if nothing newer has changed the task meanwhile. */
function save(t, patch) {
  const rev = t.rev = (t.rev || 0) + 1;
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
    .then(() => toast('Task deleted.', { label: 'Undo', run() { restoreTask(t); } }))
    .catch(saveFailed);
}

/**
 * Undo for a delete: adds the task again where it was. If its place was taken in the
 * meantime (the slot in Today's 3, or its time on the timeline), it comes back without it.
 */
async function restoreTask(old) {
  try {
    const d = await api('task_add', { title: old.title, p: old.p, board: old.board });
    const patch = { dur: old.dur, notes: old.notes || '', subs: old.subs || [] };
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

/** The panel under a task: its subtasks, a box to add one, and its notes. */
function details(t) {
  if (!open.has(t.id)) return '';
  return `<div class="details" data-details="${t.id}">
    <ul class="subs">${t.subs.map((s, i) => `<li class="${s.done ? 'done' : ''}" draggable="true" data-subrow="${t.id}" data-i="${i}">
      <button class="check ${s.done ? 'on' : ''}" data-act="sub-done" data-id="${t.id}" data-i="${i}" title="Done">✓</button>
      <span data-sub="${t.id}" data-i="${i}" title="Drag to reorder, double-click to rename">${esc(s.title)}</span>
      <button class="x" title="Delete subtask" data-act="sub-del" data-id="${t.id}" data-i="${i}">×</button></li>`).join('')}</ul>
    <input class="subadd" type="text" name="subtask" data-subadd="${t.id}" placeholder="Add a subtask and press Enter…" aria-label="New subtask" autocomplete="off" maxlength="300">
    <textarea class="notes" name="notes" data-notes="${t.id}" placeholder="Notes…" aria-label="Notes" rows="2" maxlength="5000">${esc(t.notes)}</textarea>
  </div>`;
}

function card(t) {
  const p = proj(t.p);
  return `<div class="task"><div class="item ${t.done ? 'done' : ''}" draggable="true" data-id="${t.id}" style="border-left-color:${safeColor(p.color)}">
    <button class="check ${t.done ? 'on' : ''}" data-act="done" data-id="${t.id}" title="Done">✓</button>
    <button class="dot" style="background:${safeColor(p.color)}" title="${esc(p.name)} (click to change)" data-act="proj" data-id="${t.id}"></button>
    <span class="t" title="${esc(t.title)} (double-click to rename)" data-title="${t.id}">${esc(t.title)}</span>
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
      <span class="meta">${esc(p.name)} · <button class="dur" data-act="dur" data-id="${t.id}">${durTxt(t.dur)}</button>${t.start !== null ? `<span class="at">${hm(t.start)}</span>` : '<span>not scheduled yet</span>'}${moreBtn(t)}</span></div>
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
  h += booked().map(b => `<div class="blk booked" title="${esc(b.title)} · ${esc(b.calendar)}" style="top:${(b.s - s0) / 60 * H + 1}px;height:${(b.e - b.s) / 60 * H - 2}px">🔒 ${esc(b.title)}<small>${hm(b.s)}–${hm(b.e)}</small></div>`).join('');
  const lane = lanes(scheduled());
  h += scheduled().map(t => {
    const p = proj(t.p), c = safeColor(p.color), n = t.where === 'top' ? ['①', '②', '③'][t.slot] + ' ' : '';
    const l = lane.get(t.id), side = l.cols > 1 ? `left:calc(8px + (100% - 16px) * ${l.col} / ${l.cols});right:auto;width:calc((100% - 16px) / ${l.cols} - ${l.col < l.cols - 1 ? 3 : 0}px);` : '';
    const top = Math.max(t.start, s0), end = Math.min(t.start + t.dur, endMin());
    if (end <= top) return '';
    return `<div class="blk ${t.done ? 'done' : ''}" draggable="true" data-id="${t.id}" data-blk="1" title="${esc(t.title)}" style="top:${(top - s0) / 60 * H + 1}px;height:${(end - top) / 60 * H - 2}px;${side}background-color:${c};color:${ink(c)}">${n}${esc(t.title)}<small>${hm(t.start)}–${hm(t.start + t.dur)}</small>${hasMore(t) ? `<small>${moreLabel(t)}</small>` : ''}<button class="x" title="Take off the timeline" data-act="unschedule" data-id="${t.id}">×</button><span class="rs" data-rs="${t.id}"></span></div>`;
  }).join('');
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  if (DAY === dayStr(now) && nowMin >= s0 && nowMin <= endMin()) h += `<div class="now" style="top:${(nowMin - s0) / 60 * H}px"></div>`;
  h += '<div class="ghost" id="ghost"></div>';
  $('tl').innerHTML = h;
  $('allday').innerHTML = CAL.allDay.map(e => `<span class="chip" title="${esc(e.calendar)}">All day: ${esc(e.title)}</span>`).join('');
  $('tlhint').textContent = S.calendarConnected
    ? "Striped blocks come from your calendar and can't be planned over. Your own tasks can share a time: they sit side by side."
    : 'Tasks can share a time: they sit side by side. Your calendar is not connected yet, so booked time is not shown. Connect it in Settings (⚙).';
  $('push').hidden = !S.calendarConnected;
}

function renderCalStatus() {
  const el = $('calstat');
  el.className = 'calstat' + (CAL.error ? ' bad' : '');
  if (!S.calendarConnected) { el.innerHTML = '<button class="btn go" data-act="settings-open">Connect Google Calendar</button>'; return; }
  let txt = 'Calendar';
  if (CAL.loading) txt = 'Reading calendar…';
  else if (CAL.error) txt = 'Calendar problem';
  else if (CAL.fetchedAt) { const d = new Date(CAL.fetchedAt * 1000); txt = 'Calendar read ' + hm(d.getHours() * 60 + d.getMinutes()); }
  el.innerHTML = `<span title="${esc(CAL.error || '')}">${esc(txt)}</span><button class="btn small" data-act="refresh-cal" title="Read the calendar again" aria-label="Read the calendar again">↻</button>`;
}

function renderHeader() {
  const d = dayDate(DAY), today = dayStr(new Date());
  const rel = DAY === today ? 'Today · ' : DAY === shiftDay(today, 1) ? 'Tomorrow · ' : DAY === shiftDay(today, -1) ? 'Yesterday · ' : '';
  $('dayname').textContent = rel + d.toLocaleDateString(undefined, { weekday: 'long' });
  $('daydate').textContent = d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  $('free').textContent = durTxt(freeMinutes()) + ' still free';
  renderCalStatus();
}

function render(skipProjects) {
  if (editing) return;
  renderLists();
  if (!skipProjects) renderProjects();
  renderBoards();
  renderTimeline();
  renderHeader();
}

// ---------- clicks ----------
const actions = {
  prev() { goDay(shiftDay(DAY, -1)); },
  next() { goDay(shiftDay(DAY, 1)); },
  today() { goDay(dayStr(new Date())); },
  board(_, btn) { goBoard(+btn.dataset.board); },
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
  'sub-del'(t, btn) { update(t, { subs: t.subs.filter((s, k) => k !== +btn.dataset.i) }); },
  theme(_, btn) {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    document.querySelector('meta[name=color-scheme]').content = next;
    btn.textContent = next === 'light' ? '☾' : '☀';
    document.cookie = 'planner_theme=' + next + ';path=/;max-age=34560000;samesite=strict';
  },
  'refresh-cal'() { loadCalendar(true); },
  async push(_, btn) {
    if (!S.calendarConnected) { openSettings(); toast('Connect your calendar first.'); return; }
    btn.disabled = true;
    try {
      const r = await api('calendar_push', { day: DAY });
      toast(r.created ? r.created + ' block' + (r.created === 1 ? '' : 's') + ' sent to your Planner calendar.' : 'Nothing is on the timeline; the Planner calendar is clear for this day.');
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
    try { await navigator.clipboard.writeText(ta.value); $('copied').hidden = false; toast('Script copied. Next: paste it into Apps Script (step 2).'); }
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
    } catch (err) { box.textContent = err.message + ' See “It didn’t connect” below.'; box.hidden = false; }
    btn.disabled = false; btn.textContent = 'Connect';
  },
  async 'disconnect-cal'() {
    if (!confirm('Disconnect the calendar? Your tasks stay; calendar events stop showing until you connect again.')) return;
    try { await api('calendar_disconnect', {}); S.calendarConnected = false; showCalState(); loadBridgeCode(); loadCalendar(false); }
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

// subtasks and notes
document.addEventListener('keydown', e => {
  const id = e.target.dataset && e.target.dataset.subadd;
  if (!id || e.key !== 'Enter') return;
  const t = task(+id), v = e.target.value.trim();
  if (!t || !v) return;
  if (t.subs.length >= 50) { toast('A task holds up to 50 subtasks.'); return; }
  e.target.value = '';
  update(t, { subs: t.subs.concat({ title: v, done: false }) });
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

// the password boxes sit in a form (so the browser files them correctly); it is sent from here
document.addEventListener('submit', e => {
  e.preventDefault();
  if (e.target.id === 'pw-form') actions['change-pw']();
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

$('new').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const v = e.target.value.trim();
  if (!v) return;
  e.target.value = '';
  addTask(v, $('newp').value ? +$('newp').value : null);
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
    api('board_update', { id: b.id, name: name }).then(d => { S.boards = d.boards; renderBoards(); }).catch(saveFailed);
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
  else if (drop && task(drag.id)) dragDrop(under, was.y);
  drag = null; subDrag = null;
  render();
}

function touchLift() {
  const el = touch.el, r = el.getBoundingClientRect();
  touch.active = true;
  if (el.dataset.subrow) subDrag = { id: +el.dataset.subrow, i: +el.dataset.i };
  else drag = { id: +el.dataset.id, off: el.dataset.blk ? Math.round((touch.y - r.top) / H * 60) : 0 };
  const c = el.cloneNode(true);
  c.classList.add('drag-clone');
  c.removeAttribute('data-id');
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
    (subDrag ? subMove : dragMove)(document.elementFromPoint(touch.x, touch.y), touch.y);
  }, 16);
}

document.addEventListener('touchstart', e => {
  if (touch) { touchEnd(false); return; }          // a second finger cancels
  if (e.touches.length !== 1 || editing || drag || subDrag) return;
  const el = e.target.closest('[data-id][draggable="true"], [data-subrow]');
  if (!el || e.target.closest('button, input, [data-rs]')) return;   // buttons keep their tap
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
    ? '✓ Connected.' + (calendars && calendars.length ? ' Reading: ' + calendars.join(', ') + '.' : '') + ' “Send to calendar” puts your time blocks in a Google calendar named “Planner”.'
    : '';
  $('cal-state').hidden = !on;
  $('cal-setup').hidden = on;
  $('cal-on').hidden = !on;
}

async function loadBridgeCode() {
  if (S.calendarConnected || $('bridge-code').value) return;
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
  $('copied').hidden = true; $('cal-error').hidden = true;
  $('settings').showModal();
  loadBridgeCode();
}

// a click on the dimmed area around the settings closes them
$('settings').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// ---------- start ----------
startDay();
setInterval(() => { if (!drag && !subDrag && !editing) renderTimeline(); }, 60000);          // keeps the "now" line moving
document.addEventListener('visibilitychange', () => {                              // new day or stale tab: reload
  const a = document.activeElement;
  if (document.hidden || drag || subDrag || editing || (a && a.matches('.subadd, .notes'))) return;
  startDay();
});
