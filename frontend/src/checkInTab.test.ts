import { describe, expect, it } from 'vitest'
import { checkInLayout, checkInTabTitle, type Cell } from './checkInTab'
import type { PlanStudent, SeatingPlan } from './types'

const student = (id: number, name: string, checked_in: boolean, nickname = ''): PlanStudent => ({
  id,
  key: `row-${id}`,
  name,
  nickname,
  gender: 'female',
  level: 'undergrad',
  status: 'confirmed',
  checked_in,
  waitlisted_at: null,
  chance: 1,
})

const plan: SeatingPlan = {
  tables: [
    {
      id: 't1',
      name: 'Table 1',
      gender: 'female',
      level: 'undergrad',
      members: [
        { kind: 'mentor', id: 1, locked: false },
        { kind: 'student', id: 11, locked: false },
        { kind: 'student', id: 12, locked: true },
      ],
    },
    { id: 't2', name: 'Table 2', gender: '', level: '', members: [] },
  ],
  excluded_mentor_ids: [],
  students: [student(11, 'Zoe', false), student(12, 'Amy', true, 'A'), student(13, 'Beth', true)],
  mentors: [{ id: 1, name: 'Grace Lee', gender: 'female' }],
  expected: [],
  show_up_rates: {},
  updated_at: '',
}

const values = (rows: Cell[][]) => rows.map((row) => row.map((c) => c.userEnteredValue?.stringValue ?? ''))

describe('the check-in tab', () => {
  it('is named after the sign-up tab, within Google’s limit', () => {
    expect(checkInTabTitle('Fall Kickoff')).toBe('Fall Kickoff - Check In')
    expect(checkInTabTitle('x'.repeat(120))).toHaveLength(100)
  })

  it('lists everyone by name with whether they’re here and their table', () => {
    const rows = values(checkInLayout(plan, 'Fall - Check In').rows)
    expect(rows[0][0]).toBe('Fall - Check In')
    expect(rows[1][0]).toBe('2 checked in  ·  3 signed up  ·  2 tables  ·  1 mentor')
    expect(rows.slice(4, 8).map((r) => r.slice(0, 3))).toEqual([
      ['Name', 'Checked in', 'Table'],
      ['Amy (A)', '✓  Here', 'Table 1'],
      ['Beth', '✓  Here', '—'],
      ['Zoe', 'Not yet', 'Table 1'],
    ])
  })

  it('shows each table with its group, mentors and students, those here first', () => {
    const rows = values(checkInLayout(plan, 'Fall - Check In').rows)
    const column = (c: number) => rows.slice(5).map((r) => r[c].trim()).filter(Boolean)
    expect(column(4)).toEqual(['Table 1', 'Girls UG  ·  1 of 2 here', '★  Grace Lee', '✓  Amy (A)', 'Zoe'])
    expect(column(6)).toEqual(['Table 2', 'No group  ·  0 of 0 here', 'No mentor'])
  })

  it('keeps every row the same width, with a height for each', () => {
    const { rows, columnCount, rowHeights } = checkInLayout(plan, 'Fall - Check In')
    expect(rows.every((r) => r.length === columnCount)).toBe(true)
    expect(rowHeights).toHaveLength(rows.length)
  })

  it('makes the cards in a row the same height, closed at the bottom', () => {
    const { rows } = checkInLayout(plan, 'Fall - Check In')
    const bottom = (c: number) => rows.findLastIndex((r) => r[c].userEnteredFormat?.borders?.bottom)
    expect(bottom(4)).toBe(bottom(6))
    expect(bottom(4)).toBe(5 + 4)
  })

  it('says when there are no tables yet', () => {
    const rows = values(checkInLayout({ ...plan, tables: [] }, 'Fall - Check In').rows)
    expect(rows[5][4]).toBe('No tables planned yet.')
  })
})
