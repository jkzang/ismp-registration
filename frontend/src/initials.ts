/** Drops anything in parentheses: Google names like "Jack Zhang (San Diego)" carry a note. */
function withoutParentheses(name: string) {
  let out = name
  let previous
  // Repeats so nested parentheses go too.
  do {
    previous = out
    out = out.replace(/[(（][^()（）]*[)）]/g, ' ')
  } while (out !== previous)
  return out
}

/** First and last initials for the profile icon. */
export function initials(name: string) {
  const parts = withoutParentheses(name).trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}
