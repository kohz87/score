import { createHash } from 'node:crypto'
import type {
  ConfigApplyRequest,
  ConfigApplyResponse,
  ConfigChange,
  ConfigItem,
  ConfigPreviewResponse,
} from '@score/contract'
import { unifiedDiff } from '../domain/line-diff.ts'
import { HttpError } from '../errors.ts'
import { configRestartRequired, isExcludedConfigKey, scrubConfigValue } from './config-keys.ts'

export interface ConfigIndexEntry {
  key: string
  description?: string | undefined
  default?: unknown
}
/** The only two things the service needs from Hermes (or the fake): read a top-level section, set one key. */
export interface ConfigBackend {
  readonly file: string
  readSection(top: string): Promise<{ found: boolean; value?: unknown }>
  /** `value` is the CLI string form (see `serializeConfigValue`). Resolves false when Hermes refused it. */
  write(key: string, value: string): Promise<boolean>
}

const MAX_RESULTS = 50
const READ_CONCURRENCY = 4
const MAX_VALUE_CHARS = 4000
const MAX_RENDER_CHARS = 2000
const MAX_DESCRIPTION_CHARS = 500

/** CLI string form of a value: scalars as typed, containers as JSON (Hermes parses list and mapping literals). */
export function serializeConfigValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
// Hermes coerces strings ("true", "5"), so a write counts as applied when either the value or its CLI form matches.
function sameValue(read: unknown, wanted: unknown): boolean {
  return (
    canonical(read) === canonical(wanted) ||
    serializeConfigValue(read) === serializeConfigValue(wanted)
  )
}
function renderValue(found: boolean, value: unknown): string {
  if (!found) return '(not set)'
  const text = canonical(value)
  const plain =
    typeof value === 'string' &&
    /^[A-Za-z0-9_./:@+-][A-Za-z0-9_./:@+ -]*$/.test(value) &&
    !/^(true|false|yes|no|on|off|null|none|~|[-+]?\d[\d_.eE+-]*)$/i.test(value)
  const shown = plain ? (value as string) : text
  return shown.length > MAX_RENDER_CHARS ? `${shown.slice(0, MAX_RENDER_CHARS)}…` : shown
}
function navigate(
  section: { found: boolean; value?: unknown },
  path: string[],
): { found: boolean; value?: unknown } {
  let current = section.value
  if (!section.found) return { found: false }
  for (const name of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current))
      return { found: false }
    if (!Object.hasOwn(current, name)) return { found: false }
    current = (current as Record<string, unknown>)[name]
  }
  return { found: true, value: current }
}
function bad(): HttpError {
  // One message for unknown and protected keys: the answer must not reveal which secret-like keys exist.
  return new HttpError(400, 'bad_request', 'That setting cannot be changed here')
}

/**
 * Advanced config over any backend. Searchable and writable keys are exactly the index entries that survive
 * `isExcludedConfigKey`, so a key outside the index (including every credential or env-backed one) is refused
 * before any argv is built.
 */
export class ConfigService {
  private readonly entries = new Map<string, ConfigIndexEntry>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly backend: ConfigBackend,
    index: ConfigIndexEntry[],
  ) {
    for (const entry of index)
      if (!isExcludedConfigKey(entry.key)) this.entries.set(entry.key, entry)
  }

  private reader() {
    const sections = new Map<string, Promise<{ found: boolean; value?: unknown }>>()
    return async (key: string) => {
      const [top, ...path] = key.split('.')
      let section = sections.get(top!)
      if (!section) {
        section = this.backend.readSection(top!).catch(() => ({ found: false }))
        sections.set(top!, section)
      }
      const read = navigate(await section, path)
      return read.found ? { found: true, value: scrubConfigValue(read.value) } : { found: false }
    }
  }

  async search(query: string): Promise<ConfigItem[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const ranked: { entry: ConfigIndexEntry; rank: number }[] = []
    for (const entry of this.entries.values()) {
      const name = entry.key.toLowerCase()
      const description = (entry.description ?? '').toLowerCase()
      if (!terms.every((term) => name.includes(term) || description.includes(term))) continue
      ranked.push({ entry, rank: terms.every((term) => name.includes(term)) ? 0 : 1 })
    }
    ranked.sort((a, b) => a.rank - b.rank || (a.entry.key < b.entry.key ? -1 : 1))
    const picked = ranked.slice(0, MAX_RESULTS).map((item) => item.entry)
    const read = this.reader()
    const items: ConfigItem[] = new Array<ConfigItem>(picked.length)
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(READ_CONCURRENCY, picked.length) }, async () => {
        for (let index = next++; index < picked.length; index = next++) {
          const entry = picked[index]!
          const current = await read(entry.key)
          let value = current.found ? current.value : (entry.default ?? null)
          if (canonical(value).length > MAX_VALUE_CHARS)
            value = `${canonical(value).slice(0, MAX_VALUE_CHARS)}…`
          items[index] = {
            key: entry.key,
            value,
            file: this.backend.file,
            description: entry.description
              ? entry.description.length > MAX_DESCRIPTION_CHARS
                ? `${entry.description.slice(0, MAX_DESCRIPTION_CHARS)}…`
                : entry.description
              : null,
          }
        }
      }),
    )
    return items
  }

  private assertWritable(changes: ConfigChange[]): void {
    for (const change of changes) {
      if (isExcludedConfigKey(change.key) || !this.entries.has(change.key)) throw bad()
      const text = serializeConfigValue(change.value)
      if (text.includes('\0')) throw bad()
      // A leading dash would reach the CLI as a flag; negative numbers are the one legitimate case.
      if (typeof change.value === 'string' && change.value.trimStart().startsWith('-')) throw bad()
    }
  }

  private async build(changes: ConfigChange[]) {
    this.assertWritable(changes)
    const sorted = [...changes].sort((a, b) => (a.key < b.key ? -1 : 1))
    const read = this.reader()
    const current = await Promise.all(sorted.map((change) => read(change.key)))
    const before = sorted
      .map(
        (change, index) =>
          `${change.key}: ${renderValue(current[index]!.found, current[index]!.value)}`,
      )
      .join('\n')
    const after = sorted
      .map((change) => `${change.key}: ${renderValue(true, change.value)}`)
      .join('\n')
    const diff = unifiedDiff(`${before}\n`, `${after}\n`)
    // The hash covers the diff text, the live values it was computed from and the exact values to be written.
    const hash = createHash('sha256')
      .update(
        canonical([
          diff,
          sorted.map((change, index) => [
            change.key,
            current[index]!.found,
            current[index]!.value ?? null,
            change.value,
          ]),
        ]),
      )
      .digest('hex')
    return { sorted, current, diff, hash }
  }

  async preview(changes: ConfigChange[]): Promise<ConfigPreviewResponse> {
    const { diff, hash } = await this.build(changes)
    return { diff, file: this.backend.file, hash }
  }

  apply(req: ConfigApplyRequest): Promise<ConfigApplyResponse> {
    // One apply at a time: the hash check and the writes must not interleave with another apply.
    const run = this.chain.then(() => this.applyNow(req))
    this.chain = run.catch(() => undefined)
    return run
  }
  private async applyNow(req: ConfigApplyRequest): Promise<ConfigApplyResponse> {
    const { sorted, current, hash } = await this.build(req.changes)
    if (hash !== req.expectedDiffHash)
      throw new HttpError(
        409,
        'conflict',
        'The config changed since the preview. Preview it again.',
      )
    const todo = sorted.filter(
      (change, index) => !(current[index]!.found && sameValue(current[index]!.value, change.value)),
    )
    for (const change of todo) {
      if (!(await this.backend.write(change.key, serializeConfigValue(change.value))))
        throw new HttpError(502, 'hermes_write_failed', 'Hermes did not accept the change')
    }
    const read = this.reader()
    for (const change of todo) {
      const after = await read(change.key)
      if (!after.found || !sameValue(after.value, change.value))
        throw new HttpError(502, 'hermes_write_failed', 'Hermes did not keep the change')
    }
    return { ok: true, restartRequired: configRestartRequired(todo.map((change) => change.key)) }
  }
}
