import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { api, ApiError, errorMessage } from '../api'
import { useApp } from '../appContext'
import { CheckInPanel } from '../components/CheckInPanel'
import { RefreshIcon, TrashIcon } from '../components/icons'
import { TablesBoard } from '../components/TablesBoard'
import { getAccessToken, NoAccessError, pickSpreadsheet, readTab } from '../google'
import { parseSheet } from '../sheetParser'
import type { SeatingPlan, Sheet } from '../types'

// Several volunteers may check people in at once; keep everyone's view fresh.
const REFRESH_MS = 20_000

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

function CapacityField({ sheet, onSaved }: { sheet: Sheet; onSaved: (sheet: Sheet) => void }) {
  const [value, setValue] = useState(sheet.capacity?.toString() ?? '')
  const [error, setError] = useState(false)
  useEffect(() => setValue(sheet.capacity?.toString() ?? ''), [sheet.capacity])

  async function save() {
    const capacity = value.trim() === '' ? null : Math.max(0, Math.floor(Number(value)))
    if (capacity !== null && Number.isNaN(capacity)) return setValue(sheet.capacity?.toString() ?? '')
    if (capacity === sheet.capacity) return
    try {
      onSaved(await api.setCapacity(sheet.id, capacity))
      setError(false)
    } catch {
      setError(true)
    }
  }

  return (
    <label className={`capacity-field${error ? ' has-error' : ''}`}>
      Capacity
      <input
        type="number"
        min={0}
        inputMode="numeric"
        value={value}
        placeholder="None"
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </label>
  )
}

export function SheetPage() {
  const sheetId = Number(useParams().sheetId)
  const { config, refreshSheets } = useApp()
  const navigate = useNavigate()
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [plan, setPlan] = useState<SeatingPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [resyncing, setResyncing] = useState(false)

  const load = useCallback(
    () => Promise.all([api.getSheet(sheetId), api.getPlan(sheetId)]).then(([s, p]) => {
      setSheet(s)
      setPlan(p)
    }),
    [sheetId],
  )

  useEffect(() => {
    let active = true
    setSheet(null)
    setPlan(null)
    setNotice(null)
    setError(null)
    const refresh = () =>
      load().catch((err) => {
        if (!active) return
        if (err instanceof ApiError && err.status === 404) navigate('/', { replace: true })
        else setError(errorMessage(err, 'Couldn’t load this sheet.'))
      })
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [load, navigate])

  async function resync() {
    if (!sheet) return
    setResyncing(true)
    setError(null)
    setNotice(null)
    try {
      await getAccessToken(config)
      let data
      try {
        data = await readTab(config, sheet.spreadsheet_id, sheet.tab_id)
      } catch (err) {
        if (!(err instanceof NoAccessError)) throw err
        // Someone else imported it: this person has to pick the file once before the app can read it.
        const picked = await pickSpreadsheet(config, await getAccessToken(config), sheet.spreadsheet_id)
        if (!picked) return
        data = await readTab(config, sheet.spreadsheet_id, sheet.tab_id)
      }
      const parsed = parseSheet(data.values, { fieldMap: sheet.field_map })
      const result = await api.resyncSheet(sheet.id, {
        spreadsheet_title: data.spreadsheetTitle,
        tab_title: data.tabTitle,
        field_map: parsed.fieldMap,
        rows: parsed.rows,
      })
      setSheet(result.sheet)
      setPlan(await api.getPlan(sheet.id))
      setNotice(`Re-synced: ${result.added} new, ${result.removed} removed, ${result.updated} kept.`)
      refreshSheets().catch(() => {})
    } catch (err) {
      setError(errorMessage(err, 'Re-sync failed.'))
    } finally {
      setResyncing(false)
    }
  }

  async function remove() {
    if (!sheet) return
    if (!window.confirm(`Delete this import of “${sheet.spreadsheet_title}”? Check-ins and tables for it are deleted too. The Google Sheet isn’t touched.`)) return
    try {
      await api.deleteSheet(sheet.id)
      await refreshSheets()
      navigate('/', { replace: true })
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t delete the sheet.'))
    }
  }

  if (!sheet || !plan) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheet.spreadsheet_id)}/edit#gid=${sheet.tab_id}`

  return (
    <div className="sheet-page">
      <header className="sheet-head">
        <div className="sheet-head-titles">
          <h1>{sheet.spreadsheet_title}</h1>
          <p className="muted">
            <a href={sheetUrl} target="_blank" rel="noreferrer">
              {sheet.tab_title}
            </a>{' '}
            · {sheet.signup_count} sign-ups · imported {day(sheet.imported_at)}
            {sheet.imported_by && ` by ${sheet.imported_by}`} · synced {when(sheet.synced_at)} · deleted automatically{' '}
            {day(sheet.expires_at)}
          </p>
        </div>
        <div className="sheet-head-actions">
          <CapacityField sheet={sheet} onSaved={setSheet} />
          <button type="button" className="with-icon" onClick={resync} disabled={resyncing}>
            <RefreshIcon /> {resyncing ? 'Re-syncing…' : 'Re-sync'}
          </button>
          <button type="button" className="chip-icon" onClick={remove} aria-label="Delete this import" title="Delete this import">
            <TrashIcon />
          </button>
        </div>
      </header>
      {notice && <p className="sheet-notice" role="status">{notice}</p>}
      {error && <p className="error">{error}</p>}

      <div className="sheet-layout">
        <CheckInPanel
          sheet={sheet}
          plan={plan}
          onChange={(update) => setPlan((p) => (p ? update(p) : p))}
          onReload={() => api.getPlan(sheet.id).then(setPlan).catch(() => {})}
          onResync={resync}
          resyncing={resyncing}
        />
        <TablesBoard sheetId={sheet.id} plan={plan} setPlan={setPlan} />
      </div>
    </div>
  )
}
