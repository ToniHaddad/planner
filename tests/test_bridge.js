/*
 * Checks of the Apps Script bridge (public/lib/bridge.gs.txt) against fake Google services.
 *
 *     node tests/test_bridge.js
 *
 * The fakes follow Google's documented behaviour where it matters here (a popup reminder takes
 * 5 to 40320 minutes; an all-day end date is the day after the last; tags are strings). Time
 * zones are fixed offsets, so clock changes are not covered: those need a real Google account.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('ok   ' + name); } else { failed++; console.log('FAIL ' + name + ' ' + (detail || '')); }
}

// ---------- fake Google ----------
const OFFSETS = { UTC: 0, 'Test/Plus2': 120 };
function makeGoogle(tz) {
  const g = { tz: tz, calendars: [], props: {}, locked: false, ops: [], failReminder: false, nextId: 1 };
  const off = () => OFFSETS[g.tz] * 60000;
  const pad = n => String(n).padStart(2, '0');
  g.Utilities = {
    parseDate(s, zone, fmt) {
      const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s);
      if (!m || fmt !== 'yyyy-MM-dd HH:mm') throw new Error('parseDate ' + s);
      return new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) - OFFSETS[zone] * 60000);
    },
    formatDate(d, zone, fmt) {
      const t = new Date(d.getTime() + OFFSETS[zone] * 60000);
      if (fmt === 'yyyy-MM-dd') return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
      if (fmt === 'HH:mm') return pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes());
      throw new Error('formatDate ' + fmt);
    },
  };
  const dayStart = d => { const t = d.getTime() + off(); return new Date(t - (((t % 86400000) + 86400000) % 86400000) - off()); };
  function makeEvent(cal, title, start, end, allDay) {
    const ev = {
      cal: cal, title: title, start: start, end: end, allDay: allDay, tags: {}, reminders: [], color: null, id: 'ev' + (g.nextId++) + '@google.com',
      getTitle() { return this.title; }, getId() { return this.id; }, isAllDayEvent() { return this.allDay; },
      getStartTime() { return this.start; }, getEndTime() { return this.end; },
      getAllDayStartDate() { return this.start; }, getAllDayEndDate() { return this.end; },
      getMyStatus() { throw new Error('not a guest'); },
      getTag(k) { return Object.prototype.hasOwnProperty.call(this.tags, k) ? this.tags[k] : null; },
      setTag(k, v) { g.ops.push(['tag', k, this.title]); this.tags[k] = String(v); },
      deleteEvent() { g.ops.push(['delete', this.title]); cal.events = cal.events.filter(x => x !== this); },
      removeAllReminders() { this.reminders = []; },
      addPopupReminder(m) {
        if (g.failReminder || !(m >= 5 && m <= 40320)) throw new Error('Invalid argument: minutes');
        g.ops.push(['remind', m, this.title]); this.reminders.push(m);
      },
      setColor(c) { this.color = c; },
    };
    cal.events.push(ev);
    g.ops.push(['create', title]);
    return ev;
  }
  function makeCal(name, opts) {
    const cal = {
      name: name, id: 'cal' + (g.nextId++) + '@group.calendar.google.com', events: [], selected: true, hidden: false, color: '#3366cc',
      getName() { return this.name; }, setName(n) { this.name = n; }, getId() { return this.id; }, getColor() { return this.color; },
      isSelected() { return this.selected; }, isHidden() { return this.hidden; }, getTimeZone() { return g.tz; },
      getEvents(s, e) { return this.events.filter(ev => ev.start < e && ev.end > s); },
      createEvent(title, s, e) { return makeEvent(this, title, s, e, false); },
      createAllDayEvent(title, s, e) {
        const a = dayStart(s);
        return makeEvent(this, title, a, e instanceof Date ? dayStart(e) : new Date(a.getTime() + 86400000), true);
      },
    };
    g.calendars.push(cal);
    return cal;
  }
  g.makeCal = makeCal;
  g.CalendarApp = {
    GuestStatus: { NO: 'NO' },
    getAllCalendars: () => g.calendars.slice(),
    getDefaultCalendar: () => g.calendars[0],
    getCalendarById: id => g.calendars.find(c => c.id === id) || null,
    getCalendarsByName: n => g.calendars.filter(c => c.name === n),
    createCalendar: (n, o) => makeCal(n, o),
  };
  g.Session = { getScriptTimeZone: () => g.tz };
  g.PropertiesService = { getScriptProperties: () => ({
    getProperties: () => Object.assign({}, g.props),
    getProperty: k => (Object.prototype.hasOwnProperty.call(g.props, k) ? g.props[k] : null),
    setProperty: (k, v) => { g.props[k] = String(v); },
  }) };
  g.LockService = { getScriptLock: () => ({
    tryLock() { if (g.locked) return false; g.locked = true; this.mine = true; return true; },
    releaseLock() { if (this.mine) g.locked = false; },
  }) };
  g.ContentService = { MimeType: { JSON: 'json' }, createTextOutput: s => ({ setMimeType: () => JSON.parse(s) }) };
  return g;
}

const KEY = 'k'.repeat(64);
function load(tz) {
  const g = makeGoogle(tz);
  g.makeCal('Main');                                  // the person's own calendar
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'lib', 'bridge.gs.txt'), 'utf8').replace('__BRIDGE_KEY__', KEY);
  const ctx = vm.createContext({ Utilities: g.Utilities, CalendarApp: g.CalendarApp, Session: g.Session,
    PropertiesService: g.PropertiesService, LockService: g.LockService, ContentService: g.ContentService, Date: Date, JSON: JSON, Math: Math });
  vm.runInContext(code, ctx);
  g.post = body => vm.runInContext('doPost', ctx)({ postData: { contents: JSON.stringify(Object.assign({ key: KEY }, body)) } });
  g.get = params => vm.runInContext('doGet', ctx)({ parameter: Object.assign({ key: KEY }, params) });
  g.call = (fn, ...args) => vm.runInContext(fn, ctx)(...args);
  return g;
}

const timed = (key, title, date, start, dur, extra) => Object.assign({ key: key, title: title, description: '', allDay: false,
  date: date, start: start, dur: dur, color: null, remind: null }, extra || {});
const allDay = (key, title, from, to, extra) => Object.assign({ key: key, title: title, description: '', allDay: true,
  from: from, to: to, color: null, remind: null }, extra || {});
const sync = (g, items, from, to, boards) => g.post({ action: 'sync', from: from || '2026-11-22', to: to || '2027-01-07',
  boards: boards || [{ id: 1, name: 'Main', items: items }] });
const boardCal = (g, name) => g.calendars.find(c => c.name === (name || 'Planner Main'));
const byKey = (g, key, name) => boardCal(g, name).events.filter(e => e.tags.plannerKey === key);

// ---------- requests that are refused before anything is touched ----------
(function () {
  const g = load('UTC');
  check('bridge: a body that is not an object is refused', g.call('doPost', { postData: { contents: 'null' } }).error === 'forbidden'
    && g.call('doPost', { postData: { contents: '[1]' } }).error === 'forbidden' && g.call('doPost', null).error === 'forbidden');
  check('bridge: a GET without parameters is refused', g.call('doGet', null).error === 'forbidden' && g.call('doGet', {}).error === 'forbidden');
  check('bridge: a wrong key is refused', g.call('doPost', { postData: { contents: JSON.stringify({ key: 'x'.repeat(64), action: 'sync' }) } }).error === 'forbidden');
  check('bridge: an unknown action says so', g.post({ action: 'other' }).error === 'unknown action');
  const ok = [timed('task:1', 'A', '2026-11-23', 600, 30)];
  const bad = {
    'boards that are no list': { boards: { 0: {} } },
    'a board id of 0': { boards: [{ id: 0, name: 'Main', items: [] }] },
    'a board id that is no whole number': { boards: [{ id: 1.5, name: 'Main', items: [] }] },
    'two boards with one id': { boards: [{ id: 1, name: 'A', items: [] }, { id: 1, name: 'B', items: [] }] },
    'an empty board name': { boards: [{ id: 1, name: '  ', items: [] }] },
    'a board name of 61 characters': { boards: [{ id: 1, name: 'x'.repeat(61), items: [] }] },
    'items that are no list': { boards: [{ id: 1, name: 'Main', items: 'x' }] },
    'an item key like "constructor"': { boards: [{ id: 1, name: 'Main', items: [timed('constructor', 'A', '2026-11-23', 600, 30)] }] },
    'one key twice': { boards: [{ id: 1, name: 'Main', items: ok.concat(ok) }] },
    'a day that does not exist': { boards: [{ id: 1, name: 'Main', items: [timed('task:1', 'A', '2026-02-30', 600, 30)] }] },
    'a start of 1440': { boards: [{ id: 1, name: 'Main', items: [timed('task:1', 'A', '2026-11-23', 1440, 30)] }] },
    'a length of 0': { boards: [{ id: 1, name: 'Main', items: [timed('task:1', 'A', '2026-11-23', 600, 0)] }] },
    'an all-day item ending before it starts': { boards: [{ id: 1, name: 'Main', items: [allDay('event:1', 'A', '2026-11-25', '2026-11-24')] }] },
    'a reminder past 4 weeks': { boards: [{ id: 1, name: 'Main', items: [timed('task:1', 'A', '2026-11-23', 600, 30, { remind: 50000 })] }] },
    'a window that ends before it starts': { from: '2026-12-01', to: '2026-11-01', boards: [] },
  };
  Object.keys(bad).forEach(function (why) {
    const r = g.post(Object.assign({ action: 'sync', from: '2026-11-22', to: '2027-01-07' }, bad[why]));
    check('bridge: refused, nothing touched: ' + why, r.error === 'bad request' && g.calendars.length === 1 && g.ops.length === 0, JSON.stringify(r));
  });
  const old = g.makeCal('Planner');
  old.createEvent('Old block', new Date('2026-11-23T10:00:00Z'), new Date('2026-11-23T11:00:00Z')).setTag('planner', 'timebox');
  g.ops.length = 0;
  const r = g.post({ action: 'push', date: '2026-11-23', blocks: 'not a list' });
  check('bridge: push with blocks that are no list is refused before anything is deleted', r.error === 'bad request' && old.events.length === 1);
})();

// ---------- the lock ----------
(function () {
  const g = load('UTC');
  g.locked = true;
  const r = sync(g, [timed('task:1', 'A', '2026-11-23', 600, 30)]);
  check('bridge: while another update holds the lock, the answer is busy and nothing is written', r.error === 'busy' && g.calendars.length === 1);
  g.locked = false;
  const r2 = sync(g, [timed('task:1', 'A', '2026-11-23', 600, 30)]);
  check('bridge: the lock is free again after a run', r2.ok === true && g.locked === false, JSON.stringify(r2));
})();

// ---------- sync by difference ----------
(function () {
  const g = load('UTC');
  const old = g.makeCal('Planner');
  const block = (title, at) => old.createEvent(title, new Date(at), new Date(new Date(at).getTime() + 3600000)).setTag('planner', 'timebox');
  block('Old block in the window', '2026-11-24T09:00:00Z');
  block('Old block long ago', '2026-10-01T09:00:00Z');
  const items = [timed('task:1', 'Write', '2026-11-23', 540, 45, { remind: 0, color: '#ff7a59' }),
                 allDay('event:2', 'Fair', '2026-11-25', '2026-11-27', { remind: 900 }),
                 Object.assign(allDay('event:3', 'One day', null, null), { from: undefined, to: undefined, date: '2026-11-28' })];
  g.ops.length = 0;
  let r = sync(g, items);
  const cal = boardCal(g);
  check('bridge: the first sync makes the board calendar and every event', r.ok && r.created === 3 && r.updated === 0 && cal
    && cal.events.length === 3 && r.calendars[0].name === 'Planner Main', JSON.stringify(r));
  check('bridge: the board calendar is remembered by board id', g.props.board_1 === cal.id);
  const w = byKey(g, 'task:1')[0];
  check('bridge: a timed event starts and ends at its wall-clock times', w.start.toISOString() === '2026-11-23T09:00:00.000Z'
    && w.end.toISOString() === '2026-11-23T09:45:00.000Z');
  check('bridge: a reminder of 0 is sent to Google as 5 minutes', w.reminders.join() === '5', w.reminders.join());
  const fair = byKey(g, 'event:2')[0];
  check('bridge: an all-day event over three days ends, as Google wants, on the day after the last',
    fair.allDay && fair.start.toISOString().slice(0, 10) === '2026-11-25' && fair.end.toISOString().slice(0, 10) === '2026-11-28');
  check('bridge: an all-day item given by its date alone is one day long', byKey(g, 'event:3')[0].end - byKey(g, 'event:3')[0].start === 86400000);
  const order = g.ops.filter(o => o[2] === 'Write' || o[1] === 'Write').map(o => o[0] === 'tag' ? o[1] : o[0]);
  check('bridge: the key tag comes first after creating, the hash tag last', order.join() === 'create,plannerKey,remind,plannerHash', order.join());
  check('bridge: the old blocks go only once the new events are there, and only inside the window',
    old.events.map(e => e.title).join() === 'Old block long ago' && r.removed === 1 && g.ops.findIndex(o => o[0] === 'delete') > g.ops.findIndex(o => o[1] === 'plannerHash'));

  r = sync(g, items);
  check('bridge: nothing changed, nothing written', r.created === 0 && r.updated === 0 && r.removed === 0, JSON.stringify(r));

  g.ops.length = 0;
  items[0] = timed('task:1', 'Write the plan', '2026-11-23', 540, 45, { remind: 15 });
  r = sync(g, items);
  const ops = g.ops.map(o => o[0] + ':' + (o[0] === 'tag' ? o[1] : o[o.length - 1]));
  check('bridge: a changed item is written anew first, the old event deleted after', r.updated === 1 && byKey(g, 'task:1').length === 1
    && ops.indexOf('create:Write the plan') < ops.indexOf('delete:Write'), ops.join(' '));

  // an item that moves into the window from far away: the copy out there goes, wherever it sits
  const far = cal.createEvent('Later thing', new Date('2027-03-01T10:00:00Z'), new Date('2027-03-01T11:00:00Z'));
  far.setTag('plannerKey', 'task:9'); far.setTag('plannerHash', 'old');
  items.push(timed('task:9', 'Later thing', '2026-11-30', 600, 60));
  r = sync(g, items);
  check('bridge: an item moved in from outside the window replaces its old copy there', byKey(g, 'task:9').length === 1
    && byKey(g, 'task:9')[0].start.toISOString().slice(0, 10) === '2026-11-30' && r.updated === 1, JSON.stringify(r));

  // twins an interrupted run left: the complete one stays
  const twin = cal.createEvent('Write the plan', w.start, w.end);
  twin.setTag('plannerKey', 'task:1');
  r = sync(g, items);
  check('bridge: a twin without the right hash is removed, the complete event stays', byKey(g, 'task:1').length === 1
    && byKey(g, 'task:1')[0] !== twin && r.removed === 1, JSON.stringify(r));

  // gone from the planner: removed inside the window, kept for days before it
  const past = cal.createEvent('Last month', new Date('2026-10-05T10:00:00Z'), new Date('2026-10-05T11:00:00Z'));
  past.setTag('plannerKey', 'task:50'); past.setTag('plannerHash', 'x');
  items.splice(1, 1);
  r = sync(g, items);
  check('bridge: an item the planner no longer has is removed from the window', byKey(g, 'event:2').length === 0 && r.removed === 1, JSON.stringify(r));
  check('bridge: an old record before the window is kept', byKey(g, 'task:50').length === 1);

  // a reminder Google refuses does not stop the run, and the event is repaired next time
  g.failReminder = true;
  items[0] = timed('task:1', 'Write the plan', '2026-11-23', 540, 45, { remind: 30 });
  r = sync(g, items);
  const half = byKey(g, 'task:1')[0];
  check('bridge: a reminder that fails leaves the event without its hash, and the run goes on', r.ok && half.tags.plannerKey === 'task:1'
    && !half.tags.plannerHash && byKey(g, 'task:9').length === 1, JSON.stringify(half.tags));
  g.failReminder = false;
  r = sync(g, items);
  check('bridge: ...and the next run writes it again, complete', r.updated === 1 && byKey(g, 'task:1')[0].reminders.join() === '30'
    && !!byKey(g, 'task:1')[0].tags.plannerHash, JSON.stringify(r));

  // a renamed board renames its calendar; a second board gets its own
  r = sync(g, null, null, null, [{ id: 1, name: 'Home', items: items }, { id: 2, name: 'Studio', items: [timed('task:77', 'Glaze', '2026-11-24', 600, 60)] }]);
  check('bridge: a renamed board renames its calendar, a new board gets one of its own', cal.name === 'Planner Home'
    && boardCal(g, 'Planner Studio') && g.calendars.filter(c => c.name.indexOf('Planner ') === 0).length === 2, JSON.stringify(r.calendars));

  // too much at once: it stops cleanly, and the old blocks wait
  block('Another old block', '2026-11-25T09:00:00Z');
  const many = [];
  for (let i = 0; i < 405; i++) many.push(timed('task:' + (1000 + i), 'Many ' + i, '2026-11-26', 600, 30));
  r = sync(g, null, null, null, [{ id: 1, name: 'Home', items: items.concat(many) }]);
  check('bridge: more than 400 writes stop with partial, leaving the old blocks for a complete run', r.partial === true && r.created === 400
    && old.events.some(e => e.title === 'Another old block'), JSON.stringify(r));
  r = sync(g, null, null, null, [{ id: 1, name: 'Home', items: items.concat(many) }]);
  check('bridge: the next run carries on', r.partial === false && r.created === 5 && !old.events.some(e => e.title === 'Another old block'), JSON.stringify(r));
})();

// ---------- reading ----------
(function () {
  const g = load('Test/Plus2');
  const mine = g.calendars[0];
  const at = s => new Date(s);
  mine.createEvent('Late call', at('2026-11-23T21:30:00Z'), at('2026-11-23T23:30:00Z'));     // 23:30-01:30 at +2
  mine.createEvent('Morning', at('2026-11-24T07:00:00Z'), at('2026-11-24T08:00:00Z'));       // 09:00-10:00 at +2
  mine.createAllDayEvent('Fair', at('2026-11-24T10:00:00Z'), at('2026-11-26T10:00:00Z'));    // 24 and 25
  g.makeCal('Planner Main').createEvent('Own block', at('2026-11-24T08:00:00Z'), at('2026-11-24T09:00:00Z'));
  const r = g.get({ action: 'range', from: '2026-11-23', to: '2026-11-25' });
  const d23 = r.days['2026-11-23'], d24 = r.days['2026-11-24'], d25 = r.days['2026-11-25'];
  check('bridge: times are wall-clock minutes in the script time zone', d24.events.some(e => e.title === 'Morning' && e.start === 540 && e.end === 600),
    JSON.stringify(d24.events));
  check('bridge: an event past midnight is split, clipped to each day', d23.events.some(e => e.title === 'Late call' && e.start === 1410 && e.end === 1440)
    && d24.events.some(e => e.title === 'Late call' && e.start === 0 && e.end === 90));
  check('bridge: an all-day event shows on each of its days only', d24.allDay.length === 1 && d25.allDay.length === 1 && d23.allDay.length === 0);
  check('bridge: the planner calendars are never read', !JSON.stringify(r).includes('Own block'));
  check('bridge: every event carries its Google id', d24.events.every(e => /@google\.com$/.test(e.id)));
  const one = g.get({ action: 'events', date: '2026-11-24' });
  check('bridge: one day reads exactly as the same day in a range', JSON.stringify({ events: one.events, allDay: one.allDay }) === JSON.stringify(d24));
  check('bridge: a range of 63 days is refused', /range too long/.test(g.get({ action: 'range', from: '2026-11-01', to: '2027-01-02' }).error || ''));
  check('bridge: a day that does not exist is refused', /bad/.test(g.get({ action: 'events', date: '2026-02-30' }).error || ''));
})();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
