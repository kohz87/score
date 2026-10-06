import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { z } from 'zod'

export interface Lifecycle<State extends string> {
  canTransition(from: State, to: State): boolean
  isTerminal(state: State): boolean
  parseState(value: unknown): State
}

export function defineLifecycle<const State extends string>({
  states,
  terminal,
  order,
}: {
  states: readonly State[]
  terminal: readonly State[]
  order: readonly State[]
}): Lifecycle<State> {
  const stateSchema = z.enum(states)
  z.array(stateSchema).parse(terminal)
  z.array(stateSchema).parse(order)
  if (
    states.length === 0 ||
    new Set(states).size !== states.length ||
    new Set(order).size !== states.length ||
    order.length !== states.length
  ) {
    throw new Error(
      'Lifecycle states must be unique and order must contain every state exactly once',
    )
  }
  const terminals = new Set(terminal)
  const ranks = new Map(order.map((state, index) => [state, index]))
  return {
    parseState: (value) => stateSchema.parse(value),
    isTerminal: (state) => terminals.has(state),
    canTransition(from, to) {
      stateSchema.parse(from)
      stateSchema.parse(to)
      return from === to || (!terminals.has(from) && ranks.get(to)! >= ranks.get(from)!)
    },
  }
}

export type GuardedUpsertResult =
  'applied' | 'ignored_regression' | 'ignored_terminal' | 'ignored_stale'

const IdentifierSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)

function identifier(value: string): string {
  return `"${IdentifierSchema.parse(value).toLowerCase()}"`
}

function canonicalValues(values: Record<string, SQLInputValue>, names: Map<string, string>) {
  const result = Object.create(null) as Record<string, SQLInputValue>
  for (const [name, value] of Object.entries(values)) {
    const canonical = IdentifierSchema.parse(name).toLowerCase()
    const previous = names.get(canonical)
    if (previous !== undefined && previous !== name) {
      throw new Error(`Conflicting identifier casing: ${previous}, ${name}`)
    }
    names.set(canonical, name)
    result[canonical] = value
  }
  return result
}

const VersionSchema = z.int()

export function guardedUpsert<State extends string>(
  sqlite: DatabaseSync,
  {
    table,
    key,
    stateColumn,
    lifecycle,
    values,
    refreshTerminal = false,
    versionColumn,
  }: {
    table: string
    key: Record<string, SQLInputValue>
    stateColumn: string
    lifecycle: Lifecycle<State>
    values: Record<string, SQLInputValue>
    refreshTerminal?: boolean
    versionColumn?: string
  },
): GuardedUpsertResult {
  if (!sqlite.isTransaction) throw new Error('Guarded upserts require a transaction')
  const names = new Map<string, string>()
  key = canonicalValues(key, names)
  values = canonicalValues(values, names)
  stateColumn = IdentifierSchema.parse(stateColumn).toLowerCase()
  if (versionColumn !== undefined)
    versionColumn = IdentifierSchema.parse(versionColumn).toLowerCase()
  const keys = Object.keys(key)
  if (keys.length === 0 || Object.values(key).some((value) => value === null)) {
    throw new Error('Guarded upserts require a nonempty, non-null key')
  }
  for (const column of keys) {
    if (column in values && values[column] !== key[column]) {
      throw new Error(`Conflicting key value: ${column}`)
    }
  }
  const rowValues = { ...values, ...key }
  const nextState = lifecycle.parseState(rowValues[stateColumn])
  const nextVersion =
    versionColumn === undefined ? undefined : VersionSchema.parse(rowValues[versionColumn])
  const columns = Object.keys(rowValues)
  const quotedTable = identifier(table)
  const quotedState = identifier(stateColumn)
  const quotedKeys = keys.map(identifier)
  const quotedColumns = columns.map(identifier)
  const row = sqlite
    .prepare(
      `SELECT ${quotedState} AS state${versionColumn === undefined ? '' : `, ${identifier(versionColumn)} AS version`} FROM ${quotedTable} WHERE ${quotedKeys.map((column) => `${column} = ?`).join(' AND ')}`,
    )
    .get(...Object.values(key))
  if (row !== undefined) {
    const current = lifecycle.parseState(z.object({ state: z.unknown() }).parse(row).state)
    if (versionColumn !== undefined) {
      const stored = z.object({ version: VersionSchema.nullable() }).parse(row).version
      if (stored !== null && nextVersion! < stored) return 'ignored_stale'
    }
    if (lifecycle.isTerminal(current) && (!refreshTerminal || current !== nextState)) {
      return 'ignored_terminal'
    }
    if (!lifecycle.canTransition(current, nextState)) {
      return lifecycle.isTerminal(current) ? 'ignored_terminal' : 'ignored_regression'
    }
  }
  const updates = quotedColumns.filter((column) => !quotedKeys.includes(column))
  const conflict =
    updates.length > 0
      ? `DO UPDATE SET ${updates.map((column) => `${column} = excluded.${column}`).join(', ')}`
      : 'DO NOTHING'
  sqlite
    .prepare(
      `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
       ON CONFLICT (${quotedKeys.join(', ')}) ${conflict}`,
    )
    .run(...Object.values(rowValues))
  return 'applied'
}
