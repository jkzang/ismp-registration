import type { Mentor } from './types'

const normalize = (name: string) =>
  name.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ')

// Whether every character of `query` appears in `name`, in order.
function isSubsequence(query: string, name: string) {
  let i = 0
  for (const ch of name) if (ch === query[i]) i++
  return i === query.length
}

function editDistance(a: string, b: string) {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    row = next
  }
  return row[b.length]
}

// A typo or two is forgiven once there's enough typed to tell names apart.
function isNearPrefix(query: string, name: string) {
  const allowed = query.length >= 6 ? 2 : query.length >= 3 ? 1 : 0
  if (!allowed) return false
  return [name, ...name.split(' ')].some((part) =>
    [-1, 0, 1].some((d) => editDistance(query, part.slice(0, Math.max(query.length + d, 1))) <= allowed),
  )
}

// Lower is closer; null is no match.
function rank(query: string, name: string): number | null {
  if (name.startsWith(query)) return 0
  if (name.split(' ').some((word) => word.startsWith(query))) return 1
  if (name.includes(query)) return 2
  if (isNearPrefix(query, name)) return 3
  if (query.length >= 2 && isSubsequence(query.replace(/ /g, ''), name)) return 4
  return null
}

/** The mentors whose names fit what's been typed, closest first: the start of a name, then the
    start of any word in it, then anywhere in it, then a near miss (a typo, or letters left out). */
export function searchMentors(query: string, mentors: Mentor[]): Mentor[] {
  const typed = normalize(query)
  if (!typed) return []
  return mentors
    .flatMap((mentor) => {
      const score = rank(typed, normalize(mentor.name))
      return score === null ? [] : [{ mentor, score }]
    })
    .sort((a, b) => a.score - b.score || a.mentor.name.localeCompare(b.mentor.name))
    .map(({ mentor }) => mentor)
}
