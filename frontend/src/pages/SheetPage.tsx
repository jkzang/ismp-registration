import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { api, ApiError, errorMessage } from '../api'
import { useApp } from '../appContext'
import { CheckInPanel } from '../components/CheckInPanel'
import { CheckIcon, CloseIcon, PencilIcon, RefreshIcon, WarningIcon } from '../components/icons'
import { TablesBoard } from '../components/TablesBoard'
import { useAttendanceSync, type AttendanceStatus } from '../attendanceSync'
import { getAccessToken, NoAccessError, pickSpreadsheet, readDatabaseTab, readTab, writeCells } from '../google'
import { importWarnings } from '../sheetParser'
import { parseWithDatabase } from '../studentDatabase'
import { sheetName, type SeatingPlan, type Sheet } from '../types'
import { useUndo } from '../undo'
import { RESERVE_MINUTES } from '../capacity'

// Several volunteers may check people in at once; keep everyone's view fresh.
const REFRESH_MS = 20_000

function CapacityField({ sheet, onSaved }: { sheet: Sheet; onSaved: (sheet: Sheet) => void }) {
  const { push } = useUndo()
  const [value, setValue] = useState(sheet.capacity?.toString() ?? '')
  const [error, setError] = useState(false)
  useEffect(() => setValue(sheet.capacity?.toString() ?? ''), [sheet.capacity])

  async function save() {
    const capacity = value.trim() === '' ? null : Math.max(0, Math.floor(Number(value)))
    if (capacity !== null && Number.isNaN(capacity)) return setValue(sheet.capacity?.toString() ?? '')
    if (capacity === sheet.capacity) return
    const before = sheet.capacity
    const setCapacity = (value: number | null) => async () => onSaved(await api.updateSheet(sheet.id, { capacity: value }))
    try {
      await setCapacity(capacity)()
      push({ label: 'the capacity change', undo: setCapacity(before), redo: setCapacity(capacity) })
      setError(false)
    } catch {
      setError(true)
    }
  }

  return (
    <label className={`capacity-field${error ? ' has-error' : ''}`} title="Capacity">
      <span>Capacity</span>
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

// A datetime-local input's value, in the browser's time zone.
function toLocalInput(iso: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** When the event starts; confirmed people's spots are reserved until a little after. */
function StartField({ sheet, onSaved }: { sheet: Sheet; onSaved: (sheet: Sheet) => void }) {
  const { push } = useUndo()
  const [value, setValue] = useState(toLocalInput(sheet.starts_at))
  const [error, setError] = useState(false)
  useEffect(() => setValue(toLocalInput(sheet.starts_at)), [sheet.starts_at])

  async function save() {
    const startsAt = value ? new Date(value).toISOString() : null
    if (value === toLocalInput(sheet.starts_at)) return
    const before = sheet.starts_at
    const setStart = (value: string | null) => async () => onSaved(await api.updateSheet(sheet.id, { starts_at: value }))
    try {
      await setStart(startsAt)()
      push({ label: 'the start time change', undo: setStart(before), redo: setStart(startsAt) })
      setError(false)
    } catch {
      setError(true)
    }
  }

  return (
    <label
      className={`capacity-field start-field${error ? ' has-error' : ''}`}
      title={`Confirmed people’s spots are reserved until ${RESERVE_MINUTES} minutes after this`}
    >
      <span>Starts</span>
      <input
        type="datetime-local"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </label>
  )
}

/** The sheet's name, linking to its Google Sheets tab, with a pencil to rename it. Clearing the name
 *  goes back to the tab's title. */
function SheetTitle({ sheet, url, onSaved }: { sheet: Sheet; url: string; onSaved: (sheet: Sheet) => void }) {
  const { refreshSheets } = useApp()
  const { push } = useUndo()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState(false)
  const cancelled = useRef(false)

  async function rename(name: string) {
    onSaved(await api.updateSheet(sheet.id, { name }))
    refreshSheets().catch(() => {})
  }

  async function save() {
    const name = value.trim() === sheet.tab_title ? '' : value.trim()
    if (cancelled.current || name === sheet.name) {
      cancelled.current = false
      setEditing(false)
      setError(false)
      return
    }
    const before = sheet.name
    try {
      await rename(name)
      push({ label: 'the rename', undo: () => rename(before), redo: () => rename(name) })
      setEditing(false)
      setError(false)
    } catch {
      setError(true)
    }
  }

  if (editing) {
    return (
      <h1 className="sheet-title is-editing">
        <input
          className={`sheet-title-input${error ? ' has-error' : ''}`}
          value={value}
          maxLength={200}
          aria-label="Sheet name"
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              cancelled.current = true
              e.currentTarget.blur()
            }
          }}
        />
      </h1>
    )
  }

  return (
    <h1 className="sheet-title">
      <a href={url} target="_blank" rel="noreferrer" title={`Open “${sheet.tab_title}” in ${sheet.spreadsheet_title}`}>
        {sheetName(sheet)}
      </a>
      <button
        type="button"
        className="chip-icon sheet-rename"
        aria-label="Rename"
        title="Rename"
        onClick={() => {
          setValue(sheetName(sheet))
          setEditing(true)
        }}
      >
        <PencilIcon />
      </button>
    </h1>
  )
}

/** Whether check-ins are reaching the Google Sheet's attendance checkboxes. Quiet when all is well. */
function AttendanceChip({ status, onConnect, onRetry }: { status: AttendanceStatus; onConnect: () => void; onRetry: () => void }) {
  switch (status.kind) {
    case 'idle':
      return null
    case 'saving':
      return <span className="attendance-chip is-quiet">Saving attendance…</span>
    case 'saved':
      return (
        <span className="attendance-chip is-quiet" title="Check-ins are ticked in the sheet’s attendance column">
          <CheckIcon /> Attendance saved
        </span>
      )
    case 'no-column':
      return <span className="attendance-chip is-quiet" title={status.message}>No attendance column</span>
    case 'needs-access':
      return (
        <button type="button" className="attendance-chip is-alert" onClick={onConnect} title="Attendance isn’t reaching the sheet from this device">
          Connect Google Sheets
        </button>
      )
    case 'error':
      return (
        <button type="button" className="attendance-chip is-alert" onClick={onRetry} title={status.message}>
          Attendance not saved · Retry
        </button>
      )
  }
}

/** A quiet count of formatting warnings that opens to the list; nothing when the tab looked fine. */
function WarningsChip({ warnings }: { warnings: string[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!warnings.length) return null
  return (
    <div className="warnings-chip" ref={ref}>
      <button type="button" className="attendance-chip is-warn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <WarningIcon /> {warnings.length} {warnings.length === 1 ? 'warning' : 'warnings'}
      </button>
      {open && (
        <div className="warnings-popover" role="dialog" aria-label="Import warnings">
          <ul>
            {warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
          <p className="muted">Fix these in Google Sheets, then Re-sync.</p>
        </div>
      )}
    </div>
  )
}

export function SheetPage() {
  const sheetId = Number(useParams().sheetId)
  const { config, refreshSheets } = useApp()
  const { notify } = useUndo()
  const navigate = useNavigate()
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [plan, setPlan] = useState<SeatingPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resyncing, setResyncing] = useState(false)
  const attendance = useAttendanceSync(config, sheet, plan)
  // Narrow screens show one panel at a time.
  const [panel, setPanel] = useState<'checkin' | 'tables'>('checkin')

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

  /** Runs a Google Sheets call, first getting a token (call from a click, for the popup). Null if
   *  the person closes the Picker. */
  async function withSheetAccess<T>(sheet: Sheet, run: () => Promise<T>): Promise<T | null> {
    await getAccessToken(config)
    try {
      return await run()
    } catch (err) {
      if (!(err instanceof NoAccessError)) throw err
      // Someone else imported it: this person has to pick the file once before the app can use it.
      const picked = await pickSpreadsheet(config, await getAccessToken(config), sheet.spreadsheet_id)
      return picked ? run() : null
    }
  }

  async function resync() {
    if (!sheet) return
    setResyncing(true)
    setError(null)
    try {
      const data = await withSheetAccess(sheet, () => readTab(config, sheet.spreadsheet_id, sheet.tab_id))
      if (!data) return
      const database = await readDatabaseTab(config, sheet.spreadsheet_id, data.tabs, sheet.tab_id)
      const { parsed, fills } = parseWithDatabase(data.values, database, { fieldMap: sheet.field_map })
      // Doesn't hold up the re-sync; the filled values are imported either way.
      let writeError: string | null = null
      try {
        await writeCells(config, sheet.spreadsheet_id, data.tabTitle, fills)
      } catch (err) {
        writeError = errorMessage(err, 'Couldn’t write to the sheet.')
      }
      const result = await api.resyncSheet(sheet.id, {
        spreadsheet_title: data.spreadsheetTitle,
        tab_title: data.tabTitle,
        field_map: parsed.fieldMap,
        rows: parsed.rows,
        warnings: importWarnings(parsed),
      })
      setSheet(result.sheet)
      setPlan(await api.getPlan(sheet.id))
      const changes = [
        result.added && `${result.added} added`,
        result.removed && `${result.removed} removed`,
        fills.length && `${fills.length} filled from Student Database${writeError ? ' (not written to the sheet)' : ''}`,
      ].filter(Boolean)
      notify(changes.length ? `Re-synced: ${changes.join(' · ')}` : 'Re-synced: no new or removed sign-ups')
      if (writeError) setError(`The values from the Student Database weren’t written to the sheet: ${writeError}`)
      refreshSheets().catch(() => {})
    } catch (err) {
      setError(errorMessage(err, 'Re-sync failed.'))
    } finally {
      setResyncing(false)
    }
  }

  if (!sheet || !plan) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheet.spreadsheet_id)}/edit#gid=${sheet.tab_id}`

  return (
    <div className={`sheet-page shows-${panel}`}>
      <header className="sheet-head">
        <div className="sheet-heading">
          <SheetTitle sheet={sheet} url={sheetUrl} onSaved={setSheet} />
        </div>
        <div className="sheet-head-actions">
          <WarningsChip warnings={sheet.warnings} />
          <AttendanceChip status={attendance.status} onConnect={attendance.connect} onRetry={attendance.retry} />
          <StartField sheet={sheet} onSaved={setSheet} />
          <CapacityField sheet={sheet} onSaved={setSheet} />
          <button
            type="button"
            className={`with-icon${resyncing ? ' is-syncing' : ''}`}
            onClick={resync}
            disabled={resyncing}
            aria-busy={resyncing}
            title={resyncing ? 'Syncing…' : 'Pull new sign-ups from Google Sheets'}
          >
            {/* Same label while syncing, so the buttons beside it don't shift. */}
            <RefreshIcon /> Re-sync
          </button>
        </div>
      </header>
      {error && (
        <p className="error sheet-message" role="alert">
          {error}
          <button type="button" className="chip-icon" aria-label="Dismiss" onClick={() => setError(null)}>
            <CloseIcon />
          </button>
        </p>
      )}

      <div className="panel-switch segmented" role="tablist" aria-label="View">
        <button type="button" role="tab" aria-selected={panel === 'checkin'} className={panel === 'checkin' ? 'is-on' : ''} onClick={() => setPanel('checkin')}>
          Check-in
        </button>
        <button type="button" role="tab" aria-selected={panel === 'tables'} className={panel === 'tables' ? 'is-on' : ''} onClick={() => setPanel('tables')}>
          Tables
        </button>
      </div>

      <div className="sheet-layout">
        <CheckInPanel
          sheet={sheet}
          plan={plan}
          onChange={(update) => setPlan((p) => (p ? update(p) : p))}
          onReload={() => api.getPlan(sheet.id).then(setPlan).catch(() => {})}
          onAttendance={attendance.record}
          onSheetChange={setSheet}
        />
        <TablesBoard sheetId={sheet.id} plan={plan} setPlan={setPlan} />
      </div>
    </div>
  )
}
