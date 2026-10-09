import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { LogEntrySchema, type LogEntry } from '@score/contract'
import { redact } from '../redact.ts'

const TAIL_BYTES = 4 * 1024 * 1024
export const MAX_LOG_LINES = 2000

type Level = LogEntry['level']
const rank: Record<Level, number> = { info: 0, warn: 1, error: 2 }

/** The last `TAIL_BYTES` of a file as lines (a cut first line is dropped); missing file = no lines. */
function tailLines(path: string): string[] {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return []
  }
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - TAIL_BYTES)
    const buffer = Buffer.alloc(size - start)
    readSync(fd, buffer, 0, buffer.length, start)
    const lines = buffer.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    return lines.filter((line) => line.trim() !== '')
  } finally {
    closeSync(fd)
  }
}

function levelOf(value: unknown): Level {
  const n = typeof value === 'number' ? value : 30
  return n >= 50 ? 'error' : n >= 40 ? 'warn' : 'info'
}
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** One log line as an entry. Pino JSON is unpacked; anything else (launcher output) is shown as it is. Every text
 * field is redacted here, so no caller can forget it. */
export function parseLogLine(line: string): LogEntry {
  let data: unknown
  try {
    data = JSON.parse(line)
  } catch {
    data = undefined
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {
      time: null,
      level: /\b(?:error|fatal)\b/i.test(line) ? 'error' : /\bwarn(?:ing)?\b/i.test(line) ? 'warn' : 'info',
      message: redact(line.slice(0, 2000)),
      method: null,
      url: null,
      status: null,
      durationMs: null,
    }
  }
  const record = data as Record<string, unknown>
  const req = (record.req ?? {}) as Record<string, unknown>
  const res = (record.res ?? {}) as Record<string, unknown>
  const err = (record.err ?? {}) as Record<string, unknown>
  const time = typeof record.time === 'number' ? new Date(record.time) : null
  const base = text(record.msg) ?? text(err.message) ?? ''
  const extra = text(err.message) && text(record.msg) ? ` (${text(err.message)})` : ''
  const method = text(req.method)
  const url = text(req.url)
  return {
    time: time && !Number.isNaN(time.getTime()) ? time.toISOString() : null,
    level: levelOf(record.level),
    message: redact(`${base}${extra}`.slice(0, 2000)),
    method: method ? redact(method) : null,
    url: url ? redact(url.slice(0, 2000)) : null,
    status: num(res.statusCode),
    durationMs: num(record.responseTime),
  }
}

export interface LogQuery {
  level?: Level
  q?: string
  limit: number
}

/** Newest first; the rotated generation (`<file>.1`) is read after the live file. Filters apply to the redacted text. */
export function readLogs(file: string, query: LogQuery): LogEntry[] {
  const limit = Math.min(Math.max(1, query.limit), MAX_LOG_LINES)
  const needle = query.q?.trim().toLowerCase()
  const out: LogEntry[] = []
  for (const path of [file, `${file}.1`]) {
    const lines = tailLines(path)
    for (let index = lines.length - 1; index >= 0 && out.length < limit; index--) {
      const entry = LogEntrySchema.parse(parseLogLine(lines[index]!))
      if (query.level && rank[entry.level] < rank[query.level]) continue
      if (
        needle &&
        ![entry.message, entry.url ?? '', entry.method ?? ''].some((part) =>
          part.toLowerCase().includes(needle),
        )
      )
        continue
      out.push(entry)
    }
    if (out.length >= limit) break
  }
  return out
}
