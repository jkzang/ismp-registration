import { useState } from 'react'
import { Link } from 'react-router'
import { api, errorMessage } from '../api'
import {
  CONTACT_STATUSES,
  type Gender,
  type Level,
  type PlanMentor,
  type PlanStudent,
  type SeatingPlan,
  type SeatingTable,
  type TableMember,
} from '../types'
import { LockIcon, PlusIcon, ShuffleIcon, TrashIcon, UnlockIcon } from './icons'

// Matches check-in: 3 students per mentor is comfortable, 4 is fine, more only when there's no choice.
const IDEAL_PER_MENTOR = 3
const MAX_PER_MENTOR = 4
const UNASSIGNED = 'unassigned'

type Key = `${TableMember['kind']}:${number}`
const keyOf = (m: { kind: TableMember['kind']; id: number }): Key => `${m.kind}:${m.id}`

const GENDER_LABEL: Record<Gender, string> = { female: 'Girls', male: 'Guys' }
const LEVEL_LABEL: Record<Level, string> = { undergrad: 'Undergrad', grad: 'Grad' }

const GROUP_OPTIONS: { value: string; label: string }[] = [
  { value: 'female:undergrad', label: 'Girls · Undergrad' },
  { value: 'female:grad', label: 'Girls · Grad' },
  { value: 'female:', label: 'Girls · Either level' },
  { value: 'male:undergrad', label: 'Guys · Undergrad' },
  { value: 'male:grad', label: 'Guys · Grad' },
  { value: 'male:', label: 'Guys · Either level' },
  { value: ':', label: 'No group (check-in skips it)' },
]

function newTableId() {
  return Math.random().toString(36).slice(2, 10)
}

type Warning = { text: string; serious: boolean }

/** Serious warnings break the separation rules; the rest are just things to double-check. */
function tableWarnings(table: SeatingTable, students: PlanStudent[], mentors: PlanMentor[]): Warning[] {
  const warnings: Warning[] = []
  const genders = new Set([table.gender, ...students.map((s) => s.gender)].filter(Boolean))
  const levels = new Set(students.map((s) => s.level).filter(Boolean))
  if (genders.size > 1) warnings.push({ text: 'Guys and girls mixed', serious: true })
  if (levels.size > 1) warnings.push({ text: 'Undergrad and grad mixed', serious: true })
  if (mentors.length === 0 && (students.length > 0 || table.gender)) warnings.push({ text: 'No mentor', serious: true })
  const gender = genders.size === 1 ? [...genders][0] : null
  if (mentors.some((m) => m.gender && (genders.size > 1 || (gender && m.gender !== gender)))) {
    warnings.push({ text: "Mentor gender doesn't match", serious: true })
  }
  if (mentors.length > 0 && students.length / mentors.length > MAX_PER_MENTOR) {
    warnings.push({ text: `More than ${MAX_PER_MENTOR} per mentor`, serious: false })
  }
  if (!table.gender) warnings.push({ text: 'No group, so check-in won’t seat anyone here', serious: false })
  return warnings
}

function Tag({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <span className="person-tag" title={title}>
      {children}
    </span>
  )
}

function PersonChip({ member, student, mentor, tables, where, onMove, onToggleLock, onNotComing }: {
  member: TableMember
  student?: PlanStudent
  mentor?: PlanMentor
  tables: SeatingTable[]
  where: string
  onMove: (target: string) => void
  onToggleLock?: () => void
  onNotComing?: () => void
}) {
  const person = student ?? mentor!
  const gender = person.gender === 'female' ? 'F' : person.gender === 'male' ? 'M' : '?'
  const genderTitle = person.gender ? `Gender: ${person.gender}` : 'Gender not on file'
  const status = student ? CONTACT_STATUSES.find((s) => s.value === student.status)?.label : null

  return (
    <li
      className={`person-chip${mentor ? ' is-mentor' : ''}${student && !student.checked_in ? ' is-gone' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', keyOf(member))
        e.dataTransfer.effectAllowed = 'move'
      }}
    >
      <span className="person-main">
        <span className="person-name">
          {person.name}
          {student?.nickname && <span className="person-nick"> ({student.nickname})</span>}
        </span>
        <span className="person-tags">
          {mentor && <Tag title="Mentor">Mentor</Tag>}
          <Tag title={genderTitle}>{gender}</Tag>
          {student && (
            <Tag title={student.level ? `Level: ${student.level}` : 'Level unknown'}>
              {student.level === 'grad' ? 'G' : student.level === 'undergrad' ? 'UG' : '?'}
            </Tag>
          )}
          {student && !student.checked_in && <Tag title={`Sign-up status: ${status}`}>Not here yet</Tag>}
        </span>
      </span>
      <span className="person-actions">
        {onToggleLock && (
          <button
            type="button"
            className={`chip-icon${member.locked ? ' is-on' : ''}`}
            aria-pressed={member.locked}
            aria-label={member.locked ? `Unlock ${person.name}` : `Lock ${person.name} to this table`}
            title={member.locked ? 'Locked: Regenerate keeps them here' : 'Lock to this table'}
            onClick={onToggleLock}
          >
            {member.locked ? <LockIcon /> : <UnlockIcon />}
          </button>
        )}
        <select
          className="chip-move"
          value={where}
          onChange={(e) => onMove(e.target.value)}
          aria-label={`Move ${person.name}`}
          title="Move to another table"
        >
          {tables.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
          <option value={UNASSIGNED}>Not seated</option>
        </select>
        {onNotComing && (
          <button type="button" className="chip-text" onClick={onNotComing} title="Leave out of this sheet's tables">
            Not coming
          </button>
        )}
      </span>
    </li>
  )
}

function DropZone({ id, dragOver, setDragOver, onDropKey, className, children }: {
  id: string
  dragOver: string | null
  setDragOver: (id: string | null) => void
  onDropKey: (key: Key, target: string) => void
  className: string
  children: React.ReactNode
}) {
  return (
    <div
      className={`${className}${dragOver === id ? ' is-drop-target' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (dragOver !== id) setDragOver(id)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(null)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(null)
        const key = e.dataTransfer.getData('text/plain') as Key
        if (key) onDropKey(key, id)
      }}
    >
      {children}
    </div>
  )
}

function percent(rate: number) {
  return `${Math.round(rate * 100)}%`
}

/** The show-up rates behind "expected". */
function RatesNote({ plan }: { plan: SeatingPlan }) {
  const parts = CONTACT_STATUSES.flatMap(({ value, label }) => {
    const rate = plan.show_up_rates[value]
    return rate === undefined ? [] : [`${label} ${percent(rate)}`]
  })
  return <p className="muted dg-help">Show-up rates used for “expected”: {parts.join(' · ')}.</p>
}

export function TablesBoard({ sheetId, plan, setPlan }: {
  sheetId: number
  plan: SeatingPlan
  setPlan: (plan: SeatingPlan) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [dragOver, setDragOver] = useState<string | null>(null)

  const studentsById = new Map(plan.students.map((s) => [s.id, s]))
  const mentorsById = new Map(plan.mentors.map((m) => [m.id, m]))
  const excluded = new Set(plan.excluded_mentor_ids)
  const seated = new Map<Key, string>()
  for (const table of plan.tables) for (const m of table.members) seated.set(keyOf(m), table.id)

  const attendingMentors = plan.mentors.filter((m) => !excluded.has(m.id))
  const asMember = (kind: TableMember['kind'], id: number): TableMember => ({ kind, id, locked: false })
  const arrivedUnseated = [
    ...plan.students.filter((s) => s.checked_in && !seated.has(`student:${s.id}`)).map((s) => asMember('student', s.id)),
    ...attendingMentors.filter((m) => !seated.has(`mentor:${m.id}`)).map((m) => asMember('mentor', m.id)),
  ]
  const notHereYet = plan.students.filter((s) => !s.checked_in && !seated.has(`student:${s.id}`))
  const checkedIn = plan.students.filter((s) => s.checked_in).length
  const expectedTotal = plan.expected.reduce((sum, e) => sum + e.count, 0)
  const studentsWithoutGender = plan.students.filter((s) => !s.gender && !s.checked_in).length

  async function save(tables: SeatingTable[], excludedIds: number[]) {
    const previous = plan
    setPlan({ ...previous, tables, excluded_mentor_ids: excludedIds })
    try {
      setPlan(await api.savePlan(sheetId, tables, excludedIds, previous.updated_at))
      setError(null)
    } catch (err) {
      setPlan(previous)
      setError(errorMessage(err, 'Could not save the change'))
    }
  }

  function withoutPerson(tables: SeatingTable[], key: Key) {
    return tables.map((t) => ({ ...t, members: t.members.filter((m) => keyOf(m) !== key) }))
  }

  // People moved by hand are locked so Regenerate and check-in leave them where they were put.
  function move(key: Key, target: string) {
    if (seated.get(key) === target || (!seated.has(key) && target === UNASSIGNED)) return
    const [kind, id] = key.split(':') as [TableMember['kind'], string]
    let tables = withoutPerson(plan.tables, key)
    if (target !== UNASSIGNED) {
      tables = tables.map((t) => (t.id === target ? { ...t, members: [...t.members, { kind, id: Number(id), locked: true }] } : t))
    }
    save(tables, plan.excluded_mentor_ids)
  }

  function toggleLock(tableId: string, key: Key) {
    save(
      plan.tables.map((t) =>
        t.id === tableId ? { ...t, members: t.members.map((m) => (keyOf(m) === key ? { ...m, locked: !m.locked } : m)) } : t,
      ),
      plan.excluded_mentor_ids,
    )
  }

  function setGroup(tableId: string, group: string) {
    const [gender, level] = group.split(':') as [Gender | '', Level | '']
    save(plan.tables.map((t) => (t.id === tableId ? { ...t, gender, level } : t)), plan.excluded_mentor_ids)
  }

  function markNotComing(mentorId: number) {
    save(withoutPerson(plan.tables, `mentor:${mentorId}`), [...plan.excluded_mentor_ids, mentorId])
  }

  function restoreMentor(mentorId: number) {
    save(plan.tables, plan.excluded_mentor_ids.filter((id) => id !== mentorId))
  }

  function addTable() {
    const table: SeatingTable = { id: newTableId(), name: `Table ${plan.tables.length + 1}`, gender: '', level: '', members: [] }
    save([...plan.tables, table], plan.excluded_mentor_ids)
  }

  function removeTable(tableId: string) {
    const table = plan.tables.find((t) => t.id === tableId)!
    if (table.members.length > 0 && !window.confirm(`Remove ${table.name}? Its ${table.members.length} people go back to "Not seated".`)) return
    save(plan.tables.filter((t) => t.id !== tableId), plan.excluded_mentor_ids)
  }

  async function generate() {
    if (plan.tables.length > 0 && !window.confirm('Re-plan the tables? Checked-in and locked people keep their table; everyone else is rearranged.')) return
    setGenerating(true)
    try {
      setPlan(await api.generatePlan(sheetId))
      setError(null)
    } catch (err) {
      setError(errorMessage(err, 'Could not plan the tables'))
    } finally {
      setGenerating(false)
    }
  }

  const chipFor = (member: TableMember, where: string, tableId?: string) => (
    <PersonChip
      key={keyOf(member)}
      member={member}
      student={member.kind === 'student' ? studentsById.get(member.id) : undefined}
      mentor={member.kind === 'mentor' ? mentorsById.get(member.id) : undefined}
      tables={plan.tables}
      where={where}
      onMove={(target) => move(keyOf(member), target)}
      onToggleLock={tableId ? () => toggleLock(tableId, keyOf(member)) : undefined}
      onNotComing={member.kind === 'mentor' ? () => markNotComing(member.id) : undefined}
    />
  )

  return (
    <section className="dg" aria-label="Tables">
      <div className="dg-controls">
        <button type="button" className="primary with-icon" onClick={generate} disabled={generating}>
          <ShuffleIcon /> {generating ? 'Planning…' : plan.tables.length > 0 ? 'Re-plan tables' : 'Plan tables'}
        </button>
        <span className="muted dg-summary">
          {checkedIn} checked in · about {Math.round(expectedTotal)} expected · {attendingMentors.length} mentors
        </span>
      </div>
      <ul className="dg-expected" aria-label="Expected students by group">
        {plan.expected.map((e) => (
          <li key={`${e.gender}:${e.level}`}>
            <span className="muted">
              {GENDER_LABEL[e.gender]} · {LEVEL_LABEL[e.level]}
            </span>{' '}
            <strong>~{e.count}</strong>
          </li>
        ))}
      </ul>
      <p className="muted dg-help">
        Tables are planned from expected turnout for about 6 students and 2 mentors each, and each gets a group. Check-in
        fills one table of the student’s group to 3 per mentor before starting the next, then tops tables up to 4 per
        mentor. Levels stay apart unless a level has no table. Drag people or use their Move menu; anyone you
        move is locked, so check-in and Re-plan leave them there.
      </p>
      <RatesNote plan={plan} />

      {error && <p className="error">{error}</p>}
      {plan.mentors.length === 0 && (
        <p className="dg-notice">
          No mentors on the roster yet. <Link to="/mentors">Add mentors</Link> so tables get someone to lead them.
        </p>
      )}
      {studentsWithoutGender > 0 && (
        <p className="dg-notice">
          {studentsWithoutGender} {studentsWithoutGender === 1 ? 'sign-up doesn’t' : 'sign-ups don’t'} say their gender.
          Check-in will ask.
        </p>
      )}

      <DropZone id={UNASSIGNED} dragOver={dragOver} setDragOver={setDragOver} onDropKey={move} className="dg-tray">
        <div className="dg-tray-head">
          <strong>Here, not seated</strong> <span className="muted">{arrivedUnseated.length}</span>
        </div>
        {arrivedUnseated.length > 0 ? (
          <ul className="dg-chips is-row">{arrivedUnseated.map((m) => chipFor(m, UNASSIGNED))}</ul>
        ) : (
          <p className="muted">Everyone who's here has a seat.</p>
        )}
        {notHereYet.length > 0 && (
          <details className="dg-waiting">
            <summary>
              Signed up, not here yet <span className="muted">{notHereYet.length}</span>
            </summary>
            <p className="muted">Drag someone to a table to save them a seat.</p>
            <ul className="dg-chips is-row">{notHereYet.map((s) => chipFor(asMember('student', s.id), UNASSIGNED))}</ul>
          </details>
        )}
        {excluded.size > 0 && (
          <p className="dg-away">
            Not coming:{' '}
            {plan.mentors
              .filter((m) => excluded.has(m.id))
              .map((m, i) => (
                <span key={m.id}>
                  {i > 0 && ', '}
                  {m.name}{' '}
                  <button type="button" className="link-button" onClick={() => restoreMentor(m.id)}>
                    undo
                  </button>
                </span>
              ))}
          </p>
        )}
      </DropZone>

      {plan.tables.length === 0 && (
        <p className="dg-notice">No tables yet. Plan tables once sign-ups are in; you can re-plan any time before or during the event.</p>
      )}

      <div className="dg-grid">
        {plan.tables.map((table) => {
          const students = table.members.filter((m) => m.kind === 'student').map((m) => studentsById.get(m.id)!).filter(Boolean)
          const mentors = table.members.filter((m) => m.kind === 'mentor').map((m) => mentorsById.get(m.id)!).filter(Boolean)
          const here = students.filter((s) => s.checked_in).length
          const warnings = tableWarnings(table, students, mentors)
          return (
            <DropZone
              key={table.id}
              id={table.id}
              dragOver={dragOver}
              setDragOver={setDragOver}
              onDropKey={move}
              className={`dg-table${warnings.some((w) => w.serious) ? ' has-warning' : ''}`}
            >
              <div className="dg-table-head">
                <h4>{table.name}</h4>
                <select
                  className="dg-group"
                  value={`${table.gender}:${table.level}`}
                  onChange={(e) => setGroup(table.id, e.target.value)}
                  aria-label={`Who check-in seats at ${table.name}`}
                >
                  {GROUP_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="chip-icon"
                  aria-label={`Remove ${table.name}`}
                  title="Remove table"
                  onClick={() => removeTable(table.id)}
                >
                  <TrashIcon />
                </button>
              </div>
              <p className="dg-composition">
                {here} here{students.length > here && ` + ${students.length - here} saved`}
                {mentors.length > 0 && ` · fits ${mentors.length * IDEAL_PER_MENTOR} (up to ${mentors.length * MAX_PER_MENTOR})`} ·{' '}
                {mentors.length} {mentors.length === 1 ? 'mentor' : 'mentors'}
              </p>
              {warnings.length > 0 && (
                <ul className="dg-warnings">
                  {warnings.map((w) => (
                    <li key={w.text} className={w.serious ? 'is-serious' : ''}>
                      {w.text}
                    </li>
                  ))}
                </ul>
              )}
              <ul className="dg-chips">
                {[...table.members]
                  .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'mentor' ? -1 : 1))
                  .map((m) => chipFor(m, table.id, table.id))}
                {table.members.length === 0 && <li className="dg-empty">Drop people here</li>}
              </ul>
            </DropZone>
          )
        })}
        {plan.tables.length > 0 && (
          <button type="button" className="dg-add-table with-icon" onClick={addTable}>
            <PlusIcon /> Add table
          </button>
        )}
      </div>
    </section>
  )
}
