# Planner

One-page day planner: brain dump, today's 3 main tasks, a day timeline with Google Calendar events beside the
tasks, a Calendar page, repeating tasks, reminders through Google Calendar, project colors, drag and drop.
Single user. It runs in two ways from the same code:

- **Local mode** (`php start.php`): on the user's own computer, no sign-in, answers only that computer.
- **Hosted** (any PHP host): behind one username and password.

This repository is **public**. Nothing personal goes into it: no real domains, account ids, names, emails or
machine paths. Private notes for the owner's own deployment live in `CLAUDE.local.md` (git-ignored).

## Layout

| Path | What |
|---|---|
| `public/` | The web root. `index.php` (board, or sign-in when hosted), `api.php` (JSON API), `assets/app.js` + `app.css` (front end, no dependencies, no build step). |
| `public/lib/` | `boot.php` (config, SQLite schema, sessions, login throttle, local mode), `calendar.php` (calls the bridge: reads, Google-event extras, sync), `series.php` (repeating tasks), `bridge.gs.txt` (Apps Script source the user pastes into Google; the key placeholder is filled in by `api.php?action=bridge_code`). Blocked by `.htaccess`. |
| `public/data/` | Runtime only: `config.php`, `planner.sqlite`, `sessions/`, `server.log`. Git-ignored, blocked by `.htaccess`, never uploaded or overwritten by a deploy. |
| `start.php`, `start.bat`, `start.sh` | Local start: checks PHP, switches on the needed extensions for that run, writes a local-mode config on first run, starts PHP's built-in server with `tools/router.php`, opens the browser. |
| `tools/router.php` | Decides what PHP's built-in server may serve in local mode (it ignores `.htaccess`). |
| `tools/make-config.php` | Writes a hosted (`env => prod`) config with a generated password. |
| `tools/deploy.py` | Publishes to Hostinger through its API. Target comes from `deploy.local.json` (git-ignored) or `PLANNER_*` env vars. |
| `tools/screenshots.py` | Regenerates `docs/img/*.png` from a made-up day. Run it after a visible UI change. |
| `tests/` | `test_api.py` (server checks, hosted and local mode) and `test_browser.py` (Playwright, headless Chromium). Both start throwaway local PHP servers and a fake calendar bridge. `test_bridge.js` (Node) runs `bridge.gs.txt` itself against fake Google services. |
| `docs/` | `index.html` is the GitHub Pages site; `google-calendar.md`, `hosting.md`, `sheets-version.md` are the guides the README links to. |
| `Planner.gs` | The earlier Google Sheets + Apps Script planner, kept for reference. Not used by the web app. |

## Commands

- Run locally: `php start.php` (`--port N`, `--no-browser`).
- Test: `python tests/test_api.py` and `python tests/test_browser.py` (need `php` on PATH), and
  `node tests/test_bridge.js` after any change to `bridge.gs.txt`. Never run them, or the app, from a cloud-synced
  folder: SQLite must not live there.
- Screenshots: `python tools/screenshots.py`.
- Hosted config: `php tools/make-config.php --username NAME`.

## How it works

- **Config:** `public/data/config.php` returns an array. `env` is `local` (start.php), `prod` (hosted) or `dev`
  (tests; with `allow_test_bridge` it accepts a fake bridge on 127.0.0.1).
- **Local mode:** `local_gate()` in `boot.php`. There is no username or password; a request gets through only if
  (1) PHP runs as the built-in server, (2) `REMOTE_ADDR` is loopback and the `Host` header is
  `localhost`/`127.0.0.1` (this stops DNS rebinding), and (3) the browser holds the `planner_local` cookie, whose
  value is `local_key` from the config. `start.php` opens `/?k=<local_key>`, which sets the cookie and redirects.
  The key keeps out other accounts on the machine and visitors forwarded by a proxy or tunnel. CSRF tokens still
  apply. A local-mode config on a web host answers nobody.
- **Local file serving:** `tools/router.php` is an allowlist (`/`, `index.php`, `api.php`, `assets/*.js|css|svg`),
  not a blocklist: blocklists were bypassed with `///data/...` and NTFS `::$DATA` paths. A new kind of asset
  must be added to that pattern.
- **Data model:** a task is in the brain dump (`place = dump`, no day) or planned on a day (`top` with slot 0-2,
  or `also`), optionally with a start minute. A task also carries `notes` (text) and `subs` (its subtasks, a JSON
  list of `{title, done}` stored on the task row and always sent as a whole list) and `remind` (minutes before,
  or null). Tasks may share a time with each other and with Google events: nothing but the day hours blocks a
  drop (`conflict()`); `lanes()` in `app.js` lays tasks and Google events (`gBlocks()`) side by side. The schema is
  versioned with `PRAGMA user_version` in `db()`; a schema change is a new `if ($version < N)` step there.
- **Boards:** a board is a separate task list (`boards` table, `tasks.board_id`); the first one is "Main".
  `state` takes `board` and returns only that board's tasks and projects (`projects.board_id`); a task keeps
  its project only on the project's board. Settings and the calendar are shared.
  The buttons at the top (`#tabs`) show only when there are two or more boards; the browser remembers its
  board in `localStorage`. A task dropped on another board's button moves to that board's brain dump.
  Each board has its own Google calendar (see Sync). Board names are the owner's data: none belong in
  this repo. Unfinished tasks from past days go back to the dump (`rollover`,
  called by the browser with its local date).
- **Events and the Calendar page:** an event (`events` table, schema version 5) belongs to one board and runs
  from `day_from` to `day_to` (at most 60 days), all-day unless `start`/`end` are set (one-day events only).
  It carries `location`, a project, `notes` and `subs` (the "To arrange" checklist, same shape as a task's).
  `event_apply()` in `api.php` checks the row as a whole after every change. `state` returns the day's events
  (chips in `#allday`, never on the timeline); `events` and `month` read a range of at most 62 days. `month` holds
  everything the Calendar page draws in one answer: events, the board's planned tasks and `google`, from
  `calendar_range()` in `calendar.php` (one bridge `range` call, cached 10 minutes in `cal_range_cache`). A
  bridge pasted before `range` existed answers "unknown action", which becomes `needsUpdate`: the page and
  Settings then show how to update the script. Google trouble never fails `month`. The Day | Calendar switch
  (`#pages`, `goPage()`) and Month | Week (`setView()`) are kept in `localStorage`; `render()` draws only the
  page in view (`renderCalendar()` for the Calendar page). Events are dragged to another day (`evDrag`, see
  Dragging); nothing re-draws the calendar during that drag. Events carry `remind` too: for a timed event the
  task choices (5, 10, 15, 30, 60, 1440), for an all-day one minutes before its first day (900, 360, 2340, 9540).
- **Repeating tasks** (`lib/series.php`, schema version 6): a `series` row holds the pattern (`rule` daily,
  weekdays, weekly or monthly, `anchor_day`, `until_day`, and the task's fields). Every day it falls on gets an
  ordinary task, a copy (`tasks.series_id` + `series_day`, unique together), made by `ensure_occurrences()` when
  `state`, `month`, `rollover` (60 days back, before the carry-over, so missed copies reach the dump) or
  `calendar_sync` list those days. A deleted copy is kept out by `series_skips`. `task_repeat` and
  `series_apply` change a series from a copy's day on: the old series ends the day before (`series_end()`
  deletes its untouched copies from then), a new one starts there, and days with a ticked copy are skipped by
  the new one (`series_hand_over()`). `task_out` gives `repeat` (the rule or ''). Undo of a deleted copy brings
  it back as a plain task. A deleted board's coming copies are dropped and made again on the new board.
- **Google events on the board:** the bridge sends each event's Google id; `cal_key()` makes a key per event and
  day (sha1 of `day|id|start|calendar`, since every occurrence of a repeating Google event shares its id; or of
  `day|title|start|end|calendar` for scripts without ids; start is empty for all-day). `with_extras()` adds
  `key, notes, subs, hidden` from `cal_extras` every time a day or range is read, cached or not. `cal_extra`
  saves them, only for an event the day really has. Hidden events stay in the data (`hidden: true`) so the hint
  can offer "N hidden · show"; the browser leaves them out of the timeline, free time and the Calendar page.
  `rollover` purges extras older than 60 days.
- **Sync:** `calendar_sync` (POST, browser's today) sends every board's timed tasks and events from today−1 to
  today+45 to the bridge's `sync` action in one call (`sync_items()`, up to `SYNC_TIMEOUT` seconds). The bridge
  keeps one calendar per board, "Planner <name>", remembered by id in ScriptProperties, and works by difference
  with two tags per event: the key, set right after creating, and the content hash (with `HASH_VERSION`), set
  last and only when reminders and color worked, so a half-written event is rewritten next time. It finds its
  events by key from 60 days before to 400 days after the window, writes a changed item anew before deleting the
  old copy (and removes twins), but deletes absent keys only inside the window. At most 400 writes and ~4.5
  minutes per call (`partial`; the next sync carries on); the old "Planner" blocks are cleared only at the end of
  a complete run. The whole request is validated before any Calendar call (`validSync_`), and `doPost` holds
  `LockService`'s script lock: a second writer gets `busy`, which the planner treats as "try again later" (no
  error, no `last_sync`). `bridge_call` accepts only a 2xx JSON reply with `ok: true` and no `error`; nothing
  else is cached. Reminders are 5-1440 minutes (Google takes 5-40320; a 0 from older data is read as 5).
  "unknown action" from an older script sets `sync_old` and answers `needsUpdate`; "Send to calendar" then
  falls back to the old `calendar_push`. The bridge reads and writes wall-clock times in the script's time zone
  and counts days as UTC civil dates (`shiftDay_`); `events_` is `range_` of one day. The browser syncs a few seconds
  after a change (`queueSync()`, delay `sync_delay_ms` from config, 8000 by default; tests use 400) and on opening
  when the last sync is over 30 minutes old (`last_sync`), one at a time; failures only show in `#calstat`.
  `state.sync` carries `auto, last, needsUpdate, delay`.
- **Calendar:** the server never holds Google credentials. An Apps Script web app in the user's Google account
  ("the bridge") answers `events`, `range`, `sync` and the old `push` for requests carrying the shared key from
  `data/config.php`. It reads every calendar ticked in Google Calendar except the planner's own (named "Planner",
  starting with "Planner ", or remembered as a board calendar), and writes only its own tagged events into those.
  It never deletes a calendar. Day results are cached 10 minutes in SQLite. On Windows, PHP has no CA bundle by default, so
  `bridge_call` asks curl to use the Windows certificate store.
- **Hosted security:** bcrypt password, per-address lockout (8 wrong tries / 15 min, counted atomically),
  `SameSite=Strict` HttpOnly Secure session cookie, CSRF header on every change, strict CSP (no inline scripts,
  so the front end uses `data-act` attributes instead of `onclick`).
- **Dragging:** a mouse uses HTML5 drag and drop; a finger uses the touch handlers in `app.js` (press and hold
  260 ms, then move; the page scrolls when the finger is near an edge). Both call `dragMove()` and `dragDrop()`.
  Nothing may re-render the board while a touch drag is active: a touch only reports to the element it started on.
  Subtasks are dragged into a new order the same two ways, through `subDrag`, `subMove()` and `subDrop()`.
  Events on the Calendar page move to another day the same two ways, through `evDrag`, `evMove()` and `evDrop()`
  (the day grabbed lands on the day let go); in the phone month view, where events are dots, there is no drag.
  Google events on the timeline are not draggable: their time is Google's.
- **Front end:** a delete is sent at once; "Undo" adds the task again (`restoreTask`), without its slot or time
  if those were taken meanwhile. A re-draw replaces the subtask and notes boxes, so `renderLists()` carries
  over what is being typed; notes are saved 700 ms after the last keystroke. `save()` ignores the answer to an
  older save once the task has changed again. Colors are CSS variables: dark is the standard look, and the
  sun button sets the cookie `planner_theme=light`, which `index.php` turns into `data-theme` on `<html>`.
- **Password pop-ups:** the password boxes in Settings sit in their own form with a user-name field. Without
  it, Chrome's password manager takes the first text box on the page (the brain dump) for the user name and
  offers saved logins there. Keep any new password field inside such a form.

## Rules

- No secrets and no personal details in this repo. `public/data/*` stays ignored.
- A deploy must never upload anything under `data/` except `.htaccess` (and `config.php` on first run or
  password reset).
- A new file type under `public/assets/` must be allowed in `tools/router.php`; a new blocking rule for hosts goes in `public/.htaccess`.
- The words in the calendar steps (`public/index.php`) and `docs/google-calendar.md` describe Google's screens;
  change them together.
