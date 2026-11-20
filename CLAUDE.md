# Planner

One-page day planner: brain dump, today's 3 main tasks, a day timeline where calendar events are
locked blocks, project colors, drag and drop. Single user. It runs in two ways from the same code:

- **Local mode** (`php start.php`): on the user's own computer, no sign-in, answers only that computer.
- **Hosted** (any PHP host): behind one username and password.

This repository is **public**. Nothing personal goes into it: no real domains, account ids, names, emails or
machine paths. Private notes for the owner's own deployment live in `CLAUDE.local.md` (git-ignored).

## Layout

| Path | What |
|---|---|
| `public/` | The web root. `index.php` (board, or sign-in when hosted), `api.php` (JSON API), `assets/app.js` + `app.css` (front end, no dependencies, no build step). |
| `public/lib/` | `boot.php` (config, SQLite schema, sessions, login throttle, local mode), `calendar.php` (calls the bridge), `bridge.gs.txt` (Apps Script source the user pastes into Google; the key placeholder is filled in by `api.php?action=bridge_code`). Blocked by `.htaccess`. |
| `public/data/` | Runtime only: `config.php`, `planner.sqlite`, `sessions/`, `server.log`. Git-ignored, blocked by `.htaccess`, never uploaded or overwritten by a deploy. |
| `start.php`, `start.bat`, `start.sh` | Local start: checks PHP, switches on the needed extensions for that run, writes a local-mode config on first run, starts PHP's built-in server with `tools/router.php`, opens the browser. |
| `tools/router.php` | Decides what PHP's built-in server may serve in local mode (it ignores `.htaccess`). |
| `tools/make-config.php` | Writes a hosted (`env => prod`) config with a generated password. |
| `tools/deploy.py` | Publishes to Hostinger through its API. Target comes from `deploy.local.json` (git-ignored) or `PLANNER_*` env vars. |
| `tools/screenshots.py` | Regenerates `docs/img/*.png` from a made-up day. Run it after a visible UI change. |
| `tests/` | `test_api.py` (server checks, hosted and local mode) and `test_browser.py` (Playwright, headless Chromium). Both start throwaway local PHP servers and a fake calendar bridge. |
| `docs/` | `index.html` is the GitHub Pages site; `google-calendar.md`, `hosting.md`, `sheets-version.md` are the guides the README links to. |
| `Planner.gs` | The earlier Google Sheets + Apps Script planner, kept for reference. Not used by the web app. |

## Commands

- Run locally: `php start.php` (`--port N`, `--no-browser`).
- Test: `python tests/test_api.py` and `python tests/test_browser.py` (need `php` on PATH). Never run them, or the
  app, from a cloud-synced folder: SQLite must not live there.
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
  list of `{title, done}` stored on the task row and always sent as a whole list). Tasks may share a time: only
  calendar events block a drop; `lanes()` in `app.js` lays overlapping blocks side by side. The schema is
  versioned with `PRAGMA user_version` in `db()`; a schema change is a new `if ($version < N)` step there.
- **Boards:** a board is a separate task list (`boards` table, `tasks.board_id`); the first one is "Main".
  `state` takes `board` and returns only that board's tasks; projects, settings and the calendar are shared.
  The buttons at the top (`#tabs`) show only when there are two or more boards; the browser remembers its
  board in `localStorage`. A task dropped on another board's button moves to that board's brain dump.
  "Send to calendar" sends the day's blocks of every board. Board names are the owner's data: none belong in
  this repo. Unfinished tasks from past days go back to the dump (`rollover`,
  called by the browser with its local date).
- **Calendar:** the server never holds Google credentials. An Apps Script web app in the user's Google account
  ("the bridge") answers `events` and `push` for requests carrying the shared key from `data/config.php`. It
  reads every calendar ticked in Google Calendar except "Planner", and writes only its own tagged events into
  "Planner". Day results are cached 10 minutes in SQLite. On Windows, PHP has no CA bundle by default, so
  `bridge_call` asks curl to use the Windows certificate store.
- **Hosted security:** bcrypt password, per-address lockout (8 wrong tries / 15 min, counted atomically),
  `SameSite=Strict` HttpOnly Secure session cookie, CSRF header on every change, strict CSP (no inline scripts,
  so the front end uses `data-act` attributes instead of `onclick`).
- **Dragging:** a mouse uses HTML5 drag and drop; a finger uses the touch handlers in `app.js` (press and hold
  260 ms, then move; the page scrolls when the finger is near an edge). Both call `dragMove()` and `dragDrop()`.
  Nothing may re-render the board while a touch drag is active: a touch only reports to the element it started on.
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
