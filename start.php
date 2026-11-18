<?php
/**
 * Starts the planner on this computer and opens it in your browser.
 *
 *     php start.php                 (or double-click start.bat, or run ./start.sh)
 *     php start.php --port 9000     use another port
 *     php start.php --no-browser    do not open the browser
 *
 * The first run creates public/data/, where your tasks are kept (planner.sqlite).
 * Nothing leaves this computer unless you connect a calendar in Settings.
 */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') exit('Run this from a terminal: php start.php');
if (PHP_VERSION_ID < 80000) {
    fwrite(STDERR, 'Planner needs PHP 8.0 or newer. This is PHP ' . PHP_VERSION . ".\n");
    exit(1);
}

const DEFAULT_PORT = 8737;
umask(0077);   // your tasks, the config and the log are readable by your account only
$root = __DIR__;
$public = $root . DIRECTORY_SEPARATOR . 'public';
$data = $public . DIRECTORY_SEPARATOR . 'data';

$port = DEFAULT_PORT;
$portChosen = false;
$openBrowser = true;
$args = array_slice($argv, 1);
for ($i = 0; $i < count($args); $i++) {
    $a = $args[$i];
    if ($a === '--no-browser') {
        $openBrowser = false;
    } elseif ($a === '--port' && isset($args[$i + 1]) && ctype_digit($args[$i + 1])) {
        $port = (int) $args[++$i];
        $portChosen = true;
    } elseif (preg_match('/^--port=(\d+)$/', $a, $m)) {
        $port = (int) $m[1];
        $portChosen = true;
    } else {
        fwrite(STDERR, "Usage: php start.php [--port 8737] [--no-browser]\n");
        exit($a === '--help' || $a === '-h' ? 0 : 1);
    }
}
if ($port < 1024 || $port > 65535) {
    fwrite(STDERR, "Pick a port between 1024 and 65535.\n");
    exit(1);
}

/**
 * The planner needs three PHP extensions. PHP for Windows ships them switched off, so they
 * are switched on for this run only; nothing on your system is changed.
 */
function extension_flags(): array
{
    $flags = [];
    $missing = [];
    $dirs = array_unique(array_filter([
        (string) ini_get('extension_dir'),
        dirname(PHP_BINARY) . DIRECTORY_SEPARATOR . 'ext',
    ]));
    foreach (['pdo_sqlite', 'curl', 'mbstring'] as $ext) {
        if (extension_loaded($ext)) continue;
        $found = null;
        foreach ($dirs as $dir) {
            foreach (["php_$ext.dll", "$ext.so"] as $file) {
                if (is_file($dir . DIRECTORY_SEPARATOR . $file)) {
                    $found = $dir;
                    break 2;
                }
            }
        }
        if ($found === null) {
            $missing[] = $ext;
            continue;
        }
        if (!in_array('extension_dir=' . $found, $flags, true)) {
            array_push($flags, '-d', 'extension_dir=' . $found);
        }
        array_push($flags, '-d', 'extension=' . $ext);
    }
    if ($missing) {
        fwrite(STDERR, 'PHP is installed, but these parts of it are missing: ' . implode(', ', $missing) . ".\n\n");
        if (PHP_OS_FAMILY === 'Linux') {
            fwrite(STDERR, "On Debian or Ubuntu:  sudo apt install php-sqlite3 php-curl php-mbstring\n"
                . "On Fedora:            sudo dnf install php-pdo php-mbstring\n");
        } elseif (PHP_OS_FAMILY === 'Darwin') {
            fwrite(STDERR, "Install the full PHP with Homebrew:  brew install php\n");
        } else {
            fwrite(STDERR, "Reinstall PHP with:  winget install -e --id PHP.PHP.8.3\n");
        }
        exit(1);
    }
    return $flags;
}

function port_busy(int $port): bool
{
    $s = @fsockopen('127.0.0.1', $port, $errno, $errstr, 0.4);
    if (!$s) return false;
    fclose($s);
    return true;
}

function is_planner(int $port): bool
{
    $ctx = stream_context_create(['http' => ['timeout' => 2, 'ignore_errors' => true]]);
    $page = @file_get_contents("http://127.0.0.1:$port/", false, $ctx);
    return is_string($page) && str_contains($page, '<title>Planner</title>');
}

function open_in_browser(string $url): void
{
    if (PHP_OS_FAMILY === 'Windows') {
        pclose(popen('start "" "' . $url . '"', 'r'));
    } elseif (PHP_OS_FAMILY === 'Darwin') {
        exec('open ' . escapeshellarg($url) . ' > /dev/null 2>&1 &');
    } else {
        exec('command -v xdg-open > /dev/null 2>&1 && xdg-open ' . escapeshellarg($url) . ' > /dev/null 2>&1 &');
    }
}

$flags = extension_flags();

// First run: make the data folder and a local-mode config (no sign-in, this computer only).
if (!is_dir($data) && !mkdir($data, 0700, true)) {
    fwrite(STDERR, "Could not create $data\n");
    exit(1);
}
@chmod($data, 0700);
$config = $data . DIRECTORY_SEPARATOR . 'config.php';
$cfg = is_file($config) ? (array) require $config : null;
$firstRun = $cfg === null;
if ($firstRun || (($cfg['env'] ?? '') === 'local' && strlen((string) ($cfg['local_key'] ?? '')) < 32)) {
    // bridge_key is the secret shared with your calendar script; local_key is what lets
    // your browser, and nothing else on this computer, open the planner.
    $bridgeKey = (string) ($cfg['bridge_key'] ?? '');
    if (!preg_match('/^[A-Za-z0-9_-]{32,}$/', $bridgeKey)) $bridgeKey = bin2hex(random_bytes(32));
    $cfg = ['env' => 'local', 'bridge_key' => $bridgeKey, 'local_key' => bin2hex(random_bytes(32))];
    $body = "<?php\n// Written by start.php for running the planner on this computer. Never share this file.\n"
        . 'return ' . var_export($cfg, true) . ";\n";
    if (file_put_contents($config, $body, LOCK_EX) === false) {
        fwrite(STDERR, "Could not write $config\n");
        exit(1);
    }
    if ($firstRun) echo "First run: created your planner's data folder at $data\n";
}
@chmod($config, 0600);
$isLocal = ($cfg['env'] ?? '') === 'local';

/** The address to open: in local mode it carries the key, which the planner swaps for a cookie. */
$address = function (int $port) use ($cfg, $isLocal): string {
    return "http://127.0.0.1:$port/" . ($isLocal ? '?k=' . $cfg['local_key'] : '');
};

$url = "http://127.0.0.1:$port/";
if (port_busy($port)) {
    if (is_planner($port)) {
        echo "The planner is already running at $url\n";
        if ($openBrowser) open_in_browser($address($port));
        exit(0);
    }
    if ($portChosen) {
        fwrite(STDERR, "Port $port is used by another program. Try: php start.php --port " . ($port + 1) . "\n");
        exit(1);
    }
    for ($try = $port + 1; $try <= $port + 20 && port_busy($try); $try++);
    if ($try > $port + 20) {
        fwrite(STDERR, "No free port found near $port. Try: php start.php --port 9000\n");
        exit(1);
    }
    $port = $try;
    $url = "http://127.0.0.1:$port/";
}

$log = $data . DIRECTORY_SEPARATOR . 'server.log';
file_put_contents($log, '');
$cmd = array_merge([PHP_BINARY], $flags, ['-d', 'display_errors=0', '-d', 'log_errors=1', '-S', "127.0.0.1:$port", '-t', $public,
    $root . DIRECTORY_SEPARATOR . 'tools' . DIRECTORY_SEPARATOR . 'router.php']);
// Several workers keep the board responsive while a calendar is being read (not available on Windows).
$env = getenv() + (PHP_OS_FAMILY === 'Windows' ? [] : ['PHP_CLI_SERVER_WORKERS' => '4']);
$proc = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['file', $log, 'a'], 2 => ['file', $log, 'a']], $pipes, $root, $env);
if (!is_resource($proc)) {
    fwrite(STDERR, "Could not start PHP's web server.\n");
    exit(1);
}

$up = false;
for ($i = 0; $i < 50; $i++) {
    usleep(100000);
    if (!proc_get_status($proc)['running']) break;     // it died, e.g. another program took the port
    if (port_busy($port)) {
        usleep(150000);
        $up = proc_get_status($proc)['running'];
        break;
    }
}
if (!$up) {
    fwrite(STDERR, "The planner did not start. Details:\n" . @file_get_contents($log) . "\n");
    proc_terminate($proc);
    exit(1);
}

echo "\n  Planner is running:  $url\n\n"
    . "  Keep this window open while you use it. Press Ctrl+C here to stop.\n"
    . "  To open the planner again later, run this start file again.\n"
    . "  Your tasks are saved in: $data\n\n";
if ($openBrowser) open_in_browser($address($port));
else if ($isLocal) echo "  Open it with this address (it carries your key, so don't share it):\n  " . $address($port) . "\n\n";

if (function_exists('pcntl_signal')) {
    pcntl_async_signals(true);
    $stop = function () use ($proc) {
        proc_terminate($proc);
        exit(0);
    };
    pcntl_signal(SIGINT, $stop);
    pcntl_signal(SIGTERM, $stop);
}
while (proc_get_status($proc)['running']) usleep(300000);
exit(0);
