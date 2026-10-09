/**
 * ISMP Registration for macOS: the hosted web app in its own window, the way Slack's and VS Code's
 * desktop apps work. Pages, styles and data all come from the server, so the app looks and behaves
 * like the website and picks up each deploy by itself. What it adds: Google sign-in through the
 * system browser (oauth.js), since Google won't sign in inside an app window, and links that open
 * in the Mac's own apps.
 */
const { app, BrowserWindow, Menu, ipcMain, nativeTheme, net, safeStorage, screen, session, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { appUrl, googleClient } = require('./config')
const { createGoogleAuth } = require('./oauth')
const { createTokenStore } = require('./tokenStore')
const { dataUrl, errorPage, loadingPage } = require('./pages')

const appOrigin = new URL(appUrl).origin
// Links the window hands to the Mac instead of opening itself: web pages, and Text, Call and Email.
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'sms:'])

function isAppUrl(url) {
  try {
    return new URL(url).origin === appOrigin
  } catch {
    return false
  }
}

function openExternal(url) {
  try {
    if (EXTERNAL_SCHEMES.has(new URL(url).protocol)) shell.openExternal(url)
  } catch {
    // Not a URL: nothing to open.
  }
}

let win = null
let auth = null
const mac = process.platform === 'darwin'

// A second launch just brings this one's window forward (see second-instance).
if (!app.requestSingleInstanceLock()) app.exit()

// Sites see a plain Chrome, not "Electron/…", as they would in any browser.
app.userAgentFallback = app.userAgentFallback.replace(/ Electron\/\S+/, '').replace(/\) \S+\/\S+ Chrome\//, ') Chrome/')

// Window size and place

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json')

function savedBounds() {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      saved.x < a.x + a.width && saved.x + saved.width > a.x && saved.y < a.y + a.height && saved.y + saved.height > a.y,
    )
    return visible ? saved : null
  } catch {
    return null
  }
}

function saveBounds() {
  if (!win) return
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }))
  } catch {
    // Only a convenience.
  }
}

// The window

function showWindow() {
  if (!win) return createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function createWindow() {
  const saved = savedBounds()
  win = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 860,
    x: saved?.x,
    y: saved?.y,
    minWidth: 380,
    minHeight: 560,
    title: 'ISMP Registration',
    // The web app's frame color, so there's no white flash before the first page draws.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#131417' : '#f0f1f5',
    // On the Mac there's no title bar: the page runs up under the close, minimize and zoom buttons,
    // which sit in the sidebar's top row (frontend/src/index.css: .has-window-controls).
    ...(mac && { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 17 } }),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  if (saved?.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())
  win.on('close', saveBounds)
  win.on('closed', () => (win = null))

  const contents = win.webContents
  if (mac) {
    // Tells the page whether to make room for the buttons (preload.js); they hide in full screen.
    const tellPage = () => contents.send('window:controls', !win.isFullScreen())
    contents.on('dom-ready', tellPage)
    win.on('enter-full-screen', tellPage)
    win.on('leave-full-screen', tellPage)
  }
  // New windows (target=_blank, window.open) open in the default browser.
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  // The window only ever shows the web app; any other link goes to the Mac.
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    openExternal(url)
  })
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // -3 is a load that was replaced by another one, not a failure.
    if (!isMainFrame || code === -3 || !isAppUrl(url)) return
    contents.loadURL(dataUrl(errorPage({ appUrl: url, reason: description })))
  })

  contents.loadURL(dataUrl(loadingPage())).then(() => contents.loadURL(appUrl)).catch(() => {
    // did-fail-load shows the error page.
  })
  return win
}

// What the web app asks for (preload.js)

/** Answers only the web app's own top-level page, never a data: page or a frame inside it. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, args = {}) => {
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame || !isAppUrl(frame.url)) {
      return { ok: false, error: 'Not available on this page.' }
    }
    try {
      return { ok: true, ...(await fn(args)) }
    } catch (err) {
      return { ok: false, error: err.message, reason: err.reason }
    }
  })
}

async function browserSignIn(domain) {
  try {
    return await auth.signIn({ domain })
  } finally {
    showWindow()
  }
}

function registerBridge() {
  handle('google:sign-in', ({ domain }) => browserSignIn(domain))

  handle('google:access-token', async ({ interactive, domain }) => {
    const token = await auth.accessToken()
    if (token) return token
    if (!interactive) {
      throw Object.assign(new Error('Sign in to Google to reach the sheet.'), { reason: 'needs-sign-in' })
    }
    const { accessToken, expiresAt } = await browserSignIn(domain)
    return { accessToken, expiresAt }
  })

  handle('google:cancel', async () => auth.cancel())
  handle('google:sign-out', async () => auth.signOut())
}

// The app

function buildMenu() {
  return Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ])
}

app.on('second-instance', showWindow)

app.whenReady().then(() => {
  auth = createGoogleAuth({
    client: googleClient,
    openBrowser: (url) => shell.openExternal(url),
    store: createTokenStore({ file: path.join(app.getPath('userData'), 'google-token'), safeStorage }),
    fetch: (url, init) => net.fetch(url, init),
  })
  registerBridge()
  // The web app needs no camera, notifications or the like.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(permission === 'clipboard-sanitized-write'),
  )
  Menu.setApplicationMenu(buildMenu())
  createWindow()
  app.on('activate', showWindow)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
