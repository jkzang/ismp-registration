import { useEffect, useRef, useState } from 'react'
import { searchMentors } from '../absentMentors'
import { api, errorMessage } from '../api'
import { useApp } from '../appContext'
import { checkInLayout, isCheckInTab } from '../checkInTab'
import { getAccessToken, getSpreadsheet, getTabValues, pickSpreadsheet, readDatabaseTab, writeCells, writeCheckInTab, type PickedFile, type Tab } from '../google'
import { nextHour, toLocalInput } from '../localTime'
import { importWarnings } from '../sheetParser'
import { describeFills, parseWithDatabase } from '../studentDatabase'
import { useUndo } from '../undo'
import type { Mentor, SeatingPlan, Sheet } from '../types'
import { CheckIcon, CloseIcon, SheetIcon } from './icons'
import { Segmented } from './Segmented'

type Step =
  | { kind: 'start' }
  | { kind: 'tabs'; file: PickedFile; title: string; tabs: Tab[] }
  | { kind: 'details'; file: PickedFile; title: string; tabs: Tab[]; tab: Tab }

// How many matching mentors are offered at once.
const MAX_SUGGESTIONS = 6

/** How the dialog opens: with the file just picked in Google's Picker, or with why picking failed. */
export type ImportStart = { file: PickedFile } | { error: string }

export function ImportDialog({ start, onClose, onImported }: {
  start: ImportStart
  onClose: () => void
  /** With the plan already loaded, so the sheet's page can open without a loading screen. */
  onImported: (sheet: Sheet, plan: SeatingPlan | null) => void
}) {
  const { config } = useApp()
  const { notify } = useUndo()
  const dialogRef = useRef<HTMLDialogElement>(null)
  // A modal <dialog> sits in the browser's top layer, above Google's Picker, so it's hidden while picking.
  const pickingRef = useRef(false)
  const [step, setStep] = useState<Step>({ kind: 'start' })
  const [busy, setBusy] = useState<string | null>(null)
  // The import's stages so far: the last is under way, the ones before it are done.
  const [stages, setStages] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>('error' in start ? start.error : null)
  // Kept across a change of tab or spreadsheet, so they're only typed once.
  // Most sheets are imported on the day, shortly before the event: today, at the next full hour.
  const [startsAt, setStartsAt] = useState(() => toLocalInput(nextHour()))
  const [capacity, setCapacity] = useState('')
  const [mentorsAbsent, setMentorsAbsent] = useState<'no' | 'yes'>('no')
  const [absentIds, setAbsentIds] = useState<number[]>([])
  const [mentors, setMentors] = useState<Mentor[] | null>(null)
  const [mentorsError, setMentorsError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  // The chapter's mentors, to search through when some will be absent.
  useEffect(() => {
    if (mentorsAbsent !== 'yes' || mentors) return
    let cancelled = false
    setMentorsError(null)
    api.listMentors().then(
      (list) => !cancelled && setMentors(list),
      (err) => !cancelled && setMentorsError(errorMessage(err, 'Couldn’t load the mentors.')),
    )
    return () => {
      cancelled = true
    }
  }, [mentorsAbsent, mentors])

  const absent = absentIds.flatMap((id) => mentors?.find((m) => m.id === id) ?? [])
  const suggestions = searchMentors(query, (mentors ?? []).filter((m) => !absentIds.includes(m.id))).slice(0, MAX_SUGGESTIONS)

  function addAbsent(mentor: Mentor) {
    setAbsentIds((ids) => [...ids, mentor.id])
    setQuery('')
    setActive(0)
    setError(null)
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!suggestions.length) return
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + step + suggestions.length) % suggestions.length)
    } else if (e.key === 'Enter' && query.trim()) {
      // Enter picks the highlighted mentor; it only submits the form once the search box is empty.
      e.preventDefault()
      if (suggestions[active]) addAbsent(suggestions[active])
    } else if (e.key === 'Escape' && query) {
      e.preventDefault()
      setQuery('')
    } else if (e.key === 'Backspace' && !query && absentIds.length) {
      setAbsentIds((ids) => ids.slice(0, -1))
    }
  }

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(errorMessage(err, 'Something went wrong.'))
    } finally {
      setBusy(null)
      setStages(null)
    }
  }

  // Reads the tab and imports it as is: the header row and columns are found automatically.
  async function importTab(file: PickedFile, title: string, tabs: Tab[], tab: Tab, event: { starts_at: string; capacity: number; absent_mentor_ids: number[] }) {
    setStages([`Reading “${tab.title}” from Google Sheets`])
    const [values, database] = await Promise.all([
      getTabValues(config, file.id, tab.title),
      readDatabaseTab(config, file.id, tabs, tab.id),
    ])
    const { parsed, fills } = parseWithDatabase(values, database)
    if (parsed.rows.length === 0) throw new Error(`No sign-ups found in “${tab.title}”.`)
    // The import doesn't depend on this; a sheet that can't be edited still imports the filled values.
    let writeError: string | null = null
    if (fills.length) setStages((done) => [...(done ?? []), `Filling ${fills.length} blank ${fills.length === 1 ? 'cell' : 'cells'} from the Student Database`])
    try {
      await writeCells(config, file.id, tab.title, fills)
    } catch (err) {
      writeError = errorMessage(err, 'Couldn’t write to the sheet.')
    }
    // One request: the server saves the sign-ups and plans the first tables together.
    const people = `${parsed.rows.length} ${parsed.rows.length === 1 ? 'sign-up' : 'sign-ups'}`
    setStages((done) => [...(done ?? []), `Saving ${people} and planning the tables`])
    const sheet = await api.importSheet({
      spreadsheet_id: file.id,
      spreadsheet_title: title,
      tab_id: tab.id,
      tab_title: tab.title,
      field_map: parsed.fieldMap,
      rows: parsed.rows,
      warnings: importWarnings(parsed),
      ...event,
    })
    // Loaded while the dialog is still up; the page loads it itself if this fails.
    const plan = await api.getPlan(sheet.id).catch(() => null)
    // The "- Check In" tab beside the sign-ups. The sheet's page keeps it up to date, and adds it
    // if this fails.
    let tabError: string | null = null
    if (plan) {
      setStages((done) => [...(done ?? []), `Adding the “${tab.title} - Check In” tab`])
      try {
        await writeCheckInTab(config, sheet, (title) => checkInLayout(plan, title))
      } catch (err) {
        tabError = errorMessage(err, 'Couldn’t add the check-in tab.')
      }
    }
    const imported = `Imported ${people} and planned the tables`
    notify(
      (!fills.length
        ? imported
        : writeError
          ? `${imported}, but the ${fills.length} values from the Student Database weren’t written to the sheet: ${writeError}`
          : `${imported} · filled ${fills.length} blank cells in the sheet from the Student Database (${describeFills(fills)})`) +
        (tabError ? ` · the check-in tab wasn’t added: ${tabError}` : ''),
    )
    onImported(sheet, plan)
  }

  // A spreadsheet with a single tab skips the choice of tab.
  async function openFile(file: PickedFile) {
    const { title, tabs: all } = await getSpreadsheet(config, file.id)
    // The app's own "- Check In" tabs aren't sign-ups.
    const tabs = all.filter((t) => !isCheckInTab(t.title))
    if (tabs.length === 1) setStep({ kind: 'details', file, title, tabs, tab: tabs[0] })
    else setStep({ kind: 'tabs', file, title, tabs })
  }

  useEffect(() => {
    if ('file' in start) run('Reading the spreadsheet…', () => openFile(start.file))
    // Runs once, for the file picked before the dialog opened.
  }, [])

  const chooseFile = () =>
    run('Opening Google Drive…', async () => {
      const token = await getAccessToken(config)
      const dialog = dialogRef.current!
      pickingRef.current = true
      dialog.close()
      let file: PickedFile | null
      try {
        file = await pickSpreadsheet(config, token)
      } finally {
        dialog.showModal()
      }
      if (file) await openFile(file)
    })

  function chooseTab(tab: Tab) {
    setError(null)
    if (step.kind === 'tabs') setStep({ ...step, kind: 'details', tab })
  }

  function submitDetails(e: React.FormEvent) {
    e.preventDefault()
    if (step.kind !== 'details') return
    const people = Number(capacity)
    const starts = new Date(startsAt)
    // The inputs are `required` too; this catches what the browser's own check lets through.
    if (!startsAt || Number.isNaN(starts.getTime())) return setError('Enter the date and time of the event.')
    if (!Number.isInteger(people) || people < 1) return setError('Enter the event’s capacity as a whole number, 1 or more.')
    if (mentorsAbsent === 'yes' && !absentIds.length) return setError('Choose the mentors who’ll be absent, or choose No.')
    if (mentorsAbsent === 'yes' && query.trim()) return setError(`Choose a mentor for “${query.trim()}”, or clear the search.`)
    run('Importing…', () =>
      importTab(step.file, step.title, step.tabs, step.tab, {
        starts_at: starts.toISOString(),
        capacity: people,
        absent_mentor_ids: mentorsAbsent === 'yes' ? absentIds : [],
      }),
    )
  }

  return (
    <dialog ref={dialogRef} className="import-dialog" onClose={() => {
        if (pickingRef.current) pickingRef.current = false
        else onClose()
      }} aria-labelledby="import-title">
      <header className="dialog-head">
        <h2 id="import-title">Add sign up sheet</h2>
        <button type="button" className="chip-icon" aria-label="Close" onClick={() => dialogRef.current?.close()}>
          <CloseIcon />
        </button>
      </header>

      {step.kind !== 'start' && (
        <p className="import-crumbs">
          <SheetIcon /> <strong>{step.title}</strong>{' '}
          <button type="button" className="link-button" onClick={chooseFile} disabled={!!busy}>
            Change spreadsheet
          </button>
        </p>
      )}

      <div className="dialog-body">
        {step.kind === 'start' && !busy && (
          <div className="import-start">
            <button type="button" className="primary with-icon" onClick={chooseFile}>
              <SheetIcon /> Choose from Google Drive
            </button>
          </div>
        )}

        {step.kind === 'tabs' && (
          <>
            <ul className="tab-list">
              {step.tabs.map((tab) => (
                <li key={tab.id}>
                  <button type="button" onClick={() => chooseTab(tab)}>
                    <span>{tab.title}</span>
                    <span className="muted">{tab.rows} rows</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {step.kind === 'details' && !stages && (
          <form className="import-details" onSubmit={submitDetails}>
            <p className="import-details-tab">
              Importing <strong>{step.tab.title}</strong> <span className="muted">· {step.tab.rows} rows</span>
              {step.tabs.length > 1 && (
                <button type="button" className="link-button" onClick={() => setStep({ ...step, kind: 'tabs' })} disabled={!!busy}>
                  Change tab
                </button>
              )}
            </p>
            <label className="import-field">
              <span>When is the event?</span>
              <input
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                required
                autoFocus
                disabled={!!busy}
              />
            </label>
            <label className="import-field">
              <span>How many people can it hold?</span>
              <input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                placeholder="Capacity"
                required
                disabled={!!busy}
              />
            </label>
            <div className="import-field">
              <span>Will there be any mentors absent?</span>
              <Segmented
                label="Will there be any mentors absent?"
                value={mentorsAbsent}
                options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }]}
                onChange={setMentorsAbsent}
              />
            </div>
            {mentorsAbsent === 'yes' && (
              <div className="import-field">
                <label htmlFor="absent-search">Who will be absent?</label>
                {absent.length > 0 && (
                  <ul className="dg-chips is-row" aria-label="Mentors absent">
                    {absent.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          className="away-chip"
                          onClick={() => setAbsentIds((ids) => ids.filter((id) => id !== m.id))}
                          disabled={!!busy}
                          title={`Remove ${m.name}`}
                        >
                          {m.name}
                          <CloseIcon />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <input
                  id="absent-search"
                  type="text"
                  className="import-field-wide"
                  role="combobox"
                  aria-expanded={!!query.trim()}
                  aria-controls="absent-options"
                  aria-autocomplete="list"
                  aria-activedescendant={suggestions[active] ? `absent-option-${suggestions[active].id}` : undefined}
                  autoComplete="off"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setActive(0)
                  }}
                  onKeyDown={onSearchKeyDown}
                  placeholder={mentors ? 'Search mentors by name' : 'Loading mentors…'}
                  autoFocus
                  disabled={!!busy || !mentors}
                />
                {query.trim() && (
                  <ul id="absent-options" className="search-results import-mentor-results" role="listbox" aria-label="Matching mentors">
                    {suggestions.map((m, i) => (
                      <li key={m.id} role="presentation">
                        <button
                          type="button"
                          id={`absent-option-${m.id}`}
                          role="option"
                          aria-selected={i === active}
                          className={i === active ? 'is-active' : undefined}
                          tabIndex={-1}
                          // Keeps the focus in the search box, ready for the next name.
                          onMouseDown={(e) => e.preventDefault()}
                          onMouseEnter={() => setActive(i)}
                          onClick={() => addAbsent(m)}
                        >
                          {m.name}
                        </button>
                      </li>
                    ))}
                    {suggestions.length === 0 && <li className="muted">No mentor in this chapter matches “{query.trim()}”.</li>}
                  </ul>
                )}
                {mentorsError && <p className="error">{mentorsError}</p>}
              </div>
            )}
            <p className="muted">
              All of these can be changed after the import: the date and capacity at the top of the sheet’s page, and
              mentors on the Tables board.
            </p>
            <div className="import-details-actions">
              <button type="submit" className="primary" disabled={!!busy}>
                Import
              </button>
            </div>
          </form>
        )}

        {stages && (
          <ol className="import-progress" role="status">
            {stages.map((stage, i) => {
              const done = i < stages.length - 1
              return (
                <li key={stage} className={done ? 'is-done' : undefined}>
                  {done ? <CheckIcon /> : <span className="spinner" aria-hidden="true" />}
                  {stage}{!done && '…'}
                </li>
              )
            })}
            <li className="muted import-progress-note">Planning tries many seatings, so it can take a moment.</li>
          </ol>
        )}
        {busy && !stages && (
          <p className="muted loading-line" role="status">
            <span className="spinner" aria-hidden="true" /> {busy}
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </dialog>
  )
}
