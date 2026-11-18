<?php
/**
 * Router for PHP's built-in web server, used by start.php in local mode.
 *
 * The built-in server ignores .htaccess, so this file decides what may be served. It works
 * from a short list of what IS allowed (the two pages and the files in assets/), because a
 * list of what is forbidden can be dodged with odd spellings of a path. Everything else,
 * including all of data/ and lib/, answers 403.
 */
$addr = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
$host = (string) preg_replace('/:\d{1,5}$/', '', strtolower((string) ($_SERVER['HTTP_HOST'] ?? '')));
$path = rawurldecode((string) strtok((string) ($_SERVER['REQUEST_URI'] ?? '/'), '?'));

$local = in_array($addr, ['127.0.0.1', '::1'], true) && in_array($host, ['127.0.0.1', 'localhost', '[::1]'], true);
$allowed = (bool) preg_match('~^/(index\.php|api\.php|assets/[a-z0-9_-]+\.(js|css|svg))?$~', $path);

if (!$local || !$allowed) {
    http_response_code(403);
    header('Content-Type: text/plain; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    echo 'Forbidden';
    return true;
}
return false;   // let the built-in server run the page or send the file
