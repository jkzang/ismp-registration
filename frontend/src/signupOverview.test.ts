import { describe, expect, it } from 'vitest'
import { overviewOf, type OverviewPlan } from './signupOverview'
import { readContacts } from './signupTracker'

const values = [
  ['Timestamp', 'Name', 'Gender', 'Enrollment Status', 'Contact Status', 'How did you hear about this event?',
    'Would you like to join our group chats?', 'WeChat ID', 'Instagram', 'Added to Group Chat'],
  ['1', 'Amy', 'Female', 'Undergrad', 'Confirmed', 'Friend, Instagram', 'Yes', 'amy_wx', '', 'TRUE'],
  ['2', 'Bea', 'Female', 'Grad', 'Confirmed', 'friend', 'Yes please', '', '@bea', 'FALSE'],
  ['3', 'Cal', 'Male', 'Undergrad', 'Awaiting response', '', 'No', 'cal_wx', '', ''],
  ['4', 'Dee', 'Female', 'Other', 'Confirmed', 'Flyer', 'Yes', '', '', ''],
  ['5', 'Eli', 'Male', 'Grad', 'Not coming', 'Flyer', 'Yes', 'eli', '', ''],
]

const plan: OverviewPlan = {
  students: [],
  mentors: [
    { id: 1, name: 'M1', gender: 'female' },
    { id: 2, name: 'M2', gender: 'male' },
    { id: 3, name: 'M3', gender: 'male' },
  ],
  excluded_mentor_ids: [3],
  show_up_rates: { confirmed: 0.85, awaiting_response: 0.4, no_response: 0.2 },
  walk_in_rate: 0.15,
  ideal_per_mentor: 3,
}

describe('readContacts extras', () => {
  const { contacts, columns } = readContacts(values, {})
  it('finds the referral, group chat and social media columns', () => {
    expect(columns).toMatchObject({ referral: true, chat: true, chatAdded: true })
    expect(contacts[0].socials).toEqual([{ label: 'WeChat ID', id: 'amy_wx' }])
    expect(contacts[1].socials).toEqual([{ label: 'Instagram', id: '@bea' }])
  })
  it('reads who wants to join and who was added', () => {
    expect(contacts.map((c) => c.wantsChat)).toEqual([true, true, false, true, true])
    expect(contacts.map((c) => c.chatAdded)).toEqual([true, false, false, false, false])
  })
  it('without a join question, anyone who gave an ID wants to join', () => {
    const { contacts } = readContacts(values.map((r) => r.filter((_, i) => i !== 6)), {})
    expect(contacts.map((c) => c.wantsChat)).toEqual([true, true, true, false, true])
  })
})

describe('overviewOf', () => {
  const { contacts } = readContacts(values, {})
  const o = overviewOf(contacts, plan)

  it('estimates turnout like the planner, leaving out Not a student', () => {
    // Amy and Bea confirmed (0.85 each), Cal awaiting (0.4): 2.1, so 2, plus 15% walk-ins.
    expect(o.estimate.terms).toEqual([
      { label: 'Confirmed', count: 2, rate: 0.85 },
      { label: 'Awaiting response', count: 1, rate: 0.4 },
    ])
    expect(o.estimate).toMatchObject({ likely: 2, walkIns: 0, total: 2 })
  })

  it('counts students per mentor by gender, without absent mentors', () => {
    const [girls, guys] = o.ratios
    expect(girls).toMatchObject({ gender: 'female', mentors: 1, confirmed: 2, short: 0 })
    expect(girls.expected).toBeCloseTo(1.7 * 1.15)
    expect(guys).toMatchObject({ gender: 'male', mentors: 1, confirmed: 0 })
  })

  it('breaks down who’s still coming by gender and level', () => {
    expect(o.active).toBe(4)
    const girls = o.breakdown.find((r) => r.gender === 'female')!
    expect(girls.cells.map((c) => [c.level, c.count, c.confirmed])).toEqual([
      ['undergrad', 1, 1],
      ['grad', 1, 1],
      ['other', 1, 1],
    ])
  })

  it('tallies how people heard, splitting checkbox answers', () => {
    expect(o.referrals).toEqual([
      { label: 'Flyer', count: 2 },
      { label: 'Friend', count: 2 },
      { label: 'Instagram', count: 1 },
    ])
    expect(o.noReferral).toBe(1)
  })

  it('counts the group chats among people still coming', () => {
    expect(o.chats).toEqual({ wanting: 3, confirmed: 3, added: 1, toAdd: 2 })
  })
})
