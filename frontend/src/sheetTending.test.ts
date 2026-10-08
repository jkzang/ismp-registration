import { describe, expect, it } from 'vitest'
import { expectedTurnout, planTending, STATS_ROWS, STATS_TITLE, statsRowsIn, type Turnout } from './sheetTending'
import { chatAnswerOf, readContacts } from './signupTracker'

const NOW = new Date(2026, 9, 8, 12, 0).getTime()
const QUESTION = 'Are you already part of our WeChat/Line group chat?'
const HEADER = ['Timestamp', 'Name', 'Phone', 'Gender', 'Enrollment Status', QUESTION, 'LINE ID']
const DATABASE = [
  ['Name', 'Phone'],
  ['Amy Lin', '858-555-0100'],
]
const TURNOUT: Turnout = {
  show_up_rates: { not_contacted: 0.5, confirmed: 0.9 },
  walk_in_rate: 0.2,
  checkedIn: new Set(),
  capacity: 2,
}
// Each table takes two columns: its name, then a name and a number on each row.
const table = (values: string[][], t: number) =>
  values.slice(3, 12).map((r) => r.slice(t * 2, t * 2 + 2)).filter((r) => r.some(Boolean))

describe('the group chat question', () => {
  it('reads the form’s three answers', () => {
    expect(chatAnswerOf('Yes')).toBe('in')
    expect(chatAnswerOf('Yes!')).toBe('in')
    expect(chatAnswerOf('No - Please help me join!')).toBe('add')
    expect(chatAnswerOf('No thank you, I don’t want to be added')).toBe('declined')
    expect(chatAnswerOf("No thank you, I don't want to be added")).toBe('declined')
    expect(chatAnswerOf('')).toBe('')
  })
})

describe('planTending on a fresh form tab', () => {
  const values = [
    HEADER,
    ['10/1/2026 9:00:00', 'Amy Lin', '(858) 555-0100', 'Female', 'Undergrad', 'Yes', 'amy_line'],
    ['10/2/2026 9:00:00', 'Ben Wu', '', 'Male', 'Grad', 'No thank you, I don’t want to be added', ''],
    ['10/8/2026 9:00:00', 'Cat Ho', '', 'Female', 'Grad', 'No - Please help me join!', ''],
  ]
  const plan = planTending(values, {}, DATABASE, { now: NOW, turnout: TURNOUT })!

  it('keeps the timestamp in A, puts the three statuses in B to D, and Contacted At last', () => {
    expect(plan.rowOp).toEqual({ kind: 'insert', at: 0, count: STATS_ROWS })
    expect(plan.columnOps).toEqual([{ kind: 'insert', at: 1 }, { kind: 'insert', at: 2 }, { kind: 'insert', at: 3 }])
    expect(plan.headerRow).toBe(STATS_ROWS)
    expect(plan.values[STATS_ROWS]).toEqual(['Timestamp', 'Contact Status', 'New or Returning', 'Group Chat Status', ...HEADER.slice(1), 'Contacted At'])
    expect(plan.newColumns.map((c) => c.column)).toEqual([1, 2, 3, 10])
    expect(plan.dropdowns.map((c) => c.column)).toEqual([1, 2, 3])
  })

  it('fills the columns, the group chats from the form’s answers', () => {
    const { contacts } = readContacts(plan.values, {})
    expect(contacts.map((c) => [c.name, c.status, c.returning, c.groupChat, c.wantsChat])).toEqual([
      ['Amy Lin', 'not_contacted', 'returning', 'already_in', false],
      ['Ben Wu', 'not_contacted', 'new', 'declined', false],
      ['Cat Ho', 'not_contacted', 'new', 'not_invited', true],
    ])
    expect(plan.values[STATS_ROWS + 1].slice(0, 4)).toEqual(['10/1/2026 9:00:00', 'Not Contacted', 'Returning', 'Already In Group'])
    expect(plan.cells).toContainEqual({ row: STATS_ROWS + 2, column: 3, text: "Doesn't Want To Join" })
  })

  it('puts the statistics on top as side-by-side tables, with two empty rows before the header', () => {
    expect(plan.values[0][0].startsWith(STATS_TITLE)).toBe(true)
    expect(plan.values[0][0]).toContain('expected attendance 2')
    expect(plan.values[1]).toEqual([])
    expect(plan.values[2]).toEqual([
      'Expected attendance', 'Count', 'Overview', 'Count', 'Contact status', 'Count',
      'Group chats', 'Count', 'Gender & level', 'Count', 'New vs returning', 'Count',
    ])
    // Three not contacted at 50% is 1.5, so 2, and 20% walk-ins of that is 0.
    expect(table(plan.values, 0)).toEqual([
      ['Expected', '2'],
      ['From sign-ups', '2'],
      ['Walk-ins (+20%)', '0'],
      ['Capacity', '2'],
      ['Room left', '0'],
    ])
    expect(table(plan.values, 1)[0]).toEqual(['Signed up', '3'])
    expect(table(plan.values, 1)[8]).toEqual(['To add to chats', '0'])
    expect(table(plan.values, 2)[0]).toEqual(['Not Contacted', '3  ·  100%'])
    expect(table(plan.values, 3)[6]).toEqual(['Already In Group', '1  ·  33%'])
    expect(table(plan.values, 4)[0]).toEqual(['Girls', '2  ·  67%'])
    expect(table(plan.values, 5)[0]).toEqual(['New', '2  ·  67%'])
    expect(plan.values[STATS_ROWS - 2]).toEqual([])
    expect(plan.values[STATS_ROWS - 1]).toEqual([])
    expect(statsRowsIn(plan.values, plan.headerRow)).toBe(STATS_ROWS)
  })

  it('drops the empty rows below the last sign-up', () => {
    expect(plan.rowCount).toBe(STATS_ROWS + 4)
  })

  it('shows a dash without a plan to estimate from', () => {
    const bare = planTending(values, {}, DATABASE, { now: NOW })!
    expect(table(bare.values, 0)[0]).toEqual(['Expected', '—'])
  })

  it('leaves a tended tab alone', () => {
    const again = planTending(plan.values, {}, DATABASE, { now: NOW, turnout: TURNOUT })!
    expect(again).toMatchObject({ rowOp: null, columnOps: [], changed: false, newColumns: [], dropdowns: [], cells: [], stats: null })
  })
})

describe('expectedTurnout', () => {
  it('counts the checked in as here, leaves out Not a student, and adds walk-ins', () => {
    const people = [
      { key: 'a', level: 'undergrad', status: 'confirmed' as const },
      { key: 'b', level: 'grad', status: 'confirmed' as const },
      { key: 'c', level: 'other', status: 'confirmed' as const },
      { key: 'd', level: 'grad', status: 'not_coming' as const },
    ]
    expect(expectedTurnout(people, { ...TURNOUT, checkedIn: new Set(['d']), walk_in_rate: 0.5 })).toEqual({
      likely: 3,
      walkIns: 2,
      total: 5,
      checkedIn: 1,
    })
  })
})

describe('tabs tended by earlier versions', () => {
  it('grows a six-row block, and moves the columns from the end to B to D', () => {
    const values = [
      [`${STATS_TITLE}  ·  kept up to date`],
      ['Sign-ups', '1 signed up'],
      ['New or returning', '1 new'],
      ['Contact status', '1 confirmed'],
      ['Group chats', '1 to do'],
      [],
      ['Timestamp', 'Name', 'Contact Status', 'New or Returning', 'Group Chat Status', 'Contacted At'],
      ['10/1/2026 9:00:00', 'Amy', 'Confirmed', 'New', 'Not Invited', ''],
    ]
    expect(statsRowsIn(values, 6)).toBe(6)
    const plan = planTending(values, {}, null, { now: NOW })!
    expect(plan.rowOp).toEqual({ kind: 'insert', at: 6, count: STATS_ROWS - 6 })
    expect(plan.columnOps).toEqual([
      { kind: 'move', from: 2, to: 1 },
      { kind: 'move', from: 3, to: 2 },
      { kind: 'move', from: 4, to: 3 },
    ])
    expect(plan.values[STATS_ROWS]).toEqual(['Timestamp', 'Contact Status', 'New or Returning', 'Group Chat Status', 'Name', 'Contacted At'])
    expect(plan.values[STATS_ROWS + 1]).toEqual(['10/1/2026 9:00:00', 'Confirmed', 'New', 'Not Invited', 'Amy'])
    expect(plan.cells).toEqual([])
  })

  it('moves the timestamp back to A from behind the columns in A to C, and grows the 13-row block', () => {
    const values = [
      [`${STATS_TITLE}  ·  kept up to date`],
      [],
      ['Overview', 'Count'],
      ...Array.from({ length: 9 }, () => ['x', '1']),
      [],
      ['Contact Status', 'New or Returning', 'Group Chat Status', 'Timestamp', 'Name', QUESTION, 'Contacted At'],
      ['Not Invited', 'New', 'Not Invited', '10/1/2026 9:00:00', 'Amy', 'Yes', ''],
    ]
    expect(statsRowsIn(values, 13)).toBe(13)
    const plan = planTending(values, {}, null, { now: NOW, version: 0 })!
    expect(plan.rowOp).toEqual({ kind: 'insert', at: 13, count: 1 })
    expect(plan.setVersion).toBe(true)
    expect(plan.columnOps).toEqual([{ kind: 'move', from: 3, to: 0 }])
    expect(plan.values[STATS_ROWS]).toEqual(['Timestamp', 'Contact Status', 'New or Returning', 'Group Chat Status', 'Name', QUESTION, 'Contacted At'])
    // The first version's Not Invited gives way to the answer: Yes is Already In Group.
    expect(plan.values[STATS_ROWS + 1]).toEqual(['10/1/2026 9:00:00', 'Not Invited', 'New', 'Already In Group', 'Amy', 'Yes'])
  })
})

describe('group chat statuses the first version got wrong', () => {
  const header = ['Timestamp', 'Contact Status', 'New or Returning', 'Group Chat Status', 'Name', QUESTION]
  const values = [
    header,
    ['1', 'Not Contacted', 'New', "Doesn't Want To Join", 'Amy', 'No - Please help me join!'],
    ['2', 'Not Contacted', 'New', 'Not Invited', 'Ben', 'Yes'],
    ['3', 'Not Contacted', 'New', "Doesn't Want To Join", 'Cat', 'No thank you, I don’t want to be added'],
    ['4', 'Not Contacted', 'New', 'Added To WeChat', 'Dee', 'No - Please help me join!'],
  ]
  const chats = (version: number) =>
    readContacts(planTending(values, {}, null, { now: NOW, version })!.values, {}).contacts.map((c) => c.groupChat)

  it('are put right once, catching up from an earlier version', () => {
    expect(chats(1)).toEqual(['not_invited', 'already_in', 'declined', 'added_wechat'])
  })

  it('are left alone after that, so a volunteer’s change stays', () => {
    expect(chats(2)).toEqual(['declined', 'not_invited', 'declined', 'added_wechat'])
  })
})

describe('No Response after 48 hours', () => {
  const header = ['Timestamp', 'Contact Status', 'New or Returning', 'Group Chat Status', ...HEADER.slice(1), 'Contacted At']
  const row = (name: string, status: string, contacted: string) =>
    ['10/1/2026 9:00:00', status, 'New', 'Not Invited', name, '', 'Female', 'Undergrad', '', '', contacted]
  const values = [
    header,
    row('Old', 'Awaiting Response', '2026-10-06 11:59'),
    row('Recent', 'Awaiting Response', '2026-10-07 09:00'),
    row('Unstamped', 'Awaiting Response', ''),
    row('Confirmed', 'Confirmed', '2026-10-01 09:00'),
  ]
  const plan = planTending(values, {}, null, { now: NOW })!
  const { contacts } = readContacts(plan.values, {})

  it('moves people awaiting a response for 48 hours to No Response', () => {
    expect(plan.columnOps).toEqual([])
    expect(contacts.map((c) => c.status)).toEqual(['no_response', 'awaiting_response', 'awaiting_response', 'confirmed'])
    expect(plan.values[STATS_ROWS + 1][1]).toBe('No Response')
  })

  it('starts the clock for someone awaiting with no time', () => {
    expect(contacts[2].contactedAt).toBe('2026-10-08 12:00')
  })
})

describe('older sheets', () => {
  it('turns a ticked “Added to Group Chat” box into Added To Line or WeChat', () => {
    const values = [
      ['Timestamp', 'Name', 'LINE ID', 'WeChat ID', 'Added to Group Chat'],
      ['1', 'Amy', 'amy_line', '', 'TRUE'],
      ['2', 'Ben', '', 'ben_wx', 'TRUE'],
      ['3', 'Cal', '', '', 'FALSE'],
    ]
    const { contacts } = readContacts(planTending(values, {}, null, { now: NOW })!.values, {})
    expect(contacts.map((c) => c.groupChat)).toEqual(['added_line', 'added_wechat', 'not_invited'])
  })

  it('keeps what was typed', () => {
    const values = [
      ['Timestamp', 'Name', 'Contact Status', 'Group Chat Status'],
      ['1', 'Amy', 'Confirmed', 'Line QR Shared'],
    ]
    const plan = planTending(values, {}, null, { now: NOW })!
    expect(plan.newColumns.map((c) => c.header)).toEqual(['New or Returning', 'Contacted At'])
    expect(plan.values[STATS_ROWS + 1]).toEqual(['1', 'Confirmed', '', 'Line QR Shared', 'Amy'])
    expect(plan.cells.filter((c) => c.row > STATS_ROWS)).toEqual([])
  })
})
