<?php
/**
 * Repeating tasks. A series holds the pattern; every day it falls on gets an ordinary task (a copy)
 * made from it ahead of time, the first time anything lists that day. A copy is then ticked, moved
 * or changed on its own. A copy the owner deleted is remembered in series_skips and not made again.
 */
declare(strict_types=1);

const REPEAT_RULES = ['daily', 'weekdays', 'weekly', 'monthly'];
const COPY_DAYS_BACK = 60;      // copies are never made for days further back than this

function day_shift(string $day, int $n): string
{
    return gmdate('Y-m-d', strtotime($day . ' 12:00 UTC') + $n * 86400);
}

/** Whether the series has a copy on that day. Monthly: the anchor's day of the month, or the month's last day. */
function series_falls_on(array $s, string $day): bool
{
    if ($day < $s['anchor_day'] || ($s['until_day'] !== null && $day > $s['until_day'])) return false;
    $t = strtotime($day . ' 12:00 UTC');
    $a = strtotime($s['anchor_day'] . ' 12:00 UTC');
    switch ($s['rule']) {
        case 'daily': return true;
        case 'weekdays': return (int) gmdate('N', $t) <= 5;
        case 'weekly': return gmdate('N', $t) === gmdate('N', $a);
        case 'monthly': return (int) gmdate('j', $t) === min((int) gmdate('j', $a), (int) gmdate('t', $t));
    }
    return false;
}

/**
 * Makes the missing copies of every series (of one board, or of all when $board is null) for the
 * days from $from to $to. Safe to call again: a day that has its copy, or had it deleted, is left alone.
 * Returns how many copies were made.
 */
function ensure_occurrences(?int $board, string $from, string $to): int
{
    $pdo = db();
    $from = max($from, day_shift(gmdate('Y-m-d'), -COPY_DAYS_BACK - 1));
    if ($from > $to) return 0;
    $st = $pdo->prepare('SELECT * FROM series WHERE (? IS NULL OR board_id = ?) AND anchor_day <= ?
                         AND (until_day IS NULL OR until_day >= ?)');
    $st->execute([$board, $board, $to, $from]);
    $all = $st->fetchAll();
    if (!$all) return 0;
    $made = 0;
    $have = $pdo->prepare('SELECT series_day FROM tasks WHERE series_id = ? AND series_day BETWEEN ? AND ?');
    $skips = $pdo->prepare('SELECT day FROM series_skips WHERE series_id = ? AND day BETWEEN ? AND ?');
    $taken = $pdo->prepare("SELECT 1 FROM tasks WHERE board_id = ? AND day = ? AND place = 'top' AND slot = ?");
    $add = $pdo->prepare('INSERT OR IGNORE INTO tasks (title, project_id, dur, place, slot, day, start, done, carried, created_at,
                          notes, subs, board_id, series_id, series_day, remind) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)');
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        foreach ($all as $s) {
            $a = max($from, $s['anchor_day']);
            $b = $s['until_day'] !== null ? min($to, $s['until_day']) : $to;
            $have->execute([$s['id'], $a, $b]);
            $skips->execute([$s['id'], $a, $b]);
            $leave = array_flip(array_merge($have->fetchAll(PDO::FETCH_COLUMN), $skips->fetchAll(PDO::FETCH_COLUMN)));
            for ($d = $a; $d <= $b; $d = day_shift($d, 1)) {
                if (isset($leave[$d]) || !series_falls_on($s, $d)) continue;
                $place = $s['place'];
                $slot = $s['slot'] === null ? null : (int) $s['slot'];
                if ($place === 'top') {
                    // the series' place in Today's 3 is taken that day: the copy goes to "Also today"
                    $taken->execute([$s['board_id'], $d, $slot]);
                    if ($taken->fetchColumn()) { $place = 'also'; $slot = null; }
                }
                $add->execute([$s['title'], $s['project_id'], $s['dur'], $place, $slot, $d, $s['start'], gmdate('c'),
                               $s['notes'], $s['subs'], $s['board_id'], $s['id'], $d, $s['remind']]);
                $made += $add->rowCount();
            }
        }
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
    return $made;
}

/** The rule of a series ('' for none). Read once per request; $forget drops what was read after a change. */
function series_rule($id, bool $forget = false): string
{
    static $rules = null;
    if ($forget) { $rules = null; return ''; }
    if ($id === null) return '';
    if ($rules === null) $rules = db()->query('SELECT id, rule FROM series')->fetchAll(PDO::FETCH_KEY_PAIR);
    return (string) ($rules[(int) $id] ?? '');
}

/** A new series made from a task as it is now (its subtasks unticked), starting on $anchor. Returns its id. */
function series_from_task(array $t, string $rule, string $anchor): int
{
    $subs = array_map(fn($s) => ['title' => (string) $s['title'], 'done' => false], json_decode((string) $t['subs'], true) ?: []);
    $pdo = db();
    $pdo->prepare('INSERT INTO series (board_id, rule, anchor_day, title, project_id, dur, start, place, slot, notes, subs, remind, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        ->execute([$t['board_id'], $rule, $anchor, $t['title'], $t['project_id'], $t['dur'], $t['start'],
                   $t['place'] === 'top' ? 'top' : 'also', $t['place'] === 'top' ? $t['slot'] : null, $t['notes'],
                   json_encode($subs, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), remind_out($t['remind']), gmdate('c')]);
    series_rule(null, true);
    return (int) $pdo->lastInsertId();
}

/**
 * Stops a series from $from on: it ends the day before, and its untouched copies from that day on
 * (not done, not the task $keep) go. Past days stay as they were.
 */
function series_end(int $id, string $from, int $keep): void
{
    $pdo = db();
    $pdo->prepare('UPDATE series SET until_day = ? WHERE id = ? AND (until_day IS NULL OR until_day >= ?)')
        ->execute([day_shift($from, -1), $id, $from]);
    $pdo->prepare('DELETE FROM tasks WHERE series_id = ? AND day >= ? AND done = 0 AND id <> ?')->execute([$id, $from, $keep]);
}

/** A new series taking over from an old one: days the old one already has a ticked copy on are not made twice. */
function series_hand_over(int $old, int $new, string $from): void
{
    db()->prepare('INSERT OR IGNORE INTO series_skips (series_id, day) SELECT ?, day FROM tasks
                   WHERE series_id = ? AND day > ? AND done = 1')->execute([$new, $old, $from]);
}
