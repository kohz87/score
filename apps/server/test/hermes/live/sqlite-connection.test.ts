import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { HermesDbMissing, incarnationOf, openReadOnly } from '../../../src/hermes/live/index.ts'
import { fixtures, installSqliteHooks, open, sources } from './sqlite-helpers.ts'

installSqliteHooks()

test.each(sources)('$kind connection rejects writes even if query_only is disabled', (source) => {
  const { db, path } = fixtures.build(source.kind)
  db.close()
  const reader = open(path)
  expect(reader.prepare('PRAGMA query_only').get()).toEqual({ query_only: 1 })
  expect(reader.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 2000 })
  expect(() => reader.exec('CREATE TABLE forbidden (id INTEGER)')).toThrow(/readonly/i)
  reader.exec('PRAGMA query_only = 0')
  expect(() => reader.exec('CREATE TABLE forbidden (id INTEGER)')).toThrow(/readonly/i)
})

test('missing database is typed and is never created', () => {
  const path = join(fixtures.home, 'missing.db')
  expect(() => openReadOnly(path)).toThrow(HermesDbMissing)
  expect(() => incarnationOf(path)).toThrow(HermesDbMissing)
  expect(existsSync(path)).toBe(false)
})
