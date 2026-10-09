import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../api'
import { desktop } from '../desktop'
import { cancelDesktopSignIn, renderSignInButton, signInOnDesktop } from '../google'
import type { AppConfig, CurrentUser } from '../types'

export function LoginPage({ config, onSignedIn }: { config: AppConfig; onSignedIn: (user: CurrentUser) => void }) {
  const buttonRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // In the Mac app: while Google's page is open in the system browser.
  const [inBrowser, setInBrowser] = useState(false)
  const configured = Boolean(config.google_client_id)

  useEffect(() => {
    if (!configured || desktop || !buttonRef.current) return
    renderSignInButton(buttonRef.current, config, async (credential) => {
      setBusy(true)
      setError(null)
      try {
        onSignedIn((await api.googleLogin(credential)).user)
      } catch (err) {
        setError(errorMessage(err, 'Sign-in failed.'))
      } finally {
        setBusy(false)
      }
    }).catch((err) => setError(errorMessage(err, 'Couldn’t load Google sign-in.')))
  }, [config, configured, onSignedIn])

  async function signInOnMac() {
    setError(null)
    setInBrowser(true)
    try {
      const credential = await signInOnDesktop(config)
      setInBrowser(false)
      if (!credential) return
      setBusy(true)
      onSignedIn((await api.googleLogin(credential)).user)
    } catch (err) {
      setError(errorMessage(err, 'Sign-in failed.'))
    } finally {
      setInBrowser(false)
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <main className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">IR</span>
          <span className="brand-name">ISMP Registration</span>
        </div>
        <h1>Sign in</h1>
        <p className="muted">Use your @{config.allowed_domain} Google account.</p>
        {configured && desktop ? (
          inBrowser ? (
            <>
              <p>Finish signing in in your browser.</p>
              <button type="button" className="link-button" onClick={cancelDesktopSignIn}>
                Cancel
              </button>
            </>
          ) : (
            <div className="google-button" aria-busy={busy}>
              <GoogleSignInButton onClick={signInOnMac} disabled={busy} />
            </div>
          )
        ) : configured ? (
          <div ref={buttonRef} className="google-button" aria-busy={busy} />
        ) : (
          <p className="error">Google sign-in isn’t configured yet. Set GOOGLE_CLIENT_ID in backend/.env.</p>
        )}
        {busy && <p className="muted">Signing in…</p>}
        {error && <p className="error">{error}</p>}
      </main>
    </div>
  )
}

/** Google's own "Sign in with Google" button (large, outline, pill), drawn here for the Mac app. */
function GoogleSignInButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button type="button" className="gsi-button" onClick={onClick} disabled={disabled}>
      <svg className="gsi-button-icon" viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.31-8.15 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
      </svg>
      Sign in with Google
    </button>
  )
}
