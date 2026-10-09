import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LogsResponseSchema, type LogEntry } from '@score/contract'
import { apiFetch } from '../../data/api.ts'

type LevelFilter = 'all' | LogEntry['level']

export function logLine(entry: LogEntry): string {
  const request =
    entry.method || entry.url
      ? ` ${entry.method ?? ''} ${entry.url ?? ''}${entry.status !== null ? ` -> ${entry.status}` : ''}${
          entry.durationMs !== null ? ` (${Math.round(entry.durationMs)} ms)` : ''
        }`
      : ''
  return `${entry.time ?? '-'} ${entry.level.toUpperCase()} ${entry.message}${request}`.trimEnd()
}

export function LogsSection() {
  const [level, setLevel] = useState<LevelFilter>('all')
  const [text, setText] = useState('')
  const [auto, setAuto] = useState(false)
  const [limit, setLimit] = useState(200)
  const logs = useQuery({
    queryKey: ['system', 'logs', level, text, limit],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ limit: String(limit) })
      if (level !== 'all') params.set('level', level)
      if (text.trim()) params.set('q', text.trim())
      return LogsResponseSchema.parse(await apiFetch(`system/logs?${params}`, { signal }))
    },
    retry: false,
    refetchInterval: auto ? 5000 : false,
  })
  const items = logs.data?.items ?? []
  function download() {
    const blob = new Blob([items.map(logLine).join('\n') + '\n'], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'score-log.txt'
    link.click()
    URL.revokeObjectURL(url)
  }
  return (
    <section id="logs" className="settings-card" aria-labelledby="settings-logs">
      <div>
        <h2 id="settings-logs">Logs</h2>
        <p className="settings-muted-strong">
          Score&apos;s own log, newest first. Secrets are removed on the server before anything is
          shown.
        </p>
      </div>
      <div className="logs-controls">
        <label>
          Level
          <select value={level} onChange={(event) => setLevel(event.target.value as LevelFilter)}>
            <option value="all">All</option>
            <option value="warn">Warnings and errors</option>
            <option value="error">Errors only</option>
          </select>
        </label>
        <label>
          Search
          <input type="search" value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <label>
          <input
            type="checkbox"
            checked={auto}
            onChange={(event) => setAuto(event.target.checked)}
          />{' '}
          Refresh every 5 seconds
        </label>
        <button type="button" className="settings-pill" onClick={() => void logs.refetch()}>
          Refresh
        </button>
        <button
          type="button"
          className="settings-pill"
          disabled={items.length === 0}
          onClick={download}
        >
          Download
        </button>
      </div>
      {logs.isError && <p role="alert">Could not load the log. Is this browser paired?</p>}
      {logs.data && !logs.data.available && (
        <p className="settings-muted">
          This Score was not started with a log file (<code>scripts/score start</code> sets one).
        </p>
      )}
      {logs.data?.available && items.length === 0 && (
        <p className="settings-muted">No matching log lines.</p>
      )}
      {items.length > 0 && (
        <div
          className="logs-scroll"
          role="region"
          aria-label="Log lines, scroll to see all columns"
          tabIndex={0}
        >
          <table className="logs-table" aria-label="Log lines table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Level</th>
                <th scope="col">Message</th>
                <th scope="col">Request</th>
              </tr>
            </thead>
            <tbody>
              {items.map((entry, index) => (
                <tr key={index} data-level={entry.level}>
                  <td>{entry.time ? new Date(entry.time).toLocaleString() : '—'}</td>
                  <td>{entry.level}</td>
                  <td>{entry.message}</td>
                  <td>
                    {entry.method || entry.url
                      ? `${entry.method ?? ''} ${entry.url ?? ''}${entry.status !== null ? ` ${entry.status}` : ''}${
                          entry.durationMs !== null ? ` ${Math.round(entry.durationMs)} ms` : ''
                        }`
                      : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {items.length >= limit && limit < 2000 && (
        <button
          type="button"
          className="settings-pill settings-start"
          onClick={() => setLimit((current) => Math.min(2000, current * 2))}
        >
          Show more
        </button>
      )}
    </section>
  )
}
