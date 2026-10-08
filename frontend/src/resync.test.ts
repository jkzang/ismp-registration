import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./google', () => ({ readDatabaseTab: vi.fn(async () => null), writeCells: vi.fn(async () => {}) }))
vi.mock('./api', () => {
  class ApiError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  }
  return {
    ApiError,
    api: { resyncSheet: vi.fn(async () => ({ sheet: {}, added: 0, updated: 0, removed: 0 })) },
    errorMessage: (_: unknown, fallback: string) => fallback,
  }
})

const { api, ApiError } = await import('./api')
const { resyncSheet } = await import('./resync')
const { parseSheet } = await import('./sheetParser')

const config = {} as never
let nextId = 1
const sheet = () => ({ id: nextId++, spreadsheet_id: 's', tab_id: 0, field_map: {} }) as never
const tab = (rows: string[][]) => ({
  spreadsheetTitle: 'Fall',
  tabTitle: 'Sign Ups',
  tabs: [],
  values: [['Timestamp', 'Name', 'Contact Status'], ...rows],
})
const keysOf = (rows: string[][]) => parseSheet(tab(rows).values).rows.map((r) => r.key)

describe('background re-sync', () => {
  beforeEach(() => vi.mocked(api.resyncSheet).mockClear())

  it('sends only when the rows changed since the last send', async () => {
    const s = sheet()
    const rows = [['1', 'Amy', 'Confirmed']]
    expect(await resyncSheet(config, s, tab(rows), { auto: true })).not.toBeNull()
    expect(await resyncSheet(config, s, tab(rows), { auto: true })).toBeNull()
    // A new row, then a status changed in the sheet.
    expect(await resyncSheet(config, s, tab([...rows, ['2', 'Ben', '']]), { auto: true })).not.toBeNull()
    expect(await resyncSheet(config, s, tab([['1', 'Amy', 'Not coming'], ['2', 'Ben', '']]), { auto: true })).not.toBeNull()
    expect(api.resyncSheet).toHaveBeenCalledTimes(3)
    // Re-sync from the button always sends.
    expect(await resyncSheet(config, s, tab([['1', 'Amy', 'Not coming'], ['2', 'Ben', '']]))).not.toBeNull()
  })

  it('won’t drop most of the sign-ups by itself', async () => {
    const rows = [['1', 'Amy'], ['2', 'Ben'], ['3', 'Cat']]
    const knownKeys = keysOf(rows)
    expect(await resyncSheet(config, sheet(), tab([['1', 'Amy']]), { auto: true, knownKeys })).toBeNull()
    expect(await resyncSheet(config, sheet(), tab(rows.slice(0, 2)), { auto: true, knownKeys })).not.toBeNull()
    expect(await resyncSheet(config, sheet(), tab([['1', 'Amy']]), { knownKeys })).not.toBeNull()
  })

  it('gives way to a newer read another device already sent, and tries again next time', async () => {
    const s = sheet()
    const data = { ...tab([['1', 'Amy', 'Confirmed']]), readAt: '2026-10-08T12:00:00Z' }
    vi.mocked(api.resyncSheet).mockRejectedValueOnce(new ApiError('newer read', 409))
    expect(await resyncSheet(config, s, data, { auto: true })).toBeNull()
    expect(vi.mocked(api.resyncSheet).mock.calls[0][1]).toMatchObject({ read_at: '2026-10-08T12:00:00Z' })
    // Not counted as sent, so the next read sends it again.
    expect(await resyncSheet(config, s, data, { auto: true })).not.toBeNull()
  })
})
