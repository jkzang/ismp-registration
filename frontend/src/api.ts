import type {
  AppConfig,
  Chapter,
  CheckInResult,
  CurrentUser,
  Gender,
  Level,
  Mentor,
  NewSheet,
  PlanStudent,
  ResyncResult,
  SeatingPlan,
  SeatingTable,
  Sheet,
  SheetRows,
  Simulation,
} from './types'

function csrfToken() {
  const cookie = document.cookie.split('; ').find((c) => c.startsWith('csrftoken='))
  return cookie ? decodeURIComponent(cookie.split('=')[1]) : ''
}

// Flattens DRF error bodies like {"non_field_errors": ["..."]} into plain text.
function flattenErrors(body: unknown): string[] {
  if (typeof body === 'string') return [body]
  if (Array.isArray(body)) return body.flatMap(flattenErrors)
  if (body && typeof body === 'object') return Object.values(body).flatMap(flattenErrors)
  return []
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const method = options?.method ?? 'GET'
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (method !== 'GET') headers['X-CSRFToken'] = csrfToken()
  const res = await fetch(`/api${path}`, { ...options, headers })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const messages = flattenErrors(body)
    throw new ApiError(messages.length ? messages.join(' ') : res.statusText, res.status)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback
}

type UserResponse = { user: CurrentUser }

export const api = {
  config: () => request<AppConfig>('/config/'),
  me: () => request<{ user: CurrentUser | null }>('/auth/me/'),
  googleLogin: (credential: string) => post<UserResponse>('/auth/google/', { credential }),
  logout: () => post<void>('/auth/logout/'),

  searchChapters: (q: string) => request<Chapter[]>(`/chapters/?q=${encodeURIComponent(q)}`),
  createChapter: (name: string) => post<UserResponse>('/chapters/', { name }),
  joinChapter: (id: number) => post<UserResponse>(`/chapters/${id}/join/`),

  listMentors: () => request<Mentor[]>('/mentors/'),
  createMentor: (name: string, gender: Gender) => post<Mentor>('/mentors/', { name, gender }),
  updateMentor: (id: number, data: Partial<Omit<Mentor, 'id'>>) =>
    request<Mentor>(`/mentors/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteMentor: (id: number) => request<void>(`/mentors/${id}/`, { method: 'DELETE' }),

  listSheets: () => request<Sheet[]>('/sheets/'),
  getSheet: (id: number) => request<Sheet>(`/sheets/${id}/`),
  importSheet: (data: NewSheet) => post<Sheet>('/sheets/', data),
  resyncSheet: (id: number, data: SheetRows) =>
    request<ResyncResult>(`/sheets/${id}/rows/`, { method: 'PUT', body: JSON.stringify(data) }),
  updateSheet: (id: number, data: Partial<Pick<Sheet, 'name' | 'capacity' | 'starts_at' | 'reserved_released_at'>>) =>
    request<Sheet>(`/sheets/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSheet: (id: number) => request<void>(`/sheets/${id}/`, { method: 'DELETE' }),

  getPlan: (sheetId: number) => request<SeatingPlan>(`/sheets/${sheetId}/plan/`),
  savePlan: (sheetId: number, tables: SeatingTable[], excludedMentorIds: number[], updatedAt: string) =>
    request<SeatingPlan>(`/sheets/${sheetId}/plan/`, {
      method: 'PUT',
      body: JSON.stringify({ tables, excluded_mentor_ids: excludedMentorIds, updated_at: updatedAt }),
    }),
  generatePlan: (sheetId: number) => post<SeatingPlan>(`/sheets/${sheetId}/plan/generate/`),
  /** `attendance` is how many come; without it the turnout is random. */
  simulatePlan: (sheetId: number, attendance: number | null) =>
    post<Simulation>(`/sheets/${sheetId}/plan/simulate/`, { attendance }),

  checkIn: (signupId: number, door: { gender?: Gender; level?: Level } = {}) =>
    post<CheckInResult>(`/signups/${signupId}/check-in/`, door),
  undoCheckIn: (signupId: number) => post<{ student: PlanStudent }>(`/signups/${signupId}/undo-check-in/`),
  waitlist: (signupId: number) => post<{ student: PlanStudent }>(`/signups/${signupId}/waitlist/`),
  undoWaitlist: (signupId: number) => post<{ student: PlanStudent }>(`/signups/${signupId}/undo-waitlist/`),
}
