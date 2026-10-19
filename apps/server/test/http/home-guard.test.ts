import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'

// 2026-10-19: test servers built with a test database and the default home (~/.score) ran the start-up cleanups
// against the owner's real home and deleted a live agent's pet pack. Cleanups that delete what the database doesn't
// name only run against the home the database lives in.
function seedHome() {
  const home = mkdtempSync(join(tmpdir(), 'score-other-home-'))
  mkdirSync(join(home, 'packs', 'luna', 'rev1'), { recursive: true, mode: 0o700 })
  writeFileSync(join(home, 'packs', 'luna', 'rev1', 'idle.webp'), 'x', { mode: 0o600 })
  mkdirSync(join(home, 'knowledge-staging'), { recursive: true, mode: 0o700 })
  writeFileSync(join(home, 'knowledge-staging', 'kept-zip'), 'x', { mode: 0o600 })
  return home
}

test('a server whose database lives elsewhere leaves that home’s packs and staged zips alone', async () => {
  const env = setup()
  const other = seedHome()
  const app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: other }),
    logger: false,
    port: new FakePort(1, { db: env.db }, false),
    db: env.db,
    ingest: env.ingest,
  })
  await app.ready()
  expect(readdirSync(join(other, 'packs'))).toEqual(['luna'])
  expect(readdirSync(join(other, 'packs', 'luna'))).toEqual(['rev1'])
  expect(readdirSync(join(other, 'knowledge-staging'))).toEqual(['kept-zip'])
  await app.close()
})

test('in its own home the pack cleanup still clears strays', async () => {
  const env = setup()
  mkdirSync(join(env.home, 'packs', 'ghost', 'rev1'), { recursive: true, mode: 0o700 })
  const app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake', SCORE_HOME: env.home }),
    logger: false,
    port: new FakePort(1, { db: env.db }, false),
    db: env.db,
    ingest: env.ingest,
  })
  await app.ready()
  expect(readdirSync(join(env.home, 'packs'))).toEqual([])
  await app.close()
})

test('tests never see the real home', async () => {
  const { homedir } = await import('node:os')
  expect(homedir()).toContain('score-test-root-')
})
