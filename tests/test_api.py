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
import sqlite3
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
PORT, BRIDGE_PORT, LOCAL_PORT, MIGRATE_PORT = 8791, 8792, 8793, 8796
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
    knows_range = True       # False acts like a script pasted before the Calendar page existed
    range_error = None       # an error the bridge reports for a range
    range_calls = 0

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
        if q.get("action") == "range":
            Bridge.range_calls += 1
            if not Bridge.knows_range:
                return self.send({"error": "unknown action"})
            if Bridge.range_error:
                return self.send({"error": Bridge.range_error})
            today = date.today().isoformat()
            days = {q["from"]: {"events": [], "allDay": [{"title": "Range start", "calendar": "Main"}]},
                    "1999-01-01": {"events": [], "allDay": [{"title": "Outside the range", "calendar": "Main"}]}}
            if q["from"] <= today <= q["to"]:
                days[today] = {"events": [{"title": "Team <b>call</b>", "start": 600, "end": 660, "calendar": "Main"}],
                               "allDay": [{"title": "Holiday", "calendar": "Main"}]}
            return self.send({"ok": True, "tz": "Europe/Paris", "days": days})
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
        run_migration(work)
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

    # --- notes and subtasks ---
    check("a new task has empty notes and no subtasks", t.get("notes") == "" and t.get("subs") == [], str(t))
    _, st = c.api("state", day=today)
    check("state lists every task with notes and subs", st["tasks"] and all(
        x.get("notes") == "" and x.get("subs") == [] for x in st["tasks"]), str(st["tasks"][:1]))
    status, r = c.api("task_update", {"id": t["id"], "patch": {"notes": "line1\r\nline2"}})
    check("notes keep only newline line ends", status == 200 and r["task"]["notes"] == "line1\nline2", str(r))
    status, r = c.api("task_update", {"id": t["id"], "patch": {"notes": "é" * 6000}})
    check("notes over 5000 characters are cut", status == 200 and r["task"]["notes"] == "é" * 5000)
    for bad in (123, ["a"], None):
        status, r = c.api("task_update", {"id": t["id"], "patch": {"notes": bad}})
        check(f"non-text notes refused: {bad!r}", status == 400, str(r))
    subs_in = [{"title": "  Buy   paint ", "done": False}, {"title": "", "done": True}, {"title": "Sand", "done": 1}]
    status, r = c.api("task_update", {"id": t["id"], "patch": {"subs": subs_in}})
    check("subtasks are tidied: spaces collapsed, empty dropped, done a boolean", status == 200 and r["task"]["subs"] ==
          [{"title": "Buy paint", "done": False}, {"title": "Sand", "done": True}], str(r))
    status, r = c.api("task_update", {"id": t["id"], "patch": {"subs": [{"title": f"s{i}"} for i in range(51)]}})
    check("more than 50 subtasks refused", status == 400, str(r))
    status, r = c.api("task_update", {"id": t["id"], "patch": {"subs": [{"title": f"s{i}"} for i in range(50)]}})
    check("exactly 50 subtasks accepted", status == 200 and len(r["task"]["subs"]) == 50, str(r)[:200])
    for bad in ("Buy paint", {"title": "x", "done": False}, 5, ["text"]):
        status, r = c.api("task_update", {"id": t["id"], "patch": {"subs": bad}})
        check(f"subs that is not a list of subtasks refused: {bad!r}", status == 400, str(r))
    c.api("task_update", {"id": t["id"], "patch": {"subs": subs_in}})
    status, r = c.api("task_update", {"id": t["id"], "patch": {"dur": 45}})
    check("an unrelated change keeps notes and subtasks", status == 200 and r["task"]["dur"] == 45
          and r["task"]["notes"] == "é" * 5000 and len(r["task"]["subs"]) == 2, str(r)[:200])
    _, st = c.api("state", day=today)
    got = next(x for x in st["tasks"] if x["id"] == t["id"])
    check("state shows the saved notes and subtasks", got["notes"] == "é" * 5000
          and [s["title"] for s in got["subs"]] == ["Buy paint", "Sand"])
    c.api("task_update", {"id": t["id"], "patch": {"notes": ""}})
    c.api("task_update", {"id": t["id"], "patch": {"subs": []}})

    # two tasks planned at the same time are allowed
    ids = []
    for name in ("Twin A", "Twin B"):
        _, r = c.api("task_add", {"title": name})
        ids.append(r["task"]["id"])
        status, r = c.api("task_update", {"id": r["task"]["id"], "patch": {"where": "also", "day": today, "start": 900, "dur": 30}})
    _, st = c.api("state", day=today)
    twins = [x for x in st["tasks"] if x["id"] in ids]
    check("two tasks can share a start time on the same day", len(twins) == 2 and all(x["start"] == 900 for x in twins))
    for i in ids:
        c.api("task_delete", {"id": i})

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

    run_boards(c, today)
    run_events(c, today)

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
    check("bridge script answers ranges", "action === 'range'" in code["code"])
    run_month_google(c, today)

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

    # --- the board page: theme and the password form ---
    page_c = Client()
    page_c.login("alex", "a-much-longer-password")
    sess = "; ".join(f"{k.name}={k.value}" for k in page_c.jar)

    def themed(val):
        return page_c.raw("/", headers={"Cookie": sess + ("; planner_theme=" + val if val else "")})[1]
    html = themed("")
    check("this is the signed-in board", "app.js" in html)
    check("board page is dark by default", re.search(r'<html[^>]*data-theme="dark"', html) is not None)
    html = themed("light")
    check("cookie planner_theme=light gives the light theme", re.search(r'<html[^>]*data-theme="light"', html) is not None)
    for val in ("dark", "blue", "LIGHT", '"><script>'.replace('"', "%22")):
        html = themed(val)
        check(f"any other theme cookie ({val}) gives dark", re.search(r'<html[^>]*data-theme="dark"', html) is not None)
    form = re.search(r'<form[^>]*id="pw-form".*?</form>', html, re.S)
    check("password boxes sit in #pw-form with a user name input", form is not None and 'id="pw-cur"' in form.group(0)
          and 'id="pw-new"' in form.group(0) and 'autocomplete="username"' in form.group(0))
    forms = re.findall(r'<form.*?</form>', html, re.S)
    own = [f for f in forms if 'id="new"' in f]
    check("the brain dump box sits in a form of its own, away from any password box",
          len(own) == 1 and 'type="password"' not in own[0] and 'type="submit"' in own[0])
    check("every password box is in the password form", html.count('type="password"') == form.group(0).count('type="password"'))

    # --- logout and lockout ---
    c.api("logout", {})
    status, _ = c.api("state", day=today)
    check("logout ends the session", status == 401)
    attacker = Client()
    for _ in range(8):
        attacker.login("alex", "guess")
    ok, html = attacker.login("alex", "a-much-longer-password")
    check("lockout after 8 wrong attempts, even with the right password", not ok and "Too many wrong attempts" in html)


def run_boards(c, today):
    """Boards: separate task lists. Leaves the database with the one starting board and no extra tasks."""
    status, st = c.api("state", day=today)
    first = st.get("board")
    check("boards: a fresh database has one board named Main",
          status == 200 and st.get("boards") == [{"id": first, "name": "Main"}] and first == 1, str(st.get("boards")))
    check("boards: every task says which board it is on", st["tasks"] and all(x.get("board") == first for x in st["tasks"]))
    base_titles = sorted(x["title"] for x in st["tasks"])

    status, r = c.api("board_add", {"name": "  Side   hustle  "})
    b2 = r.get("board", {}).get("id")
    check("boards: a board is added, its name tidied", status == 200 and r["board"]["name"] == "Side hustle"
          and [b["id"] for b in r["boards"]] == [first, b2], str(r))
    status, r = c.api("board_add", {"name": "é" * 40})
    b3 = r.get("board", {}).get("id")
    check("boards: a name over 30 characters is cut", status == 200 and r["board"]["name"] == "é" * 30, str(r))
    status, r = c.api("board_add", {"name": "   "})
    check("boards: an empty name is refused on add", status == 400, str(r))
    status, r = c.api("board_add", {"name": "x"}, csrf=False)
    check("boards: adding without the CSRF token is refused", status == 403)
    status, r = c.api("board_update", {"id": b3, "name": "  Third  one "})
    check("boards: a board is renamed", status == 200 and next(b for b in r["boards"] if b["id"] == b3)["name"] == "Third one", str(r))
    # each board has its own projects
    n_first = len(st["projects"])
    _, r = c.api("project_add", {"name": "Clients", "color": "#112233", "board": b2})
    p2 = r["project"]["id"]
    _, on1 = c.api("state", day=today, board=first)
    _, on2 = c.api("state", day=today, board=b2)
    check("projects: a new board starts without projects, and its own project shows only there",
          [p["id"] for p in on2["projects"]] == [p2] and len(on1["projects"]) == n_first
          and p2 not in [p["id"] for p in on1["projects"]], str(on2["projects"]))
    _, r = c.api("task_add", {"title": "Project of another board", "p": p2, "board": first})
    stray = r["task"]["id"]
    check("projects: a task cannot take a project of another board when added", r["task"]["p"] is None, str(r))
    _, r = c.api("task_update", {"id": stray, "patch": {"p": p2}})
    check("projects: nor when changed", r["task"]["p"] is None, str(r))
    _, r = c.api("task_add", {"title": "Has a project", "p": p2, "board": b2})
    own = r["task"]["id"]
    check("projects: a task takes a project of its own board", r["task"]["p"] == p2, str(r))
    _, r = c.api("task_update", {"id": own, "patch": {"board": first}})
    check("projects: a task moved to another board arrives without a project", r["task"]["board"] == first and r["task"]["p"] is None, str(r))
    _, r = c.api("task_update", {"id": own, "patch": {"board": b2}})
    _, r = c.api("task_update", {"id": own, "patch": {"p": p2}})
    _, r = c.api("board_add", {"name": "Short lived"})
    b4 = r["board"]["id"]
    _, r = c.api("project_add", {"name": "Travels", "color": "#445566", "board": b4})
    p4 = r["project"]["id"]
    _, r = c.api("task_add", {"title": "Travels along", "p": p4, "board": b4})
    along = r["task"]["id"]
    _, r = c.api("board_delete", {"id": b4})
    _, on1 = c.api("state", day=today, board=first)
    moved = next((x for x in on1["tasks"] if x["id"] == along), {})
    check("projects: a deleted board's projects move with its tasks", r.get("to") == first and moved.get("p") == p4
          and p4 in [p["id"] for p in on1["projects"]], str(moved))
    for t in (stray, own, along):
        c.api("task_delete", {"id": t})
    c.api("project_delete", {"id": p2})
    c.api("project_delete", {"id": p4})
    _, on1 = c.api("state", day=today, board=first)
    check("projects: the first board's projects are as before", len(on1["projects"]) == n_first)

    status, r = c.api("board_update", {"id": b3, "name": " "})
    check("boards: an empty name is refused on rename", status == 400, str(r))
    status, r = c.api("board_update", {"id": 9999, "name": "Ghost"})
    check("boards: renaming an unknown board gives 404", status == 404, str(r))

    # per-board state
    _, r = c.api("task_add", {"title": "Only on two", "board": b2})
    t2 = r["task"]
    check("boards: a task can be added straight to another board", t2["board"] == b2 and t2["where"] == "dump", str(t2))
    _, r = c.api("task_add", {"title": "Nowhere board", "board": 9999})
    t_unknown = r["task"]
    check("boards: a task added to an unknown board lands on the first one", t_unknown["board"] == first, str(t_unknown))
    _, r = c.api("task_add", {"title": "No board given"})
    t_none = r["task"]
    check("boards: a task added without a board lands on the first one", t_none["board"] == first, str(t_none))
    _, st1 = c.api("state", day=today, board=first)
    _, st2 = c.api("state", day=today, board=b2)
    titles1 = {x["title"] for x in st1["tasks"]}
    titles2 = {x["title"] for x in st2["tasks"]}
    check("boards: a task of board 2 does not show in board 1", "Only on two" not in titles1 and st1["board"] == first)
    check("boards: board 2 shows only its own task, not the brain dump of board 1",
          titles2 == {"Only on two"} and st2["board"] == b2, str(titles2))
    check("boards: board 1 keeps its own tasks", {"Nowhere board", "No board given"} <= titles1)
    check("boards: state lists all boards whichever is in view", st1["boards"] == st2["boards"] and len(st1["boards"]) == 3)
    _, stx = c.api("state", day=today, board=9999)
    check("boards: state for an unknown board falls back to the first", stx["board"] == first
          and {x["title"] for x in stx["tasks"]} == titles1)
    _, stx = c.api("state", day=today)
    check("boards: state without a board uses the first", stx["board"] == first)

    # moving a task
    _, r = c.api("task_add", {"title": "Planned mover"})
    mover = r["task"]["id"]
    c.api("task_update", {"id": mover, "patch": {"where": "top", "slot": 1, "day": today, "start": 540, "dur": 60}})
    status, r = c.api("task_update", {"id": mover, "patch": {"board": first}})
    check("boards: sending a task to the board it is on changes nothing else", status == 200
          and r["task"]["where"] == "top" and r["task"]["slot"] == 1 and r["task"]["start"] == 540
          and r["task"]["day"] == today and r["task"]["board"] == first, str(r))
    status, r = c.api("task_update", {"id": mover, "patch": {"board": 9999}})
    check("boards: moving a task to an unknown board gives 404", status == 404, str(r))
    _, st1 = c.api("state", day=today, board=first)
    check("boards: ...and the task stays where it was", any(x["id"] == mover and x["where"] == "top" for x in st1["tasks"]))
    status, r = c.api("task_update", {"id": mover, "patch": {"board": b2}})
    m = r.get("task", {})
    check("boards: a planned task moved to another board lands in its brain dump", status == 200 and m.get("board") == b2
          and m.get("where") == "dump" and m.get("day") is None and m.get("start") is None and m.get("slot") is None, str(r))
    _, st1 = c.api("state", day=today, board=first)
    _, st2 = c.api("state", day=today, board=b2)
    check("boards: the moved task left the first board and shows in the second",
          all(x["id"] != mover for x in st1["tasks"]) and any(x["id"] == mover for x in st2["tasks"]))
    _, r = c.api("task_update", {"id": mover, "patch": {"where": "also", "day": today, "start": 600}})
    check("boards: a task can be planned on a board other than the first",
          r["task"]["where"] == "also" and r["task"]["board"] == b2, str(r))
    _, st2 = c.api("state", day=today, board=b2)
    check("boards: planned tasks show only on their own board's day",
          any(x["id"] == mover and x["where"] == "also" for x in st2["tasks"]))
    _, st1 = c.api("state", day=today, board=first)
    check("boards: ...not on the other board's timeline", all(x["id"] != mover for x in st1["tasks"]))

    # the limit of 8 boards
    _, r = c.api("state", day=today)
    have = len(r["boards"])
    extra = []
    for i in range(8 - have):
        status, r = c.api("board_add", {"name": f"Extra {i}"})
        extra.append(r["board"]["id"])
    check("boards: up to 8 boards can be made", status == 200 and len(r["boards"]) == 8, str(r))
    status, r = c.api("board_add", {"name": "Ninth"})
    check("boards: a 9th board is refused", status == 400, str(r))

    # deleting
    status, r = c.api("board_delete", {"id": 9999})
    check("boards: deleting an unknown board gives 404", status == 404, str(r))
    for i in extra:
        c.api("board_delete", {"id": i})
    status, r = c.api("board_delete", {"id": b2})
    check("boards: deleting a board reports how many tasks moved and where", status == 200 and r["moved"] == 2
          and r["to"] == first and [b["id"] for b in r["boards"]] == [first, b3], str(r))
    _, st1 = c.api("state", day=today, board=first)
    got = {x["id"]: x for x in st1["tasks"]}
    check("boards: the deleted board's tasks are now in the first board's brain dump, unplanned",
          mover in got and t2["id"] in got and all(got[i]["where"] == "dump" and got[i]["day"] is None
          and got[i]["start"] is None and got[i]["board"] == first for i in (mover, t2["id"])), str(got.get(mover)))
    _, stx = c.api("state", day=today, board=b2)
    check("boards: asking for the deleted board falls back to the first", stx["board"] == first)
    status, r = c.api("board_delete", {"id": b3})
    check("boards: the second-to-last board can go", status == 200 and r["moved"] == 0 and len(r["boards"]) == 1, str(r))
    status, r = c.api("board_delete", {"id": first})
    check("boards: the last board cannot be deleted", status == 400, str(r))
    _, st = c.api("state", day=today)
    check("boards: one board is left", len(st["boards"]) == 1 and st["boards"][0]["id"] == first)

    for i in (mover, t2["id"], t_unknown["id"], t_none["id"]):
        c.api("task_delete", {"id": i})
    _, st = c.api("state", day=today)
    check("boards: the test tasks are cleaned up", sorted(x["title"] for x in st["tasks"]) == base_titles, str(st["tasks"]))


def run_events(c, today):
    """Events: the board's own entries over one or more days. Leaves no events and no extra boards behind."""
    d = date.today()

    def day(n):
        return (d + timedelta(days=n)).isoformat()
    _, st = c.api("state", day=today)
    first = st["board"]
    pid = st["projects"][0]["id"]
    check("events: state lists the day's events, none yet", st.get("events") == [], str(st.get("events")))

    # access
    status, _ = c.api("event_add", {"title": "x", "from": today}, csrf=False)
    check("events: adding without the CSRF token is refused", status == 403)
    status, _ = c.api("event_add", None, title="x", **{"from": today})
    check("events: adding with a GET is refused", status == 405)
    status, _ = c.api("events", {"from": today, "to": today})
    check("events: reading with a POST is refused", status == 405)
    status, _ = c.api("month", {"from": today, "to": today})
    check("events: the month cannot be read with a POST", status == 405)

    # adding
    status, r = c.api("event_add", {"title": "  Design   <b>workshop</b> ", "from": day(10), "to": day(11),
                                    "location": "  Hall   B ", "p": pid, "notes": "a\r\nb",
                                    "subs": [{"title": " Book  the room ", "done": True}, {"title": ""}, {"title": "Print badges"}]})
    w = r.get("event", {})
    check("events: an event is added, title and place tidied", status == 200 and w.get("title") == "Design <b>workshop</b>"
          and w.get("location") == "Hall B" and w.get("from") == day(10) and w.get("to") == day(11), str(r))
    check("events: it is all-day, on the first board, with its project", w.get("start") is None and w.get("end") is None
          and w.get("board") == first and w.get("p") == pid, str(w))
    check("events: notes and the checklist are kept like a task's", w.get("notes") == "a\nb"
          and w.get("subs") == [{"title": "Book the room", "done": True}, {"title": "Print badges", "done": False}], str(w))
    check("events: the answer has exactly the agreed fields", set(w) == {"id", "board", "title", "from", "to", "start", "end",
          "location", "p", "notes", "subs"}, str(sorted(w)))
    status, r = c.api("event_add", {"title": "One day", "from": day(12)})
    one = r.get("event", {})
    check("events: without a To date the event lasts one day", status == 200 and one.get("to") == day(12)
          and one.get("location") == "" and one.get("subs") == [] and one.get("notes") == "", str(r))
    status, r = c.api("event_add", {"title": "Late", "from": day(12), "start": 23 * 60, "end": 1440})
    late = r.get("event", {})
    check("events: a timed event may end at midnight (1440)", status == 200 and late.get("start") == 1380 and late.get("end") == 1440, str(r))
    status, r = c.api("event_add", {"title": "é" * 400, "from": day(12), "location": "ü" * 300})
    long = r.get("event", {})
    check("events: a long title is cut at 300 and a long place at 200", status == 200 and long.get("title") == "é" * 300
          and long.get("location") == "ü" * 200, str(r)[:200])
    status, r = c.api("event_add", {"title": "Sixty days", "from": day(1), "to": day(60)})
    sixty = r.get("event", {})
    check("events: an event of 60 days is accepted", status == 200 and sixty.get("to") == day(60), str(r))

    bad_adds = [
        ({"title": "   ", "from": today}, "An event needs a title"),
        ({"title": "x"}, "Bad day"),
        ({"title": "x", "from": "2026-02-30"}, "Bad day"),
        ({"title": "x", "from": today, "to": "soon"}, "Bad day"),
        ({"title": "x", "from": day(5), "to": day(4)}, "The end date is before the start date"),
        ({"title": "x", "from": day(1), "to": day(61)}, "An event can last at most 60 days"),
        ({"title": "x", "from": today, "start": 600}, "Give both a start and an end time"),
        ({"title": "x", "from": today, "end": 600}, "Give both a start and an end time"),
        ({"title": "x", "from": today, "to": day(1), "start": 600, "end": 660}, "Only a one-day event can have a time"),
        ({"title": "x", "from": today, "start": 660, "end": 660}, "The end time must be after the start time"),
        ({"title": "x", "from": today, "start": 700, "end": 660}, "The end time must be after the start time"),
        ({"title": "x", "from": today, "start": -5, "end": 60}, "Bad time"),
        ({"title": "x", "from": today, "start": 60, "end": 1441}, "Bad time"),
        ({"title": "x", "from": today, "start": "600", "end": 660}, "Bad time"),
        ({"title": "x", "from": today, "location": 5}, "Bad location"),
        ({"title": "x", "from": today, "notes": 5}, "Bad notes"),
        ({"title": "x", "from": today, "subs": "Book"}, "Bad subtasks"),
        ({"title": "x", "from": today, "subs": [{"title": str(i)} for i in range(51)]}, "Bad subtasks"),
    ]
    for body, msg in bad_adds:
        status, r = c.api("event_add", body)
        shown = {k: v for k, v in body.items() if k != "subs"}
        check(f"events: refused with 400 ({msg}): {shown}", status == 400 and r.get("error") == msg, str(r))

    # projects belong to one board
    _, r = c.api("board_add", {"name": "Second"})
    b2 = r["board"]["id"]
    _, r = c.api("project_add", {"name": "Theirs", "color": "#123456", "board": b2})
    p2 = r["project"]["id"]
    _, r = c.api("event_add", {"title": "Wrong project", "from": day(3), "p": p2})
    check("events: a project of another board is dropped", r["event"]["p"] is None and r["event"]["board"] == first, str(r))
    stray = [r["event"]["id"]]
    _, r = c.api("event_add", {"title": "No such project", "from": day(3), "p": 99999})
    check("events: an unknown project is dropped", r["event"]["p"] is None, str(r))
    stray.append(r["event"]["id"])

    # changing
    status, r = c.api("event_update", {"id": one["id"], "patch": {"title": " Renamed ", "location": "Depot", "p": pid}})
    check("events: a change is saved", status == 200 and r["event"]["title"] == "Renamed" and r["event"]["location"] == "Depot"
          and r["event"]["p"] == pid and r["event"]["from"] == day(12), str(r))
    status, r = c.api("event_update", {"id": one["id"], "patch": {"start": 540, "end": 600}})
    check("events: a one-day event can get a time", status == 200 and r["event"]["start"] == 540 and r["event"]["end"] == 600, str(r))
    status, r = c.api("event_update", {"id": one["id"], "patch": {"to": day(13)}})
    check("events: making a timed event longer than a day is refused as a whole",
          status == 400 and r.get("error") == "Only a one-day event can have a time", str(r))
    status, r = c.api("event_update", {"id": one["id"], "patch": {"to": day(13), "start": None, "end": None}})
    check("events: ...but works together with clearing the time", status == 200 and r["event"]["to"] == day(13)
          and r["event"]["start"] is None, str(r))
    status, r = c.api("event_update", {"id": one["id"], "patch": {"from": day(14)}})
    check("events: moving the start past the end is refused", status == 400
          and r.get("error") == "The end date is before the start date", str(r))
    status, r = c.api("event_update", {"id": one["id"], "patch": {"from": day(14), "to": day(15)}})
    check("events: moving both dates keeps the length", status == 200 and (r["event"]["from"], r["event"]["to"]) == (day(14), day(15)), str(r))
    status, r = c.api("event_update", {"id": one["id"], "patch": {"subs": [{"title": "Van", "done": False}], "notes": "Gate 3"}})
    check("events: the checklist and notes can be changed", status == 200 and r["event"]["subs"] == [{"title": "Van", "done": False}]
          and r["event"]["notes"] == "Gate 3", str(r))
    status, r = c.api("event_update", {"id": one["id"], "patch": {"board": b2, "id": 5}})
    check("events: fields that are not the event's own are ignored", status == 200 and r["event"]["board"] == first
          and r["event"]["id"] == one["id"], str(r))
    status, r = c.api("event_update", {"id": one["id"], "patch": {"title": ""}})
    check("events: an empty title is refused on change", status == 400 and r.get("error") == "An event needs a title", str(r))
    status, r = c.api("event_update", {"id": one["id"], "patch": "title"})
    check("events: a change that is not a list of fields is refused", status == 400, str(r))
    status, r = c.api("event_update", {"id": 99999, "patch": {"title": "Ghost"}})
    check("events: changing an unknown event gives 404", status == 404, str(r))
    status, _ = c.api("event_update", {"id": one["id"], "patch": {"title": "x"}}, csrf=False)
    check("events: changing without the CSRF token is refused", status == 403)

    # reading a range: every event that touches it
    def titles(f, t, board=None):
        params = {"from": f, "to": t}
        if board is not None:
            params["board"] = board
        status, r = c.api("events", **params)
        return [e["title"] for e in r.get("events", [])]
    w_title = w["title"]
    check("events: a range ending on an event's first day includes it", w_title in titles(day(5), day(10)))
    check("events: a range starting on an event's last day includes it", w_title in titles(day(11), day(20)))
    check("events: a range inside a multi-day event includes it", w_title in titles(day(11), day(11)))
    check("events: a range just before it leaves it out", w_title not in titles(day(5), day(9)))
    check("events: a range just after it leaves it out", w_title not in titles(day(12), day(13)))
    status, r = c.api("events", **{"from": day(12), "to": day(12)})
    got = [(e["title"], e["start"]) for e in r["events"]]
    check("events: all-day events come first (by start day), then timed ones by start",
          [x for x in got if x[0] in ("Late", "é" * 300, "Sixty days")] == [("Sixty days", None), ("é" * 300, None), ("Late", 1380)], str(got))
    for params, why in (({"from": day(5), "to": day(4)}, "a range that ends before it starts"),
                        ({"from": day(0), "to": day(62)}, "a range of 63 days"),
                        ({"from": "2026-13-01", "to": day(1)}, "a bad day"),
                        ({"from": day(0)}, "a missing end")):
        status, r = c.api("events", **params)
        check(f"events: reading {why} is refused", status == 400, str(r))
    status, _ = c.api("events", **{"from": day(0), "to": day(61)})
    check("events: a range of 62 days is fine", status == 200)

    # boards
    _, r = c.api("event_add", {"title": "On two", "from": day(10), "board": b2})
    on2 = r["event"]
    check("events: an event can be added to another board", on2["board"] == b2, str(on2))
    check("events: it does not show on the first board", "On two" not in titles(day(10), day(10)))
    check("events: it shows on its own board, alone", titles(day(10), day(10), b2) == ["On two"])
    check("events: an unknown board reads as the first", titles(day(10), day(10), 9999) == titles(day(10), day(10)))
    _, r = c.api("event_add", {"title": "Theirs too", "from": day(10), "board": b2, "p": p2})
    check("events: an event takes a project of its own board", r["event"]["p"] == p2, str(r))

    # state: only the events covering the day asked for
    _, r = c.api("event_add", {"title": "Spans today", "from": day(-1), "to": day(1)})
    spans = r["event"]["id"]
    _, st = c.api("state", day=today)
    check("events: state lists an event that started yesterday and ends tomorrow", [e["title"] for e in st["events"]] == ["Spans today"], str(st["events"]))
    _, st = c.api("state", day=day(12))
    check("events: state for another day lists that day's events", {e["title"] for e in st["events"]} == {"Late", "é" * 300, "Sixty days"},
          str([e["title"] for e in st["events"]]))
    _, st = c.api("state", day=day(10), board=b2)
    check("events: state shows only the board's own events", [e["title"] for e in st["events"]] == ["On two", "Theirs too"], str(st["events"]))

    # the month: events, planned tasks and Google in one answer
    _, r = c.api("task_add", {"title": "Planned in range", "p": pid})
    planned = r["task"]["id"]
    c.api("task_update", {"id": planned, "patch": {"where": "top", "slot": 1, "day": day(10), "start": 600}})
    _, r = c.api("task_add", {"title": "In the dump"})
    dumped = r["task"]["id"]
    status, m = c.api("month", **{"from": day(8), "to": day(14)})
    check("month: one answer holds events, tasks and google", status == 200 and set(m) == {"events", "tasks", "google"}, str(m)[:200])
    check("month: the events of the range", {e["title"] for e in m["events"]} >= {w_title, "Late", "Sixty days"}
          and "On two" not in {e["title"] for e in m["events"]}, str([e["title"] for e in m["events"]]))
    mt = [t for t in m["tasks"] if t["id"] == planned]
    check("month: the planned task, with only the fields the calendar needs", len(mt) == 1 and mt[0] == {
          "id": planned, "title": "Planned in range", "day": day(10), "where": "top", "slot": 1, "start": 600,
          "dur": 30, "done": False, "p": pid}, str(mt))
    check("month: tasks in the brain dump are left out", all(t["id"] != dumped for t in m["tasks"]))
    check("month: Google is reported as not connected", m["google"] == {"connected": False}, str(m["google"]))
    status, m = c.api("month", **{"from": day(8), "to": day(14)}, board=b2)
    check("month: another board shows its own events and no tasks of the first", [e["title"] for e in m["events"]] == ["On two", "Theirs too"]
          and m["tasks"] == [], str(m)[:200])
    status, m = c.api("month", **{"from": day(0), "to": day(62)})
    check("month: more than 62 days is refused", status == 400, str(m))
    c.api("task_delete", {"id": planned})
    c.api("task_delete", {"id": dumped})

    # deleting a project or a board keeps the events
    _, r = c.api("project_add", {"name": "Short", "color": "#654321", "board": first})
    p_short = r["project"]["id"]
    _, r = c.api("event_add", {"title": "Keeps going", "from": day(2), "p": p_short})
    keeps = r["event"]["id"]
    c.api("project_delete", {"id": p_short})
    _, r = c.api("events", **{"from": day(2), "to": day(2)})
    k = next((e for e in r["events"] if e["id"] == keeps), {})
    check("events: deleting a project keeps its events, without a project", k.get("title") == "Keeps going" and k.get("p") is None, str(k))
    status, r = c.api("board_delete", {"id": b2})
    check("events: the second board is deleted", status == 200 and r["to"] == first, str(r))
    _, r = c.api("events", **{"from": day(10), "to": day(10)})
    moved = {e["title"]: e for e in r["events"]}
    check("events: a deleted board's events move to the board that takes its tasks",
          "On two" in moved and moved["On two"]["board"] == first and moved["Theirs too"]["p"] == p2, str(list(moved)))

    # deleting
    status, r = c.api("event_delete", {"id": spans}, csrf=False)
    check("events: deleting without the CSRF token is refused", status == 403)
    status, r = c.api("event_delete", {"id": spans})
    check("events: an event is deleted", status == 200 and r == {"ok": True}, str(r))
    _, st = c.api("state", day=today)
    check("events: it is gone from the day", st["events"] == [], str(st["events"]))
    status, r = c.api("event_update", {"id": spans, "patch": {"title": "Back?"}})
    check("events: a deleted event gives 404", status == 404, str(r))
    for e in [w, one, late, long, sixty, moved["On two"], moved["Theirs too"]]:
        c.api("event_delete", {"id": e["id"]})
    for i in stray + [keeps]:
        c.api("event_delete", {"id": i})
    c.api("project_delete", {"id": p2})
    _, r = c.api("events", **{"from": day(-1), "to": day(60)})
    check("events: the test events are cleaned up", r["events"] == [], str(r["events"])[:200])
    _, st = c.api("state", day=today)
    check("events: one board is left, with its projects as before", len(st["boards"]) == 1 and pid in [p["id"] for p in st["projects"]])


def run_month_google(c, today):
    """Google events on the Calendar page: one bridge call per range, cached, and never fatal."""
    d = date.today()

    def day(n):
        return (d + timedelta(days=n)).isoformat()
    before = Bridge.range_calls
    status, m = c.api("month", **{"from": day(-3), "to": day(3)})
    g = m.get("google", {})
    check("month: Google events come through for the range", status == 200 and g.get("connected") is True
          and g["days"][today]["events"][0] == {"title": "Team <b>call</b>", "start": 600, "end": 660, "calendar": "Main"}
          and g["days"][today]["allDay"][0]["title"] == "Holiday" and g["days"][day(-3)]["allDay"][0]["title"] == "Range start", str(g))
    check("month: days outside the range are dropped", "1999-01-01" not in g.get("days", {}), str(g.get("days", {}).keys()))
    check("month: the bridge was asked once", Bridge.range_calls == before + 1, str(Bridge.range_calls - before))
    status, m = c.api("month", **{"from": day(-3), "to": day(3)})
    check("month: the second read of the same range comes from the cache", status == 200 and Bridge.range_calls == before + 1
          and m["google"]["days"][today]["events"][0]["start"] == 600, str(Bridge.range_calls - before))
    status, m = c.api("month", **{"from": day(-3), "to": day(3)}, refresh="1")
    check("month: refresh asks the bridge again", status == 200 and Bridge.range_calls == before + 2)

    Bridge.knows_range = False
    _, r = c.api("event_add", {"title": "Still here", "from": day(20)})
    still = r["event"]["id"]
    status, m = c.api("month", **{"from": day(20), "to": day(26)})
    check("month: an older script that does not know ranges asks for an update", status == 200
          and m["google"] == {"connected": True, "needsUpdate": True, "days": {}}, str(m.get("google")))
    check("month: ...and the board's own events still come", [e["title"] for e in m.get("events", [])] == ["Still here"], str(m)[:200])
    Bridge.knows_range = True
    Bridge.range_error = "Calendar is busy"
    status, m = c.api("month", **{"from": day(27), "to": day(30)})
    check("month: a Google error is reported in the answer, not as a failure", status == 200
          and "Calendar is busy" in m["google"].get("error", "") and m["google"]["days"] == {}, str(m.get("google")))
    Bridge.range_error = None
    c.api("event_delete", {"id": still})

    status, _ = c.api("calendar_connect", {"url": f"http://127.0.0.1:{BRIDGE_PORT}/exec"})
    before = Bridge.range_calls
    c.api("month", **{"from": day(-3), "to": day(3)})
    check("month: connecting again clears the cached ranges", status == 200 and Bridge.range_calls == before + 1)
    status, _ = c.api("calendar_disconnect", {})
    _, m = c.api("month", **{"from": day(-3), "to": day(3)})
    check("month: after disconnecting, Google is not connected", m["google"] == {"connected": False}, str(m.get("google")))
    c.api("calendar_connect", {"url": f"http://127.0.0.1:{BRIDGE_PORT}/exec"})


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


def run_migration(work):
    """A database made by version 1 (no notes, no subtasks, old starter colors) is upgraded in place."""
    today = date.today().isoformat()
    site = work / "migrate"
    shutil.copytree(ROOT / "public", site, ignore=shutil.ignore_patterns("planner.sqlite*", "sessions", "config.php", "server.log"))
    (site / "data" / "config.php").write_text(
        "<?php return ['env'=>'local','bridge_key'=>'" + "k" * 64 + "','local_key'=>'" + "M" * 64 + "'];",
        encoding="utf-8")
    dbfile = site / "data" / "planner.sqlite"
    con = sqlite3.connect(dbfile)
    con.executescript("""
        CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL,
            sort INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
            project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
            dur INTEGER NOT NULL DEFAULT 30,
            place TEXT NOT NULL DEFAULT 'dump',
            slot INTEGER, day TEXT, start INTEGER,
            done INTEGER NOT NULL DEFAULT 0, done_at TEXT,
            carried INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
        CREATE INDEX tasks_day ON tasks(day);
        CREATE TABLE attempts (ip TEXT NOT NULL, ts INTEGER NOT NULL);
        CREATE INDEX attempts_ts ON attempts(ts);
        CREATE TABLE cal_cache (day TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL);
        INSERT INTO projects (name, color, sort) VALUES
            ('Work', '#e9967a', 1), ('Personal', '#7fb7be', 2), ('Learning', '#9d8fd6', 3), ('Admin', '#b9b3a7', 4);
        UPDATE projects SET color = '#123456' WHERE name = 'Personal';
        INSERT INTO tasks (title, project_id, dur, place, day, start, created_at)
            VALUES ('Old task', 1, 45, 'also', '%s', 600, '2026-01-01 00:00:00');
        PRAGMA user_version = 1;
    """ % today)
    con.commit()
    con.close()
    php = subprocess.Popen(["php", "-S", f"127.0.0.1:{MIGRATE_PORT}", "-t", str(site), str(ROOT / "tools" / "router.php")],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        c = Client()
        c.base = f"http://127.0.0.1:{MIGRATE_PORT}"
        for _ in range(50):
            try:
                urllib.request.urlopen(c.base + "/", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        _, html, _ = c.raw("/?k=" + "M" * 64)
        c.csrf = re.search(r'name="csrf" content="([0-9a-f]+)"', html).group(1)
        status, st = c.api("state", day=today)
        check("migration: the old database still answers", status == 200, str(st)[:200])
        old = [x for x in st.get("tasks", []) if x["title"] == "Old task"]
        check("migration: the old task is still there, with empty notes and subtasks",
              len(old) == 1 and old[0]["notes"] == "" and old[0]["subs"] == [] and old[0]["dur"] == 45
              and old[0]["start"] == 600, str(old))
        colors = {p["name"]: p["color"] for p in st.get("projects", [])}
        check("migration: untouched starter colors become the brighter ones", colors.get("Work") == "#ff7a59"
              and colors.get("Learning") == "#a78bfa" and colors.get("Admin") == "#ffc83d", str(colors))
        check("migration: a hand-picked color is kept", colors.get("Personal") == "#123456", str(colors))
        status, r = c.api("task_update", {"id": old[0]["id"], "patch": {"notes": "hi", "subs": [{"title": "a", "done": False}]}})
        check("migration: notes and subtasks can be saved on the old task", status == 200 and r["task"]["notes"] == "hi"
              and len(r["task"]["subs"]) == 1, str(r))
        con = sqlite3.connect(dbfile)
        version = con.execute("PRAGMA user_version").fetchone()[0]
        con.close()
        check("migration: the database is now version 5", version == 5, str(version))
        con = sqlite3.connect(dbfile)
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        con.close()
        check("migration: the events table and the range cache exist", {"events", "cal_range_cache"} <= tables, str(tables))
        status, r = c.api("event_add", {"title": "After the upgrade", "from": today, "board": st["board"]})
        check("migration: an event can be added to the upgraded database", status == 200
              and r["event"]["title"] == "After the upgrade", str(r))
        _, st2 = c.api("state", day=today)
        check("migration: state lists it and the old task is untouched", [e["title"] for e in st2.get("events", [])] == ["After the upgrade"]
              and any(x["title"] == "Old task" and x["dur"] == 45 for x in st2["tasks"]), str(st2.get("events")))
        status, st = c.api("state", day=today)
        check("migration: exactly one board, named Main", status == 200 and len(st["boards"]) == 1
              and st["boards"][0]["name"] == "Main" and st["board"] == st["boards"][0]["id"], str(st.get("boards")))
        old = [x for x in st["tasks"] if x["title"] == "Old task"]
        check("migration: the old task is on that board", len(old) == 1 and old[0]["board"] == st["board"], str(old))
        con = sqlite3.connect(dbfile)
        n = con.execute("SELECT COUNT(*) FROM boards").fetchone()[0]
        con.close()
        check("migration: the boards table holds one row", n == 1, str(n))
    finally:
        php.terminate()


if __name__ == "__main__":
    main()
