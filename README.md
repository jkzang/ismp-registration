# ISMP Registration

Check-in and discussion-table assignment for ISMP events, driven by a Google Sheets sign-up tab.
Extracted from ISMP Operations (the check-in and discussion-group logic is a port of
`core/discussion_groups.py` there).

- Sign in with a Google account on the allowed domain (`acts2.network` by default).
- Create or join a chapter. Everyone in a chapter shares its imported sheets and mentor roster.
- **Add sign up sheet** opens Google's file picker. Pick the spreadsheet, then the tab, check the
  column mapping, and import. The same tab can be imported more than once.
- Each sheet page has the check-in list and the table board side by side, and a manual capacity.
  The sheet is the source of truth: its name, **Start**, **Capacity** and **Re-sync** sit in a
  header shared by its Check-in and Sign-ups pages, which stays put (with everything loaded) when
  switching between them. The sign-up tab is read every 30 seconds while either page is open (and
  when you come back to the browser tab), and any change goes to both pages and to check-in, never
  on its own dropping more than half the sign-ups (a half-edited sheet, more likely). Switching
  pages doesn't read it again; **Re-sync** reads it right away (check-ins are kept). What a sheet's
  pages last had is kept while the app is open, so going back to a sheet shows it at once.
- Importing a tab also adds a **[tab] - Check In** tab right after it in the spreadsheet: everyone
  signed up with whether they've checked in and their table, and the tables with their mentors.
  The sheet's page rewrites it whenever check-ins or the tables change (re-plans, seats handed out
  at the door, people moved by hand), so edits made in that tab are overwritten.

- Each sheet also has a **Sign-ups** page (switch between it and Check-in under the sheet's title)
  for reaching people before the event: everyone in the tab, newest first, filtered by contact
  status. Changing someone's status writes it straight into the tab's Contact Status column (in
  the sheet's own spelling, e.g. its dropdown's) and into the app. **Text**, **Call** and **Email**
  open your phone's or computer's own app with a message you set under **Message** (kept on that
  device), and move people who hadn't been contacted to *Awaiting response*. Both views list the
  same people from the same tab; Sign-ups is where contact status is tracked, and Check-in picks
  it up by itself.
- **Overview** (a button beside the Sign-ups page's search and filters; it opens in a large window
  that closes with its X, Escape or a click outside it) answers:
  expected turnout (each sign-up times their status's show-up rate, plus walk-ins, the same
  numbers the tables are planned from), mentors to students per gender at that turnout, who's
  coming by gender and level, the contact status spread, how people heard about the event, and
  the group chats.
- **The app tends every imported sign-up tab** whenever it reads it (at import, every 30 seconds on
  a sheet's pages, and for every sheet when the app opens with Google already connected). It only
  fills blank cells, so anything typed in the sheet stays:
  - Puts **Contact Status**, **New or Returning** and **Group Chat Status** in columns A, B and C
    (adding them, or moving them there from wherever they were), and **Contacted At** after the
    last column, as dropdowns colored like the app, each status centered with a white edge so it
    sits in its cell like a chip. (The Sheets API can't choose the dropdown's display style; to get
    Google's own chips, select columns A–C, open Data → Data validation, and set each rule's
    Advanced options → Display style to *Chip*. The app leaves that alone afterwards.)
  - Fills blank Contact Status with *Not Contacted*.
  - Fills New or Returning by looking each person up in the spreadsheet's **Student Database** tab
    (by phone, then email, then name): found is *Returning*, otherwise *New*. Without that tab it's
    left blank.
  - Fills Group Chat Status from the form's group chat question: *Yes!* (already in our group) is
    *Already In Group*, *No - Please help me join!* is *Not Invited* (to be added), and *No thank
    you, I don't want to be added* is *Doesn't Want To Join* (left alone). Without an answer it's
    *Not Invited* (or *Added To WeChat/Line* where an older "Added to Group Chat" checkbox was
    ticked). The statuses, by stage: To Do (*Not Invited*), Pending (*WeChat Friend Request Sent*,
    *Line QR Shared*, *WeChat Group Invite Sent*), Complete (*Added To WeChat*, *Added To Line*,
    *Already In Group*), N/A (*Doesn't Want To Join*).
  - Moving someone to *Awaiting response* from the Sign-ups page stamps Contacted At (someone set to
    it in the sheet is stamped the next time it's read); 48 hours later they're moved to
    *No Response*.
  - Keeps a **Sign-up statistics** block above the header, frozen with it and rewritten when the
    numbers change: a title bar, then six boxed tables side by side, two columns each (Overview,
    Contact status, Group chats, Gender & level, New vs returning, and when people signed up),
    with counts and percentages, and an empty row between them and the sheet's header.

  None of these columns are sent to the server. The Sign-ups page sets Group Chat Status from a
  dropdown on each row, and the **Add to chats** filter lists the confirmed people who asked to be
  added and are still To Do or Pending. The overview charts new vs returning and the group chat stages.
  A "How did you hear about this event?" question feeds the overview. Like phone numbers, social
  media IDs and these answers stay in the browser.
- Several volunteers can use a sheet at once. Each device asks the server for a sync ticket before
  reading the tab, and the server turns away a re-sync from a read older than the last one it
  took, so a slow device can't undo newer changes. Undo and redo on the Sign-ups page only change
  a status nobody else has changed since.

## Privacy

- The browser reads the sheet and keeps only name, nickname, gender, enrollment level and
  contact status. Phone numbers, emails, chat IDs and all other columns are never sent to the
  server. See `frontend/src/sheetParser.ts`. The Sign-ups page shows phone numbers and emails by
  reading the sheet in the browser each time; they stay in that tab's memory
  (`frontend/src/signupTracker.ts`).
- Google access tokens stay in the browser tab's memory; the server never sees them.
- The app uses the `drive.file` scope, so it can open only spreadsheets someone picks in the
  picker.
- For volunteers, only the Google account id and display name are stored, not the email.
- Imports are deleted `SIGNUP_RETENTION_DAYS` (default 30) after their last import or re-sync.
  This runs whenever the sheet list loads; `python manage.py purge_expired_sheets` does the same
  by hand (Render's free plan has no cron jobs).

## Google Cloud setup (one time)

Use a personal Google Cloud project. No org project is needed.

1. Create a project at https://console.cloud.google.com and note its **project number**
   (Dashboard → Project info). That's `GOOGLE_APP_ID`.
2. **APIs & Services → Library**: enable **Google Sheets API** and **Google Picker API**.
3. **OAuth consent screen**: User type *External*. Add the scopes `openid`, `email`, `profile`
   and `.../auth/drive.file`. All are non-sensitive, so no Google verification review is needed.
   While in *Testing*, add yourself as a test user; publish the app when you're ready for others.
4. **Credentials → Create credentials → OAuth client ID** → *Web application*.
   Authorized JavaScript origins: `http://localhost:5173` (plus your production URL, see Deploying).
   Copy the client ID → `GOOGLE_CLIENT_ID`.
5. **Credentials → Create credentials → API key**. Restrict it to the *Google Picker API* and to
   HTTP referrers `http://localhost:5173/*` (plus production later) → `GOOGLE_API_KEY`.

## Local development

Needs Python 3.13, Postgres, and Node 24.

```sh
# Backend
python3.13 -m venv venv
venv/bin/pip install -r backend/requirements.txt
createdb ismp-registration
cp backend/.env.example backend/.env   # then fill in the Google values
cd backend
../venv/bin/python manage.py migrate
../venv/bin/python manage.py runserver 8000

# Frontend (another terminal)
cd frontend
npm install
npm run dev        # http://localhost:5173, proxies /api to :8000
```

Tests: `../venv/bin/python manage.py test registration` in `backend/`, `npm test` in `frontend/`.

## Deploying (Render + Neon, free)

One Render web service serves the API and the built frontend from the same origin; the database
is on Neon. Neither can charge you without a payment method on file, so don't add one: going over a
free limit suspends the service until next month instead. `render.yaml` pins `plan: free`.

1. **Neon**: create a project in **AWS US West 2 (Oregon)**. Under **Connect**, turn off
   *Connection pooling* and copy the connection string. That's `DATABASE_URL`.
2. **Render**: **New → Blueprint**, pick this GitHub repo. It reads `render.yaml` and asks for
   `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_API_KEY` and `GOOGLE_APP_ID` (same values as your
   `.env`). `DJANGO_SECRET_KEY` is generated. The first deploy builds the frontend, installs
   Python packages, and runs migrations on start.
3. **Google Cloud**, with your service's URL (e.g. `https://ismp-registration.onrender.com`):
   - OAuth client → Authorized JavaScript origins: add the URL.
   - API key → HTTP referrers: add `https://ismp-registration.onrender.com/*`.
   - OAuth consent screen: **Publish app** so people other than test users can sign in.
4. **Check the CSP**: sign in, import a sheet with the Picker, and re-sync, with the browser's
   console open. If nothing says *Content-Security-Policy* (report-only), delete
   `DJANGO_CSP_REPORT_ONLY` in Render's Environment tab to enforce it. If something does, add
   that domain in `backend/config/csp.py`.
5. After a few weeks with no HTTPS problems, set `DJANGO_HSTS_SECONDS=31536000`.

The free service sleeps after 15 minutes without traffic and takes up to a minute to wake, so
open the app a few minutes before check-in starts.

To try production settings locally: `npm run build` in `frontend/`, then in `backend/`
`DJANGO_DEBUG=0 DJANGO_SECRET_KEY=x ../venv/bin/gunicorn config.wsgi` and request it with an
`X-Forwarded-Proto: https` header (otherwise it redirects to HTTPS).
