import { useRef, useState, type KeyboardEvent } from 'react'

const LANGUAGES: Array<[label: string, value: string]> = [
  ['Plain text', ''],
  ['TypeScript', 'ts'],
  ['JavaScript', 'js'],
  ['Python', 'python'],
  ['Shell', 'sh'],
  ['JSON', 'json'],
  ['SQL', 'sql'],
  ['HTML', 'html'],
  ['CSS', 'css'],
  ['Markdown', 'markdown'],
]

export function CodeLanguage({
  onPick,
  inBlock,
}: {
  onPick: (language: string) => void
  inBlock: boolean
}) {
  const [other, setOther] = useState('')
  return (
    <div className="kn-tb-code">
      <div role="group" aria-label="Code block language" className="kn-tb-choices">
        {LANGUAGES.map(([label, value]) => (
          <button
            key={label}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <form
        className="kn-tb-inline"
        onSubmit={(event) => {
          event.preventDefault()
          const language = other.trim().replace(/[^A-Za-z0-9_+#.-]/g, '')
          onPick(language)
        }}
      >
        <label>
          Other language
          <input value={other} maxLength={30} onChange={(event) => setOther(event.target.value)} />
        </label>
        <button type="submit">Insert</button>
      </form>
      {inBlock && (
        <p className="kn-muted">
          The cursor is in a code block. Choosing a language removes the block.
        </p>
      )}
    </div>
  )
}

export function TablePicker({ onPick }: { onPick: (columns: number, rows: number) => void }) {
  const [hover, setHover] = useState({ columns: 0, rows: 0 })
  const grid = useRef<HTMLDivElement>(null)
  const move = (event: KeyboardEvent<HTMLButtonElement>, columns: number, rows: number) => {
    const delta: Record<string, [number, number]> = {
      ArrowRight: [1, 0],
      ArrowLeft: [-1, 0],
      ArrowDown: [0, 1],
      ArrowUp: [0, -1],
    }
    const step = delta[event.key]
    if (!step) return
    event.preventDefault()
    const nextColumns = Math.min(8, Math.max(1, columns + step[0]))
    const nextRows = Math.min(8, Math.max(1, rows + step[1]))
    grid.current
      ?.querySelector<HTMLButtonElement>(`[data-cell="${nextColumns}x${nextRows}"]`)
      ?.focus()
  }
  return (
    <div className="kn-tb-table-picker">
      <div
        ref={grid}
        role="group"
        aria-label="Table size"
        className="kn-tb-grid"
        onMouseLeave={() => setHover({ columns: 0, rows: 0 })}
      >
        {Array.from({ length: 8 }, (_, row) =>
          Array.from({ length: 8 }, (_, column) => {
            const columns = column + 1
            const rows = row + 1
            return (
              <button
                key={`${columns}x${rows}`}
                type="button"
                data-cell={`${columns}x${rows}`}
                className={columns <= hover.columns && rows <= hover.rows ? 'is-on' : undefined}
                aria-label={`${columns} columns by ${rows} rows`}
                tabIndex={columns === 1 && rows === 1 ? 0 : -1}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHover({ columns, rows })}
                onFocus={() => setHover({ columns, rows })}
                onKeyDown={(event) => move(event, columns, rows)}
                onClick={() => onPick(columns, rows)}
              />
            )
          }),
        )}
      </div>
      <p className="kn-tb-grid-label" aria-live="polite">
        {hover.columns > 0
          ? `${hover.columns} × ${hover.rows}`
          : 'Choose a size (the first row is the header)'}
      </p>
    </div>
  )
}
