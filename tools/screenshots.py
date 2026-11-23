"""Makes the screenshots used in the README and the landing page (docs/img/).

    python tools/screenshots.py

Starts a throwaway copy of the planner in local mode with a made-up day and a fake calendar,
then photographs it in headless Chromium (needs: pip install playwright; playwright install chromium).
Nothing here touches real data or Google.
"""
import http.server
import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
import test_api as T  # noqa: E402

OUT = ROOT / "docs" / "img"
PORT, BRIDGE_PORT = 8794, 8795
BASE = f"http://127.0.0.1:{PORT}"
KEY = "k" * 64

EVENTS = [
    {"title": "Team stand-up", "start": 9 * 60 + 30, "end": 10 * 60, "calendar": "Work"},
    {"title": "Lunch with Maya", "start": 12 * 60 + 30, "end": 13 * 60 + 30, "calendar": "Personal"},
    {"title": "Client call", "start": 15 * 60, "end": 16 * 60, "calendar": "Work"},
]
# Google events of other days, for the Calendar page: (days from today, timed events, all-day events)
RANGE_EVENTS = [
    (0, EVENTS, [{"title": "Maya's birthday", "calendar": "Personal"}]),
    (2, [{"title": "Dentist", "start": 8 * 60 + 30, "end": 9 * 60, "calendar": "Personal"}], []),
    (6, [{"title": "Quarterly review", "start": 14 * 60, "end": 15 * 60, "calendar": "Work"}], []),
    (9, [{"title": "Team stand-up", "start": 9 * 60 + 30, "end": 10 * 60, "calendar": "Work"}], []),
    (12, [], [{"title": "Public holiday", "calendar": "Holidays"}]),
    (-4, [{"title": "Client call", "start": 15 * 60, "end": 16 * 60, "calendar": "Work"}], []),
]


class Bridge(http.server.BaseHTTPRequestHandler):
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
        if q.get("action") == "ping":
            return self.send({"ok": True, "tz": "Europe/Paris", "calendars": ["Work", "Personal"]})
        if q.get("action") == "range":
            days = {}
            for n, timed, all_day in RANGE_EVENTS:
                d = (date.today() + timedelta(days=n)).isoformat()
                if q["from"] <= d <= q["to"]:
                    days[d] = {"events": timed, "allDay": all_day}
            return self.send({"ok": True, "tz": "Europe/Paris", "days": days})
        today = q.get("date") == date.today().isoformat()
        self.send({"ok": True, "tz": "Europe/Paris", "events": EVENTS if today else [],
                   "allDay": [{"title": "Maya's birthday", "calendar": "Personal"}] if today else []})


def seed(c):
    """Fills the board with a believable day. Projects 1-4 are Work, Personal, Learning, Admin."""
    today = date.today().isoformat()
    yesterday = (date.today() - timedelta(days=1)).isoformat()

    def add(title, project, **patch):
        _, r = c.api("task_add", {"title": title, "p": project})
        if patch:
            c.api("task_update", {"id": r["task"]["id"], "patch": patch})
        return r["task"]["id"]

    def sub(title, done=False):
        return {"title": title, "done": done}

    c.api("board_update", {"id": 1, "name": "Alex"})                      # three boards, so the buttons show
    c.api("board_add", {"name": "Sam"})
    c.api("board_add", {"name": "Studio"})
    add("Send the October invoice", 4, where="also", day=yesterday)       # becomes "carried"
    c.api("rollover", {"today": today})
    add("Reply to Sam about the workshop", 1)
    add("Book the dentist", 2, notes="Ask for a morning slot.")
    add("Read chapter 4 of the statistics book", 3)
    add("Renew car insurance", 4)
    report = add("Finish the quarterly report", 1, where="top", slot=0, day=today, start=10 * 60, dur=120,
                 subs=[sub("Pull the sales numbers", True), sub("Write the summary"), sub("Send to Dana for review")],
                 notes="Numbers are in the shared folder.")
    add("Water the plants", 2, where="also", day=today, start=18 * 60, dur=30)     # same time as the run
    add("Prepare slides for Thursday", 1, where="top", slot=1, day=today, start=13 * 60 + 30, dur=90)
    add("Run 5 km", 2, where="top", slot=2, day=today, start=18 * 60, dur=45)
    add("Review pull requests", 1, where="also", day=today, start=8 * 60, dur=60, done=True)
    add("Practise Spanish", 3, where="also", day=today, start=16 * 60 + 30, dur=30)
    add("Pay the electricity bill", 4, where="also", day=today, dur=15)
    later = lambda n: (date.today() + timedelta(days=n)).isoformat()
    add("Order the workshop materials", 1, where="top", slot=0, day=later(1))
    add("Confirm the caterer", 1, where="also", day=later(2))
    add("Pack the demo kit", 1, where="top", slot=0, day=later(3), start=9 * 60)
    add("Label the boxes", 4, where="also", day=later(7))

    def event(title, start_in, project, days=1, **more):
        c.api("event_add", dict({"title": title, "from": later(start_in), "to": later(start_in + days - 1), "p": project}, **more))

    event("Supplier visit", 0, 1, start=16 * 60 + 30, end=17 * 60 + 30, location="Main warehouse",
          subs=[sub("Print the order list", True), sub("Book a meeting room"), sub("Safety vests")])
    event("Design workshop", 3, 1, days=2, location="Riverside studio, room 2",
          subs=[sub("Book the room", True), sub("Send the invitations", True), sub("Order lunch"),
                sub("Print the handouts"), sub("Bring the projector")])
    event("Office move", 8, 4, location="12 Harbour Street",
          subs=[sub("Hire the van"), sub("Tell the post office"), sub("Pack the archive")])
    event("Volunteer training weekend for the new community kitchen team", 10, 2, days=2, location="Community hall")
    event("Trade fair", 15, 1, days=3, location="Exhibition centre, hall 4",
          subs=[sub("Stand booked", True), sub("Flyers", True)])
    return report


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="planner-shots-"))
    site = work / "public"
    shutil.copytree(ROOT / "public", site,
                    ignore=shutil.ignore_patterns("planner.sqlite*", "sessions", "config.php", "server.log"))
    (site / "data" / "config.php").write_text(
        "<?php return ['env'=>'local','bridge_key'=>'" + KEY + "','local_key'=>'" + KEY + "','allow_test_bridge'=>true];", encoding="utf-8")
    bridge = http.server.ThreadingHTTPServer(("127.0.0.1", BRIDGE_PORT), Bridge)
    threading.Thread(target=bridge.serve_forever, daemon=True).start()
    php = subprocess.Popen(["php", "-S", f"127.0.0.1:{PORT}", "-t", str(site), str(ROOT / "tools" / "router.php")],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(BASE + "/", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        c = T.Client()
        c.base = BASE
        c.csrf = re.search(r'name="csrf" content="([0-9a-f]+)"', c.raw("/?k=" + KEY)[1]).group(1)
        report = seed(c)

        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            for scheme in ("light", "dark"):
                ctx = browser.new_context(viewport={"width": 1320, "height": 950}, device_scale_factor=2, locale="en-GB")
                ctx.add_cookies([{"name": "planner_theme", "value": scheme, "url": BASE}])
                page = ctx.new_page()
                # Mid-morning, so the red "now" line shows on the timeline.
                page.clock.set_fixed_time(datetime.combine(date.today(), datetime.min.time()) + timedelta(hours=11, minutes=10))
                page.goto(BASE + "/?k=" + KEY)
                page.wait_for_selector("#top3 .slot")
                if scheme == "light":
                    page.click("[data-act=settings-open]")
                    for _ in range(50):
                        if "doGet" in page.input_value("#bridge-code"):
                            break
                        page.wait_for_timeout(100)
                    page.wait_for_timeout(300)
                    page.locator("#settings").screenshot(path=str(OUT / "calendar-setup.png"))
                    page.fill("#bridge-url", f"http://127.0.0.1:{BRIDGE_PORT}/exec")
                    page.click("[data-act=connect-cal]")
                    page.wait_for_selector("#tl .booked")
                    page.click("[data-act=settings-close]")
                else:
                    page.wait_for_selector("#tl .booked")
                page.click(f"#top3 [data-act=more][data-id='{report}']")      # show a task's subtasks and notes
                page.wait_for_selector("#top3 .details")
                page.wait_for_timeout(4200)          # let the "Connected" message fade
                page.mouse.move(5, 5)
                page.screenshot(path=str(OUT / f"board-{scheme}.png"))
                # the Calendar page: this month, with "Coming up" beside it
                page.click("[data-act=page][data-page=calendar]")
                page.wait_for_selector("#cal-grid .cell .ev")
                page.wait_for_selector("#cal-grid .gev")
                page.wait_for_selector("#up .up-row")
                page.wait_for_timeout(300)
                page.mouse.move(5, 5)
                page.screenshot(path=str(OUT / f"calendar-{scheme}.png"))
                ctx.close()
            browser.close()
    finally:
        php.terminate()
        bridge.shutdown()
        shutil.rmtree(work, ignore_errors=True)
    for f in sorted(OUT.glob("*.png")):
        print(f"{f.relative_to(ROOT)}  {f.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
