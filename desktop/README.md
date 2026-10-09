# ISMP Registration for Mac

The web app in its own Mac window, like Slack's and VS Code's desktop apps: every page, style and
bit of data comes from the server, so it looks and works exactly like the website and picks up each
deploy by itself. What the app adds:

- **Google sign-in through the browser.** Google won't sign in inside an app window, so **Sign in
  with Google** opens Google in your default browser. When you finish there, the browser hands the
  sign-in back to the app (through a one-off address on `127.0.0.1`), and you're signed in. That one
  sign-in also covers Sheets access, and it lasts until you sign out: there are no more Google
  popups after it. Google's refresh token stays in the app, encrypted with the Mac's Keychain; the
  page only ever gets short-lived access tokens, and the server only gets the ID token it already
  gets on the web.
- **Links open on the Mac.** Text, Call and Email open Messages, FaceTime and Mail. Links to Google
  Sheets and anything else outside the app open in your browser.
- **No title bar.** The close, minimize and zoom buttons sit in the sidebar's top row, which drags
  the window like a title bar (`.has-window-controls` in `frontend/src/index.css`).
- A loading page while the server wakes up (Render's free plan can take a minute), and a
  **Try again** page when it can't be reached.

The web app knows it's in the Mac app by `window.ismpDesktop` (`frontend/src/desktop.ts`); in a
browser everything works as before.

## One-time setup

1. **Google Cloud** (the same project as the web app): **APIs & Services → Credentials → Create
   credentials → OAuth client ID**, type **Desktop app**, named e.g. *ISMP Registration Mac*.
   Download its JSON and save it as `desktop/google-client.json`. That file is gitignored, and
   built into the app. An app that was built without it reads the same file from
   `~/Library/Application Support/ISMP Registration/google-client.json` instead (in Finder,
   **Go → Go to Folder…**; open the app once first so the folder exists).

   Google doesn't treat a desktop client's secret as confidential, because every copy of an
   installed app carries it. It still isn't something to post publicly, so share the built app
   rather than the file.
2. **The server** has to accept sign-ins from this client: set `GOOGLE_DESKTOP_CLIENT_ID` to the
   new client's ID in Render's Environment tab (and in `backend/.env` for local development).
3. **The web app's address** is `ismp.appUrl` in `package.json`
   (`https://ismp-registration.onrender.com`). Change it if your Render service has a different
   URL.

## Building the app

On a Mac with Node 24:

```sh
cd desktop
npm install
npm start          # try it without building
npm run dist       # → dist/ISMP Registration-0.1.0-universal.dmg (Apple silicon and Intel)
```

`ISMP_APP_URL=http://localhost:5173 npm start` points it at the local dev server instead.

## Installing

Open the `.dmg` and drag **ISMP Registration** into Applications. The app is signed ad hoc, not
with a paid Apple Developer ID, so the first time it opens:

- If you built it yourself, it opens like any app.
- If it was downloaded or sent to you, macOS says it can't verify the app. Go to **System Settings
  → Privacy & Security** and click **Open Anyway** (once per download).
- After the first sign-in, macOS may ask whether *ISMP Registration* can use its *Safe Storage* in
  the Keychain. Click **Always Allow**; that's where it keeps you signed in to Google. It may ask
  again after you install a new build.

A $99/year Apple Developer account would remove both prompts: set `mac.identity` in
`package.json`'s `build` section to the certificate, and turn notarization on.

## To check on the first run

- **Add sign up sheet** (the Google Picker) runs inside the app window. It isn't a sign-in page and
  gets the app's access token, so it should work, but Google could still refuse it there. If it
  does, add the sheet on the website; everything else in the app is unaffected.

## Code

- `src/main.js`: the window, which links it keeps and which it sends to the Mac, and what it
  answers the web app.
- `src/oauth.js`: the browser sign-in (PKCE, loopback redirect, refresh, sign-out).
- `src/preload.js`: `window.ismpDesktop`, the four calls the web app can make.
- `src/tokenStore.js`: the refresh token, encrypted with the Keychain.
- `src/pages.js`: the loading, can't-connect and "You're signed in" pages, in the web app's styles.

Tests: `npm test`.
