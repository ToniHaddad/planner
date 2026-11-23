"""Browser checks of the board in headless Chromium (needs: pip install playwright; playwright install chromium).

    python tests/test_browser.py [screenshot.png]

Uses the same throwaway local server and fake calendar bridge as test_api.py.
"""
import http.server
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from datetime import date, timedelta
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
        "'day_start'=>7,'sync_delay_ms'=>400];", encoding="utf-8")       # a short wait before an automatic sync
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
            run_phone_calendar(browser, problems)
            run_touch_events(browser, problems)
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
    page.wait_for_selector("#tl .gcal")
    check("settings switch to the connected view", page.locator("#cal-on").is_visible()
          and not page.locator("#cal-setup").is_visible() and "Main, Outlook" in page.locator("#cal-state").inner_text())
    page.click("[data-act=settings-close]")
    check("Send to calendar appears once connected", page.locator("#push").is_visible())
    gblk = page.locator("#tl .gcal")
    check("a calendar event shows on the timeline with a calendar mark, its title as text",
          "Team <b>call</b>" in gblk.inner_text() and page.locator("#tl .gcal b").count() == 0
          and page.locator("#tl .gcal .gmark").count() == 1 and "🔒" not in gblk.inner_text())
    check("...as a plain block, not striped and not locked",
          gblk.evaluate("e => getComputedStyle(e).backgroundImage") == "none"
          and gblk.evaluate("e => getComputedStyle(e).cursor") == "pointer" and gblk.get_attribute("draggable") is None)
    check("all-day event shows as a chip", "Holiday" in page.locator("#allday").inner_text())

    drop_on_timeline(page, "#z-dump .item:has-text('Call the supplier')", 190)   # 10:15, while the 10:00-11:00 event is on
    beside = page.locator("#tl .blk[data-blk]:has-text('Call the supplier')")
    beside.wait_for()
    page.wait_for_timeout(300)
    a, b = beside.bounding_box(), gblk.bounding_box()
    check("a task dropped at the time of a calendar event is accepted, in Also today", "10:15" in beside.inner_text()
          and page.locator("#z-also .item:has-text('Call the supplier')").count() == 1, beside.inner_text())
    check("...and sits beside the event", a["x"] >= b["x"] + b["width"] - 1 or a["x"] + a["width"] <= b["x"] + 1, f"{a} {b}")

    page.locator("#top3 .check").first.click()
    page.wait_for_selector("#top3 .slot.done")
    check("main task can be ticked off", page.locator("#tl .blk.done").count() == 1)

    page.click("[data-act=push]")
    page.locator("#toast:has-text('Google Calendar is up to date')").wait_for()
    sent = [it["title"] for it in T.Bridge.synced[-1]["boards"][0]["items"]] if T.Bridge.synced else []
    check("Send to calendar brings Google up to date, the ticked block marked",
          {"✓ Write the report", "Call the supplier"} <= set(sent)
          and re.match(r"Google Calendar is up to date: \d+ added, \d+ changed, \d+ removed\.$", page.locator("#toast-msg").inner_text()),
          str(sent) + page.locator("#toast-msg").inner_text())

    page.reload()
    page.wait_for_selector("#tl .gcal")
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

    run_sub_rename(page)
    run_sub_reorder(page)
    run_boards(page)
    run_events(page)
    run_google(page)
    run_repeat_remind(page)


def run_sub_rename(page):
    """A subtask is renamed by double-clicking it. Uses its own task and deletes it afterwards."""
    add(page, "Rename host")
    item = "#z-dump .task:has(.item:has-text('Rename host'))"
    page.click(item + " [data-act=more]")
    for title in ("First step", "Second step"):
        page.fill(item + " .subadd", title)
        page.press(item + " .subadd", "Enter")
    page.locator(item + " .subs li").nth(1).wait_for()
    page.click(item + " .subs li >> nth=1 >> [data-act=sub-done]")
    page.dblclick(item + " .subs li >> nth=1 >> span")
    box = page.locator(item + " .subs input.edit")
    check("subtasks: a double-click turns the title into a box holding it", box.input_value() == "Second step")
    box.fill("Second <b>step</b>, renamed")
    box.press("Enter")
    page.wait_for_selector(item + " .subs li:has-text('renamed')")
    check("subtasks: the new name shows, as text, and the tick is kept",
          page.locator(item + " .subs li").nth(1).inner_text().strip().startswith("✓")
          and "Second <b>step</b>, renamed" in page.locator(item + " .subs li").nth(1).inner_text()
          and page.locator(item + " .subs b").count() == 0
          and page.locator(item + " .subs li.done").count() == 1
          and "First step" in page.locator(item + " .subs li").nth(0).inner_text())
    page.dblclick(item + " .subs li >> nth=0 >> span")
    page.locator(item + " .subs input.edit").fill("Thrown away")
    page.locator(item + " .subs input.edit").press("Escape")
    check("subtasks: Escape leaves the name as it was", "First step" in page.locator(item + " .subs li").nth(0).inner_text())
    page.wait_for_timeout(400)
    page.reload()
    page.wait_for_selector(item)
    page.click(item + " [data-act=more]")
    check("subtasks: the new name is saved", "renamed" in page.locator(item + " .subs li").nth(1).inner_text()
          and "First step" in page.locator(item + " .subs li").nth(0).inner_text())
    page.click(item + " .item [data-act=del]")
    page.wait_for_timeout(300)


def run_sub_reorder(page):
    """Subtasks are dragged into a new order. Uses its own task and deletes it afterwards."""
    add(page, "Order host")
    item = "#z-dump .task:has(.item:has-text('Order host'))"
    page.click(item + " [data-act=more]")
    for title in ("Alpha", "Bravo", "Charlie"):
        page.fill(item + " .subadd", title)
        page.press(item + " .subadd", "Enter")
    rows = page.locator(item + " .subs li")
    rows.nth(2).wait_for()
    page.click(item + " .subs li >> nth=0 >> [data-act=sub-done]")

    def order():
        return [t.strip().lstrip("✓").rstrip("×").strip() for t in rows.all_inner_texts()]

    box = rows.nth(2).bounding_box()
    rows.nth(0).drag_to(rows.nth(2), target_position={"x": box["width"] / 2, "y": box["height"] - 2})
    page.wait_for_timeout(300)
    check("subtasks: dragging the first below the last moves it to the end, tick and all",
          order() == ["Bravo", "Charlie", "Alpha"] and "done" in (rows.nth(2).get_attribute("class") or ""), str(order()))
    rows.nth(2).drag_to(rows.nth(1), target_position={"x": box["width"] / 2, "y": 2})
    page.wait_for_timeout(300)
    check("subtasks: dragging onto the top half of a row puts it before that row", order() == ["Bravo", "Alpha", "Charlie"], str(order()))
    page.wait_for_timeout(300)
    page.reload()
    page.wait_for_selector(item)
    page.click(item + " [data-act=more]")
    rows = page.locator(item + " .subs li")
    check("subtasks: the new order is saved", order() == ["Bravo", "Alpha", "Charlie"], str(order()))
    check("subtasks: a subtask dragged onto the task lists changes nothing",
          page.locator("#z-dump .item:has-text('Order host')").count() == 1)
    page.click(item + " .item [data-act=del]")
    page.wait_for_timeout(300)


def run_boards(page):
    """Boards: tabs appear with two boards, each board has its own lists, a task can be dragged to another board."""
    page.reload()
    page.wait_for_selector("#top3 .slot")
    check("boards: with one board the tabs are hidden", not page.locator("#tabs").is_visible())
    dump_before = page.locator("#z-dump .item").count()
    check("boards: the first board has a task to tell it apart by", dump_before >= 1)

    page.click("[data-act=settings-open]")
    page.click("[data-act=add-board]")
    for _ in range(50):
        if page.locator("[data-bname]").count() == 2:
            break
        page.wait_for_timeout(100)
    check("boards: add-board focuses the new board's name input",
          page.evaluate("document.activeElement.dataset.bname !== undefined")
          and page.evaluate("document.activeElement.value") == "New board")
    page.keyboard.press("Control+A")
    page.keyboard.type("Errands")
    page.keyboard.press("Tab")
    page.locator("#tabs .tab:has-text('Errands')").wait_for()
    check("boards: two boards show two tab buttons", page.locator("#tabs").is_visible()
          and page.locator("#tabs .tab").count() == 2, str(page.locator("#tabs").inner_text()))
    check("boards: the first tab is the current one", "on" in page.locator("#tabs .tab").nth(0).get_attribute("class").split()
          and "on" not in page.locator("#tabs .tab").nth(1).get_attribute("class").split())
    check("boards: the new board has the name that was typed", page.locator("#tabs .tab").nth(1).inner_text().strip() == "Errands")
    page.click("[data-act=settings-close]")

    # the second board is empty and separate
    page.locator("#tabs .tab").nth(1).click()
    page.locator("#tabs .tab.on:has-text('Errands')").wait_for()
    page.wait_for_timeout(400)
    check("boards: the second tab becomes current", page.locator("#tabs .tab").nth(1).get_attribute("class").split().count("on") == 1
          and page.locator("#tabs .tab.on").count() == 1)
    check("boards: the second board's brain dump is empty", page.locator("#z-dump .item").count() == 0
          and page.locator("#tl .blk[data-blk]").count() == 0 and page.locator("#top3 .slot.empty").count() == 3)
    add(page, "Errand one")
    add(page, "Errand two")
    page.locator("#tabs .tab").nth(0).click()
    page.locator("#tabs .tab.on:has-text('Main')").wait_for()
    page.wait_for_timeout(400)
    check("boards: the errands are not on the first board", page.locator("#z-dump .item:has-text('Errand')").count() == 0)
    check("boards: the first board's tasks are back", page.locator("#z-dump .item").count() == dump_before
          and page.locator("#tl .blk[data-blk]").count() == 2 and page.locator("#top3 .slot.done").count() == 1)

    # the choice is remembered
    page.locator("#tabs .tab").nth(1).click()
    page.locator("#tabs .tab.on:has-text('Errands')").wait_for()
    page.reload()
    page.wait_for_selector("#top3 .slot")
    page.locator("#z-dump .item:has-text('Errand one')").wait_for()
    check("boards: after a reload the last chosen board is still shown",
          page.locator("#tabs .tab.on").inner_text().strip() == "Errands" and page.locator("#z-dump .item").count() == 2)

    # drag a task onto the other board's tab
    page.locator("#z-dump .item:has-text('Errand two')").drag_to(page.locator("#tabs .tab").nth(0))
    page.wait_for_selector("#toast.on:has-text('Moved to')")
    check("boards: dragging a task onto a tab says it moved", "Moved to Main" in page.locator("#toast").inner_text(),
          page.locator("#toast").inner_text())
    check("boards: the dragged task left this list", page.locator("#z-dump .item:has-text('Errand two')").count() == 0
          and page.locator("#z-dump .item:has-text('Errand one')").count() == 1)
    page.locator("#tabs .tab").nth(0).click()
    page.locator("#tabs .tab.on:has-text('Main')").wait_for()
    page.locator("#z-dump .item:has-text('Errand two')").wait_for()
    check("boards: ...and it is in the other board's brain dump", page.locator("#z-dump .item:has-text('Errand two')").count() == 1
          and page.locator("#z-dump .item").count() == dump_before + 1)
    page.click("#z-dump .item:has-text('Errand two') [data-act=del]")
    page.wait_for_timeout(300)

    # markup in a board name is plain text
    page.click("[data-act=settings-open]")
    name_box = page.locator("[data-bname]").nth(1)
    name_box.fill("<b>x</b>")
    name_box.press("Tab")
    page.locator("#tabs .tab:has-text('<b>x</b>')").wait_for()
    check("boards: markup in a board name is shown as text", page.locator("#tabs b").count() == 0
          and page.locator("#tabs .tab").nth(1).inner_text().strip() == "<b>x</b>")
    page.reload()
    page.wait_for_selector("#top3 .slot")
    check("boards: ...also after a reload", page.locator("#tabs b").count() == 0
          and page.locator("#tabs .tab:has-text('<b>x</b>')").count() == 1)

    # delete the second board: its task goes to the first board's brain dump
    page.click("[data-act=settings-open]")
    check("boards: each board has a delete button when there are two", page.locator("[data-act=del-board]").count() == 2)
    page.once("dialog", lambda d: d.accept())
    page.locator("#boards .proj").nth(1).hover()
    page.locator("[data-act=del-board]").nth(1).click()
    for _ in range(50):
        if not page.locator("#tabs").is_visible():
            break
        page.wait_for_timeout(100)
    check("boards: with one board left the tabs are hidden again", not page.locator("#tabs").is_visible())
    check("boards: the last board has no delete button", page.locator("[data-act=del-board]").count() == 0 and page.locator("[data-bname]").count() == 1,
          str(page.locator("#boards").inner_html()))
    page.click("[data-act=settings-close]")
    page.locator("#z-dump .item:has-text('Errand one')").wait_for()
    check("boards: the deleted board's task is now in the first board's brain dump",
          page.locator("#z-dump .item:has-text('Errand one')").count() == 1
          and page.locator("#z-dump .item").count() == dump_before + 1)
    page.click("#z-dump .item:has-text('Errand one') [data-act=del]")
    page.wait_for_timeout(300)
    check("boards: the board is back to how it started", page.locator("#z-dump .item").count() == dump_before
          and page.locator("#tl .blk[data-blk]").count() == 2)


def wait_until(page, fn, tries=50):
    """Polls from here (the page's CSP forbids eval-style waits)."""
    for _ in range(tries):
        if fn():
            return True
        page.wait_for_timeout(100)
    return False


def new_event(page, opener, title, start=None, end=None, location="", subs=(), day_from=None, day_to=None):
    """Fills the event dialog opened by `opener` and saves it."""
    page.click(opener)
    page.wait_for_selector("#event-dlg[open]")
    page.fill("#ev-title", title)
    if day_from:
        page.fill("#ev-from", day_from)
        page.dispatch_event("#ev-from", "change")
    if day_to:
        page.fill("#ev-to", day_to)
    if start:
        page.uncheck("#ev-allday")
        page.fill("#ev-start", start)
        page.fill("#ev-end", end)
    page.fill("#ev-loc", location)
    for s in subs:
        page.fill("#ev-subadd", s)
        page.press("#ev-subadd", "Enter")
    page.click("#ev-save")
    page.wait_for_selector("#event-dlg", state="hidden")


def run_events(page):
    """Events on the Day page and the Calendar page. Leaves the Day page showing, in month view."""
    today = date.today()
    iso = lambda d: d.isoformat()
    page.reload()
    page.wait_for_selector("#top3 .slot")
    blocks = page.locator("#tl .blk[data-blk]").count()

    # --- the Day page: the row above the timeline ---
    check("events: the + Event button shows even on a day without events",
          page.locator("#allday [data-act=event-new]").is_visible() and page.locator("#allday .chip.own").count() == 0)
    page.click("#allday [data-act=event-new]")
    page.wait_for_selector("#event-dlg[open]")
    check("events: the dialog opens for a new all-day event on this day",
          page.locator("#ev-head").inner_text() == "New event" and page.input_value("#ev-from") == iso(today)
          and page.input_value("#ev-to") == iso(today) and page.is_checked("#ev-allday")
          and not page.locator("#ev-del").is_visible() and not page.locator("#ev-times").is_visible())
    check("events: the dialog's boxes do not look like login fields", page.locator("#event-dlg input[autocomplete=off]").count() >= 6
          and page.locator("#event-dlg input[type=password], #event-dlg [autocomplete=username]").count() == 0)
    page.click("#ev-save")
    check("events: saving without a title says why and keeps the dialog open",
          page.locator("#ev-error").inner_text() == "An event needs a title" and page.locator("#event-dlg[open]").count() == 1)
    page.fill("#ev-title", "Thrown away")
    page.keyboard.press("Escape")
    page.wait_for_selector("#event-dlg", state="hidden")
    page.wait_for_timeout(300)
    check("events: Escape closes the dialog without saving", page.locator("#allday .chip.own").count() == 0)

    new_event(page, "#allday [data-act=event-new]", "Site visit <b>x</b>", location="<i>Depot</i>",
              subs=["Hire <b>van</b>", "Keys"])
    chip = "#allday .chip.own:has-text('Site visit')"
    page.wait_for_selector(chip)
    check("events: an all-day event added from the Day page shows as a chip",
          "Site visit <b>x</b> · <i>Depot</i>" in page.locator(chip).inner_text() and "0/2" in page.locator(chip).inner_text(),
          page.locator(chip).inner_text())
    check("events: markup in its title and place is shown as text", page.locator("#allday i").count() == 0
          and page.locator(chip + " b").count() == 1)
    check("events: an own event never blocks the timeline", page.locator("#tl .blk[data-blk]").count() == blocks)

    # edit: tick, rename, save
    page.click(chip)
    page.wait_for_selector("#event-dlg[open]")
    check("events: clicking the chip opens it for editing", page.locator("#ev-head").inner_text() == "Edit event"
          and page.input_value("#ev-title") == "Site visit <b>x</b>" and page.locator("#ev-subs li").count() == 2
          and page.locator("#ev-del").is_visible())
    check("events: markup in the checklist is text in the dialog", page.locator("#ev-subs b").count() == 0
          and "Hire <b>van</b>" in page.locator("#ev-subs li").nth(0).inner_text())
    page.click("#ev-subs li >> nth=0 >> [data-act=evsub-done]")
    page.dblclick("#ev-subs li >> nth=1 >> span")
    page.fill("#ev-subs input.edit", "Keys and badges")
    page.press("#ev-subs input.edit", "Enter")
    check("events: a thing to arrange is renamed by double-clicking it, and the dialog stays open",
          "Keys and badges" in page.locator("#ev-subs li").nth(1).inner_text() and page.locator("#event-dlg[open]").count() == 1)
    page.click("#ev-save")
    page.wait_for_selector("#event-dlg", state="hidden")
    page.wait_for_selector(chip + ":has-text('1/2')")
    check("events: the edit is saved: the chip counts 1/2", "1/2" in page.locator(chip).inner_text())

    # a timed event
    page.click("#allday [data-act=event-new]")
    page.wait_for_selector("#event-dlg[open]")
    page.uncheck("#ev-allday")
    check("events: unticking All day shows the times and ties the end date to the start",
          page.locator("#ev-times").is_visible() and page.locator("#ev-to").is_disabled())
    page.fill("#ev-title", "Supplier call")
    page.fill("#ev-start", "15:00")
    page.fill("#ev-end", "14:00")
    page.click("#ev-save")
    check("events: an end before the start is refused in the dialog",
          page.locator("#ev-error").inner_text() == "The end time must be after the start time")
    page.fill("#ev-start", "14:00")
    page.fill("#ev-end", "15:00")
    page.click("#ev-save")
    page.wait_for_selector("#event-dlg", state="hidden")
    timed = "#allday .chip.own:has-text('Supplier call')"
    page.wait_for_selector(timed)
    check("events: a timed event shows its time first", page.locator(timed).inner_text().startswith("14:00–15:00 Supplier call"),
          page.locator(timed).inner_text())
    check("events: ...and adds no block to the timeline", page.locator("#tl .blk[data-blk]").count() == blocks)

    # delete, undo, delete
    page.click(timed)
    page.wait_for_selector("#event-dlg[open]")
    page.click("#ev-del")
    page.wait_for_selector("#toast.on:has-text('Event deleted')")
    check("events: a deleted event leaves the row at once", page.locator(timed).count() == 0)
    page.click("#toast-act")
    page.wait_for_selector(timed)
    check("events: Undo brings it back, time and all", page.locator(timed).inner_text().startswith("14:00–15:00"))
    page.click(timed)
    page.wait_for_selector("#event-dlg[open]")
    page.click("#ev-del")
    page.wait_for_selector("#toast.on:has-text('Event deleted')")
    page.reload()
    page.wait_for_selector(chip)
    check("events: without Undo it stays deleted", page.locator(timed).count() == 0 and page.locator(chip).count() == 1)

    # --- the Calendar page ---
    page.click("[data-act=page][data-page=calendar]")
    page.wait_for_selector("#cal-grid .cell")
    check("calendar: the switch shows the Calendar page and hides the Day page",
          page.locator("#cal").is_visible() and not page.locator(".cols").is_visible()
          and "on" in page.get_attribute("[data-page=calendar]", "class").split())
    check("calendar: the heading names the month; free time is hidden, Send to calendar stays",
          page.locator("#dayname").inner_text() == today.strftime("%B %Y") and not page.locator("#free").is_visible()
          and page.locator("#push").is_visible(), page.locator("#dayname").inner_text())
    page.reload()
    page.wait_for_selector("#cal-grid .cell")
    check("calendar: the page choice is kept after a reload", page.locator("#cal").is_visible() and not page.locator(".cols").is_visible())
    cells = page.locator("#cal-grid .cell").count()
    check("calendar: the month grid has whole weeks (5 or 6)", cells in (35, 42), str(cells))
    page.wait_for_selector(f".cell[data-cday='{iso(today)}'] .gev")
    check("calendar: today is marked and holds the Google events, as text",
          page.locator(f".cell.today[data-cday='{iso(today)}']").count() == 1
          and "Holiday" in page.locator(f".cell[data-cday='{iso(today)}']").inner_text()
          and page.locator("#cal-grid .gev b:has-text('Team')").count() == 0)
    check("calendar: today's own event shows, its markup as text",
          page.locator(f".cell[data-cday='{iso(today)}'] .ev:has-text('Site visit <b>x</b>')").count() == 1
          and page.locator("#cal-grid .ev b:has-text('x')").count() == 0)

    # a multi-day event from the + Event button
    first = date(today.year, today.month, 10)
    d = lambda n: iso(first + timedelta(days=n))
    new_event(page, ".cal-bar [data-act=event-new]", "Workshop", location="Hall 2", day_from=d(0), day_to=d(2),
              subs=["Room", "Lunch"])
    page.wait_for_selector(f".cell[data-cday='{d(0)}'] .ev:has-text('Workshop')")
    on = lambda day: page.locator(f".cell[data-cday='{day}'] .ev:has-text('Workshop')").count() == 1
    check("calendar: a three-day event shows on each of its days and no other",
          on(d(0)) and on(d(1)) and on(d(2)) and not on(d(-1)) and not on(d(3)))
    check("calendar: it reads as one bar: flat ends where it goes on",
          "cont-r" in page.get_attribute(f".cell[data-cday='{d(0)}'] .ev", "class")
          and "cont-l" in page.get_attribute(f".cell[data-cday='{d(2)}'] .ev", "class"))

    # drag it to another day: the day grabbed lands where it is let go
    page.locator(f".cell[data-cday='{d(0)}'] .ev:has-text('Workshop')").drag_to(page.locator(f".cell[data-cday='{d(7)}']"))
    page.wait_for_selector(f".cell[data-cday='{d(9)}'] .ev:has-text('Workshop')")
    check("calendar: dragging an event to another day moves it and keeps its length",
          on(d(7)) and on(d(8)) and on(d(9)) and not on(d(0)) and not on(d(10)) and page.locator("#event-dlg[open]").count() == 0)
    page.wait_for_timeout(300)
    page.reload()
    page.wait_for_selector(f".cell[data-cday='{d(9)}'] .ev:has-text('Workshop')")
    check("calendar: the move is saved", on(d(7)) and not on(d(0)))

    # a click on a free part of a day opens a new event on that day
    free = d(4) if d(4) != iso(today) else d(5)
    page.locator(f".cell[data-cday='{free}']").click(position={"x": 60, "y": 80})
    page.wait_for_selector("#event-dlg[open]")
    check("calendar: clicking a free part of a day opens a new event on that day", page.input_value("#ev-from") == free
          and page.locator("#ev-head").inner_text() == "New event")
    page.click("#event-dlg [data-act=event-close] >> nth=1")
    page.wait_for_selector("#event-dlg", state="hidden")

    # the day number opens the Day page on that date
    page.click(f".cell[data-cday='{d(8)}'] .dnum")
    page.wait_for_selector(".cols:visible")
    page.wait_for_selector("#allday .chip.own:has-text('Workshop')")
    check("calendar: a day number opens the Day page on that date",
          page.locator("#daydate").inner_text() == (first + timedelta(days=8)).strftime("%B ") + str((first + timedelta(days=8)).day)
          and not page.locator("#cal").is_visible(), page.locator("#daydate").inner_text())
    check("events: on the Day page a multi-day event says which day it is",
          "day 2 of 3" in page.locator("#allday .chip.own:has-text('Workshop')").inner_text()
          and "Hall 2" in page.locator("#allday .chip.own:has-text('Workshop')").inner_text())
    page.click("[data-act=today]")
    page.wait_for_selector(chip)

    # the week view
    page.click("[data-act=page][data-page=calendar]")
    page.click("[data-act=cal-view][data-view=week]")
    page.wait_for_selector("#cal-grid .wday")
    wk = f".wday[data-cday='{iso(today)}']"
    page.wait_for_selector(wk + " .wtask")
    check("calendar: the week view shows seven days, Monday first", page.locator("#cal-grid .wday").count() == 7
          and date.fromisoformat(page.get_attribute("#cal-grid .wday >> nth=0", "data-cday")).weekday() == 0)
    check("calendar: the week lists the day's planned tasks, Today's 3 first with their number, done ones struck through",
          "Write the report" in page.locator(wk + " .wtask").nth(0).inner_text()
          and page.locator(wk + " .wtask").nth(0).locator("b").inner_text() == "1"
          and "done" in page.get_attribute(wk + " .wtask >> nth=0", "class")
          and "Call the supplier" in page.locator(wk + " .wtask").nth(1).inner_text())
    site = page.locator(wk + " .ev:has-text('Site visit')")
    check("calendar: the week shows an event's place and checklist", "<i>Depot</i>" in site.inner_text()
          and "To arrange 1/2" in site.inner_text(), site.inner_text())
    monday = today - timedelta(days=today.weekday())
    head = page.locator("#dayname").inner_text()
    check("calendar: the heading names the week", head != today.strftime("%B %Y") and str(monday.day) in head
          and str((monday + timedelta(days=6)).day) in head, head)
    page.reload()
    page.wait_for_selector("#cal-grid .wday")
    check("calendar: the week view is kept after a reload", page.locator("#cal-grid .wday").count() == 7)
    page.click("[data-act=cal-view][data-view=month]")
    page.wait_for_selector("#cal-grid .cell")

    # Coming up: countdown, progress, and ticking things off
    later = iso(today + timedelta(days=5))
    new_event(page, ".cal-bar [data-act=event-new]", "Later thing", day_from=later, subs=["Tickets"])
    row = "#up .up-row:has-text('Site visit')"
    page.wait_for_selector("#up .up-row:has-text('Later thing')")
    check("coming up: an event of today says today, with its place and progress",
          page.locator(row + " .up-when").inner_text() == "today" and "<i>Depot</i>" in page.locator(row).inner_text()
          and "1/2" in page.locator(row + " .up-prog").inner_text() and page.locator(row + " .ok").count() == 0)
    check("coming up: a later one counts the days", page.locator("#up .up-row:has-text('Later thing') .up-when").inner_text() == "in 5 days")
    check("coming up: what is still to arrange is listed, as text", page.locator(row + " .up-todo li").count() == 1
          and "Keys and badges" in page.locator(row + " .up-todo").inner_text()
          and page.locator("#up b, #up .up-title i, #up .up-loc i").count() == 0)
    page.click(row + " [data-act=up-tick]")
    page.wait_for_selector(row + " .ok")
    check("coming up: ticking it off there moves the progress to 2/2 with a tick",
          "2/2" in page.locator(row + " .up-prog").inner_text() and page.locator(row + " .up-todo").count() == 0)
    page.wait_for_timeout(400)
    page.reload()
    page.wait_for_selector(row)
    check("coming up: the tick survives a reload", "2/2" in page.locator(row + " .up-prog").inner_text()
          and page.locator(row + " .ok").count() == 1)

    # an older calendar script: a hint on the page and update steps in Settings
    T.Bridge.knows_range = False
    page.click("#calstat [data-act=refresh-cal]")
    page.wait_for_selector("#cal-note:visible")
    check("calendar: with an older script the page says how to update it", page.locator("#cal-note").inner_text()
          == "Update the calendar script to get Google events on this page, reminders and one Google calendar per board: Settings › Google Calendar.")
    page.click("#cal-note [data-act=settings-update]")
    wait_until(page, lambda: "doGet" in page.input_value("#bridge-code"))
    check("calendar: Settings opens on the update steps, with the script ready to copy",
          page.locator("#cal-update[open]").count() == 1 and page.locator("#cal-old").is_visible()
          and page.locator("#cal-update [data-act=copy-code]").is_visible() and "k" * 64 in page.input_value("#bridge-code"))
    page.click("[data-act=settings-close]")
    T.Bridge.knows_range = True
    page.click("#calstat [data-act=refresh-cal]")
    page.wait_for_selector("#cal-note", state="hidden")
    check("calendar: once updated the hint goes away", not page.locator("#cal-note").is_visible())

    # back to the Day page for what follows
    page.click("[data-act=page][data-page=day]")
    page.wait_for_selector(".cols:visible")
    page.wait_for_selector(chip)
    check("events: back on the Day page the chip shows the ticked checklist", "2/2" in page.locator(chip).inner_text())


def run_phone_calendar(browser, problems):
    """The Calendar page on a phone: no sideways scrolling, dots in the month, days stacked in the week."""
    ctx = browser.new_context(viewport={"width": 390, "height": 800}, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    page.on("console", lambda m: problems.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: problems.append(str(e)))
    page.goto(T.BASE + "/")
    page.fill("input[name=username]", "alex")
    page.fill("input[name=password]", "correct horse battery")
    page.click("button[type=submit]")
    page.wait_for_selector("#top3 .slot")
    page.click("[data-act=page][data-page=calendar]")
    page.wait_for_selector("#cal-grid .cell .ev")
    page.wait_for_selector("#up .up-row")
    width = page.evaluate("document.documentElement.scrollWidth")
    check("phone: the Calendar page fits the width, no sideways scrolling", width <= 390, str(width))
    ev = page.locator("#cal-grid .cell .ev").first.bounding_box()
    check("phone: events in the month are small dots", ev["width"] < 12 and ev["height"] < 12, str(ev))
    day = page.get_attribute("#cal-grid .cell .ev >> nth=0", "data-day")
    page.locator(f".cell[data-cday='{day}']").click(position={"x": 25, "y": 45})
    page.wait_for_selector(f".wday[data-cday='{day}'] .ev")      # the week's own data has arrived
    page.wait_for_timeout(300)
    a, b = (page.locator("#cal-grid .wday").nth(i).bounding_box() for i in (0, 1))
    check("phone: tapping a day opens its week, the days one under the other",
          page.locator(f".wday[data-cday='{day}']").count() == 1 and abs(a["x"] - b["x"]) < 2 and b["y"] > a["y"])
    width = page.evaluate("document.documentElement.scrollWidth")
    check("phone: the week fits the width too", width <= 390, str(width))
    ctx.close()


def run_google(page):
    """Google events on the Day page: a dialog with subtasks and notes, hiding with Undo, and showing them again."""
    page.reload()
    g = "#tl .gcal:has-text('Team')"
    page.wait_for_selector(g)
    page.click(g)
    page.wait_for_selector("#gev-dlg[open]")
    dlg = page.locator("#gev-dlg")
    check("google: clicking a calendar event opens its dialog: title, time and calendar, as text",
          page.locator("#gev-title").inner_text() == "Team <b>call</b>" and "10:00–11:00" in page.locator("#gev-when").inner_text()
          and "Main" in page.locator("#gev-when").inner_text() and page.locator("#gev-title b").count() == 0)
    check("google: the dialog says the event stays in Google", "It stays in Google Calendar." in dlg.inner_text()
          and page.locator("#gev-dlg [data-act=gev-hide]").inner_text() == "Hide from the planner")
    page.fill("#gev-subadd", "Agenda <i>draft</i>")
    page.click("[data-act=gev-sub-add]")
    page.wait_for_selector("#gev-subs li")
    page.fill("#gev-subadd", "Room")
    page.press("#gev-subadd", "Enter")
    wait_until(page, lambda: page.locator("#gev-subs li").count() == 2)
    page.click("#gev-subs li >> nth=0 >> [data-act=gev-sub-done]")
    page.dblclick("#gev-subs li >> nth=1 >> span")
    page.fill("#gev-subs input.edit", "Book the room")
    page.press("#gev-subs input.edit", "Enter")
    check("google: subtasks are added (button and Enter), ticked and renamed; the dialog stays open",
          page.locator("#gev-subs li").count() == 2 and page.locator("#gev-subs li.done").count() == 1
          and "Book the room" in page.locator("#gev-subs li").nth(1).inner_text() and page.locator("#gev-dlg[open]").count() == 1)
    page.fill("#gev-notes", "Dial-in <b>in</b> the invite")
    page.click("#gev-dlg .dlg-foot [data-act=gev-close]")
    page.wait_for_selector("#gev-dlg", state="hidden")
    page.wait_for_selector(g + " small:has-text('1/2')")
    check("google: the block shows the subtask count and a pen for the notes", "1/2 ✎" in page.locator(g).inner_text(),
          page.locator(g).inner_text())
    page.wait_for_timeout(400)
    page.reload()
    page.wait_for_selector(g)
    page.click(g)
    page.wait_for_selector("#gev-dlg[open]")
    check("google: subtasks and notes are kept after a reload, markup as text", page.locator("#gev-subs li").count() == 2
          and page.locator("#gev-subs li.done").count() == 1 and "Agenda <i>draft</i>" in page.locator("#gev-subs").inner_text()
          and page.locator("#gev-subs i").count() == 0 and page.input_value("#gev-notes") == "Dial-in <b>in</b> the invite")

    # hide, undo, hide again, then show the day's hidden events again
    page.click("[data-act=gev-hide]")
    page.wait_for_selector("#toast.on:has-text('Hidden from the planner')")
    check("google: hiding takes the event off the timeline", page.locator(g).count() == 0)
    page.click("#toast-act")
    page.wait_for_selector(g)
    check("google: Undo brings it back", page.locator(g).count() == 1)
    page.click(g)
    page.wait_for_selector("#gev-dlg[open]")
    page.click("[data-act=gev-hide]")
    page.wait_for_selector(g, state="detached")
    page.click("#allday .gchip:has-text('Holiday')")
    page.wait_for_selector("#gev-dlg[open]")
    check("google: an all-day event opens the same dialog", "All day" in page.locator("#gev-when").inner_text())
    page.click("[data-act=gev-hide]")
    page.wait_for_timeout(400)
    page.reload()
    page.wait_for_selector("#tlhint [data-act=gev-unhide]")
    check("google: hidden events stay hidden after a reload; the hint offers them back",
          page.locator(g).count() == 0 and page.locator("#allday .gchip").count() == 0
          and "2 hidden · show" in page.locator("#tlhint").inner_text(), page.locator("#tlhint").inner_text())
    page.click("[data-act=gev-unhide]")
    page.wait_for_selector(g)
    page.wait_for_selector("#allday .gchip")
    page.wait_for_timeout(400)
    page.reload()
    page.wait_for_selector(g)
    check("google: '2 hidden · show' brings them back for good", page.locator("#allday .gchip").count() == 1
          and page.locator("[data-act=gev-unhide]").count() == 0)


def run_repeat_remind(page):
    """Repeat and Remind me in a task's panel; the automatic sync after a change."""
    title = "Daily <b>stretch</b>"
    add(page, title)
    dump = f"#z-dump .task:has(.item:has-text('{title}'))"
    also = f"#z-also .task:has(.item:has-text('{title}'))"
    page.click(dump + " [data-act=more]")
    check("remind: without a time the select is off and says why", page.locator(dump + " [data-remind]").is_disabled()
          and "Give the task a time first" in page.locator(dump + " .details").inner_text())
    page.select_option(dump + " [data-repeat]", "daily")
    page.wait_for_selector(also + " .rep")
    check("repeat: Every day plans a brain dump task on this day, marked ↻, its title as text",
          page.locator(dump).count() == 0 and page.locator(also + " .rep").inner_text() == "↻"
          and page.locator("#z-also b").count() == 0)
    page.click("[data-act=next]")
    page.locator("#dayname:has-text('Tomorrow')").wait_for()
    page.wait_for_selector(also)
    check("repeat: tomorrow already has it, not done", page.locator(also).count() == 1 and page.locator(also + " .item.done").count() == 0)
    page.click("[data-act=today]")
    page.locator("#dayname:has-text('Today')").wait_for()
    page.wait_for_selector(also)
    page.click(also + " .item [data-act=done]")
    page.wait_for_selector(also + " .item.done")
    page.wait_for_timeout(300)
    page.click("[data-act=next]")
    page.locator("#dayname:has-text('Tomorrow')").wait_for()
    page.wait_for_selector(also)
    check("repeat: ticking today's leaves tomorrow's open", page.locator(also + " .item.done").count() == 0)

    # tomorrow's copy renamed, and its details used from that day on
    page.dblclick(also + " [data-title]")
    page.fill("#z-also input.edit", "Stretch and breathe")
    page.press("#z-also input.edit", "Enter")
    also2 = "#z-also .task:has(.item:has-text('Stretch and breathe'))"
    page.wait_for_selector(also2)
    page.wait_for_timeout(300)
    page.click(also2 + " [data-act=more]")
    page.click(also2 + " [data-act=series-apply]")
    page.wait_for_selector("#toast.on:has-text('From this day on')")
    page.click("[data-act=next]")
    page.locator("#dayname:not(:has-text('Tomorrow'))").wait_for()
    page.wait_for_selector(also2)
    check("repeat: 'Use these details from this day on' renames the days after", page.locator(also2).count() == 1
          and page.locator(also).count() == 0)
    # Never, on the day after tomorrow: the days after lose it
    page.click(also2 + " [data-act=more]")
    page.select_option(also2 + " [data-repeat]", "")
    page.wait_for_selector("#toast.on:has-text('No longer repeats')")
    page.wait_for_selector(also2 + " .item")
    check("repeat: Never keeps this day's task, without ↻", page.locator(also2 + " .rep").count() == 0)
    page.click("[data-act=next]")
    page.wait_for_timeout(600)
    check("repeat: ...and the days after no longer have it", page.locator(also2).count() == 0 and page.locator(also).count() == 0)
    page.click("[data-act=today]")
    page.locator("#dayname:has-text('Today')").wait_for()

    # a reminder once the task has a time; the change reaches Google once, a moment later
    page.wait_for_selector(also)
    drop_on_timeline(page, also + " .item", 9 * 60)        # 16:00
    blk = f"#tl .blk[data-blk]:has-text('{title}')"
    page.wait_for_selector(blk)
    page.wait_for_timeout(1500)                            # any sync the drop started is over
    before = len(T.Bridge.synced)
    if page.locator(also + " .details").count() == 0:
        page.click(also + " [data-act=more]")
    check("remind: with a time the select can be used", not page.locator(also + " [data-remind]").is_disabled())
    page.select_option(also + " [data-remind]", "15")
    page.wait_for_selector(also + " .bell")
    page.wait_for_timeout(1800)
    sent = {it["title"]: it for it in T.Bridge.synced[-1]["boards"][0]["items"]} if T.Bridge.synced else {}
    check("sync: a change goes to Google by itself, once, a moment later", len(T.Bridge.synced) == before + 1, str(len(T.Bridge.synced) - before))
    check("sync: ...with the reminder", sent.get("✓ " + title, sent.get(title, {})).get("remind") == 15, str(list(sent)))
    check("remind: a bell shows on the task and its block", page.locator(also + " .bell").count() >= 1 and page.locator(blk + " .bell").count() == 1)
    labels = page.locator(also + " [data-remind] option").all_inner_texts()
    check("remind: 'At the time' is not offered (Google wants 5 minutes at least)", "At the time" not in labels
          and labels[:2] == ["No reminder", "5 minutes before"], str(labels))

    # never two syncs at once: a slow one runs, and a change made meanwhile waits for it, then goes in a second run
    T.Bridge.sync_seconds = 1.5
    T.Bridge.most_in_flight = 0
    before = len(T.Bridge.synced)
    page.select_option(also + " [data-remind]", "30")
    page.wait_for_timeout(900)                             # the first sync is now running
    page.select_option(also + " [data-remind]", "60")
    page.wait_for_timeout(4500)
    T.Bridge.sync_seconds = 0
    last = {it["title"]: it for it in T.Bridge.synced[-1]["boards"][0]["items"]} if T.Bridge.synced else {}
    check("sync: never two at once; a change made during one goes in the next", T.Bridge.most_in_flight == 1
          and len(T.Bridge.synced) == before + 2 and last.get("✓ " + title, last.get(title, {})).get("remind") == 60,
          f"{T.Bridge.most_in_flight} {len(T.Bridge.synced) - before}")
    page.select_option(also + " [data-remind]", "15")
    page.wait_for_timeout(1500)
    page.reload()
    page.wait_for_selector(also)
    page.click(also + " [data-act=more]")
    check("remind: the reminder is kept after a reload", page.input_value(also + " [data-remind]") == "15")
    page.click(also + " [data-act=more]")

    # Settings: the automatic sync switch and the per-board calendars
    page.click("[data-act=settings-open]")
    check("settings: automatic sync is on, and the calendars per board are explained", page.is_checked("#auto-sync")
          and "one Google calendar per board" in page.locator("#cal-on").inner_text()
          and "Last brought up to date" in page.locator("#sync-last").inner_text())
    page.click("#auto-sync")
    page.wait_for_timeout(400)
    page.click("[data-act=settings-close]")
    page.reload()
    page.wait_for_selector("#top3 .slot")
    page.click("[data-act=settings-open]")
    check("settings: switching it off is kept", not page.is_checked("#auto-sync"))
    page.click("#auto-sync")
    page.wait_for_timeout(1500)
    page.click("[data-act=settings-close]")


def run_touch_events(browser, problems):
    """Events are dragged to another day with a finger too: the week view on a phone, the month view on a tablet."""
    today = date.today()

    def open_calendar(ctx_opts):
        ctx = browser.new_context(has_touch=True, is_mobile=True, **ctx_opts)
        page = ctx.new_page()
        page.on("console", lambda m: problems.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: problems.append(str(e)))
        page.goto(T.BASE + "/")
        page.fill("input[name=username]", "alex")
        page.fill("input[name=password]", "correct horse battery")
        page.click("button[type=submit]")
        page.wait_for_selector("#top3 .slot")
        page.click("[data-act=page][data-page=calendar]")
        page.wait_for_selector("#cal-grid .cell")
        return ctx, page

    # a phone, the week view (its days one under the other)
    ctx, page = open_calendar({"viewport": {"width": 390, "height": 2400}})
    page.click("[data-act=cal-view][data-view=week]")
    src_day = today.isoformat()
    dst_day = (today + timedelta(days=1 if today.weekday() < 6 else -1)).isoformat()
    ev = f".wday[data-cday='{src_day}'] .ev:has-text('Site visit')"
    page.wait_for_selector(ev)
    finger = Finger(page)
    x, y = centre(page, ev)
    finger.send("touchStart", x, y)
    finger.glide(x, y, x, y + 250, steps=6)
    finger.send("touchEnd")
    page.wait_for_timeout(300)
    check("phone: a quick swipe over an event does not move it", page.locator(ev).count() == 1 and page.locator(".drag-clone").count() == 0)
    page.tap(ev)
    page.wait_for_selector("#event-dlg[open]")
    check("phone: a tap on an event opens it", "Site visit" in page.input_value("#ev-title"))
    page.click("#event-dlg [data-act=event-close] >> nth=1")
    page.wait_for_selector("#event-dlg", state="hidden")
    tx, ty = centre(page, f".wday[data-cday='{dst_day}'] .whead")
    finger.hold_and_drag(ev, tx, ty)
    moved = f".wday[data-cday='{dst_day}'] .ev:has-text('Site visit')"
    page.wait_for_selector(moved)
    check("phone: press, hold and drag moves an event to another day in the week", page.locator(ev).count() == 0
          and page.locator(".drag-clone").count() == 0 and page.locator("[data-cday].over").count() == 0)
    page.wait_for_timeout(400)
    page.reload()
    page.wait_for_selector(moved)
    check("phone: the new day is kept after a reload", page.locator(ev).count() == 0)
    ctx.close()

    # a tablet, the month view: the three-day workshop from run_events, grabbed on its first day
    ctx, page = open_calendar({"viewport": {"width": 1100, "height": 1300}})
    first = date(today.year, today.month, 17)
    d = lambda n: (first + timedelta(days=n)).isoformat()
    on = lambda day: page.locator(f".cell[data-cday='{day}'] .ev:has-text('Workshop')").count() == 1
    page.wait_for_selector(f".cell[data-cday='{d(0)}'] .ev:has-text('Workshop')")
    finger = Finger(page)
    tx, ty = centre(page, f".cell[data-cday='{d(7)}']")
    finger.hold_and_drag(f".cell[data-cday='{d(0)}'] .ev:has-text('Workshop')", tx, ty)
    page.wait_for_selector(f".cell[data-cday='{d(9)}'] .ev:has-text('Workshop')")
    check("tablet: press, hold and drag moves an event in the month, keeping its length",
          on(d(7)) and on(d(8)) and on(d(9)) and not on(d(0)) and not on(d(10)))
    page.wait_for_timeout(400)
    page.reload()
    page.wait_for_selector(f".cell[data-cday='{d(9)}'] .ev:has-text('Workshop')")
    check("tablet: the move is kept after a reload", on(d(7)) and not on(d(0)))
    ctx.close()


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
    # some phone keyboards have no Enter key: the Add buttons do the same
    page.fill("#new", "Button task")
    page.tap("#add-form button[type=submit]")
    page.wait_for_selector("#z-dump .item:has-text('Button task')")
    check("phone: the Add button puts a task in the brain dump and empties the box",
          page.locator("#z-dump .item:has-text('Button task')").count() == 1 and page.input_value("#new") == "")
    host = "#z-dump .task:has(.item:has-text('Button task'))"
    page.tap(host + " [data-act=more]")
    page.fill(host + " .subadd", "Tapped in")
    page.tap(host + " [data-act=sub-add]")
    page.wait_for_selector(host + " .subs li:has-text('Tapped in')")
    check("phone: the Add button beside the subtask box adds a subtask",
          page.locator(host + " .subs li").count() == 1 and page.input_value(host + " .subadd") == "")
    page.tap(host + " .item [data-act=del]")
    page.wait_for_timeout(300)
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

    # a drop while a calendar event is on is accepted (the fake calendar has an event 10:00-11:00)
    add(page, "Beside task")
    finger.hold_and_drag("#z-dump .item:has-text('Beside task') .t", tl["x"] + tl["width"] * 0.75, tl["y"] + 3 * 52 + 20)
    check("phone: a drop at the time of a calendar event is accepted", page.locator("#z-also .item:has-text('Beside task')").count() == 1
          and page.locator("#tl .blk[data-blk]").count() == blocks + 2)

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
