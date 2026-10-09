import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import type { Overview } from '../signupOverview'
import { RETURNING_LABELS } from '../signupColumns'
import { CheckIcon, CloseIcon, WarningIcon } from './icons'

const GENDERS = { female: 'Girls', male: 'Guys', '': 'No gender' } as const
const LEVELS = { undergrad: 'Undergrad', grad: 'Grad', '': 'No level' } as const

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

/** Slides each row from where it was to where it is now, when the counts reorder the list. */
function useReorderMotion(list: RefObject<HTMLUListElement | null>) {
  const tops = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    const rows = [...(list.current?.children ?? [])] as HTMLElement[]
    const before = tops.current
    tops.current = new Map(rows.map((row) => [row.dataset.key!, row.offsetTop]))
    if (before.size === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    for (const row of rows) {
      const was = before.get(row.dataset.key!)
      const shift = was === undefined ? 0 : was - row.offsetTop
      if (shift) row.animate([{ transform: `translateY(${shift}px)` }, { transform: 'none' }], { duration: 250, easing: 'ease-out' })
    }
  })
}

/** One thin bar per row, scaled to the largest, with its count beside it. */
function BarList({ rows, total }: { rows: { key: string; label: ReactNode; count: number }[]; total: number }) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  const ref = useRef<HTMLUListElement>(null)
  useReorderMotion(ref)
  return (
    <ul className="bar-list" ref={ref}>
      {rows.map((r) => (
        <li key={r.key} data-key={r.key} title={`${r.count} of ${total} (${percent(total ? r.count / total : 0)})`}>
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

/** A pie slice from `from` to `to`, as fractions of the circle clockwise from the top. */
function slicePath(from: number, to: number, r: number) {
  const point = (t: number) => {
    const a = 2 * Math.PI * t - Math.PI / 2
    return `${(r + r * Math.cos(a)).toFixed(2)} ${(r + r * Math.sin(a)).toFixed(2)}`
  }
  return `M ${r} ${r} L ${point(from)} A ${r} ${r} 0 ${to - from > 0.5 ? 1 : 0} 1 ${point(to)} Z`
}

/** New and returning as a pie, with a legend that carries the numbers. */
function ReturningChart({ rows, total }: { rows: Overview['returning']; total: number }) {
  const known = rows.filter((r) => r.value !== '')
  const sum = known.reduce((n, r) => n + r.count, 0)
  const blank = rows.find((r) => r.value === '')?.count ?? 0
  const R = 50
  let at = 0
  const slices = known.flatMap((r) => {
    if (r.count === 0) return []
    const from = at
    at += r.count / sum
    return [{ ...r, from, to: at }]
  })
  const tip = (r: (typeof known)[number]) =>
    `${RETURNING_LABELS[r.value as 'new']}: ${r.count} of ${sum} (${percent(r.count / sum)}) · ${r.confirmed} confirmed`
  return (
    <>
      <div className="returning-pie">
        <svg
          viewBox={`0 0 ${R * 2} ${R * 2}`}
          role="img"
          aria-label={known.map((r) => `${r.count} ${RETURNING_LABELS[r.value as 'new']}`).join(', ')}
        >
          {slices.length === 0 && <circle className="pie-empty" cx={R} cy={R} r={R} />}
          {slices.map((r) =>
            // A whole circle can't be drawn as an arc.
            slices.length === 1 ? (
              <circle key={r.value} className={`pie-slice returning-${r.value}`} cx={R} cy={R} r={R}>
                <title>{tip(r)}</title>
              </circle>
            ) : (
              <path key={r.value} className={`pie-slice returning-${r.value}`} d={slicePath(r.from, r.to, R)}>
                <title>{tip(r)}</title>
              </path>
            ),
          )}
        </svg>
        <ul className="split-legend">
          {known.map((r) => (
            <li key={r.value}>
              <span className={`split-swatch returning-${r.value}`} aria-hidden="true" />
              <span className="split-name">{RETURNING_LABELS[r.value as 'new']}</span>
              <span className="split-count">{r.count}</span>
              <span className="split-detail muted">{sum ? percent(r.count / sum) : '—'} · {r.confirmed} confirmed</span>
            </li>
          ))}
        </ul>
      </div>
      {blank > 0 && (
        <p className="overview-note">
          {blank} of {total} not looked up yet. They’re checked against the spreadsheet’s “Student Database” tab by name, phone or email.
        </p>
      )}
    </>
  )
}

/** Signed up, expected and expected with walk-ins, beside the Sign-ups page's search. */
export function TurnoutSummary({ overview, capacity }: { overview: Overview; capacity: number | null }) {
  const { estimate } = overview
  const over = capacity !== null && estimate.total > capacity
  const stats = [
    { label: 'Signed up', value: overview.total, title: 'Everyone in the sign-up tab' },
    { label: 'Expected', value: estimate.likely, title: 'Each sign-up times their contact status’s show-up rate' },
    {
      label: 'With walk-ins',
      value: estimate.total,
      title: `Expected plus ${percent(estimate.walkInRate)} walk-ins${capacity !== null ? ` · capacity ${capacity}` : ''}${
        over ? ` · ${estimate.total - capacity} over` : ''
      }`,
      warn: over,
    },
  ]
  return (
    <dl className="turnout-summary" aria-label="Turnout">
      {stats.map((s) => (
        <div key={s.label} className={s.warn ? 'is-warn' : undefined} title={s.title}>
          <dt>{s.label}</dt>
          <dd>{s.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * The Sign-ups page's overview: contact statuses with the expected turnout, mentors to students,
 * who's coming, new and returning, how people heard, and the group chats. `onShowChatList` filters the list to the
 * confirmed people still to add to the chats.
 */
export function SignupsOverview({ overview, capacity, columns, onShowChatList }: {
  overview: Overview
  capacity: number | null
  columns: { referral: boolean; chat: boolean; groupChat: boolean; returning: boolean }
  onShowChatList: () => void
}) {
  const { estimate, ratios, chats } = overview
  return (
    <div className="overview" aria-label="Overview">
      <Card title="Contact status">
        <table className="overview-status">
          <thead>
            <tr>
              <th />
              <th>People</th>
              <th>Show-up</th>
              <th>Expected</th>
            </tr>
          </thead>
          <tbody>
            {overview.statuses.map((s) => (
              <tr key={s.value}>
                <th>
                  <span className={`checkin-status status-${s.value}`}>{s.label}</span>
                </th>
                <td>{s.count}</td>
                <td className="muted">{s.rate > 0 ? percent(s.rate) : '—'}</td>
                <td>{s.expected > 0 || (s.count > 0 && s.rate > 0) ? one(s.expected) : '—'}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th>Expected turnout</th>
              <td>{overview.total}</td>
              <td />
              <td>{estimate.likely}</td>
            </tr>
            <tr>
              <th>With walk-ins</th>
              <td />
              <td className="muted">+ {percent(estimate.walkInRate)}</td>
              <td>{estimate.total}</td>
            </tr>
          </tfoot>
        </table>
        {capacity !== null && estimate.total > capacity && (
          <p className="overview-flag is-warn">
            <WarningIcon /> {estimate.total - capacity} over capacity ({capacity})
          </p>
        )}
        <p className="overview-note">
          Expected is each status’s people times its show-up rate, the way the tables are planned. Not a student isn’t
          counted{overview.checkedIn > 0 && ', and anyone checked in counts in full'}.
        </p>
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
        <p className="overview-note">
          Students not turned down: {overview.activeStudents} of {overview.total}. Not a student isn’t shown.
        </p>
      </Card>

      <Card title="New vs returning">
        {columns.returning ? (
          <ReturningChart rows={overview.returning} total={overview.total} />
        ) : (
          <p className="overview-note">The sheet’s New or Returning column is added the next time it’s read.</p>
        )}
      </Card>

      <Card title="How they heard">
        {columns.referral ? (
          <>
            <BarList total={overview.total} rows={overview.referrals.map((r) => ({ key: r.label, label: r.label, count: r.count }))} />
            {overview.noReferral > 0 && <p className="overview-note">{overview.noReferral} didn’t answer.</p>}
            {overview.otherAnswers.length > 0 && (
              <p className="overview-note">Other: {overview.otherAnswers.join(' · ')}</p>
            )}
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
                <dt>Asked to be added</dt>
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
            <BarList
              total={overview.total}
              rows={chats.stages.map((s) => ({
                key: s.value,
                label: <span className={`checkin-status chat-${s.value}`}>{s.label}</span>,
                count: s.count,
              }))}
            />
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
            {!columns.groupChat && (
              <p className="overview-note">The sheet’s Group Chat Status column is added the next time it’s read.</p>
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

/** The overview in a large modal. The close button, Escape or a click outside it closes it. */
export function OverviewDialog({ open, onClose, title, ...props }: Parameters<typeof SignupsOverview>[0] & {
  open: boolean
  onClose: () => void
  title: string
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="overview-dialog"
      aria-labelledby="overview-title"
      onClose={onClose}
      // The dialog itself is only reachable on the backdrop; its content fills the box.
      onClick={(e) => e.target === e.currentTarget && ref.current?.close()}
    >
      <header className="dialog-head">
        <h2 id="overview-title">Overview · {title}</h2>
        <button type="button" className="chip-icon" aria-label="Close" onClick={() => ref.current?.close()}>
          <CloseIcon />
        </button>
      </header>
      <div className="dialog-body">
        {open && (
          <SignupsOverview
            {...props}
            onShowChatList={() => {
              props.onShowChatList()
              ref.current?.close()
            }}
          />
        )}
      </div>
    </dialog>
  )
}
