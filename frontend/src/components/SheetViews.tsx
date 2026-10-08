import { NavLink } from 'react-router'

/** Switches between a sheet's Sign-ups page (reaching people beforehand) and its check-in page. */
export function SheetViews({ sheetId }: { sheetId: number }) {
  const className = ({ isActive }: { isActive: boolean }) => (isActive ? 'is-on' : '')
  return (
    <nav className="segmented sheet-views" aria-label="Sheet views">
      <NavLink to={`/sheets/${sheetId}/signups`} className={className}>
        Sign-ups
      </NavLink>
      <NavLink to={`/sheets/${sheetId}`} end className={className}>
        Check-in
      </NavLink>
    </nav>
  )
}
