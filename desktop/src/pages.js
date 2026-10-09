/**
 * The few pages the desktop app draws itself: while the server wakes up, when it can't be reached,
 * and the browser tab Google's sign-in lands on. They copy the web app's sign-in page
 * (frontend/src/index.css: .auth-page, .auth-card, .brand-mark) so they read as the same app.
 */

const CSS = `
:root {
  --text: #0e1318; --text-muted: #5b6770; --bg: #ffffff; --frame: #f0f1f5;
  --accent: #7d2ae8; --accent-fill: #8b3dff; --accent-fill-hover: #7731e3; --accent-contrast: #ffffff;
  --brand-gradient: linear-gradient(135deg, #00c4cc 0%, #5a5cfa 52%, #8b3dff 100%);
  --error: #d92d20;
  font: 16px/1.5 'Figtree', system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: var(--text); background: var(--frame); -webkit-font-smoothing: antialiased;
  --ui-scale: 0.9;
}
@media (prefers-color-scheme: dark) {
  :root {
    --text: #eceef1; --text-muted: #a1a8b1; --bg: #1e1f23; --frame: #131417;
    --accent: #b88cff; --accent-fill: #8b3dff; --accent-fill-hover: #9a55ff; --error: #f97066;
  }
}
* { box-sizing: border-box; }
body { margin: 0; }
/* In the app window, the strip above the card drags the window, as the title bar would. */
.has-window-controls body::before { content: ''; position: fixed; top: 0; left: 0; right: 0; height: 44px; -webkit-app-region: drag; }
.auth-page {
  zoom: var(--ui-scale); min-height: calc(100vh / var(--ui-scale)); display: flex; align-items: flex-start; justify-content: center; padding: 56px 16px;
  background:
    radial-gradient(900px 500px at 0% 0%, rgba(0, 196, 204, 0.22), transparent 60%),
    radial-gradient(900px 600px at 100% 100%, rgba(139, 61, 255, 0.24), transparent 60%),
    var(--frame);
}
.auth-card {
  display: flex; flex-direction: column; gap: 12px; width: min(460px, 100%); padding: 32px 32px 28px;
  border-radius: 20px; background: var(--bg); box-shadow: 0 20px 60px rgba(40, 30, 90, 0.16);
}
.auth-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.brand-mark {
  flex: none; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px;
  font-size: 13px; font-weight: 800; letter-spacing: 0.02em; color: #fff;
  background: var(--brand-gradient); box-shadow: 0 4px 12px rgba(90, 92, 250, 0.3);
}
.brand-name { font-size: 17px; font-weight: 800; letter-spacing: -0.01em; }
h1 { font-size: 26px; font-weight: 700; letter-spacing: -0.01em; margin: 0; }
p { margin: 0; }
.muted { color: var(--text-muted); font-size: 14px; }
.error { color: var(--error); font-size: 14px; }
.button {
  align-self: flex-start; margin-top: 8px; font-size: 14px; font-weight: 600; line-height: 1.3;
  padding: 8px 14px; border-radius: 8px; text-decoration: none;
  background: var(--accent-fill); color: var(--accent-contrast); transition: background 0.15s;
}
.button:hover { background: var(--accent-fill-hover); }
`

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;600;700;800&display=swap" rel="stylesheet" />
<style>${CSS}</style>
</head>
<body>
<div class="auth-page">
<main class="auth-card">
<div class="auth-brand"><span class="brand-mark" aria-hidden="true">IR</span><span class="brand-name">ISMP Registration</span></div>
${body}
</main>
</div>
</body>
</html>`
}

/** The tab Google's sign-in comes back to, in the system browser. */
function signedInPage(ok) {
  return ok
    ? page('Signed in', '<h1>You’re signed in</h1><p class="muted">You can close this tab and go back to ISMP Registration.</p>')
    : page('Sign-in cancelled', '<h1>Sign-in didn’t finish</h1><p class="muted">Close this tab and go back to ISMP Registration to try again.</p>')
}

/** Shown in the window until the server answers; Render's free plan can take a minute to wake up. */
function loadingPage() {
  return page('ISMP Registration', '<h1>Loading…</h1><p class="muted">If the server was asleep, this takes up to a minute.</p>')
}

function errorPage({ appUrl, reason }) {
  return page(
    'ISMP Registration',
    `<h1>Couldn’t reach the server</h1>
<p class="muted">Check your internet connection, then try again.</p>
<p class="error">${escapeHtml(reason)}</p>
<a class="button" href="${escapeHtml(appUrl)}">Try again</a>`,
  )
}

/** A page as a URL the window can load. */
const dataUrl = (html) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`

module.exports = { signedInPage, loadingPage, errorPage, dataUrl, escapeHtml }
