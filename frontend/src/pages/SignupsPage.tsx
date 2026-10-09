import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, errorMessage } from '../api'
import { useApp } from '../appContext'
import { ChartIcon, MailIcon, MessageIcon, PhoneIcon, SearchIcon } from '../components/icons'
import { ColumnHeader } from '../components/ColumnHeader'
import { MessageMenu } from '../components/MessageMenu'
import { MessagesDialog } from '../components/MessagesDialog'
import { GENDER_LABELS, LEVEL_LABELS, SignupPersonDialog } from '../components/SignupPersonDialog'
import { OverviewDialog, TurnoutSummary } from '../components/SignupsOverview'
import { StatusMenu, type StatusOption } from '../components/StatusMenu'
import { StatusChangedError, writeGroupChat, writeStatus } from '../google'
import { useSheet } from '../sheetContext'
import { CHAT_STAGES, chatStageOf, GROUP_CHAT_STATUSES, groupChatLabel, RETURNING_LABELS, type GroupChatStatus } from '../signupColumns'
import { DEFAULT_SORT, isFiltered, optionCounts, passes, sortRows, TO_ADD, type ColumnId, type Filters, type Sort } from '../signupFilters'
import { overviewOf, type OverviewPlan } from '../signupOverview'
import {
  BEFORE_CONTACT,
  DEFAULT_MESSAGES,
  dialable,
  fillMessage,
  mailtoHref,
  messageItems,
  signedUpText,
  smsHref,
  telHref,
  type Contact,
} from '../signupTracker'
import { CONTACT_STATUSES, eventName, sheetName, type ContactStatus, type SeatingPlan } from '../types'
import { useUndo } from '../undo'

type PlanInfo = Omit<OverviewPlan, 'students'>
const planInfo = ({ mentors, excluded_mentor_ids, show_up_rates, walk_in_rate, ideal_per_mentor }: SeatingPlan): PlanInfo => ({
  mentors,
  excluded_mentor_ids,
  show_up_rates,
  walk_in_rate,
  ideal_per_mentor,
})

/** Shares the list's scrollbar width with its column names, as --list-scrollbar, so they keep
 *  clear of it. It's 0 where scrollbars float over the page, and changes with the zoom. */
function measureScrollbar(list: HTMLUListElement | null) {
  if (!list) return
  const observer = new ResizeObserver(() => {
    list.parentElement?.style.setProperty('--list-scrollbar', `${list.offsetWidth - list.clientWidth}px`)
  })
  observer.observe(list)
  return () => observer.disconnect()
}

// The group chat statuses under their stages, and the contact statuses, each in its own colors.
const CHAT_OPTIONS: StatusOption<GroupChatStatus>[] = GROUP_CHAT_STATUSES.map((s) => ({
  value: s.value,
  label: s.label,
  tone: `chat-${s.stage}`,
  group: CHAT_STAGES.find((stage) => stage.value === s.stage)?.label,
}))
const STATUS_OPTIONS: StatusOption<ContactStatus>[] = CONTACT_STATUSES.map((s) => ({ ...s, tone: `status-${s.value}` }))

// How long someone who just came in from the sheet stays highlighted.
const ARRIVAL_MS = 6000

/** The confirmation texts Text and Email start with, kept per sheet in this browser only. The
 *  first keeps the key it had when there was only one message. */
function useMessageTemplates(sheetId: number) {
  const keys = useMemo(() => [`signup-message-${sheetId}`, `signup-message-2-${sheetId}`], [sheetId])
  const [templates, setTemplates] = useState<readonly string[]>(DEFAULT_MESSAGES)
  useEffect(() => {
    setTemplates(
      keys.map((key, i) => {
        try {
          return localStorage.getItem(key) ?? DEFAULT_MESSAGES[i]
        } catch {
          return DEFAULT_MESSAGES[i]
        }
      }),
    )
  }, [keys])
  const save = useCallback(
    (index: number, next: string) => {
      setTemplates((t) => t.map((text, i) => (i === index ? next : text)))
      try {
        if (next === DEFAULT_MESSAGES[index]) localStorage.removeItem(keys[index])
        else localStorage.setItem(keys[index], next)
      } catch {
        // Only a convenience; it just won't be remembered.
      }
    },
    [keys],
  )
  return [templates, save] as const
}

/**
 * Everyone who signed up, newest first, for reaching out before the event: change their contact
 * status (written straight into the sheet's Contact Status column), text, call or email them, and
 * tick off who's been added to the group chats (the sheet's "Added to Group Chat" column). An
 * overview above sums it all up. The sheet is read in this browser, so phone numbers, emails and
 * social media IDs never reach the server.
 */
export function SignupsPage() {
  const { config } = useApp()
  const { push, notify } = useUndo()
  const { sheet, setSheet, plan: fullPlan, setPlan: setFullPlan, read, setRead, access, tendError, readSheet, queue, writes, setError } = useSheet()
  const sheetId = sheet.id
  const students = fullPlan.students
  const plan = planInfo(fullPlan)
  // Statuses being written, shown right away.
  const [pending, setPending] = useState<Map<string, ContactStatus>>(new Map())
  const [pendingChat, setPendingChat] = useState<Map<string, GroupChatStatus>>(new Map())
  const [overviewOpen, setOverviewOpen] = useState(false)
  // The person view; by key, so it shows their latest row.
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // Each column header's ticked values, and the column the list is sorted by.
  const [filters, setFilters] = useState<Filters>({})
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT)
  // Who was changed here, as they were before, so they keep their place in the list (and don't drop
  // out of the filters) until the search, filters or sort change. Otherwise the row would leave from
  // under the pointer and the next click would land on whoever moved into its place.
  const [placedAs, setPlacedAs] = useState<Map<string, Contact>>(new Map())
  useEffect(() => setPlacedAs(new Map()), [query, filters, sort, sheetId])
  const [editingMessages, setEditingMessages] = useState(false)
  const [templates, setTemplate] = useMessageTemplates(sheetId)
  // Who just came in from the sheet and showed under the filters then, to pop in at their place.
  const [arrived, setArrived] = useState<Set<string>>(new Set())
  const known = useRef<{ sheetId: number; keys: Set<string> } | null>(null)
  const shownKeys = useRef<Set<string>>(new Set())
  const arrivalTimers = useRef<number[]>([])

  const sheetRef = useRef(sheet)
  sheetRef.current = sheet
  const studentByKey = useMemo(() => new Map(students.map((s) => [s.key, s])), [students])
  const studentByKeyRef = useRef(studentByKey)
  studentByKeyRef.current = studentByKey

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
        // The app's copy follows on its own, so the next change in line doesn't wait for it.
        const student = studentByKeyRef.current.get(key)
        if (!student) return
        api
          .setStatus(student.id, status)
          .then(({ student: saved }) => setFullPlan((p) => p && { ...p, students: p.students.map((s) => (s.id === saved.id ? saved : s)) }))
          .catch(() => setError('The status was saved in the sheet; check-in will pick it up within a minute.'))
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
    [config, queue, writes, setRead, setFullPlan, setError],
  )

  const statusOfContact = (contact: Contact) => pending.get(contact.key) ?? contact.status

  /** Sets their Group Chat Status. With `expected` (undo and redo), only if it still shows that. */
  const applyChat = useCallback(
    async (key: string, status: GroupChatStatus, expected?: GroupChatStatus | null) => {
      const current = sheetRef.current
      if (!current) return
      setPendingChat((p) => new Map(p).set(key, status))
      writes.current.running++
      const run = queue.current.then(async () => {
        await writeGroupChat(config, current, key, status, expected)
        setRead((r) => r && { ...r, contacts: r.contacts.map((c) => (c.key === key ? { ...c, groupChat: status } : c)) })
      })
      queue.current = run.catch(() => {})
      try {
        await run
      } finally {
        writes.current.running--
        writes.current.done++
        setPendingChat((p) => {
          if (p.get(key) !== status) return p
          const next = new Map(p)
          next.delete(key)
          return next
        })
      }
    },
    [config, queue, writes, setRead],
  )

  const groupChatOf = (contact: Contact) => pendingChat.get(contact.key) ?? contact.groupChat

  /** Keeps them where the list has them now, the first time they're changed. */
  function keepPlace(contact: Contact) {
    const placed = { ...contact, status: statusOfContact(contact), groupChat: groupChatOf(contact) }
    setPlacedAs((p) => (p.has(contact.key) ? p : new Map(p).set(contact.key, placed)))
  }

  /** Shows the new status at once and writes it in the background; undoable with Ctrl/Cmd+Z once saved. */
  function changeChat(contact: Contact, status: GroupChatStatus) {
    const before = groupChatOf(contact)
    if (before === status) return
    setError(null)
    keepPlace(contact)
    applyChat(contact.key, status).then(
      () =>
        push({
          label: `${contact.name}’s group chat status`,
          // A blank cell is filled in again by the next read, so undo goes back to what it would get.
          undo: () => applyChat(contact.key, before ?? 'not_invited', status),
          redo: () => applyChat(contact.key, status, before ?? 'not_invited'),
        }),
      (err) => setError(errorMessage(err, 'Couldn’t change the group chat status.')),
    )
  }

  /** Shows the new status at once and writes it in the background; undoable with Ctrl/Cmd+Z once saved.
   *  False when there was nothing to change. */
  function changeStatus(contact: Contact, status: ContactStatus) {
    const before = statusOfContact(contact)
    if (before === status) return false
    setError(null)
    keepPlace(contact)
    applyStatus(contact.key, status).then(
      () =>
        push({
          label: `${contact.name}’s status`,
          // Each only if nobody has changed it since, so undo never overwrites someone else's change.
          undo: () => applyStatus(contact.key, before, status),
          redo: () => applyStatus(contact.key, status, before),
        }),
      (err) => setError(errorMessage(err, 'Couldn’t change the status.')),
    )
    return true
  }

  /** Texting, calling or emailing someone not reached yet moves them to Awaiting response. */
  function contacted(contact: Contact) {
    if (!read?.columns.status || !BEFORE_CONTACT.includes(statusOfContact(contact))) return
    if (changeStatus(contact, 'awaiting_response')) notify(`${contact.name} is now Awaiting response`)
  }

  const connect = () => readSheet(true)

  // New rows are added to the sheet by hand and come in with the background read. The first read of
  // a sheet only learns who's there; after that, anyone new that the search and filters show is
  // highlighted for a few seconds. Those they hide just show up, unmarked, once the filters change.
  const contactKeys = read?.contacts.map((c) => c.key).join('\n')
  useEffect(() => {
    if (contactKeys === undefined) return
    const keys = new Set(contactKeys ? contactKeys.split('\n') : [])
    const before = known.current
    known.current = { sheetId, keys }
    if (!before || before.sheetId !== sheetId) return
    const fresh = [...keys].filter((k) => !before.keys.has(k) && shownKeys.current.has(k))
    if (fresh.length === 0) return
    setArrived((a) => new Set([...a, ...fresh]))
    arrivalTimers.current.push(
      window.setTimeout(() => {
        setArrived((a) => {
          const next = new Set(a)
          for (const k of fresh) next.delete(k)
          return next
        })
      }, ARRIVAL_MS),
    )
  }, [contactKeys, sheetId])
  useEffect(() => () => arrivalTimers.current.forEach((t) => clearTimeout(t)), [])

  // {event} in the messages, and the emails' subject.
  const event = eventName(sheet)
  const contacts = read?.contacts ?? []
  const q = query.trim().toLowerCase()
  const qDigits = q.replace(/\D/g, '')
  const matches = (c: Contact) =>
    !q ||
    c.name.toLowerCase().includes(q) ||
    c.nickname.toLowerCase().includes(q) ||
    c.email.toLowerCase().includes(q) ||
    c.socials.some((s) => s.id.toLowerCase().includes(q)) ||
    (qDigits.length >= 3 && c.phone.replace(/\D/g, '').includes(qDigits))
  const clearFilters = () => setFilters({})
  // With what's still being saved, so a row moves as soon as its status changes.
  const current = contacts.map((c) => ({ ...c, status: statusOfContact(c), groupChat: groupChatOf(c) }))
  const now = Date.now()
  const searched = current.filter(matches)
  const shown = sortRows(
    searched
      .map((contact, index) => ({ contact: placedAs.get(contact.key) ?? contact, index, current: contact }))
      .filter((r) => passes(r.contact, filters, now)),
    sort,
  ).map((r) => r.current)
  shownKeys.current = new Set(shown.map((c) => c.key))
  const messagesFor = (c: Contact) => templates.map((t) => fillMessage(t, c, event))
  /** A column's header, with counts among who the search and the other columns let through. */
  const header = (id: ColumnId, className: string, end?: boolean, badge?: { count: number; label: string }) => (
    <ColumnHeader
      id={id}
      className={className}
      sort={sort}
      picked={filters[id] ?? []}
      counts={optionCounts(searched, filters, id, now)}
      end={end}
      badge={badge}
      onSort={(dir) => setSort({ column: id, dir })}
      onPick={(values) => setFilters((f) => ({ ...f, [id]: values }))}
    />
  )
  // With what's still being saved, so the numbers move as soon as something changes.
  const overview =
    read
      ? overviewOf(current, { ...plan, students })
      : null
  // The red counts by the Group chat and Contact status column names: who's still to get to.
  const toInvite = overview?.chats.toInvite ?? 0
  const notContacted = overview?.statuses.find((s) => s.value === 'not_contacted')?.count ?? 0

  return (
    <div className="sheet-view signups-page">
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
            title={sheetName(sheet)}
            overview={overview}
            capacity={sheet.capacity}
            columns={read.columns}
            onShowChatList={() => {
              setQuery('')
              setFilters({ groupChat: [TO_ADD] })
            }}
          />
        )}
        {(() => {
          const person = contacts.find((c) => c.key === openKey) ?? null
          return (
            <SignupPersonDialog
              contact={person}
              status={person ? statusOfContact(person) : 'not_contacted'}
              groupChat={person ? groupChatOf(person) : null}
              event={event}
              messages={person ? messagesFor(person) : []}
              onContacted={contacted}
              onClose={() => setOpenKey(null)}
            />
          )
        })()}
        <MessagesDialog
          open={editingMessages}
          sheet={sheet}
          onSheetSaved={setSheet}
          templates={templates}
          onChange={setTemplate}
          onClose={() => setEditingMessages(false)}
        />
        <section className="signups" aria-label="Sign-ups">
          {tendError && (
            <p className="signups-note">{tendError}</p>
          )}
          {!read.columns.status && (
            <p className="signups-note">No Contact Status column found, so statuses can’t be changed here. Name a column “Contact Status” in the sheet.</p>
          )}
          {!read.columns.phone && !read.columns.email && (
            <p className="signups-note">No phone or email column found, so there’s no one to text or email.</p>
          )}
          {/* The search, tools and column names stay put while the list scrolls. */}
          <div className="signups-head">
            <div className="signups-top">
              <label className="checkin-search">
                <SearchIcon />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search names"
                  aria-label="Search by name, nickname, phone, email or social media ID"
                />
              </label>
              {overview && <TurnoutSummary overview={overview} capacity={sheet.capacity} />}
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
                  className="icon-button tool-button"
                  aria-haspopup="dialog"
                  aria-label="Messages"
                  onClick={() => setEditingMessages(true)}
                  title="The confirmation texts Text and Email start with"
                >
                  <MessageIcon />
                </button>
              </div>
              {isFiltered(filters) && (
                <button type="button" className="link-button signups-clear" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </div>
            {/* Lined up with the list's columns; on a phone, where each row wraps, they wrap too. */}
            <div className="signups-columns">
              {header('signedUp', 'signup-when')}
              {header('name', 'signup-person')}
              <div className="signup-details">
                {header('gender', 'signup-gender')}
                {header('level', 'signup-level')}
                {header('returning', 'signup-returning')}
              </div>
              <div className="signup-controls">
                {header('groupChat', 'signups-column-chat', true, {
                  count: toInvite,
                  label: `${toInvite} still to invite to the group chats`,
                })}
                {header('status', 'signups-column-status', true, {
                  count: notContacted,
                  label: `${notContacted} not contacted yet`,
                })}
                <div className="column-header signup-actions">
                  <span className="column-name">Reach out</span>
                </div>
              </div>
            </div>
          </div>
          <ul className="signups-list" ref={measureScrollbar}>
            {shown.map((c) => {
              const status = statusOfContact(c)
              const groupChat = groupChatOf(c)
              const messages = messagesFor(c)
              const isNew = arrived.has(c.key)
              const phone = dialable(c.phone)
              const when = signedUpText(c.signedUp)
              return (
                <li
                  key={c.key}
                  className={isNew ? 'is-new' : undefined}
                >
                  <div className="signup-when" title={c.signedUp || undefined}>
                    {when ?? (c.signedUp || '—')}
                  </div>
                  <div className="signup-person">
                    <button type="button" className="signup-name" onClick={() => setOpenKey(c.key)} aria-haspopup="dialog">
                      {c.name}
                      {c.nickname && <span className="checkin-nickname">“{c.nickname}”</span>}
                      {isNew && <span className="new-badge">New</span>}
                    </button>
                  </div>
                  <div className="signup-details">
                    <span className="signup-gender">
                      {c.gender && <span className={`detail-chip gender-${c.gender}`}>{GENDER_LABELS[c.gender]}</span>}
                    </span>
                    <span className="signup-level">
                      {c.level && <span className={`detail-chip level-${c.level}`}>{LEVEL_LABELS[c.level]}</span>}
                    </span>
                    <span className="signup-returning">
                      {c.returning && <span className={`detail-chip returning-${c.returning}`}>{RETURNING_LABELS[c.returning]}</span>}
                    </span>
                  </div>
                  <div className="signup-controls">
                    <StatusMenu
                      className={`chat-select chat-${groupChat ? chatStageOf(groupChat) : 'none'}${
                        groupChat && chatStageOf(groupChat) !== 'complete' && status === 'confirmed' && c.wantsChat ? ' is-due' : ''
                      }`}
                      value={groupChat}
                      options={CHAT_OPTIONS}
                      placeholder="Group chats…"
                      disabled={!read.columns.groupChat}
                      onChange={(value) => changeChat(c, value)}
                      label={`Group chat status for ${c.name}`}
                      title={
                        !read.columns.groupChat
                          ? 'The sheet’s Group Chat Status column is added the next time it’s read'
                          : groupChat
                            ? `Group chats: ${groupChatLabel(groupChat)}`
                            : 'Group chats'
                      }
                    />
                    <StatusMenu
                      className={`status-${status}`}
                      value={status}
                      options={STATUS_OPTIONS}
                      disabled={!read.columns.status}
                      onChange={(value) => changeStatus(c, value)}
                      label={`Contact status for ${c.name}`}
                    />
                    <div className="signup-actions">
                      {phone && (
                        <MessageMenu
                          className="icon-button"
                          label={`Text ${c.name}`}
                          title={`Text ${c.phone}`}
                          items={messageItems(messages, (m) => smsHref(c.phone, m))}
                          end
                          onPick={() => contacted(c)}
                        >
                          <MessageIcon />
                        </MessageMenu>
                      )}
                      {phone && (
                        <a className="icon-button" href={telHref(c.phone)} onClick={() => contacted(c)} title={`Call ${c.phone}`} aria-label={`Call ${c.name}`}>
                          <PhoneIcon />
                        </a>
                      )}
                      {c.email.includes('@') && (
                        <MessageMenu
                          className="icon-button"
                          label={`Email ${c.name}`}
                          title={`Email ${c.email}`}
                          items={messageItems(messages, (m) => mailtoHref(c.email, event, m))}
                          end
                          onPick={() => contacted(c)}
                        >
                          <MailIcon />
                        </MessageMenu>
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
