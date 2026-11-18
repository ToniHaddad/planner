# The Google Sheets version

The first version of this planner: one Apps Script file, [`Planner.gs`](../Planner.gs), that builds a planner inside a Google Sheet. It is kept for reference and is not used by the web app.

A Google Sheets planner with tasks by project, a week calendar fed by Google Calendar and Outlook, and a timebox page for planning your days in color. One Apps Script file, `Planner.gs`, builds the whole thing.

## Set it up (10 minutes)

1. Create a blank Google Sheet. Name it "Planner".
2. **Extensions › Apps Script.** Delete the empty `myFunction`, paste all of `Planner.gs`, and save.
3. Choose `setup` in the function dropdown and click **Run**. Approve the permission prompt: the script needs your sheets and your calendars.
4. Go back to the sheet and reload it. A **Planner** menu appears.
5. Optional: to bring in projects and tasks from an older sheet, put that sheet's id in **Settings › Old sheet id**, then run **Planner › Import old sheet**.

To rebuild a missing tab later, run **Planner › Setup / rebuild**. It never erases rows you've typed.

## Daily use

| Tab | What it's for |
|---|---|
| **Today** | What's due or overdue, what's scheduled today, and today's time blocks. |
| **Projects** | One row per project. **To add a project, type a new row.** Set its color by filling the Color cell (Format › Fill color). |
| **Categories** | Block types that aren't projects (Deep work, Meetings, Break…), each with its own color. |
| **Tasks** | Every task for every project in one list, with project, status and priority dropdowns. Setting a task to Done stamps the date. |
| **By Project** | Pick a project at the top to see its open tasks, its done tasks and its progress. |
| **Calendar** | The week's events from your calendars. Updates every 30 minutes, or run **Planner › Refresh calendar**. |
| **Timebox** | 30-minute slots for the week. Pick a project or category in a slot and it takes that color. You can also color any cell by hand. |
| **Archive** | Old done or canceled tasks, moved here by **Planner › Archive done**. |
| **Settings** | Day hours, slot length, which calendars to read, the name of the Planner calendar. |

**Changing colors:** change the fill in Projects or Categories, then run **Planner › Recolor timebox**.

**Moving between weeks:** use **Planner › Next week / Previous week**, not by typing a date. That way each week's blocks are saved and come back when you return to it.

**Sending blocks to your calendar:** **Planner › Push timebox to calendar** turns the week's blocks into events on a "Planner" Google calendar. It's safe to run again: it replaces that week's blocks instead of adding duplicates. **Sync scheduled tasks to calendar** does the same for tasks that have a Scheduled start. It also runs every hour by itself.

## Connect Outlook (once)

Sheets can't log in to Outlook directly, so Google Calendar acts as the bridge:

1. **Outlook → Google:** in Outlook on the web, open Settings › Calendar › Shared calendars › Publish a calendar. Choose your calendar and "Can view all details", then publish and copy the **ICS** link. In Google Calendar, go to Other calendars › **+** › From URL and paste the link.
2. Copy that calendar's id (Google Calendar › its Settings › Integrate calendar › Calendar ID) into **Settings › Calendars to read** in the sheet, separated from the others by commas.
3. **Google → Outlook (optional):** in Google Calendar, open the "Planner" calendar's settings › Integrate calendar and copy the **Secret address in iCal format**. In Outlook, go to Add calendar › Subscribe from web and paste it.

Limits: Google and Outlook refresh these subscribed calendars only every few hours, and they are read-only on the receiving side. Events you edit in the Planner Google calendar reach the sheet on the next refresh. Live two-way Outlook sync would need a Microsoft app registration; that's not part of this version.
