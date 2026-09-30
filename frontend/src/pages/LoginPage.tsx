import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../api'
import { renderSignInButton } from '../google'
import type { AppConfig, CurrentUser } from '../types'

export function LoginPage({ config, onSignedIn }: { config: AppConfig; onSignedIn: (user: CurrentUser) => void }) {
  const buttonRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const configured = Boolean(config.google_client_id)

  useEffect(() => {
    if (!configured || !buttonRef.current) return
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

  return (
    <div className="auth-page">
      <main className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">IR</span>
          <span className="brand-name">ISMP Registration</span>
        </div>
        <h1>Sign in</h1>
        <p className="muted">Use your @{config.allowed_domain} Google account.</p>
        {configured ? (
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
