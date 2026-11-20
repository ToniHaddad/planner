<?php
/**
 * JSON API for the board. Every call needs a signed-in session; every change needs the CSRF header.
 */
declare(strict_types=1);
require __DIR__ . '/lib/boot.php';
require __DIR__ . '/lib/calendar.php';

security_headers();
header('Content-Type: application/json; charset=utf-8');
start_session();

function reply(array $data, int $code = 200): void
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail(string $message, int $code = 400): void
{
    reply(['error' => $message], $code);
}

if (!logged_in()) fail('Signed out', 401);

$action = (string) ($_GET['action'] ?? '');
$isPost = $_SERVER['REQUEST_METHOD'] === 'POST';
$readOnly = ['state', 'calendar', 'bridge_code'];
if (in_array($action, $readOnly, true) === $isPost) fail('Wrong method', 405);
$in = [];
if ($isPost) {
    if (!csrf_ok($_SERVER['HTTP_X_CSRF'] ?? null)) fail('Session check failed. Reload the page.', 403);
    $in = json_decode((string) file_get_contents('php://input'), true);
    if (!is_array($in)) fail('Bad request body');
}
session_write_close(); // nothing below writes the session except password/logout, which reopen it

function valid_day($v): bool
{
    if (!is_string($v) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $v, $m)) return false;
    return checkdate((int) $m[2], (int) $m[3], (int) $m[1]);
}

function task_out(array $r): array
{
    return [
        'id' => (int) $r['id'], 'title' => $r['title'],
        'p' => $r['project_id'] === null ? null : (int) $r['project_id'],
        'dur' => (int) $r['dur'], 'where' => $r['place'],
        'slot' => $r['slot'] === null ? null : (int) $r['slot'],
        'day' => $r['day'], 'start' => $r['start'] === null ? null : (int) $r['start'],
        'done' => (bool) $r['done'], 'carried' => (bool) $r['carried'],
        'board' => (int) $r['board_id'],
        'notes' => (string) $r['notes'],
        'subs' => json_decode((string) $r['subs'], true) ?: [],
    ];
}

function clean_notes($v): string
{
    if (!is_string($v)) fail('Bad notes');
    return mb_substr(str_replace(["\r\n", "\r"], "\n", $v), 0, 5000);
}

/** Subtasks arrive as a whole list: [{title, done}, ...]. Returns the JSON to store. */
function clean_subs($v): string
{
    if (!is_array($v) || $v !== array_values($v) || count($v) > 50) fail('Bad subtasks');
    $out = [];
    foreach ($v as $s) {
        if (!is_array($s)) fail('Bad subtasks');
        $title = mb_substr(trim(preg_replace('/\s+/u', ' ', (string) ($s['title'] ?? ''))), 0, 300);
        if ($title !== '') $out[] = ['title' => $title, 'done' => !empty($s['done'])];
    }
    return json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

function get_task(int $id): array
{
    $st = db()->prepare('SELECT * FROM tasks WHERE id = ?');
    $st->execute([$id]);
    $row = $st->fetch();
    if (!$row) fail('That task no longer exists', 404);
    return $row;
}

/** Whether the project exists; with a board given, whether it is one of that board's projects. */
function project_exists($id, ?int $board = null): bool
{
    $st = db()->prepare('SELECT board_id FROM projects WHERE id = ?');
    $st->execute([(int) $id]);
    $b = $st->fetchColumn();
    return $b !== false && ($board === null || (int) $b === $board);
}

const MAX_BOARDS = 8;

function boards(): array
{
    return array_map(fn($b) => ['id' => (int) $b['id'], 'name' => $b['name']],
        db()->query('SELECT id, name FROM boards ORDER BY sort, id')->fetchAll());
}

/** The id of the board asked for, or of the first board when that one does not exist (any more). */
function board_id($v): int
{
    $all = array_column(boards(), 'id');
    return in_array((int) $v, $all, true) ? (int) $v : (int) $all[0];
}

function clean_board_name($v): string
{
    $n = mb_substr(trim(preg_replace('/\s+/u', ' ', (string) $v)), 0, 30);
    if ($n === '') fail('A board needs a name');
    return $n;
}

function clean_title($v): string
{
    $t = trim(preg_replace('/\s+/u', ' ', (string) $v));
    if ($t === '') fail('A task needs a title');
    return mb_substr($t, 0, 300);
}

function clean_color($v): string
{
    if (!is_string($v) || !preg_match('/^#[0-9a-fA-F]{6}$/', $v)) fail('Bad color');
    return strtolower($v);
}

function day_hours(): array
{
    return ['dayStart' => (int) setting('day_start', '7'), 'dayEnd' => (int) setting('day_end', '20')];
}

$pdo = db();

switch ($action) {
    case 'state':
        $day = $_GET['day'] ?? '';
        if (!valid_day($day)) fail('Bad day');
        $board = board_id($_GET['board'] ?? 0);
        $st = $pdo->prepare("SELECT * FROM tasks WHERE board_id = ? AND (place = 'dump' OR day = ?) ORDER BY id");
        $st->execute([$board, $day]);
        reply([
            'boards' => boards(),
            'board' => $board,
            'projects' => array_map(fn($p) => ['id' => (int) $p['id'], 'name' => $p['name'], 'color' => $p['color']],
                (function () use ($pdo, $board) {
                    $ps = $pdo->prepare('SELECT * FROM projects WHERE board_id = ? ORDER BY sort, id');
                    $ps->execute([$board]);
                    return $ps->fetchAll();
                })()),
            'tasks' => array_map('task_out', $st->fetchAll()),
            'settings' => day_hours(),
            'calendarConnected' => (bool) setting('bridge_url'),
            'user' => local_mode() ? '' : credentials()['username'],
            'local' => local_mode(),
        ]);

    case 'rollover':
        // Unfinished tasks from earlier days go back to the brain dump. "today" comes from the
        // browser (your time zone); it is only trusted within a day of the server's clock.
        $today = $in['today'] ?? '';
        if (!valid_day($today) || abs(strtotime($today . ' 12:00 UTC') - time()) > 2 * 86400) fail('Bad day');
        $st = $pdo->prepare("UPDATE tasks SET place = 'dump', day = NULL, start = NULL, slot = NULL, carried = 1
                             WHERE done = 0 AND day IS NOT NULL AND day < ?");
        $st->execute([$today]);
        reply(['ok' => true, 'carried' => $st->rowCount()]);

    case 'calendar':
        $day = $_GET['day'] ?? '';
        if (!valid_day($day)) fail('Bad day');
        reply(calendar_day($day, ($_GET['refresh'] ?? '') === '1'));

    case 'bridge_code':
        $code = (string) file_get_contents(__DIR__ . '/lib/bridge.gs.txt');
        reply(['code' => str_replace('__BRIDGE_KEY__', (string) cfg('bridge_key'), $code),
               'url' => (string) setting('bridge_url', '')]);

    case 'task_add':
        $title = clean_title($in['title'] ?? '');
        $board = board_id($in['board'] ?? 0);
        $p = $in['p'] ?? null;
        if ($p !== null && !project_exists($p, $board)) $p = null;
        $pdo->prepare("INSERT INTO tasks (title, project_id, dur, place, created_at, board_id) VALUES (?, ?, 30, 'dump', ?, ?)")
            ->execute([$title, $p, gmdate('c'), $board]);
        reply(['task' => task_out(get_task((int) $pdo->lastInsertId()))]);

    case 'task_update':
        $t = get_task((int) ($in['id'] ?? 0));
        $patch = is_array($in['patch'] ?? null) ? $in['patch'] : [];
        if (array_key_exists('title', $patch)) $t['title'] = clean_title($patch['title']);
        if (array_key_exists('p', $patch)) {
            $t['project_id'] = $patch['p'] !== null ? (int) $patch['p'] : null;
        }
        if (array_key_exists('dur', $patch)) {
            $d = (int) $patch['dur'];
            if ($d < 5 || $d > 720) fail('Bad length');
            $t['dur'] = $d;
        }
        if (array_key_exists('notes', $patch)) $t['notes'] = clean_notes($patch['notes']);
        if (array_key_exists('subs', $patch)) $t['subs'] = clean_subs($patch['subs']);
        if (array_key_exists('where', $patch)) {
            if (!in_array($patch['where'], ['dump', 'top', 'also'], true)) fail('Bad list');
            $t['place'] = $patch['where'];
        }
        if (array_key_exists('slot', $patch)) {
            $s = $patch['slot'];
            if ($s !== null && !in_array($s, [0, 1, 2], true)) fail('Bad slot');
            $t['slot'] = $s;
        }
        if (array_key_exists('day', $patch)) {
            if ($patch['day'] !== null && !valid_day($patch['day'])) fail('Bad day');
            $t['day'] = $patch['day'];
        }
        if (array_key_exists('start', $patch)) {
            $s = $patch['start'];
            if ($s !== null && (!is_int($s) || $s < 0 || $s > 1435)) fail('Bad start time');
            $t['start'] = $s;
        }
        if (array_key_exists('done', $patch)) {
            $done = (bool) $patch['done'];
            if ($done && !$t['done']) $t['done_at'] = gmdate('c');
            if (!$done) $t['done_at'] = null;
            $t['done'] = $done ? 1 : 0;
        }
        if (array_key_exists('board', $patch) && (int) $patch['board'] !== (int) $t['board_id']) {
            // A task moved to another board lands in that board's brain dump.
            if (board_id($patch['board']) !== (int) $patch['board']) fail('That board no longer exists', 404);
            $t['board_id'] = (int) $patch['board'];
            $t['place'] = 'dump';
        }
        // A project belongs to one board: a task keeps its project only on that board.
        if ($t['project_id'] !== null && !project_exists($t['project_id'], (int) $t['board_id'])) $t['project_id'] = null;
        // Keep the row consistent whatever the browser sent.
        if ($t['place'] === 'dump') { $t['day'] = null; $t['start'] = null; }
        elseif ($t['day'] === null) fail('A planned task needs a day');
        if ($t['place'] !== 'top') $t['slot'] = null;
        elseif ($t['slot'] === null) fail('A main task needs a slot');
        if ($t['place'] !== 'dump') $t['carried'] = 0;
        $pdo->prepare('UPDATE tasks SET title=?, project_id=?, dur=?, place=?, slot=?, day=?, start=?, done=?, done_at=?, carried=?, notes=?, subs=?, board_id=? WHERE id=?')
            ->execute([$t['title'], $t['project_id'], $t['dur'], $t['place'], $t['slot'], $t['day'], $t['start'],
                       $t['done'], $t['done_at'], $t['carried'], $t['notes'], $t['subs'], $t['board_id'], $t['id']]);
        reply(['task' => task_out(get_task((int) $t['id']))]);

    case 'task_delete':
        $pdo->prepare('DELETE FROM tasks WHERE id = ?')->execute([(int) ($in['id'] ?? 0)]);
        reply(['ok' => true]);

    case 'board_add':
        if (count(boards()) >= MAX_BOARDS) fail('That is the most boards the planner holds (' . MAX_BOARDS . ')');
        $name = clean_board_name($in['name'] ?? '');
        $pdo->prepare('INSERT INTO boards (name, sort) VALUES (?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM boards))')
            ->execute([$name]);
        reply(['board' => ['id' => (int) $pdo->lastInsertId(), 'name' => $name], 'boards' => boards()]);

    case 'board_update':
        $id = (int) ($in['id'] ?? 0);
        if (board_id($id) !== $id) fail('That board no longer exists', 404);
        $pdo->prepare('UPDATE boards SET name = ? WHERE id = ?')->execute([clean_board_name($in['name'] ?? ''), $id]);
        reply(['boards' => boards()]);

    case 'board_delete':
        // The board's tasks are kept: they move to the brain dump of the first board that stays,
        // and its projects go with them.
        $id = (int) ($in['id'] ?? 0);
        if (board_id($id) !== $id) fail('That board no longer exists', 404);
        $rest = array_values(array_filter(array_column(boards(), 'id'), fn($b) => $b !== $id));
        if (!$rest) fail('The last board cannot be deleted');
        $pdo->exec('BEGIN IMMEDIATE');
        $st = $pdo->prepare("UPDATE tasks SET board_id = ?, place = 'dump', day = NULL, start = NULL, slot = NULL WHERE board_id = ?");
        $st->execute([$rest[0], $id]);
        $pdo->prepare('UPDATE projects SET board_id = ? WHERE board_id = ?')->execute([$rest[0], $id]);
        $pdo->prepare('DELETE FROM boards WHERE id = ?')->execute([$id]);
        $pdo->exec('COMMIT');
        reply(['boards' => boards(), 'moved' => $st->rowCount(), 'to' => $rest[0]]);

    case 'project_add':
        $name = mb_substr(trim((string) ($in['name'] ?? '')), 0, 60) ?: 'New project';
        $pdo->prepare('INSERT INTO projects (name, color, sort, board_id) VALUES (?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM projects), ?)')
            ->execute([$name, clean_color($in['color'] ?? ''), board_id($in['board'] ?? 0)]);
        reply(['project' => ['id' => (int) $pdo->lastInsertId(), 'name' => $name, 'color' => clean_color($in['color'])]]);

    case 'project_update':
        $id = (int) ($in['id'] ?? 0);
        if (!project_exists($id)) fail('That project no longer exists', 404);
        if (isset($in['name'])) {
            $name = mb_substr(trim((string) $in['name']), 0, 60) ?: 'Project';
            $pdo->prepare('UPDATE projects SET name = ? WHERE id = ?')->execute([$name, $id]);
        }
        if (isset($in['color'])) {
            $pdo->prepare('UPDATE projects SET color = ? WHERE id = ?')->execute([clean_color($in['color']), $id]);
        }
        reply(['ok' => true]);

    case 'project_delete':
        $pdo->prepare('DELETE FROM projects WHERE id = ?')->execute([(int) ($in['id'] ?? 0)]);
        reply(['ok' => true]);

    case 'settings':
        $s = (int) ($in['dayStart'] ?? -1);
        $e = (int) ($in['dayEnd'] ?? -1);
        if ($s < 0 || $e > 24 || $e - $s < 4) fail('The day needs at least 4 hours between start and end');
        set_setting('day_start', (string) $s);
        set_setting('day_end', (string) $e);
        reply(['settings' => day_hours()]);

    case 'password':
        if (local_mode()) fail('There is no password in local mode');
        $cred = credentials();
        session_start();
        if (reserve_attempt() > 0) fail('Too many wrong attempts. Wait a few minutes.', 429);
        if (!password_verify((string) ($in['current'] ?? ''), $cred['hash'])) fail('The current password is wrong');
        $pdo->prepare('DELETE FROM attempts WHERE ip = ?')->execute([client_ip()]);
        $new = (string) ($in['new'] ?? '');
        if (strlen($new) < 12) fail('Use at least 12 characters');
        if (strlen($new) > 72) fail('Use at most 72 characters');
        $newHash = password_hash($new, PASSWORD_BCRYPT, ['cost' => 12]);
        // Only replace the hash that was just verified, so two changes at once cannot cross.
        $st = $pdo->prepare("UPDATE settings SET v = ? WHERE k = 'password_hash' AND v = ?");
        $st->execute([$newHash, $cred['hash']]);
        if ($st->rowCount() !== 1) fail('The password was changed elsewhere. Sign in again.', 409);
        $_SESSION['cred'] = stamp_of($newHash); // every other session is now signed out
        session_regenerate_id(true);
        reply(['ok' => true]);

    case 'calendar_connect':
        $url = trim((string) ($in['url'] ?? ''));
        if (!bridge_url_valid($url)) {
            fail('That is not a web app address. It should look like https://script.google.com/macros/s/…/exec');
        }
        try {
            $ping = bridge_call($url, ['action' => 'ping']);
        } catch (Throwable $e) {
            fail($e->getMessage());
        }
        set_setting('bridge_url', $url);
        $pdo->exec('DELETE FROM cal_cache');
        reply(['ok' => true, 'calendars' => $ping['calendars'] ?? [], 'tz' => $ping['tz'] ?? '']);

    case 'calendar_disconnect':
        set_setting('bridge_url', null);
        $pdo->exec('DELETE FROM cal_cache');
        reply(['ok' => true]);

    case 'calendar_push':
        $day = $in['day'] ?? '';
        if (!valid_day($day)) fail('Bad day');
        $url = setting('bridge_url');
        if (!$url) fail('Connect your calendar first (Settings)');
        $st = $pdo->prepare('SELECT t.title, t.start, t.dur, p.color FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
                             WHERE t.day = ? AND t.start IS NOT NULL ORDER BY t.start, t.id');
        $st->execute([$day]);
        $blocks = array_map(fn($r) => ['title' => $r['title'], 'start' => (int) $r['start'], 'dur' => (int) $r['dur'],
                                       'color' => $r['color']], $st->fetchAll());
        try {
            $res = bridge_call($url, [], ['action' => 'push', 'date' => $day, 'blocks' => $blocks]);
        } catch (Throwable $e) {
            fail($e->getMessage(), 502);
        }
        reply(['ok' => true, 'created' => (int) ($res['created'] ?? 0), 'removed' => (int) ($res['removed'] ?? 0)]);

    case 'logout':
        if (local_mode()) fail('There is no sign-in in local mode');
        session_start();
        logout();
        reply(['ok' => true]);

    default:
        fail('Unknown action', 404);
}
