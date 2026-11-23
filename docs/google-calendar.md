# Connect Google Calendar

Once connected, your calendar events appear on the planner's timeline, and your planned times and events go
back into Google Calendar: one calendar per board, kept up to date by itself, with the reminders you set.

It takes about three minutes and you do it once. You need a Google account and nothing else.

## How it works, in one paragraph

The planner never asks for your Google password. Instead, you put a small script (the "bridge") into your own
Google account, using Google's own tool for that, Apps Script. The script answers three questions, "what is on
this day?", "what is on these days?" (for the Calendar page) and "please bring my plan up to date", and only
when the request carries a secret key that your copy of the planner generated. You can read the whole script
before you use it: it is about 300 lines, in [`public/lib/bridge.gs.txt`](../public/lib/bridge.gs.txt).

## The five steps

Open the planner, click the **gear** (top right), and you will see these same steps under **Google Calendar**.

### 1. Copy the script

Click **Copy script**. Use this button and not the file in this repository: the button fills in the secret key
for your planner.

### 2. Paste it into a new Apps Script project

Click **Open Google Apps Script**. A new tab opens with an editor that contains a few lines of sample code.

- If Google asks you to sign in, use the account that holds your calendar.
- Click inside the editor, select everything (Ctrl+A, or ⌘A on a Mac) and paste (Ctrl+V or ⌘V), so the script
  replaces the sample code.

You don't need to name the project or press save; the next step saves it.

### 3. Deploy it as a web app

1. Top right of the editor: **Deploy**, then **New deployment**.
2. Click the **gear** beside "Select type" and choose **Web app**.
3. Set **Execute as** to **Me**.
4. Set **Who has access** to **Anyone**.
5. Click **Deploy**.

"Anyone" sounds alarming, and here is why it is fine: it only means the script can be called without a Google
sign-in, which the planner needs. The script itself refuses every call that does not carry your secret key.

### 4. Allow it to use your calendar

Google now asks for permission, because the script reads your calendar.

1. Click **Authorize access** and pick your account.
2. Google shows a warning: **"Google hasn't verified this app"**. This appears for every script a person writes
   for themselves; the "app" is the script you pasted a minute ago. Click **Advanced**, then
   **Go to Untitled project (unsafe)**.
3. Click **Allow**. If Google shows a checkbox for the calendar permission, tick it first.

### 5. Paste the web app URL into the planner

Google shows a **Web app URL** that ends in `/exec`. Click **Copy** under it, go back to the planner, paste it
into the box in step 5 and click **Connect**.

The planner answers "Connected" and lists the calendars it reads. Close Settings: your events are on the
timeline.

## Which calendars are read

Every calendar that is **ticked in the list on the left of Google Calendar**, including calendars you have
subscribed to (a shared team calendar, an Outlook or iCloud calendar added by link, public holidays). Untick a
calendar in Google Calendar and it disappears from the planner.

Events you have declined are skipped, and so are the planner's own calendars (below). The planner re-reads a
day every ten minutes; the **↻** button at the top of the board reads it immediately.

On the timeline a calendar event is a plain block with a small calendar mark. You can plan a task at the same
time: it sits beside the event. Click the event to give it subtasks and notes (they stay in the planner;
Google is not changed), or to hide it from the planner with **Hide from the planner**. It stays in Google
Calendar. A day with hidden events says "2 hidden · show" under **Timebox**; click it to show them again.

## Your plan in Google Calendar

Each board gets a Google calendar of its own, named **Planner** and the board's name, for example
**Planner Main** and **Planner Studio**. The script makes it the first time and remembers it, so renaming a
board renames its calendar. Into it go the board's tasks that have a time, and its events, from yesterday to
45 days ahead. A ticked task stays there with a ✓ in front of its title, so the day keeps its record. Notes,
open subtasks and an event's place and "To arrange" list go in the event's description.

It happens by itself a few seconds after you change something that shows in Google (a task's time, title,
length or tick, a reminder, an event, a board's name, a repeat), and when you open the planner after half an
hour or more. Switch this off in **Settings › Google Calendar** with "Keep Google Calendar up to date
automatically". **Send to calendar** does it at once, on the Day page and the Calendar page, and says what it
did: "Google Calendar is up to date: 3 added, 1 changed, 0 removed."

What the script may touch: inside those calendars, only events it made itself (it tags them). It changes only
what changed and removes what the planner no longer has, so nothing is ever duplicated; it removes events only
for the days from yesterday on, so the record of earlier days stays. It never deletes a calendar: when you
delete a board, its calendar stays as it is in Google (the planner no longer updates it), and you can delete it
there yourself. Older planners wrote to one calendar named **Planner**; once the new script has written your
plan, it removes the blocks it put there for the same days, so they don't show twice.

The script also uses two small Google services: script properties, to remember which calendar belongs to which
board, and a lock, so two updates (from two tabs or two devices) never run at once; the second one waits for
its next turn. A very large update stops after about four and a half minutes, as Apps Script allows six; the
next update carries on where it stopped.

### Reminders

Give a task with a time a reminder in its panel (**Remind me**: 5, 10, 15 or 30 minutes, 1 hour or 1 day
before; Google does not take a reminder of less than 5 minutes), or an event in its window (for an all-day event: the day before at 09:00 or 18:00, two days
before or a week before at 09:00). A small bell shows on it. The planner does not ring by itself: Google
Calendar does, on every phone and computer where you are signed in to it. On a phone, Google Calendar's own
notification settings decide how (sound, banner, or nothing), so check them once if a reminder stays silent.

## If it didn't connect

| The planner says | What to do |
|---|---|
| "Google answered with a page instead of data" | Either "Who has access" is not **Anyone** (it must not be "Anyone with a Google account"), or the script ran into an error. For both: copy the script again, paste it over the old one, then **Deploy › Manage deployments**, click the pencil, set Who has access to **Anyone** and Version to **New version**, **Deploy**. |
| "The calendar script answered in a way the planner does not understand" | The script is not the one this planner made. Paste the current script from Settings and deploy a new version, as in the row above. |
| "The bridge refused the key" | The script in Google is not the one from **Copy script** (for example you copied the file from this repository, or reinstalled the planner). Copy it again from Settings, paste it over the old one, then **Deploy › Manage deployments › pencil › Version: New version › Deploy**. The URL stays the same. |
| "That is not a web app address" | Paste the **Web app URL** from the deployment window (it ends in `/exec`), not the address from your browser's address bar. |
| "Could not reach Google" | Check your internet connection and try again. |
| Google won't let you authorize | Work and school accounts sometimes block personal scripts. Use a personal Google account, or ask your administrator. |

If you change the script later, always deploy it as a **new version** of the same deployment, as described in
the second row. A brand-new deployment gets a new URL.

## Updating the script

A newer planner can need a newer script: this one brings Google events on the Calendar page, reminders, and one
Google calendar per board. When the script in your Google account is older than the planner, the Calendar page
says: "Update the calendar script to get Google events on this page, reminders and one Google calendar per
board: Settings › Google Calendar." Your day timeline keeps working meanwhile, and **Send to calendar** sends
the day the old way. Updating keeps the same web app URL, so there is nothing to change in the planner
afterwards. In the planner, open **Settings**, then **Update the script** under **Google Calendar**, and follow
its three steps:

1. **Copy the script again.** Click **Copy script**.
2. **Paste it over the old one.** Click **Open Google Apps Script** and open the project you made for the
   planner. Click in the code editor, select everything (Ctrl+A, or ⌘A on a Mac) and paste over it.
3. **Deploy it as a new version.** Top right: **Deploy › Manage deployments**. Click the pencil (edit), set
   **Version: New version**, then click **Deploy**. If Google asks for permission again, allow it as the first
   time: **Advanced**, then **Go to Untitled project (unsafe)**, then **Allow**. Google may ask after an update,
   for example now that the script also uses its lock and script-properties services.

## Disconnecting

In the planner: **Settings › Disconnect calendar**. To switch the script off on Google's side as well:
**Deploy › Manage deployments › Archive** in Apps Script, or delete the project. The **Planner** calendars stay
in Google Calendar until you delete them there.

## Other calendars

- **Outlook, iCloud and others, through Google:** in Google Calendar, use **Other calendars › + › From URL**
  and paste the calendar's public or secret ICS link. It then shows up in the planner like any other calendar.
  Google refreshes such calendars every few hours, so new events can take a while to appear.
- **Something else, or a direct connection:** [open an issue](https://github.com/ToniHaddad/planner/issues/new)
  and tell me which calendar you use and what you need. I'm happy to help.
