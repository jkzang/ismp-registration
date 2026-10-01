/** A datetime-local input's value, in the browser's time zone. */
export function toLocalInput(iso: string | Date | null) {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The time rounded up to the hour: 2:20 becomes 3:00, and 3:00 stays. */
export function nextHour(now = new Date()) {
  const d = new Date(now)
  d.setMinutes(0, 0, 0)
  if (d.getTime() < now.getTime()) d.setHours(d.getHours() + 1)
  return d
}
