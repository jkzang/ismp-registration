import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { api, ApiError, errorMessage } from '../api'
import { useApp } from '../appContext'
import { CloseIcon, MailIcon, MessageIcon, PhoneIcon, RefreshIcon, SearchIcon } from '../components/icons'
import { SheetViews } from '../components/SheetViews'
import {
  getAccessToken,
  NeedsSignInError,
  NoAccessError,
  readTab,
  withSheetAccess,
  writeStatus,
} from '../google'
import { describeResync, resyncSheet } from '../resync'
import {
  BEFORE_CONTACT,
  DEFAULT_MESSAGE,
  dialable,
  fillMessage,
  mailtoHref,
  readContacts,
  shortTimestamp,
  smsHref,
  STATUS_GROUPS,
  telHref,
  type Contact,
} from '../signupTracker'
import { CONTACT_STATUSES, sheetName, type ContactStatus, type PlanStudent, type Sheet } from '../types'
import { useUndo } from '../undo'

// Other volunteers (and the form) change the sheet too; re-read it now and then, and on coming back to the tab.
const REFRESH_MS = 30_000

const GENDER_LABELS = { female: 'Girl', male: 'Guy' } as const
const LEVEL_LABELS = { undergrad: 'Undergrad', grad: 'Grad', other: 'Not a student' } as const

type Read = ReturnType<typeof readContacts>

/** The Text and Email message, kept per sheet in this browser only. */
function useMessageTemplate(sheetId: number) {
  const key = `signup-message-${sheetId}`
  const [template, setTemplate] = useState(DEFAULT_MESSAGE)
  useEffect(() => {
    try {
      setTemplate(localStorage.getItem(key) ?? DEFAULT_MESSAGE)
    } catch {
      setTemplate(DEFAULT_MESSAGE)
    }
  }, [key])
  const save = useCallback(
    (next: string) => {
      setTemplate(next)
      try {
        if (next === DEFAULT_MESSAGE) localStorage.removeItem(key)
        else localStorage.setItem(key, next)
      } catch {
        // Only a convenience; it just won't be remembered.
      }
    },
    [key],
  )
  return [template, save] as const
}

/**
 * Everyone who signed up, newest first, for reaching out before the event: change their contact
 * status (written straight into the sheet's Contact Status column) and text, call or email them.
 * The sheet is read in this browser, so phone numbers and emails never reach the server.
 */
export function SignupsPage() {
  const sheetId = Number(useParams().sheetId)
  const { config, refreshSheets } = useApp()
  const { push, notify } = useUndo()
  const navigate = useNavigate()
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [students, setStudents] = useState<PlanStudent[] | null>(null)
  const [read, setRead] = useState<Read | null>(null)
  const [access, setAccess] = useState<'checking' | 'needs-access' | 'ok'>('checking')
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  // Statuses being written, shown right away.
  const [pending, setPending] = useState<Map<string, ContactStatus>>(new Map())
  const [group, setGroup] = useState('all')
  const [query, setQuery] = useState('')
  const [editingMessage, setEditingMessage] = useState(false)
  const [template, setTemplate] = useMessageTemplate(sheetId)

  const sheetRef = useRef(sheet)
  sheetRef.current = sheet
  const studentByKey = useMemo(() => new Map((students ?? []).map((s) => [s.key, s])), [students])
  const studentByKeyRef = useRef(studentByKey)
  studentByKeyRef.current = studentByKey
  // Status writes go out one at a time. A read that overlaps one may predate it, so it's dropped.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const writes = useRef({ running: 0, done: 0 })

  useEffect(() => {
    let active = true
    setSheet(null)
    setStudents(null)
    setRead(null)
    setAccess('checking')
    setError(null)
    setPending(new Map())
    const refresh = () =>
      Promise.all([api.getSheet(sheetId), api.getPlan(sheetId)])
        .then(([s, p]) => {
          if (!active) return
          setSheet(s)
          setStudents(p.students)
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
  }, [sheetId, navigate])

  /** With `interactive`, from a click: may open Google's sign-in and the Picker. */
  const readSheet = useCallback(
    async (current: Sheet, interactive: boolean) => {
      const before = writes.current.done
      setReading(true)
      try {
        const run = () => readTab(config, current.spreadsheet_id, current.tab_id)
        let data
        if (interactive) {
          data = await withSheetAccess(config, current.spreadsheet_id, run)
          if (!data) return
        } else {
          await getAccessToken(config, { interactive: false })
          data = await run()
        }
        if (sheetRef.current?.id !== current.id) return
        if (writes.current.running || writes.current.done !== before) return
        setRead(readContacts(data.values, current.field_map))
        setAccess('ok')
      } catch (err) {
        if (err instanceof NeedsSignInError || err instanceof NoAccessError) setAccess('needs-access')
        else setError(errorMessage(err, 'Couldn’t read the sheet.'))
      } finally {
        setReading(false)
      }
    },
    [config],
  )

  const loadedId = sheet?.id
  useEffect(() => {
    if (loadedId === undefined) return
    const refresh = () => {
      if (document.visibilityState === 'visible' && sheetRef.current) readSheet(sheetRef.current, false)
    }
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [loadedId, readSheet])

  /** Writes the status into the sheet, then into the app if they're in it yet. Throws when the sheet write fails. */
  const applyStatus = useCallback(
    async (key: string, status: ContactStatus) => {
      const current = sheetRef.current
      if (!current) return
      setPending((p) => new Map(p).set(key, status))
      writes.current.running++
      const run = queue.current.then(async () => {
        await writeStatus(config, current, key, status)
        setRead((r) => r && { ...r, contacts: r.contacts.map((c) => (c.key === key ? { ...c, status } : c)) })
        const student = studentByKeyRef.current.get(key)
        if (!student) return
        try {
          const { student: saved } = await api.setStatus(student.id, status)
          setStudents((list) => list && list.map((s) => (s.id === saved.id ? saved : s)))
        } catch {
          setError('The status was saved in the sheet but not in the app. Re-sync on the Check-in page to catch it up.')
        }
      })
      queue.current = run.catch(() => {})
      try {
        await run
      } finally {
        writes.current.running--
        writes.current.done++
        setPending((p) => {
          if (p.get(key) !== status) return p
          const next = new Map(p)
          next.delete(key)
          return next
        })
      }
    },
    [config],
  )

  const statusOfContact = (contact: Contact) => pending.get(contact.key) ?? contact.status

  /** True once saved; undoable with Ctrl/Cmd+Z. */
  async function changeStatus(contact: Contact, status: ContactStatus) {
    const before = statusOfContact(contact)
    if (before === status) return false
    setError(null)
    try {
      await applyStatus(contact.key, status)
      push({
        label: `${contact.name}’s status`,
        undo: () => applyStatus(contact.key, before),
        redo: () => applyStatus(contact.key, status),
      })
      return true
    } catch (err) {
      if (err instanceof NeedsSignInError || err instanceof NoAccessError) setAccess('needs-access')
      setError(errorMessage(err, 'Couldn’t change the status.'))
      return false
    }
  }

  /** Texting, calling or emailing someone not reached yet moves them to Awaiting response. */
  function contacted(contact: Contact) {
    if (!read?.columns.status || !BEFORE_CONTACT.includes(statusOfContact(contact))) return
    changeStatus(contact, 'awaiting_response').then((saved) => {
      if (saved) notify(`${contact.name} is now Awaiting response`)
    })
  }

  async function connect() {
    if (!sheet) return
    setError(null)
    await readSheet(sheet, true)
  }

  /** Brings sign-ups the app doesn't have yet into check-in: a re-sync. */
  async function addToCheckIn() {
    if (!sheet) return
    setSyncing(true)
    setError(null)
    try {
      const data = await withSheetAccess(config, sheet.spreadsheet_id, () => readTab(config, sheet.spreadsheet_id, sheet.tab_id))
      if (!data) return
      const synced = await resyncSheet(config, sheet, data)
      setSheet(synced.result.sheet)
      setStudents((await api.getPlan(sheet.id)).students)
      notify(describeResync(synced))
      if (synced.writeError) setError(`The values from the Student Database weren’t written to the sheet: ${synced.writeError}`)
      refreshSheets().catch(() => {})
      readSheet(synced.result.sheet, false)
    } catch (err) {
      setError(errorMessage(err, 'Re-sync failed.'))
    } finally {
      setSyncing(false)
    }
  }

  if (!sheet) {
    return error ? <p className="error">{error}</p> : (
      <p className="muted loading-line" role="status">
        <span className="spinner" aria-hidden="true" /> Loading the sign-ups…
      </p>
    )
  }

  const event = sheetName(sheet)
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheet.spreadsheet_id)}/edit#gid=${sheet.tab_id}`
  const contacts = read?.contacts ?? []
  const inGroup = (contact: Contact, value: string) => {
    const statuses = STATUS_GROUPS.find((g) => g.value === value)?.statuses
    return !statuses || statuses.includes(statusOfContact(contact))
  }
  const q = query.trim().toLowerCase()
  const qDigits = q.replace(/\D/g, '')
  const matches = (c: Contact) =>
    !q ||
    c.name.toLowerCase().includes(q) ||
    c.nickname.toLowerCase().includes(q) ||
    c.email.toLowerCase().includes(q) ||
    (qDigits.length >= 3 && c.phone.replace(/\D/g, '').includes(qDigits))
  // The form adds rows at the bottom, so the newest sign-ups come first.
  const shown = contacts.filter((c) => inGroup(c, group) && matches(c)).reverse()
  const notInApp = students ? contacts.filter((c) => !studentByKey.has(c.key)).length : 0

  return (
    <div className="sheet-page signups-page">
      <header className="sheet-head">
        <div className="sheet-heading">
          <h1 className="sheet-title">
            <a href={sheetUrl} target="_blank" rel="noreferrer" title={`Open “${sheet.tab_title}” in ${sheet.spreadsheet_title}`}>
              {event}
            </a>
          </h1>
          <SheetViews sheetId={sheet.id} />
        </div>
        <div className="sheet-head-actions">
          {access === 'needs-access' && read && (
            <button type="button" className="attendance-chip is-alert" onClick={connect} title="This device can’t reach the sheet right now">
              Connect Google Sheets
            </button>
          )}
          <button
            type="button"
            className="with-icon"
            aria-expanded={editingMessage}
            onClick={() => setEditingMessage((open) => !open)}
            title="The message Text and Email start with"
          >
            <MessageIcon /> Message
          </button>
          <button
            type="button"
            className={`with-icon resync-button${reading ? ' is-syncing' : ''}`}
            onClick={() => readSheet(sheet, true)}
            disabled={reading}
            aria-busy={reading}
            title="Read the latest from Google Sheets"
          >
            <RefreshIcon /> Refresh
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

      {editingMessage && (
        <div className="message-editor">
          <label>
            <span>Message for Text and Email</span>
            <textarea rows={3} value={template} onChange={(e) => setTemplate(e.target.value)} />
          </label>
          <div className="message-editor-foot">
            <p className="muted">
              <code>{'{first}'}</code> is their nickname or first name, <code>{'{name}'}</code> their full name and{' '}
              <code>{'{event}'}</code> “{event}”. Kept on this device only.
            </p>
            {template !== DEFAULT_MESSAGE && (
              <button type="button" className="link-button" onClick={() => setTemplate(DEFAULT_MESSAGE)}>
                Reset
              </button>
            )}
          </div>
        </div>
      )}

      {!read ? (
        access === 'needs-access' ? (
          <div className="empty-state">
            <p>Sign-ups are read straight from Google Sheets in this browser, so phone numbers and emails never leave it.</p>
            <button type="button" className="primary" onClick={connect}>
              Connect Google Sheets
            </button>
          </div>
        ) : (
          <p className="muted loading-line" role="status">
            <span className="spinner" aria-hidden="true" /> Reading the sheet…
          </p>
        )
      ) : (
        <section className="signups" aria-label="Sign-ups">
          <div className="signups-top">
            <label className="checkin-search">
              <SearchIcon />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Search by name, nickname, phone or email"
              />
            </label>
            <div className="segmented signups-groups" role="tablist" aria-label="Contact status">
              {STATUS_GROUPS.map((g) => (
                <button
                  key={g.value}
                  type="button"
                  role="tab"
                  aria-selected={group === g.value}
                  className={group === g.value ? 'is-on' : ''}
                  onClick={() => setGroup(g.value)}
                >
                  {g.label} <span className="tab-count">{contacts.filter((c) => inGroup(c, g.value)).length}</span>
                </button>
              ))}
            </div>
          </div>
          {notInApp > 0 && (
            <p className="signups-note">
              {notInApp} {notInApp === 1 ? 'sign-up isn’t' : 'sign-ups aren’t'} on the check-in list yet.
              <button type="button" onClick={addToCheckIn} disabled={syncing} aria-busy={syncing}>
                {syncing ? 'Adding…' : 'Add to check-in'}
              </button>
            </p>
          )}
          {!read.columns.status && (
            <p className="signups-note">No Contact Status column found, so statuses can’t be changed here. Name a column “Contact Status” in the sheet.</p>
          )}
          {!read.columns.phone && !read.columns.email && (
            <p className="signups-note">No phone or email column found, so there’s no one to text or email.</p>
          )}
          <ul className="signups-list">
            {shown.map((c) => {
              const status = statusOfContact(c)
              const message = fillMessage(template, c, event)
              const phone = dialable(c.phone)
              const details = [c.gender && GENDER_LABELS[c.gender], c.level && LEVEL_LABELS[c.level]].filter(Boolean).join(' · ')
              return (
                <li key={c.key} className={pending.has(c.key) ? 'is-saving' : ''}>
                  <div className="signup-person">
                    <span className="checkin-name">
                      {c.name}
                      {c.nickname && <span className="checkin-nickname">“{c.nickname}”</span>}
                    </span>
                    <span className="signup-meta">
                      {students && !studentByKey.has(c.key) && <span className="checkin-flag">New</span>}
                      {details && <span>{details}</span>}
                      {c.signedUp && <span title={c.signedUp}>Signed up {shortTimestamp(c.signedUp)}</span>}
                    </span>
                    {(c.phone || c.email) && (
                      <span className="signup-reach">
                        {c.phone && <span>{c.phone}</span>}
                        {c.email && <span>{c.email}</span>}
                      </span>
                    )}
                  </div>
                  <div className="signup-controls">
                    <select
                      className={`status-select status-${status}`}
                      value={status}
                      disabled={!read.columns.status}
                      onChange={(e) => changeStatus(c, e.target.value as ContactStatus)}
                      aria-label={`Contact status for ${c.name}`}
                    >
                      {CONTACT_STATUSES.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                    <div className="signup-actions">
                      {phone && (
                        <a className="icon-button" href={smsHref(c.phone, message)} onClick={() => contacted(c)} title={`Text ${c.phone}`} aria-label={`Text ${c.name}`}>
                          <MessageIcon />
                        </a>
                      )}
                      {phone && (
                        <a className="icon-button" href={telHref(c.phone)} onClick={() => contacted(c)} title={`Call ${c.phone}`} aria-label={`Call ${c.name}`}>
                          <PhoneIcon />
                        </a>
                      )}
                      {c.email.includes('@') && (
                        <a
                          className="icon-button"
                          href={mailtoHref(c.email, event, message)}
                          onClick={() => contacted(c)}
                          title={`Email ${c.email}`}
                          aria-label={`Email ${c.name}`}
                        >
                          <MailIcon />
                        </a>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
            {shown.length === 0 && <li className="checkin-empty">{contacts.length > 0 ? 'No matches' : 'No sign-ups'}</li>}
          </ul>
        </section>
      )}
    </div>
  )
}
