import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../api'
import type { Gender, Level, PlanStudent, SeatedTable, SeatingPlan, Sheet } from '../types'
import { CheckIcon, SearchIcon } from './icons'
import { Segmented } from './Segmented'

type Seated = { name: string; table: SeatedTable | null }

/** Big "where to sit" card for whoever was just checked in, so the volunteer can point. */
function SeatCard({ seated, hasTables, onClose }: { seated: Seated; hasTables: boolean; onClose: () => void }) {
  const { name, table } = seated
  const ref = useRef<HTMLDivElement>(null)
  // The volunteer may have tapped far down the list; bring the table number into view.
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [seated])
  return (
    <div ref={ref} className={`seat-card${table ? '' : ' is-unseated'}`} role="status">
      <div>
        <div className="seat-card-who">{name} is checked in</div>
        {table ? (
          <>
            <div className="seat-card-table">{table.name}</div>
            {table.mentors.length > 0 && (
              <div className="seat-card-mentor">
                {table.mentors.length === 1 ? 'Mentor' : 'Mentors'}: {table.mentors.join(', ')}
              </div>
            )}
          </>
        ) : (
          <div className="seat-card-note">
            {hasTables
              ? 'There’s no table for their group. Seat them by hand on the tables board.'
              : 'Tables aren’t set up yet. Use Plan tables to create them.'}
          </div>
        )}
      </div>
      <button type="button" className="seat-card-close" onClick={onClose}>
        Done
      </button>
    </div>
  )
}

export function CheckInPanel({ sheet, plan, onChange, onReload, onResync, resyncing }: {
  sheet: Sheet
  plan: SeatingPlan
  onChange: (update: (plan: SeatingPlan) => SeatingPlan) => void
  /** Picks up the seat the server just handed out, for the tables board. */
  onReload: () => void
  onResync: () => void
  resyncing: boolean
}) {
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [seated, setSeated] = useState<Seated | null>(null)
  // The sign-up being asked for gender/level before check-in, with the answers so far.
  const [asking, setAsking] = useState<{ id: number; gender: Gender | ''; level: Level | '' } | null>(null)
  const [busy, setBusy] = useState<number | null>(null)

  const tableOf = new Map<number, string>()
  for (const t of plan.tables) for (const m of t.members) if (m.kind === 'student') tableOf.set(m.id, t.name)
  const hasTables = plan.tables.length > 0

  const people = [...plan.students].sort((a, b) => a.name.localeCompare(b.name))
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? people.filter((p) => p.name.toLowerCase().includes(needle) || p.nickname.toLowerCase().includes(needle))
    : people

  const checkedIn = people.filter((p) => p.checked_in).length
  const remaining = sheet.capacity === null ? null : sheet.capacity - checkedIn
  const over = remaining !== null && remaining < 0

  const replace = (student: PlanStudent) =>
    onChange((p) => ({ ...p, students: p.students.map((s) => (s.id === student.id ? student : s)) }))

  async function checkIn(person: PlanStudent, door: { gender?: Gender; level?: Level } = {}) {
    setBusy(person.id)
    try {
      const { student, table } = await api.checkIn(person.id, door)
      replace(student)
      setSeated({ name: person.name, table })
      setAsking(null)
      setQuery('')
      setError(null)
      onReload()
    } catch (err) {
      setError(errorMessage(err, 'Check-in failed'))
    } finally {
      setBusy(null)
    }
  }

  async function undo(person: PlanStudent) {
    setBusy(person.id)
    try {
      replace((await api.undoCheckIn(person.id)).student)
      setSeated(null)
      setError(null)
      onReload()
    } catch (err) {
      setError(errorMessage(err, 'Undo failed'))
    } finally {
      setBusy(null)
    }
  }

  // Gender and level decide the table, so ask for whichever the sheet didn't have.
  function start(person: PlanStudent) {
    if (hasTables && (!person.gender || !person.level)) {
      setAsking({ id: person.id, gender: person.gender, level: person.level })
    } else {
      checkIn(person)
    }
  }

  return (
    <section className="checkin" aria-label="Check-in">
      {remaining === null ? (
        <div className="spots-banner" role="status">
          <div>
            <span className="spots-number">{checkedIn}</span>
            <span className="spots-label">checked in</span>
          </div>
          <div className="spots-detail">of {people.length} signed up · no capacity set</div>
        </div>
      ) : (
        <div className={`spots-banner${over ? ' is-over' : remaining === 0 ? ' is-full' : ''}`} role="status">
          <div>
            <span className="spots-number">{over ? `${-remaining} over` : remaining}</span>
            <span className="spots-label">{over ? 'capacity' : `spot${remaining === 1 ? '' : 's'} left`}</span>
          </div>
          <div className="spots-detail">
            {checkedIn} checked in · capacity {sheet.capacity}
            {over && <strong> · Over capacity</strong>}
          </div>
        </div>
      )}

      {seated && <SeatCard seated={seated} hasTables={hasTables} onClose={() => setSeated(null)} />}
      {error && <p className="error">{error}</p>}

      <label className="checkin-search">
        <SearchIcon />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or nickname"
          aria-label="Search by name or nickname"
        />
      </label>
      <p className="checkin-walkin muted">
        Not on the list? Have them fill out the sign-up form, then{' '}
        <button type="button" className="link-button" onClick={onResync} disabled={resyncing}>
          {resyncing ? 're-syncing…' : 're-sync'}
        </button>
        .
      </p>

      <ul className="checkin-list">
        {shown.map((person) => {
          const table = tableOf.get(person.id)
          const isAsking = asking?.id === person.id
          return (
            <li key={person.id} className={`${person.checked_in ? 'is-in' : ''}${isAsking ? ' is-asking' : ''}`}>
              <div className="checkin-row">
                <div className="checkin-person">
                  <span className="checkin-name">{person.name}</span>
                  {person.nickname && <span className="checkin-nickname">“{person.nickname}”</span>}
                  {person.checked_in && table && <span className="checkin-table">{table}</span>}
                </div>
                {person.checked_in ? (
                  <button
                    type="button"
                    className="checkin-done"
                    onClick={() => undo(person)}
                    disabled={busy === person.id}
                    aria-label={`Undo check-in for ${person.name}`}
                  >
                    <CheckIcon /> Checked in
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => (isAsking ? setAsking(null) : start(person))}
                    disabled={busy === person.id}
                    aria-label={`Check in ${person.name}`}
                  >
                    {isAsking ? 'Cancel' : 'Check in'}
                  </button>
                )}
              </div>
              {isAsking && (
                <div className="checkin-ask">
                  <p className="muted">Their sign-up didn't say. This picks their table.</p>
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
              )}
            </li>
          )
        })}
        {shown.length === 0 && (
          <li className="checkin-empty">{people.length === 0 ? 'No sign-ups in this sheet.' : 'No one matches that search.'}</li>
        )}
      </ul>
    </section>
  )
}
