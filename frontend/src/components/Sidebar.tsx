import { useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router'
import { api, errorMessage } from '../api'
import { useApp } from '../appContext'
import { sheetName, type Sheet } from '../types'
import { ConfirmDialog } from './ConfirmDialog'
import { MentorIcon, PlusIcon, SidebarIcon, TrashIcon } from './icons'

function initials(name: string) {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export function Sidebar({ open, collapsed, onToggleCollapsed, onNavigate, onAddSheet, onLogout }: {
  /** Phones: slid in over the page. */
  open: boolean
  /** Desktop: folded down to a narrow rail. */
  collapsed: boolean
  onToggleCollapsed: () => void
  onNavigate: () => void
  onAddSheet: () => void
  onLogout: () => void
}) {
  const { user, sheets, refreshSheets } = useApp()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [deleting, setDeleting] = useState<Sheet | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function remove(sheet: Sheet) {
    setDeleting(null)
    try {
      await api.deleteSheet(sheet.id)
      setError(null)
      if (pathname === `/sheets/${sheet.id}`) navigate('/', { replace: true })
      await refreshSheets()
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t delete the sheet.'))
    }
  }

  return (
    <aside className={`sidebar${open ? ' is-open' : ''}${collapsed ? ' is-collapsed' : ''}`} aria-label="Sign up sheets">
      <div className="sidebar-rail" aria-hidden={!collapsed} inert={!collapsed}>
        <button type="button" className="icon-button" onClick={onToggleCollapsed} aria-label="Expand sidebar" title="Expand sidebar">
          <SidebarIcon />
        </button>
        <button type="button" className="icon-button" onClick={onAddSheet} aria-label="Add sign up sheet" title="Add sign up sheet">
          <PlusIcon />
        </button>
        <NavLink
          to="/mentors"
          className={({ isActive }) => `icon-button${isActive ? ' active' : ''}`}
          aria-label="Mentors"
          title="Mentors"
        >
          <MentorIcon />
        </NavLink>
        <button
          type="button"
          className="avatar sidebar-rail-avatar"
          onClick={onToggleCollapsed}
          aria-label={`${user.display_name || 'Signed in'}. Expand sidebar for account options`}
          title={[user.display_name, user.chapter?.name].filter(Boolean).join(' · ')}
        >
          {initials(user.display_name)}
        </button>
      </div>

      <div className="sidebar-full" aria-hidden={collapsed} inert={collapsed}>
        <div className="sidebar-top">
          <Link to="/" className="sidebar-brand" onClick={onNavigate}>
            <span className="brand-mark" aria-hidden="true">IR</span>
            <span className="brand-name">ISMP Registration</span>
          </Link>
          <button
            type="button"
            className="icon-button sidebar-collapse"
            onClick={onToggleCollapsed}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <SidebarIcon />
          </button>
        </div>
        <button type="button" className="primary with-icon sidebar-create" onClick={onAddSheet}>
          <PlusIcon /> Add sign up sheet
        </button>
        <nav className="sidebar-nav sheet-nav" aria-label="Imported sign up sheets">
          {error && <p className="error sheet-nav-note">{error}</p>}
          {sheets === null ? (
            <p className="muted sheet-nav-note">Loading…</p>
          ) : sheets.length === 0 ? (
            <p className="muted sheet-nav-note">No sheets imported yet.</p>
          ) : (
            sheets.map((sheet) => (
              <div key={sheet.id} className="sheet-item">
                <NavLink
                  to={`/sheets/${sheet.id}`}
                  className={({ isActive }) => `sheet-link${isActive ? ' active' : ''}`}
                  onClick={onNavigate}
                >
                  <span className="sheet-link-title">{sheetName(sheet)}</span>
                  <span className="sheet-link-meta">
                    {sheet.spreadsheet_title} · {shortDate(sheet.imported_at)}
                  </span>
                </NavLink>
                <button
                  type="button"
                  className="chip-icon sheet-delete"
                  onClick={() => setDeleting(sheet)}
                  aria-label={`Delete ${sheetName(sheet)}`}
                  title="Delete this import"
                >
                  <TrashIcon />
                </button>
              </div>
            ))
          )}
        </nav>
        <div className="sidebar-footer">
          <NavLink
            to="/mentors"
            className={({ isActive }) => `sidebar-link sidebar-mentors${isActive ? ' active' : ''}`}
            onClick={onNavigate}
          >
            <MentorIcon />
            <span>Mentors</span>
          </NavLink>
          <span className="avatar" aria-hidden="true">{initials(user.display_name)}</span>
          <div className="sidebar-user">
            <span className="sidebar-user-name">{user.display_name || 'Signed in'}</span>
            <span className="sidebar-user-branch">{user.chapter?.name}</span>
          </div>
          <button type="button" className="sidebar-logout" onClick={onLogout}>
            Log out
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete “${deleting ? sheetName(deleting) : ''}”?`}
        confirmLabel="Delete"
        danger
        onConfirm={() => deleting && remove(deleting)}
        onClose={() => setDeleting(null)}
      >
        Check-ins and tables for this import are deleted too. The Google Sheet isn’t touched.
      </ConfirmDialog>
    </aside>
  )
}
