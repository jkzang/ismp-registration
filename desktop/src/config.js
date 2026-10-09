/**
 * Where the app points: the web app it shows, and the Google OAuth client it signs in with.
 *
 * - ISMP_APP_URL overrides the web app's address (e.g. http://localhost:5173 while developing).
 * - The Google client comes from ISMP_GOOGLE_CLIENT_ID and ISMP_GOOGLE_CLIENT_SECRET, or else from
 *   google-client.json: the JSON Google Cloud downloads for a "Desktop app" OAuth client. The app
 *   looks for it in its own folder (~/Library/Application Support/ISMP Registration), so a built
 *   app can be set up afterwards, then beside package.json, where it's packaged in at build time
 *   (it's gitignored there).
 */
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const pkg = require('../package.json')

const appUrl = (process.env.ISMP_APP_URL || pkg.ismp.appUrl).replace(/\/+$/, '')

function googleClient() {
  if (process.env.ISMP_GOOGLE_CLIENT_ID && process.env.ISMP_GOOGLE_CLIENT_SECRET) {
    return { clientId: process.env.ISMP_GOOGLE_CLIENT_ID, clientSecret: process.env.ISMP_GOOGLE_CLIENT_SECRET }
  }
  for (const dir of [app.getPath('userData'), path.join(__dirname, '..')]) {
    try {
      const json = JSON.parse(fs.readFileSync(path.join(dir, 'google-client.json'), 'utf8'))
      const client = json.installed ?? json
      if (client.client_id && client.client_secret) return { clientId: client.client_id, clientSecret: client.client_secret }
    } catch {
      // Not here.
    }
  }
  // No file: sign-in says it isn't set up.
  return null
}

module.exports = { appUrl, googleClient }
