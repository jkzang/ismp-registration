import { useEffect, useState, type ReactNode } from 'react'
import { api, errorMessage } from '../api'
import { doorAction, doorCounts, isReleased, reservedUntil, waitlistChance, waitlistOf, type DoorAction, type DoorCounts } from '../capacity'
import { useUndo } from '../undo'
import { CONTACT_STATUSES, type ContactStatus, type Gender, type Level, type PlanStudent, type SeatedTable, type SeatingPlan, type Sheet } from '../types'
import { ConfirmDialog } from './ConfirmDialog'
import { CheckIcon, ClockIcon, SearchIcon } from './icons'
import { Segmented } from './Segmented'

type Seated = { id: number; name: string; table: SeatedTable | null }

const statusLabel = (status: ContactStatus) => CONTACT_STATUSES.find((s) => s.value === status)?.label

/** Where the last person checked in should sit; stays up so the volunteer can point. */
function SeatCard({ seated }: { seated: Seated | null }) {
  if (!seated) {
    return (
      <div className="seat-card is-empty" role="status">
        <div className="seat-card-who">Last check-in</div>
        <div className="seat-card-table">—</div>
        <div className="seat-card-mentor">&nbsp;</div>
      </div>
    )
  }
  const { name, table } = seated
  return (
    <div className={`seat-card${table ? '' : ' is-unseated'}`} role="status">
      <div className="seat-card-who">{name}</div>
      <div className="seat-card-table">{table ? table.name : 'No table'}</div>
      <div className="seat-card-mentor">{table?.mentors.join(', ') || '\u00a0'}</div>
    </div>
  )
}

const plural = (n: number, word: string) => `${word}${n === 1 ? '' : 's'}`
const clock = (time: Date | string) => new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/**
 * How the room splits up: who's in, whose spots are reserved (confirmed people not here yet), who's
 * waiting for one, and what's free. The headline is what the door does next.
 */
function SpotsBanner({ counts, capacity, total, released, children }: {
  counts: DoorCounts
  capacity: number | null
  total: number
  released: boolean
  /** The reservation line, under the headline. */
  children?: ReactNode
}) {
  const { checkedIn, room, free, forWaitlist } = counts
  if (capacity === null || room === null || free === null) {
    return (
      <div className="spots-banner" role="status">
        <div className="spots-head">
          <span className="spots-number">{checkedIn}</span>
          <span className="spots-label">checked in</span>
          <span className="spots-detail">of {total} signed up</span>
        </div>
        <div className="spots-hint">No capacity set, so anyone can check in.</div>
      </div>
    )
  }
  const [tone, number, label, hint] =
    checkedIn > capacity ? ['is-over', checkedIn - capacity, 'over capacity', 'Nobody else can check in.']
    : counts.full ? ['is-over', null, 'Full', 'Nobody else can check in.']
    : forWaitlist > 0 ? ['', forWaitlist, `${plural(forWaitlist, 'spot')} for the waitlist`, 'Let the waitlist in, in order.']
    : free > 0 ? ['', free, plural(free, 'free spot'), 'Anyone can check in.']
    : ['is-full', null, 'No free spots', released ? 'Walk-ins join the waitlist.' : 'Confirmed people can still check in. Walk-ins join the waitlist.']
  const segments = [
    { key: 'in', label: 'Checked in', n: checkedIn, bar: checkedIn },
    ...(released ? [] : [{ key: 'held', label: 'Reserved', n: counts.reserved, bar: Math.min(counts.reserved, Math.max(0, room)) }]),
    { key: 'waitlist', label: 'Waitlist', n: counts.waitlisted, bar: forWaitlist },
    { key: 'open', label: 'Free', n: free, bar: free },
  ]
  return (
    <div className={`spots-banner ${tone}`} role="status">
      <div className="spots-head">
        {number !== null && <span className="spots-number">{number}</span>}
        <span className={number === null ? 'spots-number' : 'spots-label'}>{label}</span>
        <span className="spots-detail">
          {checkedIn} of {capacity} here
        </span>
      </div>
      <div className="spots-hint">{hint}</div>
      {children}
      <div className="spots-bar" aria-hidden="true">
        {segments.map((s) => s.bar > 0 && <span key={s.key} className={`is-${s.key}`} style={{ flexGrow: s.bar }} />)}
      </div>
      <ul className="spots-legend">
        {segments.map((s) => (
          <li key={s.key} title={s.key === 'in' ? `${counts.confirmedIn} confirmed, ${counts.unconfirmedIn} unconfirmed` : undefined}>
            <span className={`spots-swatch is-${s.key}`} />
            {s.label} <b>{s.n}</b>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Until when confirmed people's spots are held, with a button to release them early. */
function Reservation({ sheet, counts, released, now, onRelease }: {
  sheet: Sheet
  counts: DoorCounts
  released: boolean
  now: number
  onRelease: () => void
}) {
  const until = reservedUntil(sheet)
  if (released) {
    if (counts.confirmed === counts.confirmedIn) return null
    return (
      <div className="spots-reserve">
        Reserved spots were released at {clock(sheet.reserved_released_at ?? until!)}. Confirmed people arriving now are
        treated like walk-ins.
      </div>
    )
  }
  if (counts.reserved === 0) return null
  const minutes = until && Math.max(1, Math.ceil((until.getTime() - now) / 60_000))
  return (
    <div className="spots-reserve">
      <span>
        <b>{counts.reserved}</b> {plural(counts.reserved, 'spot')} reserved for confirmed people{' '}
        {until ? (
          <>
            until <b>{clock(until)}</b> ({minutes} min)
          </>
        ) : (
          'until you release them'
        )}
      </span>
      <button type="button" className="spots-release" onClick={onRelease}>
        Release now
      </button>
    </div>
  )
}

export function CheckInPanel({ sheet, plan, onChange, onReload, onAttendance, onSheetChange }: {
  sheet: Sheet
  plan: SeatingPlan
  /** Saves a change to the sheet itself, like releasing the reserved spots. */
  onSheetChange: (sheet: Sheet) => void
  onChange: (update: (plan: SeatingPlan) => SeatingPlan) => void
  /** Picks up the seat the server just handed out, for the tables board. */
  onReload: () => void
  /** Ticks or clears their box in the Google Sheet, in the background. */
  onAttendance: (key: string, checkedIn: boolean) => void
}) {
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [seated, setSeated] = useState<Seated | null>(null)
  // The sign-up being asked for gender/level before check-in, with the answers so far, and whether
  // the Next up card asked (so the questions show there rather than down the list).
  const [asking, setAsking] = useState<{ id: number; gender: Gender | ''; level: Level | ''; nextUp: boolean } | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [confirmingOther, setConfirmingOther] = useState<PlanStudent | null>(null)
  const [tab, setTab] = useState<'all' | 'waitlist'>('all')
  const [confirmingRelease, setConfirmingRelease] = useState(false)
  const { push } = useUndo()

  // Reserved spots run out on their own; tick so that happens without a reload.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])
  const released = isReleased(sheet, now)

  const tableOf = new Map<number, string>()
  for (const t of plan.tables) for (const m of t.members) if (m.kind === 'student') tableOf.set(m.id, t.name)
  const hasTables = plan.tables.length > 0

  const people = [...plan.students].sort((a, b) => a.name.localeCompare(b.name))
  const waitlist = waitlistOf(people, released)
  const counts = doorCounts(people, sheet.capacity, released)
  // Strict order: only the front of the line is let in, one at a time.
  const nextUp = sheet.capacity !== null && counts.forWaitlist > 0 ? waitlist[0] : undefined
  const until = reservedUntil(sheet)
  const showTabs = sheet.capacity !== null || waitlist.length > 0
  const onWaitlistTab = showTabs && tab === 'waitlist'

  const needle = query.trim().toLowerCase()
  const matches = (p: PlanStudent) => p.name.toLowerCase().includes(needle) || p.nickname.toLowerCase().includes(needle)
  const list = onWaitlistTab ? waitlist : people
  const shown = needle ? list.filter(matches) : list

  const replace = (student: PlanStudent) =>
    onChange((p) => ({ ...p, students: p.students.map((s) => (s.id === student.id ? student : s)) }))

  // The API calls on their own, so Ctrl+Z can replay them.
  async function doCheckIn(person: PlanStudent, door: { gender?: Gender; level?: Level } = {}) {
    const { student, table } = await api.checkIn(person.id, door)
    replace(student)
    setSeated({ id: person.id, name: person.name, table })
    onAttendance(person.key, true)
    onReload()
  }

  async function doUndoCheckIn(person: PlanStudent) {
    replace((await api.undoCheckIn(person.id)).student)
    setSeated((current) => (current?.id === person.id ? null : current))
    onAttendance(person.key, false)
    onReload()
  }

  async function checkIn(person: PlanStudent, door: { gender?: Gender; level?: Level } = {}) {
    setBusy(person.id)
    try {
      await doCheckIn(person, door)
      push({ label: `${person.name}’s check-in`, undo: () => doUndoCheckIn(person), redo: () => doCheckIn(person, door) })
      setAsking(null)
      setQuery('')
      setError(null)
    } catch (err) {
      setError(errorMessage(err, 'Check-in failed'))
    } finally {
      setBusy(null)
    }
  }

  async function undo(person: PlanStudent) {
    setBusy(person.id)
    try {
      await doUndoCheckIn(person)
      push({ label: `un-checking ${person.name}`, undo: () => doCheckIn(person), redo: () => doUndoCheckIn(person) })
      setError(null)
    } catch (err) {
      setError(errorMessage(err, 'Undo failed'))
    } finally {
      setBusy(null)
    }
  }

  // Waitlisting only happens here: the Google Sheet isn't touched.
  async function doWaitlist(person: PlanStudent) {
    replace((await api.waitlist(person.id)).student)
  }

  async function doUndoWaitlist(person: PlanStudent) {
    replace((await api.undoWaitlist(person.id)).student)
  }

  async function setWaitlisted(person: PlanStudent, on: boolean) {
    setBusy(person.id)
    try {
      const [action, reverse] = on ? [doWaitlist, doUndoWaitlist] : [doUndoWaitlist, doWaitlist]
      await action(person)
      push({
        label: on ? `waitlisting ${person.name}` : `taking ${person.name} off the waitlist`,
        undo: () => reverse(person),
        redo: () => action(person),
      })
      if (on) setQuery('')
      setError(null)
    } catch (err) {
      setError(errorMessage(err, on ? 'Couldn’t waitlist them' : 'Couldn’t take them off the waitlist'))
    } finally {
      setBusy(null)
    }
  }

  async function setReleasedAt(at: string | null) {
    onSheetChange(await api.updateSheet(sheet.id, { reserved_released_at: at }))
  }

  async function release() {
    setConfirmingRelease(false)
    try {
      await setReleasedAt(new Date().toISOString())
      push({
        label: 'releasing the reserved spots',
        undo: () => setReleasedAt(null),
        redo: () => setReleasedAt(new Date().toISOString()),
      })
      setError(null)
    } catch (err) {
      setError(errorMessage(err, 'Couldn’t release the reserved spots'))
    }
  }

  // Gender and level decide the table, so ask for whichever the sheet didn't have.
  function start(person: PlanStudent, confirmed = false, fromNextUp = false) {
    if (person.level === 'other' && !confirmed) return setConfirmingOther(person)
    setConfirmingOther(null)
    if (hasTables && (!person.gender || !person.level)) {
      setAsking({ id: person.id, gender: person.gender, level: person.level, nextUp: fromNextUp })
    } else {
      checkIn(person)
    }
  }

  // Asked before check-in when the sheet didn't say.
  function askFields(person: PlanStudent) {
    if (!asking) return null
    return (
      <div className="checkin-ask">
        <Segmented
          label="Gender"
          value={asking.gender}
          options={[
            { value: 'female', label: 'Girl' },
            { value: 'male', label: 'Guy' },
          ]}
          onChange={(gender) => setAsking({ ...asking, gender })}
        />
        <Segmented
          label="Level"
          value={asking.level}
          options={[
            { value: 'undergrad', label: 'Undergrad' },
            { value: 'grad', label: 'Grad' },
          ]}
          onChange={(level) => setAsking({ ...asking, level })}
        />
        <button
          type="button"
          className="primary"
          disabled={!asking.gender || busy === person.id}
          onClick={() =>
            checkIn(person, {
              ...(asking.gender && { gender: asking.gender }),
              ...(asking.level && { level: asking.level }),
            })
          }
        >
          Check in
        </button>
      </div>
    )
  }

  const askingNextUp = !!nextUp && asking?.id === nextUp.id && asking.nextUp

  return (
    <section className="checkin" aria-label="Check-in">
      <ConfirmDialog
        open={confirmingRelease}
        title="Release the reserved spots now?"
        confirmLabel="Release now"
        onConfirm={release}
        onClose={() => setConfirmingRelease(false)}
      >
        {counts.reserved} confirmed {counts.reserved === 1 ? 'person hasn’t' : 'people haven’t'} arrived. Their spots
        go to the waitlist, and if they come later they’re treated like walk-ins.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmingOther !== null}
        title={`Check in ${confirmingOther?.name ?? ''}?`}
        confirmLabel="Check in anyway"
        onConfirm={() => confirmingOther && start(confirmingOther, true)}
        onClose={() => setConfirmingOther(null)}
      >
        Their enrollment is Other, so they’re not a student.
      </ConfirmDialog>
      <div className="checkin-top">
        <SpotsBanner counts={counts} capacity={sheet.capacity} total={people.length} released={released}>
          {sheet.capacity !== null && (
            <Reservation sheet={sheet} counts={counts} released={released} now={now} onRelease={() => setConfirmingRelease(true)} />
          )}
        </SpotsBanner>
        {nextUp && (
          <div className="next-up" role="status">
            <div className="next-up-row">
              <span className="waitlist-place">1</span>
              <div className="next-up-who">
                <span className="next-up-label">
                  Next up from the waitlist
                  {counts.forWaitlist > 1 && ` · ${counts.forWaitlist - 1} more after`}
                </span>
                <span className="checkin-name">
                  {nextUp.name}
                  {nextUp.nickname && <span className="checkin-nickname">“{nextUp.nickname}”</span>}
                </span>
              </div>
              <button
                type="button"
                className="primary"
                onClick={() => (askingNextUp ? setAsking(null) : start(nextUp, false, true))}
                disabled={busy === nextUp.id}
                aria-label={`Check in ${nextUp.name}`}
              >
                {askingNextUp ? 'Cancel' : 'Check in'}
              </button>
              <button
                type="button"
                onClick={() => setWaitlisted(nextUp, false)}
                disabled={busy === nextUp.id}
                title="Take them off the waitlist and move on to the next person"
              >
                Not here
              </button>
            </div>
            {askingNextUp && askFields(nextUp)}
          </div>
        )}
        <SeatCard seated={seated} />
        <label className="checkin-search">
          <SearchIcon />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search by name or nickname"
          />
        </label>
        {showTabs && (
          <div className="segmented checkin-tabs" role="tablist" aria-label="List">
            <button type="button" role="tab" aria-selected={!onWaitlistTab} className={onWaitlistTab ? '' : 'is-on'} onClick={() => setTab('all')}>
              Check-in <span className="tab-count">{people.length}</span>
            </button>
            <button type="button" role="tab" aria-selected={onWaitlistTab} className={onWaitlistTab ? 'is-on' : ''} onClick={() => setTab('waitlist')}>
              Waitlist <span className="tab-count">{waitlist.length}</span>
            </button>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>

      {onWaitlistTab && waitlist.length > 0 && (
        <p className="waitlist-note">
          In order of arrival. They’re let in one at a time as spots open up
          {!released && counts.reserved > 0 && (until ? `, like when reserved spots are released at ${clock(until)}` : ', like when you release the reserved spots')}.
        </p>
      )}
      <ul className={`checkin-list${onWaitlistTab ? ' is-waitlist' : ''}`}>
        {shown.map((person) => {
          const table = tableOf.get(person.id)
          const isAsking = asking?.id === person.id
          const place = waitlist.indexOf(person)
          const action: DoorAction = doorAction(person, counts, released, place)
          return (
            <li key={person.id} className={`${person.checked_in ? 'is-in' : ''}${isAsking ? ' is-asking' : ''}`}>
              <div className="checkin-row">
                {onWaitlistTab && <span className="waitlist-place">{place + 1}</span>}
                <div className="checkin-person">
                  <span className="checkin-name">
                    {person.name}
                    {person.nickname && <span className="checkin-nickname">“{person.nickname}”</span>}
                  </span>
                  <span className="checkin-flags">
                    <span className={`checkin-status status-${person.status}`}>{statusLabel(person.status)}</span>
                    {person.checked_in && table && <span className="checkin-table">{table}</span>}
                    {person.level === 'other' && <span className="checkin-flag">Not a student</span>}
                    {action === 'waitlisted' && <span className="checkin-chance">#{place + 1} · {waitlistChance(place, counts)}</span>}
                  </span>
                </div>
                {action === 'checked-in' && (
                  <button
                    type="button"
                    className="checkin-done"
                    onClick={() => undo(person)}
                    disabled={busy === person.id}
                    aria-label={`Undo check-in for ${person.name}`}
                  >
                    <CheckIcon /> Checked in
                  </button>
                )}
                {action === 'check-in' && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => (isAsking && !asking.nextUp ? setAsking(null) : start(person))}
                    disabled={busy === person.id}
                    aria-label={`Check in ${person.name}`}
                  >
                    {isAsking && !asking.nextUp ? 'Cancel' : 'Check in'}
                  </button>
                )}
                {action === 'waitlist' && (
                  <button
                    type="button"
                    className="checkin-waitlist"
                    onClick={() => setWaitlisted(person, true)}
                    disabled={busy === person.id}
                    aria-label={`Waitlist ${person.name}`}
                  >
                    Waitlist
                  </button>
                )}
                {action === 'waitlisted' && (
                  <button
                    type="button"
                    className="checkin-waitlisted"
                    onClick={() => setWaitlisted(person, false)}
                    disabled={busy === person.id}
                    title="Take off the waitlist"
                    aria-label={`Take ${person.name} off the waitlist`}
                  >
                    <ClockIcon /> Waitlisted
                  </button>
                )}
                {action === 'no-room' && (
                  <button type="button" className="checkin-noroom" disabled aria-label={`No room for ${person.name}`}>
                    No room
                  </button>
                )}
              </div>
              {isAsking && !asking.nextUp && askFields(person)}
            </li>
          )
        })}
        {shown.length === 0 && (
          <li className="checkin-empty">
            {list.length > 0 ? 'No matches' : onWaitlistTab ? 'No one is waiting' : 'No sign-ups'}
          </li>
        )}
      </ul>
    </section>
  )
}
