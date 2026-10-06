import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'

const HeadRowSchema = z.object({ seq: z.int().nonnegative() })

function requireMaterialized(value: unknown, depth = 0): void {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  )
    return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object')
    throw new Error('Snapshot data must be materialized JSON-like data')
  if ('then' in value && typeof value.then === 'function') {
    void Promise.resolve(value).catch(() => undefined)
    throw new Error('Snapshot callbacks must be synchronous and return materialized data')
  }
  if ('next' in value && typeof value.next === 'function')
    throw new Error('Snapshot data must be materialized, not an iterator')
  const prototype: unknown = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error('Snapshot data must contain only arrays and plain objects')
  }
  if (
    !Array.isArray(value) &&
    Symbol.iterator in value &&
    typeof value[Symbol.iterator] === 'function'
  ) {
    throw new Error('Snapshot data must be materialized, not iterable')
  }
  if (depth >= 8) throw new Error('Snapshot data exceeds the maximum depth of 8')
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw new Error('Snapshot data must not contain symbol properties')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (descriptor.get || descriptor.set)
      throw new Error('Snapshot data must not contain accessors')
    requireMaterialized(descriptor.value, depth + 1)
  }
}

export function headSeq(sqlite: DatabaseSync): number {
  const row = sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get()
  return row === undefined ? 0 : HeadRowSchema.parse(row).seq
}

export function snapshot<T>(
  db: ScoreDb,
  fn: (sqlite: DatabaseSync) => T,
): { asOfSeq: number; data: T } {
  return db.read((sqlite) => {
    const asOfSeq = headSeq(sqlite)
    const data = fn(sqlite)
    requireMaterialized(data)
    return { asOfSeq, data }
  })
}
