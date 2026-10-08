import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { api, ApiError, errorMessage } from '../api'
import { useApp } from '../appContext'
import { ChartIcon, CheckIcon, CloseIcon, MailIcon, MessageIcon, PhoneIcon, RefreshIcon, SearchIcon } from '../components/icons'
import { Segmented } from '../components/Segmented'
import { SheetViews } from '../components/SheetViews'
import { OverviewDialog } from '../components/SignupsOverview'
import {
  getAccessToken,
  NeedsSignInError,
  NoAccessError,
  readTab,
  StatusChangedError,
  withSheetAccess,
  writeChatAdded,
  writeStatus,
} from '../google'
import { readForSync, resyncSheet } from '../resync'
import { overviewOf, type OverviewPlan } from '../signupOverview'
import {
  BEFORE_CONTACT,
  DEFAULT_MESSAGE,
  dialable,
  fillMessage,
  mailtoHref,
  readContacts,
  shortTimestamp,
  SIGNED_UP_RANGES,
  signedUpWithin,
  smsHref,
  socialLabel,
  STATUS_GROUPS,
  telHref,
  type Contact,
} from '../signupTracker'
import { CONTACT_STATUSES, sheetName, type ContactStatus, type PlanStudent, type SeatingPlan, type Sheet } from '../types'
import { useUndo } from '../undo'

// Other volunteers (and the form) change the sheet too; re-read it now and then, and on coming back to the tab.
const REFRESH_MS = 30_000

const GENDER_LABELS = { female: 'Girl', male: 'Guy' } as const
const LEVEL_LABELS = { undergrad: 'Undergrad', grad: 'Grad', other: 'Not a student' } as const

const GENDER_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'female', label: 'Girls' },
  { value: 'male', label: 'Guys' },
] as const
const LEVEL_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'undergrad', label: 'Undergrad' },
  { value: 'grad', label: 'Grad' },
  { value: 'other', label: 'Not a student' },
] as const
type GenderFilter = (typeof GENDER_FILTERS)[number]['value']
type LevelFilter = (typeof LEVEL_FILTERS)[number]['value']

type Read = ReturnType<typeof readContacts>

// The filter for confirmed people who asked to join the group chats and aren't in them yet.
const CHAT_GROUP = 'chat'

type PlanInfo = Omit<OverviewPlan, 'students'>
const planInfo = ({ mentors, excluded_mentor_ids, show_up_rates, walk_in_rate, ideal_per_mentor }: SeatingPlan): PlanInfo => ({
  mentors,
  excluded_mentor_ids,
  show_up_rates,
  walk_in_rate,
  ideal_per_mentor,
})

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
 * status (written straight into the sheet's Contact Status column), text, call or email them, and
 * tick off who's been added to the group chats (the sheet's "Added to Group Chat" column). An
 * overview above sums it all up. The sheet is read in this browser, so phone numbers, emails and
 * social media IDs never reach the server.
 */
export function SignupsPage() {
  const sheetId = Number(useParams().sheetId)
  const { config } = useApp()
  const { push, notify } = useUndo()
  const navigate = useNavigate()
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [students, setStudents] = useState<PlanStudent[] | null>(null)
  const [plan, setPlan] = useState<PlanInfo | null>(null)
  const [read, setRead] = useState<Read | null>(null)
  const [access, setAccess] = useState<'checking' | 'needs-access' | 'ok'>('checking')
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  // Statuses being written, shown right away.
  const [pending, setPending] = useState<Map<string, ContactStatus>>(new Map())
  const [pendingChat, setPendingChat] = useState<Map<string, boolean>>(new Map())
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [group, setGroup] = useState('all')
  const [query, setQuery] = useState('')
  const [signedUpRange, setSignedUpRange] = useState('any')
  const [genderFilter, setGenderFilter] = useState<GenderFilter>('all')
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all')
  const [editingMessage, setEditingMessage] = useState(false)
  const [template, setTemplate] = useMessageTemplate(sheetId)

  const sheetRef = useRef(sheet)
  sheetRef.current = sheet
  const studentByKey = useMemo(() => new Map((students ?? []).map((s) => [s.key, s])), [students])
  const studentsRef = useRef(students)
  studentsRef.current = students
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
    setPendingChat(new Map())
    setPlan(null)
    const refresh = () =>
      Promise.all([api.getSheet(sheetId), api.getPlan(sheetId)])
        .then(([s, p]) => {
          if (!active) return
          setSheet(s)
          setStudents(p.students)
          setPlan(planInfo(p))
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
        if (!interactive) await getAccessToken(config, { interactive: false })
        const data = await readForSync(current, interactive ? () => withSheetAccess(config, current.spreadsheet_id, run) : run)
        if (!data) return
        if (sheetRef.current?.id !== current.id) return
        if (writes.current.running || writes.current.done !== before) return
        setRead(readContacts(data.values, current.field_map))
        setAccess('ok')
        // New rows and statuses changed in the sheet go on to check-in.
        const synced = await resyncSheet(config, current, data, {
          auto: true,
          knownKeys: studentsRef.current?.map((s) => s.key),
        })
        if (synced && sheetRef.current?.id === current.id) {
          setSheet(synced.result.sheet)
          const next = await api.getPlan(current.id)
          setStudents(next.students)
          setPlan(planInfo(next))
        }
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

  /**
   * Writes the status into the sheet, then into the app if they're in it yet. Throws when the sheet
   * write fails. With `expected` (undo and redo), only if the sheet still has that status.
   */
  const applyStatus = useCallback(
    async (key: string, status: ContactStatus, expected?: ContactStatus) => {
      const current = sheetRef.current
      if (!current) return
      setPending((p) => new Map(p).set(key, status))
      writes.current.running++
      const run = queue.current.then(async () => {
        try {
          await writeStatus(config, current, key, status, expected)
        } catch (err) {
          // Show what the sheet has now.
          if (err instanceof StatusChangedError) {
            const now = err.status
            setRead((r) => r && { ...r, contacts: r.contacts.map((c) => (c.key === key ? { ...c, status: now } : c)) })
          }
          throw err
        }
        setRead((r) => r && { ...r, contacts: r.contacts.map((c) => (c.key === key ? { ...c, status } : c)) })
        const student = studentByKeyRef.current.get(key)
        if (!student) return
        try {
          const { student: saved } = await api.setStatus(student.id, status)
          setStudents((list) => list && list.map((s) => (s.id === saved.id ? saved : s)))
        } catch {
          setError('The status was saved in the sheet; check-in will pick it up within a minute.')
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

  /** Ticks or clears their "Added to Group Chat" box. With `expected` (undo and redo), only if it still shows that. */
  const applyChat = useCallback(
    async (key: string, added: boolean, expected?: boolean) => {
      const current = sheetRef.current
      if (!current) return
      setPendingChat((p) => new Map(p).set(key, added))
      writes.current.running++
      const run = queue.current.then(async () => {
        await writeChatAdded(config, current, key, added, expected)
        setRead((r) => r && { ...r, contacts: r.contacts.map((c) => (c.key === key ? { ...c, chatAdded: added } : c)) })
      })
      queue.current = run.catch(() => {})
      try {
        await run
      } finally {
        writes.current.running--
        writes.current.done++
        setPendingChat((p) => {
          if (p.get(key) !== added) return p
          const next = new Map(p)
          next.delete(key)
          return next
        })
      }
    },
    [config],
  )

  const chatAddedOf = (contact: Contact) => pendingChat.get(contact.key) ?? contact.chatAdded

  async function toggleChat(contact: Contact) {
    const before = chatAddedOf(contact)
    setError(null)
    try {
      await applyChat(contact.key, !before)
      push({
        label: `${contact.name}’s group chat box`,
        undo: () => applyChat(contact.key, before, !before),
        redo: () => applyChat(contact.key, !before, before),
      })
    } catch (err) {
      if (err instanceof NeedsSignInError || err instanceof NoAccessError) setAccess('needs-access')
      setError(errorMessage(err, 'Couldn’t update the group chat box.'))
    }
  }

  /** True once saved; undoable with Ctrl/Cmd+Z. */
  async function changeStatus(contact: Contact, status: ContactStatus) {
    const before = statusOfContact(contact)
    if (before === status) return false
    setError(null)
    try {
      await applyStatus(contact.key, status)
      push({
        label: `${contact.name}’s status`,
        // Each only if nobody has changed it since, so undo never overwrites someone else's change.
        undo: () => applyStatus(contact.key, before, status),
        redo: () => applyStatus(contact.key, status, before),
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
    if (value === CHAT_GROUP) return statusOfContact(contact) === 'confirmed' && contact.wantsChat && !chatAddedOf(contact)
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
    c.socials.some((s) => s.id.toLowerCase().includes(q)) ||
    (qDigits.length >= 3 && c.phone.replace(/\D/g, '').includes(qDigits))
  const filtered = signedUpRange !== 'any' || genderFilter !== 'all' || levelFilter !== 'all'
  const passesFilters = (c: Contact) =>
    signedUpWithin(c.signedUp, signedUpRange) &&
    (genderFilter === 'all' || c.gender === genderFilter) &&
    (levelFilter === 'all' || c.level === levelFilter)
  const clearFilters = () => {
    setSignedUpRange('any')
    setGenderFilter('all')
    setLevelFilter('all')
  }
  // The status tabs count who's left after the time, gender and enrollment filters.
  const filteredContacts = contacts.filter(passesFilters)
  // The form adds rows at the bottom, so the newest sign-ups come first.
  const shown = filteredContacts.filter((c) => inGroup(c, group) && matches(c)).reverse()
  const groups = [
    ...STATUS_GROUPS,
    ...(read?.columns.chat ? [{ value: CHAT_GROUP, label: 'Add to chats' }] : []),
  ]
  // With what's still being saved, so the numbers move as soon as something changes.
  const overview =
    read && plan && students
      ? overviewOf(contacts.map((c) => ({ ...c, status: statusOfContact(c), chatAdded: chatAddedOf(c) })), { ...plan, students })
      : null

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
        <>
        {overview && (
          <OverviewDialog
            open={overviewOpen}
            onClose={() => setOverviewOpen(false)}
            title={event}
            overview={overview}
            capacity={sheet.capacity}
            columns={read.columns}
            onShowChatList={() => {
              setQuery('')
              clearFilters()
              setGroup(CHAT_GROUP)
            }}
          />
        )}
        <section className="signups" aria-label="Sign-ups">
          <div className="signups-top">
            <label className="checkin-search">
              <SearchIcon />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Search by name, nickname, phone, email or social media ID"
              />
            </label>
            <div className="segmented signups-groups" role="tablist" aria-label="Contact status">
              {groups.map((g) => (
                <button
                  key={g.value}
                  type="button"
                  role="tab"
                  aria-selected={group === g.value}
                  className={group === g.value ? 'is-on' : ''}
                  onClick={() => setGroup(g.value)}
                >
                  {g.label} <span className="tab-count">{filteredContacts.filter((c) => inGroup(c, g.value)).length}</span>
                </button>
              ))}
            </div>
            <div className="signups-tools">
              <button
                type="button"
                className="with-icon"
                aria-haspopup="dialog"
                onClick={() => setOverviewOpen(true)}
                disabled={!overview}
                title="Turnout, mentors, statuses, how people heard and group chats"
              >
                <ChartIcon /> Overview
              </button>
              <button
                type="button"
                className={`icon-button tool-button${editingMessage ? ' is-on' : ''}`}
                aria-expanded={editingMessage}
                aria-label="Message"
                onClick={() => setEditingMessage((open) => !open)}
                title="The message Text and Email start with"
              >
                <MessageIcon />
              </button>
              <button
                type="button"
                className={`icon-button tool-button${reading ? ' is-syncing' : ''}`}
                onClick={() => readSheet(sheet, true)}
                disabled={reading}
                aria-busy={reading}
                aria-label="Refresh"
                title="Read the latest from Google Sheets"
              >
                <RefreshIcon />
              </button>
            </div>
            <div className="signups-filters">
              <label className="signups-filter">
                <span>Signed up</span>
                <select value={signedUpRange} onChange={(e) => setSignedUpRange(e.target.value)}>
                  {SIGNED_UP_RANGES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="signups-filter">
                <span>Gender</span>
                <Segmented label="Gender" value={genderFilter} options={[...GENDER_FILTERS]} onChange={setGenderFilter} />
              </div>
              <div className="signups-filter">
                <span>Enrollment</span>
                <Segmented label="Enrollment" value={levelFilter} options={[...LEVEL_FILTERS]} onChange={setLevelFilter} />
              </div>
              {filtered && (
                <button type="button" className="link-button" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </div>
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
          </div>
          {!read.columns.status && (
            <p className="signups-note">No Contact Status column found, so statuses can’t be changed here. Name a column “Contact Status” in the sheet.</p>
          )}
          {!read.columns.phone && !read.columns.email && (
            <p className="signups-note">No phone or email column found, so there’s no one to text or email.</p>
          )}
          <ul className="signups-list">
            {shown.map((c) => {
              const status = statusOfContact(c)
              const chatAdded = chatAddedOf(c)
              const message = fillMessage(template, c, event)
              const phone = dialable(c.phone)
              return (
                <li key={c.key} className={pending.has(c.key) || pendingChat.has(c.key) ? 'is-saving' : ''}>
                  <div className="signup-person">
                    <span className="checkin-name">
                      {c.name}
                      {c.nickname && <span className="checkin-nickname">“{c.nickname}”</span>}
                    </span>
                    <span className="signup-meta">
                      {c.gender && <span className={`detail-chip gender-${c.gender}`}>{GENDER_LABELS[c.gender]}</span>}
                      {c.level && <span className={`detail-chip level-${c.level}`}>{LEVEL_LABELS[c.level]}</span>}
                      {c.signedUp && <span title={c.signedUp}>Signed up {shortTimestamp(c.signedUp)}</span>}
                    </span>
                    {(c.phone || c.email || c.socials.length > 0) && (
                      <span className="signup-reach">
                        {c.phone && <span>{c.phone}</span>}
                        {c.email && <span>{c.email}</span>}
                        {c.socials.map((s) => (
                          <span key={s.label} title={s.label}>
                            {socialLabel(s.label)}: {s.id}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                  <div className="signup-controls">
                    <span className="chat-slot">
                      {(c.wantsChat || chatAdded) && (
                        <button
                          type="button"
                          className={`chat-toggle${chatAdded ? ' is-on' : status === 'confirmed' ? ' is-due' : ''}`}
                          aria-pressed={chatAdded}
                          disabled={!read.columns.chatAdded || pendingChat.has(c.key)}
                          onClick={() => toggleChat(c)}
                          title={
                            !read.columns.chatAdded
                              ? 'Add a checkbox column named “Added to Group Chat” to the sheet'
                              : chatAdded
                                ? 'In the group chats. Click to clear.'
                                : status === 'confirmed'
                                  ? 'Confirmed and asked to join the group chats. Click once they’re added.'
                                  : 'Asked to join the group chats. Add them once they confirm.'
                          }
                        >
                          {chatAdded && <CheckIcon />} {chatAdded ? 'In chats' : 'Add to chats'}
                        </button>
                      )}
                    </span>
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
        </>
      )}
    </div>
  )
}
