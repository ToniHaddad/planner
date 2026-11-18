"""Browser checks of the board in headless Chromium (needs: pip install playwright; playwright install chromium).

    python tests/test_browser.py [screenshot.png]

Uses the same throwaway local server and fake calendar bridge as test_api.py.
"""
import http.server
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

import test_api as T

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"ok   {name}")
    else:
        failed += 1
        print(f"FAIL {name} {detail}")


def main():
    shot = sys.argv[1] if len(sys.argv) > 1 else None
    work = Path(tempfile.mkdtemp(prefix="planner-browser-"))
    site = work / "public"
    shutil.copytree(T.ROOT / "public", site, ignore=shutil.ignore_patterns("planner.sqlite*", "sessions", "config.php"))
    key = "k" * 64
    T.Bridge.key = key
    hashed = subprocess.run(["php", "-r", 'echo password_hash("correct horse battery", PASSWORD_BCRYPT);'],
                            capture_output=True, check=True).stdout.decode()
    (site / "data" / "config.php").write_text(
        "<?php return ['env'=>'dev','username'=>'alex','password_hash'=>'" + hashed +
        "','cred_version'=>1,'bridge_key'=>'" + key + "','allow_test_bridge'=>true,"
        "'day_start'=>7];", encoding="utf-8")
    bridge = http.server.ThreadingHTTPServer(("127.0.0.1", T.BRIDGE_PORT), T.Bridge)
    threading.Thread(target=bridge.serve_forever, daemon=True).start()
    php = subprocess.Popen(["php", "-S", f"127.0.0.1:{T.PORT}", "-t", str(site)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(T.BASE + "/", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            page = browser.new_page(viewport={"width": 1400, "height": 1000})
            problems = []
            page.on("console", lambda m: problems.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: problems.append(str(e)))
            run(page)
            check("no console errors or blocked scripts", not problems, str(problems[:3]))
            if shot:
                page.screenshot(path=shot, full_page=True)
            browser.close()
    finally:
        php.terminate()
        bridge.shutdown()
        shutil.rmtree(work, ignore_errors=True)
    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


def add(page, title):
    page.fill("#new", title)
    page.press("#new", "Enter")
    page.wait_for_selector(f"#z-dump .item:has-text('{title}')")


def drop_on_timeline(page, source, minutes_from_start):
    """Drags a card to a time on the timeline (52 px per hour)."""
    box = page.locator("#tl").bounding_box()
    page.locator(source).drag_to(page.locator("#tl"),
                                 target_position={"x": box["width"] / 2, "y": minutes_from_start / 60 * 52 + 2})


def run(page):
    page.goto(T.BASE + "/")
    page.fill("input[name=username]", "alex")
    page.fill("input[name=password]", "correct horse battery")
    page.click("button[type=submit]")
    page.wait_for_selector("#top3 .slot")
    check("board shows after sign-in", page.locator("#top3 .slot.empty").count() == 3)

    check("Send to calendar stays hidden until a calendar is connected", not page.locator("#push").is_visible())
    add(page, "Throwaway")
    page.click("#z-dump .item:has-text('Throwaway') [data-act=del]")
    check("a deleted task leaves the list", page.locator("#z-dump .item").count() == 0)
    page.click("#toast-act")
    page.wait_for_selector("#z-dump .item:has-text('Throwaway')")
    check("Undo brings it back", page.locator("#z-dump .item:has-text('Throwaway')").count() == 1)
    page.click("#z-dump .item:has-text('Throwaway') [data-act=del]")
    page.wait_for_selector("#toast-act:visible")
    page.reload()
    page.wait_for_selector("#top3 .slot")
    check("without Undo the task stays deleted", page.locator("#z-dump .item").count() == 0)

    add(page, "Write the report")
    add(page, "Call the supplier")
    add(page, "<img src=x onerror=alert(1)>")
    check("typed tasks land in the brain dump", page.locator("#z-dump .item").count() == 3)
    check("markup in a title is shown as text", page.locator("#z-dump img").count() == 0)

    page.locator("#z-dump .item:has-text('Write the report')").drag_to(page.locator("#top3 .slot").nth(0))
    page.wait_for_selector("#top3 .slot:has-text('Write the report')")
    check("drag into Today's 3", page.locator("#top3 .slot.empty").count() == 2)

    drop_on_timeline(page, "#top3 .slot:has-text('Write the report')", 60)       # 08:00 when the day starts at 07:00
    page.wait_for_selector("#tl .blk[data-blk]")
    check("drag onto the timeline makes a block at 08:00",
          "08:00–08:30" in page.locator("#tl .blk[data-blk]").inner_text())

    # connect the (fake) calendar through the settings dialog
    page.click("[data-act=settings-open]")
    for _ in range(50):                      # the page's CSP forbids eval-style waits, so poll from here
        if "doGet" in page.input_value("#bridge-code"):
            break
        page.wait_for_timeout(100)
    check("settings shows the bridge script with its key", "k" * 64 in page.input_value("#bridge-code"))
    page.fill("#bridge-url", f"http://127.0.0.1:{T.BRIDGE_PORT}/exec")
    page.click("[data-act=connect-cal]")
    page.wait_for_selector("#tl .booked")
    check("settings switch to the connected view", page.locator("#cal-on").is_visible()
          and not page.locator("#cal-setup").is_visible() and "Main, Outlook" in page.locator("#cal-state").inner_text())
    page.click("[data-act=settings-close]")
    check("Send to calendar appears once connected", page.locator("#push").is_visible())
    check("calendar event shows as a booked block", "Team <b>call</b>" in page.locator("#tl .booked").inner_text()
          and page.locator("#tl .booked b").count() == 0)
    check("all-day event shows as a chip", "Holiday" in page.locator("#allday").inner_text())

    drop_on_timeline(page, "#z-dump .item:has-text('Call the supplier')", 190)   # 10:10, inside the 10:00-11:00 event
    page.wait_for_timeout(400)
    check("a drop on booked time is refused", page.locator("#tl .blk[data-blk]").count() == 1
          and "Booked" in page.locator("#toast").inner_text())

    drop_on_timeline(page, "#z-dump .item:has-text('Call the supplier')", 300)   # 12:00
    page.locator("#tl .blk[data-blk]").nth(1).wait_for()
    check("a drop on free time works and moves the task to Also today",
          page.locator("#z-also .item:has-text('Call the supplier')").count() == 1)

    page.locator("#top3 .check").first.click()
    page.wait_for_selector("#top3 .slot.done")
    check("main task can be ticked off", page.locator("#tl .blk.done").count() == 1)

    page.click("[data-act=push]")
    page.locator("#toast:has-text('sent')").wait_for()
    check("send to calendar pushes both blocks", len(T.pushed) >= 1 and len(T.pushed[-1]["blocks"]) == 2)

    page.reload()
    page.wait_for_selector("#tl .booked")
    check("everything is still there after a reload", page.locator("#tl .blk[data-blk]").count() == 2
          and page.locator("#top3 .slot.done").count() == 1 and page.locator("#z-dump .item").count() == 1)

    page.click("[data-act=next]")
    page.locator("#dayname:has-text('Tomorrow')").wait_for()
    page.wait_for_timeout(500)
    check("tomorrow starts empty but keeps the brain dump", page.locator("#tl .blk[data-blk]").count() == 0
          and page.locator("#z-dump .item").count() == 1)
    page.click("[data-act=today]")
    page.locator("#tl .blk[data-blk]").nth(1).wait_for()


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).parent))
    main()
