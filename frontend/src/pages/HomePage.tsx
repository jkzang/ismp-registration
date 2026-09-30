import { Navigate } from 'react-router'
import { useApp } from '../appContext'
import { PlusIcon } from '../components/icons'

export function HomePage({ onAddSheet }: { onAddSheet: () => void }) {
  const { sheets, config } = useApp()
  if (sheets === null) return <p className="muted">Loading…</p>
  if (sheets.length > 0) return <Navigate to={`/sheets/${sheets[0].id}`} replace />
  return (
    <div className="empty-state">
      <h2>No sign up sheets yet</h2>
      <p>Import a Google Sheets tab of sign-ups to get a check-in list and table assignments.</p>
      <button type="button" className="primary with-icon" onClick={onAddSheet}>
        <PlusIcon /> Add sign up sheet
      </button>
      <p className="muted">
        Only names, nicknames, gender, enrollment and contact status are imported. Imports are deleted {config.retention_days}{' '}
        days after their last re-sync.
      </p>
    </div>
  )
}
