<?php
/**
 * Makes the config file for running the planner on a web host, behind a sign-in.
 *
 *     php tools/make-config.php --username alex
 *     php tools/make-config.php --username alex --out somewhere/config.php
 *
 * It writes config.php (username, password hash, calendar key) and prints the password once.
 * Upload that file into the data/ folder on your host. See docs/hosting.md.
 */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') exit('Run this from a terminal.');

$username = '';
$out = getcwd() . DIRECTORY_SEPARATOR . 'config.php';
$force = false;
$args = array_slice($argv, 1);
for ($i = 0; $i < count($args); $i++) {
    if ($args[$i] === '--username' && isset($args[$i + 1])) $username = trim($args[++$i]);
    elseif ($args[$i] === '--out' && isset($args[$i + 1])) $out = $args[++$i];
    elseif ($args[$i] === '--force') $force = true;
    else {
        fwrite(STDERR, "Usage: php tools/make-config.php --username NAME [--out config.php] [--force]\n");
        exit(1);
    }
}
if ($username === '') {
    fwrite(STDOUT, 'Username to sign in with: ');
    $username = trim((string) fgets(STDIN));
}
if (!preg_match('/^[A-Za-z0-9._@-]{1,60}$/', $username)) {
    fwrite(STDERR, "Use 1 to 60 letters, digits, dots, dashes or underscores for the username.\n");
    exit(1);
}
if (is_file($out) && !$force) {
    fwrite(STDERR, "$out already exists. Add --force to replace it (this makes a new password and a new\n"
        . "calendar key, so a connected calendar would need its script pasted again).\n");
    exit(1);
}

// Four groups of six letters and digits: about 143 bits, and easy to type.
$alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
$groups = [];
for ($g = 0; $g < 4; $g++) {
    $part = '';
    for ($c = 0; $c < 6; $c++) $part .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    $groups[] = $part;
}
$password = implode('-', $groups);

$config = "<?php\n// Made by tools/make-config.php. Never commit, never share.\nreturn [\n"
    . "    'env' => 'prod',\n"
    . '    \'username\' => ' . var_export($username, true) . ",\n"
    . '    \'password_hash\' => ' . var_export(password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]), true) . ",\n"
    . "    'cred_version' => " . time() . ",\n"
    . '    \'bridge_key\' => ' . var_export(bin2hex(random_bytes(32)), true) . ",\n];\n";
if (file_put_contents($out, $config, LOCK_EX) === false) {
    fwrite(STDERR, "Could not write $out\n");
    exit(1);
}
@chmod($out, 0600);

echo "\nWrote $out\n\n"
    . "  Username: $username\n"
    . "  Password: $password\n\n"
    . "This password is shown only now: save it in your password manager.\n"
    . "You can change it later in the planner under Settings > Password.\n\n"
    . "Next: upload the contents of public/ to your host, then put this config.php\n"
    . "into the data/ folder there. Full steps: docs/hosting.md\n";
