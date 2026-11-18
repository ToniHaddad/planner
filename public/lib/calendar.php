<?php
/**
 * Talks to the calendar bridge (an Apps Script web app in the owner's Google account).
 * The bridge URL is stored in settings; the shared key lives in data/config.php.
 */
declare(strict_types=1);

const CAL_CACHE_SECONDS = 600;
const BRIDGE_URL_RE = '~^https://script\.google\.com/macros/s/[A-Za-z0-9_-]{20,}/exec$~';

function bridge_url_valid(string $url): bool
{
    if (preg_match(BRIDGE_URL_RE, $url)) return true;
    // Tests point the bridge at a local fake; never enabled in production.
    return !is_prod() && cfg('allow_test_bridge') === true && str_starts_with($url, 'http://127.0.0.1:');
}

/** Calls the bridge. Returns the decoded reply or throws with a readable message. */
function bridge_call(string $url, array $query, ?array $post = null): array
{
    if (!bridge_url_valid($url)) throw new RuntimeException('The calendar link is not a valid Apps Script address.');
    $key = (string) cfg('bridge_key');
    $ch = curl_init();
    $opts = [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 5,
        CURLOPT_CONNECTTIMEOUT => 10, CURLOPT_TIMEOUT => 40, CURLOPT_USERAGENT => 'planner/1.0',
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
        throw new RuntimeException($code === 200
            ? 'Google answered with a page instead of data. Check the web app is deployed with access "Anyone".'
            : 'Google answered with status ' . $code . '.');
    }
    if (isset($data['error'])) {
        throw new RuntimeException($data['error'] === 'forbidden'
            ? 'The bridge refused the key. Paste the script again from Settings and redeploy.'
            : 'Calendar bridge: ' . $data['error']);
    }
    return $data;
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
        return ['connected' => true, 'fetchedAt' => (int) $hit['fetched_at']] + json_decode($hit['json'], true);
    }
    try {
        $data = bridge_call($url, ['action' => 'events', 'date' => $day]);
        $clean = ['events' => [], 'allDay' => [], 'tz' => (string) ($data['tz'] ?? '')];
        foreach (($data['events'] ?? []) as $e) {
            $clean['events'][] = [
                'title' => mb_substr((string) ($e['title'] ?? ''), 0, 200),
                'start' => max(0, min(1440, (int) ($e['start'] ?? 0))),
                'end' => max(0, min(1440, (int) ($e['end'] ?? 0))),
                'calendar' => mb_substr((string) ($e['calendar'] ?? ''), 0, 100),
            ];
        }
        foreach (($data['allDay'] ?? []) as $e) {
            $clean['allDay'][] = ['title' => mb_substr((string) ($e['title'] ?? ''), 0, 200),
                'calendar' => mb_substr((string) ($e['calendar'] ?? ''), 0, 100)];
        }
        $pdo->prepare('INSERT INTO cal_cache (day, json, fetched_at) VALUES (?, ?, ?)
                       ON CONFLICT(day) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at')
            ->execute([$day, json_encode($clean), time()]);
        $pdo->prepare('DELETE FROM cal_cache WHERE fetched_at < ?')->execute([time() - 14 * 86400]);
        return ['connected' => true, 'fetchedAt' => time()] + $clean;
    } catch (Throwable $e) {
        // Show the last good copy (if any) with the error, so the day never goes blank.
        $old = $hit ? json_decode($hit['json'], true) : ['events' => [], 'allDay' => []];
        return ['connected' => true, 'error' => $e->getMessage(),
                'fetchedAt' => $hit ? (int) $hit['fetched_at'] : null] + $old;
    }
}
