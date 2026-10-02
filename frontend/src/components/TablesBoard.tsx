import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { api, errorMessage } from '../api'
import { isCounted } from '../capacity'
import {
  type TableLevel,
  type PlanMentor,
  type PlanStudent,
  type SeatingPlan,
  type SeatingTable,
  type Simulation,
  type TableMember,
} from '../types'
import { useUndo } from '../undo'
import { ConfirmDialog } from './ConfirmDialog'
import { ChevronDownIcon, LockIcon, PlayIcon, PlusIcon, ShuffleIcon, TrashIcon, UnlockIcon } from './icons'

// 3 students per mentor is comfortable, 4 is fine. A table seats 8 at most: 2 mentors and 6 students.
const IDEAL_PER_MENTOR = 3
const MAX_PER_MENTOR = 4
const MAX_STUDENTS = 6
const MAX_MENTORS = 2
const UNASSIGNED = 'unassigned'

type Key = `${TableMember['kind']}:${number}`
const keyOf = (m: { kind: TableMember['kind']; id: number }): Key => `${m.kind}:${m.id}`

// A coed table is always one level, so there's no "Coed Any".
const GROUP_OPTIONS: { value: string; label: string }[] = [
  { value: 'female:undergrad', label: 'Girls UG' },
  { value: 'female:grad', label: 'Girls Grad' },
  { value: 'female:', label: 'Girls Any' },
  { value: 'male:undergrad', label: 'Guys UG' },
  { value: 'male:grad', label: 'Guys Grad' },
  { value: 'male:', label: 'Guys Any' },
  { value: 'coed:undergrad', label: 'Coed UG' },
  { value: 'coed:grad', label: 'Coed Grad' },
  { value: ':', label: 'No group' },
]

/** Why a table can't take one more of this kind, or null if it can. */
function fullReason(table: SeatingTable, kind: TableMember['kind']): string | null {
  const count = table.members.filter((m) => m.kind === kind).length
  if (kind === 'student' && count >= MAX_STUDENTS) return `${table.name} already has ${MAX_STUDENTS} students`
  if (kind === 'mentor' && count >= MAX_MENTORS) return `${table.name} already has ${MAX_MENTORS} mentors`
  return null
}

function newTableId() {
  return Math.random().toString(36).slice(2, 10)
}

/** A married couple: a man and a woman with the same last name. */
function isCouple(mentors: PlanMentor[]) {
  const lastName = (m: PlanMentor) => m.name.trim().split(/\s+/).slice(1).pop()?.toLowerCase()
  const [a, b] = mentors
  return mentors.length === 2 && a.gender !== b.gender && !!lastName(a) && lastName(a) === lastName(b)
}

/** Only what breaks the separation rules. */
function tableWarnings(table: SeatingTable, students: PlanStudent[], mentors: PlanMentor[]): string[] {
  const warnings: string[] = []
  const coed = table.gender === 'coed'
  const genders = new Set([coed ? '' : table.gender, ...students.map((s) => s.gender)].filter(Boolean))
  const levels = new Set(students.map((s) => s.level).filter((l) => l === 'undergrad' || l === 'grad'))
  if (genders.size > 1 && !coed) warnings.push('Guys and girls mixed')
  if (levels.size > 1) warnings.push('Undergrad and grad mixed')
  if (mentors.length === 0 && students.length > 0) warnings.push('No mentor')
  if (coed) {
    if (!isCouple(mentors)) warnings.push('Not led by a couple')
    // Nobody should be the only one of their gender at the table.
    if (students.filter((s) => s.gender === 'female').length === 1) warnings.push('Only one girl')
    if (students.filter((s) => s.gender === 'male').length === 1) warnings.push('Only one guy')
    return warnings
  }
  const gender = genders.size === 1 ? [...genders][0] : null
  if (mentors.some((m) => genders.size > 1 || (gender && m.gender !== gender))) warnings.push('Mentor gender mismatch')
  return warnings
}

function Tag({ children, title, off = false }: { children: React.ReactNode; title: string; off?: boolean }) {
  return (
    <span className={`person-tag${off ? ' is-off' : ''}`} title={title}>
      {children}
    </span>
  )
}

function PersonChip({ member, student, mentor, table, fixed = false, onToggleLock, onNotComing }: {
  member: TableMember
  student?: PlanStudent
  mentor?: PlanMentor
  /** The table they sit at; tags that don't match its group are highlighted. */
  table?: SeatingTable
  /** Can't be dragged: the board is showing a simulation. */
  fixed?: boolean
  onToggleLock?: () => void
  onNotComing?: () => void
}) {
  const person = student ?? mentor!
  const gender = person.gender === 'female' ? 'F' : person.gender === 'male' ? 'M' : '?'
  const level = student?.level === 'grad' ? 'G' : student?.level === 'undergrad' ? 'UG' : student?.level === 'other' ? 'Other' : '?'

  return (
    <li
      className={`person-chip${mentor ? ' is-mentor' : ''}${student && !student.checked_in ? ' is-gone' : ''}`}
      title={mentor ? `${person.name} (mentor)` : student && !student.checked_in ? `${person.name} (not here yet)` : person.name}
      draggable={!fixed}
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
          <Tag title={person.gender || 'Gender unknown'} off={!!table?.gender && table.gender !== 'coed' && person.gender !== table.gender}>
            {gender}
          </Tag>
          {student && (
            <Tag
              title={student.level === 'other' ? 'Not a student' : student.level || 'Level unknown'}
              off={!!table?.level && student.level !== table.level}
            >
              {level}
            </Tag>
          )}
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
        {onNotComing && (
          <button type="button" className="chip-text" onClick={onNotComing} title="Mark absent: leave out of this sheet's tables">
            Absent
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

/** Four tables per row (two on phones), rows sharing the height so each table has room to grow. */
function useTableGrid(count: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const cols = width && width < 560 ? 2 : 4
  return { ref, cols, rows: Math.max(1, Math.ceil(count / cols)) }
}

export function TablesBoard({ sheetId, plan: savedPlan, setPlan, signupsChanged, onReplanAnswered }: {
  sheetId: number
  plan: SeatingPlan
  setPlan: (plan: SeatingPlan) => void
  /** A re-sync just changed the sign-ups the tables were planned for: asks whether to re-plan. */
  signupsChanged: boolean
  onReplanAnswered: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [confirmingReplan, setConfirmingReplan] = useState(false)
  // A pretend check-in shown in place of the saved board. The board can't be edited while it's up.
  const [simulation, setSimulation] = useState<Simulation | null>(null)
  const [simulating, setSimulating] = useState(false)
  // How many come in the simulation, as typed. Blank is a random turnout.
  const [attendance, setAttendance] = useState('')
  const [settingAttendance, setSettingAttendance] = useState(false)
  const simulateRef = useRef<HTMLSpanElement>(null)
  const plan = simulation ? { ...savedPlan, ...simulation } : savedPlan
  const [removing, setRemoving] = useState<SeatingTable | null>(null)
  const { push, notify } = useUndo()
  const [dragOver, setDragOver] = useState<string | null>(null)
  // While someone is dragged, the not-seated area shows even when empty so they can be dropped there.
  const [dragging, setDragging] = useState(false)
  const grid = useTableGrid(plan.tables.length)

  const studentsById = new Map(plan.students.map((s) => [s.id, s]))
  const mentorsById = new Map(plan.mentors.map((m) => [m.id, m]))
  const excluded = new Set(plan.excluded_mentor_ids)
  const seated = new Map<Key, string>()
  for (const table of plan.tables) for (const m of table.members) seated.set(keyOf(m), table.id)

  const attendingMentors = plan.mentors.filter((m) => !excluded.has(m.id))
  const asMember = (kind: TableMember['kind'], id: number): TableMember => ({ kind, id, locked: false })
  // Re-planning would move mentors away from students already told their table. The first plan
  // is still allowed, in case check-in began before anyone planned.
  const checkInStarted = savedPlan.tables.length > 0 && savedPlan.students.some((s) => s.checked_in)
  const unseatedMentors = attendingMentors.filter((m) => !seated.has(`mentor:${m.id}`)).map((m) => asMember('mentor', m.id))
  const unseatedStudents = plan.students
    .filter((s) => s.checked_in && !seated.has(`student:${s.id}`))
    .map((s) => asMember('student', s.id))

  // "No space" sign-ups are only listed; the simulation never draws them.
  const signups = savedPlan.students.filter(isCounted).length
  const expectedTurnout = Math.round(plan.expected.reduce((sum, e) => sum + e.count, 0))
  const simulated = {
    came: plan.students.filter((s) => s.checked_in).length,
    over: plan.tables.filter((t) => t.members.filter((m) => m.kind === 'student').length > MAX_STUDENTS).length,
    guessed: plan.students.filter((s, i) => s.gender !== savedPlan.students[i]?.gender).length,
  }

  const moves = simulation?.rearranged
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
  const rearranged =
    moves && (moves.coed_tables > 0 || moves.tables_added > 0 || moves.mentors_seated > 0 || moves.mentors_moved > 0)
      ? 'To ease tables past ' + IDEAL_PER_MENTOR + ' per mentor: ' + [
          moves.coed_tables > 0 && `${plural(moves.coed_tables, 'table')} made coed`,
          moves.tables_added > 0 && `${plural(moves.tables_added, 'table')} added`,
          moves.students_moved > 0 && `${plural(moves.students_moved, 'student')} moved`,
          moves.mentors_seated > 0 && `${plural(moves.mentors_seated, 'spare mentor')} seated`,
          moves.mentors_moved > 0 && `${plural(moves.mentors_moved, 'mentor')} moved to seat a couple together`,
        ].filter(Boolean).join(', ')
      : ''

  // Undo and redo put the whole board back as it was at that step. Its time tells the server which
  // check-ins came after, so seats handed out since then are kept.
  const restore = (previous: SeatingPlan) => async () =>
    setPlan(await api.savePlan(sheetId, previous.tables, previous.excluded_mentor_ids, previous.updated_at))

  const nameOf = (key: Key) => {
    const [kind, id] = key.split(':')
    return (kind === 'mentor' ? mentorsById : studentsById).get(Number(id))?.name ?? 'someone'
  }

  /** `label` finishes "Undid …" and "Redid …". */
  function save(tables: SeatingTable[], excludedIds: number[], label: string) {
    if (!simulation) commit(tables, excludedIds, label)
  }

  async function commit(tables: SeatingTable[], excludedIds: number[], label: string) {
    const previous = savedPlan
    setPlan({ ...previous, tables, excluded_mentor_ids: excludedIds })
    try {
      const next = await api.savePlan(sheetId, tables, excludedIds, previous.updated_at)
      setPlan(next)
      push({ label, undo: restore(previous), redo: restore(next) })
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
    const full = target === UNASSIGNED ? null : fullReason(plan.tables.find((t) => t.id === target)!, kind)
    if (full) return setError(full)
    let tables = withoutPerson(plan.tables, key)
    if (target !== UNASSIGNED) {
      tables = tables.map((t) => (t.id === target ? { ...t, members: [...t.members, { kind, id: Number(id), locked: true }] } : t))
    }
    save(tables, plan.excluded_mentor_ids, `moving ${nameOf(key)}`)
  }

  function toggleLock(tableId: string, key: Key) {
    save(
      plan.tables.map((t) =>
        t.id === tableId ? { ...t, members: t.members.map((m) => (keyOf(m) === key ? { ...m, locked: !m.locked } : m)) } : t,
      ),
      plan.excluded_mentor_ids,
      `the lock on ${nameOf(key)}`,
    )
  }

  function setGroup(tableId: string, group: string) {
    const [gender, level] = group.split(':') as [SeatingTable['gender'], TableLevel | '']
    const table = plan.tables.find((t) => t.id === tableId)!
    save(plan.tables.map((t) => (t.id === tableId ? { ...t, gender, level } : t)), plan.excluded_mentor_ids, `${table.name}’s group change`)
  }

  function markNotComing(mentorId: number) {
    save(withoutPerson(plan.tables, `mentor:${mentorId}`), [...plan.excluded_mentor_ids, mentorId], `marking ${nameOf(`mentor:${mentorId}`)} absent`)
  }

  function restoreMentor(mentorId: number) {
    save(plan.tables, plan.excluded_mentor_ids.filter((id) => id !== mentorId), `putting ${nameOf(`mentor:${mentorId}`)} back`)
  }

  function addTable() {
    const table: SeatingTable = { id: newTableId(), name: `Table ${plan.tables.length + 1}`, gender: '', level: '', members: [] }
    save([...plan.tables, table], plan.excluded_mentor_ids, `adding ${table.name}`)
  }

  function removeTable(tableId: string) {
    setRemoving(null)
    const table = plan.tables.find((t) => t.id === tableId)!
    save(plan.tables.filter((t) => t.id !== tableId), plan.excluded_mentor_ids, `removing ${table.name}`)
  }

  async function generate() {
    setConfirmingReplan(false)
    onReplanAnswered()
    setSimulation(null)
    setGenerating(true)
    const previous = savedPlan
    try {
      const next = await api.generatePlan(sheetId)
      setPlan(next)
      const count = next.tables.length
      notify(`${previous.tables.length > 0 ? 'Re-planned' : 'Planned'} ${count} ${count === 1 ? 'table' : 'tables'}`)
      // Redo brings back this plan, not a fresh random one.
      push({ label: 'the re-plan', undo: restore(previous), redo: restore(next) })
      setError(null)
    } catch (err) {
      setError(errorMessage(err, 'Could not plan the tables'))
    } finally {
      setGenerating(false)
    }
  }

  async function simulate() {
    setSimulating(true)
    try {
      setSimulation(await api.simulatePlan(sheetId, attendance === '' ? null : Number(attendance)))
      setError(null)
    } catch (err) {
      setError(errorMessage(err, 'Could not run the simulation'))
    } finally {
      setSimulating(false)
    }
  }

  useEffect(() => {
    if (!settingAttendance) return
    const onPointer = (e: PointerEvent) => {
      if (!simulateRef.current?.contains(e.target as Node)) setSettingAttendance(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSettingAttendance(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [settingAttendance])

  /** Makes the simulated arrangement the real one: its coed tables and where its mentors sit.
   * The pretend students go; the ones really seated are where they were. */
  function keepSimulation() {
    if (!simulation) return
    const reallySeated = new Set(savedPlan.tables.flatMap((t) => t.members.filter((m) => m.kind === 'student').map((m) => m.id)))
    const tables = simulation.tables.map((t) => ({
      ...t,
      members: t.members.filter((m) => m.kind === 'mentor' || reallySeated.has(m.id)),
    }))
    setSimulation(null)
    commit(tables, savedPlan.excluded_mentor_ids, 'keeping the simulated tables')
  }

  const chipFor = (member: TableMember, tableId?: string) => (
    <PersonChip
      key={keyOf(member)}
      member={member}
      table={tableId ? plan.tables.find((t) => t.id === tableId) : undefined}
      student={member.kind === 'student' ? studentsById.get(member.id) : undefined}
      mentor={member.kind === 'mentor' ? mentorsById.get(member.id) : undefined}
      fixed={!!simulation}
      onToggleLock={tableId && !simulation ? () => toggleLock(tableId, keyOf(member)) : undefined}
      onNotComing={member.kind === 'mentor' && !simulation ? () => markNotComing(member.id) : undefined}
    />
  )

  return (
    <section className="dg" aria-label="Tables" onDragStart={() => setDragging(true)} onDragEnd={() => setDragging(false)}>
      <ConfirmDialog
        open={confirmingReplan}
        title="Re-plan the tables?"
        confirmLabel="Re-plan"
        onConfirm={generate}
        onClose={() => setConfirmingReplan(false)}
      >
        Checked-in and locked people keep their table. Everyone else is rearranged.
      </ConfirmDialog>
      <ConfirmDialog
        open={signupsChanged && !checkInStarted}
        title="Re-plan the tables for the new sign-ups?"
        confirmLabel="Re-plan"
        onConfirm={generate}
        onClose={onReplanAnswered}
      >
        The re-sync changed who’s signed up or how likely they are to come, and the tables were planned for the sign-ups
        as they were. Checked-in and locked people keep their table. Everyone else is rearranged.
      </ConfirmDialog>
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? 'table'}?`}
        confirmLabel="Remove table"
        danger
        onConfirm={() => removing && removeTable(removing.id)}
        onClose={() => setRemoving(null)}
      >
        Its {removing?.members.length} people become unseated.
      </ConfirmDialog>
      <div className="dg-controls">
        {/* The span carries the tooltip, since a disabled button doesn't get hover events. */}
        <span className="dg-plan" title={checkInStarted ? 'Check-in has started, so the tables are set. Move people by dragging.' : undefined}>
          <button
            type="button"
            className="primary with-icon"
            onClick={() => (plan.tables.length > 0 ? setConfirmingReplan(true) : generate())}
            disabled={generating || checkInStarted || !!simulation}
            aria-busy={generating}
          >
            {generating ? <span className="spinner" aria-hidden="true" /> : <ShuffleIcon />}
            {generating ? 'Planning…' : plan.tables.length > 0 ? 'Re-plan' : 'Plan tables'}
          </button>
        </span>
        <span className="dg-simulate" ref={simulateRef}>
          <button
            type="button"
            className="with-icon"
            onClick={simulate}
            disabled={simulating || checkInStarted || plan.tables.length === 0}
            title={checkInStarted ? 'Check-in has started, so the simulation is off.' : `Pretend it's the day: ${attendance === '' ? 'a random turnout checks' : `${attendance} sign-ups check`} in, up to capacity, and ${attendance === '' ? 'is' : 'are'} seated by the check-in rules. Nothing is saved.`}
          >
            <PlayIcon /> {simulating ? 'Simulating…' : simulation ? 'Simulate again' : 'Simulate'}
            {attendance !== '' && <span className="dg-simulate-count">{attendance}</span>}
          </button>
          <button
            type="button"
            className="dg-simulate-more"
            aria-label="Set how many come in the simulation"
            aria-expanded={settingAttendance}
            title="Set how many come"
            onClick={() => setSettingAttendance((open) => !open)}
            disabled={checkInStarted || plan.tables.length === 0}
          >
            <ChevronDownIcon />
          </button>
          {settingAttendance && (
            <form
              className="dg-simulate-menu"
              role="dialog"
              aria-label="Simulated attendance"
              onSubmit={(e) => {
                e.preventDefault()
                setSettingAttendance(false)
                simulate()
              }}
            >
              <label htmlFor="dg-attendance">How many come</label>
              <div className="dg-simulate-row">
                <input
                  id="dg-attendance"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={signups}
                  step={1}
                  autoFocus
                  placeholder={`Random, about ${expectedTurnout}`}
                  value={attendance}
                  onChange={(e) => setAttendance(e.target.value.replace(/\D/g, ''))}
                />
                <button type="submit" className="primary" disabled={simulating}>
                  Simulate
                </button>
              </div>
              <input
                type="range"
                aria-label="How many come"
                min={0}
                max={signups}
                step={1}
                value={attendance === '' ? expectedTurnout : Math.min(Number(attendance), signups)}
                onChange={(e) => setAttendance(e.target.value)}
              />
              <p className="muted">
                Of {signups} sign-ups. Likelier ones are picked more often. Leave it blank for a random turnout.
              </p>
            </form>
          )}
        </span>
        <button type="button" className="with-icon" onClick={addTable} disabled={!!simulation}>
          <PlusIcon /> Table
        </button>
        {plan.mentors.length === 0 && (
          <Link to="/mentors" className="dg-controls-link">
            Add mentors
          </Link>
        )}
        {excluded.size > 0 && (
          <div className="dg-away">
            <span className="dg-label">Mentors absent</span>
            <ul className="dg-chips is-row">
              {plan.mentors
                .filter((m) => excluded.has(m.id))
                .map((m) => (
                  <li key={m.id}>
                    <button type="button" className="away-chip" onClick={() => restoreMentor(m.id)} disabled={!!simulation} title={`Put ${m.name} back`}>
                      {m.name}
                      <PlusIcon />
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        )}
        {(unseatedMentors.length > 0 || unseatedStudents.length > 0 || dragging) && (
          <DropZone id={UNASSIGNED} dragOver={dragOver} setDragOver={setDragOver} onDropKey={move} className="dg-tray">
            {unseatedMentors.length > 0 && (
              <>
                <span className="dg-label">Mentors not seated</span>
                <ul className="dg-chips is-row" aria-label="Mentors not seated">
                  {unseatedMentors.map((m) => chipFor(m))}
                </ul>
              </>
            )}
            {unseatedStudents.length > 0 && (
              <>
                <span className="dg-label">Students not seated</span>
                <ul className="dg-chips is-row" aria-label="Students not seated">
                  {unseatedStudents.map((m) => chipFor(m))}
                </ul>
              </>
            )}
            {unseatedMentors.length === 0 && unseatedStudents.length === 0 && <span className="dg-label">Drop here to unseat</span>}
          </DropZone>
        )}
        {error && <span className="error">{error}</span>}
      </div>
      {simulation && (
        <p className="dg-sim" role="status">
          <strong>Simulation</strong>
          <span>
            {simulated.came} of {signups} sign-ups got in
            {simulation.turned_away > 0 && ` · ${simulation.turned_away} turned away at capacity`}
            {unseatedStudents.length > 0 && ` · ${unseatedStudents.length} with no table to sit at`}
            {simulated.over > 0 && ` · ${simulated.over} ${simulated.over === 1 ? 'table' : 'tables'} past ${MAX_STUDENTS} students`}
            {simulated.guessed > 0 && ` · ${simulated.guessed} with no gender on the sheet given one at random`}
            . {rearranged && `${rearranged}. `}
            Nothing is saved.
          </span>
          {rearranged && !checkInStarted && (
            <button
              type="button"
              className="primary"
              onClick={keepSimulation}
              title="Make these the real tables: the coed and added tables, and where the mentors sit. The pretend students aren't kept."
            >
              Keep these tables
            </button>
          )}
          <button type="button" onClick={() => setSimulation(null)}>
            Back to the plan
          </button>
        </p>
      )}
      <div
        ref={grid.ref}
        className={`dg-grid${generating ? ' is-planning' : ''}`}
        aria-busy={generating}
        style={{
          gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))`,
        }}
      >
        {plan.tables.length === 0 && <p className="dg-empty-board muted">No tables</p>}
        {plan.tables.map((table) => {
          const students = table.members.filter((m) => m.kind === 'student').map((m) => studentsById.get(m.id)!).filter(Boolean)
          const mentors = table.members.filter((m) => m.kind === 'mentor').map((m) => mentorsById.get(m.id)!).filter(Boolean)
          const warnings = tableWarnings(table, students, mentors)
          const fits = mentors.length * IDEAL_PER_MENTOR
          const most = Math.min(mentors.length * MAX_PER_MENTOR, MAX_STUDENTS)
          const fill = students.length > most ? 'is-over' : students.length > fits ? 'is-warm' : ''
          return (
            <DropZone
              key={table.id}
              id={table.id}
              dragOver={dragOver}
              setDragOver={setDragOver}
              onDropKey={move}
              className={`dg-table is-${table.gender || 'nogroup'}${warnings.length ? ' has-warning' : ''}`}
            >
              <div className="dg-table-head">
                <h4>{table.name}</h4>
                <select
                  className="dg-group"
                  value={`${table.gender}:${table.level}`}
                  onChange={(e) => setGroup(table.id, e.target.value)}
                  disabled={!!simulation}
                  aria-label={`Group for ${table.name}`}
                >
                  {GROUP_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <button type="button" className="chip-icon dg-remove" aria-label={`Remove ${table.name}`} title="Remove table" disabled={!!simulation} onClick={() => (table.members.length > 0 ? setRemoving(table) : removeTable(table.id))}>
                  <TrashIcon />
                </button>
              </div>
              <div className={`dg-fill ${fill}`} title={`${students.length} students; fits ${fits}, up to ${most}`}>
                <span className="dg-fill-track">
                  <span className="dg-fill-bar" style={{ width: `${Math.min(100, fits ? (students.length / fits) * 100 : students.length ? 100 : 0)}%` }} />
                </span>
                <span className="dg-fill-count">
                  {students.length}/{fits}
                </span>
              </div>
              {warnings.length > 0 && <p className="dg-warning">{warnings.join(' · ')}</p>}
              <ul className="dg-chips">
                {[...table.members]
                  .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'mentor' ? -1 : 1))
                  .map((m) => chipFor(m, table.id))}
              </ul>
            </DropZone>
          )
        })}
      </div>
    </section>
  )
}
