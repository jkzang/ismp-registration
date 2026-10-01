import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../api'
import { useApp } from '../appContext'
import { getAccessToken, getSpreadsheet, getTabValues, pickSpreadsheet, readDatabaseTab, writeCells, type PickedFile, type Tab } from '../google'
import { importWarnings } from '../sheetParser'
import { describeFills, parseWithDatabase } from '../studentDatabase'
import { useUndo } from '../undo'
import type { Sheet } from '../types'
import { CloseIcon, SheetIcon } from './icons'

type Step =
  | { kind: 'start' }
  | { kind: 'tabs'; file: PickedFile; title: string; tabs: Tab[] }

/** How the dialog opens: with the file just picked in Google's Picker, or with why picking failed. */
export type ImportStart = { file: PickedFile } | { error: string }

export function ImportDialog({ start, onClose, onImported }: {
  start: ImportStart
  onClose: () => void
  onImported: (sheet: Sheet) => void
}) {
  const { config } = useApp()
  const { notify } = useUndo()
  const dialogRef = useRef<HTMLDialogElement>(null)
  // A modal <dialog> sits in the browser's top layer, above Google's Picker, so it's hidden while picking.
  const pickingRef = useRef(false)
  const [step, setStep] = useState<Step>({ kind: 'start' })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>('error' in start ? start.error : null)

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

  // Reads the tab and imports it as is: the header row and columns are found automatically.
  async function importTab(file: PickedFile, title: string, tabs: Tab[], tab: Tab) {
    const [values, database] = await Promise.all([
      getTabValues(config, file.id, tab.title),
      readDatabaseTab(config, file.id, tabs, tab.id),
    ])
    const { parsed, fills } = parseWithDatabase(values, database)
    if (parsed.rows.length === 0) throw new Error(`No sign-ups found in “${tab.title}”.`)
    // The import doesn't depend on this; a sheet that can't be edited still imports the filled values.
    let writeError: string | null = null
    try {
      await writeCells(config, file.id, tab.title, fills)
    } catch (err) {
      writeError = errorMessage(err, 'Couldn’t write to the sheet.')
    }
    const sheet = await api.importSheet({
      spreadsheet_id: file.id,
      spreadsheet_title: title,
      tab_id: tab.id,
      tab_title: tab.title,
      field_map: parsed.fieldMap,
      rows: parsed.rows,
      warnings: importWarnings(parsed),
    })
    if (fills.length) {
      notify(
        writeError
          ? `Imported, but the ${fills.length} values from the Student Database weren’t written to the sheet: ${writeError}`
          : `Filled ${fills.length} blank cells in the sheet from the Student Database (${describeFills(fills)})`,
      )
    }
    onImported(sheet)
  }

  // A spreadsheet with a single tab is imported right away.
  async function openFile(file: PickedFile) {
    const { title, tabs } = await getSpreadsheet(config, file.id)
    if (tabs.length === 1) {
      setStep({ kind: 'start' })
      await importTab(file, title, tabs, tabs[0])
    } else setStep({ kind: 'tabs', file, title, tabs })
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

  const chooseTab = (tab: Tab) =>
    run('Importing…', async () => {
      if (step.kind === 'tabs') await importTab(step.file, step.title, step.tabs, tab)
    })

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
                  <button type="button" onClick={() => chooseTab(tab)} disabled={!!busy}>
                    <span>{tab.title}</span>
                    <span className="muted">{tab.rows} rows</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {busy && <p className="muted">{busy}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </dialog>
  )
}
