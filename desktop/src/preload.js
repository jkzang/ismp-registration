/**
 * What the web app can ask of the desktop app, as window.ismpDesktop (frontend/src/desktop.ts).
 * Every call answers { ok: true, ... } or { ok: false, error, reason? } instead of throwing, since
 * errors lose their details on the way across. main.js only answers the web app's own pages.
 */
const { contextBridge, ipcRenderer } = require('electron')

// Mac: html.has-window-controls while the window's buttons sit over the page (main.js).
ipcRenderer.on('window:controls', (_event, shown) => {
  document.documentElement.classList.toggle('has-window-controls', shown)
})

contextBridge.exposeInMainWorld('ismpDesktop', {
  signIn: (domain) => ipcRenderer.invoke('google:sign-in', { domain }),
  accessToken: (interactive, domain) => ipcRenderer.invoke('google:access-token', { interactive, domain }),
  cancelSignIn: () => ipcRenderer.invoke('google:cancel'),
  signOut: () => ipcRenderer.invoke('google:sign-out'),
  checkTexting: () => ipcRenderer.invoke('messages:check'),
  sendText: (to, body) => ipcRenderer.invoke('messages:send', { to, body }),
})
