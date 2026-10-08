import { useCallback, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router'
import { api, errorMessage } from './api'
import { AppContext } from './appContext'
import { ImportDialog, type ImportStart } from './components/ImportDialog'
import { MenuIcon } from './components/icons'
import { Sidebar } from './components/Sidebar'
import { getAccessToken, pickSpreadsheet, signOutOfGoogle } from './google'
import { ChapterPage } from './pages/ChapterPage'
import { HomePage } from './pages/HomePage'
import { LoginPage } from './pages/LoginPage'
import { MentorsPage } from './pages/MentorsPage'
import { SheetPage } from './pages/SheetPage'
import { SignupsPage } from './pages/SignupsPage'
import { UndoProvider } from './undo'
import type { AppConfig, CurrentUser, Sheet } from './types'

const COLLAPSED_KEY = 'sidebar-collapsed'
// Matches the CSS breakpoint where the sidebar becomes a slide-in menu.
const DESKTOP = '(min-width: 1101px)'

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const list = window.matchMedia(query)
    const update = () => setMatches(list.matches)
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [query])
  return matches
}

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [user, setUser] = useState<CurrentUser | null | undefined>(undefined)
  const [sheets, setSheets] = useState<Sheet[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const isDesktop = useMediaQuery(DESKTOP)
  const [importing, setImporting] = useState<ImportStart | null>(null)
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

  // Straight from the click to Google (consent the first time, then the Picker) so the popup isn't blocked.
  async function startImport() {
    setMenuOpen(false)
    try {
      const token = await getAccessToken(config!)
      const file = await pickSpreadsheet(config!, token)
      if (file) setImporting({ file })
    } catch (err) {
      setImporting({ error: errorMessage(err, 'Couldn’t open Google Drive.') })
    }
  }

  function toggleCollapsed() {
    const next = !collapsed
    setCollapsed(next)
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
    } catch {
      // Only a convenience; it just won't be remembered.
    }
  }

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
      <UndoProvider>
      <div className="shell">
        <Sidebar
          open={menuOpen}
          collapsed={collapsed && isDesktop}
          onToggleCollapsed={toggleCollapsed}
          onNavigate={() => setMenuOpen(false)}
          onAddSheet={startImport}
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
              <Route path="/" element={<HomePage onAddSheet={startImport} />} />
              <Route path="/sheets/:sheetId" element={<SheetPage />} />
              <Route path="/sheets/:sheetId/signups" element={<SignupsPage />} />
              <Route path="/mentors" element={<MentorsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
        {importing && (
          <ImportDialog
            start={importing}
            onClose={() => setImporting(null)}
            onImported={(sheet, plan) => {
              setImporting(null)
              refreshSheets().catch(() => {})
              navigate(`/sheets/${sheet.id}`, plan ? { state: { sheet, plan } } : undefined)
            }}
          />
        )}
      </div>
      </UndoProvider>
    </AppContext.Provider>
  )
}
