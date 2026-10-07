import { statSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { z } from 'zod'

const JsonSchema = z.json()
export type JsonValue = z.infer<typeof JsonSchema>

export class HermesDbMissing extends Error {
  constructor(
    readonly path: string,
    options?: ErrorOptions,
  ) {
    super(`Hermes database is missing: ${path}`, options)
    this.name = 'HermesDbMissing'
  }
}

export class HermesSchemaDrift extends Error {
  constructor(
    readonly table: string,
    readonly column: string | null,
    options?: ErrorOptions,
  ) {
    super(`Hermes schema drift: ${table}${column ? `.${column}` : ''} is missing`, options)
    this.name = 'HermesSchemaDrift'
  }
}

export interface ReaderBatch<Row> {
  rows: Row[]
  malformed: number
  /** Last scanned ID also advances past malformed rows, so one bad row cannot stall a tail. */
  position?: number
}

export const TailInputSchema = z.object({
  afterId: z.int().nonnegative(),
  limit: z.int().positive(),
})
export const IdsSchema = z.array(z.string().min(1))
export const TaskIdsSchema = z.object({ taskIds: IdsSchema })

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export function incarnationOf(path: string): string {
  z.string().min(1).parse(path)
  try {
    const stat = statSync(path)
    // Never ctime: it changes on every write, so a filesystem without birth times would look like a
    // replaced database on every poll and force a full re-read. Replacement means a new inode.
    return stat.birthtimeMs > 0
      ? `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
      : `${stat.dev}:${stat.ino}`
  } catch (error) {
    if (isMissing(error)) throw new HermesDbMissing(path, { cause: error })
    throw error
  }
}

export function openReadOnly(path: string): DatabaseSync {
  incarnationOf(path)
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch (error) {
    // A file can disappear between stat and open. Preserve other failures (permissions, corruption).
    incarnationOf(path)
    throw error
  }
  try {
    db.exec('PRAGMA query_only = 1')
    db.exec('PRAGMA busy_timeout = 2000')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function closeReadOnly(db: DatabaseSync): void {
  db.close()
}

export function parseJson(text: string | null): { value: JsonValue; malformed: number } {
  if (text === null) return { value: null, malformed: 0 }
  try {
    return { value: JsonSchema.parse(JSON.parse(text)), malformed: 0 }
  } catch {
    return { value: { unparsed: text }, malformed: 1 }
  }
}

function queryRows(db: DatabaseSync, table: string, sql: string, parameters: SQLInputValue[]) {
  try {
    return db.prepare(sql).all(...parameters)
  } catch (error) {
    if (error instanceof Error) {
      const column = /no such column: (\w+)/.exec(error.message)?.[1]
      if (column || error.message.includes('no such table:')) {
        throw new HermesSchemaDrift(table, column ?? null, { cause: error })
      }
    }
    throw error
  }
}

export function readBatch<S extends z.ZodObject>(
  db: DatabaseSync,
  table: string,
  schema: S,
  where: string,
  parameters: SQLInputValue[],
  tail = false,
): ReaderBatch<z.output<S>> {
  const raw = queryRows(
    db,
    table,
    `SELECT ${Object.keys(schema.shape).join(', ')} FROM ${table} ${where}`,
    parameters,
  )
  const batch: ReaderBatch<z.output<S>> = { rows: [], malformed: 0 }
  for (const row of raw) {
    if (tail) batch.position = z.int().positive().parse(row.id)
    const parsed = schema.safeParse(row)
    if (parsed.success) batch.rows.push(parsed.data)
    else batch.malformed++
  }
  return batch
}

export function readByIds<S extends z.ZodObject>(
  db: DatabaseSync,
  table: string,
  schema: S,
  ids: string[],
  columns: string[],
  orderBy: string,
): ReaderBatch<z.output<S>> {
  const unique = [...new Set(IdsSchema.parse(ids))]
  const batch: ReaderBatch<z.output<S>> = { rows: [], malformed: 0 }
  const seen = new Set<string>()
  for (let offset = 0; offset < unique.length; offset += 500) {
    const chunk = unique.slice(offset, offset + 500)
    const placeholders = chunk.map(() => '?').join(', ')
    const result = readBatch(
      db,
      table,
      schema,
      `WHERE ${columns.map((column) => `${column} IN (${placeholders})`).join(' OR ')} ORDER BY ${orderBy}`,
      columns.flatMap(() => chunk),
    )
    batch.malformed += result.malformed
    for (const row of result.rows) {
      // A dependency can touch requested tasks in different chunks.
      const key = JSON.stringify(row)
      if (!seen.has(key)) {
        seen.add(key)
        batch.rows.push(row)
      }
    }
  }
  return batch
}
