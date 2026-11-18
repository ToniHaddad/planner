# Connect Google Calendar

Once connected, your calendar events appear on the planner's timeline as striped, locked blocks, and the
**Send to calendar** button can write your time blocks back to Google.

It takes about three minutes and you do it once. You need a Google account and nothing else.

## How it works, in one paragraph

The planner never asks for your Google password. Instead, you put a small script (the "bridge") into your own
Google account, using Google's own tool for that, Apps Script. The script answers two questions, "what is on
this day?" and "please save these time blocks", and only when the request carries a secret key that your copy
of the planner generated. You can read the whole script before you use it: it is about 130 lines, in
[`public/lib/bridge.gs.txt`](../public/lib/bridge.gs.txt).

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

Events you have declined are skipped. The planner re-reads a day every ten minutes; the **↻** button at the
top of the board reads it immediately.

## Sending your plan to the calendar

**Send to calendar** writes the day's time blocks to a separate Google calendar named **Planner** (created the
first time). Sending again replaces that day's blocks, so you never get duplicates. The script only ever
deletes events that it created itself.

## If it didn't connect

| The planner says | What to do |
|---|---|
| "Google answered with a page instead of data" | "Who has access" is not **Anyone**. In Apps Script: **Deploy › Manage deployments**, click the pencil, set it to **Anyone**, **Deploy**. |
| "The bridge refused the key" | The script in Google is not the one from **Copy script** (for example you copied the file from this repository, or reinstalled the planner). Copy it again from Settings, paste it over the old one, then **Deploy › Manage deployments › pencil › Version: New version › Deploy**. The URL stays the same. |
| "That is not a web app address" | Paste the **Web app URL** from the deployment window (it ends in `/exec`), not the address from your browser's address bar. |
| "Could not reach Google" | Check your internet connection and try again. |
| Google won't let you authorize | Work and school accounts sometimes block personal scripts. Use a personal Google account, or ask your administrator. |

If you change the script later, always deploy it as a **new version** of the same deployment, as described in
the second row. A brand-new deployment gets a new URL.

## Disconnecting

In the planner: **Settings › Disconnect calendar**. To switch the script off on Google's side as well:
**Deploy › Manage deployments › Archive** in Apps Script, or delete the project.

## Other calendars

- **Outlook, iCloud and others, through Google:** in Google Calendar, use **Other calendars › + › From URL**
  and paste the calendar's public or secret ICS link. It then shows up in the planner like any other calendar.
  Google refreshes such calendars every few hours, so new events can take a while to appear.
- **Something else, or a direct connection:** [open an issue](https://github.com/ToniHaddad/planner/issues/new)
  and tell me which calendar you use and what you need. I'm happy to help.
