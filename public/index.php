<?php
/**
 * The only page: shows the sign-in form, or the board once signed in.
 */
declare(strict_types=1);
require __DIR__ . '/lib/boot.php';

security_headers();
start_session();

$error = '';
if ($_SERVER['REQUEST_METHOD'] === 'POST' && !logged_in()) {
    if (!csrf_ok($_POST['csrf'] ?? null)) {
        $error = 'The form expired. Try again.';
    } else {
        $result = try_login((string) ($_POST['username'] ?? ''), (string) ($_POST['password'] ?? ''));
        if ($result === 0) {
            header('Location: ./', true, 303);
            exit;
        }
        $error = $result > 0
            ? 'Too many wrong attempts. Try again in ' . (int) ceil($result / 60) . ' min.'
            : 'Wrong username or password.';
    }
}
$v = (string) max((int) @filemtime(__DIR__ . '/assets/app.js'), (int) @filemtime(__DIR__ . '/assets/app.css'));
$theme = ($_COOKIE['planner_theme'] ?? '') === 'light' ? 'light' : 'dark';   // dark unless the sun button was used
?>
<!DOCTYPE html>
<html lang="en" data-theme="<?= $theme ?>">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="<?= $theme ?>">
<title>Planner</title>
<link rel="icon" href="assets/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="assets/app.css?v=<?= h($v) ?>">
<?php if (logged_in()): ?>
<meta name="csrf" content="<?= h(csrf_token()) ?>">
<script src="assets/app.js?v=<?= h($v) ?>" defer></script>
<?php endif; ?>
</head>
<body>
<?php if (!logged_in()): ?>
<main class="login">
  <form method="post" action="./" class="login-card" autocomplete="on">
    <h1>Planner</h1>
    <p class="hint">Sign in to plan your day.</p>
    <?php if ($error): ?><p class="err" role="alert"><?= h($error) ?></p><?php endif; ?>
    <input type="hidden" name="csrf" value="<?= h(csrf_token()) ?>">
    <label>Username<input name="username" autocomplete="username" required autofocus></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="btn go" type="submit">Sign in</button>
  </form>
</main>
<?php else: ?>
<div class="wrap">
  <div class="app">
    <nav class="tabs" id="tabs" aria-label="Boards" hidden></nav>
    <div class="top">
      <div class="seg" id="pages" role="group" aria-label="Page">
        <button data-act="page" data-page="day" aria-pressed="true" class="on">Day</button><button data-act="page" data-page="calendar" aria-pressed="false">Calendar</button>
      </div>
      <button class="btn icon" id="prev" data-act="prev" title="Previous day" aria-label="Previous day">‹</button>
      <button class="btn" data-act="today">Today</button>
      <button class="btn icon" id="next" data-act="next" title="Next day" aria-label="Next day">›</button>
      <h1 id="dayname"></h1><span class="date" id="daydate"></span>
      <span class="pill" id="free"></span>
      <span class="sp"></span>
      <span class="calstat" id="calstat"></span>
      <button class="btn go" id="push" data-act="push" title="Bring your planned times and events into Google Calendar now, one calendar per board" hidden>Send to calendar</button>
      <button class="btn icon" id="theme" data-act="theme" title="Switch between dark and light" aria-label="Switch between dark and light"><?= $theme === 'light' ? '☾' : '☀' ?></button>
      <button class="btn icon" data-act="settings-open" title="Settings" aria-label="Settings">⚙</button>
    </div>
    <div class="cols">
      <div class="col c1">
        <h2 class="h"><span class="num">1</span>Brain dump</h2>
        <p class="hint">Empty your head. Sort later. The ⋯ on a task opens its subtasks and notes. Double-click a title to rename it; drag a subtask to reorder.</p>
        <p class="hint touch-only">To move a task, press and hold it, then drag.</p>
        <?php /* A form with a button: some phone keyboards have no Enter key for a lone text box. */ ?>
        <form class="add" id="add-form" method="post" action="./"><input id="new" name="task" type="text" placeholder="Type a task…" aria-label="New task" autocomplete="off" enterkeyhint="done" data-lpignore="true" data-1p-ignore data-bwignore maxlength="300" autofocus><select id="newp" name="project" title="Project"></select><button class="btn go" type="submit" title="Add the task">Add</button></form>
        <div class="zone" id="z-dump" data-zone="dump" data-empty="Head empty. Nice."></div>
        <h2 class="h gap">Projects</h2>
        <p class="hint" id="projhint">Click a color to change it everywhere.</p>
        <div id="projects"></div>
        <button class="link" data-act="add-project">+ Add project</button>
      </div>
      <div class="col c2">
        <h2 class="h"><span class="num">2</span>Today's 3</h2>
        <p class="hint">If only these get done, the day was good.</p>
        <div id="top3"></div>
        <h2 class="h gap">Also today</h2>
        <p class="hint">Smaller things, if there's room.</p>
        <div class="zone" id="z-also" data-zone="also" data-empty="Drop smaller tasks here"></div>
      </div>
      <div class="col c3">
        <h2 class="h"><span class="num">3</span>Timebox</h2>
        <p class="hint" id="tlhint">Tasks can share a time with anything: they sit side by side.</p>
        <div class="allday" id="allday"></div>
        <div class="tl" id="tl"></div>
      </div>
    </div>
    <div class="cal" id="cal" hidden>
      <div class="cal-main">
        <div class="cal-bar">
          <div class="seg" id="views" role="group" aria-label="Calendar view">
            <button data-act="cal-view" data-view="month" aria-pressed="true" class="on">Month</button><button data-act="cal-view" data-view="week" aria-pressed="false">Week</button>
          </div>
          <span class="hint" id="cal-hint">Click a day to add an event; drag an event to move it.</span>
          <span class="sp"></span>
          <button class="btn go" data-act="event-new">+ Event</button>
        </div>
        <p class="cal-note" id="cal-note" hidden></p>
        <div class="cal-days" id="cal-days"></div>
        <div class="cal-grid" id="cal-grid"></div>
      </div>
      <aside class="up" aria-labelledby="up-head">
        <h2 class="h" id="up-head">Coming up</h2>
        <p class="hint">Your events of the next 60 days, and what is still to arrange for the first ones. Tick things off here.</p>
        <div id="up"></div>
      </aside>
    </div>
  </div>
</div>

<dialog id="event-dlg" aria-labelledby="ev-head">
  <form id="event-form" autocomplete="off" novalidate>
    <div class="dlg-head"><h2 id="ev-head">New event</h2><button type="button" class="btn icon" data-act="event-close" title="Close" aria-label="Close">×</button></div>
    <section class="ev-form">
      <label class="fld">Title<input id="ev-title" name="event-title" type="text" maxlength="300" autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore></label>
      <div class="fld-row">
        <label class="fld">From<input id="ev-from" name="event-from" type="date" autocomplete="off"></label>
        <label class="fld">To<input id="ev-to" name="event-to" type="date" autocomplete="off"></label>
        <label class="fld chk"><input id="ev-allday" name="event-allday" type="checkbox" checked> All day</label>
      </div>
      <div class="fld-row" id="ev-times" hidden>
        <label class="fld">Starts<input id="ev-start" name="event-start" type="time" step="900" autocomplete="off"></label>
        <label class="fld">Ends<input id="ev-end" name="event-end" type="time" step="900" autocomplete="off"></label>
      </div>
      <label class="fld">Location<input id="ev-loc" name="event-place" type="text" maxlength="200" autocomplete="off" data-lpignore="true" data-1p-ignore data-bwignore></label>
      <div class="fld-row">
        <label class="fld">Project<select id="ev-proj" name="event-project"></select></label>
        <label class="fld">Remind me<select id="ev-remind" name="event-remind" data-value=""></select></label>
      </div>
      <div class="fld">To arrange
        <ul class="subs" id="ev-subs"></ul>
        <div class="subaddrow"><input class="subadd" id="ev-subadd" name="event-arrange" type="text" maxlength="300" placeholder="Add something to arrange…" aria-label="New thing to arrange" autocomplete="off" enterkeyhint="done" data-lpignore="true" data-1p-ignore data-bwignore><button type="button" class="btn small" data-act="evsub-add" title="Add it to the list">Add</button></div>
      </div>
      <label class="fld">Notes<textarea id="ev-notes" name="event-notes" rows="3" maxlength="5000" placeholder="Contacts, times, what to bring…"></textarea></label>
      <p class="err" id="ev-error" role="alert" hidden></p>
    </section>
    <section class="dlg-foot">
      <button type="button" class="btn danger" id="ev-del" data-act="event-delete">Delete</button>
      <span class="sp"></span>
      <button type="button" class="btn" data-act="event-close">Cancel</button>
      <button type="submit" class="btn go" id="ev-save">Save</button>
    </section>
  </form>
</dialog>

<dialog id="gev-dlg" aria-labelledby="gev-head">
  <div class="dlg-head"><h2 id="gev-head">Calendar event</h2><button type="button" class="btn icon" data-act="gev-close" title="Close" aria-label="Close">×</button></div>
  <section class="ev-form">
    <div><b class="gev-title" id="gev-title"></b><p class="hint" id="gev-when"></p></div>
    <div class="fld">Subtasks
      <ul class="subs" id="gev-subs"></ul>
      <div class="subaddrow"><input class="subadd" id="gev-subadd" name="calendar-subtask" type="text" maxlength="300" placeholder="Add a subtask…" aria-label="New subtask" autocomplete="off" enterkeyhint="done" data-lpignore="true" data-1p-ignore data-bwignore><button type="button" class="btn small" data-act="gev-sub-add" title="Add the subtask">Add</button></div>
    </div>
    <label class="fld">Notes<textarea id="gev-notes" name="calendar-notes" rows="3" maxlength="5000" placeholder="Notes…"></textarea></label>
    <p class="hint">Subtasks and notes stay in the planner; the event itself is Google’s.</p>
  </section>
  <section class="dlg-foot">
    <button type="button" class="btn danger" data-act="gev-hide">Hide from the planner</button>
    <span class="hint">It stays in Google Calendar.</span>
    <span class="sp"></span>
    <button type="button" class="btn go" data-act="gev-close">Done</button>
  </section>
</dialog>

<dialog id="settings">
  <div class="dlg-head"><h2>Settings</h2><button class="btn icon" data-act="settings-close" title="Close" aria-label="Close">×</button></div>

  <section>
    <h3>Google Calendar</h3>
    <p id="cal-state" class="hint"></p>
    <div id="cal-setup">
      <p class="hint">Your events show up on the timeline, so you see the time you really have, and your planned times
        and events go back into Google Calendar, which reminds you of them. The planner talks to Google through a small
        script that runs inside <b>your own</b> Google account; your Google password never reaches the planner. Five
        steps, about three minutes, done once.</p>
      <ol class="steps">
        <li><b>Copy the script.</b>
          <button class="btn small" data-act="copy-code">Copy script</button>
          <span class="okmark" id="copied" hidden>Copied</span></li>
        <li><b>Paste it into a new Apps Script project.</b>
          <a class="btn small" href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">Open Google Apps Script ↗</a>
          <span class="sub">Sign in with the Google account that holds your calendar. Click in the code editor, select
            everything (Ctrl+A, or ⌘A on a Mac) and paste over it.</span></li>
        <li><b>Deploy it as a web app.</b>
          <span class="sub">Top right: <b>Deploy › New deployment</b>. Click the gear beside “Select type” and choose
            <b>Web app</b>. Set <b>Execute as: Me</b> and <b>Who has access: Anyone</b>, then click <b>Deploy</b>.</span></li>
        <li><b>Allow it to use your calendar.</b>
          <span class="sub">Click <b>Authorize access</b> and pick your account. Google warns that it “hasn’t verified
            this app”. That is expected for a script you just made yourself: click <b>Advanced</b>, then
            <b>Go to Untitled project (unsafe)</b>, then <b>Allow</b> (tick the calendar box if Google shows one).</span></li>
        <li><b>Paste the web app URL here.</b>
          <span class="sub">Google now shows a <b>Web app URL</b> ending in <code>/exec</code>. Copy it and paste it below.</span>
          <div class="row"><input id="bridge-url" placeholder="https://script.google.com/macros/s/…/exec" aria-label="Web app URL" autocomplete="off" spellcheck="false"><button class="btn go" data-act="connect-cal">Connect</button></div>
          <p class="err" id="cal-error" role="alert" hidden></p></li>
      </ol>
      <details>
        <summary>What can the script see and do?</summary>
        <p class="hint">It reads the events of every calendar you have ticked in Google Calendar (calendars you
          subscribed to there, such as Outlook, included). It writes your planned times and events into calendars of
          its own, one per board, named “Planner” and the board’s name (for example “Planner Main”), and only ever
          changes or removes events it made itself. It never deletes a calendar. It also uses Google’s lock and
          script-properties services, to remember which calendar belongs to which board and to stop two updates
          running at once. It carries a secret key made for
          this planner and ignores every request without that key, which is why “Anyone” is safe to choose in step 3.
          Don’t share the script. You can switch it off at any time: in Apps Script, <b>Deploy › Manage
          deployments › Archive</b>.</p>
      </details>
      <details>
        <summary>It didn’t connect</summary>
        <ul class="hint">
          <li><b>“Google answered with a page instead of data”</b>: either “Who has access” is not <b>Anyone</b> (it
            must not be “Anyone with a Google account”), or the script ran into an error. For both: copy the script
            again, paste it over the old one, then Deploy › Manage deployments › edit: set Who has access to
            <b>Anyone</b> and Version to <b>New version</b>, then Deploy.</li>
          <li><b>“The bridge refused the key”</b>: the script in Google is not the one from step 1. Copy it again,
            paste it over the old one, then Deploy › Manage deployments › edit › Version: <b>New version</b> › Deploy.</li>
          <li><b>The URL is refused</b>: use the <b>Web app URL</b> (it ends in <code>/exec</code>), not the address
            in your browser’s address bar.</li>
          <li>A work or school account may block scripts like this one. Try a personal Google account, or ask your
            administrator.</li>
        </ul>
      </details>
    </div>
    <div id="cal-on" hidden>
      <p class="hint">Events are read again every ten minutes; the ↻ button at the top of the board reads them now.
        To show or hide a calendar, tick or untick it in Google Calendar’s list.</p>
      <p class="hint">Your planned times and events go into one Google calendar per board, named “Planner” and the
        board’s name (for example “Planner Main”), for the next 45 days. Reminders you set ring through Google
        Calendar, on every device where it is signed in; on a phone, Google Calendar’s own notification settings
        decide how. A deleted board’s calendar is left as it is: delete it in Google Calendar if you no longer want it.</p>
      <label class="chkrow"><input type="checkbox" id="auto-sync" name="auto-sync"> Keep Google Calendar up to date automatically</label>
      <p class="hint" id="sync-last"></p>
      <button class="btn small" data-act="disconnect-cal">Disconnect calendar</button>
      <details id="cal-update">
        <summary>Update the script</summary>
        <p class="hint" id="cal-old" hidden>Your calendar script is older than this planner, so it cannot yet show
          your Google events on the Calendar page, set reminders or keep one calendar per board.</p>
        <p class="hint">A newer planner can need a newer script: this one brings Google events on the Calendar page,
          reminders, and one Google calendar per board. Updating keeps the same web app URL, so there is nothing to
          change here afterwards.</p>
        <ol class="steps">
          <li><b>Copy the script again.</b>
            <button class="btn small" data-act="copy-code">Copy script</button>
            <span class="okmark" id="copied-again" hidden>Copied</span></li>
          <li><b>Paste it over the old one.</b>
            <a class="btn small" href="https://script.google.com/home" target="_blank" rel="noopener">Open Google Apps Script ↗</a>
            <span class="sub">Open the project you made for the planner. Click in the code editor, select everything
              (Ctrl+A, or ⌘A on a Mac) and paste over it.</span></li>
          <li><b>Deploy it as a new version.</b>
            <span class="sub">Top right: <b>Deploy › Manage deployments</b>. Click the pencil (edit), set
              <b>Version: New version</b>, then click <b>Deploy</b>. If Google asks for permission again, allow it as
              the first time: <b>Advanced</b>, then <b>Go to Untitled project (unsafe)</b>, then <b>Allow</b>.</span></li>
        </ol>
      </details>
    </div>
    <details id="code-box">
      <summary>Show the script</summary>
      <textarea id="bridge-code" readonly rows="6" spellcheck="false" aria-label="Calendar script"></textarea>
    </details>
    <p class="hint more-cal">Use Outlook, iCloud or another calendar? Anything you subscribe to inside Google Calendar already
      shows up here. If you need a direct connection to something else,
      <a href="<?= h(REPO_URL) ?>/issues/new" target="_blank" rel="noopener">get in touch</a>.</p>
  </section>

  <section>
    <h3>Boards</h3>
    <p class="hint">A board is its own brain dump, Today's 3 and timeline: one per person or area of work. With more
      than one, buttons at the top switch between them. Each board has its own projects; the calendar and the day
      hours are shared. To move a task, drag it onto another board's button (it arrives without a project).</p>
    <div id="boards"></div>
    <button class="link" data-act="add-board">+ Add board</button>
  </section>

  <section>
    <h3>Day hours</h3>
    <div class="row">
      <label>From <select id="set-start"></select></label>
      <label>to <select id="set-end"></select></label>
      <button class="btn" data-act="save-hours">Save</button>
    </div>
  </section>

<?php if (!local_mode()): ?>
  <section>
    <h3>Password</h3>
    <?php /* Its own form, with the user name in it: otherwise the browser's password manager takes the
             first text box on the page (the brain dump) for the user name and offers saved logins there. */ ?>
    <form class="row" id="pw-form" method="post" action="./">
      <input type="text" name="username" autocomplete="username" value="<?= h(credentials()['username']) ?>" readonly hidden>
      <input id="pw-cur" name="current-password" type="password" placeholder="Current password" aria-label="Current password" autocomplete="current-password">
      <input id="pw-new" name="new-password" type="password" placeholder="New password (12+ characters)" aria-label="New password" autocomplete="new-password">
      <button class="btn" type="submit">Change</button>
    </form>
  </section>
<?php endif; ?>

  <section class="dlg-foot">
    <span class="hint" id="whoami"></span>
    <span class="sp"></span>
    <a class="hint" href="<?= h(REPO_URL) ?>#readme" target="_blank" rel="noopener">Help &amp; source</a>
<?php if (!local_mode()): ?>
    <button class="btn" data-act="logout">Sign out</button>
<?php endif; ?>
  </section>
</dialog>
<div class="toast" id="toast" role="status"><span id="toast-msg"></span><button class="toast-act" id="toast-act" hidden></button></div>
<?php endif; ?>
</body>
</html>
