import { describe, expect, it } from 'vitest'
import { overviewOf, type OverviewPlan } from './signupOverview'
import { readContacts } from './signupTracker'

const values = [
  ['Timestamp', 'Name', 'Gender', 'Enrollment Status', 'Contact Status', 'How did you hear about this event?',
    'Would you like to join our group chats?', 'WeChat ID', 'Instagram', 'Group Chat Status', 'New or Returning'],
  ['1', 'Amy', 'Female', 'Undergrad', 'Confirmed', 'Friend, Instagram', 'Yes!', 'amy_wx', '', 'Added To WeChat', 'Returning'],
  ['2', 'Bea', 'Female', 'Grad', 'Confirmed', 'friend', 'No - Please help me join!', '', '@bea', 'Not Invited', 'New'],
  ['3', 'Cal', 'Male', 'Undergrad', 'Awaiting response', '', 'No thank you, I don’t want to be added', 'cal_wx', '', "Doesn't Want To Join", 'New'],
  ['4', 'Dee', 'Female', 'Other', 'Confirmed', 'Flyer', 'No - please help me join', '', '', '', ''],
  ['5', 'Eli', 'Male', 'Grad', 'Not coming', 'Flyer', 'Please help me join', 'eli', '', 'Line QR Shared', 'Returning'],
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
    expect(columns).toMatchObject({ referral: true, chat: true, groupChat: true, returning: true })
    expect(contacts[0].socials).toEqual([{ label: 'WeChat ID', id: 'amy_wx' }])
    expect(contacts[1].socials).toEqual([{ label: 'Instagram', id: '@bea' }])
  })
  it('reads who wants to join, their group chat status and whether they’re returning', () => {
    expect(contacts.map((c) => c.chatAnswer)).toEqual(['in', 'add', 'declined', 'add', 'add'])
    expect(contacts.map((c) => c.wantsChat)).toEqual([false, true, false, true, true])
    expect(contacts.map((c) => c.groupChat)).toEqual(['added_wechat', 'not_invited', 'declined', null, 'line_qr_shared'])
    expect(contacts.map((c) => c.returning)).toEqual(['returning', 'new', 'new', '', 'returning'])
  })
  it('without a join question, anyone who gave an ID wants to join', () => {
    const { contacts } = readContacts(values.map((r) => r.filter((_, i) => i !== 6 && i < 9)), {})
    expect(contacts.map((c) => c.wantsChat)).toEqual([true, true, true, false, true])
  })
})

describe('overviewOf', () => {
  const { contacts } = readContacts(values, {})
  const o = overviewOf(contacts, plan)

  it('estimates turnout like the planner, status by status, leaving out Not a student', () => {
    // Amy and Bea confirmed (0.85 each; Dee isn't a student), Cal awaiting (0.4): 2.1, so 2, plus 15% walk-ins.
    const confirmed = o.statuses.find((s) => s.value === 'confirmed')!
    expect(confirmed).toMatchObject({ count: 3, rate: 0.85 })
    expect(confirmed.expected).toBeCloseTo(1.7)
    expect(o.statuses.find((s) => s.value === 'awaiting_response')).toMatchObject({ count: 1, rate: 0.4, expected: 0.4 })
    expect(o.statuses.find((s) => s.value === 'not_coming')).toMatchObject({ count: 1, rate: 0, expected: 0 })
    expect(o.estimate).toMatchObject({ likely: 2, walkIns: 0, total: 2 })
  })

  it('counts students per mentor by gender, without absent mentors', () => {
    const [girls, guys] = o.ratios
    expect(girls).toMatchObject({ gender: 'female', mentors: 1, confirmed: 2, short: 0 })
    expect(girls.expected).toBeCloseTo(1.7 * 1.15)
    expect(guys).toMatchObject({ gender: 'male', mentors: 1, confirmed: 0 })
  })

  it('breaks down the students still coming by gender and level, without Not a student', () => {
    expect(o.active).toBe(4)
    expect(o.activeStudents).toBe(3)
    expect(o.levels).toEqual(['undergrad', 'grad'])
    const girls = o.breakdown.find((r) => r.gender === 'female')!
    expect(girls.cells.map((c) => [c.level, c.count, c.confirmed])).toEqual([
      ['undergrad', 1, 1],
      ['grad', 1, 1],
    ])
  })

  it('lists the sources most first, Other included', () => {
    const { contacts } = readContacts(
      [values[0], ...['a newspaper', 'a podcast', 'Instagram'].map((heard, i) => ['9' + i, 'P' + i, '', '', '', heard])],
      {},
    )
    expect(overviewOf(contacts, plan).referrals).toEqual([
      { label: 'Other', count: 2 },
      { label: 'Instagram', count: 1 },
    ])
  })

  it('tallies how people heard, splitting checkbox answers', () => {
    expect(o.referrals).toEqual([
      { label: 'Friend or mentor', count: 2 },
      { label: 'Posters & flyers', count: 2 },
      { label: 'Instagram', count: 1 },
    ])
    expect(o.noReferral).toBe(1)
    expect(o.otherAnswers).toEqual([])
  })

  it('counts the group chats among people still coming', () => {
    expect(o.chats).toMatchObject({ wanting: 2, confirmed: 2, added: 1, toAdd: 2, toInvite: 1 })
    expect(o.chats.stages.map((s) => [s.value, s.count])).toEqual([['todo', 1], ['pending', 1], ['complete', 1], ['na', 1]])
  })

  it('counts new and returning, and how many of each confirmed', () => {
    expect(o.returning).toEqual([
      { value: 'new', count: 2, confirmed: 1 },
      { value: 'returning', count: 2, confirmed: 1 },
      { value: '', count: 1, confirmed: 1 },
    ])
  })
})
