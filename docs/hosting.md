# Host the planner online

Running the planner on your own computer keeps its data on that computer. If you work on several machines,
put it on a web host instead: one copy, behind a username and password, that you open from anywhere.

This guide is for people comfortable with uploading files to a web host.

## What the host needs

- **PHP 8.0 or newer** with the `pdo_sqlite`, `curl` and `mbstring` extensions (standard on shared hosting).
- **HTTPS.** The sign-in cookie is only sent over HTTPS, so the planner cannot be used over plain HTTP.
- **Apache or LiteSpeed**, so the `.htaccess` files are honored. They keep `data/` and `lib/` from being
  served. For nginx, see [the rules below](#nginx).
- A domain or subdomain whose web root you control, for example `planner.example.com`.

No database server is needed: the planner keeps everything in one SQLite file.

## Steps

### 1. Make the config file

On your computer, in this repository's folder:

```sh
php tools/make-config.php --username alex
```

This writes `config.php` in the current folder and prints a generated password **once**. Save it in your
password manager. The file holds the password's hash (not the password) and the secret key for the calendar
connection.

### 2. Upload

1. Upload **the contents of `public/`** into the web root of your domain: `index.php`, `api.php`, `.htaccess`,
   `assets/`, `lib/` and `data/`. Make sure the hidden `.htaccess` files are uploaded too (there are three).
2. Do **not** upload your local `public/data/config.php` or `public/data/planner.sqlite`. Of the `data/` folder,
   only `.htaccess` goes up.
3. Upload the `config.php` from step 1 into the **`data/`** folder on the host.
4. Check that PHP can write to `data/` (it creates the database and session files there).
5. Delete the local `config.php` from step 1, or keep it somewhere safe. It is git-ignored.

### 3. Check

- Open `https://your-domain/`: you should see the sign-in page. Sign in.
- Open `https://your-domain/data/config.php` and `https://your-domain/lib/boot.php`: both must answer
  **403 Forbidden**. If either shows anything else, your host is not applying `.htaccess`; do not use the
  planner there until it does.

Then connect your calendar from Settings: [google-calendar.md](google-calendar.md).

### Bring your local tasks along (optional)

Stop the local planner, then upload your local `public/data/planner.sqlite` into `data/` on the host before
you sign in for the first time.

## Updating

Upload the new contents of `public/` over the old ones, leaving `data/` alone. The database upgrades itself
when needed.

## Changing or resetting the password

- **Change:** Settings › Password. Every other device is signed out.
- **Forgot it:** run `php tools/make-config.php --username alex --force` and upload the new `config.php`
  over the old one. This also makes a new calendar key, so reconnect the calendar afterwards (copy the script
  again from Settings and deploy it as a new version).

## What protects it

- One username and password; the password is stored as a bcrypt hash.
- Eight wrong attempts lock that address out for 15 minutes.
- The session cookie is `Secure`, `HttpOnly` and `SameSite=Strict`; every change carries a CSRF token.
- A strict Content-Security-Policy: no inline scripts, nothing loaded from other sites.
- `data/` and `lib/` are never served.

It is built for **one person**. There are no user accounts beyond the single login.

## Hostinger, in one command

If your host is Hostinger, `tools/deploy.py` does all of the above through their API, including creating the
subdomain and its SSL certificate. Create `deploy.local.json` beside the README (it is git-ignored):

```json
{
  "hostinger_username": "u123456789",
  "domain": "planner.example.com",
  "login_name": "alex"
}
```

Set `HOSTINGER_API_TOKEN` in your environment (hPanel › Account › API), then:

```sh
python tools/deploy.py                    # first run: creates the site and the login
python tools/deploy.py --reset-password   # new password
```

The login is written to `~/.planner/credentials.txt` on the machine that ran it. Later runs upload the app
and never touch the data on the server.

## nginx

nginx ignores `.htaccess`. Add the same rules to the server block, above your PHP location:

```nginx
location ~ ^/(data|lib)(/|$) { return 403; }
location ~ /\.               { return 403; }
location ~ \.(sqlite|sqlite-wal|sqlite-shm|db|gs|md|py|log)$ { return 403; }
```

## A note on local mode

The copy that `start.php` runs on your own computer has no username or password. In their place it only
runs under PHP's built-in server, refuses every request that does not come from that same computer, and
requires a key that `start.php` hands to your browser. Do not put it behind a reverse proxy or a tunnel to
reach it from elsewhere: it is not built for that. A local-mode `data/config.php` uploaded to a web host
answers 403 to everyone. Use `tools/make-config.php` for a hosted copy.
