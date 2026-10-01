import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import { errorMessage } from './api'
import { CloseIcon } from './components/icons'

/** One change that Ctrl/Cmd+Z takes back and Ctrl/Cmd+Shift+Z (or Ctrl+Y) puts back.
 *  `label` finishes the sentences "Undid …" and "Redid …". */
export type UndoEntry = { label: string; undo: () => Promise<unknown>; redo: () => Promise<unknown> }

type UndoState = {
  push: (entry: UndoEntry) => void
  /** A short-lived banner across the top of the app. */
  notify: (message: string) => void
}

const UndoContext = createContext<UndoState | null>(null)
const LIMIT = 50
const NOTICE_MS = 5_000

export function useUndo() {
  const state = useContext(UndoContext)
  if (!state) throw new Error('useUndo needs UndoProvider')
  return state
}

// Text fields keep the browser's own undo for what's being typed.
function isTextField(el: EventTarget | null) {
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLElement && el.isContentEditable) return true
  return el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'range'].includes(el.type)
}

export function UndoProvider({ children }: { children: React.ReactNode }) {
  const undoStack = useRef<UndoEntry[]>([])
  const redoStack = useRef<UndoEntry[]>([])
  const running = useRef(false)
  const [notice, setNotice] = useState<{ message: string; key: number } | null>(null)
  const { pathname } = useLocation()

  // Undo applies to the page in front of you.
  useEffect(() => {
    undoStack.current = []
    redoStack.current = []
  }, [pathname])

  const notify = useCallback((message: string) => setNotice({ message, key: Date.now() }), [])

  const push = useCallback((entry: UndoEntry) => {
    undoStack.current.push(entry)
    if (undoStack.current.length > LIMIT) undoStack.current.shift()
    // A new change starts a new history; what was undone can't be redone on top of it.
    redoStack.current = []
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const key = e.key.toLowerCase()
      const isRedo = (key === 'z' && e.shiftKey) || (key === 'y' && e.ctrlKey && !e.shiftKey)
      const isUndo = key === 'z' && !e.shiftKey
      if (!isUndo && !isRedo) return
      if (isTextField(e.target) || document.querySelector('dialog[open]')) return
      e.preventDefault()
      if (running.current) return
      const [from, to] = isUndo ? [undoStack, redoStack] : [redoStack, undoStack]
      const verb = isUndo ? 'undo' : 'redo'
      const entry = from.current.pop()
      if (!entry) return notify(`Nothing to ${verb}`)
      running.current = true
      entry[verb]()
        .then(() => {
          to.current.push(entry)
          notify(`${isUndo ? 'Undid' : 'Redid'} ${entry.label}`)
        })
        .catch((err) => notify(errorMessage(err, `Couldn’t ${verb} ${entry.label}`)))
        .finally(() => (running.current = false))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [notify])

  return (
    <UndoContext.Provider value={{ push, notify }}>
      {children}
      {notice && (
        <p key={notice.key} className="toast-banner" role="status">
          {notice.message}
          <button type="button" className="chip-icon" aria-label="Dismiss" onClick={() => setNotice(null)}>
            <CloseIcon />
          </button>
        </p>
      )}
    </UndoContext.Provider>
  )
}
