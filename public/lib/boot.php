<?php
/**
 * Shared bootstrap: config, database, session, security headers, helpers.
 * Secrets live in data/config.php (never in git, never served).
 */
declare(strict_types=1);

const DATA_DIR = __DIR__ . '/../data';
const SESSION_DAYS = 30;
const REPO_URL = 'https://github.com/ToniHaddad/planner';

$cfgFile = DATA_DIR . '/config.php';
if (!is_file($cfgFile)) {
    http_response_code(503);
    exit('Planner is not set up yet. On your own computer, run start.php. On a web host, see docs/hosting.md.');
}
$CFG = require $cfgFile;

function cfg(string $key, $default = null)
{
    global $CFG;
    return $CFG[$key] ?? $default;
}

function is_prod(): bool
{
    return cfg('env', 'prod') === 'prod';
}

/**
 * Local mode (env 'local', written by start.php): the planner runs on this computer for the
 * person sitting at it, so there is no username or password. Three things together replace
 * the sign-in:
 *   1. it only runs under PHP's built-in server, which start.php binds to this computer;
 *   2. the request must come from this computer and be addressed to it by a local name,
 *      which stops a web page from reaching it through a domain pointed at 127.0.0.1;
 *   3. the browser must hold the key that start.php hands over when it opens the planner,
 *      which keeps out other accounts on the same computer and anything that forwards
 *      outside visitors to it (a reverse proxy, a tunnel).
 */
function local_mode(): bool
{
    return cfg('env') === 'local';
}

function local_request(): bool
{
    $addr = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    $host = strtolower((string) ($_SERVER['HTTP_HOST'] ?? ''));
    $host = (string) preg_replace('/:\d{1,5}$/', '', $host);
    return PHP_SAPI === 'cli-server'
        && in_array($addr, ['127.0.0.1', '::1'], true)
        && in_array($host, ['127.0.0.1', 'localhost', '[::1]'], true);
}

const LOCAL_COOKIE = 'planner_local';

function local_refuse(string $message): void
{
    http_response_code(403);
    header('Content-Type: text/html; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store');
    header('Referrer-Policy: no-referrer');
    exit('<!DOCTYPE html><html lang="en"><meta charset="utf-8"><title>Planner</title>'
        . '<body style="font:16px/1.5 system-ui,sans-serif;max-width:34em;margin:15vh auto;padding:0 20px">'
        . '<h1 style="font-size:22px">Planner</h1><p>' . $message . '</p></body></html>');
}

/** Lets a local-mode request through, or ends it with a 403. */
function local_gate(): void
{
    if (!local_request()) {
        local_refuse('This planner runs in local mode and answers only on the computer it runs on. '
            . 'To use it from other devices, set it up for a web host: see docs/hosting.md.');
    }
    $key = (string) cfg('local_key', '');
    $given = $_GET['k'] ?? null;
    if (strlen($key) >= 32 && is_string($given) && hash_equals($key, $given)) {
        setcookie(LOCAL_COOKIE, $key, ['expires' => time() + 400 * 86400, 'path' => '/',
            'httponly' => true, 'samesite' => 'Strict']);
        header('Referrer-Policy: no-referrer');
        header('Cache-Control: no-store');
        header('Location: ./', true, 303);     // drops the key from the address bar
        exit;
    }
    $cookie = $_COOKIE[LOCAL_COOKIE] ?? null;
    if (strlen($key) < 32 || !is_string($cookie) || !hash_equals($key, $cookie)) {
        local_refuse('To open the planner, start it the usual way: double-click <b>start.bat</b> on Windows, '
            . 'or run <b>./start.sh</b> on macOS and Linux. It opens here by itself.');
    }
}

if (local_mode()) local_gate();

/** SQLite connection; creates the schema on first use. */
function db(): PDO
{
    static $pdo = null;
    if ($pdo) return $pdo;
    $pdo = new PDO('sqlite:' . DATA_DIR . '/planner.sqlite');
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 4000; PRAGMA foreign_keys = ON;');
    $version = (int) $pdo->query('PRAGMA user_version')->fetchColumn();
    if ($version < 1) {
        $pdo->exec("
            CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL,
                sort INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
                project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
                dur INTEGER NOT NULL DEFAULT 30,
                place TEXT NOT NULL DEFAULT 'dump',   -- dump | top | also
                slot INTEGER, day TEXT, start INTEGER,
                done INTEGER NOT NULL DEFAULT 0, done_at TEXT,
                carried INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS tasks_day ON tasks(day);
            CREATE TABLE IF NOT EXISTS attempts (ip TEXT NOT NULL, ts INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS attempts_ts ON attempts(ts);
            CREATE TABLE IF NOT EXISTS cal_cache (day TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL);
            INSERT INTO projects (name, color, sort) VALUES
                ('Work', '#e9967a', 1), ('Personal', '#7fb7be', 2), ('Learning', '#9d8fd6', 3), ('Admin', '#b9b3a7', 4);
            PRAGMA user_version = 1;
        ");
    }
    if ($version < 2) {
        // Notes and subtasks live on the task row (subtasks as a JSON list). The starter
        // project colors get brighter, unless they were changed by hand.
        $pdo->exec('BEGIN IMMEDIATE');          // two requests at once must not both add the columns
        try {
            if ((int) $pdo->query('PRAGMA user_version')->fetchColumn() < 2) {
                $pdo->exec("
                    ALTER TABLE tasks ADD COLUMN notes TEXT NOT NULL DEFAULT '';
                    ALTER TABLE tasks ADD COLUMN subs TEXT NOT NULL DEFAULT '[]';
                    UPDATE projects SET color = '#ff7a59' WHERE color = '#e9967a';
                    UPDATE projects SET color = '#2fd6c8' WHERE color = '#7fb7be';
                    UPDATE projects SET color = '#a78bfa' WHERE color = '#9d8fd6';
                    UPDATE projects SET color = '#ffc83d' WHERE color = '#b9b3a7';
                    PRAGMA user_version = 2;
                ");
            }
            $pdo->exec('COMMIT');
        } catch (Throwable $e) {
            $pdo->exec('ROLLBACK');
            throw $e;
        }
    }
    if ($version < 3) {
        // Boards: separate task lists (one per person or area) behind the buttons at the top.
        // Every existing task goes to the first board.
        $pdo->exec('BEGIN IMMEDIATE');
        try {
            if ((int) $pdo->query('PRAGMA user_version')->fetchColumn() < 3) {
                $pdo->exec("
                    CREATE TABLE boards (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
                    INSERT INTO boards (id, name, sort) VALUES (1, 'Main', 1);
                    ALTER TABLE tasks ADD COLUMN board_id INTEGER NOT NULL DEFAULT 1;
                    CREATE INDEX tasks_board ON tasks(board_id);
                    PRAGMA user_version = 3;
                ");
            }
            $pdo->exec('COMMIT');
        } catch (Throwable $e) {
            $pdo->exec('ROLLBACK');
            throw $e;
        }
    }
    return $pdo;
}

function setting(string $key, ?string $default = null): ?string
{
    $st = db()->prepare('SELECT v FROM settings WHERE k = ?');
    $st->execute([$key]);
    $v = $st->fetchColumn();
    return $v === false ? $default : (string) $v;
}

function set_setting(string $key, ?string $value): void
{
    if ($value === null) {
        db()->prepare('DELETE FROM settings WHERE k = ?')->execute([$key]);
        return;
    }
    db()->prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
        ->execute([$key, $value]);
}

function security_headers(): void
{
    header('X-Frame-Options: DENY');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: same-origin');
    header("Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
        . "frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    header('Cache-Control: no-store');
    if (is_prod()) header('Strict-Transport-Security: max-age=31536000');
}

/** Sessions are kept in data/sessions so the host's cleanup cannot log you out early. */
function start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) return;
    $dir = DATA_DIR . '/sessions';
    if (!is_dir($dir)) mkdir($dir, 0700, true);
    $life = SESSION_DAYS * 86400;
    ini_set('session.save_path', $dir);
    ini_set('session.gc_maxlifetime', (string) $life);
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    session_name('planner');
    session_set_cookie_params([
        'lifetime' => $life, 'path' => '/', 'secure' => is_prod(),
        'httponly' => true, 'samesite' => 'Strict',
    ]);
    session_start();
    if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));
}

function csrf_token(): string
{
    return $_SESSION['csrf'] ?? '';
}

function csrf_ok(?string $given): bool
{
    return is_string($given) && $given !== '' && hash_equals(csrf_token(), $given);
}

function logged_in(): bool
{
    if (local_mode()) return true;   // local_gate() has already let this request through
    return !empty($_SESSION['user']) && ($_SESSION['cred'] ?? '') === cred_stamp();
}

/** Username and password hash in force: the database copy unless config.php carries a newer one. */
function credentials(): array
{
    $cfgVersion = (int) cfg('cred_version', 0);
    if ($cfgVersion > (int) setting('cred_version', '0')) {
        set_setting('username', (string) cfg('username'));
        set_setting('password_hash', (string) cfg('password_hash'));
        set_setting('cred_version', (string) $cfgVersion);
    }
    return ['username' => (string) setting('username', ''), 'hash' => (string) setting('password_hash', '')];
}

/** Changes whenever the password changes, which signs out every older session. */
function cred_stamp(): string
{
    return stamp_of(credentials()['hash']);
}

function client_ip(): string
{
    return (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
}

const MAX_FAILS_PER_IP = 8;      // per 15 minutes, then that address is refused
const FAIL_WINDOW = 900;

/** Stamp of one password hash; a session carries the stamp of the hash it signed in with. */
function stamp_of(string $hash): string
{
    return substr(hash('sha256', $hash), 0, 16);
}

/**
 * Counts this attempt before the password is checked, in one database transaction, so
 * parallel guesses cannot slip past the limit. Returns seconds to wait when locked, else 0.
 */
function reserve_attempt(): int
{
    $pdo = db();
    $since = time() - FAIL_WINDOW;
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $pdo->prepare('DELETE FROM attempts WHERE ts < ?')->execute([$since]);
        $st = $pdo->prepare('SELECT COUNT(*) AS n, MIN(ts) AS first FROM attempts WHERE ip = ?');
        $st->execute([client_ip()]);
        $row = $st->fetch();
        if ((int) $row['n'] >= MAX_FAILS_PER_IP) {
            $pdo->exec('COMMIT');
            return max(1, (int) $row['first'] + FAIL_WINDOW - time());
        }
        $pdo->prepare('INSERT INTO attempts (ip, ts) VALUES (?, ?)')->execute([client_ip(), time()]);
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
    return 0;
}

/**
 * Checks a login. Returns 0 on success, -1 on wrong details, or the seconds to wait when
 * this address is locked out. Spends the same work whether or not the username exists.
 */
function try_login(string $user, string $pass): int
{
    $wait = reserve_attempt();
    if ($wait > 0) return $wait;
    $cred = credentials();
    $userOk = $cred['username'] !== '' && hash_equals(strtolower($cred['username']), strtolower(trim($user)));
    $passOk = $cred['hash'] !== '' && password_verify($pass, $cred['hash']);
    if ($userOk && $passOk) {
        db()->prepare('DELETE FROM attempts WHERE ip = ?')->execute([client_ip()]);
        session_regenerate_id(true);
        $_SESSION['user'] = $cred['username'];
        $_SESSION['cred'] = stamp_of($cred['hash']);   // the hash that was actually verified
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
        return 0;
    }
    usleep(random_int(200000, 500000));
    return -1;
}

function logout(): void
{
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', ['expires' => time() - 3600, 'path' => $p['path'],
            'secure' => $p['secure'], 'httponly' => true, 'samesite' => 'Strict']);
    }
    session_destroy();
}

function h(string $s): string
{
    return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}
