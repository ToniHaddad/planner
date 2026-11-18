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
            run_touch(browser, problems)
            # the one deliberate wrong-password try in run() makes the browser log one 400; anything else is a problem
            expected = "Failed to load resource: the server responded with a status of 400 (Bad Request)"
            if expected in problems:
                problems.remove(expected)
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

    # --- subtasks and notes ---
    add(page, "Detail task")
    card = "#z-dump .task:has(.item:has-text('Detail task'))"
    more = "#z-dump .item:has-text('Detail task') [data-act=more]"
    check("the more button starts as three dots", page.locator(more).inner_text().strip() == "⋯")
    page.click(more)
    page.wait_for_selector(card + " .details")
    check("the more button opens a panel under the task", page.locator(card + " .details .subadd").count() == 1
          and page.locator(card + " .details .notes").count() == 1)
    sub_in = card + " .subadd"
    page.fill(sub_in, "Buy paint")
    page.press(sub_in, "Enter")
    page.locator(card + " .subs li").first.wait_for()
    page.keyboard.type("Sand the door")
    page.keyboard.press("Enter")
    for _ in range(30):
        if page.locator(card + " .subs li").count() == 2:
            break
        page.wait_for_timeout(100)
    check("two subtasks appear after two Enters", page.locator(card + " .subs li").count() == 2)
    check("the subtask box keeps the focus for the next one",
          page.evaluate("document.activeElement.classList.contains('subadd')")
          and page.locator(sub_in).input_value() == "")
    check("the more button counts subtasks: 0/2", page.locator(more).inner_text().strip() == "0/2")
    page.locator(card + " .subs li").first.locator("[data-act=sub-done]").click()
    page.locator(more + ":has-text('1/2')").wait_for()
    check("ticking a subtask moves the count to 1/2", page.locator(card + " .subs li.done").count() == 1)
    second = page.locator(card + " .subs li").nth(1)
    second.hover()
    second.locator("[data-act=sub-del]").click()
    page.locator(more + ":has-text('1/1')").wait_for()
    check("deleting a subtask leaves 1/1", page.locator(card + " .subs li").count() == 1
          and "Buy paint" in page.locator(card + " .subs li").inner_text())

    page.fill(sub_in, "<b>bold</b>")
    page.press(sub_in, "Enter")
    page.locator(card + " .subs li").nth(1).wait_for()
    check("markup typed as a subtask is shown as text", page.locator(card + " .details b").count() == 0
          and "<b>bold</b>" in page.locator(card + " .subs li").nth(1).inner_text())

    note = "Call Sam first\n<i>not italic</i> <img src=x onerror=alert(1)>"
    page.locator(card + " .notes").fill(note)
    page.wait_for_timeout(1200)                       # notes are saved 700 ms after the last keystroke
    check("typing notes puts a pen on the more button", "✎" in page.locator(more).inner_text()
          and page.locator(more).inner_text().strip() == "1/2 ✎", page.locator(more).inner_text())
    check("markup typed into notes creates no element", page.locator(card + " .details i, " + card + " .details img").count() == 0)
    page.reload()
    page.wait_for_selector("#top3 .slot")
    check("panels are closed again after a reload", page.locator("#z-dump .details").count() == 0)
    page.click(more)
    page.wait_for_selector(card + " .details")
    check("subtasks are still there after a reload", page.locator(card + " .subs li").count() == 2
          and page.locator(card + " .subs li.done").count() == 1)
    check("notes are still there after a reload", page.locator(card + " .notes").input_value() == note)
    check("the more button still shows count and pen", page.locator(more).inner_text().strip() == "1/2 ✎")
    check("markup in notes and subtasks is still plain text on reload", page.locator(card + " .details i, "
          + card + " .details b, " + card + " .details img").count() == 0)
    page.click("#z-dump .item:has-text('Detail task') [data-act=del]")
    page.wait_for_timeout(300)

    # --- two tasks at the same time ---
    add(page, "Twin task")
    tl_w = page.locator("#tl").bounding_box()["width"]
    drop_on_timeline(page, "#z-dump .item:has-text('Twin task')", 60)       # 08:00, where "Write the report" is
    twin = page.locator("#tl .blk[data-blk]:has-text('Twin task')")
    first = page.locator("#tl .blk[data-blk]:has-text('Write the report')")
    twin.wait_for()
    page.wait_for_timeout(300)
    check("both tasks sit on the timeline at the same time", twin.count() == 1 and first.count() == 1
          and "08:00" in twin.inner_text() and "08:00" in first.inner_text(), twin.inner_text() if twin.count() else "no twin")
    a, b = first.bounding_box(), twin.bounding_box()
    check("same-time blocks start at the same height", abs(a["y"] - b["y"]) < 3, f"{a['y']} vs {b['y']}")
    check("same-time blocks do not overlap sideways",
          a["x"] + a["width"] <= b["x"] + 1 or b["x"] + b["width"] <= a["x"] + 1, f"{a} {b}")
    check("same-time blocks are about half the timeline each",
          all(0.35 * tl_w < r["width"] < 0.6 * tl_w for r in (a, b)), f"{a['width']} {b['width']} of {tl_w}")
    page.click("#z-also .item:has-text('Twin task') [data-act=del]")
    page.wait_for_timeout(300)
    check("the twin is gone again", page.locator("#tl .blk[data-blk]").count() == 2)

    # --- theme ---
    check("the page starts dark", page.get_attribute("html", "data-theme") == "dark")
    page.click("[data-act=theme]")
    check("the sun button switches to light", page.get_attribute("html", "data-theme") == "light")
    page.reload()
    page.wait_for_selector("#top3 .slot")
    check("light stays after a reload", page.get_attribute("html", "data-theme") == "light")
    page.click("[data-act=theme]")
    check("the button switches back to dark", page.get_attribute("html", "data-theme") == "dark")
    page.reload()
    page.wait_for_selector("#top3 .slot")
    check("dark stays after a reload", page.get_attribute("html", "data-theme") == "dark")

    # --- Enter in the password form must not send the page away (one wrong try only: it counts toward the lockout) ---
    page.evaluate("window.__still_here = true")
    url = page.url
    page.click("[data-act=settings-open]")
    page.fill("#pw-cur", "not the password")
    page.fill("#pw-new", "a-new-long-password-1")
    page.press("#pw-new", "Enter")
    page.locator("#toast.on").wait_for()
    page.wait_for_timeout(500)
    check("Enter in the password form does not leave or reload the page",
          page.url == url and page.evaluate("window.__still_here === true") and page.locator("#tl").count() == 1)
    check("...and the wrong current password is reported", page.locator("#toast-msg").inner_text().strip() != ""
          and "changed" not in page.locator("#toast-msg").inner_text().lower(), page.locator("#toast-msg").inner_text())
    page.click("[data-act=settings-close]")


class Finger:
    """One finger on a phone screen, driven through Chromium's own touch input."""

    def __init__(self, page):
        self.page = page
        self.cdp = page.context.new_cdp_session(page)

    def send(self, kind, x=None, y=None):
        points = [] if x is None else [{"x": x, "y": y}]
        self.cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": points})

    def glide(self, x0, y0, x1, y1, steps=12):
        for i in range(1, steps + 1):
            self.send("touchMove", x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps)
            self.page.wait_for_timeout(16)

    def hold_and_drag(self, source, tx, ty, hold=420):
        """Press and hold `source`, then drag to the viewport point (tx, ty)."""
        b = self.page.locator(source).bounding_box()
        x0, y0 = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
        self.send("touchStart", x0, y0)
        self.page.wait_for_timeout(hold)
        self.glide(x0, y0, tx, ty)
        self.page.wait_for_timeout(60)
        self.send("touchEnd")
        self.page.wait_for_timeout(250)


def centre(page, selector):
    b = page.locator(selector).bounding_box()
    return b["x"] + b["width"] / 2, b["y"] + b["height"] / 2


def run_touch(browser, problems):
    """The same board on a phone: tasks are dragged by pressing and holding."""
    tall = browser.new_context(viewport={"width": 390, "height": 2600}, has_touch=True, is_mobile=True)
    page = tall.new_page()
    page.on("console", lambda m: problems.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: problems.append(str(e)))
    page.goto(T.BASE + "/")
    page.fill("input[name=username]", "alex")
    page.fill("input[name=password]", "correct horse battery")
    page.click("button[type=submit]")
    page.wait_for_selector("#top3 .slot")
    check("phone: the press-and-hold hint is shown", page.locator(".touch-only").is_visible())
    add(page, "Thumb task")
    add(page, "Swipe task")
    finger = Finger(page)
    item = "#z-dump .item:has-text('Thumb task')"

    # a quick swipe over a task must stay a scroll, not a drag
    x, y = centre(page, item + " .t")
    finger.send("touchStart", x, y)
    finger.glide(x, y, x, y + 300, steps=6)
    finger.send("touchEnd")
    page.wait_for_timeout(200)
    check("phone: a quick swipe does not move the task", page.locator(item).count() == 1
          and page.locator(".drag-clone").count() == 0)

    # press and hold, then drag into an empty slot of Today's 3
    empty = "#top3 .slot.empty"
    before = page.locator(empty).count()
    tx, ty = centre(page, empty + " >> nth=0")
    finger.hold_and_drag(item + " .t", tx, ty)
    check("phone: press, hold and drag into Today's 3", page.locator(empty).count() == before - 1
          and page.locator("#top3 .slot:has-text('Thumb task')").count() == 1
          and page.locator(".drag-clone").count() == 0)

    # from there onto a free hour of the timeline (19:00-20:00 is free in the test day)
    tl = page.locator("#tl").bounding_box()
    blocks = page.locator("#tl .blk[data-blk]").count()
    finger.hold_and_drag("#top3 .slot:has-text('Thumb task') .body", tl["x"] + tl["width"] / 2, tl["y"] + 12 * 52 + 4)
    check("phone: drag onto the timeline makes a block", page.locator("#tl .blk[data-blk]").count() == blocks + 1
          and "19:00" in page.locator("#tl .blk[data-blk]:has-text('Thumb task')").inner_text())

    # a drop on booked time is refused (the fake calendar has an event 10:00-11:00)
    finger.hold_and_drag("#z-dump .item:has-text('Swipe task') .t", tl["x"] + tl["width"] / 2, tl["y"] + 3 * 52 + 20)
    check("phone: a drop on booked time is refused", page.locator("#z-dump .item:has-text('Swipe task')").count() == 1
          and page.locator("#tl .blk[data-blk]").count() == blocks + 1)

    # make the block longer by pulling its bottom edge
    hx, hy = centre(page, "#tl .blk[data-blk]:has-text('Thumb task') .rs")
    blk = "#tl .blk[data-blk]:has-text('Thumb task')"
    h0 = page.locator(blk).bounding_box()["height"]
    finger.send("touchStart", hx, hy)
    finger.glide(hx, hy, hx, hy + 26, steps=8)       # 30 minutes longer
    finger.send("touchEnd")
    page.wait_for_timeout(300)
    h1 = page.locator(blk).bounding_box()["height"]
    check("phone: pulling the bottom edge changes the length", abs((h1 - h0) - 26) < 3, f"{h0} -> {h1}")
    page.reload()
    page.wait_for_selector(blk)
    check("phone: the new length is saved", abs(page.locator(blk).bounding_box()["height"] - h1) < 1)
    tall.close()

    # on a real phone-sized screen the lists are far apart: holding near the edge scrolls the page
    small = browser.new_context(viewport={"width": 390, "height": 740}, has_touch=True, is_mobile=True)
    page = small.new_page()
    page.on("pageerror", lambda e: problems.append(str(e)))
    page.goto(T.BASE + "/")
    page.fill("input[name=username]", "alex")
    page.fill("input[name=password]", "correct horse battery")
    page.click("button[type=submit]")
    page.wait_for_selector("#z-dump .item:has-text('Swipe task')")
    finger = Finger(page)
    x, y = centre(page, "#z-dump .item:has-text('Swipe task') .t")
    finger.send("touchStart", x, y)
    page.wait_for_timeout(420)
    finger.glide(x, y, x, 720)
    also = None
    for _ in range(200):                              # keep the finger at the bottom edge until "Also today" arrives
        finger.send("touchMove", x, 720)
        page.wait_for_timeout(30)
        box = page.locator("#z-also").bounding_box()
        if box and box["y"] + box["height"] / 2 < 600:
            also = box
            break
    scrolled = page.evaluate("window.scrollY")
    check("phone: holding a task at the bottom edge scrolls the page", scrolled > 100 and also is not None, str(scrolled))
    if also:
        finger.glide(x, 720, x, 400)                  # away from the edge: the page stops scrolling
        page.wait_for_timeout(100)
        also = page.locator("#z-also").bounding_box()
        finger.glide(x, 400, also["x"] + also["width"] / 2, also["y"] + also["height"] / 2)
        page.wait_for_timeout(60)
        finger.send("touchEnd")
        page.wait_for_timeout(300)
        check("phone: and the task can be dropped in a list that was off screen",
              page.locator("#z-also .item:has-text('Swipe task')").count() == 1)
    else:
        finger.send("touchEnd")
    small.close()


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).parent))
    main()
