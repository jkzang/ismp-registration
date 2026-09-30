import { useCallback, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router'
import { api, errorMessage } from './api'
import { AppContext } from './appContext'
import { ImportDialog } from './components/ImportDialog'
import { MenuIcon } from './components/icons'
import { Sidebar } from './components/Sidebar'
import { signOutOfGoogle } from './google'
import { ChapterPage } from './pages/ChapterPage'
import { HomePage } from './pages/HomePage'
import { LoginPage } from './pages/LoginPage'
import { MentorsPage } from './pages/MentorsPage'
import { SheetPage } from './pages/SheetPage'
import type { AppConfig, CurrentUser, Sheet } from './types'

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [user, setUser] = useState<CurrentUser | null | undefined>(undefined)
  const [sheets, setSheets] = useState<Sheet[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    Promise.all([api.config(), api.me()])
      .then(([c, me]) => {
        setConfig(c)
        setUser(me.user)
      })
      .catch((err) => setLoadError(errorMessage(err, 'Couldn’t reach the server.')))
  }, [])

  const inChapter = Boolean(user?.chapter)
  const refreshSheets = useCallback(() => api.listSheets().then(setSheets), [])

  useEffect(() => {
    if (inChapter) refreshSheets().catch(() => setSheets([]))
  }, [inChapter, refreshSheets])

  async function logout() {
    await api.logout().catch(() => {})
    signOutOfGoogle()
    setUser(null)
    setSheets(null)
    navigate('/')
  }

  if (loadError) return <div className="app error">{loadError}</div>
  if (!config || user === undefined) return <div className="app muted">Loading…</div>
  if (!user) return <LoginPage config={config} onSignedIn={setUser} />
  if (!user.chapter) return <ChapterPage user={user} onJoined={setUser} onLogout={logout} />

  return (
    <AppContext.Provider value={{ config, user, sheets, refreshSheets }}>
      <div className="shell">
        <Sidebar
          open={menuOpen}
          onNavigate={() => setMenuOpen(false)}
          onAddSheet={() => {
            setMenuOpen(false)
            setImporting(true)
          }}
          onLogout={logout}
        />
        {menuOpen && <div className="sidebar-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
        <div className="shell-main">
          <div className="mobile-bar">
            <button type="button" className="icon-button" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
              <MenuIcon />
            </button>
            <span className="mobile-brand">ISMP Registration</span>
          </div>
          <main className="app">
            <Routes>
              <Route path="/" element={<HomePage onAddSheet={() => setImporting(true)} />} />
              <Route path="/sheets/:sheetId" element={<SheetPage />} />
              <Route path="/mentors" element={<MentorsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
        {importing && (
          <ImportDialog
            onClose={() => setImporting(false)}
            onImported={(sheet) => {
              setImporting(false)
              refreshSheets().catch(() => {})
              navigate(`/sheets/${sheet.id}`)
            }}
          />
        )}
      </div>
    </AppContext.Provider>
  )
}
