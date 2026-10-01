import { describe, expect, it } from 'vitest'
import { doorAction, doorCounts, isReleased, waitlistChance, waitlistOf } from './capacity'
import type { ContactStatus } from './types'

const person = (status: ContactStatus, checked_in = false, waitlisted: string | null = null) => ({
  status,
  checked_in,
  waitlisted_at: waitlisted && `2026-10-01T19:${waitlisted}:00Z`,
})

describe('releasing reserved spots', () => {
  const start = '2026-10-01T19:00:00Z'
  const at = (time: string) => new Date(`2026-10-01T${time}:00Z`).getTime()

  it('happens 20 minutes after the start, or earlier by hand', () => {
    expect(isReleased({ starts_at: start, reserved_released_at: null }, at('19:19'))).toBe(false)
    expect(isReleased({ starts_at: start, reserved_released_at: null }, at('19:20'))).toBe(true)
    expect(isReleased({ starts_at: start, reserved_released_at: '2026-10-01T19:05:00Z' }, at('19:06'))).toBe(true)
  })

  it('only happens by hand without a start time', () => {
    expect(isReleased({ starts_at: null, reserved_released_at: null }, at('23:59'))).toBe(false)
  })
})

describe('door actions', () => {
  it('lets everyone in without a capacity', () => {
    const people = [person('not_contacted'), person('confirmed', true)]
    const counts = doorCounts(people, null, false)
    expect(people.map((p) => doorAction(p, counts, false))).toEqual(['check-in', 'checked-in'])
  })

  it('reserves spots for confirmed people, then waitlists walk-ins without a cap', () => {
    // Capacity 4: two confirmed (one here), one unconfirmed here, so 4 - 2 - 1 = 1 spot free.
    const people = [person('confirmed', true), person('confirmed'), person('awaiting_response', true), person('no_response')]
    let counts = doorCounts(people, 4, false)
    expect(counts).toMatchObject({ checkedIn: 2, reserved: 1, free: 1 })
    expect(doorAction(people[3], counts, false)).toBe('check-in')

    // The free spot is taken: walk-ins go on the waitlist, but the confirmed person can still come in.
    people[3].checked_in = true
    counts = doorCounts(people, 4, false)
    expect(counts.free).toBe(0)
    expect(doorAction(person('not_contacted'), counts, false)).toBe('waitlist')
    expect(doorAction(people[1], counts, false)).toBe('check-in')

    // Two already waiting; a third can still join.
    counts = doorCounts([...people, person('not_contacted', false, '01'), person('not_contacted', false, '02')], 4, false)
    expect(counts).toMatchObject({ waitlisted: 2, forWaitlist: 0 })
    expect(doorAction(person('not_contacted'), counts, false)).toBe('waitlist')
  })

  it('lets the waitlist in, in order, once reserved spots are released', () => {
    // Capacity 3: one here, two confirmed not here, two waiting.
    const people = [
      person('not_contacted', true), person('confirmed'), person('confirmed'),
      person('no_response', false, '02'), person('not_contacted', false, '01'),
    ]
    let counts = doorCounts(people, 3, false)
    let line = waitlistOf(people, false)
    expect(line).toEqual([people[4], people[3]])
    expect(line.map((p, i) => doorAction(p, counts, false, i))).toEqual(['waitlisted', 'waitlisted'])
    expect(line.map((_, i) => waitlistChance(i, counts))).toEqual([
      'In if 1 confirmed person doesn’t come',
      'In if 2 confirmed people don’t come',
    ])

    counts = doorCounts(people, 3, true)
    line = waitlistOf(people, true)
    expect(counts).toMatchObject({ reserved: 0, forWaitlist: 2, free: 0 })
    expect(line.map((p, i) => doorAction(p, counts, true, i))).toEqual(['check-in', 'check-in'])
  })

  it('treats a late confirmed person like a walk-in after the release', () => {
    // Capacity 2: one here, one waiting, so the last spot goes to the waitlist.
    const people = [person('not_contacted', true), person('confirmed'), person('no_response', false, '01')]
    const counts = doorCounts(people, 2, true)
    expect(doorAction(people[1], counts, true)).toBe('waitlist')
    expect(waitlistChance(1, counts)).toBe('Unlikely to get in')
  })

  it('keeps a confirmed person off the waitlist until the release', () => {
    const waiting = person('confirmed', false, '01')
    expect(waitlistOf([waiting], false)).toEqual([])
    expect(waitlistOf([waiting], true)).toEqual([waiting])
  })

  it('counts the waitlist as owed spots, so walk-ins can’t jump it', () => {
    // Capacity 2, one checked in, one waiting: the spot left is the waiting person's.
    const people = [person('not_contacted', true), person('not_contacted', false, '01')]
    const counts = doorCounts(people, 2, false)
    expect(counts).toMatchObject({ free: 0, forWaitlist: 1 })
    expect(doorAction(person('not_contacted'), counts, false)).toBe('waitlist')
  })

  it('has no room once everyone’s spot is filled', () => {
    const people = [person('not_contacted', true), person('confirmed')]
    const counts = doorCounts(people, 1, false)
    expect(doorAction(person('not_contacted'), counts, false)).toBe('no-room')
    expect(doorAction(people[1], counts, false)).toBe('no-room')
  })
})
