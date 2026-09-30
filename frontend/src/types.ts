import type { ContactStatus, FieldMap, Gender, Level, SignupRow } from './sheetParser'

export type { ContactStatus, FieldMap, Gender, Level, SignupRow }

export type AppConfig = {
  google_client_id: string
  google_api_key: string
  google_app_id: string
  allowed_domain: string
  retention_days: number
}

export type Chapter = { id: number; name: string }

export type CurrentUser = { display_name: string; chapter: Chapter | null }

export type Mentor = { id: number; name: string; gender: Gender }

export type Sheet = {
  id: number
  spreadsheet_id: string
  spreadsheet_title: string
  tab_id: number
  tab_title: string
  field_map: FieldMap
  capacity: number | null
  imported_at: string
  synced_at: string
  expires_at: string
  imported_by: string | null
  signup_count: number
}

export type SheetRows = {
  spreadsheet_title: string
  tab_title: string
  field_map: FieldMap
  rows: SignupRow[]
}

export type NewSheet = SheetRows & { spreadsheet_id: string; tab_id: number }

export type ResyncResult = { sheet: Sheet; added: number; updated: number; removed: number }

export const CONTACT_STATUSES: { value: ContactStatus; label: string }[] = [
  { value: 'not_contacted', label: 'Not contacted' },
  { value: 'awaiting_response', label: 'Awaiting response' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'no_response', label: 'No response' },
  { value: 'not_inviting', label: 'Not inviting' },
]

export type TableMember = { kind: 'student' | 'mentor'; id: number; locked: boolean }

export type SeatingTable = {
  id: string
  name: string
  gender: Gender | ''
  level: Level | ''
  members: TableMember[]
}

export type PlanStudent = {
  id: number
  name: string
  nickname: string
  gender: Gender | ''
  level: Level | ''
  status: ContactStatus
  checked_in: boolean
  chance: number
}

export type PlanMentor = { id: number; name: string; gender: Gender }

export type SeatingPlan = {
  tables: SeatingTable[]
  excluded_mentor_ids: number[]
  students: PlanStudent[]
  mentors: PlanMentor[]
  expected: { gender: Gender; level: Level; count: number }[]
  show_up_rates: Partial<Record<ContactStatus, number>>
  updated_at: string
}

export type SeatedTable = { id: string; name: string; mentors: string[] }

export type CheckInResult = { student: PlanStudent; table: SeatedTable | null }
