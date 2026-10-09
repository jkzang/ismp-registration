const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { test } = require('node:test')
const { createGoogleAuth, SignInCancelled } = require('../src/oauth')

const CLIENT = { clientId: 'desktop-id', clientSecret: 'desktop-secret' }

function memoryStore(token = null) {
  return { token, load() { return this.token }, save(t) { this.token = t }, clear() { this.token = null } }
}

/** A stand-in for Google's token endpoint that records what it was sent. */
function fakeGoogle(respond) {
  const calls = []
  const fetch = async (url, init) => {
    const body = Object.fromEntries(new URLSearchParams(init.body))
    calls.push({ url, body })
    const { status = 200, json } = respond(url, body)
    return { ok: status < 400, status, json: async () => json }
  }
  return { calls, fetch }
}

/** Plays the person in the browser: reads Google's URL and comes back to the loopback with `query`. */
function browser(query) {
  const opened = []
  const openBrowser = async (url) => {
    const auth = new URL(url)
    opened.push(auth)
    const back = new URL(auth.searchParams.get('redirect_uri'))
    for (const [k, v] of Object.entries(query(auth))) back.searchParams.set(k, v)
    // Not awaited: the browser lands on the page after openBrowser returns.
    setImmediate(() => fetch(back).then((res) => res.text()))
  }
  return { opened, openBrowser }
}

const tokens = { id_token: 'id-token', access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-1' }

test('signs in through the browser with PKCE and keeps the refresh token', async () => {
  const google = fakeGoogle(() => ({ json: tokens }))
  const person = browser((auth) => ({ code: 'the-code', state: auth.searchParams.get('state') }))
  const store = memoryStore()
  const auth = createGoogleAuth({ client: () => CLIENT, openBrowser: person.openBrowser, store, fetch: google.fetch })

  const result = await auth.signIn({ domain: 'acts2.network' })

  assert.equal(result.idToken, 'id-token')
  assert.equal(result.accessToken, 'access-1')
  assert.ok(result.expiresAt > Date.now() + 3500_000)
  assert.equal(store.token, 'refresh-1')

  const sent = person.opened[0].searchParams
  assert.equal(sent.get('client_id'), 'desktop-id')
  assert.equal(sent.get('hd'), 'acts2.network')
  assert.equal(sent.get('access_type'), 'offline')
  assert.match(sent.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.match(sent.get('scope'), /drive\.file/)

  const exchange = google.calls[0].body
  assert.equal(exchange.code, 'the-code')
  assert.equal(exchange.redirect_uri, sent.get('redirect_uri'))
  const challenge = crypto.createHash('sha256').update(exchange.code_verifier).digest('base64url')
  assert.equal(challenge, sent.get('code_challenge'))
})

test('ignores a redirect with the wrong state, and reports Google’s denial as a cancel', async () => {
  const google = fakeGoogle(() => ({ json: tokens }))
  const opened = []
  const openBrowser = async (url) => {
    const auth = new URL(url)
    opened.push(auth)
    const back = new URL(auth.searchParams.get('redirect_uri'))
    back.searchParams.set('code', 'forged')
    back.searchParams.set('state', 'not-the-state')
    const forged = await fetch(back)
    assert.equal(forged.status, 404)
    back.searchParams.set('state', auth.searchParams.get('state'))
    back.searchParams.set('error', 'access_denied')
    setImmediate(() => fetch(back).then((res) => res.text()))
  }
  const auth = createGoogleAuth({ client: () => CLIENT, openBrowser, store: memoryStore(), fetch: google.fetch })

  await assert.rejects(auth.signIn(), SignInCancelled)
  assert.equal(google.calls.length, 0)
})

test('cancelling stops a sign-in that is waiting on the browser', async () => {
  const google = fakeGoogle(() => ({ json: tokens }))
  const auth = createGoogleAuth({ client: () => CLIENT, openBrowser: async () => {}, store: memoryStore(), fetch: google.fetch })
  const signingIn = auth.signIn()
  setImmediate(() => auth.cancel())
  await assert.rejects(signingIn, (err) => err instanceof SignInCancelled && err.reason === 'cancelled')
})

test('a sign-in times out when the browser never comes back', async () => {
  const google = fakeGoogle(() => ({ json: tokens }))
  const auth = createGoogleAuth({ client: () => CLIENT, openBrowser: async () => {}, store: memoryStore(), fetch: google.fetch, timeoutMs: 20 })
  await assert.rejects(auth.signIn(), /timed out/)
})

test('access tokens come from the refresh token, shared between overlapping calls and cached', async () => {
  let n = 0
  const google = fakeGoogle(() => ({ json: { access_token: `access-${++n}`, expires_in: 3600 } }))
  const auth = createGoogleAuth({ client: () => CLIENT, openBrowser: async () => {}, store: memoryStore('refresh-1'), fetch: google.fetch })

  const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()])
  assert.equal(a.accessToken, 'access-1')
  assert.equal(b.accessToken, 'access-1')
  assert.equal((await auth.accessToken()).accessToken, 'access-1')
  assert.equal(google.calls.length, 1)
  assert.equal(google.calls[0].body.grant_type, 'refresh_token')
  assert.equal(google.calls[0].body.refresh_token, 'refresh-1')
})

test('no refresh token, or one Google refuses, means signing in again', async () => {
  const none = createGoogleAuth({ client: () => CLIENT, openBrowser: async () => {}, store: memoryStore(), fetch: async () => assert.fail() })
  assert.equal(await none.accessToken(), null)

  const google = fakeGoogle(() => ({ status: 400, json: { error: 'invalid_grant' } }))
  const store = memoryStore('revoked')
  const refused = createGoogleAuth({ client: () => CLIENT, openBrowser: async () => {}, store, fetch: google.fetch })
  assert.equal(await refused.accessToken(), null)
  assert.equal(store.token, null)
})

test('other token errors are reported, and the refresh token kept', async () => {
  const google = fakeGoogle(() => ({ status: 500, json: { error: 'backend_error', error_description: 'Try later' } }))
  const store = memoryStore('refresh-1')
  const auth = createGoogleAuth({ client: () => CLIENT, openBrowser: async () => {}, store, fetch: google.fetch })
  await assert.rejects(auth.accessToken(), /Try later/)
  assert.equal(store.token, 'refresh-1')
})

test('signing out forgets and revokes the refresh token', async () => {
  const google = fakeGoogle(() => ({ json: { access_token: 'access-1', expires_in: 3600 } }))
  const store = memoryStore('refresh-1')
  const auth = createGoogleAuth({ client: () => CLIENT, openBrowser: async () => {}, store, fetch: google.fetch })
  await auth.accessToken()
  await auth.signOut()
  assert.equal(store.token, null)
  assert.match(google.calls.at(-1).url, /revoke/)
  assert.equal(google.calls.at(-1).body.token, 'refresh-1')
  assert.equal(await auth.accessToken(), null)
})

test('says so when the app has no Google client', async () => {
  const auth = createGoogleAuth({ client: () => null, openBrowser: async () => {}, store: memoryStore(), fetch: async () => assert.fail() })
  await assert.rejects(auth.signIn(), /isn’t set up/)
})
