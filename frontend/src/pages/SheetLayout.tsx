import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate, useParams } from 'react-router'
import { api, ApiError, errorMessage } from '../api'
import { useApp } from '../appContext'
import { useAttendanceSync, type AttendanceStatus } from '../attendanceSync'
import { RESERVE_MINUTES } from '../capacity'
import { useCheckInTabSync, type CheckInTabStatus } from '../checkInTabSync'
import { CheckIcon, CloseIcon, PencilIcon, RefreshIcon, WarningIcon } from '../components/icons'
import { SheetViews } from '../components/SheetViews'
import { getAccessToken, NeedsSignInError, NoAccessError, readTab, withSheetAccess } from '../google'
import { toLocalInput } from '../localTime'
import { describeResync, readForSync, resyncSheet } from '../resync'
import { SheetContext, type SheetRead } from '../sheetContext'
import { readContacts } from '../signupTracker'
import { sheetName, signupsKey, type SeatingPlan, type Sheet } from '../types'
import { useUndo } from '../undo'

// Several volunteers may check people in at once; keep everyone's view fresh.
const REFRESH_MS = 20_000
// How often the sign-up tab itself is read, so changes made in the sheet come in without a Re-sync.
const SHEET_READ_MS = 30_000

type Cached = { sheet: Sheet; plan: SeatingPlan; read: SheetRead | null }
// What each sheet's pages last had, so coming back to a sheet shows it at once.
const cache = new Map<number, Cached>()

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

/** Only when the "- Check In" tab isn't keeping up. Needing sign-in is left to the attendance chip when it asks too. */
function CheckInTabChip({ status, attendance, onConnect, onRetry }: {
  status: CheckInTabStatus
  attendance: AttendanceStatus
  onConnect: () => void
  onRetry: () => void
}) {
  if (status.kind === 'needs-access' && attendance.kind !== 'needs-access') {
    return (
      <button type="button" className="attendance-chip is-alert" onClick={onConnect} title="The check-in tab isn’t being updated from this device">
        Connect Google Sheets
      </button>
    )
  }
  if (status.kind === 'error') {
    return (
      <button type="button" className="attendance-chip is-alert" onClick={onRetry} title={status.message}>
        Check-in tab not updated · Retry
      </button>
    )
  }
  return null
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

/**
 * A sheet's header (name, Check-in and Sign-ups, Start, Capacity, Re-sync) over whichever of its two
 * pages is open. The header and everything the pages share stay put while switching between them:
 * the sheet, its plan and the tab as last read are loaded once and kept up to date in the
 * background, and Re-sync reads the sheet now. The sheet is the source of truth: whatever changes
 * there reaches both pages and check-in.
 */
export function SheetLayout() {
  const sheetId = Number(useParams().sheetId)
  const { config, refreshSheets } = useApp()
  const { notify } = useUndo()
  const navigate = useNavigate()
  // A fresh import hands over the sheet and plan it just loaded, so the page doesn't blank out to load them again.
  const state = useLocation().state as { sheet: Sheet; plan: SeatingPlan } | null
  const preloaded = state?.sheet?.id === sheetId ? state : null
  const cached = cache.get(sheetId)
  const [sheet, setSheet] = useState<Sheet | null>(preloaded?.sheet ?? cached?.sheet ?? null)
  const [plan, setPlan] = useState<SeatingPlan | null>(preloaded?.plan ?? cached?.plan ?? null)
  const [read, setRead] = useState<SheetRead | null>(cached?.read ?? null)
  const [access, setAccess] = useState<'checking' | 'needs-access' | 'ok'>(cached?.read ? 'ok' : 'checking')
  const [tendError, setTendError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  // A re-sync changed the sign-ups the tables were planned for, and nobody has answered whether to re-plan.
  const [signupsChanged, setSignupsChanged] = useState(false)
  const attendance = useAttendanceSync(config, sheet, plan)
  const checkInTab = useCheckInTabSync(config, sheet, plan)

  const sheetRef = useRef(sheet)
  sheetRef.current = sheet
  const planRef = useRef(plan)
  planRef.current = plan
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const writes = useRef({ running: 0, done: 0 })

  useEffect(() => {
    if (sheet && plan && sheet.id === sheetId) cache.set(sheetId, { sheet, plan, read })
  }, [sheetId, sheet, plan, read])

  /** Takes a fresh plan, and asks about re-planning when the sign-ups it was planned for changed. */
  const takePlan = useCallback((next: SeatingPlan) => {
    const before = planRef.current
    // Once check-in starts the tables are set, so there's nothing to ask.
    const planned = next.tables.length > 0 && !next.students.some((s) => s.checked_in)
    if (!planned) setSignupsChanged(false)
    else if (before && signupsKey(next) !== signupsKey(before)) setSignupsChanged(true)
    planRef.current = next
    setPlan(next)
  }, [])

  // A different sheet starts from what this browser last had of it.
  useEffect(() => {
    const cached = cache.get(sheetId)
    setSheet(preloaded?.sheet ?? cached?.sheet ?? null)
    setPlan(preloaded?.plan ?? cached?.plan ?? null)
    setRead(cached?.read ?? null)
    setAccess(cached?.read ? 'ok' : 'checking')
    setTendError(null)
    setError(null)
    setSignupsChanged(false)
  }, [sheetId, preloaded])

  // The app's side (other volunteers' check-ins and tables), every 20 seconds.
  useEffect(() => {
    let active = true
    const refresh = () =>
      Promise.all([api.getSheet(sheetId), api.getPlan(sheetId)])
        .then(([s, p]) => {
          if (!active) return
          setSheet(s)
          takePlan(p)
        })
        .catch((err) => {
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
  }, [sheetId, navigate, takePlan])

  const reading = useRef(false)
  /**
   * Reads (and tends) the sign-up tab and sends any change on to check-in. In the background it
   * never opens Google's popup; from a click (`interactive`) it may, and it's a Re-sync: it always
   * sends, and says what changed.
   */
  const readSheet = useCallback(
    async (interactive: boolean) => {
      const current = sheetRef.current
      if (!current) return
      if (!interactive && (reading.current || document.visibilityState !== 'visible')) return
      reading.current = true
      if (interactive) {
        setSyncing(true)
        setError(null)
      }
      const before = writes.current.done
      try {
        const run = () => readTab(config, current.spreadsheet_id, current.tab_id)
        if (!interactive) await getAccessToken(config, { interactive: false })
        const data = await readForSync(config, current, interactive ? () => withSheetAccess(config, current.spreadsheet_id, run) : run)
        if (!data || sheetRef.current?.id !== current.id) return
        // A status written meanwhile may not be in this read; the next one has it.
        if (writes.current.running || writes.current.done !== before) return
        setRead(readContacts(data.values, current.field_map))
        setTendError(data.tendError ?? null)
        setAccess('ok')
        const synced = await resyncSheet(
          config,
          current,
          data,
          interactive ? {} : { auto: true, knownKeys: planRef.current?.students.map((s) => s.key) },
        )
        if (sheetRef.current?.id !== current.id) return
        if (synced) {
          setSheet(synced.result.sheet)
          takePlan(await api.getPlan(current.id))
        } else if (interactive) {
          // Another volunteer's device synced the sheet even more recently.
          takePlan(await api.getPlan(current.id))
        }
        if (interactive) {
          notify(synced ? describeResync(synced) : 'Re-synced: already up to date')
          if (synced?.writeError) setError(`The values from the Student Database weren’t written to the sheet: ${synced.writeError}`)
          refreshSheets().catch(() => {})
        }
      } catch (err) {
        if (err instanceof NeedsSignInError || err instanceof NoAccessError) setAccess('needs-access')
        else if (interactive) setError(errorMessage(err, 'Re-sync failed.'))
      } finally {
        reading.current = false
        if (interactive) setSyncing(false)
      }
    },
    [config, notify, refreshSheets, takePlan],
  )

  // The sheet every 30 seconds and on coming back to the window; switching pages doesn't read it again.
  const loadedId = sheet?.id
  const hasRead = read !== null
  useEffect(() => {
    if (loadedId === undefined) return
    const refresh = () => readSheet(false)
    if (!hasRead) refresh()
    const timer = setInterval(refresh, SHEET_READ_MS)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
    // Only when the sheet changes: a read already had is kept, and the timer does the rest.
  }, [loadedId, readSheet])

  if (!sheet || !plan) {
    return error ? <p className="error">{error}</p> : (
      <p className="muted loading-line" role="status">
        <span className="spinner" aria-hidden="true" /> Loading the sheet…
      </p>
    )
  }

  const sheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheet.spreadsheet_id)}/edit#gid=${sheet.tab_id}`
  const connect = () => attendance.connect().then(() => Promise.all([checkInTab.retry(), readSheet(true)]))

  return (
    <SheetContext.Provider
      value={{
        sheet,
        setSheet,
        plan,
        setPlan,
        read,
        setRead,
        access,
        tendError,
        readSheet,
        queue,
        writes,
        setError,
        signupsChanged,
        onReplanAnswered: () => setSignupsChanged(false),
        attendance,
      }}
    >
      <div className="sheet-page">
        <header className="sheet-head">
          <div className="sheet-heading">
            <SheetTitle sheet={sheet} url={sheetUrl} onSaved={setSheet} />
            <SheetViews sheetId={sheet.id} />
          </div>
          <div className="sheet-head-actions">
            <WarningsChip warnings={sheet.warnings} />
            <AttendanceChip status={attendance.status} onConnect={attendance.connect} onRetry={attendance.retry} />
            <CheckInTabChip status={checkInTab.status} attendance={attendance.status} onConnect={connect} onRetry={checkInTab.retry} />
            {access === 'needs-access' && attendance.status.kind !== 'needs-access' && checkInTab.status.kind !== 'needs-access' && (
              <button type="button" className="attendance-chip is-alert" onClick={() => readSheet(true)} title="This device can’t reach the sheet right now">
                Connect Google Sheets
              </button>
            )}
            <StartField sheet={sheet} onSaved={setSheet} />
            <CapacityField sheet={sheet} onSaved={setSheet} />
            <button
              type="button"
              className={`with-icon resync-button${syncing ? ' is-syncing' : ''}`}
              onClick={() => readSheet(true)}
              disabled={syncing}
              aria-busy={syncing}
              title={syncing ? 'Syncing…' : 'Changes in Google Sheets come in by themselves every 30 seconds; this reads the sheet now'}
            >
              {/* Same label and a fixed width while syncing, so the buttons beside it don't shift. */}
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
        <Outlet />
      </div>
    </SheetContext.Provider>
  )
}
