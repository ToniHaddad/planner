"""End-to-end checks against a local copy: login, lockout, CSRF, tasks, rollover, calendar.

    python tests/test_api.py

Starts PHP's built-in server on a throwaway copy of public/ plus a fake calendar bridge,
so nothing here touches real data or Google.
"""
import http.cookiejar
import http.server
import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT, BRIDGE_PORT, LOCAL_PORT = 8791, 8792, 8793
BASE = f"http://127.0.0.1:{PORT}"
passed = failed = 0
pushed = []


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"ok   {name}")
    else:
        failed += 1
        print(f"FAIL {name} {detail}")


class Bridge(http.server.BaseHTTPRequestHandler):
    key = None

    def log_message(self, *a):
        pass

    def send(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(self.path).query))
        if q.get("key") != Bridge.key:
            return self.send({"error": "forbidden"})
        if q.get("action") == "ping":
            return self.send({"ok": True, "tz": "Europe/Paris", "calendars": ["Main", "Outlook"]})
        self.send({"ok": True, "tz": "Europe/Paris", "events": [
            {"title": "Team <b>call</b>", "start": 600, "end": 660, "calendar": "Main", "color": "#fff"}],
            "allDay": [{"title": "Holiday", "calendar": "Main"}]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if body.get("key") != Bridge.key:
            return self.send({"error": "forbidden"})
        pushed.append(body)
        self.send({"ok": True, "created": len(body["blocks"]), "removed": 0})


class Client:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf = ""

    base = BASE

    def raw(self, path, data=None, headers=None):
        req = urllib.request.Request(self.base + path, data=data, headers=headers or {})
        try:
            with self.opener.open(req, timeout=30) as r:
                return r.status, r.read().decode(), r.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode(), e.headers

    def login(self, user, password):
        _, html, _ = self.raw("/")
        token = re.search(r'name="csrf" value="([0-9a-f]+)"', html).group(1)
        body = urllib.parse.urlencode({"csrf": token, "username": user, "password": password}).encode()
        _, html, _ = self.raw("/", body)
        m = re.search(r'<meta name="csrf" content="([0-9a-f]+)"', html)
        self.csrf = m.group(1) if m else ""
        return bool(m), html

    def api(self, action, body=None, csrf=True, **params):
        qs = urllib.parse.urlencode({"action": action, **params})
        headers = {"X-CSRF": self.csrf} if csrf else {}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        status, text, _ = self.raw("/api.php?" + qs, data, headers)
        try:
            return status, json.loads(text)
        except ValueError:
            return status, {"raw": text}


def main():
    work = Path(tempfile.mkdtemp(prefix="planner-test-"))
    site = work / "public"
    shutil.copytree(ROOT / "public", site, ignore=shutil.ignore_patterns("planner.sqlite*", "sessions", "config.php"))
    key = "k" * 64
    Bridge.key = key
    hashed = subprocess.run(["php", "-r", 'echo password_hash("correct horse battery", PASSWORD_BCRYPT);'],
                            capture_output=True, check=True).stdout.decode()
    (site / "data" / "config.php").write_text(
        "<?php return ['env'=>'dev','username'=>'alex','password_hash'=>'" + hashed +
        "','cred_version'=>1,'bridge_key'=>'" + key + "','allow_test_bridge'=>true];", encoding="utf-8")
    bridge = http.server.ThreadingHTTPServer(("127.0.0.1", BRIDGE_PORT), Bridge)
    threading.Thread(target=bridge.serve_forever, daemon=True).start()
    php = subprocess.Popen(["php", "-S", f"127.0.0.1:{PORT}", "-t", str(site)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(BASE + "/", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        run(site)
        run_local(work)
    finally:
        php.terminate()
        bridge.shutdown()
        shutil.rmtree(work, ignore_errors=True)
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


def run(site):
    today = date.today().isoformat()
    yesterday = (date.today() - timedelta(days=1)).isoformat()

    # --- access control ---
    anon = Client()
    status, html, headers = anon.raw("/")
    check("login page shown when signed out", status == 200 and 'name="password"' in html and "app.js" not in html)
    check("security headers present", "frame-ancestors 'none'" in headers.get("Content-Security-Policy", "")
          and headers.get("X-Frame-Options") == "DENY")
    status, body = anon.api("state", day=today)
    check("API refuses signed-out calls", status == 401)
    ok, html = anon.login("alex", "wrong password")
    check("wrong password refused", not ok and "Wrong username or password" in html)
    ok, html = anon.login("nobody", "correct horse battery")
    check("wrong username refused with the same message", not ok and "Wrong username or password" in html)

    c = Client()
    ok, _ = c.login("Alex", "correct horse battery")
    check("correct login works (username not case-sensitive)", ok)
    cookie = next((k for k in c.jar if k.name == "planner"), None)
    check("session cookie is HttpOnly + SameSite=Strict", cookie is not None
          and cookie.has_nonstandard_attr("HttpOnly") and cookie.get_nonstandard_attr("SameSite") == "Strict")
    status, body = c.api("task_add", {"title": "x"}, csrf=False)
    check("change without CSRF token refused", status == 403)
    status, body = c.api("task_add", None, day=today)
    check("GET on a change action refused", status == 405)

    # --- tasks ---
    status, st = c.api("state", day=today)
    check("state loads with seed projects", status == 200 and len(st["projects"]) == 4 and st["tasks"] == [])
    pid = st["projects"][0]["id"]
    status, r = c.api("task_add", {"title": "  Write   report <script>  ", "p": pid})
    t = r.get("task", {})
    check("task added to the brain dump, title tidied", status == 200 and t.get("where") == "dump"
          and t.get("title") == "Write report <script>" and t.get("p") == pid)
    status, r = c.api("task_add", {"title": "   "})
    check("empty title refused", status == 400)
    status, r = c.api("task_update", {"id": t["id"], "patch": {"where": "top", "slot": 0, "day": today, "start": 480, "dur": 90}})
    check("task planned as main task 1 at 08:00", status == 200 and r["task"]["where"] == "top"
          and r["task"]["slot"] == 0 and r["task"]["start"] == 480 and r["task"]["dur"] == 90)
    status, r = c.api("task_update", {"id": t["id"], "patch": {"where": "also"}})
    check("leaving the top 3 clears the slot", status == 200 and r["task"]["slot"] is None and r["task"]["start"] == 480)
    for bad in ({"where": "nowhere"}, {"dur": 0}, {"start": 5000}, {"day": "2026-02-31"}, {"slot": 7}, {"where": "top"}):
        status, r = c.api("task_update", {"id": t["id"], "patch": bad})
        check(f"bad change refused: {bad}", status == 400, str(r))
    status, r = c.api("task_update", {"id": t["id"], "patch": {"where": "dump"}})
    check("back to the dump clears day and time", r["task"]["day"] is None and r["task"]["start"] is None)

    # --- rollover ---
    _, r2 = c.api("task_add", {"title": "Old unfinished"})
    _, r3 = c.api("task_add", {"title": "Old finished"})
    c.api("task_update", {"id": r2["task"]["id"], "patch": {"where": "also", "day": yesterday, "start": 600}})
    c.api("task_update", {"id": r3["task"]["id"], "patch": {"where": "also", "day": yesterday, "done": True}})
    status, _ = c.api("rollover", None, today=today)
    check("rollover cannot be triggered by a plain GET", status == 405)
    status, r = c.api("rollover", {"today": today})
    check("rollover runs as a protected POST", status == 200 and r["carried"] == 1, str(r))
    _, st = c.api("state", day=today)
    by = {x["title"]: x for x in st["tasks"]}
    check("yesterday's unfinished task is carried to the dump", by.get("Old unfinished", {}).get("where") == "dump"
          and by["Old unfinished"]["carried"] and by["Old unfinished"]["start"] is None)
    check("yesterday's finished task stays on yesterday", "Old finished" not in by)
    _, st = c.api("state", day=yesterday)
    check("...and is still visible on that day", any(x["title"] == "Old finished" for x in st["tasks"]))
    status, _ = c.api("rollover", {"today": "2031-01-01"})
    check("a bogus 'today' from the browser is refused", status == 400)

    # --- projects ---
    status, r = c.api("project_add", {"name": "Side", "color": "#ABCDEF"})
    check("project added", status == 200 and r["project"]["color"] == "#abcdef")
    status, _ = c.api("project_update", {"id": r["project"]["id"], "color": "red"})
    check("bad color refused", status == 400)
    c.api("task_update", {"id": t["id"], "patch": {"p": r["project"]["id"]}})
    c.api("project_delete", {"id": r["project"]["id"]})
    _, st = c.api("state", day=today)
    check("deleting a project keeps its tasks", any(x["id"] == t["id"] and x["p"] is None for x in st["tasks"]))

    # --- calendar ---
    _, cal = c.api("calendar", day=today)
    check("calendar reports not connected", cal.get("connected") is False)
    status, r = c.api("calendar_connect", {"url": "https://evil.example.com/macros/s/aaaaaaaaaaaaaaaaaaaaaaaa/exec"})
    check("non-Google bridge address refused", status == 400)
    status, r = c.api("calendar_connect", {"url": "http://169.254.169.254/latest"})
    check("internal address refused", status == 400)
    status, r = c.api("calendar_connect", {"url": f"http://127.0.0.1:{BRIDGE_PORT}/exec"})
    check("bridge connects", status == 200 and r.get("calendars") == ["Main", "Outlook"], str(r))
    _, cal = c.api("calendar", day=today)
    check("events come through", cal.get("connected") and cal["events"][0]["start"] == 600
          and cal["allDay"][0]["title"] == "Holiday", str(cal))
    c.api("task_update", {"id": t["id"], "patch": {"where": "also", "day": today, "start": 480, "dur": 60}})
    status, r = c.api("calendar_push", {"day": today})
    check("push sends the day's blocks", status == 200 and r["created"] == 1 and pushed
          and pushed[-1]["blocks"][0]["start"] == 480 and pushed[-1]["date"] == today, str(r))
    status, code = c.api("bridge_code")
    check("bridge script carries the key", status == 200 and Bridge.key in code["code"] and "__BRIDGE_KEY__" not in code["code"])

    # --- files that must never be served (PHP's dev server has no .htaccess, so check the rules exist) ---
    ht = (site / ".htaccess").read_text()
    check(".htaccess blocks data and lib", "^(data|lib)" in ht)

    # --- settings and password ---
    status, r = c.api("settings", {"dayStart": 6, "dayEnd": 22})
    check("day hours saved", status == 200 and r["settings"] == {"dayStart": 6, "dayEnd": 22})
    status, r = c.api("settings", {"dayStart": 10, "dayEnd": 11})
    check("too-short day refused", status == 400)
    other = Client()
    other.login("alex", "correct horse battery")
    status, r = c.api("password", {"current": "nope", "new": "a-much-longer-password"})
    check("password change needs the current password", status == 400)
    status, r = c.api("password", {"current": "correct horse battery", "new": "x" * 73})
    check("over-long new password refused", status == 400)
    status, r = c.api("password", {"current": "correct horse battery", "new": "short"})
    check("short new password refused", status == 400)
    status, r = c.api("password", {"current": "correct horse battery", "new": "a-much-longer-password"})
    check("password changed", status == 200, str(r))
    status, _ = c.api("state", day=today)
    check("this session stays signed in", status == 200)
    status, _ = other.api("state", day=today)
    check("other sessions are signed out", status == 401)
    fresh = Client()
    check("old password no longer works", not fresh.login("alex", "correct horse battery")[0])
    check("new password works", fresh.login("alex", "a-much-longer-password")[0])

    # --- logout and lockout ---
    c.api("logout", {})
    status, _ = c.api("state", day=today)
    check("logout ends the session", status == 401)
    attacker = Client()
    for _ in range(8):
        attacker.login("alex", "guess")
    ok, html = attacker.login("alex", "a-much-longer-password")
    check("lockout after 8 wrong attempts, even with the right password", not ok and "Too many wrong attempts" in html)


def run_local(work):
    """Local mode, as start.php sets it up: no sign-in, this computer only, files blocked by the router."""
    today = date.today().isoformat()
    site = work / "local"
    shutil.copytree(ROOT / "public", site, ignore=shutil.ignore_patterns("planner.sqlite*", "sessions", "config.php", "server.log"))
    (site / "data" / "config.php").write_text(
        "<?php return ['env'=>'local','bridge_key'=>'" + "k" * 64 + "','local_key'=>'" + "L" * 64 + "'];",
        encoding="utf-8")
    php = subprocess.Popen(["php", "-S", f"127.0.0.1:{LOCAL_PORT}", "-t", str(site), str(ROOT / "tools" / "router.php")],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        c = Client()
        c.base = f"http://127.0.0.1:{LOCAL_PORT}"
        for _ in range(50):
            try:
                urllib.request.urlopen(c.base + "/", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        status, html, _ = c.raw("/")
        check("local mode: refused without the key that start.php hands over", status == 403 and "app.js" not in html)
        status, body, _ = c.raw("/api.php?action=state&day=" + today)
        check("local mode: the API is refused without it too", status == 403 and "projects" not in body)
        status, html, _ = c.raw("/?k=" + "x" * 64)
        check("local mode: a wrong key is refused", status == 403)
        status, html, _ = c.raw("/?k=" + "L" * 64)
        cookie = next((k for k in c.jar if k.name == "planner_local"), None)
        check("local mode: the right key sets an HttpOnly, SameSite=Strict cookie", cookie is not None
              and cookie.has_nonstandard_attr("HttpOnly") and cookie.get_nonstandard_attr("SameSite") == "Strict")
        check("local mode: board opens without a sign-in", status == 200 and "app.js" in html and 'name="password"' not in html)
        check("local mode: no password or sign-out controls", 'data-act="change-pw"' not in html and 'data-act="logout"' not in html)
        c.csrf = re.search(r'name="csrf" content="([0-9a-f]+)"', html).group(1)
        status, st = c.api("state", day=today)
        check("local mode: state says so", status == 200 and st.get("local") is True and st.get("user") == "")
        status, r = c.api("task_add", {"title": "Local task"})
        check("local mode: tasks can be added", status == 200 and r["task"]["title"] == "Local task")
        status, _ = c.api("task_add", {"title": "x"}, csrf=False)
        check("local mode: a change still needs the CSRF token", status == 403)
        status, _ = c.api("password", {"current": "", "new": "a-much-longer-password"})
        check("local mode: password change refused", status == 400)
        status, _ = c.api("logout", {})
        check("local mode: logout refused", status == 400)
        status, body, _ = c.raw("/", headers={"Host": "planner.example.com"})
        check("local mode: a request addressed to another host name is refused", status == 403 and "app.js" not in body)
        status, body, _ = c.raw("/api.php?action=state&day=" + today, headers={"Host": "planner.example.com"})
        check("local mode: the API refuses another host name too", status == 403 and "projects" not in body)
        for path in ("/data/config.php", "/data/planner.sqlite", "/lib/boot.php", "/lib/bridge.gs.txt",
                     "/DATA/config.php", "/data%2Fconfig.php", "/.htaccess", "///data/planner.sqlite",
                     "//data/config.php", "/data./planner.sqlite", "/data/planner.sqlite::$DATA",
                     "//data/config.php::$DATA", "/data::$INDEX_ALLOCATION/config.php", "/index.php::$DATA",
                     "/api.php/data/config.php", "/assets/../data/config.php", "/assets/app.js::$DATA",
                     "/data/server.log", "/lib./bridge.gs.txt"):
            status, body, _ = c.raw(path)
            check(f"local mode: {path} is not served", status == 403 and "bridge_key" not in body, str(status))
        status, _, _ = c.raw("/assets/app.js")
        check("local mode: the app's own files are served", status == 200)
        status, body, _ = c.raw("/assets/app.js", headers={"Host": "planner.example.com"})
        check("local mode: not even those under another host name", status == 403)
    finally:
        php.terminate()


if __name__ == "__main__":
    main()
