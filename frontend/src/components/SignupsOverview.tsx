import type { ReactNode } from 'react'
import type { Overview } from '../signupOverview'
import { CheckIcon, WarningIcon } from './icons'

const GENDERS = { female: 'Girls', male: 'Guys', '': 'No gender' } as const
const LEVELS = { undergrad: 'Undergrad', grad: 'Grad', other: 'Not a student', '': 'No level' } as const

const one = (n: number) => (Math.round(n * 10) / 10).toString()
const percent = (rate: number) => `${Math.round(rate * 100)}%`

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="overview-card" aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  )
}

/** One thin bar per row, scaled to the largest, with its count beside it. */
function BarList({ rows, total }: { rows: { key: string; label: ReactNode; count: number }[]; total: number }) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <ul className="bar-list">
      {rows.map((r) => (
        <li key={r.key} title={`${r.count} of ${total} (${percent(total ? r.count / total : 0)})`}>
          <span className="bar-label">{r.label}</span>
          <span className="bar-track">
            {r.count > 0 && <span className="bar-fill" style={{ width: `${(r.count / max) * 100}%` }} />}
          </span>
          <span className="bar-value">{r.count}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The Sign-ups page's overview: expected turnout, mentors to students, who's coming, contact
 * statuses, how people heard, and the group chats. `onShowChatList` filters the list to the
 * confirmed people still to add to the chats.
 */
export function SignupsOverview({ overview, capacity, columns, onShowChatList }: {
  overview: Overview
  capacity: number | null
  columns: { referral: boolean; chat: boolean; chatAdded: boolean }
  onShowChatList: () => void
}) {
  const { estimate, ratios, chats } = overview
  return (
    <div className="overview" aria-label="Overview">
      <Card title="Expected turnout">
        <div className="overview-hero">
          <span className="overview-number">{estimate.total}</span>
          <span className="muted">
            of {overview.total} signed up
            {capacity !== null && ` · capacity ${capacity}`}
          </span>
        </div>
        {capacity !== null && estimate.total > capacity && (
          <p className="overview-flag is-warn">
            <WarningIcon /> {estimate.total - capacity} over capacity
          </p>
        )}
        <table className="overview-equation">
          <tbody>
            {estimate.terms.map((t) => (
              <tr key={t.label}>
                <td>{t.count} {t.label.toLowerCase()}</td>
                <td>× {percent(t.rate)}</td>
                <td>{one(t.count * t.rate)}</td>
              </tr>
            ))}
            <tr>
              <td>Walk-ins</td>
              <td>+ {percent(estimate.walkInRate)}</td>
              <td>{estimate.walkIns}</td>
            </tr>
          </tbody>
        </table>
        <p className="overview-note">Other statuses count as 0%, and Not a student isn’t counted.</p>
      </Card>

      <Card title="Mentors to students">
        <ul className="overview-ratios">
          {ratios.map((r) => (
            <li key={r.gender}>
              <div className="overview-ratio-head">
                <span className="overview-ratio-group">{GENDERS[r.gender]}</span>
                <span className="overview-ratio">{r.perMentor === null ? '—' : `1 : ${one(r.perMentor)}`}</span>
              </div>
              <span className="muted">
                {r.mentors} {r.mentors === 1 ? 'mentor' : 'mentors'} · {one(r.expected)} expected ({r.confirmed} confirmed)
              </span>
              {r.short > 0 ? (
                <p className="overview-flag is-warn">
                  <WarningIcon /> {r.short} more {r.short === 1 ? 'mentor' : 'mentors'} needed
                </p>
              ) : (
                r.expected > 0 && (
                  <p className="overview-flag is-ok">
                    <CheckIcon /> Enough mentors
                  </p>
                )
              )}
            </li>
          ))}
        </ul>
        <p className="overview-note">
          Tables are planned for 1 mentor to {overview.idealPerMentor} students. Mentors marked absent aren’t counted
          {overview.noGender >= 0.5 && `; ${one(overview.noGender)} expected with no gender aren’t either`}.
        </p>
      </Card>

      <Card title="Who’s coming">
        <table className="overview-breakdown">
          <thead>
            <tr>
              <th />
              {overview.levels.map((l) => <th key={l}>{LEVELS[l]}</th>)}
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {overview.breakdown.map((row) => (
              <tr key={row.gender}>
                <th>{GENDERS[row.gender]}</th>
                {row.cells.map((c) => (
                  <td key={c.level} title={`${c.confirmed} of ${c.count} confirmed`}>
                    {c.count}
                    {c.count > 0 && <span className="overview-sub">{c.confirmed} conf.</span>}
                  </td>
                ))}
                <td>
                  {row.cells.reduce((n, c) => n + c.count, 0)}
                  <span className="overview-sub">{row.cells.reduce((n, c) => n + c.confirmed, 0)} conf.</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="overview-note">Everyone not turned down: {overview.active} of {overview.total}.</p>
      </Card>

      <Card title="Contact status">
        <BarList
          total={overview.total}
          rows={overview.statuses.map((s) => ({
            key: s.value,
            label: <span className={`checkin-status status-${s.value}`}>{s.label}</span>,
            count: s.count,
          }))}
        />
      </Card>

      <Card title="How they heard">
        {columns.referral ? (
          <>
            <BarList total={overview.total} rows={overview.referrals.map((r) => ({ key: r.label, label: r.label, count: r.count }))} />
            {overview.noReferral > 0 && <p className="overview-note">{overview.noReferral} didn’t answer.</p>}
          </>
        ) : (
          <p className="overview-note">
            Add a question like “How did you hear about this event?” to the form and it shows up here.
          </p>
        )}
      </Card>

      <Card title="Group chats">
        {columns.chat ? (
          <>
            <dl className="overview-stats">
              <div>
                <dt>Want to join</dt>
                <dd>{chats.wanting}</dd>
              </div>
              <div>
                <dt>Confirmed</dt>
                <dd>{chats.confirmed}</dd>
              </div>
              <div>
                <dt>Added</dt>
                <dd>{chats.added}</dd>
              </div>
            </dl>
            {chats.confirmed > 0 && (
              <span className="bar-track is-progress" title={`${chats.confirmed - chats.toAdd} of ${chats.confirmed} confirmed are in the chats`}>
                <span className="bar-fill" style={{ width: `${((chats.confirmed - chats.toAdd) / chats.confirmed) * 100}%` }} />
              </span>
            )}
            {chats.toAdd > 0 ? (
              <button type="button" className="overview-action" onClick={onShowChatList}>
                {chats.toAdd} confirmed to add
              </button>
            ) : (
              chats.confirmed > 0 && (
                <p className="overview-flag is-ok">
                  <CheckIcon /> Everyone confirmed is added
                </p>
              )
            )}
            {!columns.chatAdded && (
              <p className="overview-note">Add a checkbox column named “Added to Group Chat” to the sheet to tick people off here.</p>
            )}
          </>
        ) : (
          <p className="overview-note">
            No group chat question or social media ID column found in the sheet.
          </p>
        )}
      </Card>
    </div>
  )
}
