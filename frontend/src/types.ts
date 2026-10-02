import type { ContactStatus, FieldMap, Gender, Level, SignupRow } from './sheetParser'

export type { ContactStatus, FieldMap, Gender, Level, SignupRow }

/** Tables are grouped by student level only; "Other" sits at either. */
export type TableLevel = Exclude<Level, 'other'>

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
  /** Blank until someone renames it; see sheetName. */
  name: string
  spreadsheet_id: string
  spreadsheet_title: string
  tab_id: number
  tab_title: string
  field_map: FieldMap
  /** Formatting problems noticed at the last import or re-sync. */
  warnings: string[]
  capacity: number | null
  /** When the event starts; confirmed people's spots are reserved until a little after. See capacity.ts. */
  starts_at: string | null
  /** When the door volunteer released the reserved spots early. */
  reserved_released_at: string | null
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
  warnings: string[]
}

/** The start time, capacity and absent mentors are asked for at import. */
export type NewSheet = SheetRows & {
  spreadsheet_id: string
  tab_id: number
  starts_at: string
  capacity: number
  absent_mentor_ids: number[]
}

export type ResyncResult = { sheet: Sheet; added: number; updated: number; removed: number }

export const CONTACT_STATUSES: { value: ContactStatus; label: string }[] = [
  { value: 'not_contacted', label: 'Not contacted' },
  { value: 'waiting_to_contact', label: 'Waiting to contact' },
  { value: 'awaiting_response', label: 'Awaiting response' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'no_response', label: 'No response' },
  { value: 'not_coming', label: 'Not coming' },
  { value: 'no_room', label: 'No room' },
  { value: 'no_space', label: 'No space' },
  { value: 'not_inviting', label: 'Not inviting' },
]

export type TableMember = { kind: 'student' | 'mentor'; id: number; locked: boolean }

export type SeatingTable = {
  id: string
  name: string
  /** A coed table takes both, and always has a level. */
  gender: Gender | 'coed' | ''
  level: TableLevel | ''
  members: TableMember[]
}

export type PlanStudent = {
  id: number
  /** Matches SignupRow.key, to find their row in the sheet. */
  key: string
  name: string
  nickname: string
  gender: Gender | ''
  level: Level | ''
  status: ContactStatus
  checked_in: boolean
  /** When they were put on the door's waitlist; kept after check-in. See capacity.ts. */
  waitlisted_at: string | null
  chance: number
}

export type PlanMentor = { id: number; name: string; gender: Gender }

export type SeatingPlan = {
  tables: SeatingTable[]
  excluded_mentor_ids: number[]
  students: PlanStudent[]
  mentors: PlanMentor[]
  /** `tables_wanted` is how many tables that turnout calls for, before the limit of one per mentor. */
  expected: { gender: Gender; level: TableLevel; count: number; tables_wanted: number }[]
  show_up_rates: Partial<Record<ContactStatus, number>>
  updated_at: string
}

/** A pretend check-in on the planned tables: who got in and where they'd sit. Never saved. */
export type Simulation = Pick<SeatingPlan, 'tables' | 'students'> & {
  /** Arrived after the sheet's capacity was reached. */
  turned_away: number
  /** The last-minute pass that relieves tables past 3 students per mentor: coed tables (counting
   * new ones), tables opened by mentors who had none, and couples brought together. */
  rearranged: {
    coed_tables: number
    tables_added: number
    students_moved: number
    mentors_seated: number
    mentors_moved: number
  }
}

/** How the planned tables hold up over many pretend check-ins, in penalty points a day: lower is better. */
export type PlanScore = {
  days: number
  /** The fewest and the most who came on those days. */
  turnout: [number, number]
  average: number
  /** The average over the worst tenth of the days. */
  worst: number
  /** The average points a day from each way a seat goes wrong. */
  causes: Record<'no_table' | 'past_max' | 'alone' | 'lone_gender' | 'past_ideal' | 'other_level' | 'empty_table' | 'lone_mentor', number>
}

export type SeatedTable ={ id: string; name: string; mentors: string[] }

export type CheckInResult = { student: PlanStudent; table: SeatedTable | null }

/** What the tables are planned from in the sign-ups: who signed up, their group, and how likely each is to come. */
export const signupsKey = (plan: SeatingPlan) => plan.students.map((s) => `${s.id}${s.gender}${s.level}${s.chance}`).join()

/** What a sheet is called in the app: its given name, else its tab's title. */
export const sheetName = (sheet: Sheet) => sheet.name || sheet.tab_title
