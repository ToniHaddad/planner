/**
 * Personal Project Planner - container-bound Google Apps Script (V8).
 *
 * Install: blank Google Sheet > Extensions > Apps Script > paste this file >
 * run setup() once and approve the permissions. Everything is built by code.
 *
 * Tabs: Today, Projects, Categories, Tasks, By Project, Calendar, Timebox,
 * Archive, Settings, Migration log (created by import), plus hidden helper
 * tabs "Lists" and "Timebox store".
 */

// ===========================================================================
// CONFIG - every constant lives here
// ===========================================================================
const CONFIG = {
  tabs: {
    today: 'Today', projects: 'Projects', categories: 'Categories', tasks: 'Tasks',
    byProject: 'By Project', calendar: 'Calendar', timebox: 'Timebox', archive: 'Archive',
    settings: 'Settings', log: 'Migration log', lists: 'Lists', store: 'Timebox store'
  },
  // Visible tab order (the log tab is only placed if it exists).
  tabOrder: ['today', 'projects', 'categories', 'tasks', 'byProject', 'calendar',
             'timebox', 'archive', 'settings', 'log'],
  // Tabs created by setup(); the log tab is created by the import.
  setupTabs: ['today', 'projects', 'categories', 'tasks', 'byProject', 'calendar',
              'timebox', 'archive', 'settings', 'lists', 'store'],
  headers: {
    projects: ['Project', 'Area', 'Status', 'Color', 'Start', 'Target', 'Notes'],
    categories: ['Category', 'Color', 'Notes'],
    tasks: ['Project', 'Task', 'Status', 'Priority', 'Deadline', 'Est. hours',
            'Scheduled start', 'Duration (min)', 'Done date', 'Notes', 'Event ID'],
    archivedOn: 'Archived on',
    log: ['Logged at', 'Source tab', 'Row', 'Reason', 'Raw values'],
    settings: ['Key', 'Value', 'Notes']
  },
  // 1-based column numbers of the Tasks tab.
  col: { PROJECT: 1, TASK: 2, STATUS: 3, PRIORITY: 4, DEADLINE: 5, EST: 6,
         START: 7, DURATION: 8, DONE: 9, NOTES: 10, EVENT: 11, COUNT: 11 },
  projectStatuses: ['Active', 'On hold', 'Completed', 'Canceled', 'Inactive'],
  projectStatusColors: { 'Active': '#d9ead3', 'On hold': '#fff2cc', 'Completed': '#cfe2f3',
                         'Canceled': '#f4cccc', 'Inactive': '#e0e0e0' },
  taskStatuses: ['To do', 'Doing', 'Waiting', 'Done', 'Canceled'],
  priorities: ['P1', 'P2', 'P3', 'P4'],
  categorySeed: [
    ['Deep work', '#b4c7e7'], ['Meetings', '#f4b6b6'], ['Admin', '#d9d2e9'],
    ['Email', '#fce5cd'], ['Break', '#d9ead3'], ['Family', '#f9cb9c'],
    ['Exercise', '#b6d7a8'], ['Learning', '#a2c4c9'], ['Travel', '#ffe599']
  ],
  // Settings keys (looked up by key, never by row).
  keys: {
    weekStart: 'Week start', dayStart: 'Day start hour', dayEnd: 'Day end hour',
    slot: 'Slot minutes', calendars: 'Calendars to read',
    plannerName: 'Planner calendar name', oldSheet: 'Old sheet id',
    tzNote: 'Timezone note', includePlanner: 'Show Planner calendar in Calendar tab'
  },
  // Default hours: dayEnd is the START of the last slot (23.5 = 23:30).
  dayStart: 5, dayEnd: 23.5, slotMinutes: 30,
  defaultCalendars: 'primary', defaultPlannerName: 'Planner',
  defaultOldSheetId: '',
  grid: { firstRow: 4, firstCol: 2, days: 7 },
  maxRows: 1000,               // formatted/validated rows on list tabs
  defaultDurationMin: 60,
  archiveAfterDays: 7,
  cacheSeconds: 60,
  cacheKey: 'planner_colormap',
  propPlannerCal: 'plannerCalId',
  tagKey: 'planner', tagTimebox: 'timebox', tagTask: 'task',
  colors: { header: '#1f3a5f', headerFont: '#ffffff', grey: '#9e9e9e', overdue: '#f8d7da',
            doneBg: '#efefef', todayHeader: '#ffd966', white: '#ffffff',
            darkText: '#1f1f1f', lightText: '#ffffff' },
  triggerHandlers: ['refreshCalendar', 'syncTasksToCalendar'],
  refreshEveryMinutes: 30,
  // Old sheet import
  oldTabs: { main: 'Project Management Template', todo: 'TO-DO' },
  oldHeaderRow: 2,             // 1-based row holding headers on the main tab
  oldFallbackCols: { status: 1, priority: 2, deadline: 3, completion: 4, task: 5 },
  yellow: '#ffff00',
  inboxProject: 'Inbox',
  labelMap: { 'COMPLETED': 'Completed', 'CANCELED': 'Canceled', 'CANCELLED': 'Canceled',
              'ON HOLD': 'On hold', 'INACTIVE': 'Inactive', 'OVERDUE': 'Active' },
  // Google Calendar event color ids with approximate hex values.
  eventColors: [
    ['1', '#a4bdfc'], ['2', '#7ae7bf'], ['3', '#dbadff'], ['4', '#ff887c'],
    ['5', '#fbd75b'], ['6', '#ffb878'], ['7', '#46d6db'], ['8', '#e1e1e1'],
    ['9', '#5484ed'], ['10', '#51b749'], ['11', '#dc2127']
  ]
};

// ===========================================================================
// Menu and entry points
// ===========================================================================

/** Adds the Planner menu when the sheet opens. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Planner')
    .addItem('Setup / rebuild', 'setup')
    .addItem('Import old sheet', 'importOldSheet')
    .addSeparator()
    .addItem('Refresh calendar', 'refreshCalendar')
    .addItem('Push timebox to calendar', 'pushTimebox')
    .addItem('Sync scheduled tasks to calendar', 'syncTasksToCalendar')
    .addItem('Recolor timebox', 'recolorTimebox')
    .addSeparator()
    .addItem('Archive done', 'archiveDone')
    .addItem('Next week', 'nextWeek')
    .addItem('Previous week', 'prevWeek')
    .addSeparator()
    .addItem('Install triggers', 'installTriggers')
    .addToUi();
}

/** Builds everything. Safe to run again: never wipes tabs that hold user data. */
function setup() {
  ensureTabs_();
  setupSettings_();
  setupProjects_();
  setupCategories_();
  setupTasks_();
  setupLists_();
  setupStore_();
  setupTimebox_();
  setupCalendarTab_();
  setupByProject_();
  setupToday_();
  setupArchive_();
  orderTabs_();
  installTriggers();
  const hasOld = String(getSetting_(CONFIG.keys.oldSheet, '')).trim() !== '';
  toast_('Setup finished.' + (hasOld ? ' Run Planner > Import old sheet to bring in the old projects.' : ''));
  // No dialog here: a Yes/No prompt waits for an answer in the sheet tab, and
  // when setup runs from the editor nobody sees it, so the run hits the 6-min limit.
}

// ===========================================================================
// Small shared helpers
// ===========================================================================

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function tz_() { return ss_().getSpreadsheetTimeZone(); }
function sheet_(name) { return ss_().getSheetByName(name); }
function toast_(msg) { ss_().toast(msg, 'Planner', 6); }
function str_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function pad_(n) { return (n < 10 ? '0' : '') + n; }

/** True when all named tabs exist; otherwise toasts the setup hint. */
function requireTabs_(keys) {
  const missing = keys.filter(function (k) { return !sheet_(CONFIG.tabs[k]); });
  if (missing.length) { toast_('Run Planner > Setup first'); return false; }
  return true;
}

/** Returns a valid Date or null. */
function toDate_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

/** Midnight (spreadsheet time zone) of the given date plus n days. */
function addDays_(date, n, tz) {
  const fmt = 'yyyy-MM-dd';
  const mid = Utilities.parseDate(Utilities.formatDate(date, tz, fmt), tz, fmt);
  const shifted = new Date(mid.getTime() + 12 * 3600000 + n * 86400000);
  return Utilities.parseDate(Utilities.formatDate(shifted, tz, fmt), tz, fmt);
}

function today_() { return addDays_(new Date(), 0, tz_()); }

/** Monday (midnight) of the week holding the date. */
function mondayOf_(date, tz) {
  const dow = Number(Utilities.formatDate(date, tz, 'u')); // 1 = Monday
  return addDays_(date, -(dow - 1), tz);
}

/** Date for day index d of the week at the given minutes after midnight. */
function dayTime_(weekStart, d, minutes, tz) {
  const day = Utilities.formatDate(addDays_(weekStart, d, tz), tz, 'yyyy-MM-dd');
  const text = day + ' ' + pad_(Math.floor(minutes / 60)) + ':' + pad_(minutes % 60);
  return Utilities.parseDate(text, tz, 'yyyy-MM-dd HH:mm');
}

/** Last row with content in the given column (1-based), 0 when empty. */
function lastDataRow_(sh, col) {
  const n = sh.getLastRow();
  if (n < 1) return 0;
  const vals = sh.getRange(1, col, n, 1).getValues();
  for (let i = vals.length - 1; i >= 0; i--) if (str_(vals[i][0]) !== '') return i + 1;
  return 0;
}

/** Reads a Settings value by its key (not by row). */
function getSetting_(key, fallback) {
  const sh = sheet_(CONFIG.tabs.settings);
  if (!sh || sh.getLastRow() < 1) return fallback;
  const vals = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (str_(vals[i][0]).toLowerCase() === key.toLowerCase()) {
      const v = vals[i][1];
      return (v === '' || v === null) ? fallback : v;
    }
  }
  return fallback;
}

/** Timebox geometry from Settings: start minute, slot length, slot count. */
function getGrid_() {
  const startH = Number(getSetting_(CONFIG.keys.dayStart, CONFIG.dayStart));
  const endH = Number(getSetting_(CONFIG.keys.dayEnd, CONFIG.dayEnd));
  const slot = Number(getSetting_(CONFIG.keys.slot, CONFIG.slotMinutes)) || CONFIG.slotMinutes;
  const startMin = Math.round(startH * 60);
  const n = Math.max(1, Math.floor((Math.round(endH * 60) - startMin) / slot) + 1);
  return { startMin: startMin, slot: slot, n: n };
}

/** Week start configured in Settings (falls back to this week's Monday). */
function weekStartSetting_() {
  const tz = tz_();
  const d = toDate_(getSetting_(CONFIG.keys.weekStart, null));
  return mondayOf_(d || new Date(), tz);
}

// ===========================================================================
// Setup of individual tabs
// ===========================================================================

/** Creates every missing tab; removes the empty default Sheet1. */
function ensureTabs_() {
  const ss = ss_();
  CONFIG.setupTabs.forEach(function (k) {
    if (!ss.getSheetByName(CONFIG.tabs[k])) ss.insertSheet(CONFIG.tabs[k]);
  });
  const blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
}

/** Puts the visible tabs in the configured order; helper tabs stay at the end. */
function orderTabs_() {
  const ss = ss_();
  let pos = 1;
  CONFIG.tabOrder.forEach(function (k) {
    const sh = ss.getSheetByName(CONFIG.tabs[k]);
    if (!sh) return;
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(pos++);
  });
  const lists = sheet_(CONFIG.tabs.lists);
  const store = sheet_(CONFIG.tabs.store);
  if (lists && !lists.isSheetHidden()) lists.hideSheet();
  if (store && !store.isSheetHidden()) store.hideSheet();
  ss.setActiveSheet(sheet_(CONFIG.tabs.today));
}

/** Styles and freezes a header row. */
function styleHeader_(sh, count) {
  sh.getRange(1, 1, 1, count).setFontWeight('bold')
    .setBackground(CONFIG.colors.header).setFontColor(CONFIG.colors.headerFont);
  sh.setFrozenRows(1);
}

/** Writes headers, adds a filter over the table and (optionally) banding. */
function applyTableBasics_(sh, headers, banding) {
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  styleHeader_(sh, headers.length);
  const rows = Math.max(sh.getMaxRows(), 2);
  if (sh.getFilter()) sh.getFilter().remove();
  sh.getRange(1, 1, rows, headers.length).createFilter();
  if (banding && sh.getBandings().length === 0) {
    sh.getRange(1, 1, rows, headers.length)
      .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false);
  }
}

/** Settings tab: adds missing keys only, never overwrites user values. */
function setupSettings_() {
  const sh = sheet_(CONFIG.tabs.settings);
  const K = CONFIG.keys;
  const wanted = [
    [K.weekStart, mondayOf_(new Date(), tz_()), 'Monday of the week shown in Timebox and Calendar'],
    [K.dayStart, CONFIG.dayStart, 'First hour of the Timebox (5 = 05:00)'],
    [K.dayEnd, CONFIG.dayEnd, 'Start of the LAST slot (23.5 = 23:30)'],
    [K.slot, CONFIG.slotMinutes, 'Minutes per Timebox row'],
    [K.calendars, CONFIG.defaultCalendars, 'Comma-separated calendar ids; "primary" = your main calendar'],
    [K.plannerName, CONFIG.defaultPlannerName, 'Calendar that receives Timebox blocks and scheduled tasks'],
    [K.oldSheet, CONFIG.defaultOldSheetId, 'Source sheet for Planner > Import old sheet'],
    [K.tzNote, tz_(), 'Information only: the spreadsheet time zone (File > Settings) is used'],
    [K.includePlanner, 'no', 'yes = also list the Planner calendar in the Calendar tab']
  ];
  const have = {};
  const last = sh.getLastRow();
  if (last > 1) {
    sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) { have[str_(r[0]).toLowerCase()] = true; });
  }
  const add = wanted.filter(function (w) { return !have[w[0].toLowerCase()]; });
  sh.getRange(1, 1, 1, 3).setValues([CONFIG.headers.settings]);
  styleHeader_(sh, 3);
  if (add.length) sh.getRange(Math.max(last, 1) + 1, 1, add.length, 3).setValues(add);
  sh.getRange('B:B').setHorizontalAlignment('left');
  sh.setColumnWidth(1, 260); sh.setColumnWidth(2, 340); sh.setColumnWidth(3, 460);
  formatSettingsDates_(sh);
}

/** Date format for the Week start value, wherever its row is. */
function formatSettingsDates_(sh) {
  const vals = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (str_(vals[i][0]) === CONFIG.keys.weekStart) sh.getRange(i + 1, 2).setNumberFormat('yyyy-mm-dd');
  }
}

/** Projects tab: headers, status dropdown + colors, filter, banding. */
function setupProjects_() {
  const sh = sheet_(CONFIG.tabs.projects);
  applyTableBasics_(sh, CONFIG.headers.projects, true);
  const max = CONFIG.maxRows;
  const statusRange = sh.getRange(2, 3, max, 1);
  statusRange.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(CONFIG.projectStatuses, true).setAllowInvalid(false).build());
  sh.getRange(2, 5, max, 2).setNumberFormat('yyyy-mm-dd');
  const rules = CONFIG.projectStatuses.map(function (s) {
    return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(s)
      .setBackground(CONFIG.projectStatusColors[s]).setRanges([statusRange]).build();
  });
  sh.setConditionalFormatRules(rules);
  sh.getRange('D1').setNote('Fill the cell background to set the project color (used by Timebox).');
  sh.setColumnWidths(1, 7, 140); sh.setColumnWidth(7, 320);
}

/** Categories tab: headers and seed rows (only when the tab is empty). */
function setupCategories_() {
  const sh = sheet_(CONFIG.tabs.categories);
  applyTableBasics_(sh, CONFIG.headers.categories, false);
  if (lastDataRow_(sh, 1) <= 1) {
    const seed = CONFIG.categorySeed;
    sh.getRange(2, 1, seed.length, 1).setValues(seed.map(function (s) { return [s[0]]; }));
    sh.getRange(2, 2, seed.length, 1).setBackgrounds(seed.map(function (s) { return [s[1]]; }));
  }
  sh.getRange('B1').setNote('Fill the cell background to set the category color (used by Timebox).');
  sh.setColumnWidth(1, 160); sh.setColumnWidth(2, 100); sh.setColumnWidth(3, 320);
}

/** Header row for Tasks / Archive-like tables, with a list of extra columns. */
function tasksHeaders_() { return CONFIG.headers.tasks.slice(); }

/** Tasks tab: headers, validation, formats, conditional formatting, filter. */
function setupTasks_() {
  const sh = sheet_(CONFIG.tabs.tasks);
  const C = CONFIG.col;
  applyTableBasics_(sh, tasksHeaders_(), true);
  const max = CONFIG.maxRows;
  const dv = function () { return SpreadsheetApp.newDataValidation(); };
  sh.getRange(2, C.PROJECT, max, 1).setDataValidation(dv()
    .requireValueInRange(sheet_(CONFIG.tabs.projects).getRange('A2:A'), true).setAllowInvalid(false).build());
  sh.getRange(2, C.STATUS, max, 1).setDataValidation(dv()
    .requireValueInList(CONFIG.taskStatuses, true).setAllowInvalid(false).build());
  sh.getRange(2, C.PRIORITY, max, 1).setDataValidation(dv()
    .requireValueInList(CONFIG.priorities, true).setAllowInvalid(false).build());
  [C.DEADLINE, C.START, C.DONE].forEach(function (c) {
    sh.getRange(2, c, max, 1).setDataValidation(dv().requireDate().setAllowInvalid(false)
      .setHelpText('Enter a date').build());
  });
  [C.EST, C.DURATION].forEach(function (c) {
    sh.getRange(2, c, max, 1).setDataValidation(dv().requireNumberGreaterThanOrEqualTo(0)
      .setAllowInvalid(false).build());
  });
  sh.getRange(2, C.DEADLINE, max, 1).setNumberFormat('yyyy-mm-dd');
  sh.getRange(2, C.START, max, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  sh.getRange(2, C.DONE, max, 1).setNumberFormat('yyyy-mm-dd');
  sh.getRange(2, C.EST, max, 1).setNumberFormat('0.0#');
  setTasksConditionalFormats_(sh);
  const widths = [150, 320, 90, 70, 100, 80, 140, 100, 100, 260, 50];
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.getRange(2, C.EVENT, max, 1).setFontColor(CONFIG.colors.grey).setFontSize(7);
}

/** Overdue (light red), done/canceled (grey strikethrough), P1 bold. */
function setTasksConditionalFormats_(sh) {
  const range = sh.getRange(2, 1, CONFIG.maxRows, CONFIG.col.COUNT);
  const rule = function (formula) {
    return SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(formula).setRanges([range]);
  };
  sh.setConditionalFormatRules([
    rule('=OR($C2="Done",$C2="Canceled")').setBackground(CONFIG.colors.doneBg)
      .setFontColor(CONFIG.colors.grey).setStrikethrough(true).build(),
    rule('=AND($E2<>"",$E2<TODAY(),$C2<>"Done",$C2<>"Canceled")')
      .setBackground(CONFIG.colors.overdue).build(),
    rule('=$D2="P1"').setBold(true).build()
  ]);
}

/** Hidden helper tab feeding the Timebox dropdown. */
function setupLists_() {
  const sh = sheet_(CONFIG.tabs.lists);
  const x = '{IFERROR(FILTER(Projects!A2:A,(Projects!C2:C="Active")+(Projects!C2:C="On hold")),"");' +
            'IFERROR(FILTER(Categories!A2:A,Categories!A2:A<>""),"")}';
  sh.getRange('A1').setFormula('=IFERROR(LET(x,' + x + ',SORT(UNIQUE(FILTER(x,x<>"")))),"")');
  sh.getRange('B1').setValue('Helper for the Timebox dropdown (Active/On hold projects + categories). Do not edit.');
}

/** Hidden tab holding one saved Timebox grid per week. */
function setupStore_() {
  const sh = sheet_(CONFIG.tabs.store);
  sh.getRange('A:A').setNumberFormat('@');
  sh.getRange(1, 1, 1, 2).setValues([['Week start', 'Grid (JSON)']]).setFontWeight('bold');
}

/** Timebox tab: week header, time slots, dropdowns, formatting. */
function setupTimebox_() {
  const sh = sheet_(CONFIG.tabs.timebox);
  const g = getGrid_();
  const G = CONFIG.grid;
  if (sh.getRange('B1').getValue() === '') sh.getRange('B1').setValue(weekStartSetting_());
  sh.getRange('A1').setValue('Week start').setFontWeight('bold');
  sh.getRange('B1').setNumberFormat('yyyy-mm-dd').setHorizontalAlignment('left');
  sh.getRange('C1').setValue('Move weeks with Planner > Next / Previous week (blocks are saved per week).')
    .setFontColor(CONFIG.colors.grey);
  const formulas = [];
  for (let d = 0; d < G.days; d++) formulas.push(d === 0 ? '=$B$1' : '=$B$1+' + d);
  sh.getRange(3, 1).setValue('Time');
  sh.getRange(3, G.firstCol, 1, G.days).setFormulas([formulas]).setNumberFormat('ddd d mmm');
  styleHeader_(sh, G.firstCol + G.days - 1);
  sh.setFrozenRows(3); sh.setFrozenColumns(1);
  sh.getRange(3, 1, 1, G.firstCol + G.days - 1).setHorizontalAlignment('center');
  const times = [];
  for (let i = 0; i < g.n; i++) times.push([(g.startMin + i * g.slot) / 1440]);
  sh.getRange(G.firstRow, 1, g.n, 1).setValues(times).setNumberFormat('HH:mm')
    .setFontWeight('bold').setBackground('#f3f3f3').setHorizontalAlignment('center');
  const grid = sh.getRange(G.firstRow, G.firstCol, g.n, G.days);
  grid.setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(sheet_(CONFIG.tabs.lists).getRange('A1:A300'), true).setAllowInvalid(true).build());
  grid.setBorder(true, true, true, true, true, true, '#cccccc', SpreadsheetApp.BorderStyle.SOLID);
  grid.setVerticalAlignment('middle').setFontSize(10);
  sh.setRowHeights(G.firstRow, g.n, 22);
  sh.setColumnWidth(1, 64); sh.setColumnWidths(G.firstCol, G.days, 150);
  sh.setConditionalFormatRules([SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=B$3=TODAY()').setBackground(CONFIG.colors.todayHeader)
    .setFontColor('#000000').setBold(true)
    .setRanges([sh.getRange(3, G.firstCol, 1, G.days)]).build()]);
}

/** Calendar tab: week header and layout (events are written by refreshCalendar). */
function setupCalendarTab_() {
  const sh = sheet_(CONFIG.tabs.calendar);
  const G = CONFIG.grid;
  if (sh.getRange('B1').getValue() === '') sh.getRange('B1').setValue(weekStartSetting_());
  sh.getRange('A1').setValue('Week start').setFontWeight('bold');
  sh.getRange('B1').setNumberFormat('yyyy-mm-dd').setHorizontalAlignment('left');
  const formulas = [];
  for (let d = 0; d < G.days; d++) formulas.push(d === 0 ? '=$B$1' : '=$B$1+' + d);
  sh.getRange(3, 1).setValue('Events');
  sh.getRange(3, G.firstCol, 1, G.days).setFormulas([formulas]).setNumberFormat('ddd d mmm');
  styleHeader_(sh, G.firstCol + G.days - 1);
  sh.setFrozenRows(3);
  sh.setColumnWidth(1, 64); sh.setColumnWidths(G.firstCol, G.days, 190);
  sh.getRange(G.firstRow, G.firstCol, Math.max(sh.getMaxRows() - 3, 1), G.days)
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP).setVerticalAlignment('top').setFontSize(9);
}

/** By Project tab: project picker, progress, open and done task queries. */
function setupByProject_() {
  const sh = sheet_(CONFIG.tabs.byProject);
  sh.getRange('A1').setValue('Project').setFontWeight('bold');
  sh.getRange('B1').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(sheet_(CONFIG.tabs.projects).getRange('A2:A'), true).setAllowInvalid(false).build())
    .setBackground('#fff2cc').setFontWeight('bold');
  sh.getRange('A3').setValue('Progress').setFontWeight('bold');
  sh.getRange('B3').setFormula('=IF($B$1="","",IFERROR(COUNTIFS(Tasks!A2:A,$B$1,Tasks!C2:C,"Done")/' +
    'COUNTIFS(Tasks!A2:A,$B$1,Tasks!C2:C,"<>Canceled"),0))').setNumberFormat('0%');
  sh.getRange('C3').setFormula('=IF($B$1="","",COUNTIFS(Tasks!A2:A,$B$1,Tasks!C2:C,"Done")&" of "&' +
    'COUNTIFS(Tasks!A2:A,$B$1,Tasks!C2:C,"<>Canceled")&" tasks done")');
  sh.getRange('A5').setValue('Open tasks (by priority, then deadline)').setFontWeight('bold');
  sh.getRange('H5').setValue('Done tasks').setFontWeight('bold');
  sh.getRange('A6').setFormula('=IF($B$1="","Pick a project in B1",IFERROR(QUERY(Tasks!A1:K,' +
    '"select B,C,D,E,F,G where A = \'"&$B$1&"\' and C <> \'Done\' and C <> \'Canceled\' order by D, E",1),"No open tasks"))');
  sh.getRange('H6').setFormula('=IF($B$1="","",IFERROR(QUERY(Tasks!A1:K,' +
    '"select B,C,I,J where A = \'"&$B$1&"\' and C = \'Done\' order by I desc",1),"No done tasks"))');
  sh.getRange('D:E').setNumberFormat('yyyy-mm-dd');
  sh.getRange('F:F').setNumberFormat('0.0#');
  sh.getRange('G:G').setNumberFormat('yyyy-mm-dd hh:mm');
  sh.getRange('J:J').setNumberFormat('yyyy-mm-dd');
  const widths = [300, 90, 70, 100, 80, 140, 30, 300, 90, 100, 260];
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
}

/** Today tab: formulas only. */
function setupToday_() {
  const sh = sheet_(CONFIG.tabs.today);
  const g = getGrid_();
  const last = g.n + 3;
  sh.clear();
  sh.getRange('A1').setValue('Today').setFontWeight('bold').setFontSize(16);
  sh.getRange('B1').setFormula('=TODAY()').setNumberFormat('dddd d mmmm yyyy')
    .setFontSize(14).setHorizontalAlignment('left');
  const titles = [['A3', 'Due today or overdue'], ['G3', 'Scheduled today'],
                  ['M3', 'Open tasks per active project'], ['P3', 'Timebox today']];
  titles.forEach(function (t) { sh.getRange(t[0]).setValue(t[1]).setFontWeight('bold').setFontSize(12); });
  sh.getRange('A4:E4').setValues([['Project', 'Task', 'Status', 'Priority', 'Deadline']]);
  sh.getRange('G4:K4').setValues([['Project', 'Task', 'Status', 'Start', 'Duration']]);
  sh.getRange('M4:N4').setValues([['Project', 'Open']]);
  sh.getRange('P4:Q4').setValues([['Time', 'Plan']]);
  [['A4:E4'], ['G4:K4'], ['M4:N4'], ['P4:Q4']].forEach(function (a) {
    sh.getRange(a[0]).setFontWeight('bold').setBackground(CONFIG.colors.header).setFontColor(CONFIG.colors.headerFont);
  });
  const day = 'TEXT(TODAY(),"yyyy-mm-dd")';
  sh.getRange('A5').setFormula('=IFERROR(QUERY(Tasks!A2:K,"select A,B,C,D,E where E is not null and E <= date \'"&' +
    day + '&"\' and C <> \'Done\' and C <> \'Canceled\' order by E",0),"Nothing due")');
  sh.getRange('G5').setFormula('=IFERROR(QUERY(Tasks!A2:K,"select A,B,C,G,H where G >= datetime \'"&' + day +
    '&" 00:00:00\' and G < datetime \'"&TEXT(TODAY()+1,"yyyy-mm-dd")&" 00:00:00\' and C <> \'Done\' ' +
    'and C <> \'Canceled\' order by G",0),"Nothing scheduled")');
  sh.getRange('M5').setFormula('=IFERROR(QUERY(FILTER(Tasks!A2:C,Tasks!A2:A<>"",' +
    'COUNTIF(FILTER(Projects!A2:A,Projects!C2:C="Active"),Tasks!A2:A)>0),' +
    '"select Col1, count(Col2) where Col3 <> \'Done\' and Col3 <> \'Canceled\' group by Col1 ' +
    'label count(Col2) \'\'",0),"No open tasks")');
  sh.getRange('P5').setFormula('=Timebox!$A$4:$A$' + last);
  sh.getRange('Q5').setFormula('=IFERROR(INDEX(Timebox!$B$4:$H$' + last +
    ',0,MATCH(TODAY(),Timebox!$B$3:$H$3,0)),"Today is not in the week shown in Timebox")');
  sh.getRange('E5:E500').setNumberFormat('yyyy-mm-dd');
  sh.getRange('J5:J500').setNumberFormat('hh:mm');
  sh.getRange('P5:P500').setNumberFormat('HH:mm');
  const widths = [140, 280, 80, 70, 100, 30, 140, 280, 80, 70, 70, 30, 150, 60, 30, 60, 220];
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.setFrozenRows(4);
}

/** Archive tab: Tasks headers plus "Archived on". */
function setupArchive_() {
  const sh = sheet_(CONFIG.tabs.archive);
  const headers = tasksHeaders_().concat([CONFIG.headers.archivedOn]);
  applyTableBasics_(sh, headers, false);
  const C = CONFIG.col;
  sh.getRange(2, C.DEADLINE, CONFIG.maxRows, 1).setNumberFormat('yyyy-mm-dd');
  sh.getRange(2, C.START, CONFIG.maxRows, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  sh.getRange(2, C.DONE, CONFIG.maxRows, 1).setNumberFormat('yyyy-mm-dd');
  sh.getRange(2, C.COUNT + 1, CONFIG.maxRows, 1).setNumberFormat('yyyy-mm-dd');
  const widths = [150, 320, 90, 70, 100, 80, 140, 100, 100, 260, 50, 100];
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
}

// ===========================================================================
// Colors: name -> color map, Timebox coloring
// ===========================================================================

/** Dark or white text for a given background hex. */
function fontFor_(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return CONFIG.colors.darkText;
  const lum = (0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16)) / 255;
  return lum > 0.55 ? CONFIG.colors.darkText : CONFIG.colors.lightText;
}

/** Adds lowercase name -> background of the color column into map. */
function addColors_(map, sh, colorCol) {
  if (!sh || sh.getLastRow() < 2) return;
  const n = sh.getLastRow() - 1;
  const names = sh.getRange(2, 1, n, 1).getValues();
  const bgs = sh.getRange(2, colorCol, n, 1).getBackgrounds();
  for (let i = 0; i < n; i++) {
    const name = str_(names[i][0]).toLowerCase();
    const bg = String(bgs[i][0]).toLowerCase();
    if (name && bg && bg !== CONFIG.colors.white) map[name] = bg;
  }
}

/** Name -> color map from Projects col D and Categories col B (cached 60 s). */
function getColorMap_(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) {
    const hit = cache.get(CONFIG.cacheKey);
    if (hit) return JSON.parse(hit);
  }
  const map = {};
  addColors_(map, sheet_(CONFIG.tabs.categories), 2);
  addColors_(map, sheet_(CONFIG.tabs.projects), 4); // projects win on a name clash
  cache.put(CONFIG.cacheKey, JSON.stringify(map), CONFIG.cacheSeconds);
  return map;
}

/** Fills bgs/fonts in place from the values: match, clear on empty, keep unknown. */
function applyColors_(vals, bgs, fonts, map) {
  for (let r = 0; r < vals.length; r++) {
    for (let c = 0; c < vals[r].length; c++) {
      const v = str_(vals[r][c]);
      if (v === '') { bgs[r][c] = CONFIG.colors.white; fonts[r][c] = '#000000'; continue; }
      const color = map[v.toLowerCase()];
      if (color) { bgs[r][c] = color; fonts[r][c] = fontFor_(color); }
    }
  }
}

/** Recolors the whole Timebox grid in one batch. */
function recolorTimebox() {
  if (!requireTabs_(['timebox', 'projects', 'categories', 'settings'])) return;
  const sh = sheet_(CONFIG.tabs.timebox);
  const g = getGrid_();
  const range = sh.getRange(CONFIG.grid.firstRow, CONFIG.grid.firstCol, g.n, CONFIG.grid.days);
  const vals = range.getValues();
  const bgs = range.getBackgrounds();
  const fonts = range.getFontColors();
  applyColors_(vals, bgs, fonts, getColorMap_(true));
  range.setBackgrounds(bgs).setFontColors(fonts);
}

/** Simple trigger: colors Timebox edits and stamps Done dates on Tasks. */
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    const name = e.range.getSheet().getName();
    if (name === CONFIG.tabs.timebox) colorEditedCells_(e.range);
    else if (name === CONFIG.tabs.tasks) stampDoneDates_(e.range);
  } catch (err) { /* simple triggers must never throw */ }
}

/** Colors the part of an edited range that lies inside the Timebox grid. */
function colorEditedCells_(range) {
  const sh = range.getSheet();
  const G = CONFIG.grid;
  const r0 = Math.max(range.getRow(), G.firstRow);
  const r1 = Math.min(range.getLastRow(), sh.getMaxRows());
  const c0 = Math.max(range.getColumn(), G.firstCol);
  const c1 = Math.min(range.getLastColumn(), G.firstCol + G.days - 1);
  if (r0 > r1 || c0 > c1) return;
  const sub = sh.getRange(r0, c0, r1 - r0 + 1, c1 - c0 + 1);
  const vals = sub.getValues();
  const bgs = sub.getBackgrounds();
  const fonts = sub.getFontColors();
  applyColors_(vals, bgs, fonts, getColorMap_(false));
  sub.setBackgrounds(bgs).setFontColors(fonts);
}

/** Done / Canceled -> stamp today when empty; anything else clears the date. */
function stampDoneDates_(range) {
  const C = CONFIG.col;
  if (range.getColumn() > C.STATUS || range.getLastColumn() < C.STATUS) return;
  const sh = range.getSheet();
  const r0 = Math.max(range.getRow(), 2);
  const r1 = Math.min(range.getLastRow(), sh.getLastRow());
  if (r0 > r1) return;
  const n = r1 - r0 + 1;
  const status = sh.getRange(r0, C.STATUS, n, 1).getValues();
  const doneRange = sh.getRange(r0, C.DONE, n, 1);
  const done = doneRange.getValues();
  const today = today_();
  for (let i = 0; i < n; i++) {
    const s = str_(status[i][0]);
    if (s === 'Done' || s === 'Canceled') { if (done[i][0] === '') done[i][0] = today; }
    else done[i][0] = '';
  }
  doneRange.setValues(done);
}

// ===========================================================================
// Week navigation (grids are stored per week)
// ===========================================================================

function nextWeek() { shiftWeek_(7); }
function prevWeek() { shiftWeek_(-7); }

/** Key used in the Timebox store: week start as yyyy-MM-dd. */
function weekKey_(date, tz) { return Utilities.formatDate(date, tz, 'yyyy-MM-dd'); }

/** Finds the store row (1-based) for a key, or 0. */
function findStoreRow_(sh, key) {
  const n = sh.getLastRow();
  if (n < 2) return 0;
  const keys = sh.getRange(2, 1, n - 1, 1).getValues();
  for (let i = 0; i < keys.length; i++) if (str_(keys[i][0]) === key) return i + 2;
  return 0;
}

/** Saves a week's grid values into the hidden store. */
function saveWeek_(key, values) {
  const sh = sheet_(CONFIG.tabs.store);
  const row = findStoreRow_(sh, key) || Math.max(sh.getLastRow(), 1) + 1;
  sh.getRange(row, 1, 1, 2).setValues([[key, JSON.stringify(values)]]);
}

/** Returns a stored grid (array of rows) or null. */
function readWeek_(key) {
  const sh = sheet_(CONFIG.tabs.store);
  const row = findStoreRow_(sh, key);
  if (!row) return null;
  try { return JSON.parse(sh.getRange(row, 2).getValue()); } catch (err) { return null; }
}

/** Pads/trims a stored grid to n rows x 7 columns. */
function fitGrid_(vals, n) {
  const out = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < CONFIG.grid.days; c++) row.push(vals && vals[r] && vals[r][c] !== undefined ? vals[r][c] : '');
    out.push(row);
  }
  return out;
}

/** Saves the current grid, moves the week, loads the target grid, recolors. */
function shiftWeek_(days) {
  if (!requireTabs_(['timebox', 'calendar', 'store', 'settings'])) return;
  const tb = sheet_(CONFIG.tabs.timebox);
  const tz = tz_();
  const g = getGrid_();
  const current = toDate_(tb.getRange('B1').getValue());
  if (!current) { toast_('Timebox B1 needs a date.'); return; }
  const range = tb.getRange(CONFIG.grid.firstRow, CONFIG.grid.firstCol, g.n, CONFIG.grid.days);
  saveWeek_(weekKey_(current, tz), range.getValues());
  const target = addDays_(current, days, tz);
  range.setValues(fitGrid_(readWeek_(weekKey_(target, tz)), g.n));
  tb.getRange('B1').setValue(target);
  sheet_(CONFIG.tabs.calendar).getRange('B1').setValue(target);
  SpreadsheetApp.flush();
  recolorTimebox();
  refreshCalendar();
}

// ===========================================================================
// Calendar
// ===========================================================================

/** Planner calendar if it already exists (no creation), else null. */
function findPlannerCalendar_() {
  const props = PropertiesService.getDocumentProperties();
  const id = props.getProperty(CONFIG.propPlannerCal);
  let cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) {
    const found = CalendarApp.getCalendarsByName(String(getSetting_(CONFIG.keys.plannerName, CONFIG.defaultPlannerName)));
    cal = found.length ? found[0] : null;
    if (cal) props.setProperty(CONFIG.propPlannerCal, cal.getId());
  }
  return cal;
}

/** Planner calendar: found by name, created when missing; id is stored. */
function getPlannerCalendar_() {
  let cal = findPlannerCalendar_();
  if (!cal) {
    cal = CalendarApp.createCalendar(String(getSetting_(CONFIG.keys.plannerName, CONFIG.defaultPlannerName)));
    PropertiesService.getDocumentProperties().setProperty(CONFIG.propPlannerCal, cal.getId());
  }
  return cal;
}

/** Resolves a calendar id from Settings ("primary" = default calendar). */
function getCalendar_(id) {
  const cal = id.toLowerCase() === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(id);
  if (!cal) throw new Error('calendar not found or no access');
  return cal;
}

/** Label for an event inside the Calendar tab (from already-read values). */
function eventLabel_(title, start, end, allDay, calName, tz) {
  const when = allDay ? 'All day' :
    Utilities.formatDate(start, tz, 'HH:mm') + '–' + Utilities.formatDate(end, tz, 'HH:mm');
  return when + ' ' + title + ' (' + calName + ')';
}

/** Puts the week's events from the configured calendars into the Calendar tab. */
function refreshCalendar() {
  if (!requireTabs_(['calendar', 'settings'])) return;
  const sh = sheet_(CONFIG.tabs.calendar);
  const tz = tz_();
  const ws = toDate_(sh.getRange('B1').getValue());
  if (!ws) { toast_('Calendar B1 needs a date.'); return; }
  const days = [];
  for (let d = 0; d < CONFIG.grid.days; d++) days.push(addDays_(ws, d, tz));
  const ids = String(getSetting_(CONFIG.keys.calendars, CONFIG.defaultCalendars))
    .split(',').map(str_).filter(Boolean);
  const showPlanner = /^(y|true|1)/i.test(String(getSetting_(CONFIG.keys.includePlanner, 'no')));
  const planner = findPlannerCalendar_();
  const cols = days.map(function () { return []; });
  const errors = [];
  ids.forEach(function (id) {
    try {
      const cal = getCalendar_(id);
      if (!showPlanner && planner && cal.getId() === planner.getId()) return;
      collectEvents_(cal, days, tz, cols);
    } catch (err) { errors.push(id + ': ' + err.message); }
  });
  writeCalendarGrid_(sh, cols);
  sh.getRange('D1').setValue(errors.length ? 'Problems: ' + errors.join(' | ')
    : 'Refreshed ' + Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'))
    .setFontColor(errors.length ? '#cc0000' : CONFIG.colors.grey);
}

/** Adds one calendar's events to the per-day lists (overlap logic for multi-day events). */
function collectEvents_(cal, days, tz, cols) {
  // Each CalendarEvent getter is a service call: read every value once per event.
  const color = cal.getColor() || CONFIG.colors.white;
  const calName = cal.getName();
  const end = addDays_(days[0], days.length, tz);
  cal.getEvents(days[0], end).forEach(function (ev) {
    const s = ev.getStartTime(), e = ev.getEndTime(), allDay = ev.isAllDayEvent();
    const item = { key: allDay ? 0 : s.getTime(),
                   text: eventLabel_(ev.getTitle(), s, e, allDay, calName, tz), color: color };
    days.forEach(function (dayStart, d) {
      const dayEnd = d + 1 < days.length ? days[d + 1] : end;
      if (s < dayEnd && e > dayStart) cols[d].push(item);
    });
  });
}

/** Clears the old list and writes the new one in a single batch. */
function writeCalendarGrid_(sh, cols) {
  const G = CONFIG.grid;
  const area = sh.getRange(G.firstRow, G.firstCol, Math.max(sh.getMaxRows() - G.firstRow + 1, 1), G.days);
  area.clearContent().setBackground(null).setFontColor('#000000');
  const rows = Math.max.apply(null, cols.map(function (c) { return c.length; }).concat([0]));
  if (!rows) return;
  cols.forEach(function (list) { list.sort(function (a, b) { return a.key - b.key; }); });
  const vals = [], bgs = [], fonts = [];
  for (let r = 0; r < rows; r++) {
    vals.push([]); bgs.push([]); fonts.push([]);
    cols.forEach(function (list) {
      const item = list[r];
      vals[r].push(item ? item.text : '');
      bgs[r].push(item ? item.color : CONFIG.colors.white);
      fonts[r].push(item ? fontFor_(item.color) : '#000000');
    });
  }
  if (sh.getMaxRows() < G.firstRow + rows - 1) sh.insertRowsAfter(sh.getMaxRows(), G.firstRow + rows - 1 - sh.getMaxRows());
  const out = sh.getRange(G.firstRow, G.firstCol, rows, G.days);
  out.setValues(vals).setBackgrounds(bgs).setFontColors(fonts);
}

/** Merges consecutive equal non-empty slots per day into blocks. */
function blocksFromGrid_(vals, g) {
  const blocks = [];
  for (let d = 0; d < CONFIG.grid.days; d++) {
    let i = 0;
    while (i < g.n) {
      const v = str_(vals[i][d]);
      if (v === '') { i++; continue; }
      let j = i;
      while (j + 1 < g.n && str_(vals[j + 1][d]) === v) j++;
      blocks.push({ day: d, startMin: g.startMin + i * g.slot, durMin: (j - i + 1) * g.slot, title: v });
      i = j + 1;
    }
  }
  return blocks;
}

/** Nearest Google Calendar event color id for a hex color. */
function nearestEventColor_(hex) {
  const rgb = function (h) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255];
  };
  const a = rgb(hex);
  let best = CONFIG.eventColors[0][0], bestD = Infinity;
  CONFIG.eventColors.forEach(function (ec) {
    const b = rgb(ec[1]);
    const dist = Math.pow(a[0] - b[0], 2) + Math.pow(a[1] - b[1], 2) + Math.pow(a[2] - b[2], 2);
    if (dist < bestD) { bestD = dist; best = ec[0]; }
  });
  return best;
}

/** Replaces the Planner calendar's timebox events for the shown week (idempotent). */
function pushTimebox() {
  if (!requireTabs_(['timebox', 'settings', 'projects', 'categories'])) return;
  const tb = sheet_(CONFIG.tabs.timebox);
  const tz = tz_();
  const ws = toDate_(tb.getRange('B1').getValue());
  if (!ws) { toast_('Timebox B1 needs a date.'); return; }
  const g = getGrid_();
  const vals = tb.getRange(CONFIG.grid.firstRow, CONFIG.grid.firstCol, g.n, CONFIG.grid.days).getValues();
  const blocks = blocksFromGrid_(vals, g);
  const cal = getPlannerCalendar_();
  let removed = 0;
  cal.getEvents(ws, addDays_(ws, CONFIG.grid.days, tz)).forEach(function (ev) {
    if (ev.getTag(CONFIG.tagKey) === CONFIG.tagTimebox) { ev.deleteEvent(); removed++; }
  });
  const colors = getColorMap_(true);
  blocks.forEach(function (b) {
    const start = dayTime_(ws, b.day, b.startMin, tz);
    const end = new Date(start.getTime() + b.durMin * 60000);
    const ev = cal.createEvent(b.title, start, end, { description: CONFIG.tagKey + ':' + CONFIG.tagTimebox });
    ev.setTag(CONFIG.tagKey, CONFIG.tagTimebox);
    const color = colors[b.title.toLowerCase()];
    if (color) { try { ev.setColor(nearestEventColor_(color)); } catch (err) { /* color is optional */ } }
  });
  toast_('Timebox pushed: ' + blocks.length + ' blocks created, ' + removed + ' old ones replaced.');
}

/** Gets an event by id, or null when it no longer exists. */
function getEventSafe_(cal, id) {
  if (!id) return null;
  try { return cal.getEventById(id); } catch (err) { return null; }
}

/** Creates/updates/deletes calendar events for tasks with a Scheduled start. */
function syncTasksToCalendar() {
  if (!requireTabs_(['tasks', 'settings'])) return;
  const sh = sheet_(CONFIG.tabs.tasks);
  const C = CONFIG.col;
  const last = sh.getLastRow();
  if (last < 2) return;
  const cal = getPlannerCalendar_();
  const range = sh.getRange(2, 1, last - 1, C.COUNT);
  const rows = range.getValues();
  const stats = { created: 0, updated: 0, deleted: 0 };
  rows.forEach(function (row) { syncTaskRow_(cal, row, stats); });
  sh.getRange(2, C.EVENT, rows.length, 1).setValues(rows.map(function (r) { return [r[C.EVENT - 1]]; }));
  toast_('Tasks synced: ' + stats.created + ' created, ' + stats.updated + ' updated, ' + stats.deleted + ' removed.');
}

/** Syncs one task row (mutates row[Event ID]). */
function syncTaskRow_(cal, row, stats) {
  const C = CONFIG.col;
  const idx = function (c) { return c - 1; };
  const start = toDate_(row[idx(C.START)]);
  const status = str_(row[idx(C.STATUS)]);
  const active = start && status !== 'Done' && status !== 'Canceled' && str_(row[idx(C.TASK)]) !== '';
  const id = str_(row[idx(C.EVENT)]);
  const existing = getEventSafe_(cal, id);
  if (!active) {
    if (id) { if (existing) { try { existing.deleteEvent(); stats.deleted++; } catch (err) { /* already gone */ } } row[idx(C.EVENT)] = ''; }
    return;
  }
  const project = str_(row[idx(C.PROJECT)]);
  const title = (project ? '[' + project + '] ' : '') + str_(row[idx(C.TASK)]);
  const dur = Number(row[idx(C.DURATION)]) > 0 ? Number(row[idx(C.DURATION)]) : CONFIG.defaultDurationMin;
  const end = new Date(start.getTime() + dur * 60000);
  if (existing) {
    // Write only what changed: the hourly trigger would otherwise rewrite every event.
    let changed = false;
    if (existing.getStartTime().getTime() !== start.getTime() ||
        existing.getEndTime().getTime() !== end.getTime()) { existing.setTime(start, end); changed = true; }
    if (existing.getTitle() !== title) { existing.setTitle(title); changed = true; }
    if (changed) stats.updated++;
  } else {
    const ev = cal.createEvent(title, start, end, { description: CONFIG.tagKey + ':' + CONFIG.tagTask });
    ev.setTag(CONFIG.tagKey, CONFIG.tagTask);
    row[idx(C.EVENT)] = ev.getId(); stats.created++;
  }
}

/** Replaces this script's triggers with the periodic refresh and sync. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (CONFIG.triggerHandlers.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshCalendar').timeBased().everyMinutes(CONFIG.refreshEveryMinutes).create();
  ScriptApp.newTrigger('syncTasksToCalendar').timeBased().everyHours(1).create();
  toast_('Triggers installed: refresh every ' + CONFIG.refreshEveryMinutes + ' min, task sync hourly.');
}

// ===========================================================================
// Archive
// ===========================================================================

/** Lowercase names of Completed/Canceled projects. */
function closedProjects_() {
  const sh = sheet_(CONFIG.tabs.projects);
  const out = {};
  if (sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (r) {
    const s = str_(r[2]);
    if (str_(r[0]) && (s === 'Completed' || s === 'Canceled')) out[str_(r[0]).toLowerCase()] = true;
  });
  return out;
}

/** Deletes calendar events of archived rows; clears their Event ID. */
function dropArchivedEvents_(rows) {
  const ids = rows.filter(function (r) { return str_(r[CONFIG.col.EVENT - 1]); });
  if (!ids.length) return;
  let cal = null;
  try { cal = findPlannerCalendar_(); } catch (err) { cal = null; }
  ids.forEach(function (r) {
    const ev = cal ? getEventSafe_(cal, str_(r[CONFIG.col.EVENT - 1])) : null;
    if (ev) { try { ev.deleteEvent(); } catch (err) { /* ignore */ } }
    r[CONFIG.col.EVENT - 1] = '';
  });
}

/** Moves old Done/Canceled tasks and tasks of closed projects to Archive. */
function archiveDone() {
  if (!requireTabs_(['tasks', 'archive', 'projects'])) return;
  const tasks = sheet_(CONFIG.tabs.tasks);
  const archive = sheet_(CONFIG.tabs.archive);
  const C = CONFIG.col;
  const last = tasks.getLastRow();
  if (last < 2) { toast_('Nothing to archive.'); return; }
  const tz = tz_();
  const today = today_();
  const cutoff = addDays_(today, -CONFIG.archiveAfterDays, tz);
  const closed = closedProjects_();
  const data = tasks.getRange(2, 1, last - 1, C.COUNT).getValues();
  const keep = [], move = [];
  data.forEach(function (row) {
    if (row.every(function (v) { return str_(v) === ''; })) return;
    const status = str_(row[C.STATUS - 1]);
    const final = status === 'Done' || status === 'Canceled';
    const doneOn = toDate_(row[C.DONE - 1]) || today;
    const aged = final && doneOn < cutoff;
    if (aged || closed[str_(row[C.PROJECT - 1]).toLowerCase()]) move.push(row); else keep.push(row);
  });
  if (!move.length) { toast_('Nothing to archive.'); return; }
  dropArchivedEvents_(move);
  const out = move.map(function (r) { return r.concat([today]); });
  archive.getRange(lastDataRow_(archive, 2) + 1, 1, out.length, C.COUNT + 1).setValues(out);
  const blank = [];
  for (let i = keep.length; i < data.length; i++) blank.push(new Array(C.COUNT).fill(''));
  tasks.getRange(2, 1, data.length, C.COUNT).setValues(keep.concat(blank));
  toast_('Archived ' + move.length + ' tasks.');
}

// ===========================================================================
// Import of the old sheet
// ===========================================================================

/** Imports projects/tasks from the old sheet without modifying it. */
function importOldSheet() {
  if (!requireTabs_(['projects', 'tasks', 'archive', 'settings'])) return;
  const id = String(getSetting_(CONFIG.keys.oldSheet, '')).trim();
  if (!id) { toast_('Set "Old sheet id" in Settings first.'); return; }
  let src;
  try { src = SpreadsheetApp.openById(id); }
  catch (err) { toast_('Cannot open the old sheet: ' + err.message); return; }
  const ctx = newImportCtx_();
  importMainTab_(src, ctx);
  importTodoTab_(src, ctx);
  flushImport_(ctx);
  toast_(ctx.newProjects.length + ' projects, ' + ctx.tasks.length + ' tasks, ' +
    ctx.archive.length + ' archived, ' + ctx.log.length + ' logged' +
    (ctx.dupes ? ' (' + ctx.dupes + ' duplicates skipped)' : '') + '.');
}

/** Import state: existing keys/projects, and the rows collected for batch writes. */
function newImportCtx_() {
  const C = CONFIG.col;
  const ctx = { newProjects: [], tasks: [], archive: [], log: [], status: {}, keys: {}, dupes: 0,
                tz: tz_(), today: today_() };
  const ps = sheet_(CONFIG.tabs.projects);
  if (ps.getLastRow() > 1) {
    ps.getRange(2, 1, ps.getLastRow() - 1, 3).getValues().forEach(function (r) {
      if (str_(r[0])) ctx.status[str_(r[0]).toLowerCase()] = str_(r[2]) || 'Active';
    });
  }
  [CONFIG.tabs.tasks, CONFIG.tabs.archive].forEach(function (name) {
    const sh = sheet_(name);
    if (sh.getLastRow() < 2) return;
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
      if (str_(r[1])) ctx.keys[taskKey_(r[0], r[1])] = true;
    });
  });
  return ctx;
}

function taskKey_(project, task) { return str_(project).toLowerCase() + '|' + str_(task).toLowerCase(); }

/** Records a row that could not be classified. */
function logRow_(ctx, tab, rowNum, reason, raw) {
  ctx.log.push([new Date(), tab, rowNum, reason, raw]);
}

/** Adds a project unless it exists; returns its stored status. */
function addProject_(ctx, name, status, note) {
  const k = name.toLowerCase();
  if (ctx.status[k]) return ctx.status[k];
  ctx.status[k] = status;
  ctx.newProjects.push([name, '', status, '', '', '', note || '']);
  return status;
}

/** Adds a task row; routes to Archive for closed projects; skips duplicates. */
function addTask_(ctx, project, row) {
  const key = taskKey_(project, row[CONFIG.col.TASK - 1]);
  if (ctx.keys[key]) { ctx.dupes++; return; }
  ctx.keys[key] = true;
  const status = ctx.status[project.toLowerCase()];
  if (status === 'Completed' || status === 'Canceled') {
    if (status === 'Canceled' && row[CONFIG.col.STATUS - 1] !== 'Done') row[CONFIG.col.STATUS - 1] = 'Canceled';
    if (status === 'Completed' && row[CONFIG.col.STATUS - 1] !== 'Canceled') row[CONFIG.col.STATUS - 1] = 'Done';
    ctx.archive.push(row.concat([ctx.today]));
  } else {
    ctx.tasks.push(row);
  }
}

/** Finds the main-tab columns by header text (case-insensitive); falls back to B..F. */
function findOldColumns_(headerRow) {
  const names = headerRow.map(function (h) { return str_(h).toLowerCase(); });
  const find = function (pred, fallback) {
    const i = names.findIndex(pred);
    return i >= 0 ? i : fallback;
  };
  const F = CONFIG.oldFallbackCols;
  return {
    status: find(function (n) { return n === 'status'; }, F.status),
    priority: find(function (n) { return n === 'priority'; }, F.priority),
    deadline: find(function (n) { return n === 'deadline'; }, F.deadline),
    completion: find(function (n) { return n.indexOf('completion') === 0; }, F.completion),
    task: find(function (n) { return n === 'task'; }, F.task),
    names: names
  };
}

/** Column letter for a 0-based index (A, B, ... AA). */
function colLetter_(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Text for a note: dates as yyyy-MM-dd, checkboxes as TRUE/FALSE. */
function noteText_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  return str_(v);
}

/** Maps free text to a task status. */
function mapTaskStatus_(text) {
  const t = text.toLowerCase();
  if (/cancel/.test(t)) return 'Canceled';
  if (/done|complete/.test(t)) return 'Done';
  if (/doing|progress|ongoing|started/.test(t)) return 'Doing';
  if (/wait|hold|blocked/.test(t)) return 'Waiting';
  return 'To do';
}

/** Maps high/medium/low (or P1-P4 / 1-4) to P1-P4; '' when unknown. */
function mapPriority_(text) {
  const t = text.toLowerCase();
  if (/^p[1-4]$/.test(t)) return t.toUpperCase();
  if (/^[1-4]$/.test(t)) return 'P' + t;
  if (/high|urgent|critical/.test(t)) return 'P1';
  if (/med/.test(t)) return 'P2';
  if (/low/.test(t)) return 'P3';
  return '';
}

/** Splits a cell into a Date (or '') and leftover raw text. */
function dateCell_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return { date: v, raw: '' };
  const s = str_(v);
  if (!s) return { date: '', raw: '' };
  const d = toDate_(s);
  return d ? { date: d, raw: '' } : { date: '', raw: s };
}

/** True for words that look like a status rather than a project name. */
function isStatusWord_(text) {
  return /^(done|completed?|in progress|not started|to ?do|doing|waiting|canceled|cancelled|overdue)$/i.test(text);
}

/** Builds one Tasks row from an old-sheet row. */
function oldTaskRow_(row, cols, headers, project, ctx) {
  const used = [cols.status, cols.priority, cols.deadline, cols.completion, cols.task];
  const notes = [];
  const prioText = str_(row[cols.priority]);
  const prio = mapPriority_(prioText);
  if (prioText && !prio) notes.push('Priority: ' + prioText);
  const dl = dateCell_(row[cols.deadline]);
  if (dl.raw) notes.push('Deadline: ' + dl.raw);
  const done = dateCell_(row[cols.completion]);
  if (done.raw) notes.push('Completion Date: ' + done.raw);
  row.forEach(function (v, j) {
    if (used.indexOf(j) >= 0 || str_(v) === '') return;
    notes.push((headers[j] ? str_(headers[j]) : 'Col ' + colLetter_(j)) + ': ' + noteText_(v, ctx.tz));
  });
  return [project, str_(row[cols.task]), mapTaskStatus_(str_(row[cols.status])), prio, dl.date,
          '', '', '', done.date, notes.join('; '), ''];
}

/** Imports the "Project Management Template" tab. */
function importMainTab_(src, ctx) {
  const tab = CONFIG.oldTabs.main;
  const sh = src.getSheetByName(tab);
  if (!sh) { logRow_(ctx, tab, '', 'Tab not found in the old sheet', ''); return; }
  const range = sh.getDataRange();
  const vals = range.getValues();
  const bgs = range.getBackgrounds();
  const headerRaw = vals[CONFIG.oldHeaderRow - 1] || [];
  const cols = findOldColumns_(headerRaw);
  const headers = headerRaw.map(str_);
  let current = null, afterDivider = false;
  for (let i = CONFIG.oldHeaderRow; i < vals.length; i++) {
    const row = vals[i];
    const rowNum = i + 1;
    const hasText = row.some(function (c) { return str_(c) !== ''; });
    if (!hasText) {
      if (bgs[i].some(function (b) { return String(b).toLowerCase() === CONFIG.yellow; })) afterDivider = true;
      continue;
    }
    const name = str_(row[cols.status]);
    const task = str_(row[cols.task]);
    const raw = row.map(function (c) { return noteText_(c, ctx.tz); }).join(' | ');
    if (task === '') {
      if (name !== '' && !isStatusWord_(name)) current = startOldProject_(ctx, row, cols, name, afterDivider);
      else logRow_(ctx, tab, rowNum, 'No task and no project name', raw);
    } else if (!current) {
      logRow_(ctx, tab, rowNum, 'Task found before any project header', raw);
    } else {
      addTask_(ctx, current, oldTaskRow_(row, cols, headers, current, ctx));
    }
  }
}

/** Registers a project header row; returns the project name. */
function startOldProject_(ctx, row, cols, name, afterDivider) {
  let label = str_(row[cols.priority]).toUpperCase();
  if (!label) {
    row.forEach(function (c, j) {
      const u = str_(c).toUpperCase();
      if (!label && j !== cols.status && CONFIG.labelMap[u]) label = u;
    });
  }
  const status = CONFIG.labelMap[label] || (afterDivider ? 'Inactive' : 'Active');
  const note = 'Imported from old sheet' + (label && !CONFIG.labelMap[label] ? ' (label: ' + label + ')' : '');
  addProject_(ctx, name, status, note);
  return name;
}

/** Imports the TO-DO tab into the Inbox project. */
function importTodoTab_(src, ctx) {
  const tab = CONFIG.oldTabs.todo;
  const sh = src.getSheets().filter(function (s) { return s.getName().toLowerCase() === tab.toLowerCase(); })[0];
  if (!sh) { logRow_(ctx, tab, '', 'Tab not found in the old sheet', ''); return; }
  const vals = sh.getDataRange().getValues();
  const nonEmpty = function (c) { return str_(c) !== ''; };
  const h = vals.findIndex(function (r) { return r.some(nonEmpty); });
  if (h < 0) return;
  const headers = vals[h].map(str_);
  addProject_(ctx, CONFIG.inboxProject, 'Active', 'Imported from TO-DO');
  for (let i = h + 1; i < vals.length; i++) {
    const row = vals[i];
    if (!row.some(nonEmpty)) continue;
    const t = row.findIndex(function (c) { return typeof c === 'string' && c.trim() !== ''; });
    if (t < 0) {
      logRow_(ctx, tab, i + 1, 'No text cell to use as task', row.map(String).join(' | '));
      continue;
    }
    const notes = [];
    row.forEach(function (v, j) {
      if (j === t || !nonEmpty(v) || v === true || v === false) return;
      notes.push((headers[j] || 'Col ' + colLetter_(j)) + ': ' + noteText_(v, ctx.tz));
    });
    const done = row.some(function (c) { return c === true; });
    addTask_(ctx, CONFIG.inboxProject, [CONFIG.inboxProject, str_(row[t]), done ? 'Done' : 'To do', '', '',
      '', '', '', '', notes.join('; '), '']);
  }
}

/** Creates the Migration log tab when missing. */
function ensureLogTab_() {
  const ss = ss_();
  let sh = ss.getSheetByName(CONFIG.tabs.log);
  if (sh) return sh;
  sh = ss.insertSheet(CONFIG.tabs.log);
  sh.getRange(1, 1, 1, CONFIG.headers.log.length).setValues([CONFIG.headers.log]);
  styleHeader_(sh, CONFIG.headers.log.length);
  sh.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm');
  sh.setColumnWidths(1, 4, 150); sh.setColumnWidth(4, 260); sh.setColumnWidth(5, 600);
  orderTabs_();
  return sh;
}

/** Writes all collected import rows in batch calls. */
function flushImport_(ctx) {
  const C = CONFIG.col;
  const put = function (sh, keyCol, rows, width) {
    if (rows.length) sh.getRange(lastDataRow_(sh, keyCol) + 1, 1, rows.length, width).setValues(rows);
  };
  put(sheet_(CONFIG.tabs.projects), 1, ctx.newProjects, 7);
  put(sheet_(CONFIG.tabs.tasks), 2, ctx.tasks, C.COUNT);
  put(sheet_(CONFIG.tabs.archive), 2, ctx.archive, C.COUNT + 1);
  if (ctx.log.length) {
    const log = ensureLogTab_();
    log.getRange(Math.max(log.getLastRow(), 1) + 1, 1, ctx.log.length, 5).setValues(ctx.log);
  }
}
