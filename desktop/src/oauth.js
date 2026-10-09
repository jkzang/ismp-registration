/**
 * Google sign-in for the desktop app, the way installed apps are meant to do it: Google's page opens
 * in the system browser (Google blocks sign-in inside app windows), sends the browser back to a
 * one-off server on 127.0.0.1, and the code it carries is traded for tokens with PKCE.
 *
 * One sign-in gives both halves of what the web app gets from its two popups: an ID token for the
 * app's server, and Sheets access. The refresh token stays in this process (see tokenStore.js), so
 * the page only ever holds short-lived access tokens and nothing asks again until sign-out.
 */
const crypto = require('node:crypto')
const http = require('node:http')
const { signedInPage } = require('./pages')

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
// The same scopes as the web app: sign-in plus drive.file for the sheets someone picks.
const SCOPES = 'openid email profile https://www.googleapis.com/auth/drive.file'
const SIGN_IN_TIMEOUT_MS = 10 * 60_000

class SignInCancelled extends Error {
  reason = 'cancelled'
}

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

function authUrl({ clientId, redirectUri, state, challenge, domain }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // offline + consent so Google always hands back a refresh token, not just the first time.
    access_type: 'offline',
    prompt: 'select_account consent',
  })
  if (domain) params.set('hd', domain)
  return `${AUTH_URL}?${params}`
}

/**
 * Listens on 127.0.0.1 (any free port) for Google to send the browser back. `result` settles with
 * the query Google sent, once its state matches.
 */
function listenForRedirect(state) {
  let settle
  const result = new Promise((resolve, reject) => (settle = { resolve, reject }))
  // Cancelling before anything awaits the result mustn't count as an unhandled rejection.
  result.catch(() => {})
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname !== '/' || url.searchParams.get('state') !== state) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
      return
    }
    const error = url.searchParams.get('error')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(signedInPage(!error))
    settle.resolve(url.searchParams)
  })
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
  const close = () => {
    server.close()
    server.closeAllConnections()
  }
  return { ready, result, close, fail: (err) => settle.reject(err) }
}

async function googleError(res, fallback) {
  const body = await res.json().catch(() => null)
  const err = new Error(body?.error_description || fallback)
  err.code = body?.error
  return err
}

/**
 * @param {object} deps
 * @param {() => {clientId: string, clientSecret: string} | null} deps.client  the Desktop OAuth client
 * @param {(url: string) => Promise<unknown>} deps.openBrowser
 * @param {{load(): string | null, save(token: string): void, clear(): void}} deps.store  for the refresh token
 * @param {typeof fetch} deps.fetch
 */
function createGoogleAuth({ client, openBrowser, store, fetch, timeoutMs = SIGN_IN_TIMEOUT_MS }) {
  let pending = null
  // The last access token, handed out again until a minute before it expires.
  let access = null
  let refreshing = null

  function requireClient() {
    const c = client()
    if (!c) throw new Error('Google sign-in isn’t set up in this copy of the app. See desktop/README.md.')
    return c
  }

  async function tokenRequest(params) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    })
    if (!res.ok) throw await googleError(res, `Google sign-in failed (${res.status}).`)
    return res.json()
  }

  const accessOf = (tokens) => {
    access = { accessToken: tokens.access_token, expiresAt: Date.now() + Number(tokens.expires_in) * 1000 }
    return access
  }

  /** Runs the whole browser sign-in. Starting another one cancels this one. */
  async function signIn({ domain } = {}) {
    const { clientId, clientSecret } = requireClient()
    pending?.cancel()
    const state = crypto.randomBytes(16).toString('base64url')
    const { verifier, challenge } = pkcePair()
    const redirect = listenForRedirect(state)
    const timer = setTimeout(
      () => redirect.fail(new SignInCancelled('Sign-in timed out. Try again.')),
      timeoutMs,
    )
    const attempt = { cancel: () => redirect.fail(new SignInCancelled('Sign-in was cancelled.')) }
    pending = attempt
    try {
      const redirectUri = await redirect.ready
      await openBrowser(authUrl({ clientId, redirectUri, state, challenge, domain }))
      const query = await redirect.result
      const error = query.get('error')
      if (error) {
        throw error === 'access_denied'
          ? new SignInCancelled('Sign-in was cancelled in the browser.')
          : new Error(`Google sign-in failed (${error}).`)
      }
      const tokens = await tokenRequest({
        client_id: clientId,
        client_secret: clientSecret,
        code: query.get('code') ?? '',
        code_verifier: verifier,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      })
      if (!tokens.id_token) throw new Error('Google didn’t send back a sign-in token.')
      if (tokens.refresh_token) store.save(tokens.refresh_token)
      return { idToken: tokens.id_token, ...accessOf(tokens) }
    } finally {
      clearTimeout(timer)
      redirect.close()
      if (pending === attempt) pending = null
    }
  }

  /**
   * An access token from the saved refresh token, or null when there's none (or Google dropped it).
   * Calls that overlap share one request to Google.
   */
  function accessToken() {
    if (access && access.expiresAt > Date.now() + 60_000) return Promise.resolve(access)
    refreshing ??= refresh().finally(() => (refreshing = null))
    return refreshing
  }

  async function refresh() {
    const refreshToken = store.load()
    if (!refreshToken) return null
    const { clientId, clientSecret } = requireClient()
    try {
      return accessOf(
        await tokenRequest({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      )
    } catch (err) {
      // Revoked, expired or from another client: only signing in again fixes it.
      if (err.code === 'invalid_grant') {
        store.clear()
        return null
      }
      throw err
    }
  }

  async function signOut() {
    pending?.cancel()
    access = null
    const refreshToken = store.load()
    store.clear()
    if (!refreshToken) return
    // Best effort: the token is already forgotten here either way.
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    }).catch(() => {})
  }

  return { signIn, accessToken, signOut, cancel: () => pending?.cancel() }
}

module.exports = { createGoogleAuth, SignInCancelled, authUrl, pkcePair }
