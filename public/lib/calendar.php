<?php
/**
 * Talks to the calendar bridge (an Apps Script web app in the owner's Google account).
 * The bridge URL is stored in settings; the shared key lives in data/config.php.
 */
declare(strict_types=1);

const CAL_CACHE_SECONDS = 600;
const SYNC_TIMEOUT = 330;       // a sync may take the script up to about 4.5 minutes; it stops itself before 6
const BRIDGE_URL_RE = '~^https://script\.google\.com/macros/s/[A-Za-z0-9_-]{20,}/exec$~';

function bridge_url_valid(string $url): bool
{
    if (preg_match(BRIDGE_URL_RE, $url)) return true;
    // Tests point the bridge at a local fake; never enabled in production.
    return !is_prod() && cfg('allow_test_bridge') === true && str_starts_with($url, 'http://127.0.0.1:');
}

/** Calls the bridge. Returns the decoded reply or throws with a readable message. $timeout is in seconds. */
function bridge_call(string $url, array $query, ?array $post = null, int $timeout = 40): array
{
    if (!bridge_url_valid($url)) throw new RuntimeException('The calendar link is not a valid Apps Script address.');
    $key = (string) cfg('bridge_key');
    $ch = curl_init();
    $opts = [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 5,
        CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_TIMEOUT => $timeout, CURLOPT_USERAGENT => 'planner/1.0',
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | (!is_prod() && cfg('allow_test_bridge') === true ? CURLPROTO_HTTP : 0),
    ];
    // PHP on Windows ships without a certificate list; use the one Windows keeps.
    if (PHP_OS_FAMILY === 'Windows' && !ini_get('curl.cainfo') && !ini_get('openssl.cafile')
        && defined('CURLSSLOPT_NATIVE_CA')) {
        $opts[CURLOPT_SSL_OPTIONS] = CURLSSLOPT_NATIVE_CA;
    }
    if ($post === null) {
        $opts[CURLOPT_URL] = $url . '?' . http_build_query($query + ['key' => $key]);
    } else {
        $opts[CURLOPT_URL] = $url;
        $opts[CURLOPT_POST] = true;
        $opts[CURLOPT_POSTFIELDS] = json_encode($post + ['key' => $key]);
        $opts[CURLOPT_HTTPHEADER] = ['Content-Type: application/json'];
    }
    curl_setopt_array($ch, $opts);
    $body = curl_exec($ch);
    $err = curl_error($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($body === false) throw new RuntimeException('Could not reach Google: ' . $err);
    $data = json_decode((string) $body, true);
    if (!is_array($data)) {
        throw new RuntimeException($code >= 200 && $code < 300
            ? 'Google answered with a page instead of data: “Who has access” may not be “Anyone”, or the script ran into an '
              . 'error. Either way, paste the current script from Settings and deploy a new version.'
            : 'Google answered with status ' . $code . '.');
    }
    if (isset($data['error'])) {
        throw new RuntimeException($data['error'] === 'forbidden'
            ? 'The bridge refused the key. Paste the script again from Settings and redeploy.'
            : 'Calendar bridge: ' . (is_string($data['error']) ? $data['error'] : 'error'));
    }
    // only a plain "ok" counts: anything else is never cached or remembered as a good run
    if ($code < 200 || $code >= 300) throw new RuntimeException('Google answered with status ' . $code . '.');
    if (($data['ok'] ?? null) !== true) {
        throw new RuntimeException('The calendar script answered in a way the planner does not understand. '
            . 'Paste the current script from Settings and deploy a new version.');
    }
    return $data;
}

/** A reminder as the planner offers it. "At the time" (0) is gone: Google wants at least 5 minutes. */
function remind_out($v): ?int
{
    return $v === null ? null : max(5, (int) $v);
}

/** One day of the bridge's answer, trimmed to what the board shows: {events, allDay}. */
function clean_cal_day($data): array
{
    $clean = ['events' => [], 'allDay' => []];
    if (!is_array($data)) return $clean;
    foreach ((is_array($data['events'] ?? null) ? $data['events'] : []) as $e) {
        if (!is_array($e)) continue;
        $clean['events'][] = [
            'title' => mb_substr((string) ($e['title'] ?? ''), 0, 200),
            'start' => max(0, min(1440, (int) ($e['start'] ?? 0))),
            'end' => max(0, min(1440, (int) ($e['end'] ?? 0))),
            'calendar' => mb_substr((string) ($e['calendar'] ?? ''), 0, 100),
        ] + cal_id_color($e);
    }
    foreach ((is_array($data['allDay'] ?? null) ? $data['allDay'] : []) as $e) {
        if (!is_array($e)) continue;
        $clean['allDay'][] = ['title' => mb_substr((string) ($e['title'] ?? ''), 0, 200),
            'calendar' => mb_substr((string) ($e['calendar'] ?? ''), 0, 100)] + cal_id_color($e);
    }
    return $clean;
}

/** The event's id in Google (older scripts send none) and its calendar's color, when they look right. */
function cal_id_color(array $e): array
{
    $id = is_string($e['id'] ?? null) ? mb_substr($e['id'], 0, 300) : '';
    $color = is_string($e['color'] ?? null) && preg_match('/^#[0-9a-fA-F]{6}$/', $e['color']) ? strtolower($e['color']) : '';
    return ['id' => $id, 'color' => $color];
}

/**
 * The key of one Google event on one day, for the notes, subtasks and "hidden" the planner keeps
 * for it. With an id from Google it survives a change of title or time; scripts pasted before ids
 * were sent fall back to what the event looks like.
 */
function cal_key(string $day, array $e, bool $allDay): string
{
    // Every occurrence of a repeating Google event has the same id, and so may the same event on two
    // calendars: the start and the calendar tell them apart.
    if (($e['id'] ?? '') !== '') {
        return sha1(implode('|', [$day, $e['id'], $allDay ? '' : (string) ($e['start'] ?? ''), $e['calendar'] ?? '']));
    }
    return sha1(implode('|', [$day, $e['title'] ?? '', $allDay ? '' : (string) ($e['start'] ?? ''),
                              $allDay ? '' : (string) ($e['end'] ?? ''), $e['calendar'] ?? '']));
}

/** Adds key, notes, subs and hidden to every event of $days ({day: {events, allDay}}). Read fresh, never cached. */
function with_extras(array $days): array
{
    if (!$days) return $days;
    $st = db()->prepare('SELECT * FROM cal_extras WHERE day BETWEEN ? AND ?');
    $st->execute([min(array_keys($days)), max(array_keys($days))]);
    $x = [];
    foreach ($st->fetchAll() as $r) $x[$r['key']] = $r;
    foreach ($days as $day => $d) {
        foreach (['events', 'allDay'] as $kind) {
            foreach (($d[$kind] ?? []) as $i => $e) {
                $k = cal_key((string) $day, $e, $kind === 'allDay');
                $r = $x[$k] ?? null;
                $days[$day][$kind][$i] = $e + ['key' => $k, 'notes' => $r ? (string) $r['notes'] : '',
                    'subs' => $r ? (json_decode((string) $r['subs'], true) ?: []) : [], 'hidden' => $r ? (bool) $r['hidden'] : false];
            }
        }
    }
    return $days;
}

/**
 * Events for every day from $from to $to, in one call to the bridge (the Calendar page):
 * {connected, days: {"YYYY-MM-DD": {events, allDay}}, fetchedAt, needsUpdate?, error?}.
 * Cached for ten minutes. Google trouble never fails the caller: it comes back as a field.
 */
function calendar_range(string $from, string $to, bool $refresh = false): array
{
    $url = setting('bridge_url');
    if (!$url) return ['connected' => false];
    $pdo = db();
    $k = $from . '/' . $to;
    $st = $pdo->prepare('SELECT json, fetched_at FROM cal_range_cache WHERE k = ?');
    $st->execute([$k]);
    $hit = $st->fetch();
    if ($hit && !$refresh && time() - (int) $hit['fetched_at'] < CAL_CACHE_SECONDS) {
        return ['connected' => true, 'fetchedAt' => (int) $hit['fetched_at'], 'days' => (object) with_extras(json_decode($hit['json'], true))];
    }
    try {
        $data = bridge_call($url, ['action' => 'range', 'from' => $from, 'to' => $to]);
        $days = [];
        foreach ((is_array($data['days'] ?? null) ? $data['days'] : []) as $day => $d) {
            $day = (string) $day;
            if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $day) && $day >= $from && $day <= $to) $days[$day] = clean_cal_day($d);
        }
        $pdo->prepare('INSERT INTO cal_range_cache (k, json, fetched_at) VALUES (?, ?, ?)
                       ON CONFLICT(k) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at')
            ->execute([$k, json_encode((object) $days), time()]);
        $pdo->prepare('DELETE FROM cal_range_cache WHERE fetched_at < ?')->execute([time() - 14 * 86400]);
        return ['connected' => true, 'fetchedAt' => time(), 'days' => (object) with_extras($days)];
    } catch (Throwable $e) {
        // A script pasted before ranges existed does not know the action: the owner has to paste it again.
        if ($e->getMessage() === 'Calendar bridge: unknown action') {
            return ['connected' => true, 'needsUpdate' => true, 'days' => (object) []];
        }
        // Show the last good copy (if any) with the error, as calendar_day does.
        return ['connected' => true, 'error' => $e->getMessage(), 'fetchedAt' => $hit ? (int) $hit['fetched_at'] : null,
                'days' => (object) ($hit ? with_extras(json_decode($hit['json'], true)) : [])];
    }
}

/** Events for one day: {connected, events, allDay, fetchedAt, error?}. Cached for ten minutes. */
function calendar_day(string $day, bool $refresh): array
{
    $url = setting('bridge_url');
    if (!$url) return ['connected' => false, 'events' => [], 'allDay' => []];
    $pdo = db();
    $st = $pdo->prepare('SELECT json, fetched_at FROM cal_cache WHERE day = ?');
    $st->execute([$day]);
    $hit = $st->fetch();
    if ($hit && !$refresh && time() - (int) $hit['fetched_at'] < CAL_CACHE_SECONDS) {
        return ['connected' => true, 'fetchedAt' => (int) $hit['fetched_at']] + day_extras($day, json_decode($hit['json'], true));
    }
    try {
        $data = bridge_call($url, ['action' => 'events', 'date' => $day]);
        $clean = clean_cal_day($data) + ['tz' => (string) ($data['tz'] ?? '')];
        $pdo->prepare('INSERT INTO cal_cache (day, json, fetched_at) VALUES (?, ?, ?)
                       ON CONFLICT(day) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at')
            ->execute([$day, json_encode($clean), time()]);
        $pdo->prepare('DELETE FROM cal_cache WHERE fetched_at < ?')->execute([time() - 14 * 86400]);
        return ['connected' => true, 'fetchedAt' => time()] + day_extras($day, $clean);
    } catch (Throwable $e) {
        // Show the last good copy (if any) with the error, so the day never goes blank.
        $old = $hit ? json_decode($hit['json'], true) : ['events' => [], 'allDay' => []];
        return ['connected' => true, 'error' => $e->getMessage(),
                'fetchedAt' => $hit ? (int) $hit['fetched_at'] : null] + day_extras($day, $old);
    }
}

function day_extras(string $day, array $d): array
{
    return with_extras([$day => $d])[$day];
}


// ---------- sending the plan to Google: one calendar per board ----------
const SYNC_DAYS_BACK = 1, SYNC_DAYS_AHEAD = 45;

/** Notes and open checklist items, as the text of an event in Google. */
function sync_text(array $lines, string $notes, array $subs, string $head): string
{
    $open = array_values(array_filter($subs, fn($s) => empty($s['done'])));
    if ($notes !== '') $lines[] = $notes;
    if ($open) $lines[] = $head . "\n" . implode("\n", array_map(fn($s) => '- ' . $s['title'], $open));
    return mb_substr(implode("\n\n", $lines), 0, 4000);
}

/** What one board puts in Google for the days from $from to $to: its timed tasks and its events. */
function sync_items(int $board, string $from, string $to): array
{
    $pdo = db();
    $items = [];
    $st = $pdo->prepare('SELECT t.*, p.color FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
                         WHERE t.board_id = ? AND t.day BETWEEN ? AND ? AND t.start IS NOT NULL ORDER BY t.day, t.start, t.id');
    $st->execute([$board, $from, $to]);
    foreach ($st->fetchAll() as $t) {
        // a ticked task stays in Google, marked, so the day keeps its record
        $items[] = ['key' => 'task:' . $t['id'], 'title' => ($t['done'] ? '✓ ' : '') . $t['title'],
                    'description' => sync_text([], (string) $t['notes'], json_decode((string) $t['subs'], true) ?: [], 'Subtasks:'),
                    'allDay' => false, 'date' => $t['day'], 'start' => (int) $t['start'], 'dur' => (int) $t['dur'],
                    'color' => $t['color'], 'remind' => remind_out($t['remind'])];
    }
    $colors = $pdo->query('SELECT id, color FROM projects')->fetchAll(PDO::FETCH_KEY_PAIR);
    foreach (events_in($board, $from, $to) as $e) {
        $item = ['key' => 'event:' . $e['id'], 'title' => $e['title'],
                 'description' => sync_text($e['location'] !== '' ? ['Where: ' . $e['location']] : [], $e['notes'], $e['subs'], 'To arrange:'),
                 'allDay' => $e['start'] === null, 'color' => $e['p'] !== null ? ($colors[$e['p']] ?? null) : null,
                 'remind' => remind_out($e['remind'])];
        $item += $e['start'] === null ? ['from' => $e['from'], 'to' => $e['to']]
                                      : ['date' => $e['from'], 'start' => $e['start'], 'dur' => $e['end'] - $e['start']];
        $items[] = $item;
    }
    return $items;
}

/** The whole window, every board, in one call. Returns the counts, or ['needsUpdate' => true] for an older script. */
function calendar_sync(string $today): array
{
    $url = setting('bridge_url');
    if (!$url) throw new RuntimeException('Connect your calendar first (Settings)');
    $from = day_shift($today, -SYNC_DAYS_BACK);
    $to = day_shift($today, SYNC_DAYS_AHEAD);
    $boards = [];
    foreach (db()->query('SELECT id, name FROM boards ORDER BY sort, id')->fetchAll() as $b) {
        ensure_occurrences((int) $b['id'], $from, $to);
        $boards[] = ['id' => (int) $b['id'], 'name' => $b['name'], 'items' => sync_items((int) $b['id'], $from, $to)];
    }
    @set_time_limit(SYNC_TIMEOUT + 30);
    try {
        $r = bridge_call($url, [], ['action' => 'sync', 'from' => $from, 'to' => $to, 'boards' => $boards], SYNC_TIMEOUT);
    } catch (RuntimeException $e) {
        // another update is running in the script: this one waits for the next turn, nothing is wrong
        if ($e->getMessage() === 'Calendar bridge: busy') return ['busy' => true];
        if ($e->getMessage() !== 'Calendar bridge: unknown action') throw $e;
        set_setting('sync_old', '1');               // the script was pasted before sync existed
        return ['needsUpdate' => true];
    }
    $last = ['at' => time(), 'created' => (int) ($r['created'] ?? 0), 'updated' => (int) ($r['updated'] ?? 0),
             'removed' => (int) ($r['removed'] ?? 0), 'partial' => !empty($r['partial'])];
    set_setting('last_sync', json_encode($last));
    set_setting('sync_old', null);
    return $last + ['calendars' => array_values(array_map(fn($c) => ['id' => (string) ($c['id'] ?? ''), 'name' => (string) ($c['name'] ?? '')],
                                                         array_filter(is_array($r['calendars'] ?? null) ? $r['calendars'] : [], 'is_array')))];
}

/** What the browser needs to know about syncing: on or off, when it last ran, and whether the script is too old. */
function sync_state(): array
{
    $last = json_decode((string) setting('last_sync', ''), true);
    $delay = (int) cfg('sync_delay_ms', 8000);
    return ['auto' => setting('auto_sync', '1') === '1', 'last' => is_array($last) ? $last : null,
            'needsUpdate' => setting('sync_old') === '1', 'delay' => max(100, min(600000, $delay))];
}

/** What was kept for Google events of days long gone is forgotten (called by the daily rollover). */
function cal_extras_purge(): void
{
    db()->prepare('DELETE FROM cal_extras WHERE day < ?')->execute([day_shift(gmdate('Y-m-d'), -60)]);
}
