/**
 * Keeps Google's refresh token between launches, encrypted with the Mac's Keychain (Electron's
 * safeStorage). Where that isn't available it lives in memory only, so quitting signs Google out.
 */
const fs = require('node:fs')

function createTokenStore({ file, safeStorage }) {
  const persist = safeStorage.isEncryptionAvailable()
  let token

  return {
    load() {
      if (token === undefined) {
        try {
          token = persist ? safeStorage.decryptString(fs.readFileSync(file)) : null
        } catch {
          token = null
        }
      }
      return token
    },
    save(next) {
      token = next
      if (persist) fs.writeFileSync(file, safeStorage.encryptString(next), { mode: 0o600 })
    },
    clear() {
      token = null
      fs.rmSync(file, { force: true })
    },
  }
}

module.exports = { createTokenStore }
