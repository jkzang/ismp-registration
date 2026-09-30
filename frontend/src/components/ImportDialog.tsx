import { useEffect, useMemo, useRef, useState } from 'react'
import { api, errorMessage } from '../api'
import { useApp } from '../appContext'
import { getAccessToken, getSpreadsheet, getTabValues, pickSpreadsheet, type PickedFile, type Tab } from '../google'
import { FIELD_KEYS, FIELD_LABELS, parseSheet, SheetFormatError, type FieldKey, type FieldMap, type ParseResult } from '../sheetParser'
import { CONTACT_STATUSES, type Sheet } from '../types'
import { CloseIcon, SheetIcon } from './icons'

type Step =
  | { kind: 'start' }
  | { kind: 'tabs'; file: PickedFile; title: string; tabs: Tab[] }
  | { kind: 'preview'; file: PickedFile; title: string; tabs: Tab[]; tab: Tab; values: string[][] }

const LEVEL_LABEL = { undergrad: 'Undergrad', grad: 'Grad', '': '—' }
const GENDER_LABEL = { female: 'Female', male: 'Male', '': '—' }
const STATUS_LABEL = Object.fromEntries(CONTACT_STATUSES.map((s) => [s.value, s.label]))

function Preview({ values, fieldMap, setFieldMap, headerRow, setHeaderRow }: {
  values: string[][]
  fieldMap: FieldMap
  setFieldMap: (map: FieldMap) => void
  headerRow: number | undefined
  setHeaderRow: (row: number | undefined) => void
}) {
  const parsed = useMemo((): ParseResult | Error => {
    try {
      return parseSheet(values, { headerRow, fieldMap })
    } catch (err) {
      if (err instanceof SheetFormatError) return err
      throw err
    }
  }, [values, headerRow, fieldMap])
  const shownRow = parsed instanceof Error ? headerRow : parsed.headerRow
  const headers = (shownRow === undefined ? [] : values[shownRow] ?? []).map((h) => h.trim())

  return (
    <div className="import-preview">
      <label className="header-row-field">
        Header row
        <input
          type="number"
          min={1}
          max={values.length}
          value={shownRow === undefined ? '' : shownRow + 1}
          onChange={(e) => {
            setFieldMap({})
            setHeaderRow(e.target.value ? Math.max(0, Number(e.target.value) - 1) : undefined)
          }}
        />
        <span className="muted">{headerRow === undefined ? 'Found automatically' : 'Set by hand'}</span>
      </label>

      {parsed instanceof Error ? (
        <p className="error">{parsed.message}</p>
      ) : (
        <>
          <fieldset className="field-map">
            <legend>Columns to import</legend>
            {FIELD_KEYS.map((field: FieldKey) => (
              <label key={field}>
                <span>{FIELD_LABELS[field]}</span>
                <select
                  value={parsed.fieldMap[field] ?? ''}
                  onChange={(e) => setFieldMap({ ...parsed.fieldMap, [field]: e.target.value })}
                >
                  <option value="">Not imported</option>
                  {headers.map((h, i) => h && <option key={i} value={h}>{h}</option>)}
                </select>
              </label>
            ))}
          </fieldset>

          <Summary parsed={parsed} />

          <div className="preview-table-wrap">
            <table className="preview-table">
              <caption className="muted">First {Math.min(5, parsed.rows.length)} of {parsed.rows.length} sign-ups, as they’ll be imported</caption>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Nickname</th>
                  <th>Gender</th>
                  <th>Level</th>
                  <th>Contact status</th>
                </tr>
              </thead>
              <tbody>
                {parsed.rows.slice(0, 5).map((r) => (
                  <tr key={r.key}>
                    <td>{r.name}</td>
                    <td>{r.nickname}</td>
                    <td>{GENDER_LABEL[r.gender]}</td>
                    <td>{LEVEL_LABEL[r.level]}</td>
                    <td>{STATUS_LABEL[r.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {parsed.ignored.length > 0 && (
            <details className="ignored-columns">
              <summary>
                {parsed.ignored.length} {parsed.ignored.length === 1 ? 'column stays' : 'columns stay'} in Google Sheets and
                won’t be imported
              </summary>
              <p className="muted">{parsed.ignored.join(' · ')}</p>
            </details>
          )}
        </>
      )}
    </div>
  )
}

function Summary({ parsed }: { parsed: ParseResult }) {
  const count = (pred: (r: ParseResult['rows'][number]) => boolean) => parsed.rows.filter(pred).length
  const notes: string[] = []
  const { unrecognized, missing } = parsed
  if (unrecognized.gender.length) notes.push(`Unrecognized gender values: ${unrecognized.gender.join(', ')}.`)
  if (unrecognized.level.length) notes.push(`Unrecognized enrollment values: ${unrecognized.level.join(', ')}.`)
  if (unrecognized.status.length) notes.push(`Unrecognized contact statuses (treated as Not contacted): ${unrecognized.status.join(', ')}.`)
  if (missing.gender) notes.push(`${missing.gender} without a gender: check-in will ask.`)
  else if (missing.level) notes.push(`${missing.level} without an enrollment level: check-in will ask.`)
  return (
    <div className="import-summary">
      <p>
        <strong>{parsed.rows.length} sign-ups</strong>
        <span className="muted">
          {' '}· {count((r) => r.gender === 'female')} female, {count((r) => r.gender === 'male')} male ·{' '}
          {count((r) => r.level === 'undergrad')} undergrad, {count((r) => r.level === 'grad')} grad ·{' '}
          {count((r) => r.status === 'confirmed')} confirmed
        </span>
      </p>
      {notes.map((n) => (
        <p key={n} className="dg-notice">{n}</p>
      ))}
    </div>
  )
}

export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (sheet: Sheet) => void }) {
  const { config } = useApp()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [step, setStep] = useState<Step>({ kind: 'start' })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldMap, setFieldMap] = useState<FieldMap>({})
  const [headerRow, setHeaderRow] = useState<number | undefined>(undefined)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(errorMessage(err, 'Something went wrong.'))
    } finally {
      setBusy(null)
    }
  }

  const chooseFile = () =>
    run('Opening Google Drive…', async () => {
      const token = await getAccessToken(config)
      const file = await pickSpreadsheet(config, token)
      if (!file) return
      const { title, tabs } = await getSpreadsheet(config, file.id)
      setStep({ kind: 'tabs', file, title, tabs })
    })

  const chooseTab = (tab: Tab) =>
    run('Reading the tab…', async () => {
      if (step.kind === 'start') return
      const values = await getTabValues(config, step.file.id, tab.title)
      setFieldMap({})
      setHeaderRow(undefined)
      setStep({ kind: 'preview', file: step.file, title: step.title, tabs: step.tabs, tab, values })
    })

  const doImport = () =>
    run('Importing…', async () => {
      if (step.kind !== 'preview') return
      const parsed = parseSheet(step.values, { headerRow, fieldMap })
      const sheet = await api.importSheet({
        spreadsheet_id: step.file.id,
        spreadsheet_title: step.title,
        tab_id: step.tab.id,
        tab_title: step.tab.title,
        field_map: parsed.fieldMap,
        rows: parsed.rows,
      })
      onImported(sheet)
    })

  let canImport = false
  if (step.kind === 'preview') {
    try {
      canImport = parseSheet(step.values, { headerRow, fieldMap }).rows.length > 0
    } catch {
      canImport = false
    }
  }

  return (
    <dialog ref={dialogRef} className="import-dialog" onClose={onClose} aria-labelledby="import-title">
      <header className="dialog-head">
        <h2 id="import-title">Add sign up sheet</h2>
        <button type="button" className="chip-icon" aria-label="Close" onClick={() => dialogRef.current?.close()}>
          <CloseIcon />
        </button>
      </header>

      {step.kind !== 'start' && (
        <p className="import-crumbs">
          <SheetIcon /> <strong>{step.title}</strong>
          {step.kind === 'preview' && <> / {step.tab.title}</>}{' '}
          <button type="button" className="link-button" onClick={chooseFile} disabled={!!busy}>
            Change spreadsheet
          </button>
        </p>
      )}

      <div className="dialog-body">
        {step.kind === 'start' && (
          <div className="import-start">
            <p>Choose the Google spreadsheet with the sign ups. You’ll pick the tab next.</p>
            <p className="muted">
              The app can only open spreadsheets you choose here. It imports names, nicknames, gender, enrollment and
              contact status. Phone numbers, emails and chat IDs stay in Google Sheets.
            </p>
            <button type="button" className="primary with-icon" onClick={chooseFile} disabled={!!busy}>
              <SheetIcon /> Choose from Google Drive
            </button>
          </div>
        )}

        {step.kind === 'tabs' && (
          <>
            <p>Which tab has the sign ups?</p>
            <ul className="tab-list">
              {step.tabs.map((tab) => (
                <li key={tab.id}>
                  <button type="button" onClick={() => chooseTab(tab)} disabled={!!busy}>
                    <span>{tab.title}</span>
                    <span className="muted">{tab.rows} rows</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {step.kind === 'preview' && (
          <Preview values={step.values} fieldMap={fieldMap} setFieldMap={setFieldMap} headerRow={headerRow} setHeaderRow={setHeaderRow} />
        )}

        {busy && <p className="muted">{busy}</p>}
        {error && <p className="error">{error}</p>}
      </div>

      {step.kind === 'preview' && (
        <footer className="dialog-foot">
          <button type="button" onClick={() => setStep({ kind: 'tabs', file: step.file, title: step.title, tabs: step.tabs })}>
            Back
          </button>
          <button type="button" className="primary" onClick={doImport} disabled={!!busy || !canImport}>
            Import
          </button>
        </footer>
      )}
    </dialog>
  )
}
