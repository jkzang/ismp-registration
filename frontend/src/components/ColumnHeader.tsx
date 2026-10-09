import { useEffect, useRef, useState } from 'react'
import { COLUMNS, type ColumnId, type Sort, type SortDir } from '../signupFilters'

/**
 * A Sign-ups column's name, which opens its filter menu when it has one, and its sort toggle beside
 * it. The first click sorts by the column; the next ones flip the direction. `end` opens the menu
 * leftward, for the columns at the row's right.
 */
export function ColumnHeader({ id, className, sort, picked, counts, end, onSort, onPick }: {
  id: ColumnId
  className: string
  sort: Sort
  picked: string[]
  counts: Map<string, number>
  end?: boolean
  onSort: (dir: SortDir) => void
  onPick: (values: string[]) => void
}) {
  const column = COLUMNS[id]
  const label = column.short ?? column.label
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const sorted = sort.column === id ? sort.dir : null
  const next: SortDir = sorted ? (sorted === 'asc' ? 'desc' : 'asc') : (column.firstDir ?? 'asc')
  const toggle = (values: string[], on: boolean) =>
    onPick(on ? [...new Set([...picked, ...values])] : picked.filter((v) => !values.includes(v)))
  const groups = [...new Set(column.options.map((o) => o.group))]

  return (
    <div className={`column-header ${className}`} ref={ref}>
      {column.options.length > 0 ? (
        <button
          type="button"
          className={`column-button${picked.length ? ' is-filtered' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          title={`Filter by ${column.label}`}
        >
          <span className="column-label">{label}</span>
          {picked.length > 0 ? (
            <span className="column-count" aria-label={`${picked.length} ticked`}>{picked.length}</span>
          ) : (
            <span className="column-caret" aria-hidden="true">▾</span>
          )}
        </button>
      ) : (
        <span className="column-name">{label}</span>
      )}
      <button
        type="button"
        className={`column-sort${sorted ? ' is-on' : ''}`}
        onClick={() => onSort(next)}
        aria-label={`Sort by ${column.label}: ${column.sortLabels[next === 'asc' ? 0 : 1]}`}
        title={column.sortLabels[next === 'asc' ? 0 : 1]}
      >
        {sorted === 'asc' ? '↑' : sorted === 'desc' ? '↓' : '↕'}
      </button>
      {open && (
        <div className={`column-menu${end ? ' is-end' : ''}`} role="dialog" aria-label={`Filter by ${column.label}`}>
          {groups.map((group) => {
            const options = column.options.filter((o) => o.group === group)
            const values = options.map((o) => o.value)
            const all = values.every((v) => picked.includes(v))
            // A heading over one value would only repeat it.
            const heading = group && options.length > 1
            return (
              <div key={group ?? ''} className="column-group">
                {heading && (
                  <label className="column-option is-group">
                    <input
                      type="checkbox"
                      checked={all}
                      ref={(el) => {
                        if (el) el.indeterminate = !all && values.some((v) => picked.includes(v))
                      }}
                      onChange={(e) => toggle(values, e.target.checked)}
                    />
                    <span>{group}</span>
                    <span className="column-option-count">{values.reduce((n, v) => n + (counts.get(v) ?? 0), 0)}</span>
                  </label>
                )}
                {options.map((o) => (
                  <label key={o.value} className={`column-option${heading ? ' is-nested' : ''}`}>
                    <input type="checkbox" checked={picked.includes(o.value)} onChange={(e) => toggle([o.value], e.target.checked)} />
                    <span>{o.label}</span>
                    <span className="column-option-count">{counts.get(o.value) ?? 0}</span>
                  </label>
                ))}
              </div>
            )
          })}
          {picked.length > 0 && (
            <button type="button" className="link-button column-clear" onClick={() => onPick([])}>
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  )
}
