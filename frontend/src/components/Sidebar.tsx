import { Link, NavLink } from 'react-router'
import { useApp } from '../appContext'
import { MentorIcon, PlusIcon } from './icons'

function initials(name: string) {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export function Sidebar({ open, onNavigate, onAddSheet, onLogout }: {
  open: boolean
  onNavigate: () => void
  onAddSheet: () => void
  onLogout: () => void
}) {
  const { user, sheets } = useApp()
  return (
    <aside className={`sidebar${open ? ' is-open' : ''}`} aria-label="Sign up sheets">
      <Link to="/" className="sidebar-brand" onClick={onNavigate}>
        <span className="brand-mark" aria-hidden="true">IR</span>
        <span className="brand-name">ISMP Registration</span>
      </Link>
      <button type="button" className="primary with-icon sidebar-create" onClick={onAddSheet}>
        <PlusIcon /> Add sign up sheet
      </button>
      <nav className="sidebar-nav sheet-nav" aria-label="Imported sign up sheets">
        {sheets === null ? (
          <p className="muted sheet-nav-note">Loading…</p>
        ) : sheets.length === 0 ? (
          <p className="muted sheet-nav-note">No sheets imported yet.</p>
        ) : (
          sheets.map((sheet) => (
            <NavLink
              key={sheet.id}
              to={`/sheets/${sheet.id}`}
              className={({ isActive }) => `sheet-link${isActive ? ' active' : ''}`}
              onClick={onNavigate}
            >
              <span className="sheet-link-title">{sheet.spreadsheet_title}</span>
              <span className="sheet-link-meta">
                {sheet.tab_title} · {shortDate(sheet.imported_at)}
              </span>
            </NavLink>
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
    </aside>
  )
}
