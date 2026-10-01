import { describe, expect, it } from 'vitest'
import { matchAbsentMentors } from './absentMentors'
import type { Mentor } from './types'

const mentors: Mentor[] = [
  { id: 1, name: 'Mia Chen', gender: 'female' },
  { id: 2, name: 'Leo Park', gender: 'male' },
  { id: 3, name: 'Leon Wu', gender: 'male' },
  { id: 4, name: 'Mia Tran', gender: 'female' },
]

describe('matchAbsentMentors', () => {
  it('matches full names, whatever the case or spacing', () => {
    expect(matchAbsentMentors('mia chen,  LEO   PARK', mentors)).toEqual({ ids: [1, 2], unknown: [], ambiguous: [] })
  })

  it('matches a first name or the start of a name when only one mentor fits', () => {
    expect(matchAbsentMentors('Leo\nLeon', mentors).ids).toEqual([2, 3])
    expect(matchAbsentMentors('Mia T', mentors).ids).toEqual([4])
  })

  it('reports names it can’t place', () => {
    expect(matchAbsentMentors('Mia, Zoe, Leo Park', mentors)).toEqual({ ids: [2], unknown: ['Zoe'], ambiguous: ['Mia'] })
  })

  it('ignores blanks and repeats', () => {
    expect(matchAbsentMentors(' , Leo Park,, leo park ', mentors).ids).toEqual([2])
    expect(matchAbsentMentors('', mentors)).toEqual({ ids: [], unknown: [], ambiguous: [] })
  })
})
