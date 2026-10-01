import type { Mentor } from './types'

const normalize = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ')

/** Matches typed names (separated by commas or new lines) to the chapter's mentors. A full name
    always matches; a first name or the start of a name matches when only one mentor fits. */
export function matchAbsentMentors(text: string, mentors: Mentor[]) {
  const ids = new Set<number>()
  const unknown: string[] = []
  const ambiguous: string[] = []
  for (const typed of text.split(/[,;\n]/).map((t) => t.trim()).filter(Boolean)) {
    const name = normalize(typed)
    const exact = mentors.filter((m) => normalize(m.name) === name)
    const found = exact.length ? exact : mentors.filter((m) => normalize(m.name).startsWith(`${name} `))
    const close = found.length ? found : mentors.filter((m) => normalize(m.name).startsWith(name))
    if (close.length === 1) ids.add(close[0].id)
    else if (close.length === 0) unknown.push(typed)
    else ambiguous.push(typed)
  }
  return { ids: [...ids], unknown, ambiguous }
}
