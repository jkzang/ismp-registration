import { useEffect, useRef } from 'react'
import { Link } from 'react-router'
import { CONTACT_STATUSES, type Gender, type SeatingPlan, type Sheet, type TableLevel } from '../types'

const GENDERS: { value: Gender; label: string }[] = [
  { value: 'female', label: 'Girls' },
  { value: 'male', label: 'Guys' },
]
const LEVEL_LABELS: Record<TableLevel, string> = { undergrad: 'undergrad', grad: 'grad' }
// Matches MAX_STUDENTS_PER_TABLE in the backend's seating.py.
const MAX_STUDENTS = 6

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const about = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

/** Why each (gender, level) group got the tables it did. */
function groupLines(plan: SeatingPlan) {
  const excluded = new Set(plan.excluded_mentor_ids)
  const mentors = plan.mentors.filter((m) => !excluded.has(m.id))
  return GENDERS.flatMap(({ value: gender, label }) => {
    const groups = plan.expected.filter((e) => e.gender === gender)
    const tables = plan.tables.filter((t) => t.gender === gender)
    const mentorCount = mentors.filter((m) => m.gender === gender).length
    const mentorText = plural(mentorCount, `${gender} mentor`)
    const shared = tables.filter((t) => t.level === '').length
    if (shared > 0) {
      const turnout = groups.map((e) => `${about(e.count)} ${LEVEL_LABELS[e.level]}`).join(' and ')
      return [{
        key: gender,
        title: `${label}: ${plural(shared, 'table')} for both levels`,
        reason: `About ${turnout} expected, which calls for a table each. With only ${mentorText}, undergrads and grads share.`,
      }]
    }
    return groups.filter((e) => e.count > 0).map((e) => {
      const got = tables.filter((t) => t.level === e.level).length
      const title = `${label} ${LEVEL_LABELS[e.level]}: ${plural(got, 'table')}`
      const expected = `About ${about(e.count)} expected`
      let reason: string
      if (e.tables_wanted === 0) {
        reason = `${expected}, under one person, so no table of their own. Anyone who comes sits with the other ${label.toLowerCase()}.`
      } else if (got < e.tables_wanted) {
        reason = `${expected}, which calls for ${e.tables_wanted} at ${MAX_STUDENTS} students a table. There ${mentorCount === 1 ? 'is' : 'are'} only ${mentorText} and each table needs one, so check-in will squeeze extra students in.`
      } else if (mentorCount === 0) {
        reason = `${expected}, at most ${MAX_STUDENTS} students a table. There are no ${gender} mentors on the roster to seat there yet.`
      } else {
        reason = `${expected}, at most ${MAX_STUDENTS} students a table.`
      }
      return { key: `${gender}:${e.level}`, title, reason }
    })
  })
}

/** Shown once, right after an import: how the first table plan follows from who's expected. */
export function FirstPlanDialog({ sheet, plan, onClose }: { sheet: Sheet; plan: SeatingPlan; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  // People who aren't students (enrollment Other) are listed but never planned for.
  const students = plan.students.filter((s) => s.level !== 'other')
  const guests = plan.students.length - students.length
  const byStatus = CONTACT_STATUSES.map(({ value, label }) => {
    const people = students.filter((s) => s.status === value)
    return { value, label, count: people.length, rate: plan.show_up_rates[value] ?? 0 }
  }).filter((s) => s.count > 0)
  const counted = byStatus.filter((s) => s.rate > 0)
  const uncounted = byStatus.filter((s) => s.rate === 0)
  const noGender = students.filter((s) => !s.gender && s.chance > 0).length

  const expected = plan.expected.reduce((sum, e) => sum + e.count, 0)
  const lines = groupLines(plan)
  const seatedMentors = plan.tables.reduce((n, t) => n + t.members.filter((m) => m.kind === 'mentor').length, 0)
  const mentorCount = plan.mentors.length - plan.excluded_mentor_ids.length

  return (
    <dialog
      ref={ref}
      className="confirm-dialog first-plan-dialog"
      aria-labelledby="first-plan-title"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && ref.current?.close()}
    >
      <div className="confirm-body first-plan-body">
        <h2 id="first-plan-title">
          {plan.tables.length ? `Planned ${plural(plan.tables.length, 'table')}` : 'No tables planned yet'}
        </h2>
        <p className="confirm-message">
          {plural(plan.students.length, 'person', 'people')} signed up and about {about(Math.round(expected * 10) / 10)}{' '}
          {expected === 1 ? 'is' : 'are'} expected to come. Tables are set up for the expected turnout, not for everyone
          on the list.
        </p>

        <section>
          <h3>Who’s expected</h3>
          {counted.length > 0 ? (
            <ul className="first-plan-list">
              {counted.map((s) => (
                <li key={s.value}>
                  <span>{s.count} {s.label.toLowerCase()}</span>
                  <span className="muted">
                    {Math.round(s.rate * 100)}% usually come · about {about(Math.round(s.count * s.rate * 10) / 10)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              Nobody is confirmed, awaiting a response or marked no response yet, so no one is counted. Update the
              Contact Status column in the sheet, Re-sync, then Re-plan.
            </p>
          )}
          {uncounted.length > 0 && (
            <p className="muted">
              Not counted: {uncounted.map((s) => `${s.count} ${s.label.toLowerCase()}`).join(', ')}.
            </p>
          )}
          {guests > 0 && (
            <p className="muted">{plural(guests, 'sign-up')} with enrollment “Other” {guests === 1 ? 'isn’t' : 'aren’t'} planned for.</p>
          )}
          {noGender > 0 && (
            <p className="muted">
              {plural(noGender, 'expected person', 'expected people')} {noGender === 1 ? 'has' : 'have'} no gender on the
              sheet, so they aren’t in the table counts below. The door asks at check-in.
            </p>
          )}
        </section>

        {lines.length > 0 && (
          <section>
            <h3>Why these tables</h3>
            <p className="muted">
              Guys and girls sit apart, and so do undergrads and grads. A table seats up to {MAX_STUDENTS} students
              with up to 2 mentors of their gender.
            </p>
            <ul className="first-plan-groups">
              {lines.map((line) => (
                <li key={line.key}>
                  <strong>{line.title}</strong>
                  <span className="muted">{line.reason}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h3>Mentors</h3>
          {mentorCount === 0 ? (
            <p className="muted">
              The chapter has no mentors yet, so the tables have none. Add them on the{' '}
              <Link to="/mentors">Mentors page</Link>, then Re-plan.
            </p>
          ) : (
            <p className="muted">
              {seatedMentors} of {plural(mentorCount, 'mentor')} {seatedMentors === 1 ? 'is' : 'are'} seated: one at every
              table of their gender first, then a second where there are enough.
              {seatedMentors < mentorCount && ' The rest are under Not seated for you to place.'}
            </p>
          )}
        </section>

        {sheet.capacity !== null && (
          <section>
            <h3>Capacity</h3>
            <p className="muted">
              {expected > sheet.capacity
                ? `About ${about(Math.round(expected * 10) / 10)} expected is more than the capacity of ${sheet.capacity}. Tables are planned for everyone expected; the door waitlists people once it’s full.`
                : `About ${about(Math.round(expected * 10) / 10)} expected fits within the capacity of ${sheet.capacity}. Capacity only limits check-in at the door, not the number of tables.`}
            </p>
          </section>
        )}

        <p className="muted">
          Students get a seat when they check in. Re-plan or drag people around on the Tables board any time before
          check-in starts.
        </p>
      </div>
      <footer className="dialog-foot">
        <button type="button" className="primary" autoFocus onClick={() => ref.current?.close()}>
          Got it
        </button>
      </footer>
    </dialog>
  )
}
