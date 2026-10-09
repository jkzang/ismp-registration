/**
 * The numbers in the Sign-ups page's overview, from the sheet as just read (with statuses still
 * being saved) and the plan. Turnout is estimated the way the tables are planned (seating.py): each
 * sign-up counts as their contact status's show-up rate, plus a share of walk-ins on top.
 */
import { CHAT_STAGES, chatStageOf, needsChat } from './signupColumns'
import { OTHER_SOURCE, referralSourcesOf } from './referralSources'
import type { Contact } from './signupTracker'
import { CONTACT_STATUSES, type ContactStatus, type Gender, type Level, type SeatingPlan } from './types'

export const NOT_COMING: ContactStatus[] = ['not_coming', 'no_room', 'no_space', 'not_inviting']

export type OverviewPlan = Pick<
  SeatingPlan,
  'students' | 'mentors' | 'excluded_mentor_ids' | 'show_up_rates' | 'walk_in_rate' | 'ideal_per_mentor'
>

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

export function overviewOf(contacts: Contact[], plan: OverviewPlan) {
  const studentByKey = new Map(plan.students.map((s) => [s.key, s]))
  // The door's answers fill in what the sheet left blank, as at check-in.
  const people = contacts.map((c) => {
    const student = studentByKey.get(c.key)
    const gender: Gender | '' = c.gender || student?.gender || ''
    const level: Level | '' = c.level || student?.level || ''
    const checkedIn = !!student?.checked_in
    const chance = checkedIn ? 1 : level === 'other' ? 0 : (plan.show_up_rates[c.status] ?? 0)
    return { ...c, gender, level, checkedIn, chance }
  })
  const isStudent = (p: (typeof people)[number]) => p.level !== 'other'

  // Estimated turnout, term by term.
  const terms = [
    ...(people.some((p) => p.checkedIn) ? [{ label: 'Checked in', count: people.filter((p) => p.checkedIn).length, rate: 1 }] : []),
    ...CONTACT_STATUSES.flatMap(({ value, label }) => {
      const rate = plan.show_up_rates[value] ?? 0
      const count = people.filter((p) => !p.checkedIn && isStudent(p) && p.status === value).length
      return rate > 0 && count > 0 ? [{ label, count, rate }] : []
    }).sort((a, b) => b.rate - a.rate),
  ]
  const likely = Math.round(sum(people.map((p) => p.chance)))
  const walkIns = Math.round(plan.walk_in_rate * likely)

  // Students per mentor, by gender, at the expected turnout (walk-ins included).
  const excluded = new Set(plan.excluded_mentor_ids)
  const ratios = (['female', 'male'] as const).map((gender) => {
    const ofGender = people.filter((p) => p.gender === gender)
    const expected = sum(ofGender.map((p) => p.chance)) * (1 + plan.walk_in_rate)
    const mentors = plan.mentors.filter((m) => m.gender === gender && !excluded.has(m.id)).length
    return {
      gender,
      expected,
      confirmed: ofGender.filter((p) => isStudent(p) && p.status === 'confirmed').length,
      mentors,
      perMentor: mentors ? expected / mentors : null,
      // More mentors it would take to keep to the planned ratio.
      short: Math.max(0, Math.ceil(expected / plan.ideal_per_mentor) - mentors),
    }
  })
  const noGender = sum(people.filter((p) => !p.gender).map((p) => p.chance)) * (1 + plan.walk_in_rate)

  // Who's still coming (everyone not turned down either way), by gender and level.
  const active = people.filter((p) => !NOT_COMING.includes(p.status))
  const genders = (['female', 'male', ''] as const).filter((g) => g !== '' || active.some((p) => !p.gender))
  const levels = (['undergrad', 'grad', 'other', ''] as const).filter((l) => l !== '' || active.some((p) => !p.level))
  const breakdown = genders.map((gender) => ({
    gender,
    cells: levels.map((level) => {
      const here = active.filter((p) => p.gender === gender && p.level === level)
      return { level, count: here.length, confirmed: here.filter((p) => p.status === 'confirmed').length }
    }),
  }))

  const statuses = CONTACT_STATUSES.map((s) => ({ ...s, count: people.filter((p) => p.status === s.value).length }))

  // How they heard, sorted into sources; Other last, with what they wrote.
  const heard = new Map<string, number>()
  const otherAnswers: string[] = []
  let noReferral = 0
  for (const p of people) {
    const sources = referralSourcesOf(p.referral)
    if (sources.length === 0) noReferral++
    if (sources.includes(OTHER_SOURCE)) otherAnswers.push(p.referral.trim())
    for (const source of sources) heard.set(source, (heard.get(source) ?? 0) + 1)
  }
  const referrals = [...heard.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => +(a.label === OTHER_SOURCE) - +(b.label === OTHER_SOURCE) || b.count - a.count || a.label.localeCompare(b.label))

  const wanting = active.filter((p) => p.wantsChat)
  const chats = {
    wanting: wanting.length,
    confirmed: wanting.filter((p) => p.status === 'confirmed').length,
    added: people.filter((p) => p.groupChat && chatStageOf(p.groupChat) === 'complete').length,
    toAdd: wanting.filter((p) => p.status === 'confirmed' && needsChat(p.groupChat)).length,
    stages: CHAT_STAGES.map((s) => ({
      ...s,
      count: people.filter((p) => p.groupChat && chatStageOf(p.groupChat) === s.value).length,
    })),
  }

  // New and returning (from the sheet's New or Returning column), overall and among the confirmed.
  const returning = (['new', 'returning', ''] as const).map((value) => ({
    value,
    count: people.filter((p) => p.returning === value).length,
    confirmed: people.filter((p) => p.returning === value && p.status === 'confirmed').length,
  }))

  return {
    total: people.length,
    active: active.length,
    estimate: { terms, likely, walkIns, walkInRate: plan.walk_in_rate, total: likely + walkIns },
    ratios,
    noGender,
    idealPerMentor: plan.ideal_per_mentor,
    breakdown,
    levels,
    statuses,
    referrals,
    noReferral,
    otherAnswers,
    chats,
    returning,
  }
}

export type Overview = ReturnType<typeof overviewOf>
