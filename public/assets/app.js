/* Planner board: brain dump, today's 3, timebox. No dependencies. */
'use strict';

const H = 52, SNAP = 15, DURS = [15, 30, 45, 60, 90, 120, 180];
const PALETTE = ['#f2a7b8', '#8fc79a', '#f0b27a', '#85a9e0', '#c9a0dc', '#e8c468'];
const csrf = document.querySelector('meta[name=csrf]').content;
const $ = id => document.getElementById(id);

let S = { projects: [], tasks: [], settings: { dayStart: 7, dayEnd: 20 }, calendarConnected: false, user: '', local: false };
let CAL = { connected: false, events: [], allDay: [], loading: false };
let DAY = dayStr(new Date());
let drag = null;       // { id, off } while a task is being dragged
let editing = false;   // true while a title is being renamed (pauses re-rendering)

// ---------- helpers ----------
function dayStr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function dayDate(s) { const p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function shiftDay(s, n) { const d = dayDate(s); d.setDate(d.getDate() + n); return dayStr(d); }
const hm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const durTxt = m => m < 60 ? m + ' m' : (m % 60 ? Math.floor(m / 60) + ' h ' + m % 60 : m / 60 + ' h');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeColor = c => /^#[0-9a-f]{6}$/i.test(c || '') ? c : '#d8d2c6';
const proj = id => S.projects.find(p => p.id === id) || { id: null, name: 'No project', color: '#d8d2c6' };
const task = id => S.tasks.find(t => t.id === id);
const startMin = () => S.settings.dayStart * 60;
const endMin = () => S.settings.dayEnd * 60;
function ink(hex) {
  const m = /^#(..)(..)(..)$/.exec(hex);
  if (!m) return '#2b2a27';
  const l = (.299 * parseInt(m[1], 16) + .587 * parseInt(m[2], 16) + .114 * parseInt(m[3], 16)) / 255;
  return l > .55 ? '#2b2a27' : '#fff';
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
    const d = await api('state', null, { day: DAY });
    S = d;
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
function conflict(id, s, d) {
  if (s < startMin() || s + d > endMin()) return 'Outside your day hours';
  for (const b of booked()) if (s < b.e && s + d > b.s) return 'Booked: ' + b.title;
  for (const t of scheduled()) if (t.id !== id && s < t.start + t.dur && s + d > t.start) return 'Overlaps another block';
  return '';
}

function freeMinutes() {
  const spans = booked().map(b => [b.s, b.e]).concat(scheduled().map(t => [Math.max(t.start, startMin()), Math.min(t.start + t.dur, endMin())]))
    .filter(x => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  let used = 0, cur = -1;
  for (const [s, e] of spans) { if (e <= cur) continue; used += e - Math.max(s, cur); cur = e; }
  return Math.max(0, endMin() - startMin() - used);
}

// ---------- changes ----------
function update(t, patch) {
  Object.assign(t, patch);
  render();
  api('task_update', { id: t.id, patch: patch }).then(d => { Object.assign(t, d.task); }).catch(saveFailed);
}

async function addTask(title, p) {
  try {
    const d = await api('task_add', { title: title, p: p });
    S.tasks.push(d.task); render();
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
    if (t.start === null || !conflict(t.id, t.start, d)) { update(t, { dur: d }); return; }
  }
}

function toggleDone(t) {
  const patch = { done: !t.done };
  if (patch.done && t.where === 'dump') { patch.where = 'also'; patch.day = DAY; }
  update(t, patch);
}

function removeTask(t) {
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
    const d = await api('task_add', { title: old.title, p: old.p });
    const patch = { dur: old.dur };
    if (old.where !== 'dump') {
      const same = old.day === DAY;
      const slotFree = same && !dayTasks().some(x => x.where === 'top' && x.slot === old.slot);
      patch.day = old.day;
      patch.where = old.where === 'top' && slotFree ? 'top' : 'also';
      if (patch.where === 'top') patch.slot = old.slot;
      if (same && old.start !== null && !conflict(0, old.start, old.dur)) patch.start = old.start;
      if (old.done) patch.done = true;
    }
    await api('task_update', { id: d.task.id, patch: patch });
  } catch (err) { toast(err.message); }
  loadState();
}

// ---------- rendering ----------
function card(t) {
  const p = proj(t.p);
  return `<div class="item ${t.done ? 'done' : ''}" draggable="true" data-id="${t.id}">
    <button class="check ${t.done ? 'on' : ''}" data-act="done" data-id="${t.id}" title="Done">✓</button>
    <button class="dot" style="background:${safeColor(p.color)}" title="${esc(p.name)} (click to change)" data-act="proj" data-id="${t.id}"></button>
    <span class="t" title="${esc(t.title)} (double-click to rename)" data-title="${t.id}">${esc(t.title)}</span>
    ${t.carried && t.where === 'dump' ? '<span class="carried" title="Left over from an earlier day">carried</span>' : ''}
    ${t.start !== null ? `<span class="at">${hm(t.start)}</span>` : ''}
    <button class="dur" title="Click to change length" data-act="dur" data-id="${t.id}">${durTxt(t.dur)}</button>
    <button class="x" title="Delete" data-act="del" data-id="${t.id}">×</button></div>`;
}

function renderLists() {
  $('z-dump').innerHTML = S.tasks.filter(t => t.where === 'dump').map(card).join('');
  $('z-also').innerHTML = dayTasks().filter(t => t.where === 'also').map(card).join('');
  let top = '';
  for (let i = 0; i < 3; i++) {
    const t = dayTasks().find(x => x.where === 'top' && x.slot === i);
    if (!t) { top += `<div class="slot empty" data-slot="${i}">Drag main task ${i + 1} here</div>`; continue; }
    const p = proj(t.p);
    top += `<div class="slot ${t.done ? 'done' : ''}" draggable="true" data-id="${t.id}" data-slot="${i}" style="border-left-color:${safeColor(p.color)}">
      <span class="n">${i + 1}</span><div class="body"><b title="${esc(t.title)} (double-click to rename)" data-title="${t.id}">${esc(t.title)}</b>
      <span class="meta">${esc(p.name)} · <button class="dur" data-act="dur" data-id="${t.id}">${durTxt(t.dur)}</button>${t.start !== null ? `<span class="at">${hm(t.start)}</span>` : '<span>not scheduled yet</span>'}</span></div>
      <button class="check ${t.done ? 'on' : ''}" data-act="done" data-id="${t.id}" title="Done">✓</button></div>`;
  }
  $('top3').innerHTML = top;
}

function renderProjects() {
  const sel = $('newp'), keep = sel.value;
  sel.innerHTML = S.projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  if (keep) sel.value = keep;
  $('projects').innerHTML = S.projects.map(p => `<div class="proj">
    <input type="color" value="${safeColor(p.color)}" data-pcolor="${p.id}" title="Project color">
    <input type="text" value="${esc(p.name)}" data-pname="${p.id}" maxlength="60">
    <button class="x" title="Delete project (its tasks stay)" data-act="del-project" data-id="${p.id}">×</button></div>`).join('');
}

function renderTimeline() {
  const s0 = startMin();
  let h = '';
  for (let i = S.settings.dayStart; i < S.settings.dayEnd; i++) h += `<div class="hr"><i>${String(i).padStart(2, '0')}:00</i></div>`;
  h += booked().map(b => `<div class="blk booked" title="${esc(b.title)} · ${esc(b.calendar)}" style="top:${(b.s - s0) / 60 * H + 1}px;height:${(b.e - b.s) / 60 * H - 2}px">🔒 ${esc(b.title)}<small>${hm(b.s)}–${hm(b.e)}</small></div>`).join('');
  h += scheduled().map(t => {
    const p = proj(t.p), c = safeColor(p.color), n = t.where === 'top' ? ['①', '②', '③'][t.slot] + ' ' : '';
    const top = Math.max(t.start, s0), end = Math.min(t.start + t.dur, endMin());
    if (end <= top) return '';
    return `<div class="blk ${t.done ? 'done' : ''}" draggable="true" data-id="${t.id}" data-blk="1" title="${esc(t.title)}" style="top:${(top - s0) / 60 * H + 1}px;height:${(end - top) / 60 * H - 2}px;background:${c};color:${ink(c)}">${n}${esc(t.title)}<small>${hm(t.start)}–${hm(t.start + t.dur)}</small><button class="x" title="Take off the timeline" data-act="unschedule" data-id="${t.id}">×</button><span class="rs" data-rs="${t.id}"></span></div>`;
  }).join('');
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  if (DAY === dayStr(now) && nowMin >= s0 && nowMin <= endMin()) h += `<div class="now" style="top:${(nowMin - s0) / 60 * H}px"></div>`;
  h += '<div class="ghost" id="ghost"></div>';
  $('tl').innerHTML = h;
  $('allday').innerHTML = CAL.allDay.map(e => `<span class="chip" title="${esc(e.calendar)}">All day: ${esc(e.title)}</span>`).join('');
  $('tlhint').textContent = S.calendarConnected
    ? "Striped blocks come from your calendar and can't be planned over."
    : 'Your calendar is not connected yet, so booked time is not shown. Connect it in Settings (⚙).';
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
  renderTimeline();
  renderHeader();
}

// ---------- clicks ----------
const actions = {
  prev() { goDay(shiftDay(DAY, -1)); },
  next() { goDay(shiftDay(DAY, 1)); },
  today() { goDay(dayStr(new Date())); },
  proj(t) { cycleProject(t); },
  dur(t) { cycleDur(t); },
  done(t) { toggleDone(t); },
  del(t) { removeTask(t); },
  unschedule(t) { update(t, { start: null }); },
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
      const d = await api('project_add', { name: 'New project', color: PALETTE[S.projects.length % PALETTE.length] });
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
  if (fn) fn(el.dataset.id ? task(+el.dataset.id) : null, el);
});

// The password fields sit in a real form so Chrome keeps saved logins out of the task box.
// It must never post the page: the Change button and Enter both go through the API.
$('pw-form')?.addEventListener('submit', e => { e.preventDefault(); actions['change-pw'](); });

// rename on double-click
document.addEventListener('dblclick', e => {
  const el = e.target.closest('[data-title]');
  if (!el || editing) return;
  const t = task(+el.dataset.title);
  if (!t) return;
  editing = true;
  const inp = document.createElement('input');
  inp.className = 'edit'; inp.value = t.title; inp.maxLength = 300;
  el.replaceWith(inp); inp.focus(); inp.select();
  const holder = inp.closest('[draggable]');
  if (holder) holder.draggable = false;
  let finished = false;
  const finish = save => {
    if (finished) return;
    finished = true; editing = false;
    const v = inp.value.trim();
    if (save && v && v !== t.title) update(t, { title: v }); else render();
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
document.addEventListener('dragend', () => { drag = null; render(); });

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
    const t = task(drag.id), s = dropTime(y), bad = conflict(t.id, s, t.dur);
    g.style.display = 'block';
    g.style.top = ((s - startMin()) / 60 * H + 1) + 'px';
    g.style.height = (t.dur / 60 * H - 2) + 'px';
    g.className = 'ghost' + (bad ? ' bad' : '');
    g.textContent = bad || hm(s) + '–' + hm(s + t.dur);
    return true;
  }
  if (g) g.style.display = 'none';
  const z = target && target.closest('[data-zone],[data-slot]');
  if (z) z.classList.add('over');
  return !!z;
}

/** Puts the dragged task where it was let go. */
function dragDrop(target, y) {
  const t = task(drag.id);
  if (!t || !target) return;
  if (target.closest('#tl')) {
    const s = dropTime(y), bad = conflict(t.id, s, t.dur);
    if (bad) { toast(bad + '. Pick a free gap.'); return; }
    const patch = { start: s, day: DAY };
    if (t.where === 'dump') patch.where = 'also';
    update(t, patch);
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
  if (!drag || !task(drag.id)) return;
  if (dragMove(e.target, e.clientY)) e.preventDefault();
});

document.addEventListener('drop', e => {
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
  if (drop && task(drag.id)) dragDrop(document.elementFromPoint(was.x, was.y), was.y);
  drag = null;
  render();
}

function touchLift() {
  const el = touch.el, r = el.getBoundingClientRect();
  touch.active = true;
  drag = { id: +el.dataset.id, off: el.dataset.blk ? Math.round((touch.y - r.top) / H * 60) : 0 };
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
    dragMove(document.elementFromPoint(touch.x, touch.y), touch.y);
  }, 16);
}

document.addEventListener('touchstart', e => {
  if (touch) { touchEnd(false); return; }          // a second finger cancels
  if (e.touches.length !== 1 || editing || drag) return;
  const el = e.target.closest('[data-id][draggable="true"]');
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
      if (d !== t.dur && !conflict(t.id, t.start, d)) { t.dur = d; render(); }
    },
    end() { if (t.dur !== d0) api('task_update', { id: t.id, patch: { dur: t.dur } }).catch(saveFailed); }
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
setInterval(() => { if (!drag && !editing) renderTimeline(); }, 60000);          // keeps the "now" line moving
document.addEventListener('visibilitychange', () => {                              // new day or stale tab: reload
  if (document.hidden || drag || editing) return;
  startDay();
});
