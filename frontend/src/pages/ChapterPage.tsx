import { useEffect, useState } from 'react'
import { api, errorMessage } from '../api'
import type { Chapter, CurrentUser } from '../types'

export function ChapterPage({ user, onJoined, onLogout }: {
  user: CurrentUser
  onJoined: (user: CurrentUser) => void
  onLogout: () => void
}) {
  const [query, setQuery] = useState('')
  const [chapters, setChapters] = useState<Chapter[] | null>(null)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      api
        .searchChapters(query.trim())
        .then((found) => active && setChapters(found))
        .catch((err) => active && setError(errorMessage(err, 'Couldn’t load chapters.')))
    }, 200)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [query])

  async function run(action: () => Promise<{ user: CurrentUser }>) {
    setBusy(true)
    setError(null)
    try {
      onJoined((await action()).user)
    } catch (err) {
      setError(errorMessage(err, 'Something went wrong.'))
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <main className="auth-card is-wide">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">IR</span>
          <span className="brand-name">ISMP Registration</span>
        </div>
        <h1>Welcome{user.display_name ? `, ${user.display_name.split(' ')[0]}` : ''}</h1>
        <p className="muted">Join your chapter to see its sign up sheets, or start a new one.</p>

        <section className="chapter-section">
          <h2>Join a chapter</h2>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chapters"
            aria-label="Search chapters"
          />
          <ul className="search-results">
            {chapters === null && <li className="muted">Loading…</li>}
            {chapters?.length === 0 && <li className="muted">No chapters match.</li>}
            {chapters?.map((c) => (
              <li key={c.id}>
                <button type="button" disabled={busy} onClick={() => run(() => api.joinChapter(c.id))}>
                  {c.name}
                </button>
              </li>
            ))}
          </ul>
        </section>

        <form
          className="chapter-section"
          onSubmit={(e) => {
            e.preventDefault()
            if (newName.trim()) run(() => api.createChapter(newName.trim()))
          }}
        >
          <h2>Start a new chapter</h2>
          <div className="inline-form">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Chapter name" aria-label="Chapter name" maxLength={80} />
            <button type="submit" className="primary" disabled={busy || !newName.trim()}>
              Create
            </button>
          </div>
        </form>

        {error && <p className="error">{error}</p>}
        <button type="button" className="link-button" onClick={onLogout}>
          Sign out
        </button>
      </main>
    </div>
  )
}
